// @vitest-environment jsdom
import type { Routine, RoutineOutput, ToolActivityStep } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  history: vi.fn(),
  output: vi.fn(),
  testRun: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  stopRun: vi.fn(),
}));
vi.mock("../lib/rpc", () => ({ rpc: { routines: api } }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./ActivityList", () => ({
  statusLabel: (status: string) => status,
  statusTone: () => "",
}));
vi.mock("../components/LongReplyMarkdown", () => ({
  LongReplyMarkdown: ({ children }: { children: string }) => <p>{children}</p>,
}));
vi.mock("../components/ArtifactFileCard", () => ({ ArtifactFileCard: () => null }));
vi.mock("../components/AskCard", () => ({ AskCard: () => null }));
vi.mock("../components/ToolActivityDisclosure", () => ({
  StandaloneToolActivity: ({
    steps,
    latestAction,
  }: {
    steps: ToolActivityStep[];
    latestAction?: string;
  }) => (
    <div data-testid="actions">
      {steps.map((step) => step.label).join(", ")}
      {latestAction}
    </div>
  ),
}));

import { RoutinesNavigation, RoutinesWorkspace } from "./RoutinesWorkspace";

const routine: Routine = {
  id: "routine-1",
  botId: "bot-1",
  name: "Daily report",
  prompt: "Report changes",
  crons: [],
  timezone: "UTC",
  active: false,
  notify: false,
  webhookEnabled: false,
  githubEnabled: false,
  messageProvider: null,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
  doneCondition: null,
  threadMode: "main",
  lastRunAt: null,
  nextRunAt: null,
  createdAt: "2026-01-01T00:00:00Z",
};
const output: RoutineOutput = {
  runId: "run-1",
  threadId: "routine-thread",
  isolated: true,
  status: "completed",
  error: null,
  olderCursor: null,
  events: [],
  messages: [
    {
      id: "message-1",
      threadId: "routine-thread",
      seq: 1,
      role: "bot",
      runId: "run-1",
      createdAt: "2026-01-01T00:00:00Z",
      blocks: [{ kind: "text", text: "Routine result" }],
    },
  ],
};
let close: (() => Promise<void>) | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.list.mockResolvedValue([routine]);
  api.history.mockResolvedValue({
    runs: [
      {
        id: "run-1",
        botId: "bot-1",
        status: "completed",
        groupId: null,
        messageId: null,
        createdAt: routine.createdAt,
        startedAt: null,
        completedAt: null,
      },
    ],
    nextCursor: null,
  });
  api.output.mockResolvedValue(output);
});
afterEach(async () => {
  await close?.();
  close = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
async function mount(node: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  close = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return container;
}
it("opens a routine from its own collapsible sidebar section", async () => {
  const open = vi.fn();
  const container = await mount(<RoutinesNavigation botId="bot-1" onOpen={open} />);
  const row = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === routine.name,
  )!;
  await act(async () => row.click());
  expect(open).toHaveBeenCalledWith(routine.id);
  await act(async () =>
    (container.querySelector('[aria-label="Toggle routines"]') as HTMLButtonElement).click(),
  );
  expect(container.textContent).not.toContain(routine.name);
});
it("displays only the selected run's output including legacy run filtering", async () => {
  api.output.mockResolvedValue({
    ...output,
    messages: [
      ...output.messages,
      {
        ...output.messages[0],
        id: "other-message",
        runId: "other-run",
        blocks: [{ kind: "text", text: "Other chat output" }],
      },
    ],
  });
  const container = await mount(
    <RoutinesWorkspace botId="bot-1"
      routineId={routine.id}
      onOpen={vi.fn()}
      onClose={vi.fn()}
      onEdit={vi.fn()}
    />,
  );
  expect(container.textContent).toContain("Routine result");
  expect(container.textContent).not.toContain("Other chat output");
  expect(api.output).toHaveBeenCalledWith({ runId: "run-1" }, expect.anything());
});
it("refreshes live output while keeping completed tool calls visible", async () => {
  vi.useFakeTimers();
  api.output
    .mockResolvedValueOnce({
      ...output,
      status: "running",
      messages: [
        {
          ...output.messages[0],
          blocks: [
            { kind: "steps", steps: [{ label: "Read file", count: 1, status: "succeeded" }] },
          ],
        },
      ],
    })
    .mockResolvedValue({
      ...output,
      status: "running",
      messages: [
        {
          ...output.messages[0],
          blocks: [
            {
              kind: "steps",
              steps: [
                { label: "Read file", count: 1, status: "succeeded" },
                { label: "Write report", count: 1, status: "running" },
              ],
            },
          ],
        },
      ],
    });
  const container = await mount(
    <RoutinesWorkspace botId="bot-1"
      routineId={routine.id}
      onOpen={vi.fn()}
      onClose={vi.fn()}
      onEdit={vi.fn()}
    />,
  );
  expect(container.querySelector('[data-testid="actions"]')?.textContent).toContain("Read file");
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(container.querySelectorAll('[data-testid="actions"]')).toHaveLength(1);
  expect(container.querySelector('[data-testid="actions"]')?.textContent).toContain(
    "Read file, Write report",
  );
});
it("starts a manual run and opens that run instead of the main chat", async () => {
  const open = vi.fn();
  api.testRun.mockResolvedValue({ runId: "new-run" });
  const container = await mount(
    <RoutinesWorkspace botId="bot-1" routineId={routine.id} onOpen={open} onClose={vi.fn()} onEdit={vi.fn()} />,
  );
  const run = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Run now",
  )!;
  await act(async () => run.click());
  expect(api.testRun).toHaveBeenCalledOnce();
  expect(open).toHaveBeenCalledWith(routine.id, "new-run");
});

it("keeps a failed action visible after successful background polling", async () => {
  vi.useFakeTimers();
  api.testRun.mockRejectedValue(new Error("start failed"));
  const container = await mount(
    <RoutinesWorkspace botId="bot-1"
      routineId={routine.id}
      onOpen={vi.fn()}
      onClose={vi.fn()}
      onEdit={vi.fn()}
    />,
  );
  const run = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Run now",
  )!;
  await act(async () => run.click());
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
});
