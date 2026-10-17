import type { AdapterContext, WebFetchProvider, WebSearchProvider } from "@rakazo/adapter-kit";
import { clampMaxChars, clampMaxResults } from "./web-limits.js";

export async function webSearchFromTool(
  search: WebSearchProvider,
  context: AdapterContext,
  args: Record<string, unknown>,
) {
  const query = String(args.query ?? "").trim();
  if (!query) return { error: "query is required; provide a concise search phrase and try again." };
  try {
    const results = await search.search(
      {
        query,
        maxResults: clampMaxResults(args.maxResults),
        signal: context.signal,
      },
      context,
    );
    return { results };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      error: `${detail}. Search failed; retry once with a narrower query or another source, then report if web search remains unavailable.`,
    };
  }
}

export async function webFetchFromTool(
  fetchProvider: WebFetchProvider,
  context: AdapterContext,
  args: Record<string, unknown>,
) {
  const url = String(args.url ?? "").trim();
  if (!url) return { error: "url is required; provide a public http(s) page URL and try again." };
  try {
    const result = await fetchProvider.fetch(
      {
        url,
        maxChars: clampMaxChars(args.maxChars),
        signal: context.signal,
      },
      context,
    );
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      error: `${detail}. Page fetch failed; try another public source, and do not treat the failed page as verified evidence.`,
    };
  }
}
