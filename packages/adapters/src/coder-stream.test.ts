import { Buffer } from "node:buffer";
import { stableJsonValue } from "@rakazo/core/node/approval-effect-key";
import { describe, expect, it } from "vitest";
import { coderCommand, coderShellArgs, dshActivity } from "./coder-stream.js";
import { protectedComputerLifecycleRefusal } from "./executor.js";

describe("coder runner", () => {
  it("quotes task text as data and refuses executable shell syntax", () => {
    const task = "don't execute $(anything) or `commands`";
    const command = coderCommand({ task });
    expect(command).toContain(Buffer.from(task).toString("base64"));
    expect(command).not.toContain("$(anything)");
    expect(protectedComputerLifecycleRefusal(command)).toBeUndefined();
    expect(() => coderCommand({ task: "test", executable: "dsh; env" })).toThrow();
    expect(() => coderCommand({ task: "test", profile: "x;env" })).toThrow();
  });
  it("uses absolute sandbox directories as quoted cd targets", () => {
    expect(coderCommand({ task: "test", cwd: "/tmp/work dir" })).toMatch(
      /^cd -- '\/tmp\/work dir' && printf/,
    );
    expect(coderCommand({ task: "test", cwd: "work" })).toMatch(/^printf/);
    expect(() => coderCommand({ task: "test", cwd: "bad\0path" })).toThrow();
  });
  it("passes the real approval serializer with missing, relative, and absolute cwd", () => {
    for (const cwd of [undefined, "work", "/tmp/work"]) {
      const args = coderShellArgs({ task: "Run `tests`", ...(cwd ? { cwd } : {}) });
      expect(() => stableJsonValue(args)).not.toThrow();
      expect(args.coderTask).toBe("Run `tests`");
      expect(protectedComputerLifecycleRefusal(String(args.command))).toBeUndefined();
    }
  });
  it("keeps completed calls while the next action streams and ignores partial lines", () => {
    const events =
      [
        { type: "tool_call", callId: "1", tool: "write", input: { file_path: "hello.py" } },
        { type: "tool_result", callId: "1", status: "completed", result: "saved" },
        { type: "tool_call", callId: "2", tool: "bash", input: { description: "Run tests" } },
      ]
        .map((value) => JSON.stringify(value))
        .join("\n") + '\n{"type":"final"';
    const state = dshActivity(events, "task", "now");
    expect(state.actions.map((a) => a.status)).toEqual(["done", "running"]);
    expect(state.phase).toBe("Run tests");
    expect(state.actions[0]?.output).toBe("saved");
  });
  it("redacts decoded JSON strings before publishing activity", () => {
    const state = dshActivity('{"type":"final","text":"\\u0073ecret"}\n', "task", "now", (value) =>
      value.replaceAll("secret", "[redacted]"),
    );
    expect(state.text).toBe("[redacted]");
  });
  it("captures final output without trusting HTML and bounds history", () => {
    const events = Array.from({ length: 100 }, (_, i) =>
      JSON.stringify({ type: "tool_call", callId: String(i), tool: "bash" }),
    );
    events.push(JSON.stringify({ type: "final", text: "<script>data</script>" }));
    const result = dshActivity(events.join("\n") + "\n", "task", "now");
    expect(result.actions).toHaveLength(60);
    expect(result.phase).toBe("Finished");
    expect(result.text).toBe("<script>data</script>");
  });
});
