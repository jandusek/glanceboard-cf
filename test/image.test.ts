import { decode } from "fast-png";
import { describe, expect, it } from "vitest";
import { dither, drawBatteryLine, encodePng, fitToDisplay, HEIGHT, indicesToRgb, parseBatteryPercentage, PALETTE, WIDTH } from "../src/image";

const WHITE = 1;
const blank = () => new Uint8Array(WIDTH * HEIGHT).fill(WHITE);
const inkedRows = (idx: Uint8Array) => {
  const rows: number[] = [];
  for (let y = 0; y < HEIGHT; y++) if (idx[y * WIDTH + WIDTH - 1] !== WHITE) rows.push(y);
  return rows;
};

describe("battery line", () => {
  it("is full height at 100% and empty at 0%", () => {
    expect(inkedRows(drawBatteryLine(blank(), 100))).toHaveLength(HEIGHT);
    expect(inkedRows(drawBatteryLine(blank(), 0))).toEqual([]);
  });

  it("rises from the bottom in proportion", () => {
    const rows = inkedRows(drawBatteryLine(blank(), 25));
    expect(rows).toHaveLength(HEIGHT / 4);
    expect(rows.at(-1)).toBe(HEIGHT - 1);
  });

  it("is one pixel wide", () => {
    const idx = drawBatteryLine(blank(), 100);
    expect(idx[(HEIGHT - 1) * WIDTH + WIDTH - 2]).toBe(WHITE);
  });

  it("parses the header strictly", () => {
    expect(parseBatteryPercentage("87")).toBe(87);
    expect(parseBatteryPercentage(" 0 ")).toBe(0);
    expect(parseBatteryPercentage("100")).toBe(100);
    for (const bad of [null, "", "-1", "101", "abc", "5.5"]) expect(parseBatteryPercentage(bad)).toBeNull();
  });
});

describe("pipeline images", () => {
  it("centre-crops a 16:9 image to 800x480", () => {
    // 1600x900, left third red, rest blue: after cropping the sides, column 0 is still red.
    const w = 1600, h = 900, data = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) data.set(i % w < 533 ? [200, 30, 30] : [0, 50, 180], i * 3);
    const out = fitToDisplay({ width: w, height: h, data });
    expect([out.width, out.height]).toEqual([WIDTH, HEIGHT]);
    expect([...out.data.subarray(0, 3)]).toEqual([200, 30, 30]);
    expect([...out.data.subarray(out.data.length - 3)]).toEqual([0, 50, 180]);
  });

  it("dithers exact palette colours to themselves and keeps the average colour of a flat grey", () => {
    const data = new Uint8Array(WIDTH * HEIGHT * 3).fill(255);
    data.set(PALETTE[2], 0);
    expect(dither({ width: WIDTH, height: HEIGHT, data })[0]).toBe(2);

    const grey = indicesToRgb(dither({ width: WIDTH, height: HEIGHT, data: new Uint8Array(WIDTH * HEIGHT * 3).fill(128) }));
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let i = c; i < grey.length; i += 3) sum += grey[i];
      expect(Math.abs(sum / (WIDTH * HEIGHT) - 128)).toBeLessThan(4);
    }
  });

  it("encodes a PNG that decodes back to the same pixels", async () => {
    const idx = drawBatteryLine(blank(), 50);
    idx[0] = 4;
    const png = await encodePng(indicesToRgb(idx));
    const back = decode(png);
    expect([back.width, back.height, back.channels, back.depth]).toEqual([WIDTH, HEIGHT, 3, 8]);
    expect([...back.data.subarray(0, 3)]).toEqual(PALETTE[4]);
    expect([...back.data]).toEqual([...indicesToRgb(idx)]);
  });
});
