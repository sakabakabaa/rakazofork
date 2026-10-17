// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: string }) => children,
}));

import { LONG_REPLY_COLLAPSE_CHARS, LongReplyMarkdown } from "./LongReplyMarkdown";

describe("LongReplyMarkdown", () => {
  it("keeps normal-length replies fully visible", () => {
    const html = renderToStaticMarkup(
      <LongReplyMarkdown>{"A short answer.\n\nSecond paragraph."}</LongReplyMarkdown>,
    );
    expect(html).not.toContain("long-reply-disclosure");
    expect(html).toContain("A short answer.");
    expect(html).toContain("Second paragraph.");
  });

  it("collapses a long completed reply behind a readable preview", () => {
    const text = `A useful preview. ${"Detailed supporting text. ".repeat(100)}`;
    const html = renderToStaticMarkup(<LongReplyMarkdown>{text}</LongReplyMarkdown>);
    expect(html).toContain('data-testid="long-reply-disclosure"');
    expect(html).toContain("A useful preview.");
    expect(html).toContain("Show full response");
    expect(html).toContain("Detailed supporting text.");
  });

  it("does not collapse a long reply while it is streaming", () => {
    const text = "Working. ".repeat(Math.ceil(LONG_REPLY_COLLAPSE_CHARS / 9));
    const html = renderToStaticMarkup(<LongReplyMarkdown streaming>{text}</LongReplyMarkdown>);
    expect(html).not.toContain("long-reply-disclosure");
    expect(html).toContain("Working.");
  });
});
