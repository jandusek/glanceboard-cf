import type { CalendarEvent } from "./calendar";
import type { Character, Config } from "./config";
import type { Polished } from "./polish";
import type { Weather } from "./weather";
import { seasonFor } from "./weather";
import type { WallClock } from "./time";

export const DEFAULT_PROMPT = `Create a children's illustrated daily planner in pen-and-ink style on a clean white paper background with crosshatching. Wide landscape format, 5:3 (800×480). The image must be clearly wider than it is tall.

FRAMING: leave generous margins on all sides. Keep text, characters and anything important well away from the edges so nothing gets clipped on the display.

LAYOUT — ONE FULL-WIDTH SCENE WITH OVERLAID TEXT:
The entire image is a single charming pen-and-ink illustration of a {{season}} scene{{#location}} in {{location}}{{/location}}, related to the day's activities. The scene fills the whole canvas.

TOP: a ribbon banner reads '{{day}} adventure' in bold hand-drawn block letters, well below the top edge.

LEFT SIDE (roughly 40% of the width) — TEXT OVERLAY:
Over the left part of the scene, write a clear, readable handwritten-style list of today's schedule, one item per line with a bullet, the time (if there is one) and the name. The text sits in the foreground, but the scene continues behind and around it: trees, sky, a wall or other background details peek around the edges. Keep the area right behind the text fairly uncluttered so it stays legible.
{{events}}

RIGHT SIDE (roughly 60% of the width) — MAIN SCENE:
This is where the main action and the characters are. The illustration flows naturally from the left side, but the focal point stays on the right so it doesn't compete with the text.
{{#setting}}
SETTING: {{setting}}
{{/setting}}{{#characters}}
CHARACTERS (in the scene on the right): show these characters, bringing today's activities into the picture where it fits. Draw only these characters and no other people.
{{characters}}
{{/characters}}{{#weather}}
Dress everyone for today's weather: {{clothing}}. Don't draw snow, ice or frost unless it's below 2°C.

BOTTOM LEFT — WEATHER: a small hand-drawn weather badge, clear and readable, like a little stamp on the illustration, reading '{{weather}}'.
{{/weather}}{{#countdown}}
BOTTOM RIGHT: a small hand-drawn countdown note reading:
{{countdown}}
{{/countdown}}
STYLE RULES: pen-and-ink illustration, hand-drawn crosshatching, charming and whimsical. Use only black ink and white (#FFFFFF) paper, plus limited accents of red, green, blue and yellow; no cream, beige or parchment tones. Kid-friendly, warm, joyful, whatever the weather. No scary elements. The text on the left must be clearly readable, high contrast against the background.`;

export const PLACEHOLDERS: { name: string; meaning: string }[] = [
  { name: "day", meaning: "Weekday name, e.g. Thursday" },
  { name: "date", meaning: "Date, e.g. 8 October" },
  { name: "events", meaning: "Today's schedule as bullet lines, or the empty-day lines" },
  { name: "setting", meaning: "Your local setting, from the box on this page" },
  { name: "scene", meaning: "A scene for the picture, written fresh by Workers AI" },
  { name: "characters", meaning: "Who appears today, one numbered line each" },
  { name: "countdown", meaning: "Birthdays and holidays in the next two weeks, up to three" },
  { name: "weather", meaning: "Weather stamp, e.g. ☀️ 24°C Clear sky" },
  { name: "clothing", meaning: "What to wear for today's high" },
  { name: "season", meaning: "Season for your hemisphere, or warm tropical" },
  { name: "location", meaning: "Weather location name" },
];

const MAX_CAST = 5;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const INSPIRATION = [
  "Take a moment to enjoy the weather today! 🌤️",
  "A great day for something new! ✨",
  "Make someone smile today! 😊",
  "Enjoy the little things today! 💛",
  "A perfect day to explore! 🌿",
  "Be curious, be kind! 🌈",
  "Fresh air and good vibes today! 🍃",
  "Today is full of possibilities! 🚀",
];

export interface CastMember {
  character: Character;
  /** Event summaries that brought a "mentioned" character in. */
  reasons: string[];
}

/** Regulars always appear; mentioned characters fill the remaining slots. */
export function castFor(events: CalendarEvent[], characters: Character[], max = MAX_CAST): CastMember[] {
  const regulars = characters.filter((c) => c.inclusion === "always").map((character) => ({ character, reasons: [] }));
  const guests: CastMember[] = [];
  for (const character of characters) {
    if (character.inclusion !== "mentioned") continue;
    const terms = [character.name, ...character.aliases].filter(Boolean);
    const reasons = events
      .filter((ev) => terms.some((t) => mentions(`${ev.summary} ${ev.description} ${ev.location}`, t)))
      .map((ev) => ev.summary);
    if (reasons.length) guests.push({ character, reasons });
  }
  return [...regulars, ...guests.slice(0, Math.max(0, max - regulars.length))];
}

/** Case-insensitive whole-word match, so "Al" doesn't match "Always". */
export function mentions(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu").test(text);
}

export interface PromptInputs {
  now: WallClock;
  events: CalendarEvent[];
  cast: CastMember[];
  weather: Weather | null;
  config: Config;
  /** Workers AI wording; when absent, events are listed as they appear in the calendar. */
  polished?: Polished | null;
}

