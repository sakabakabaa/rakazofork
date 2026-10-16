import { JSDOM } from "jsdom";
import { BUSY, concurrencyLimit } from "./concurrency-limit.js";
import type { ResolveHostname } from "./network-address.js";
import { fetchSafeWebBytes } from "./web-ssrf.js";

const PAGE_MAX_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 3;
const ALLOWED_PORTS = [80, 443] as const;
const MAX_CONCURRENT = 4;
const MAX_WAITING = 32;
const MAX_WAIT_MS = 4_000;
/** One budget for a whole lookup, so a slow site cannot hold a slot for every fetch's timeout. */
const LOOKUP_DEADLINE_MS = 8_000;
const MAX_CACHED_URLS = 500;
const FOUND_TTL_MS = 24 * 60 * 60 * 1000;
const MISSING_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 320;
const MAX_IMAGE_URL_LENGTH = 2_000;

/**
 * Query keys that name a one-time action or a credential. A link carrying one is not fetched:
 * the request itself can consume a reset link or leak a token to the site's logs. The favicon
 * resolver sidesteps this by only ever fetching an origin, but a preview needs the real path,
 * so this guard stands in for that protection.
 *
 * Matched on the normalised name (lowercased, separators removed) so `api_key`, `apiKey`,
 * `access_token`, and `cliKey` are all caught. A name merely *ending* in one of these words
 * counts, because services prefix them freely — `cliKey` was a real credential seen in this
 * deployment. Anything unrecognised still fetches, so this fails closed only on the known shapes.
 */
const SENSITIVE_QUERY_KEY =
  /^(?:confirm|confirmation|invite|magic|reset|verify)$|(?:key|token|secret|password|passwd|pwd|signature|sig|credential|code|otp|pin|auth|session)$/;

export type LinkPreview = {
  url: string;
  title: string;
  description?: string;
  siteName?: string;
  /** Remote image for the card. The client only loads it when the reader opted into remote images. */
  imageUrl?: string;
};

export type LinkPreviewAnswer = {
  preview: LinkPreview | null;
  /** Set when a full queue turned the request away, so the client may ask again later. */
  retry?: true;
};

export type LinkPreviewResolver = {
  preview(url: string): Promise<LinkPreviewAnswer>;
};

export type LinkPreviewResolverOptions = {
  fetch?: typeof globalThis.fetch;
  resolveHostname?: ResolveHostname;
  now?: () => number;
  /** Test seams for the queue and deadline; the defaults suit production. */
  limits?: {
    maxConcurrent?: number;
    maxWaiting?: number;
    maxWaitMs?: number;
    deadlineMs?: number;
    maxCachedUrls?: number;
  };
};

/** Whether a link is safe to fetch for a preview, before any network work happens. */
export function isUnfurlableUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  for (const key of url.searchParams.keys()) {
    // Normalise so `api_key`, `apiKey`, and `cliKey` all reduce to a checkable word.
    if (SENSITIVE_QUERY_KEY.test(key.toLowerCase().replace(/[^a-z0-9]/g, ""))) return false;
  }
  return true;
}

/** The URL to fetch and to key the cache by: fragments never reach the server. */
export function linkPreviewTarget(value: string): string | undefined {
  if (!isUnfurlableUrl(value)) return undefined;
  const url = new URL(value);
  url.hash = "";
  return url.href;
}

/**
 * Resolves Open Graph metadata for a link so a chat message can show a preview card.
 *
 * Every hop goes through the SSRF-checked fetch, and answers are cached per URL, misses
 * included. The remote image is returned as a URL rather than proxied: the client only loads
 * it when the reader has already opted into remote images, so a device never contacts a linked
 * site on its own.
 */
