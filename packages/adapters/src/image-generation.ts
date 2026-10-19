/**
 * Image generation over an OpenAI-compatible chat endpoint.
 *
 * Image models that speak the chat protocol return their pixels as an
 * `image_url` part inside the assistant message or in its `images` array,
 * alongside optional text. This needs no second API surface or vendor SDK.
 *
 * Kept free of Prisma, the secret store, and the sandbox so the parsing and the
 * request/response contract can be tested offline; the executor supplies the
 * already-resolved endpoint, credential, and abort signal.
 */

/** Every image part carries base64, so cap what one response may cost. */
export const MAX_IMAGE_RESPONSE_BYTES = 14 * 1024 * 1024;
/** Generated outputs must fit in the artifact attachment limit. */
export const MAX_GENERATED_IMAGE_BYTES = 10 * 1024 * 1024;
/** A generated prompt is text; refuse absurd ones before spending a request. */
export const MAX_IMAGE_PROMPT_CHARS = 4_000;

const SUPPORTED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type GeneratedImageMimeType = (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];

export type GeneratedImage = {
  bytes: Uint8Array;
  mimeType: GeneratedImageMimeType;
  /** The text the model returned with the image, when it returned any. */
  text?: string;
};

export const NO_IMAGE_IN_RESPONSE_MESSAGE =
  "The image model returned no image. Check that the model id generates images rather than only reading them.";

export function isSupportedImageMimeType(value: string): value is GeneratedImageMimeType {
  return (SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(value);
}

/** Extension for the artifact name, so the stored file matches its real bytes. */
export function imageExtensionForMimeType(mimeType: GeneratedImageMimeType): string {
  return mimeType === "image/jpeg" ? "jpg" : mimeType.slice("image/".length);
}

/**
 * Identify the bytes rather than trusting the declared type: a data URL is
 * written by the endpoint, and an artifact with a mismatched extension would
 * fail to render later, far from here.
 */
export function sniffImageMimeType(bytes: Uint8Array): GeneratedImageMimeType | undefined {
  if (bytes.length >= 8) {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (png.every((byte, index) => bytes[index] === byte)) return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6) {
    const header = String.fromCharCode(...bytes.subarray(0, 6));
    if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  }
  if (bytes.length >= 12) {
    const riff = String.fromCharCode(...bytes.subarray(0, 4));
    const webp = String.fromCharCode(...bytes.subarray(8, 12));
    if (riff === "RIFF" && webp === "WEBP") return "image/webp";
  }
  return undefined;
}

type ContentPart = Record<string, unknown>;

/** The `url` of an `image_url` part, whether it is nested or flat. */
function imageUrlFromPart(part: ContentPart): string | undefined {
  const nested = part.image_url;
  if (typeof nested === "string") return nested;
  if (nested && typeof nested === "object") {
    const url = (nested as ContentPart).url;
    if (typeof url === "string") return url;
  }
  const flat = part.url;
  return typeof flat === "string" ? flat : undefined;
}

/**
 * Decode one assistant message into image bytes.
 *
 * Accepts a content string or an array of parts, because endpoints disagree on
 * which they send, and tolerates remote URLs only by ignoring them: fetching a
 * URL the model chose would make the server an open proxy, and every image
 * model used here returns inline base64.
 */
export function decodeGeneratedImage(message: unknown): GeneratedImage | undefined {
  if (!message || typeof message !== "object") return undefined;
  const assistant = message as ContentPart;
  const content = assistant.content;
  const contentParts: ContentPart[] = Array.isArray(content)
    ? (content as ContentPart[]).filter(
        (part): part is ContentPart => Boolean(part) && typeof part === "object",
      )
    : [];
  // Gateways disagree on whether generated images are embedded in `content`
  // or returned separately in the OpenRouter-style `images` field.
  const images = Array.isArray(assistant.images)
    ? assistant.images.filter(
        (part): part is ContentPart => Boolean(part) && typeof part === "object",
      )
    : [];
  const parts = [...contentParts, ...images];

  const texts: string[] = [];
  if (typeof content === "string") texts.push(content);
  for (const part of contentParts) {
    if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
  }

  for (const part of parts) {
    if (part.type !== "image_url") continue;
    const url = imageUrlFromPart(part);
    if (!url?.startsWith("data:")) continue;
    const comma = url.indexOf(",");
    if (comma < 0) continue;
    const header = url.slice("data:".length, comma);
    const isBase64 = header.split(";").includes("base64");
    if (!isBase64) continue;
    const declared = header.split(";")[0]?.trim() ?? "";
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(Buffer.from(url.slice(comma + 1), "base64"));
    } catch {
      continue;
    }
    if (bytes.byteLength === 0) continue;
    // The bytes decide the type: a data URL is written by the endpoint, and a
    // mismatched extension would only fail much later, when the image renders.
    const mimeType =
      sniffImageMimeType(bytes) ?? (isSupportedImageMimeType(declared) ? declared : undefined);
    if (!mimeType) continue;
    const text = texts.join("\n").trim();
    return { bytes, mimeType, ...(text ? { text } : {}) };
  }
  return undefined;
}

export type GenerateImageRequest = {
  baseUrl: string;
  apiKey?: string;
  model: string;
  prompt: string;
  signal?: AbortSignal;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
};

/** One `POST /chat/completions` asking for an image and the text that describes it. */
export async function generateImage(request: GenerateImageRequest): Promise<GeneratedImage> {
  const prompt = request.prompt.trim();
  if (!prompt) throw new Error("Describe the image to generate");
  if (prompt.length > MAX_IMAGE_PROMPT_CHARS) {
    throw new Error(`Keep the image prompt under ${MAX_IMAGE_PROMPT_CHARS} characters`);
  }
  const endpoint = `${request.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const response = await (request.fetch ?? globalThis.fetch)(endpoint, {
    method: "POST",
    redirect: "error",
    signal: request.signal,
    headers: {
      "Content-Type": "application/json",
      ...(request.apiKey ? { Authorization: `Bearer ${request.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: request.model,
      // Ask for both, so the model's own description can caption the attachment.
      modalities: ["image", "text"],
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300).trim();
    throw new Error(
      `Image model request failed (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_IMAGE_RESPONSE_BYTES) {
    throw new Error("Image model response is too large");
  }
  const body = (await response.json()) as Record<string, unknown>;
  const choices = body.choices;
  const message = Array.isArray(choices)
    ? ((choices[0] as ContentPart | undefined)?.message as ContentPart | undefined)
    : undefined;
  const image = decodeGeneratedImage(message);
  if (!image) throw new Error(NO_IMAGE_IN_RESPONSE_MESSAGE);
  if (image.bytes.byteLength > MAX_GENERATED_IMAGE_BYTES) {
    throw new Error("Generated image is too large");
  }
  return image;
}
