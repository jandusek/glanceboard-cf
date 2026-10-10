import type { CalendarEvent } from "./calendar";
import type { Weather } from "./weather";

// Compared on 2026-10-08 (5 runs each, same sample day): with thinking on, Gemma spent
// its whole token budget reasoning and returned nothing; GLM-5.3-flash kept reasoning
// even when asked not to (2/5 valid); Llama 3.3 mangled emoji. These two were 5/5.
export const TEXT_MODELS = [
  { id: "@cf/deepseek-ai/deepseek-v4-flash-0731", name: "DeepSeek V4 Flash" },
  { id: "@cf/google/gemma-4-26b-a4b-it", name: "Gemma 4 26B" },
];

export interface Polished {
  /** One line per input event, same order: emoji + friendly wording. */
  events: string[];
  /** One or two sentences setting the scene. */
  scene: string;
}

export interface PolishInput {
  date: string;
  season: string;
  location: string;
  weather: Weather | null;
  events: CalendarEvent[];
}

const SCHEMA = {
  type: "object",
  properties: {
    events: { type: "array", items: { type: "string" } },
    scene: { type: "string" },
  },
  required: ["events", "scene"],
};

const SYSTEM = `You write the text for a children's illustrated daily planner that hangs on a family's wall.

Return JSON with:
- "events": exactly one line per input event, in the same order. Start each line with one fitting emoji, then the time as given (omit it for all-day events), then the event in friendly words a child understands. At most 10 words after the time. Keep every name. Never add details that aren't in the event.
- "scene": one or two sentences describing a realistic setting for today's illustration that fits the events, the season, the weather and the location. Use landmarks, plants and buildings typical for that place. Don't name or describe any people.`;

export type AiResult = { response?: unknown; choices?: { message?: { content?: string | null } }[] };

/**
 * Event wording and a scene description from Workers AI. Results are cached by
 * input, so re-runs with an unchanged day produce the same prompt (and skip Gemini).
 */
export async function polish(ai: Ai, kv: KVNamespace, model: string, input: PolishInput): Promise<Polished> {
  const payload = polishPayload(input);
  const key = await sha256(JSON.stringify([model, SYSTEM, payload]));
  const cached = await kv.get<Polished>(`polish:${key}`, "json");
  if (cached) return cached;

  const request = polishRequest(payload);
  // Models occasionally return malformed JSON despite the schema; one retry fixes most of it.
  let result: Polished;
  try {
    result = parsePolished((await ai.run(model as keyof AiModels, request as never)) as AiResult, input.events.length);
  } catch {
    result = parsePolished((await ai.run(model as keyof AiModels, request as never)) as AiResult, input.events.length);
  }

  // Kept two days: long enough for every run of the day, then it expires on its own.
  await kv.put(`polish:${key}`, JSON.stringify(result), { expirationTtl: 2 * 86400 });
  return result;
}

export function polishPayload(input: PolishInput) {
  return {
    date: input.date,
    season: input.season,
    location: input.location || "unknown",
    weather: input.weather ? `${input.weather.condition}, high ${input.weather.high}${input.weather.unit}` : "unknown",
    events: input.events.map((e) => ({
      time: e.allDay ? "all day" : e.time,
      title: e.summary,
      ...(e.location ? { where: e.location } : {}),
    })),
  };
}

/** The Workers AI request body; shared with the model comparison script. */
export function polishRequest(payload: ReturnType<typeof polishPayload>, extra: Record<string, unknown> = {}) {
  return {
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: JSON.stringify(payload) },
    ],
    response_format: { type: "json_schema", json_schema: SCHEMA },
    max_tokens: 800,
    temperature: 0.4,
    // Both listed models think by default, which burns the token budget on a task this small.
    chat_template_kwargs: { enable_thinking: false },
    ...extra,
  };
}

/** Accepts both Workers AI output shapes and checks the result is usable. */
export function parsePolished(raw: AiResult, eventCount: number): Polished {
  let value: unknown = raw.response ?? raw.choices?.[0]?.message?.content;
  if (typeof value === "string") {
    const text = value;
    // Tolerate code fences or prose around the object.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    try {
      value = JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text);
    } catch {
      throw new Error(`The text model didn't return valid JSON: ${JSON.stringify(text.slice(0, 300))}`);
    }
  }
  const v = value as Partial<Polished> | undefined;
  const events = Array.isArray(v?.events) ? v.events.map((e) => String(e).trim()) : null;
  if (!events || events.length !== eventCount || events.some((e) => !e)) {
    throw new Error("The text model returned the wrong number of events.");
  }
  return { events, scene: typeof v?.scene === "string" ? v.scene.trim() : "" };
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
