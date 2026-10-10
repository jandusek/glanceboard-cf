import { afterEach, describe, expect, it, vi } from "vitest";
import { generateImage } from "../src/gemini";

// Mocked fetch only: real image generation costs money per call.

const imageResponse = (mimeType = "image/png") =>
  Response.json({ candidates: [{ content: { parts: [{ text: "Here you go" }, { inlineData: { mimeType, data: btoa("PNGDATA") } }] } }] });

function mockFetch(...responses: Response[]) {
  const fn = vi.fn(async (..._args: [string, RequestInit]) => responses.shift() ?? new Response("unexpected", { status: 500 }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("generateImage", () => {
  it("sends labelled reference photos before the prompt, with the key in a header", async () => {
    const fetch = mockFetch(imageResponse());
    const out = await generateImage("KEY", "gemini-3-pro-image", "Draw Mia", [
      { label: "Mia", mimeType: "image/jpeg", data: new Uint8Array([1, 2, 3]) },
    ]);

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent");
    expect(url).not.toContain("KEY");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("KEY");

    const body = JSON.parse(init.body as string);
    expect(body.contents[0].parts).toEqual([
      { text: "Reference photo labelled Mia:" },
      { inline_data: { mime_type: "image/jpeg", data: btoa("\x01\x02\x03") } },
      { text: "Draw Mia" },
    ]);
    expect(body.generationConfig).toEqual({ responseModalities: ["IMAGE", "TEXT"], imageConfig: { aspectRatio: "16:9" } });

    expect(out.mimeType).toBe("image/png");
    expect(new TextDecoder().decode(out.data)).toBe("PNGDATA");
  });

  it("retries after a 429", async () => {
    vi.useFakeTimers();
    const fetch = mockFetch(new Response("slow down", { status: 429 }), imageResponse("image/jpeg"));
    const pending = generateImage("KEY", "m", "p", []);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await pending).mimeType).toBe("image/jpeg");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("explains a response without an image, and doesn't retry other 4xx errors", async () => {
    mockFetch(
      Response.json({ candidates: [{ finishReason: "SAFETY", content: { parts: [{ text: "Can't draw that" }] } }] }),
      Response.json({ promptFeedback: { blockReason: "OTHER" } }),
      Response.json({}),
    );
    await expect(generateImage("KEY", "m", "p", [])).rejects.toThrow(/no image \(empty response\)/);

    mockFetch(new Response("bad model", { status: 404 }));
    await expect(generateImage("KEY", "m", "p", [])).rejects.toThrow(/HTTP 404: bad model/);
  });
});
