import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fetch as undiciFetch } from "undici";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LinkPreviewResolver } from "./link-preview.js";
import {
  createLinkPreviewResolver,
  isUnfurlableUrl,
  linkPreviewTarget,
  readMetadata,
} from "./link-preview.js";
import type { ResolveHostname } from "./network-address.js";

type Reply = { status?: number; headers?: Record<string, string>; body?: string };
type Route = Reply | (() => Promise<Reply>);

// One local server stands in for every site. The injected fetch sends each request to it with
// the site's host in a header, so the SSRF checks still see the public-looking test hostnames.
const routes = new Map<string, Route>();
const hits: string[] = [];
let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const key = `${request.headers["x-test-host"]}${request.url}`;
    hits.push(key);
    const route = routes.get(key);
    const reply = typeof route === "function" ? await route() : route;
    response.writeHead(reply ? (reply.status ?? 200) : 404, reply?.headers ?? {});
    response.end(reply?.body ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  routes.clear();
  hits.length = 0;
});

const testFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const headers = { ...Object.fromEntries(new Headers(init?.headers)), "x-test-host": url.host };
  const { dispatcher: _dispatcher, ...rest } = (init ?? {}) as RequestInit & {
    dispatcher?: unknown;
  };
  return (await undiciFetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
    ...(rest as object),
    headers,
  })) as unknown as Response;
};

const publicResolver: ResolveHostname = async () => [{ address: "203.0.113.10", family: 4 }];

function resolver(
  resolveHostname: ResolveHostname = publicResolver,
  limits?: NonNullable<Parameters<typeof createLinkPreviewResolver>[0]>["limits"],
): LinkPreviewResolver {
  return createLinkPreviewResolver({ fetch: testFetch, resolveHostname, limits });
}

function html(body: string): Reply {
  return { headers: { "content-type": "text/html; charset=utf-8" }, body };
}

const PAGE = `<!doctype html><html><head>
<meta property="og:title" content="Deploying Rakazo">
<meta property="og:description" content="A self-hosted guide">
<meta property="og:site_name" content="Example Docs">
<meta property="og:image" content="/cover.png">
</head><body>hello</body></html>`;

describe("isUnfurlableUrl", () => {
  it("accepts ordinary http and https links", () => {
    expect(isUnfurlableUrl("https://example.com/docs/intro")).toBe(true);
    expect(isUnfurlableUrl("http://example.com/a?page=2")).toBe(true);
  });

  it("refuses anything that is not a web link", () => {
    expect(isUnfurlableUrl("mailto:a@example.com")).toBe(false);
    expect(isUnfurlableUrl("javascript:alert(1)")).toBe(false);
    expect(isUnfurlableUrl("not a url")).toBe(false);
    expect(isUnfurlableUrl("https://user:pw@example.com/")).toBe(false);
  });

  // A request to a one-time link consumes it, and a token in a query reaches the site's logs.
  it("refuses links whose query names a credential or a one-time action", () => {
    expect(isUnfurlableUrl("https://example.com/reset?token=abc")).toBe(false);
    expect(isUnfurlableUrl("https://example.com/x?api_key=abc")).toBe(false);
    expect(isUnfurlableUrl("https://example.com/x?access_token=abc")).toBe(false);
    expect(isUnfurlableUrl("https://example.com/invite?code=abc")).toBe(false);
  });

  it("keeps harmless query parameters", () => {
    expect(isUnfurlableUrl("https://example.com/search?q=rakazo&lang=en")).toBe(true);
  });
});

describe("linkPreviewTarget", () => {
  it("drops the fragment so it never reaches the server", () => {
    expect(linkPreviewTarget("https://example.com/docs#section-3")).toBe(
      "https://example.com/docs",
    );
  });

  it("returns undefined for a link that must not be fetched", () => {
    expect(linkPreviewTarget("https://example.com/reset?token=abc")).toBeUndefined();
  });
});

describe("readMetadata", () => {
  it("reads Open Graph tags", () => {
    expect(readMetadata(PAGE, "https://example.com/docs")).toEqual({
      url: "https://example.com/docs",
      title: "Deploying Rakazo",
      description: "A self-hosted guide",
      siteName: "Example Docs",
      imageUrl: "https://example.com/cover.png",
    });
  });

  it("falls back to the document title and meta description", () => {
    const page = `<html><head><title>Plain page</title>
      <meta name="description" content="No Open Graph here"></head></html>`;
    expect(readMetadata(page, "https://example.com/p")).toEqual({
      url: "https://example.com/p",
      title: "Plain page",
      description: "No Open Graph here",
      siteName: "example.com",
    });
  });

  it("falls back to Twitter tags when Open Graph is absent", () => {
    const page = `<html><head><meta name="twitter:title" content="Tw title">
      <meta name="twitter:description" content="Tw description"></head></html>`;
    expect(readMetadata(page, "https://example.com/p")).toMatchObject({
      title: "Tw title",
      description: "Tw description",
    });
  });

  it("returns null when there is no title to show", () => {
    expect(readMetadata("<html><head></head><body>hi</body></html>", "https://e.com")).toBeNull();
  });

  it("drops an image that is not an http(s) URL", () => {
    const page = `<html><head><title>T</title>
      <meta property="og:image" content="data:image/png;base64,AAAA"></head></html>`;
    expect(readMetadata(page, "https://example.com/p")?.imageUrl).toBeUndefined();
  });

  it("collapses whitespace and truncates long text", () => {
    const page = `<html><head><title>${"a".repeat(400)}</title></head></html>`;
    const title = readMetadata(page, "https://example.com/p")?.title ?? "";
    expect(title.length).toBeLessThanOrEqual(200);
    expect(title.endsWith("\u2026")).toBe(true);
  });
});

