import { decode } from "fast-png";
import { describe, expect, it } from "vitest";
import { batteryLineHeight, batteryLinePng, encodePng, HEIGHT, parseBatteryPercentage } from "../src/image";

describe("battery line", () => {
  it("is full height at 100%, empty at 0%, and proportional in between", () => {
    expect(batteryLineHeight(100)).toBe(HEIGHT);
    expect(batteryLineHeight(0)).toBe(0);
    expect(batteryLineHeight(25)).toBe(HEIGHT / 4);
  });

  it("is a 1px-wide black PNG of the given height", async () => {
    const back = decode(await batteryLinePng(120));
    expect([back.width, back.height]).toEqual([1, 120]);
    expect(back.data.every((v) => v === 0)).toBe(true);
  });

  it("parses the header strictly", () => {
    expect(parseBatteryPercentage("87")).toBe(87);
    expect(parseBatteryPercentage(" 0 ")).toBe(0);
    expect(parseBatteryPercentage("100")).toBe(100);
    for (const bad of [null, "", "-1", "101", "abc", "5.5"]) expect(parseBatteryPercentage(bad)).toBeNull();
  });
});

describe("PNG encoder", () => {
  it("encodes a PNG that decodes back to the same pixels", async () => {
    const w = 7, h = 5, rgb = new Uint8Array(w * h * 3).map((_, i) => (i * 37) % 256);
    const back = decode(await encodePng(rgb, w, h));
    expect([back.width, back.height, back.channels, back.depth]).toEqual([w, h, 3, 8]);
    expect([...back.data]).toEqual([...rgb]);
  });
});
