import { decode as decodePngData, convertIndexedToRgb } from "fast-png";
import jpeg from "jpeg-js";

export const WIDTH = 800;
export const HEIGHT = 480;

/** Spectra 6 inks, in the order of the indices stored in display.idx. */
export const PALETTE: readonly [number, number, number][] = [
  [0, 0, 0], // black
  [255, 255, 255], // white
  [200, 30, 30], // red
  [0, 128, 0], // green
  [0, 50, 180], // blue
  [230, 200, 0], // yellow
];
const BLACK = 0;

export interface Rgb {
  width: number;
  height: number;
  /** Packed RGB, 3 bytes per pixel. */
  data: Uint8Array;
}

export function decodeImage(bytes: Uint8Array, mimeType: string): Rgb {
  if (mimeType.includes("jpeg") || mimeType.includes("jpg") || (bytes[0] === 0xff && bytes[1] === 0xd8)) {
    const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: false, maxMemoryUsageInMB: 256 });
    return { width: img.width, height: img.height, data: img.data };
  }
  const png = decodePngData(bytes);
  let src: ArrayLike<number> = png.data;
  let channels = png.channels;
  if (png.palette) {
    src = convertIndexedToRgb(png);
    channels = png.palette[0].length;
  }
  const shift = png.depth === 16 ? 8 : 0;
  const n = png.width * png.height;
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const s = i * channels;
    if (channels >= 3) {
      out[i * 3] = src[s] >> shift;
      out[i * 3 + 1] = src[s + 1] >> shift;
      out[i * 3 + 2] = src[s + 2] >> shift;
    } else {
      const g = src[s] >> shift;
      out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = g;
    }
  }
  return { width: png.width, height: png.height, data: out };
}

/** Centre-crop to 5:3 and area-average down (or sample up) to 800×480. */
export function fitToDisplay(img: Rgb): Rgb {
  const target = WIDTH / HEIGHT;
  let cw = img.width;
  let ch = img.height;
  if (cw / ch > target) cw = Math.round(ch * target);
  else ch = Math.round(cw / target);
  const ox = Math.floor((img.width - cw) / 2);
  const oy = Math.floor((img.height - ch) / 2);

  const out = new Uint8Array(WIDTH * HEIGHT * 3);
  const sx = cw / WIDTH;
  const sy = ch / HEIGHT;
  for (let y = 0; y < HEIGHT; y++) {
    const y0 = oy + Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, oy + Math.floor((y + 1) * sy));
    for (let x = 0; x < WIDTH; x++) {
      const x0 = ox + Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, ox + Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0;
      for (let yy = y0; yy < y1; yy++) {
        let p = (yy * img.width + x0) * 3;
        for (let xx = x0; xx < x1; xx++, p += 3) {
          r += img.data[p];
          g += img.data[p + 1];
          b += img.data[p + 2];
        }
      }
      const count = (y1 - y0) * (x1 - x0);
      const o = (y * WIDTH + x) * 3;
      out[o] = Math.round(r / count);
      out[o + 1] = Math.round(g / count);
      out[o + 2] = Math.round(b / count);
    }
  }
  return { width: WIDTH, height: HEIGHT, data: out };
}

/** Floyd–Steinberg to the six e-ink inks. Returns one palette index per pixel. */
export function dither(img: Rgb): Uint8Array {
  const { width, height } = img;
  const buf = Float32Array.from(img.data);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const r = buf[i], g = buf[i + 1], b = buf[i + 2];
      let best = 0;
      let bestDist = Infinity;
      for (let k = 0; k < PALETTE.length; k++) {
        const [pr, pg, pb] = PALETTE[k];
        const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
        if (d < bestDist) {
          bestDist = d;
          best = k;
        }
      }
      out[y * width + x] = best;
      const [pr, pg, pb] = PALETTE[best];
      const er = r - pr, eg = g - pg, eb = b - pb;
      const spread = (dx: number, dy: number, f: number) => {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= width || ny >= height) return;
        const j = (ny * width + nx) * 3;
        buf[j] += er * f;
        buf[j + 1] += eg * f;
        buf[j + 2] += eb * f;
      };
      spread(1, 0, 7 / 16);
      spread(-1, 1, 3 / 16);
      spread(0, 1, 5 / 16);
      spread(1, 1, 1 / 16);
    }
  }
  return out;
}

export function parseBatteryPercentage(value: string | null): number | null {
  if (value === null || !/^\s*\d{1,3}\s*$/.test(value)) return null;
  const pct = Number(value);
  return pct <= 100 ? pct : null;
}

/**
 * A 1px black line on the right edge, rising from the bottom: full height at
 * 100%, nothing at 0%. Mutates and returns the index buffer.
 */
export function drawBatteryLine(indices: Uint8Array, pct: number, width = WIDTH, height = HEIGHT): Uint8Array {
  const h = Math.round((height * pct) / 100);
  for (let y = height - h; y < height; y++) indices[y * width + width - 1] = BLACK;
  return indices;
}

export function indicesToRgb(indices: Uint8Array): Uint8Array {
  const out = new Uint8Array(indices.length * 3);
  for (let i = 0; i < indices.length; i++) out.set(PALETTE[indices[i]], i * 3);
  return out;
}

// ─── PNG encoding (8-bit RGB, zlib via CompressionStream) ─────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function zlib(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodePng(rgb: Uint8Array, width = WIDTH, height = HEIGHT): Promise<Uint8Array> {
  // Filter type 0 (None) on every row: dithered art compresses well without it.
  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);

  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", await zlib(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