describe("createLinkPreviewResolver", () => {
  it("returns a preview for a page with metadata", async () => {
    routes.set("example.com/docs", html(PAGE));
    const { preview } = await resolver().preview("https://example.com/docs");
    expect(preview).toMatchObject({ title: "Deploying Rakazo", siteName: "Example Docs" });
  });

  it("resolves a relative image against the page it came from", async () => {
    routes.set("example.com/docs", html(PAGE));
    const { preview } = await resolver().preview("https://example.com/docs");
    expect(preview?.imageUrl).toBe("https://example.com/cover.png");
  });

  it("answers once per URL and does not refetch a cached page", async () => {
    routes.set("example.com/docs", html(PAGE));
    const previews = resolver();
    await previews.preview("https://example.com/docs");
    await previews.preview("https://example.com/docs");
    expect(hits).toHaveLength(1);
  });

  it("caches a miss so a page without metadata is not refetched", async () => {
    routes.set("example.com/bare", html("<html><head></head></html>"));
    const previews = resolver();
    expect((await previews.preview("https://example.com/bare")).preview).toBeNull();
    expect((await previews.preview("https://example.com/bare")).preview).toBeNull();
    expect(hits).toHaveLength(1);
  });

  it("shares one request between concurrent asks for the same URL", async () => {
    routes.set("example.com/docs", html(PAGE));
    const previews = resolver();
    const [a, b] = await Promise.all([
      previews.preview("https://example.com/docs"),
      previews.preview("https://example.com/docs"),
    ]);
    expect(a.preview?.title).toBe(b.preview?.title);
    expect(hits).toHaveLength(1);
  });

  it("does not fetch a link carrying a credential", async () => {
    const { preview } = await resolver().preview("https://example.com/reset?token=abc");
    expect(preview).toBeNull();
    expect(hits).toHaveLength(0);
  });

  it("refuses a host that resolves to a private address", async () => {
    routes.set("internal.example.com/", html(PAGE));
    const privateResolver = resolver(async () => [{ address: "10.0.0.5", family: 4 }]);
    const { preview } = await privateResolver.preview("https://internal.example.com/");
    expect(preview).toBeNull();
    expect(hits).toHaveLength(0);
  });

  it("ignores a non-HTML response", async () => {
    routes.set("example.com/file.pdf", {
      headers: { "content-type": "application/pdf" },
      body: "%PDF-1.4",
    });
    const { preview } = await resolver().preview("https://example.com/file.pdf");
    expect(preview).toBeNull();
  });

  it("reports retry instead of a miss when the queue is full", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    routes.set("example.com/slow", async () => {
      await held;
      return html(PAGE);
    });
    routes.set("example.com/fast", html(PAGE));
    const previews = resolver(publicResolver, { maxConcurrent: 1, maxWaiting: 0 });

    const first = previews.preview("https://example.com/slow");
    // Let the first lookup take the only slot before the second asks for it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await previews.preview("https://example.com/fast");

    // Turned away by a full queue, so the client may ask again rather than caching a miss.
    expect(second).toEqual({ preview: null, retry: true });
    // The refused URL was never fetched. (The slow request may not have reached the server yet.)
    expect(hits).not.toContain("example.com/fast");

    release();
    await expect(first).resolves.toMatchObject({ preview: { title: "Deploying Rakazo" } });
  });

  it("treats an unreachable host as a miss, not a crash", async () => {
    const { preview } = await resolver().preview("https://example.com/missing");
    expect(preview).toBeNull();
  });
});

describe("sensitive query keys", () => {
  // Real credential seen in this deployment: a Composio CLI key in a standalone link.
  it("refuses a prefixed credential name such as cliKey", () => {
    expect(isUnfurlableUrl("https://example.com/?cliKey=abc")).toBe(false);
    expect(isUnfurlableUrl("https://example.com/?clientKey=abc")).toBe(false);
  });

  it("refuses the camelCase and separated spellings of the same names", () => {
    for (const key of [
      "apiKey",
      "api_key",
      "accessToken",
      "access_token",
      "authToken",
      "clientSecret",
      "X-Amz-Signature",
      "session",
      "otp",
      "password",
    ]) {
      expect(isUnfurlableUrl(`https://example.com/?${key}=abc`)).toBe(false);
    }
  });

  it("refuses one-time action keys", () => {
    for (const key of ["reset", "confirm", "confirmation", "invite", "magic", "verify"]) {
      expect(isUnfurlableUrl(`https://example.com/?${key}=abc`)).toBe(false);
    }
  });

  it("still fetches an ordinary query", () => {
    expect(isUnfurlableUrl("https://example.com/?q=rakazo&lang=en&page=2")).toBe(true);
  });
});
