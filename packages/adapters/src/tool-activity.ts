import type { ToolDiff } from "@rakazo/contracts";
import {
  TOOL_ACTIVITY_ERROR_MAX_CHARS,
  TOOL_ACTIVITY_SUMMARY_MAX_CHARS,
  TOOL_DIFF_MAX_CHARS,
} from "@rakazo/contracts";

/** Shown when a tool has no per-tool summary and its name is unusable. */
const GENERIC_SUMMARY = "Working";
/** Shown when nothing safe can be read out of a thrown value. */
const GENERIC_ERROR = "The action failed";
const BINARY_REASON = "Binary file";
const NO_SNAPSHOT_REASON = "No before and after snapshot was captured for this file";
const TOO_LARGE_REASON = "The change is too large to display";

const BINARY_SCAN_BYTES = 8_000;
const SNAPSHOT_MAX_FILE_BYTES = 512 * 1024;
const SNAPSHOT_MAX_DIFFS = 5;
const HUNK_CONTEXT_LINES = 3;
/** LCS table cells are 4 bytes each; this keeps one diff under ~64 MB. */
const MAX_DIFF_CELLS = 16_000_000;

const EMPTY_BYTES = new Uint8Array(0);
const UTF8 = new TextDecoder("utf-8", { fatal: true });

const HOME_SEGMENT = /\/home\/[^/]+\//;
/** Workspace roots that sit directly under a home directory in the sandboxes. */
const WORKSPACE_DIRS = ["workspace/", "rakazo-home/"];

function collapseWhitespace(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/** Only strings are ever read out of tool arguments; anything else is ignored. */
function textValue(value: unknown): string {
  return typeof value === "string" ? collapseWhitespace(value) : "";
}

function humanizeToolName(tool: string): string {
  const words = tool.replaceAll(/[_-]+/g, " ").replaceAll(/\s+/g, " ").trim();
  if (!words) return GENERIC_SUMMARY;
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** Never echo a host path: absolute paths become workspace-relative or just the file name. */
function workspaceRelativePath(value: unknown): string {
  const raw = textValue(value).replaceAll("\\", "/");
  if (!raw) return "";
  const home = HOME_SEGMENT.exec(raw);
  if (home) {
    let rest = raw.slice((home.index ?? 0) + home[0].length);
    for (const dir of WORKSPACE_DIRS) {
      if (!rest.startsWith(dir)) continue;
      rest = rest.slice(dir.length);
      break;
    }
    return rest;
  }
  if (raw.startsWith("/")) return raw.slice(raw.lastIndexOf("/") + 1);
  return raw.replace(/^\.\//, "");
}

/** The command name only: the rest of the line can carry tokens and secrets. */
function commandName(value: unknown): string {
  const first = textValue(value).split(" ")[0] ?? "";
  return first.slice(first.lastIndexOf("/") + 1);
}

function urlSummary(value: unknown, includePath: boolean): string {
  const raw = textValue(value);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (!url.hostname) return "";
    if (!includePath) return url.hostname;
    return url.pathname === "/" ? url.hostname : `${url.hostname}${url.pathname}`;
  } catch {
    // Unparsed input may still carry userinfo or a token in the query string.
    return "";
  }
}

function goalTitle(args: Record<string, unknown>): string {
  return textValue(args.title) || textValue(args.goalTitle) || textValue(args.name);
}

function targetName(args: Record<string, unknown>): string {
  return (
    textValue(args.name) ||
    textValue(args.bot_name) ||
    textValue(args.confirm_name) ||
    textValue(args.title)
  );
}

/** Per-tool detail. Empty means "fall back to the humanised tool name". */
function summarize(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case "shell":
    case "coder_run": {
      const name = commandName(args.command);
      return name ? `Running ${name}` : "Running a command";
    }
    case "read_file":
    case "write_file":
    case "list_files":
    case "attach_file":
    case "open_path":
      return workspaceRelativePath(args.path);
    case "web_search":
      return textValue(args.query);
    case "web_fetch":
      return urlSummary(args.url, true);
    case "browser_navigate":
      return urlSummary(args.url, false);
    case "image_generate":
      return "Generating an image";
    case "render_plot":
      return "Rendering a chart";
    case "computer_observe":
      return "Looking at the screen";
    case "computer_act":
      return "Operating the computer";
    case "browser_snapshot":
      return "Reading the page";
    case "browser_act":
      return "Using the page";
    case "goal_create":
      return goalTitle(args) || "Creating a goal";
    case "goal_update":
      return goalTitle(args) || "Updating a goal";
    case "goal_status":
      return goalTitle(args) || "Checking goals";
    case "spawn_bot":
      return targetName(args) || "Spawning a bot";
    case "message_bot":
      return targetName(args) || "Messaging a bot";
    case "run_subagent":
      return targetName(args) || "Running a helper";
    default:
      return "";
  }
}

/**
 * One short, safe line describing a tool call. Only specific fields per tool are read,
 * so a secret in any other argument can never reach the timeline row.
 */
export function toolActivitySummary(tool: string, args: Record<string, unknown>): string {
  try {
    let detail = "";
    try {
      detail = summarize(tool, args);
    } catch {
      // A malformed argument bag must not cost us the whole row.
      detail = "";
    }
    return truncateText(
      collapseWhitespace(detail || humanizeToolName(tool)),
      TOOL_ACTIVITY_SUMMARY_MAX_CHARS,
    );
  } catch {
    return GENERIC_SUMMARY;
  }
}

/**
 * Replace known secret values with `[redacted]`, then cap the result. Short values are
 * ignored so ordinary words are not shredded.
 */
export function redactActivityText(
  text: string,
  secrets: readonly string[],
  maxChars: number = TOOL_ACTIVITY_ERROR_MAX_CHARS,
): string {
  let redacted = typeof text === "string" ? text : "";
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 4) continue;
    redacted = redacted.split(secret).join("[redacted]");
  }
  return truncateText(redacted, maxChars);
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message || error.name;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "";
}