export function createLinkPreviewResolver(
  options: LinkPreviewResolverOptions = {},
): LinkPreviewResolver {
  const now = options.now ?? Date.now;
  const cache = new Map<string, { preview: LinkPreview | null; expiresAt: number }>();
  const inFlight = new Map<string, Promise<LinkPreviewAnswer>>();
  const maxCachedUrls = options.limits?.maxCachedUrls ?? MAX_CACHED_URLS;
  const limit = concurrencyLimit(
    options.limits?.maxConcurrent ?? MAX_CONCURRENT,
    options.limits?.maxWaiting ?? MAX_WAITING,
    options.limits?.maxWaitMs ?? MAX_WAIT_MS,
  );
  const deadlineMs = options.limits?.deadlineMs ?? LOOKUP_DEADLINE_MS;

  const remember = (url: string, preview: LinkPreview | null) => {
    cache.delete(url);
    cache.set(url, { preview, expiresAt: now() + (preview ? FOUND_TTL_MS : MISSING_TTL_MS) });
    while (cache.size > maxCachedUrls) {
      cache.delete(cache.keys().next().value!);
    }
  };

  return {
    async preview(input) {
      const target = linkPreviewTarget(input);
      if (!target) return { preview: null };

      const cached = cache.get(target);
      if (cached && cached.expiresAt > now()) {
        // Least recently used first: Map order, refreshed on every hit.
        cache.delete(target);
        cache.set(target, cached);
        return { preview: cached.preview };
      }
      const pending = inFlight.get(target);
      if (pending) return pending;

      // A request turned away by a full queue is not a miss: it is not remembered, and the
      // answer tells the client to ask again later.
      const lookup = limit(() =>
        resolvePreview(target, options, AbortSignal.timeout(deadlineMs)).catch(() => null),
      )
        .then((result): LinkPreviewAnswer => {
          if (result === BUSY) return { preview: null, retry: true };
          remember(target, result);
          return { preview: result };
        })
        .finally(() => inFlight.delete(target));
      inFlight.set(target, lookup);
      return lookup;
    },
  };
}

async function resolvePreview(
  target: string,
  options: LinkPreviewResolverOptions,
  signal: AbortSignal,
): Promise<LinkPreview | null> {
  const response = await fetchSafeWebBytes(target, {
    fetch: options.fetch,
    resolveHostname: options.resolveHostname,
    timeoutMs: FETCH_TIMEOUT_MS,
    maxBytes: PAGE_MAX_BYTES,
    maxRedirects: MAX_REDIRECTS,
    allowedPorts: ALLOWED_PORTS,
    truncate: true,
    signal,
  });
  // Unlike web_fetch, which decodes any body as text, a preview only makes sense for a document.
  const contentType = (response.contentType ?? "").toLowerCase();
  if (!contentType.includes("html")) return null;
  return readMetadata(new TextDecoder().decode(response.body), response.url);
}

/**
 * Reads Open Graph tags, falling back to Twitter's and then to the plain document tags.
 * Returns null when nothing useful was found, so the client renders no card.
 */
export function readMetadata(html: string, pageUrl: string): LinkPreview | null {
  let document: Document;
  try {
    document = new JSDOM(html).window.document;
  } catch {
    return null;
  }
  const meta = (selectors: string[]): string | undefined => {
    for (const selector of selectors) {
      const value = document.querySelector(selector)?.getAttribute("content")?.trim();
      if (value) return value;
    }
    return undefined;
  };

  const title = clamp(
    meta(['meta[property="og:title"]', 'meta[name="twitter:title"]']) ??
      document.querySelector("title")?.textContent ??
      "",
    MAX_TITLE_LENGTH,
  );
  // A card with no title says nothing a bare link did not already say.
  if (!title) return null;

  const description = clamp(
    meta([
      'meta[property="og:description"]',
      'meta[name="twitter:description"]',
      'meta[name="description"]',
    ]) ?? "",
    MAX_DESCRIPTION_LENGTH,
  );
  const siteName = clamp(
    meta(['meta[property="og:site_name"]']) ?? new URL(pageUrl).hostname.replace(/^www\./, ""),
    MAX_TITLE_LENGTH,
  );
  const imageUrl = absoluteImageUrl(
    meta(['meta[property="og:image"]', 'meta[name="twitter:image"]']),
    pageUrl,
  );

  return {
    url: pageUrl,
    title,
    ...(description ? { description } : {}),
    ...(siteName ? { siteName } : {}),
    ...(imageUrl ? { imageUrl } : {}),
  };
}

/** Resolves a relative image against the page, and drops anything that is not an http(s) URL. */
function absoluteImageUrl(value: string | undefined, pageUrl: string): string | undefined {
  if (!value || value.length > MAX_IMAGE_URL_LENGTH) return undefined;
  try {
    const url = new URL(value, pageUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

function clamp(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1).trimEnd()}\u2026` : collapsed;
}
