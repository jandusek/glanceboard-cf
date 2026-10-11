import { fetchTodaysEvents, type CalendarEvent } from "./calendar";
import { loadConfig, loadState, saveState, type Config, type State } from "./config";
import { generateImage, type ReferencePhoto } from "./gemini";
import { decodeImage, dither, encodePng, fitToDisplay, indicesToRgb } from "./image";
import { polish, type Polished } from "./polish";
import { castFor, DEFAULT_PROMPT, placeholderValues, renderTemplate, type CastMember } from "./prompt";
import { dayKey, wallClock } from "./time";
import { fetchWeather, seasonFor, type Weather } from "./weather";

export interface Env {
  /** Pictures and character photos. */
  BUCKET: R2Bucket;
  /** Settings ("config"), run state ("state") and the Workers AI cache ("polish:*"). */
  KV: KVNamespace;
  AI: Ai;
  GEMINI_API_KEY: string;
  /** Optional; when set, the frame must send Authorization: Bearer … */
  DISPLAY_TOKEN?: string;
}

export interface PromptResult {
  prompt: string;
  events: CalendarEvent[];
  weather: Weather | null;
  cast: CastMember[];
  polished: Polished | null;
  /** Non-fatal problems, shown in the dashboard. */
  warnings: string[];
}

export async function buildPrompt(
  env: Pick<Env, "AI" | "KV">, config: Config, now = Date.now(), templateOverride?: string,
): Promise<PromptResult> {
  const local = wallClock(now, config.timezone);
  const warnings: string[] = [];

  // A broken calendar must not quietly become "no events today", so it's fatal.
  const events = config.icalUrl ? await fetchTodaysEvents(config.icalUrl, config.timezone, now) : [];
  if (!config.icalUrl) warnings.push("No calendar is connected, so the schedule shows the empty-day lines.");

  let weather: Weather | null = null;
  if (config.location) {
    try {
      weather = await fetchWeather(config.location.latitude, config.location.longitude, config.tempUnit, config.timezone);
    } catch (e) {
      warnings.push(`Weather left out: ${(e as Error).message}`);
    }
  }

  let polished: Polished | null = null;
  if (config.polish) {
    try {
      polished = await polish(env.AI, env.KV, config.textModel, {
        date: `${dayKey(local)} (weekday ${local.weekday}, 0 = Sunday)`,
        season: seasonFor(local.month, config.location?.latitude ?? null),
        location: config.location?.name ?? "",
        weather,
        events,
      });
    } catch (e) {
      warnings.push(`Workers AI step skipped, events are listed as written: ${(e as Error).message}`);
    }
  }

  const cast = castFor(events, config.characters);
  const template = templateOverride ?? (config.prompt || DEFAULT_PROMPT);
  const prompt = renderTemplate(template, placeholderValues({ now: local, events, cast, weather, config, polished }));
  const unknown = [...new Set([...prompt.matchAll(/\{\{[#/]?(\w+)\}\}/g)].map((m) => m[1]))];
  if (unknown.length) warnings.push(`Unknown placeholders left as typed: ${unknown.map((n) => `{{${n}}}`).join(", ")}`);
  return { prompt, events, weather, cast, polished, warnings };
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type GenerateOutcome = { status: "generated" | "unchanged"; state: State };

/** Build the prompt, and unless nothing changed since last time, draw and store a new image. */
export async function generate(env: Env, opts: { force: boolean; now?: number }): Promise<GenerateOutcome> {
  const now = opts.now ?? Date.now();
  const config = await loadConfig(env.KV);
  const state = await loadState(env.KV);
  state.lastRunAt = new Date(now).toISOString();

  try {
    if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY isn't set. Add it with: wrangler secret put GEMINI_API_KEY");
    const { prompt, cast } = await buildPrompt(env, config, now);
    const photoKeys = cast.map((m) => m.character.photo).filter(Boolean);
    const hash = await sha256(JSON.stringify([prompt, config.imageModel, photoKeys]));

    if (!opts.force && hash === state.lastHash && (await env.BUCKET.head("display.png"))) {
      state.lastSkipped = state.lastRunAt;
      state.lastError = null;
      await saveState(env.KV, state);
      return { status: "unchanged", state };
    }

    const photos: ReferencePhoto[] = [];
    for (const { character } of cast) {
      if (!character.photo) continue;
      const obj = await env.BUCKET.get(character.photo);
      if (!obj) continue;
      photos.push({
        label: character.name,
        mimeType: obj.httpMetadata?.contentType ?? "image/jpeg",
        data: new Uint8Array(await obj.arrayBuffer()),
      });
    }

    const image = await generateImage(env.GEMINI_API_KEY, config.imageModel, prompt, photos);
    const fitted = fitToDisplay(decodeImage(image.data, image.mimeType));
    const indices = dither(fitted);
    const [original, display] = await Promise.all([encodePng(fitted.data), encodePng(indicesToRgb(indices))]);
    const png = { httpMetadata: { contentType: "image/png" } };
    await Promise.all([
      env.BUCKET.put("original.png", original, png),
      env.BUCKET.put("display.png", display, png),
      env.BUCKET.put("display.idx", indices),
    ]);

    Object.assign(state, {
      lastGeneratedAt: state.lastRunAt,
      lastPrompt: prompt,
      lastModel: config.imageModel,
      lastHash: hash,
      lastError: null,
      lastSkipped: null,
    });
    await saveState(env.KV, state);
    return { status: "generated", state };
  } catch (e) {
    state.lastError = (e as Error).message;
    await saveState(env.KV, state);
    throw e;
  }
}

/** Cron: generate once per scheduled local hour. */
export async function runSchedule(env: Env, now = Date.now()): Promise<void> {
  const config = await loadConfig(env.KV);
  const local = wallClock(now, config.timezone);
  if (!config.schedule.includes(local.hour)) return;

  const today = dayKey(local);
  const slot = `${today}@${local.hour}`;
  const before = await loadState(env.KV);
  if (before.completedSlots.includes(slot)) return;

  const { state } = await generate(env, { force: false, now });
  // Failures throw above, so the slot stays open and the next 15-minute tick retries.
  state.completedSlots = [...state.completedSlots.filter((s) => s.startsWith(today)), slot];
  await saveState(env.KV, state);
}
