import { describe, expect, it } from "vitest";
import { type ComputerCommand, foldComputerCommands, settleCoderCommand } from "./events.js";

describe("computer command history", () => {
  const command = (executionId: string, status: ComputerCommand["status"]): ComputerCommand => ({
    executionId,
    kind: "shell",
    command: `echo ${executionId}`,
    cwd: ".",
    status,
    exitCode: status === "done" ? 0 : null,
    output: "",
  });

  it("keeps one entry per command in start order with its latest state", () => {
    expect(
      foldComputerCommands([
        command("a", "running"),
        command("b", "running"),
        command("b", "done"),
        command("a", "done"),
      ]).map((entry) => `${entry.executionId}:${entry.status}`),
    ).toEqual(["a:done", "b:done"]);
  });

  it("settles cancelled coder runs without reopening successful commands", () => {
    const running = {
      ...command("coder", "running"),
      coder: {
        provider: "dsh" as const,
        task: "test",
        startedAt: "start",
        phase: "Running",
        text: "",
        actions: [
          { id: "tool", tool: "bash", label: "wait", status: "running" as const, output: "" },
        ],
      },
    };
    expect(settleCoderCommand(running, "running", "end")).toEqual(running);
    const stopped = settleCoderCommand(running, "cancelled", "end");
    expect(stopped.status).toBe("done");
    expect(stopped.exitCode).toBe(130);
    expect(stopped.coder.finishedAt).toBe("end");
    expect(stopped.coder.actions[0]?.status).toBe("failed");
    expect(
      settleCoderCommand({ ...running, status: "done", exitCode: 0 }, "cancelled", "end").exitCode,
    ).toBe(0);
    expect(settleCoderCommand(command("shell", "running"), "cancelled", "end").status).toBe(
      "running",
    );
  });

  it("never lets a stale running event reopen a finished command", () => {
    expect(
      foldComputerCommands([command("a", "done"), command("a", "running")]).map(
        (entry) => entry.status,
      ),
    ).toEqual(["done"]);
  });
});
