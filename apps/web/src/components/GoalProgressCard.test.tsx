// @vitest-environment jsdom
import type { Goal } from "@rakazo/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: unknown }) => children,
}));
const mocks = vi.hoisted(() => ({ list: vi.fn(), control: vi.fn() }));
vi.mock("../lib/rpc", () => ({ rpc: { goals: mocks } }));

import { GoalCard, GoalProgressCard } from "./GoalProgressCard";

const goal: Goal = {
  id: "goal",
  botId: "bot",
  title: "Ship report",
  successCriteria: "Verified totals",
  request: "Create a report",
  checkpoint: "Keep original data",
  status: "active",
  revision: 2,
  runId: "run",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  steps: [
    {
      id: "a",
      title: "Write report",
      status: "done",
      evidence: "Read back",
      evidenceEventId: "proof",
    },
    { id: "b", title: "Check totals", status: "verifying" },
  ],
};
describe("Goal card", () => {
  it("starts collapsed and shows verified progress with expandable proof", () => {
    const html = renderToStaticMarkup(<GoalCard goal={goal} onControl={() => {}} />);
    expect(html).toContain("1/2");
    expect(html).toContain('value="1"');
    expect(html).not.toContain(" open=");
    expect(html).toContain("Read back");
    expect(html).toContain("Check totals");
    expect(html).toContain("Pause goal");
  });
  it("shows resume for paused work and no controls after completion", () => {
    expect(
      renderToStaticMarkup(<GoalCard goal={{ ...goal, status: "paused" }} onControl={() => {}} />),
    ).toContain("Resume goal");
    expect(
      renderToStaticMarkup(
        <GoalCard goal={{ ...goal, status: "completed" }} onControl={() => {}} />,
      ),
    ).not.toContain("Stop goal");
  });
  it("recovers persisted state on mount and sends revision-protected controls", async () => {
    mocks.list.mockResolvedValue([goal]);
    mocks.control.mockResolvedValue({ ...goal, status: "paused", revision: 3 });
    const node = document.createElement("div");
    const root = createRoot(node);
    await act(async () => root.render(<GoalProgressCard botId="bot" />));
    expect(node.textContent).toContain("Ship report");
    const pause = [...node.querySelectorAll("button")].find((b) => b.textContent === "Pause goal");
    await act(async () => pause?.click());
    expect(mocks.control).toHaveBeenCalledWith({ goalId: "goal", revision: 2, action: "pause" });
    expect(node.textContent).toContain("Resume goal");
    await act(async () => root.unmount());
  });
});
