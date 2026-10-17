import { Buffer } from "node:buffer";
import type { CoderActivity } from "@rakazo/contracts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Build argv-equivalent shell syntax; every model-supplied value is data. */
export function coderCommand(args: Record<string, unknown>) {
  if (typeof args.task !== "string" || !args.task.trim() || args.task.length > 32000) {
    throw new Error("Provide a coding task between 1 and 32000 characters.");
  }
  const executable = args.executable ?? "dsh";
  const profile = args.profile ?? "headless";
  if (
    typeof executable !== "string" ||
    !/^(?:[\w./-]+)$/.test(executable) ||
    executable.startsWith("-")
  ) {
    throw new Error("executable must be an installed CLI path, without arguments.");
  }
  if (typeof profile !== "string" || !/^[\w-]{1,64}$/.test(profile)) {
    throw new Error("Invalid DSH profile.");
  }
  if (
    args.cwd !== undefined &&
    (typeof args.cwd !== "string" || args.cwd.includes("\0") || args.cwd.length > 4096)
  ) {
    throw new Error("Invalid working directory.");
  }
  const directory =
    typeof args.cwd === "string" && args.cwd.startsWith("/") ? `cd -- ${quote(args.cwd)} && ` : "";
  return `${directory}printf %s ${quote(Buffer.from(args.task, "utf8").toString("base64"))} | base64 -d | ${quote(executable)} --profile ${quote(profile)} --json -`;
}

/** Keep optional keys absent: the approval serializer rejects undefined values. */
export function coderShellArgs(args: Record<string, unknown>): Record<string, unknown> {
  const command = coderCommand(args);
  return {
    command,
    coderTask: String(args.task),
    ...(typeof args.cwd === "string" && !args.cwd.startsWith("/") ? { cwd: args.cwd } : {}),
  };
}

/** Consumes the already-redacted cumulative stdout. Partial JSONL is held until complete. */
export function dshActivity(
  stdout: string,
  task: string,
  startedAt: string,
  redact: (value: string) => string = (value) => value,
): CoderActivity {
  const actions = new Map<string, CoderActivity["actions"][number]>();
  let phase = "Connecting";
  let text = "";
  for (const line of stdout.split("\n").slice(0, -1)) {
    if (!line.trim() || line.length > 2_000_000) continue;
    try {
      const event = JSON.parse(line);
      if (!event || typeof event !== "object") continue;
      if (event.type === "tool_call" && typeof event.callId === "string") {
        const tool = redact(typeof event.tool === "string" ? event.tool : "tool");
        const input = event.input && typeof event.input === "object" ? event.input : {};
        const label = redact(
          String(input.description ?? input.file_path ?? input.command ?? tool),
        ).slice(0, 200);
        actions.set(event.callId, {
          id: redact(event.callId),
          tool: tool.slice(0, 60),
          label,
          status: "running",
          output: "",
        });
        phase = label;
      } else if (event.type === "tool_result" && typeof event.callId === "string") {
        const action = actions.get(event.callId);
        if (action) {
          action.status = event.status === "failed" || event.status === "error" ? "failed" : "done";
          action.output = redact(
            typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? ""),
          ).slice(-800);
        }
        phase = "Waiting for response";
      } else if (event.type === "text" && typeof event.text === "string") {
        text = (text + redact(event.text)).slice(-4000);
        phase = "Writing response";
      } else if (event.type === "final") {
        text = typeof event.text === "string" ? redact(event.text).slice(-4000) : text;
        phase = "Finished";
      } else if (event.type === "status" && event.phase === "step_start") {
        phase = "Waiting for response";
      }
    } catch {
      // Vendor diagnostics and partial/malformed events are not executable content.
    }
  }
  return {
    provider: "dsh",
    task: redact(task).slice(0, 1000),
    startedAt,
    phase,
    text,
    actions: [...actions.values()].slice(-60),
  };
}