/** A one-line error summary: the message only, never the stack, capped for the UI. */
export function sanitizeActivityError(error: unknown): string {
  try {
    const raw = messageOf(error);
    if (!raw) return GENERIC_ERROR;
    const lines: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (/^\s+at\s/.test(line)) break;
      lines.push(line);
    }
    const text = collapseWhitespace(lines.join(" "));
    return text ? truncateText(text, TOOL_ACTIVITY_ERROR_MAX_CHARS) : GENERIC_ERROR;
  } catch {
    return GENERIC_ERROR;
  }
}

interface DiffLine {
  kind: "eq" | "del" | "ins";
  text: string;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function isBinaryBytes(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.byteLength, BINARY_SCAN_BYTES);
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0) return true;
  }
  return false;
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return UTF8.decode(bytes);
  } catch {
    return null;
  }
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Line diff over the region between the common prefix and suffix, so an edit in a large
 * file stays cheap. `null` means the changed region is too big for the table.
 */
function diffLines(before: readonly string[], after: readonly string[]): DiffLine[] | null {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > prefix && afterEnd > prefix && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  const removed = before.slice(prefix, beforeEnd);
  const added = after.slice(prefix, afterEnd);
  if ((removed.length + 1) * (added.length + 1) > MAX_DIFF_CELLS) return null;

  const lines: DiffLine[] = [];
  for (let index = 0; index < prefix; index += 1) {
    lines.push({ kind: "eq", text: before[index] ?? "" });
  }

  const stride = added.length + 1;
  const table = new Uint32Array((removed.length + 1) * stride);
  // Indexed reads are typed as possibly-undefined under noUncheckedIndexedAccess, which a
  // dense Uint32Array never is.
  const at = (index: number): number => table[index] ?? 0;
  for (let row = 1; row <= removed.length; row += 1) {
    for (let column = 1; column <= added.length; column += 1) {
      table[row * stride + column] =
        removed[row - 1] === added[column - 1]
          ? at((row - 1) * stride + column - 1) + 1
          : Math.max(at((row - 1) * stride + column), at(row * stride + column - 1));
    }
  }

  const middle: DiffLine[] = [];
  let row = removed.length;
  let column = added.length;
  while (row > 0 && column > 0) {
    if (removed[row - 1] === added[column - 1]) {
      middle.push({ kind: "eq", text: removed[row - 1] ?? "" });
      row -= 1;
      column -= 1;
    } else if (at((row - 1) * stride + column) >= at(row * stride + column - 1)) {
      middle.push({ kind: "del", text: removed[row - 1] ?? "" });
      row -= 1;
    } else {
      middle.push({ kind: "ins", text: added[column - 1] ?? "" });
      column -= 1;
    }
  }
  while (row > 0) {
    middle.push({ kind: "del", text: removed[row - 1] ?? "" });
    row -= 1;
  }
  while (column > 0) {
    middle.push({ kind: "ins", text: added[column - 1] ?? "" });
    column -= 1;
  }
  middle.reverse();
  lines.push(...middle);

  for (let index = beforeEnd; index < before.length; index += 1) {
    lines.push({ kind: "eq", text: before[index] ?? "" });
  }
  return lines;
}

interface RenderedPatch {
  patch: string;
  additions: number;
  deletions: number;
}

