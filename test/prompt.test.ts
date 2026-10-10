import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "../src/calendar";
import { DEFAULT_CONFIG, parseConfig, type Character, type Config } from "../src/config";
import { ageOn, castFor, characterIntro, countdownsFor, DEFAULT_PROMPT, mentions, placeholderValues, renderTemplate } from "../src/prompt";

const ev = (summary: string, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  summary, time: "9:00 AM", startMs: 0, allDay: false, location: "", description: "", ...extra,
});
const ch = (name: string, inclusion: Character["inclusion"], aliases: string[] = []): Character => ({
  id: name.toLowerCase(), name, aliases, inclusion, description: "", photo: null, gender: "", age: null, birthday: "",
});

describe("castFor", () => {
  const library = [ch("Mia", "always"), ch("Leo", "always"), ch("Steve", "mentioned"), ch("Sarah", "mentioned", ["Mum"])];

  it("always includes regulars and adds guests named by events or aliases", () => {
    const cast = castFor([ev("Playdate with Steve"), ev("Shopping with mum")], library);
    expect(cast.map((m) => m.character.name)).toEqual(["Mia", "Leo", "Steve", "Sarah"]);
    expect(cast[3].reasons).toEqual(["Shopping with mum"]);
  });

  it("leaves out guests nobody mentions", () => {
    expect(castFor([ev("Dentist")], library).map((m) => m.character.name)).toEqual(["Mia", "Leo"]);
  });

  it("caps guests but never drops regulars", () => {
    const cast = castFor([ev("Steve and Sarah")], library, 3);
    expect(cast.map((m) => m.character.name)).toEqual(["Mia", "Leo", "Steve"]);
    expect(castFor([ev("Steve")], library, 1).map((m) => m.character.name)).toEqual(["Mia", "Leo"]);
  });

  it("matches whole words only", () => {
    expect(mentions("Always late", "Al")).toBe(false);
    expect(mentions("Lunch with Al.", "Al")).toBe(true);
    expect(mentions("Zoë's party", "Zoë")).toBe(true);
  });
});

describe("renderTemplate", () => {
  it("fills values, drops empty sections and keeps unknown names", () => {
    const out = renderTemplate("Hi {{name}}.{{#extra}} Extra: {{extra}}{{/extra}} {{oops}}", { name: "Mia", extra: "" });
    expect(out).toBe("Hi Mia. {{oops}}");
  });
});

