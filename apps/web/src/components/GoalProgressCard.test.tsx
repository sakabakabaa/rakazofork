// @vitest-environment jsdom
import type { Goal } from "@rakazo/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: unknown }) => children,
}));
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  control: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("../lib/rpc", () => ({ rpc: { goals: mocks } }));

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => vi.unstubAllGlobals());

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
  it("offers edit and delete actions", () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const html = renderToStaticMarkup(
      <GoalCard goal={goal} onControl={() => {}} onEdit={onEdit} onDelete={onDelete} />,
    );
    expect(html).toContain("Edit goal");
    expect(html).toContain("Delete goal");
  });
  it("edits goal text and deletes with the current revision", async () => {
    mocks.list.mockResolvedValue([goal]);
    mocks.update.mockResolvedValue({
      ...goal,
      title: "Updated report",
      steps: [{ ...goal.steps[0]!, title: "Renamed step" }, goal.steps[1]!],
      revision: 3,
    });
    mocks.delete.mockResolvedValue({ ok: true });
    const node = document.createElement("div");
    const root = createRoot(node);
    await act(async () => root.render(<GoalProgressCard botId="bot" />));

    const edit = [...node.querySelectorAll("button")].find(
      (button) => button.textContent === "Edit goal",
    );
    await act(async () => edit?.click());
    const form = node.querySelector('[data-testid="goal-edit-form"]') as HTMLFormElement;
    const title = form.querySelector("input") as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    const stepTitle = form.querySelectorAll("input")[1] as HTMLInputElement;
    await act(async () => {
      setValue?.call(title, "Updated report");
      title.dispatchEvent(new Event("input", { bubbles: true }));
      title.dispatchEvent(new Event("change", { bubbles: true }));
      setValue?.call(stepTitle, "Renamed step");
      stepTitle.dispatchEvent(new Event("input", { bubbles: true }));
      stepTitle.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () =>
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(mocks.update).toHaveBeenCalledWith({
      goalId: "goal",
      revision: 2,
      title: "Updated report",
      stepTitles: [{ stepId: "a", title: "Renamed step" }],
    });
    expect(node.textContent).toContain("Updated report");

    const remove = [...node.querySelectorAll("button")].find(
      (button) => button.textContent === "Delete goal",
    );
    await act(async () => remove?.click());
    expect(node.querySelector('[data-testid="goal-delete-confirm"]')).not.toBeNull();
    const confirm = [...node.querySelectorAll("button")].find(
      (button) => button.textContent === "Delete",
    );
    await act(async () => confirm?.click());
    expect(mocks.delete).toHaveBeenCalledWith({ goalId: "goal", revision: 3 });
    await act(async () => root.unmount());
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
