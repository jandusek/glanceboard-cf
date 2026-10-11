import { isValidTimeZone } from "./time";
import { DEFAULT_PROMPT } from "./prompt";
import { TEXT_MODELS } from "./polish";

export interface Character {
  id: string;
  name: string;
  /** Other names calendar events use for them ("Mum", "Grandpa Joe"). */
  aliases: string[];
  /** "always" appears every day; "mentioned" only when an event names them. */
  inclusion: "always" | "mentioned";
  description: string;
  /** R2 key of the reference photo. */
  photo: string | null;
  gender: "female" | "male" | "";
  /** Used when there's no birthday with a year to work it out from. */
  age: number | null;
  /** YYYY-MM-DD. Drives the countdown, and the age when set. */
  birthday: string;
}

export interface Config {
  icalUrl: string;
  timezone: string;
  location: { name: string; latitude: number; longitude: number } | null;
  tempUnit: "celsius" | "fahrenheit";
  /** Local hours (0–23) at which a new image is generated. */
  schedule: number[];
  imageModel: string;
  /** Workers AI rewrites events and describes the scene before the image call. */
  polish: boolean;
  textModel: string;
  /** Local surroundings to draw ("our estate looks like…"), for {{setting}}. */
  setting: string;
  /** Prompt template; empty means the built-in default. */
  prompt: string;
  /** Lines shown on days with no events. */
  emptyDay: { weekday: string; weekend: string };
  characters: Character[];
  battery: boolean;
}

export interface State {
  lastRunAt: string | null;
  lastGeneratedAt: string | null;
  /** Prompt and image model behind the current picture, for troubleshooting. */
  lastPrompt: string | null;
  lastModel: string | null;
  lastHash: string | null;
  lastError: string | null;
  lastSkipped: string | null;
  /** "YYYY-MM-DD@H" slots already done today. */
  completedSlots: string[];
}

export const IMAGE_MODELS = [
  { id: "gemini-3-pro-image", name: "Gemini 3 Pro Image" },
  { id: "gemini-nano-banana-2.1", name: "Nano Banana 2.1" },
  { id: "gemini-3.1-flash-image", name: "Gemini 3.1 Flash Image" },
  { id: "gemini-3.1-flash-lite-image", name: "Gemini 3.1 Flash Lite Image" },
];

export const DEFAULT_CONFIG: Config = {
  icalUrl: "",
  timezone: "UTC",
  location: null,
  tempUnit: "celsius",
  schedule: [4, 10, 14, 18],
  imageModel: IMAGE_MODELS[0].id,
  polish: true,
  textModel: TEXT_MODELS[0].id,
  setting: "",
  prompt: "",
  emptyDay: { weekday: "📝 Homework & practice piano", weekend: "🎹 Practice piano & tidy your room" },
  characters: [],
  battery: false,
};

const EMPTY_STATE: State = {
  lastRunAt: null,
  lastGeneratedAt: null,
  lastPrompt: null,
  lastModel: null,
  lastHash: null,
  lastError: null,
  lastSkipped: null,
  completedSlots: [],
};

// Settings and run state live in KV; pictures and photos stay in R2.

export async function loadConfig(kv: KVNamespace): Promise<Config> {
  const stored = await kv.get<Partial<Config>>("config", "json");
  const config = { ...structuredClone(DEFAULT_CONFIG), ...(stored ?? {}) };
  // Characters saved before gender, age and birthday existed.
  config.characters = config.characters.map((c: Partial<Character>) => ({ gender: "", age: null, birthday: "", ...c }) as Character);
  return config;
}

export async function saveConfig(kv: KVNamespace, config: Config): Promise<void> {
  await kv.put("config", JSON.stringify(config));
}

export async function loadState(kv: KVNamespace): Promise<State> {
  return { ...EMPTY_STATE, ...((await kv.get<Partial<State>>("state", "json")) ?? {}) };
}

export async function saveState(kv: KVNamespace, state: State): Promise<void> {
  await kv.put("state", JSON.stringify(state));
}

