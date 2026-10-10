import { describe, expect, it, vi } from "vitest";
import type { CalendarEvent } from "../src/calendar";
import { parsePolished, polish } from "../src/polish";

const ev = (summary: string): CalendarEvent => ({ summary, time: "9:00 AM", startMs: 0, allDay: false, location: "", description: "" });

function fakeKv() {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => (store.has(k) ? JSON.parse(store.get(k)!) : null),
    put: async (k: string, v: string) => void store.set(k, v),
  } as unknown as KVNamespace;
}

describe("parsePolished", () => {
  it("reads both Workers AI output shapes", () => {
    const body = { events: ["🏊 9:00 AM Swimming lesson"], scene: "A sunny pool." };
    expect(parsePolished({ response: body }, 1)).toEqual(body);
    expect(parsePolished({ choices: [{ message: { content: "```json\n" + JSON.stringify(body) + "\n```" } }] }, 1)).toEqual(body);
  });

  it("rejects a wrong number of events", () => {
    expect(() => parsePolished({ response: { events: [], scene: "" } }, 1)).toThrow(/wrong number/);
    expect(() => parsePolished({ response: "not json" }, 1)).toThrow(/valid JSON/);
  });
});

describe("polish", () => {
  const input = { date: "2026-10-08", season: "spring", location: "Sydney", weather: null, events: [ev("Swim")] };

  it("calls the model once per distinct input and reuses the cached result", async () => {
    const run = vi.fn(async () => ({ response: { events: ["🏊 9:00 AM Swim time"], scene: "Bondi pool." } }));
    const ai = { run } as unknown as Ai;
    const kv = fakeKv();

    const a = await polish(ai, kv, "@cf/x", input);
    const b = await polish(ai, kv, "@cf/x", input);
    expect(a).toEqual(b);
    expect(run).toHaveBeenCalledTimes(1);

    // New input calls again; a wrong answer (one line for two events) is retried once, then fails.
    await expect(polish(ai, kv, "@cf/x", { ...input, events: [ev("Swim"), ev("Piano")] })).rejects.toThrow(/wrong number/);
    expect(run).toHaveBeenCalledTimes(3);
  });
});
