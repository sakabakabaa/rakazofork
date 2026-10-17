// @vitest-environment jsdom
import type { ComputerCommand } from "@rakazo/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: unknown }) => children,
}));
const mocks = vi.hoisted(() => ({
  history: vi.fn(),
  listener: undefined as ((id: string, command: ComputerCommand) => void) | undefined,
}));
vi.mock("../lib/rpc", () => ({ rpc: { computer: { commands: mocks.history } } }));
vi.mock("../lib/computer-workspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/computer-workspace")>();
  return {
    ...actual,
    subscribeComputerCommands: (listener: typeof mocks.listener) => {
      mocks.listener = listener;
      return () => {
        mocks.listener = undefined;
      };
    },
  };
});

import { CoderPanel } from "./CoderPanel";

describe("CoderPanel", () => {
  it("loads history collapsed and keeps completed actions while new calls stream", async () => {
    const command: ComputerCommand = {
      executionId: "test",
      kind: "shell",
      command: "dsh",
      cwd: ".",
      status: "running",
      exitCode: null,
      output: "",
      coder: {
        provider: "dsh",
        task: "Test task",
        startedAt: new Date().toISOString(),
        phase: "Run tests",
        text: "",
        actions: [{ id: "a", tool: "write", label: "Write CLI", status: "done", output: "saved" }],
      },
    };
    mocks.history.mockResolvedValue([command]);
    const node = document.createElement("div");
    const root = createRoot(node);
    const stop = vi.fn().mockResolvedValue(undefined);
    await act(async () => root.render(<CoderPanel botId="bot" onStop={stop} />));
    expect(node.querySelector('[aria-expanded="false"]')).not.toBeNull();
    expect(node.textContent).not.toContain("Write CLI");
    await act(async () => node.querySelector<HTMLButtonElement>("[aria-expanded]")?.click());
    await act(async () =>
      mocks.listener?.("bot", {
        ...command,
        coder: {
          ...command.coder!,
          actions: [
            ...command.coder!.actions,
            { id: "b", tool: "bash", label: "Test CLI", status: "running", output: "" },
          ],
        },
      }),
    );
    expect(node.textContent).toContain("Write CLI");
    expect(node.textContent).toContain("Test CLI");
    const button = [...node.querySelectorAll("button")].find(
      (element) => element.textContent === "Stop run",
    );
    await act(async () => button?.click());
    expect(stop).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
  });
});
