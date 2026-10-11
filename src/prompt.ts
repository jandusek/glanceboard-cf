import type { CalendarEvent } from "./calendar";
import type { Character, Config } from "./config";
import type { Polished } from "./polish";
import type { Weather } from "./weather";
import { seasonFor } from "./weather";
import type { WallClock } from "./time";

export const DEFAULT_PROMPT = `Create a children's illustrated daily planner in pen-and-ink style on a clean white paper background with crosshatching. Wide landscape format, 5:3 (800×480).

Leave generous margins on all sides. Keep text, characters and anything important well away from the edges.

TOP: a ribbon banner reads '{{day}} adventure' in bold hand-drawn block letters.

LEFT SIDE: a clear, readable handwritten list of today's schedule, one item per line with a bullet. The text sits in the foreground over the scene; keep the block only as tall as the list needs.
{{events}}

RIGHT SIDE: the main scene, one charming, whimsical illustration built around today's activities, on a {{season}} day{{#location}} in {{location}}{{/location}}.{{#scene}} {{scene}}{{/scene}}{{#characters}} Show these characters, doing today's activities where it fits. Draw only these characters and no other people.
{{characters}}{{/characters}}
{{#weather}}
Dress everyone for the weather: {{clothing}}.

BOTTOM LEFT: a small hand-drawn weather stamp reading '{{weather}}'.
{{/weather}}{{#countdown}}
BOTTOM RIGHT: a small hand-drawn countdown note reading:
{{countdown}}
{{/countdown}}
STYLE: pen-and-ink, hand-drawn crosshatching, charming and whimsical like a storybook, kid-friendly, with joyful expressions and playful little details. Keep the mood cheerful whatever the weather. Black ink on pure white (#FFFFFF) paper with limited accents of red, green, blue and yellow. No cream, beige or parchment tones. The text must be high-contrast and easy to read.

REALISM: no snow, frost or ice unless it's below 2°C.{{#location}} Use plants, animals, buildings and clothing that belong in {{location}}.{{/location}}`;

export const PLACEHOLDERS: { name: string; meaning: string }[] = [
  { name: "day", meaning: "Weekday name, e.g. Thursday" },
  { name: "date", meaning: "Date, e.g. 8 October" },
  { name: "events", meaning: "Today's schedule as bullet lines, or the empty-day lines" },
  { name: "scene", meaning: "A setting for the picture, written by Workers AI" },
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