function renderUnifiedPatch(path: string, lines: readonly DiffLine[]): RenderedPatch | undefined {
  const changes: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (line.kind !== "eq") changes.push(index);
  }
  if (changes.length === 0) return undefined;

  // aBefore[i] is how many before-lines precede index i, so line numbers fall out of it.
  const aBefore: number[] = [0];
  const bBefore: number[] = [0];
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    aBefore.push((aBefore[aBefore.length - 1] ?? 0) + (line.kind === "ins" ? 0 : 1));
    bBefore.push((bBefore[bBefore.length - 1] ?? 0) + (line.kind === "del" ? 0 : 1));
    if (line.kind === "ins") additions += 1;
    else if (line.kind === "del") deletions += 1;
  }

  const hunks: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  while (cursor < changes.length) {
    const first = changes[cursor] ?? 0;
    let last = first;
    cursor += 1;
    while (cursor < changes.length) {
      const next = changes[cursor] ?? last;
      if (next - last - 1 > HUNK_CONTEXT_LINES * 2) break;
      last = next;
      cursor += 1;
    }
    hunks.push({
      start: Math.max(0, first - HUNK_CONTEXT_LINES),
      end: Math.min(lines.length, last + HUNK_CONTEXT_LINES + 1),
    });
  }

  const output: string[] = [`--- a/${path}`, `+++ b/${path}`];
  for (const hunk of hunks) {
    const aStartBefore = aBefore[hunk.start] ?? 0;
    const bStartBefore = bBefore[hunk.start] ?? 0;
    const aCount = (aBefore[hunk.end] ?? 0) - aStartBefore;
    const bCount = (bBefore[hunk.end] ?? 0) - bStartBefore;
    // A hunk with no lines on one side anchors on the line before it, as diff(1) does.
    const aStart = aCount === 0 ? aStartBefore : aStartBefore + 1;
    const bStart = bCount === 0 ? bStartBefore : bStartBefore + 1;
    output.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (let index = hunk.start; index < hunk.end; index += 1) {
      const line = lines[index];
      if (!line) continue;
      const marker = line.kind === "ins" ? "+" : line.kind === "del" ? "-" : " ";
      output.push(`${marker}${line.text}`);
    }
  }

  return { patch: `${output.join("\n")}\n`, additions, deletions };
}

/**
 * A unified diff for one file, or `undefined` when nothing changed. Any case where the
 * change cannot be shown faithfully returns `unavailableReason` and never a partial patch.
 */
export function buildToolDiff(input: {
  path: string;
  before?: Uint8Array | null;
  after?: Uint8Array | null;
}): ToolDiff | undefined {
  const path = textValue(input.path) || "file";
  const before = input.before ?? null;
  const after = input.after ?? null;
  if (!before && !after) return { path, unavailableReason: NO_SNAPSHOT_REASON };

  const beforeBytes = before ?? EMPTY_BYTES;
  const afterBytes = after ?? EMPTY_BYTES;
  if (bytesEqual(beforeBytes, afterBytes)) return undefined;
  if (isBinaryBytes(beforeBytes) || isBinaryBytes(afterBytes)) {
    return { path, unavailableReason: BINARY_REASON };
  }

  const beforeText = decodeUtf8(beforeBytes);
  const afterText = decodeUtf8(afterBytes);
  if (beforeText === null || afterText === null) {
    return { path, unavailableReason: BINARY_REASON };
  }

  const lines = diffLines(splitLines(beforeText), splitLines(afterText));
  if (!lines) return { path, unavailableReason: TOO_LARGE_REASON };
  const rendered = renderUnifiedPatch(path, lines);
  if (!rendered) return undefined;

  if (rendered.patch.length > TOOL_DIFF_MAX_CHARS) {
    const head = rendered.patch.slice(0, TOOL_DIFF_MAX_CHARS);
    const cut = head.lastIndexOf("\n");
    return {
      path,
      patch: cut > 0 ? head.slice(0, cut + 1) : head,
      additions: rendered.additions,
      deletions: rendered.deletions,
      truncated: true,
    };
  }

  return {
    path,
    patch: rendered.patch,
    additions: rendered.additions,
    deletions: rendered.deletions,
  };
}

/**
 * Diffs for shell edits, where we only have two workspace snapshots. Oversized and binary
 * files are skipped rather than reported, and the result is capped so one command cannot
 * flood the timeline.
 */
export function snapshotWorkspaceChanges(
  before: Map<string, Uint8Array>,
  after: Map<string, Uint8Array>,
): ToolDiff[] {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const diffs: ToolDiff[] = [];
  for (const path of paths) {
    if (diffs.length >= SNAPSHOT_MAX_DIFFS) break;
    const beforeBytes = before.get(path) ?? null;
    const afterBytes = after.get(path) ?? null;
    if (beforeBytes && afterBytes && bytesEqual(beforeBytes, afterBytes)) continue;
    if ((beforeBytes?.byteLength ?? 0) > SNAPSHOT_MAX_FILE_BYTES) continue;
    if ((afterBytes?.byteLength ?? 0) > SNAPSHOT_MAX_FILE_BYTES) continue;
    if ((beforeBytes && isBinaryBytes(beforeBytes)) || (afterBytes && isBinaryBytes(afterBytes))) {
      continue;
    }
    const diff = buildToolDiff({ path, before: beforeBytes, after: afterBytes });
    if (diff) diffs.push(diff);
  }
  return diffs;
}