function parseBirthday(value: string, name: string): string {
  if (!value) return "";
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!m || !d || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) {
    throw new Error(`${name}'s birthday isn't a valid date.`);
  }
  return value;
}

/** Validate and normalise a config sent by the dashboard. Throws with a user-facing message. */
export function parseConfig(input: unknown): Config {
  if (!input || typeof input !== "object") throw new Error("Settings must be a JSON object.");
  const c = input as Record<string, any>;
  const str = (v: unknown, max = 2000) => (typeof v === "string" ? v.trim().slice(0, max) : "");

  const timezone = str(c.timezone, 100) || "UTC";
  if (!isValidTimeZone(timezone)) throw new Error(`"${timezone}" isn't a time zone this server recognises.`);

  const icalUrl = str(c.icalUrl);
  if (icalUrl && !/^(https?|webcal):\/\//i.test(icalUrl)) {
    throw new Error("The calendar address must start with https:// or webcal://.");
  }

  let location: Config["location"] = null;
  if (c.location) {
    const lat = Number(c.location.latitude);
    const lon = Number(c.location.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      throw new Error("The weather location has invalid coordinates.");
    }
    location = { name: str(c.location.name, 200), latitude: lat, longitude: lon };
  }

  const schedule = Array.isArray(c.schedule)
    ? [...new Set(c.schedule.map(Number).filter((h: number) => Number.isInteger(h) && h >= 0 && h <= 23))].sort(
        (a, b) => (a as number) - (b as number),
      ) as number[]
    : DEFAULT_CONFIG.schedule;

  const imageModel = str(c.imageModel, 100) || DEFAULT_CONFIG.imageModel;
  if (!/^[a-z0-9.\-]+$/i.test(imageModel)) throw new Error("The image model name has unexpected characters.");

  const textModel = str(c.textModel, 100) || DEFAULT_CONFIG.textModel;
  if (!/^@cf\/[a-z0-9.\-_/]+$/i.test(textModel)) throw new Error("The text model must be a Workers AI model such as @cf/deepseek-ai/deepseek-v4-flash-0731.");

  const characters: Character[] = (Array.isArray(c.characters) ? c.characters : []).slice(0, 50).map((ch: any) => {
    const id = str(ch?.id, 64);
    if (!/^[a-z0-9-]+$/i.test(id)) throw new Error("A character has an invalid id.");
    const name = str(ch.name, 100);
    if (!name) throw new Error("Every character needs a name.");
    const photo = str(ch.photo, 200);
    if (photo && !photo.startsWith(`characters/${id}-`)) throw new Error(`${name}'s photo reference is invalid.`);
    return {
      id,
      name,
      aliases: (Array.isArray(ch.aliases) ? ch.aliases : []).map((a: unknown) => str(a, 100)).filter(Boolean).slice(0, 20),
      inclusion: ch.inclusion === "mentioned" ? "mentioned" : "always",
      description: str(ch.description, 1000),
      photo: photo || null,
      gender: ch.gender === "female" || ch.gender === "male" ? ch.gender : "",
      age: Number.isInteger(Number(ch.age)) && ch.age !== null && ch.age !== "" && Number(ch.age) >= 0 && Number(ch.age) <= 120 ? Number(ch.age) : null,
      birthday: parseBirthday(str(ch.birthday, 10), name),
    };
  });

  const prompt = str(c.prompt, 20000);
  return {
    icalUrl,
    timezone,
    location,
    tempUnit: c.tempUnit === "fahrenheit" ? "fahrenheit" : "celsius",
    schedule,
    imageModel,
    polish: c.polish !== false,
    textModel,
    setting: str(c.setting, 3000),
    prompt: prompt === DEFAULT_PROMPT.trim() ? "" : prompt,
    emptyDay: { weekday: str(c.emptyDay?.weekday, 300), weekend: str(c.emptyDay?.weekend, 300) },
    characters,
    battery: c.battery === true,
  };
}