describe("placeholderValues", () => {
  const thursday = { year: 2026, month: 10, day: 8, hour: 8, minute: 0, weekday: 4 };
  const saturday = { ...thursday, day: 10, weekday: 6 };
  const config: Config = { ...DEFAULT_CONFIG, location: { name: "Sydney, Australia", latitude: -33.9, longitude: 151.2 } };

  it("lists events with times, all-day events without", () => {
    const v = placeholderValues({ now: thursday, events: [ev("Camp", { allDay: true, time: "All day" }), ev("Swim", { location: "Pool" })], cast: [], weather: null, config });
    expect(v.events).toBe("• Camp\n• 9:00 AM — Swim (Pool)");
    expect(v.day).toBe("Thursday");
    expect(v.season).toBe("spring");
  });

  it("uses the weekday or weekend routine on empty days, with a stable note", () => {
    const a = placeholderValues({ now: saturday, events: [], cast: [], weather: null, config });
    const b = placeholderValues({ now: saturday, events: [], cast: [], weather: null, config });
    expect(a.events).toContain("• 🎹 Practice piano & tidy your room");
    expect(a.events).toContain("do not invent");
    expect(a.events).toBe(b.events);
  });

  it("renders the default template without leftover placeholders", () => {
    const v = placeholderValues({ now: thursday, events: [ev("Swim")], cast: castFor([], [ch("Mia", "always")]), weather: null, config });
    const out = renderTemplate(DEFAULT_PROMPT, v);
    expect(out).not.toMatch(/\{\{/);
    expect(out).toContain("1) Mia.");
    expect(out).not.toContain("weather stamp");
  });
});

describe("parseConfig", () => {
  it("rejects bad time zones and calendar URLs", () => {
    expect(() => parseConfig({ ...DEFAULT_CONFIG, timezone: "Mars/Olympus" })).toThrow(/time zone/);
    expect(() => parseConfig({ ...DEFAULT_CONFIG, icalUrl: "ftp://x" })).toThrow(/https/);
  });

  it("stores the default prompt as empty, so template updates reach it", () => {
    expect(parseConfig({ ...DEFAULT_CONFIG, prompt: DEFAULT_PROMPT }).prompt).toBe("");
  });

  it("only accepts photo keys belonging to the character", () => {
    const c = { ...ch("Mia", "always"), photo: "characters/leo-abc" };
    expect(() => parseConfig({ ...DEFAULT_CONFIG, characters: [c] })).toThrow(/photo/);
  });
});

describe("characters' age and gender", () => {
  const oct8 = { year: 2026, month: 10, day: 8, hour: 8, minute: 0, weekday: 4 };

  it("describes people like the old app and leaves pets as a name", () => {
    expect(characterIntro({ ...ch("Mia", "always"), gender: "female", age: 7 }, oct8)).toBe("A girl named Mia, age 7.");
    expect(characterIntro({ ...ch("Sarah", "always"), gender: "female", age: 41 }, oct8)).toBe("A woman named Sarah, age 41.");
    expect(characterIntro({ ...ch("Leo", "always"), gender: "male" }, oct8)).toBe("A boy named Leo.");
    expect(characterIntro({ ...ch("Sam", "always"), age: 30 }, oct8)).toBe("A person named Sam, age 30.");
    expect(characterIntro(ch("Rex", "always"), oct8)).toBe("Rex.");
    expect(characterIntro({ ...ch("Sarah", "always", ["Mum", "Mummy"]), gender: "female", age: 41 }, oct8)).toBe(
      "A woman named Sarah (also known as Mum, Mummy), age 41.",
    );
  });

  it("works the age out from the birthday when there is one", () => {
    const mia = { ...ch("Mia", "always"), age: 5, birthday: "2019-07-28" };
    expect(ageOn(mia, oct8)).toBe(7);
    expect(ageOn({ ...mia, birthday: "2019-10-09" }, oct8)).toBe(6);
    expect(ageOn({ ...mia, birthday: "2019-10-08" }, oct8)).toBe(7);
    expect(ageOn({ ...mia, birthday: "" }, oct8)).toBe(5);
  });
});

describe("countdownsFor", () => {
  const day = (month: number, d: number, year = 2026) => ({ year, month, day: d, hour: 8, minute: 0, weekday: 0 });

  it("counts down to birthdays and holidays within two weeks, soonest first, at most three", () => {
    const people = [{ ...ch("Mia", "always"), birthday: "2019-10-11" }, { ...ch("Leo", "always"), birthday: "2017-10-09" }];
    expect(countdownsFor(people, day(10, 8)).map((c) => c.text)).toEqual([
      "⏰ Leo's birthday is tomorrow!",
      "🎂 3 days until Mia's birthday!",
    ]);
    expect(countdownsFor(people, day(10, 20)).map((c) => c.text)).toEqual(["🎉 11 days until Halloween!"]);
    expect(countdownsFor([{ ...ch("Mia", "always"), birthday: "2019-12-25" }], day(12, 25)).map((c) => c.text)).toEqual([
      "🎂 It's Mia's birthday today!",
      "🎉 Christmas is today!",
      "🎉 7 days until New Year's Day!",
    ]);
  });

  it("finds Easter and wraps into next year", () => {
    expect(countdownsFor([], day(3, 30)).map((c) => c.text)).toContain("🎉 6 days until Easter!"); // Easter 2026: 5 April
    expect(countdownsFor([], day(12, 31)).map((c) => c.text)).toEqual(["⏰ New Year's Day is tomorrow!"]);
  });

  it("puts Feb 29 birthdays on Feb 28 in other years", () => {
    expect(countdownsFor([{ ...ch("Leap", "always"), birthday: "2016-02-29" }], day(2, 27)).map((c) => c.text)[0]).toBe(
      "⏰ Leap's birthday is tomorrow!",
    );
  });
});
