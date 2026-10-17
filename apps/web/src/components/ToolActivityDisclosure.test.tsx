// @vitest-environment jsdom

import type { ToolActivityStep, ToolDiff } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return {
    Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
      (value === 1 ? one : other).replace("#", String(value)),
    Trans: ({ children }: { children: ReactNode }) => children,
    useLingui: () => ({ t }),
  };
});

import {
  StandaloneToolActivity,
  ToolActivityDisclosure,
  ToolOnlyNarration,
  ToolSteps,
} from "./ToolActivityDisclosure";

function stepsOf(n: number): ToolActivityStep[] {
  return Array.from({ length: n }, (_, i) => ({ label: `step-${i}`, count: 1 }));
}

const OPEN_DETAILS = /<details[^>]* open/;

const mounted: (() => void)[] = [];

/** Mount into the document so text content and `<details>` state can be read back. */
function mount(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  flushSync(() => root.render(node));
  mounted.push(() => {
    root.unmount();
    container.remove();
  });
  return { container, root };
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
});

function summaryOf(container: HTMLElement): HTMLElement {
  const summary = container.querySelector("summary");
  if (!(summary instanceof HTMLElement)) throw new Error("missing summary");
  return summary;
}

function textOf(container: HTMLElement): string {
  return (container.textContent ?? "").replace(/\s+/g, " ").trim();
}