export function placeholderValues({ now, events, cast, weather, config, polished }: PromptInputs): Record<string, string> {
  let eventText: string;
  if (events.length && polished) {
    eventText = polished.events.map((line) => `• ${line}`).join("\n");
  } else if (events.length) {
    eventText = events
      .map((ev) => `• ${ev.allDay ? "" : `${ev.time} — `}${ev.summary}`)
      .join("\n");
  } else {
    const weekend = now.weekday === 0 || now.weekday === 6;
    const routine = (weekend ? config.emptyDay.weekend : config.emptyDay.weekday).trim();
    // Same note all day, so a re-run doesn't count as a change.
    const note = INSPIRATION[(now.year * 372 + now.month * 31 + now.day) % INSPIRATION.length];
    const lines = [routine, note].filter(Boolean).map((l) => `• ${l}`);
    eventText =
      `There are no calendar events today. Write ${lines.length === 1 ? "this line" : "these lines"} and do not invent any other schedule items, times or activities.\n` +
      lines.join("\n");
  }

  const characters = cast
    .map(({ character, reasons }, i) => {
      let line = `${i + 1}) ${characterIntro(character, now)} ${character.description}`.trim();
      if (character.photo) line += ` (see the reference photo labelled ${character.name})`;
      if (reasons.length) line += ` Here today for: ${reasons.slice(0, 2).join("; ")}.`;
      return line;
    })
    .join("\n");

  return {
    day: DAYS[now.weekday],
    date: `${now.day} ${MONTHS[now.month - 1]}`,
    events: eventText,
    characters,
    weather: weather ? `${weather.emoji} ${weather.high}${weather.unit} ${weather.condition}` : "",
    clothing: weather?.clothing ?? "",
    season: seasonFor(now.month, config.location?.latitude ?? null),
    location: config.location?.name ?? "",
    setting: config.setting.trim(),
    scene: polished?.scene ?? "",
    countdown: countdownsFor(config.characters, now).map((c) => c.text).join("\n"),
  };
}

/**
 * Mustache-style rendering: {{name}} inserts a value; {{#name}}…{{/name}} keeps
 * its content only when the value is non-empty. Unknown names are left as typed
 * so mistakes show up in the preview.
 */
export function renderTemplate(template: string, values: Record<string, string>): string {
  const withSections = template.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (match, name: string, body: string) =>
    name in values ? (values[name] ? body : "") : match,
  );
  return withSections
    .replace(/\{\{(\w+)\}\}/g, (match, name: string) => (name in values ? values[name] : match))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Age on the given day, from the birthday when it has one, else the stored age. */
export function ageOn(character: Character, today: { year: number; month: number; day: number }): number | null {
  const m = character.birthday.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return character.age;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const hadBirthday = today.month > mo || (today.month === mo && today.day >= d);
  const age = today.year - y - (hadBirthday ? 0 : 1);
  return age >= 0 ? age : character.age;
}

/** "A girl named Mia, age 7." — or just "Rex." for characters without gender or age (pets, toys). */
export function characterIntro(character: Character, today: WallClock): string {
  const age = ageOn(character, today);
  const aka = character.aliases.length ? ` (also known as ${character.aliases.join(", ")})` : "";
  if (!character.gender && age === null) return `${character.name}${aka}.`;
  const adult = age !== null && age >= 18;
  const noun =
    character.gender === "female" ? (adult ? "woman" : "girl")
    : character.gender === "male" ? (adult ? "man" : "boy")
    : "person";
  return `A ${noun} named ${character.name}${aka}${age !== null ? `, age ${age}` : ""}.`;
}

export interface Countdown {
  daysAway: number;
  text: string;
}

const HOLIDAYS: [number, number, string][] = [
  [1, 1, "New Year's Day"],
  [2, 14, "Valentine's Day"],
  [10, 31, "Halloween"],
  [12, 25, "Christmas"],
];

/** Birthdays and holidays within the next two weeks, soonest first, at most three. */
export function countdownsFor(characters: Character[], today: WallClock, window = 14, max = 3): Countdown[] {
  const todayMs = Date.UTC(today.year, today.month - 1, today.day);
  const daysUntil = (month: number, day: number) => {
    for (const year of [today.year, today.year + 1]) {
      // Feb 29 birthdays fall on Feb 28 in other years.
      const d = month === 2 && day === 29 && !isLeap(year) ? 28 : day;
      const diff = Math.round((Date.UTC(year, month - 1, d) - todayMs) / 86400000);
      if (diff >= 0) return diff;
    }
    return Infinity;
  };

  const items: { daysAway: number; name: string; birthday: boolean }[] = [];
  for (const c of characters) {
    const m = c.birthday.match(/^\d{4}-(\d{2})-(\d{2})$/);
    if (m) items.push({ daysAway: daysUntil(+m[1], +m[2]), name: `${c.name}'s birthday`, birthday: true });
  }
  for (const [month, day, name] of HOLIDAYS) items.push({ daysAway: daysUntil(month, day), name, birthday: false });
  const easter = [today.year, today.year + 1].map(easterSunday).map(([mo, d], i) =>
    Math.round((Date.UTC(today.year + i, mo - 1, d) - todayMs) / 86400000)).find((n) => n >= 0);
  if (easter !== undefined) items.push({ daysAway: easter, name: "Easter", birthday: false });

  return items
    .filter((i) => i.daysAway <= window)
    .sort((a, b) => a.daysAway - b.daysAway)
    .slice(0, max)
    .map(({ daysAway, name, birthday }) => ({
      daysAway,
      text:
        daysAway === 0 ? (birthday ? `🎂 It's ${name} today!` : `🎉 ${name} is today!`)
        : daysAway === 1 ? `⏰ ${name} is tomorrow!`
        : `${birthday ? "🎂" : "🎉"} ${daysAway} days until ${name}!`,
    }));
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** Anonymous Gregorian algorithm. Returns [month, day]. */
function easterSunday(year: number): [number, number] {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  return [month, ((h + l - 7 * m + 114) % 31) + 1];
}
