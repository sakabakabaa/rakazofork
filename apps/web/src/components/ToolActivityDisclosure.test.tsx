// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
    (value === 1 ? one : other).replace("#", String(value)),
}));

import {
  StandaloneToolActivity,
  ToolActivityDisclosure,
  ToolOnlyNarration,
  ToolSteps,
} from "./ToolActivityDisclosure";

function stepsOf(n: number) {
  return Array.from({ length: n }, (_, i) => ({ label: `step-${i}`, count: 1 }));
}

const OPEN_DETAILS = /<details[^>]* open/;

function mountCard() {
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (live: boolean, stepCount = 2) =>
    flushSync(() =>
      root.render(
        <ToolActivityDisclosure live={live} latestAction={`step-${stepCount - 1}`}>
          <ToolSteps steps={stepsOf(stepCount)} />
        </ToolActivityDisclosure>,
      ),
    );
  const details = () => container.querySelector("details");
  const summary = () => container.querySelector("summary");
  return { render, details, summary, unmount: () => root.unmount() };
}

describe("ToolActivityDisclosure", () => {
  it("shows only the latest action and duration on a collapsed line", () => {
    const html = renderToStaticMarkup(
      <ToolActivityDisclosure live={false} latestAction="Open page" durationMs={12_000}>
        <ToolSteps
          steps={[
            { label: "Web search", count: 1 },
            { label: "Open page", count: 1 },
          ]}
        />
      </ToolActivityDisclosure>,
    );
    expect(html).toContain("Open page");
    expect(html).toContain("· Done · 12s");
    expect(html).not.toMatch(OPEN_DETAILS);
    expect(html.match(/<summary/g)).toHaveLength(1);
  });

  it("keeps the details collapsed while live and shows the latest action status", () => {
    const html = renderToStaticMarkup(
      <ToolActivityDisclosure live latestAction="Web search">
        <ToolSteps steps={[{ label: "Web search", count: 1 }]} />
      </ToolActivityDisclosure>,
    );
    expect(html).toContain("Web search");
    expect(html).toContain("· Working");
    expect(html).toContain('data-live="true"');
    expect(html).not.toMatch(OPEN_DETAILS);
  });

  it("omits an unusable duration", () => {
    const html = renderToStaticMarkup(
      <ToolActivityDisclosure live={false} latestAction="Read file">
        <ToolSteps steps={[{ label: "Read file", count: 1 }]} />
      </ToolActivityDisclosure>,
    );
    expect(html).toContain("· Done");
    expect(html).not.toContain("· Done ·");
  });

  it("preserves the user's expansion state as a run updates and completes", () => {
    const card = mountCard();
    card.render(true);
    expect(card.details()?.open).toBeFalsy();
    card.summary()?.click();
    expect(card.details()?.open).toBe(true);
    card.render(true, 3);
    expect(card.details()?.open).toBe(true);
    card.render(false, 3);
    expect(card.details()?.open).toBe(true);
    expect(card.summary()?.textContent).toContain("step-2");
    card.unmount();
  });

  it("keeps the list collapsed unless the user opens it", () => {
    const card = mountCard();
    card.render(false);
    expect(card.details()?.open).toBeFalsy();
    card.summary()?.click();
    expect(card.details()?.open).toBe(true);
    card.unmount();
  });
});

describe("ToolSteps", () => {
  it("renders each repeated tool call as its own chronological action row", () => {
    const html = renderToStaticMarkup(
      <ToolSteps
        steps={[
          { label: "Web search", count: 3 },
          { label: "Open page", count: 1 },
        ]}
      />,
    );
    expect(html.match(/data-testid="tool-action"/g)).toHaveLength(4);
    expect(html.match(/>Web search</g)).toHaveLength(3);
    expect(html).toContain(">Open page</span>");
  });

  it("marks only the latest call as active", () => {
    const html = renderToStaticMarkup(
      <ToolSteps
        steps={[
          { label: "Web search", count: 2 },
          { label: "Open page", count: 1 },
        ]}
        currentIndex={1}
      />,
    );
    expect(html.match(/animate-spin/g)).toHaveLength(1);
    expect(html.match(/text-success/g)).toHaveLength(2);
  });

  it("exposes the full label as the title of a truncated action", () => {
    const label = "Read apps/web/src/components/ToolActivityDisclosure.tsx";
    const html = renderToStaticMarkup(<ToolSteps steps={[{ label, count: 1 }]} />);
    expect(html).toContain(`title="${label}"`);
  });
});

describe("StandaloneToolActivity", () => {
  it("renders a single latest-action line, not a chat bubble", () => {
    const html = renderToStaticMarkup(
      <StandaloneToolActivity live={false} steps={stepsOf(2)} durationMs={4000} />,
    );
    expect(html).toContain('data-testid="tool-activity-line"');
    expect(html).toContain("step-1");
    expect(html).toContain("· Done · 4s");
    expect(html).not.toContain("bg-muted");
    expect(html).not.toContain("rounded-[20px]");
    expect(html).not.toMatch(OPEN_DETAILS);
  });

  it("keeps a long live sequence collapsed but renders all actions when expanded", () => {
    const steps = stepsOf(9);
    const html = renderToStaticMarkup(<StandaloneToolActivity live steps={steps} />);
    expect(html).not.toMatch(OPEN_DETAILS);
    expect(html).toContain("step-8");
    expect(html).toContain("· Working");
    expect(html.match(/data-testid="tool-action"/g)).toHaveLength(9);
  });
});

describe("ToolOnlyNarration", () => {
  it("renders live tool activity as one collapsed slim line", () => {
    const html = renderToStaticMarkup(
      <ToolOnlyNarration live blocks={[{ kind: "steps", steps: stepsOf(2) }]} />,
    );
    expect(html).toContain('data-testid="tool-activity-line"');
    expect(html).toContain("step-1");
    expect(html).toContain("· Working");
    expect(html).not.toMatch(OPEN_DETAILS);
    expect(html).not.toContain("bg-muted");
  });

  it("shows the live tool-start event immediately while the run is active", () => {
    const html = renderToStaticMarkup(
      <ToolOnlyNarration
        live
        blocks={[{ kind: "progress", text: "Opening page: example.com", activity: true }]}
      />,
    );
    expect(html).toContain("Opening page: example.com");
    expect(html).toContain("· Working");
    expect(html).not.toMatch(OPEN_DETAILS);
  });

  it("keeps prior calls in the expandable history while the latest call is live", () => {
    const html = renderToStaticMarkup(
      <ToolOnlyNarration
        live
        blocks={[
          { kind: "steps", steps: [{ label: "Web search", count: 1 }] },
          { kind: "progress", text: "Opening page: example.com", activity: true },
        ]}
      />,
    );
    expect(html.match(/data-testid="tool-activity-line"/g)).toHaveLength(1);
    expect(html).toContain("Opening page: example.com");
    expect(html).toContain(">Web search</span>");
    expect(html).toContain(">Opening page: example.com</span>");
  });

  it("shows only the latest action summary and combines the expanded history", () => {
    const html = renderToStaticMarkup(
      <ToolOnlyNarration
        live={false}
        blocks={[
          { kind: "steps", steps: stepsOf(3), durationMs: 12_000 },
          { kind: "steps", steps: stepsOf(1) },
        ]}
      />,
    );
    expect(html.match(/data-testid="tool-activity-line"/g)).toHaveLength(1);
    expect(html).toContain("· Done · 12s");
    expect(html).toContain("step-2");
    expect(html).not.toMatch(OPEN_DETAILS);
  });
});