describe("ToolActivityDisclosure", () => {
  it("shows the latest action and Working while the run is live", () => {
    const steps: ToolActivityStep[] = [{ label: "Web search", count: 1, status: "running" }];
    const { container } = mount(
      <ToolActivityDisclosure live latestAction="Web search" steps={steps}>
        <ToolSteps steps={steps} />
      </ToolActivityDisclosure>,
    );
    const summary = summaryOf(container);
    expect(summary.querySelector('[data-testid="tool-latest-action"]')?.textContent).toBe(
      "Web search",
    );
    expect(textOf(summary)).toContain("Working");
    expect(textOf(summary)).not.toContain("Completed");
    expect(summary.querySelector(".animate-spin")).not.toBeNull();
    expect(container.querySelector("details")?.dataset.live).toBe("true");
    expect(container.querySelector("details")?.open).toBeFalsy();
  });

  it("shows the completed action count and duration when the run finished", () => {
    const steps = stepsOf(7);
    const { container } = mount(
      <ToolActivityDisclosure live={false} latestAction="step-6" durationMs={53_000} steps={steps}>
        <ToolSteps steps={steps} />
      </ToolActivityDisclosure>,
    );
    expect(textOf(summaryOf(container))).toContain("Completed 7 actions · 53s");
  });

  it("names a single completed action in the singular", () => {
    const steps = stepsOf(1);
    const { container } = mount(
      <ToolActivityDisclosure live={false} latestAction="step-0" steps={steps}>
        <ToolSteps steps={steps} />
      </ToolActivityDisclosure>,
    );
    expect(textOf(summaryOf(container))).toContain("Completed 1 action");
  });

  it("shows a failure instead of a success, styled with the destructive token", () => {
    const steps: ToolActivityStep[] = [
      { id: "a", label: "Web search", count: 1, status: "succeeded" },
      {
        id: "b",
        label: "Read message",
        count: 1,
        status: "failed",
        error: "Permission denied",
      },
    ];
    const { container } = mount(
      <ToolActivityDisclosure
        live={false}
        latestAction="Read message"
        durationMs={4000}
        steps={steps}
      >
        <ToolSteps steps={steps} />
      </ToolActivityDisclosure>,
    );
    const summary = summaryOf(container);
    expect(summary.querySelector('[data-testid="tool-latest-action"]')?.textContent).toBe(
      "Read message",
    );
    expect(textOf(summary)).toContain("Failed");
    expect(textOf(summary)).not.toContain("Completed");
    expect(summary.className).toContain("text-destructive");
    expect(summary.outerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("keeps the legacy Done wording when no timeline is passed", () => {
    const html = renderToStaticMarkup(
      <ToolActivityDisclosure live={false} latestAction="Read file">
        <ToolSteps steps={[{ label: "Read file", count: 1 }]} />
      </ToolActivityDisclosure>,
    );
    expect(html).toContain("Done");
    expect(html).not.toContain("Completed");
  });

  it("omits an unusable duration", () => {
    const steps = stepsOf(2);
    const { container } = mount(
      <ToolActivityDisclosure live={false} latestAction="step-1" steps={steps}>
        <ToolSteps steps={steps} />
      </ToolActivityDisclosure>,
    );
    const summary = textOf(summaryOf(container));
    expect(summary).toContain("Completed 2 actions");
    expect(summary).not.toContain(" · 0s");
  });

  it("preserves the user's expansion state as a run updates and completes", () => {
    const render = (live: boolean, stepCount: number) =>
      flushSync(() =>
        root.render(
          <ToolActivityDisclosure
            live={live}
            latestAction={`step-${stepCount - 1}`}
            steps={stepsOf(stepCount)}
          >
            <ToolSteps steps={stepsOf(stepCount)} />
          </ToolActivityDisclosure>,
        ),
      );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push(() => {
      root.unmount();
      container.remove();
    });
    const details = () => container.querySelector("details");
    const summary = () => container.querySelector("summary");

    render(true, 2);
    expect(details()?.open).toBeFalsy();
    summary()?.click();
    expect(details()?.open).toBe(true);
    render(true, 3);
    expect(details()?.open).toBe(true);
    expect(summary()?.textContent).toContain("step-2");
    render(false, 3);
    expect(details()?.open).toBe(true);
    expect(textOf(summary() as HTMLElement)).toContain("Completed 3 actions");
  });

  it("keeps the list collapsed unless the user opens it", () => {
    const { container } = mount(
      <ToolActivityDisclosure live={false} latestAction="step-1" steps={stepsOf(2)}>
        <ToolSteps steps={stepsOf(2)} />
      </ToolActivityDisclosure>,
    );
    expect(container.querySelector("details")?.open).toBeFalsy();
    container.querySelector("summary")?.click();
    expect(container.querySelector("details")?.open).toBe(true);
  });

  it("wraps a long latest action instead of truncating it", () => {
    const html = renderToStaticMarkup(
      <ToolActivityDisclosure
        live
        latestAction="Running: ssh -o BatchMode=yes -o ConnectTimeout=8 root@host 'apt-get check'"
      >
        <ToolSteps steps={[]} />
      </ToolActivityDisclosure>,
    );
    expect(html).toContain("w-full max-w-full");
    expect(html).toContain("flex-wrap");
    expect(html).toContain("min-w-[min(8rem,100%)] flex-1");
    expect(html).toContain("ms-auto shrink-0");
    expect(html).toContain("whitespace-normal break-words [overflow-wrap:anywhere]");
    expect(html).not.toContain("truncate");
  });
});

describe("ToolSteps", () => {
  it("lists every step in order, including the ones that already finished", () => {
    const steps: ToolActivityStep[] = [
      { id: "a", label: "Open calendar", count: 1, status: "succeeded" },
      { id: "b", label: "Read events", count: 1, status: "succeeded" },
      { id: "c", label: "Draft invite", count: 1, status: "running" },
    ];
    const { container } = mount(
      <ToolActivityDisclosure live latestAction="Draft invite" steps={steps}>
        <ToolSteps steps={steps} />
      </ToolActivityDisclosure>,
    );
    const rows = [...container.querySelectorAll('[data-testid="tool-activity-step"]')];
    expect(rows.map((row) => row.textContent)).toEqual([
      "Open calendar",
      "Read events",
      "Draft invite",
    ]);
    expect(
      rows.map((row) =>
        row.querySelector('[data-testid="tool-activity-status"]')?.getAttribute("aria-label"),
      ),
    ).toEqual(["Succeeded", "Succeeded", "Running"]);
  });

  it("renders a legacy label-and-count step neutrally instead of as a success", () => {
    const steps: ToolActivityStep[] = [
      { label: "Web search", count: 1 },
      { label: "Open page", count: 1 },
    ];
    const html = renderToStaticMarkup(<ToolSteps steps={steps} />);
    expect(html.match(/data-testid="tool-activity-step"/g)).toHaveLength(2);
    expect(html).toContain(">Web search<");
    expect(html).not.toContain("tool-activity-status");
    expect(html).not.toContain("text-success");
    expect(html).not.toContain("animate-spin");
  });

  it("shows the count of a merged legacy row", () => {
    const html = renderToStaticMarkup(
      <ToolSteps
        steps={[
          { label: "Web search", count: 3 },
          { label: "Open page", count: 1 },
        ]}
      />,
    );
    expect(html.match(/data-testid="tool-activity-step"/g)).toHaveLength(2);
    expect(html).toContain("×3");
  });

  it("shows the error line and a Failed status under a failed step", () => {
    const steps: ToolActivityStep[] = [
      {
        id: "a",
        label: "Run shell",
        count: 1,
        status: "failed",
        error: "Command exited with code 1",
      },
    ];
    const html = renderToStaticMarkup(<ToolSteps steps={steps} />);
    expect(html).toContain("Command exited with code 1");
    expect(html).toContain('aria-label="Failed"');
    expect(html).toContain("text-destructive");
    expect(html).not.toContain("text-success");
  });

  it("marks a waiting action with a pause indicator", () => {
    const steps: ToolActivityStep[] = [
      { id: "a", label: "Send email", count: 1, status: "paused" },
      { id: "b", label: "Open page", count: 1, status: "interrupted" },
    ];
    const html = renderToStaticMarkup(<ToolSteps steps={steps} />);
    expect(html.match(/aria-label="Waiting"/g)).toHaveLength(2);
    expect(html).toContain("text-warning");
  });

  it("renders a summary next to the label and keeps the full label as its title", () => {
    const label = "Read apps/web/src/components/ToolActivityDisclosure.tsx";
    const steps: ToolActivityStep[] = [
      { id: "a", label, count: 1, status: "succeeded", summary: "142 lines" },
    ];
    const html = renderToStaticMarkup(<ToolSteps steps={steps} />);
    expect(html).toContain(`title="${label}"`);
    expect(html).toContain("142 lines");
    expect(html).not.toContain("truncate");
  });

  it("marks only the in-flight row as running when the stored row has no status", () => {
    const html = renderToStaticMarkup(
      <ToolSteps
        steps={[
          { label: "Web search", count: 1 },
          { label: "Open page", count: 1 },
        ]}
        currentIndex={1}
      />,
    );
    expect(html.match(/animate-spin/g)).toHaveLength(1);
  });
});

describe("tool diffs", () => {
  const patch = "@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n const b = 3;";
  const diff: ToolDiff = {
    path: "apps/web/src/App.tsx",
    patch,
    additions: 1,
    deletions: 1,
  };

  function diffOf(container: HTMLElement): HTMLElement {
    const element = container.querySelector<HTMLElement>('[data-testid="tool-diff"]');
    if (!element) throw new Error("missing diff");
    return element;
  }

  it("renders collapsed by default with the path, counts, and marked lines", () => {
    const steps: ToolActivityStep[] = [
      { id: "a", label: "Edit file", count: 1, status: "succeeded", diff },
    ];
    const { container } = mount(<ToolSteps steps={steps} />);
    const element = diffOf(container);
    expect(element.tagName).toBe("DETAILS");
    expect((element as HTMLDetailsElement).open).toBe(false);
    expect(textOf(element)).toContain("apps/web/src/App.tsx");
    expect(textOf(element)).toContain("+1");
    expect(textOf(element)).toContain("−1");

    const lines = [...element.querySelectorAll('[data-testid="tool-diff-line"]')];
    expect(lines.map((line) => line.getAttribute("data-kind"))).toEqual([
      "context",
      "del",
      "add",
      "context",
    ]);
    expect(lines.map((line) => line.textContent)).toEqual([
      "@@ -1,2 +1,2 @@",
      "-const a = 1;",
      "+const a = 2;",
      " const b = 3;",
    ]);
    expect(lines[1]?.className).toContain("bg-destructive/10");
    expect(lines[2]?.className).toContain("bg-success/10");
    expect(element.outerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("renders the unavailable reason instead of a patch", () => {
    const unavailable: ToolDiff = {
      path: "assets/logo.png",
      patch,
      additions: 1,
      deletions: 1,
      unavailableReason: "Binary file: no text diff.",
    };
    const steps: ToolActivityStep[] = [
      { id: "a", label: "Edit file", count: 1, status: "succeeded", diff: unavailable },
    ];
    const { container } = mount(<ToolSteps steps={steps} />);
    const element = diffOf(container);
    expect(textOf(element)).toContain("Binary file: no text diff.");
    expect(element.querySelectorAll('[data-testid="tool-diff-line"]')).toHaveLength(0);
  });

  it("points at the artifact instead of the full patch when the change was truncated", () => {
    const truncated: ToolDiff = {
      path: "apps/web/src/App.tsx",
      patch,
      additions: 900,
      deletions: 400,
      truncated: true,
    };
    const steps: ToolActivityStep[] = [
      { id: "a", label: "Edit file", count: 1, status: "succeeded", diff: truncated },
    ];
    const { container } = mount(<ToolSteps steps={steps} />);
    const element = diffOf(container);
    expect(textOf(element)).toMatch(/truncated/i);
    expect(element.querySelectorAll('[data-testid="tool-diff-line"]')).toHaveLength(0);
  });

  it("renders no diff at all when the step has none", () => {
    const html = renderToStaticMarkup(
      <ToolSteps steps={[{ id: "a", label: "Web search", count: 1, status: "succeeded" }]} />,
    );
    expect(html).not.toContain('data-testid="tool-diff"');
  });
});

describe("StandaloneToolActivity", () => {
  it("renders a single latest-action line, not a chat bubble", () => {
    const html = renderToStaticMarkup(
      <StandaloneToolActivity live={false} steps={stepsOf(2)} durationMs={4000} />,
    );
    expect(html).toContain('data-testid="tool-activity-line"');
    expect(html).toContain("step-1");
    expect(html).toContain("Completed 2 actions");
    expect(html).toContain("4s");
    expect(html).not.toContain("bg-muted");
    expect(html).not.toContain("rounded-[20px]");
    expect(html).not.toMatch(OPEN_DETAILS);
  });

  it("keeps a long live sequence collapsed but renders all actions when expanded", () => {
    const steps = stepsOf(9);
    const html = renderToStaticMarkup(<StandaloneToolActivity live steps={steps} />);
    expect(html).not.toMatch(OPEN_DETAILS);
    expect(html).toContain("step-8");
    expect(html).toContain("Working");
    expect(html.match(/data-testid="tool-activity-step"/g)).toHaveLength(9);
  });
});

describe("ToolOnlyNarration", () => {
  it("renders live tool activity as one collapsed slim line", () => {
    const html = renderToStaticMarkup(
      <ToolOnlyNarration live blocks={[{ kind: "steps", steps: stepsOf(2) }]} />,
    );
    expect(html).toContain('data-testid="tool-activity-line"');
    expect(html).toContain("step-1");
    expect(html).toContain("Working");
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
    expect(html).toContain("Working");
    expect(html).toContain('aria-label="Running"');
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
    expect(html).toContain(">Web search<");
    expect(html).toContain(">Opening page: example.com<");
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
    expect(html).toContain("Completed 4 actions");
    expect(html).toContain("12s");
    expect(html).toContain("step-2");
    expect(html).not.toMatch(OPEN_DETAILS);
  });
});
