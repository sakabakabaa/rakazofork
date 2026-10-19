import { describe, expect, it, vi } from "vitest";
import {
  decodeGeneratedImage,
  generateImage,
  imageExtensionForMimeType,
  MAX_IMAGE_PROMPT_CHARS,
  NO_IMAGE_IN_RESPONSE_MESSAGE,
  sniffImageMimeType,
} from "./image-generation.js";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const WEBP_BYTES = Buffer.from("RIFF\x24\x00\x00\x00WEBPVP8 ", "binary");
const GIF_BYTES = Buffer.from("GIF89a\x01\x00", "binary");

function dataUrl(mimeType: string, bytes: Buffer) {
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

function assistantMessage(parts: unknown[]) {
  return { choices: [{ message: { role: "assistant", content: parts } }] };
}

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

describe("sniffImageMimeType", () => {
  it("identifies each supported container from its magic bytes", () => {
    expect(sniffImageMimeType(PNG_BYTES)).toBe("image/png");
    expect(sniffImageMimeType(JPEG_BYTES)).toBe("image/jpeg");
    expect(sniffImageMimeType(WEBP_BYTES)).toBe("image/webp");
    expect(sniffImageMimeType(GIF_BYTES)).toBe("image/gif");
  });

  it("refuses bytes it does not recognize", () => {
    expect(sniffImageMimeType(Buffer.from("not an image"))).toBeUndefined();
    expect(sniffImageMimeType(Buffer.alloc(0))).toBeUndefined();
  });
});

describe("imageExtensionForMimeType", () => {
  it("uses jpg for jpeg, because that is what artifact names expect", () => {
    expect(imageExtensionForMimeType("image/jpeg")).toBe("jpg");
    expect(imageExtensionForMimeType("image/png")).toBe("png");
    expect(imageExtensionForMimeType("image/webp")).toBe("webp");
  });
});

describe("decodeGeneratedImage", () => {
  it("decodes an image_url part and keeps the model's text as a caption", () => {
    const image = decodeGeneratedImage({
      content: [
        { type: "text", text: "A red circle" },
        { type: "image_url", image_url: { url: dataUrl("image/png", PNG_BYTES) } },
      ],
    });
    expect(image?.mimeType).toBe("image/png");
    expect(image?.text).toBe("A red circle");
    expect(Buffer.from(image!.bytes)).toEqual(PNG_BYTES);
  });

  it("accepts a flat image_url string and a nested object alike", () => {
    const flat = decodeGeneratedImage({
      content: [{ type: "image_url", image_url: dataUrl("image/png", PNG_BYTES) }],
    });
    expect(flat?.mimeType).toBe("image/png");
  });

  it("decodes gateway responses that return images separately from content", () => {
    const image = decodeGeneratedImage({
      content: [{ type: "text", text: "A blue mug" }],
      images: [{ type: "image_url", image_url: { url: dataUrl("image/png", PNG_BYTES) } }],
    });
    expect(image?.mimeType).toBe("image/png");
    expect(image?.text).toBe("A blue mug");
    expect(Buffer.from(image!.bytes)).toEqual(PNG_BYTES);
  });

  it("trusts the bytes over a wrong declared type", () => {
    // A JPEG labeled as PNG would otherwise be stored with a .png extension.
    const image = decodeGeneratedImage({
      content: [{ type: "image_url", image_url: { url: dataUrl("image/png", JPEG_BYTES) } }],
    });
    expect(image?.mimeType).toBe("image/jpeg");
  });

  it("ignores a remote URL rather than fetching what the model chose", () => {
    const image = decodeGeneratedImage({
      content: [{ type: "image_url", image_url: { url: "https://example.test/a.png" } }],
    });
    expect(image).toBeUndefined();
  });

  it("returns undefined when the message carries no image", () => {
    expect(decodeGeneratedImage({ content: [{ type: "text", text: "hi" }] })).toBeUndefined();
    expect(decodeGeneratedImage({ content: "just text" })).toBeUndefined();
    expect(decodeGeneratedImage(null)).toBeUndefined();
  });

  it("ignores an empty or non-base64 data URL", () => {
    expect(
      decodeGeneratedImage({
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64," } }],
      }),
    ).toBeUndefined();
    expect(
      decodeGeneratedImage({
        content: [{ type: "image_url", image_url: { url: "data:image/png,raw" } }],
      }),
    ).toBeUndefined();
  });
});

describe("generateImage", () => {
  it("posts the prompt with both modalities and returns the decoded image", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        assistantMessage([
          { type: "text", text: "A red circle" },
          { type: "image_url", image_url: { url: dataUrl("image/png", PNG_BYTES) } },
        ]),
      ),
    );

    const image = await generateImage({
      baseUrl: "https://models.test/v1/",
      apiKey: "sk-test",
      model: "test/image-model",
      prompt: "  a red circle  ",
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    expect(image.mimeType).toBe("image/png");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://models.test/v1/chat/completions");
    expect(init.redirect).toBe("error");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: "test/image-model",
      modalities: ["image", "text"],
      messages: [{ role: "user", content: "a red circle" }],
    });
  });

  it("omits the Authorization header for a keyless local endpoint", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        assistantMessage([
          { type: "image_url", image_url: { url: dataUrl("image/png", PNG_BYTES) } },
        ]),
      ),
    );
    await generateImage({
      baseUrl: "http://127.0.0.1:8080/v1",
      model: "local",
      prompt: "x",
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("rejects an empty or oversized prompt before spending a request", async () => {
    const fetchMock = vi.fn();
    await expect(
      generateImage({
        baseUrl: "https://x.test",
        model: "m",
        prompt: "   ",
        fetch: fetchMock as never,
      }),
    ).rejects.toThrow("Describe the image to generate");
    await expect(
      generateImage({
        baseUrl: "https://x.test",
        model: "m",
        prompt: "a".repeat(MAX_IMAGE_PROMPT_CHARS + 1),
        fetch: fetchMock as never,
      }),
    ).rejects.toThrow("Keep the image prompt under");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces the endpoint's status and detail on failure", async () => {
    const fetchMock = vi.fn(async () => new Response("no such model", { status: 404 }));
    await expect(
      generateImage({
        baseUrl: "https://x.test/v1",
        model: "m",
        prompt: "a",
        fetch: fetchMock as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow("Image model request failed (404): no such model");
  });

  it("explains a text-only reply instead of returning an empty attachment", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(assistantMessage([{ type: "text", text: "I cannot draw." }])),
    );
    await expect(
      generateImage({
        baseUrl: "https://x.test/v1",
        model: "m",
        prompt: "a",
        fetch: fetchMock as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow(NO_IMAGE_IN_RESPONSE_MESSAGE);
  });
});
