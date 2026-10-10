export interface ReferencePhoto {
  label: string;
  mimeType: string;
  data: Uint8Array;
}

export interface GeneratedImage {
  mimeType: string;
  data: Uint8Array;
}

const API = "https://generativelanguage.googleapis.com/v1beta/models";

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * One image from a Gemini image model. Reference photos go first, each preceded
 * by a text part naming who it shows, so the model can match photos to names.
 */
export async function generateImage(
  apiKey: string, model: string, prompt: string, photos: ReferencePhoto[],
): Promise<GeneratedImage> {
  const parts: object[] = [];
  for (const p of photos) {
    parts.push({ text: `Reference photo labelled ${p.label}:` });
    parts.push({ inline_data: { mime_type: p.mimeType, data: toBase64(p.data) } });
  }
  parts.push({ text: prompt });

  const body = JSON.stringify({
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ["IMAGE", "TEXT"],
      // 16:9 is the closest supported ratio to the panel's 5:3; the sides get trimmed.
      imageConfig: { aspectRatio: "16:9" },
    },
  });

  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`${API}/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body,
    });
    if (res.status === 429 || res.status >= 500) {
      lastError = `Gemini returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
      await new Promise((r) => setTimeout(r, 5000 * attempt));
      continue;
    }
    if (!res.ok) throw new Error(`Gemini returned HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);

    const json = (await res.json()) as GeminiResponse;
    for (const candidate of json.candidates ?? []) {
      for (const part of candidate.content?.parts ?? []) {
        const blob = part.inlineData ?? part.inline_data;
        if (blob?.data) return { mimeType: blob.mimeType ?? blob.mime_type ?? "image/png", data: fromBase64(blob.data) };
      }
    }
    lastError = `Gemini returned no image (${describeImageless(json)})`;
  }
  throw new Error(lastError);
}

interface Blob64 {
  data?: string;
  mimeType?: string;
  mime_type?: string;
}

interface GeminiResponse {
  candidates?: { finishReason?: string; content?: { parts?: { text?: string; inlineData?: Blob64; inline_data?: Blob64 }[] } }[];
  promptFeedback?: { blockReason?: string };
}

function describeImageless(r: GeminiResponse): string {
  const bits: string[] = [];
  if (r.promptFeedback?.blockReason) bits.push(`blocked: ${r.promptFeedback.blockReason}`);
  for (const c of r.candidates ?? []) {
    if (c.finishReason) bits.push(`finish reason ${c.finishReason}`);
    const text = (c.content?.parts ?? []).map((p) => p.text ?? "").join(" ").trim();
    if (text) bits.push(`said "${text.slice(0, 200)}"`);
  }
  return bits.join(", ") || "empty response";
}
