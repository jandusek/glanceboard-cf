import { DEFAULT_PROMPT, PLACEHOLDERS } from "./prompt";
import { TEXT_MODELS } from "./polish";
import { IMAGE_MODELS, loadConfig, loadState, parseConfig, saveConfig } from "./config";
import { batteryLineHeight, batteryLinePng, HEIGHT, parseBatteryPercentage, WIDTH } from "./image";
import { buildPrompt, generate, PICTURE, runSchedule, type Env } from "./pipeline";
import { fetchTodaysEvents } from "./calendar";
import { fetchWeather } from "./weather";
import { castFor } from "./prompt";

const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const fail = (message: string, status = 400) => json({ error: message }, status);

async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(da, db);
}

async function serveObject(env: Env, key: string): Promise<Response> {
  const obj = await env.BUCKET.get(key);
  if (!obj) return new Response("Not found", { status: 404 });
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      "cache-control": "no-store",
    },
  });
}

const FRAME_KEY = "frame";

function jsonObject(header: string | null): Record<string, unknown> | null {
  if (!header) return null;
  try {
    const value = JSON.parse(header);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Keeps the frame's processing settings and calibrated palette, so the dashboard preview can match it. */
async function rememberFrameSettings(request: Request, env: Env): Promise<void> {
  const processing = jsonObject(request.headers.get("x-processing-settings"));
  const palette = jsonObject(request.headers.get("x-color-palette"));
  if (!processing && !palette) return;
  const next = JSON.stringify({ processing, palette });
  if (next !== (await env.KV.get(FRAME_KEY))) await env.KV.put(FRAME_KEY, next);
}

function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((t) => t.trim().replace(/^W\//, "") === etag || t.trim() === "*");
}

/**
 * The frame's endpoint. Answers 304 when the frame already shows this picture, so it
 * skips the redraw. Draws the battery line when enabled and reported.
 */
async function serveDisplay(request: Request, env: Env): Promise<Response> {
  const config = await loadConfig(env.KV);
  const pct = config.battery ? parseBatteryPercentage(request.headers.get("x-battery-percentage")) : null;
  const line = pct === null ? 0 : batteryLineHeight(pct);

  const head = await env.BUCKET.head(PICTURE);
  if (!head) return new Response("No picture yet", { status: 404 });
  // The line's height is part of the ETag, so the frame redraws when the line changes.
  const etag = line ? `"${head.etag}-b${line}"` : head.httpEtag;
  const headers = { etag, "cache-control": "no-cache" };
  if (etagMatches(request.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });

  const obj = await env.BUCKET.get(PICTURE);
  if (!obj) return new Response("No picture yet", { status: 404 });
  if (!line) {
    return new Response(obj.body, { headers: { ...headers, "content-type": obj.httpMetadata?.contentType ?? "image/png" } });
  }

  // Crop to the panel the way the frame would, so the line lands on its right edge.
  const overlay = new Blob([await batteryLinePng(line)]).stream();
  const result = await env.IMAGES.input(obj.body)
    .transform({ width: WIDTH, height: HEIGHT, fit: "cover" })
    .draw(overlay, { right: 0, bottom: 0 })
    .output({ format: "image/png" });
  return result.response({ headers });
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/api/config" && method === "GET") {
    return json({
      config: await loadConfig(env.KV),
      defaults: { prompt: DEFAULT_PROMPT, placeholders: PLACEHOLDERS, models: IMAGE_MODELS, textModels: TEXT_MODELS },
      displayUrl: new URL("/display", url.origin).toString(),
      displayToken: env.DISPLAY_TOKEN ?? null,
      geminiKeySet: Boolean(env.GEMINI_API_KEY),
    });
  }

  if (pathname === "/api/config" && method === "PUT") {
    let next;
    try {
      next = parseConfig(await request.json());
    } catch (e) {
      return fail((e as Error).message);
    }
    const previous = await loadConfig(env.KV);
    await saveConfig(env.KV, next);
    // Photos dropped by this save (character removed or photo replaced).
    const kept = new Set(next.characters.map((c) => c.photo));
    const dropped = previous.characters.map((c) => c.photo).filter((p): p is string => !!p && !kept.has(p));
    if (dropped.length) await env.BUCKET.delete(dropped);
    return json({ config: next });
  }

  if (pathname === "/api/state" && method === "GET") return json(await loadState(env.KV));

  // Today's events and weather for the overview. No AI calls, so it's cheap to load.
  if (pathname === "/api/today" && method === "GET") {
    const config = await loadConfig(env.KV);
    const [events, weather] = await Promise.allSettled([
      config.icalUrl ? fetchTodaysEvents(config.icalUrl, config.timezone) : Promise.resolve([]),
      config.location
        ? fetchWeather(config.location.latitude, config.location.longitude, config.tempUnit, config.timezone)
        : Promise.resolve(null),
    ]);
    const list = events.status === "fulfilled" ? events.value : [];
    return json({
      events: list,
      calendarError: events.status === "rejected" ? (events.reason as Error).message : null,
      weather: weather.status === "fulfilled" ? weather.value : null,
      cast: castFor(list, config.characters).map((m) => ({ name: m.character.name, reasons: m.reasons })),
    });
  }

  if (pathname === "/api/preview" && method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { prompt?: string };
    try {
      const config = await loadConfig(env.KV);
      const result = await buildPrompt(env, config, Date.now(), typeof body.prompt === "string" ? body.prompt || undefined : undefined);
      return json({ ...result, cast: result.cast.map((m) => ({ name: m.character.name, reasons: m.reasons })) });
    } catch (e) {
      return fail((e as Error).message, 502);
    }
  }

  if (pathname === "/api/generate" && method === "POST") {
    try {
      return json(await generate(env, { force: true }));
    } catch (e) {
      return fail((e as Error).message, 502);
    }
  }

  const photoUpload = pathname.match(/^\/api\/characters\/([a-z0-9-]{1,64})\/photo$/i);
  if (photoUpload && method === "PUT") {
    const type = (request.headers.get("content-type") ?? "").split(";")[0].trim();
    if (!PHOTO_TYPES.has(type)) return fail("Use a JPEG, PNG or WebP photo.", 415);
    const data = await request.arrayBuffer();
    if (data.byteLength > MAX_PHOTO_BYTES) return fail("Photos must be 5 MB or smaller.", 413);
    // A fresh key per upload, so a replaced photo changes the generation hash.
    const key = `characters/${photoUpload[1]}-${Date.now().toString(36)}`;
    await env.BUCKET.put(key, data, { httpMetadata: { contentType: type } });
    return json({ photo: key });
  }

  if (pathname === "/api/photo" && method === "GET") {
    const key = url.searchParams.get("key") ?? "";
    if (!/^characters\/[a-z0-9-]+$/i.test(key)) return fail("Unknown photo.", 404);
    return serveObject(env, key);
  }

  if (pathname === "/api/picture" && method === "GET") return serveObject(env, PICTURE);

  // The frame's own processing settings and palette, as it last sent them, for the e-ink preview.
  if (pathname === "/api/frame" && method === "GET") {
    const frame = await env.KV.get(FRAME_KEY);
    return json(frame ? JSON.parse(frame) : null);
  }

  return fail("Not found", 404);
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/display") {
      // The frame can't sign in through Cloudflare Access, so this path bypasses
      // Access and is protected by the optional token instead, sent as a Bearer header.
      const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1].trim() ?? "";
      if (env.DISPLAY_TOKEN && !(await sameSecret(token, env.DISPLAY_TOKEN))) {
        return new Response("Missing or wrong token", { status: 401 });
      }
      ctx.waitUntil(rememberFrameSettings(request, env));
      return serveDisplay(request, env);
    }

    // Everything else sits behind Cloudflare Access.
    return handleApi(request, env, url);
  },

  async scheduled(controller, env, ctx): Promise<void> {
    await runSchedule(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
