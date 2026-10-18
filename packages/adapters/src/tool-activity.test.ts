import {
  TOOL_ACTIVITY_ERROR_MAX_CHARS,
  TOOL_ACTIVITY_SUMMARY_MAX_CHARS,
  TOOL_DIFF_MAX_CHARS,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  buildToolDiff,
  redactActivityText,
  sanitizeActivityError,
  snapshotWorkspaceChanges,
  toolActivitySummary,
} from "./tool-activity.js";

const encoder = new TextEncoder();

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

describe("toolActivitySummary", () => {
  it("names the command without the rest of the line", () => {
    expect(toolActivitySummary("shell", { command: "npm install --save left-pad" })).toBe(
      "Running npm",
    );
    expect(toolActivitySummary("coder_run", { command: "/usr/bin/git status --short" })).toBe(
      "Running git",
    );
    expect(toolActivitySummary("shell", { command: "python3 -c 'print(1)'" })).toBe(
      "Running python3",
    );
  });

  it("never puts a secret from the command line into the row", () => {
    const secret = "sk-live-4f9c2ab77e";
    const summary = toolActivitySummary("shell", {
      command: `curl -H "Authorization: Bearer ${secret}" https://api.example.com/v1`,
    });
    expect(summary).toBe("Running curl");
    expect(summary).not.toContain(secret);
  });

  it("shows a workspace-relative path and never a host path", () => {
    expect(toolActivitySummary("read_file", { path: "/home/rakazo/workspace/notes/todo.md" })).toBe(
      "notes/todo.md",
    );
    expect(toolActivitySummary("write_file", { path: "./src/app.ts" })).toBe("src/app.ts");
    expect(toolActivitySummary("attach_file", { path: "/home/user/rakazo-home/report.pdf" })).toBe(
      "report.pdf",
    );
    expect(toolActivitySummary("list_files", { path: "/etc" })).toBe("etc");
    expect(toolActivitySummary("open_path", { path: "shared/chart.png" })).toBe("shared/chart.png");
  });

  it("describes web tools by target, with no query string", () => {
    expect(toolActivitySummary("web_search", { query: "  how to  bake bread " })).toBe(
      "how to bake bread",
    );
    const fetchSummary = toolActivitySummary("web_fetch", {
      url: "https://docs.example.com/guide/intro?token=abc123&user=1#section",
    });
    expect(fetchSummary).toBe("docs.example.com/guide/intro");
    expect(fetchSummary).not.toContain("token");
    expect(toolActivitySummary("browser_navigate", { url: "https://example.com/a?b=1" })).toBe(
      "example.com",
    );
  });

  it("uses fixed phrases where there is nothing safe to quote", () => {
    expect(toolActivitySummary("generate_image", { prompt: "a cat" })).toBe("Generating an image");
    expect(toolActivitySummary("render_plot", { name: "sales" })).toBe("Rendering a chart");
    expect(toolActivitySummary("computer_observe", {})).toBe("Looking at the screen");
    expect(toolActivitySummary("computer_act", { actions: [] })).toBe("Operating the computer");
    expect(toolActivitySummary("browser_snapshot", {})).toBe("Reading the page");
    expect(toolActivitySummary("browser_act", {})).toBe("Using the page");
  });

  it("prefers the goal title and the bot name when present", () => {
    expect(toolActivitySummary("goal_create", { title: "Ship the billing fix" })).toBe(
      "Ship the billing fix",
    );
    expect(toolActivitySummary("goal_update", { goalId: "g1", status: "active" })).toBe(
      "Updating a goal",
    );
    expect(toolActivitySummary("goal_status", {})).toBe("Checking goals");
    expect(toolActivitySummary("spawn_bot", { name: "Researcher" })).toBe("Researcher");
    expect(toolActivitySummary("run_subagent", { name: "scout", task: "read logs" })).toBe("scout");
    expect(toolActivitySummary("message_bot", { message: "hi" })).toBe("Messaging a bot");
  });

  it("falls back to a humanised tool name", () => {
    expect(toolActivitySummary("save_memory", {})).toBe("Save memory");
    expect(toolActivitySummary("mcp__github__create_issue", { title: "x" })).toBe(
      "Mcp github create issue",
    );
    expect(toolActivitySummary("", {})).toBe("Working");
  });

  it("truncates at the summary cap", () => {
    const summary = toolActivitySummary("web_search", { query: "a".repeat(500) });
    expect(summary.length).toBeLessThanOrEqual(TOOL_ACTIVITY_SUMMARY_MAX_CHARS);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("collapses whitespace and never throws on bad arguments", () => {
    expect(toolActivitySummary("web_search", { query: "line one\n\tline two" })).toBe(
      "line one line two",
    );
    expect(toolActivitySummary("shell", null as unknown as Record<string, unknown>)).toBe("Shell");
    expect(toolActivitySummary("shell", { command: 42 })).toBe("Running a command");
    expect(() => toolActivitySummary("shell", { get command(): string {
      throw new Error("boom");
    } })).not.toThrow();
  });
});

describe("redactActivityText", () => {
  it("replaces known secrets and ignores short ones", () => {
    expect(redactActivityText("token sk-1234 was used", ["sk-1234"])).toBe(
      "token [redacted] was used",
    );
    expect(redactActivityText("a cat sat", ["cat"])).toBe("a cat sat");
    expect(redactActivityText("hunter2hunter2 twice: hunter2hunter2", ["hunter2hunter2"])).toBe(
      "[redacted] twice: [redacted]",
    );
    expect(redactActivityText("", [])).toBe("");
  });

  it("redacts before truncating so no partial secret survives", () => {
    const secret = "s3cr3t-value";
    const redacted = redactActivityText(`${"a".repeat(400)} ${secret}`, [secret]);
    expect(redacted).not.toContain(secret);
    expect(redacted).not.toContain("s3cr3t");
    expect(redacted.length).toBeLessThanOrEqual(TOOL_ACTIVITY_ERROR_MAX_CHARS);
  });
});

describe("sanitizeActivityError", () => {
  it("keeps the message and drops the stack", () => {
    const error = new Error("ENOENT: no such file or directory");
    error.stack = `Error: ENOENT: no such file or directory\n    at readFile (node:fs:1:1)\n    at main (/app/index.ts:2:2)`;
    expect(sanitizeActivityError(error)).toBe("ENOENT: no such file or directory");
  });

  it("strips a stack embedded in a string and collapses newlines", () => {
    expect(sanitizeActivityError("Error: boom\n    at x (y:1:1)\n    at z (w:2:2)")).toBe(
      "Error: boom",
    );
    expect(sanitizeActivityError("first line\nsecond line")).toBe("first line second line");
    expect(sanitizeActivityError("  padded   text  ")).toBe("padded text");
  });

  it("reads a message off a plain object and never throws", () => {
    expect(sanitizeActivityError({ message: "quota exceeded" })).toBe("quota exceeded");
    expect(sanitizeActivityError(undefined)).toBe("The action failed");
    expect(sanitizeActivityError(null)).toBe("The action failed");
    expect(sanitizeActivityError({ nope: true })).toBe("The action failed");
    expect(sanitizeActivityError(new Error(""))).toBe("Error");
  });

  it("caps the line", () => {
    expect(sanitizeActivityError("x".repeat(500)).length).toBeLessThanOrEqual(
      TOOL_ACTIVITY_ERROR_MAX_CHARS,
    );
  });
});

describe("buildToolDiff", () => {
  it("diffs a new file as pure additions", () => {
    const diff = buildToolDiff({ path: "notes/new.md", before: null, after: bytes("hello\nworld\n") });
    expect(diff?.path).toBe("notes/new.md");
    expect(diff?.unavailableReason).toBeUndefined();
    expect(diff?.additions).toBe(2);
    expect(diff?.deletions).toBe(0);
    expect(diff?.truncated).toBeUndefined();
    expect(diff?.patch).toContain("--- a/notes/new.md");
    expect(diff?.patch).toContain("+++ b/notes/new.md");
    expect(diff?.patch).toContain("@@ -0,0 +1,2 @@");
    expect(diff?.patch).toContain("+hello");
    expect(diff?.patch).toContain("+world");
  });

  it("diffs a deleted file as pure deletions", () => {
    const diff = buildToolDiff({ path: "notes/old.md", before: bytes("bye\nnow\n"), after: null });
    expect(diff?.additions).toBe(0);
    expect(diff?.deletions).toBe(2);
    expect(diff?.patch).toContain("@@ -1,2 +0,0 @@");
    expect(diff?.patch).toContain("-bye");
    expect(diff?.patch).toContain("-now");
  });

  it("counts a modification and keeps the surrounding context", () => {
    const diff = buildToolDiff({
      path: "src/app.ts",
      before: bytes("one\ntwo\nthree\n"),
      after: bytes("one\nTWO\nthree\n"),
    });
    expect(diff?.additions).toBe(1);
    expect(diff?.deletions).toBe(1);
    expect(diff?.patch).toContain("@@ -1,3 +1,3 @@");
    expect(diff?.patch).toContain("-two");
    expect(diff?.patch).toContain("+TWO");
    expect(diff?.patch).toContain(" one");
    expect(diff?.patch).toContain(" three");
  });

  it("splits distant edits into separate hunks", () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
    const after = [...before];
    after[1] = "changed near the top";
    after[18] = "changed near the bottom";
    const diff = buildToolDiff({
      path: "long.txt",
      before: bytes(`${before.join("\n")}\n`),
      after: bytes(`${after.join("\n")}\n`),
    });
    const hunks = diff?.patch?.match(/^@@ /gm) ?? [];
    expect(hunks).toHaveLength(2);
    expect(diff?.additions).toBe(2);
    expect(diff?.deletions).toBe(2);
  });

  it("reports identical content as no diff", () => {
    expect(
      buildToolDiff({ path: "same.txt", before: bytes("same\n"), after: bytes("same\n") }),
    ).toBeUndefined();
  });

  it("refuses to patch a binary file", () => {
    const diff = buildToolDiff({
      path: "image.png",
      before: Uint8Array.from([0x89, 0x50, 0x00, 0x01]),
      after: Uint8Array.from([0x89, 0x50, 0x00, 0x02]),
    });
    expect(diff?.patch).toBeUndefined();
    expect(diff?.unavailableReason).toBe("Binary file");
  });

  it("refuses to patch bytes that are not valid UTF-8", () => {
    const diff = buildToolDiff({
      path: "legacy.txt",
      before: Uint8Array.from([0xc3, 0x28]),
      after: Uint8Array.from([0xc3, 0x29]),
    });
    expect(diff?.patch).toBeUndefined();
    expect(diff?.unavailableReason).toBe("Binary file");
  });

  it("reports a missing snapshot instead of inventing a diff", () => {
    const diff = buildToolDiff({ path: "unknown.txt" });
    expect(diff?.path).toBe("unknown.txt");
    expect(diff?.patch).toBeUndefined();
    expect(diff?.unavailableReason).toBeTruthy();
  });

  it("truncates a large patch at a line boundary", () => {
    const before = Array.from({ length: 2_000 }, (_, index) => `before ${index}`).join("\n");
    const after = Array.from({ length: 2_000 }, (_, index) => `after ${index}`).join("\n");
    const diff = buildToolDiff({
      path: "big.txt",
      before: bytes(`${before}\n`),
      after: bytes(`${after}\n`),
    });
    expect(diff?.truncated).toBe(true);
    expect(diff?.patch?.length).toBeLessThanOrEqual(TOOL_DIFF_MAX_CHARS);
    expect(diff?.patch?.endsWith("\n")).toBe(true);
    expect(diff?.additions).toBe(2_000);
    expect(diff?.deletions).toBe(2_000);
  });
});

describe("snapshotWorkspaceChanges", () => {
  it("returns only the changed text files, sorted by path", () => {
    const big = "x".repeat(600 * 1024);
    const before = new Map<string, Uint8Array>([
      ["a.txt", bytes("one\n")],
      ["same.txt", bytes("same\n")],
      ["gone.txt", bytes("bye\n")],
      ["big.txt", bytes(big)],
      ["logo.png", Uint8Array.from([0x89, 0x50, 0x00, 0x01])],
    ]);
    const after = new Map<string, Uint8Array>([
      ["a.txt", bytes("two\n")],
      ["same.txt", bytes("same\n")],
      ["new.txt", bytes("hi\n")],
      ["big.txt", bytes(`${big}y`)],
      ["logo.png", Uint8Array.from([0x89, 0x50, 0x00, 0x02])],
    ]);

    const diffs = snapshotWorkspaceChanges(before, after);
    expect(diffs.map((diff) => diff.path)).toEqual(["a.txt", "gone.txt", "new.txt"]);
    for (const diff of diffs) expect(diff.patch).toBeTruthy();
  });

  it("caps how many diffs one snapshot pair returns", () => {
    const before = new Map<string, Uint8Array>();
    const after = new Map<string, Uint8Array>();
    for (let index = 0; index < 8; index += 1) {
      before.set(`file-${index}.txt`, bytes("before\n"));
      after.set(`file-${index}.txt`, bytes("after\n"));
    }
    const diffs = snapshotWorkspaceChanges(before, after);
    expect(diffs).toHaveLength(5);
    expect(diffs.map((diff) => diff.path)).toEqual([
      "file-0.txt",
      "file-1.txt",
      "file-2.txt",
      "file-3.txt",
      "file-4.txt",
    ]);
  });

  it("returns nothing when the snapshots match", () => {
    const snapshot = new Map<string, Uint8Array>([["a.txt", bytes("same\n")]]);
    expect(snapshotWorkspaceChanges(snapshot, snapshot)).toEqual([]);
    expect(snapshotWorkspaceChanges(new Map(), new Map())).toEqual([]);
  });
});
