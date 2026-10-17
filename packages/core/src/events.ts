import type {
  MessageBlock,
  ThreadMessage,
  ToolActivityStatus,
  ToolActivityStep,
  ToolDiff,
} from "@rakazo/contracts";
import { TOOL_ACTIVITY_ERROR_MAX_CHARS } from "@rakazo/contracts";
import { cloudAgentBlockFromPayload } from "./cloud-agent.js";

export function projectMessages(
  events: Array<{
    seq: number;
    type: string;
    payload: unknown;
    runId?: string | null;
    createdAt: Date | string;
    id: string;
    threadId: string;
    botId?: string | null;
  }>,
): ThreadMessage[] {
  let messages: ThreadMessage[] = [];
  type LiveProjection = {
    blocks: MessageBlock[];
    meta: {
      id: string;
      threadId: string;
      seq: number;
      botId?: string;
      runId?: string;
      createdAt: string;
    };
  };
  const liveById = new Map<string, LiveProjection>();
  const liveSubagents = new Map<string, ThreadMessage>();
  const durableSubagents = new Set<string>();
  const liveProjection = (event: (typeof events)[number], createdAt: string): LiveProjection => {
    const id = progressMessageId(event);
    const existing = liveById.get(id);
    if (existing) return existing;
    const projection: LiveProjection = {
      blocks: [],
      meta: {
        id,
        threadId: event.threadId,
        seq: event.seq,
        botId: event.botId ?? undefined,
        runId: event.runId ?? undefined,
        createdAt,
      },
    };
    liveById.set(id, projection);
    return projection;
  };
  const clearLive = (event: (typeof events)[number]) => {
    if (event.runId) liveById.delete(progressMessageId(event));
    else liveById.clear();
  };
  for (const event of events) {
    const payload = asRecord(event.payload);
    const createdAt =
      typeof event.createdAt === "string" ? event.createdAt : event.createdAt.toISOString();
    if (event.type === "thread.message.created") {
      clearLive(event);
      const role = (payload.role as ThreadMessage["role"]) ?? "bot";
      const blocks = (payload.blocks as MessageBlock[]) ?? [];
      for (const block of blocks) {
        if (block.kind === "subagent") {
          durableSubagents.add(block.agentId);
          liveSubagents.delete(block.agentId);
        }
      }
      messages.push({
        id: (payload.messageId as string) ?? event.id,
        threadId: event.threadId,
        seq: event.seq,
        role,
        blocks,
        botId: event.botId ?? undefined,
        runId: event.runId ?? undefined,
        createdAt,
      });
      continue;
    }
    if (event.type === "thread.cloud_agent") {
      const block = cloudAgentBlockFromPayload(payload);
      for (const message of messages) {
        if (message.id === payload.messageId)
          message.blocks = message.blocks.map((old) =>
            old.kind === "cloud_agent" && old.agentId === block.agentId ? block : old,
          );
      }
      continue;
    }
    if (event.type === "thread.progress") {
      const live = liveProjection(event, createdAt);
      live.blocks = reduceLiveMessageBlocks(live.blocks, { type: "progress", payload });
      live.meta = {
        ...live.meta,
        seq: event.seq,
        botId: event.botId ?? undefined,
        createdAt,
      };
      continue;
    }
    if (event.type === "agent.tool.called") {
      const live = liveProjection(event, createdAt);
      const call = toolCallUpdateFromPayload(payload);
      const step = call ? toolStepFromCall(call) : null;
      live.blocks = reduceLiveMessageBlocks(live.blocks, {
        type: "tool",
        name: call?.name ?? String(payload.name ?? ""),
        ...(step ? { step } : {}),
      });
      live.meta = {
        ...live.meta,
        seq: event.seq,
        botId: event.botId ?? undefined,
        createdAt,
      };
      continue;
    }
    if (event.type === "agent.tool.completed") {
      const completion = toolCompletionUpdateFromPayload(payload);
      if (!completion) continue;
      const live = liveById.get(progressMessageId(event));
      const liveBlocks = live ? applyToolCompletionToBlocks(live.blocks, completion) : null;
      if (live && liveBlocks) {
        live.blocks = liveBlocks;
        continue;
      }
      // A mid-turn publish moves the step timeline onto a durable message; the completion
      // still has to land on that row, not only on the live projection.
      const updated = reduceToolCompletionMessages(
        messages,
        progressMessageId(event),
        event.runId ?? undefined,
        completion,
      );
      if (updated) messages = updated;
      continue;
    }
    if (event.type === "thread.cleared") {
      messages.length = 0;
      liveById.clear();
      liveSubagents.clear();
      durableSubagents.clear();
      continue;
    }
    if (event.type === "thread.subagent") {
      const block = subagentBlockFromPayload(payload);
      if (durableSubagents.has(block.agentId)) continue;
      liveSubagents.set(block.agentId, {
        id: `subagent:${block.agentId}`,
        threadId: event.threadId,
        seq: event.seq,
        role: "bot",
        blocks: [block],
        botId: event.botId ?? undefined,
        runId: event.runId ?? undefined,
        createdAt,
      });
      continue;
    }
    if (
      event.type === "run.completed" ||
      event.type === "run.failed" ||
      event.type === "run.cancelled"
    ) {
      clearLive(event);
      // An action still marked running when its run ends never reported back; the live
      // bubble is dropped here, but a durable message keeps the timeline it was published with.
      const settled = settleInterruptedRunMessages(messages, event.runId ?? undefined);
      if (settled) messages = settled;
    }
  }
  for (const live of liveSubagents.values()) messages.push(live);
  for (const live of liveById.values()) {
    if (live.blocks.length > 0) {
      messages.push({
        id: live.meta.id,
        threadId: live.meta.threadId,
        seq: live.meta.seq,
        role: "bot",
        blocks: live.blocks,
        botId: live.meta.botId,
        runId: live.meta.runId,
        createdAt: live.meta.createdAt,
      });
    }
  }
  return messages;
}

export function progressMessageId(event: { runId?: string | null; id?: string }): string {
  return `progress:${event.runId ?? event.id ?? "live"}`;
}

export function isRunTerminalEvent(event: { type: string }): boolean {
  return (
    event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled"
  );
}

export const RESPONSE_STREAMING_STORAGE_KEY = "rakazo.responseStreaming";
export type ResponseStreamingPreference = "on" | "off";

/** Missing and unknown values stay off; only an explicit "on" enables streaming. */
export function normalizeResponseStreamingPreference(
  raw: string | null | undefined,
): ResponseStreamingPreference {
  return raw?.trim().toLowerCase() === "on" ? "on" : "off";
}

export function responseStreamingEnabled(preference: ResponseStreamingPreference = "off"): boolean {
  return preference === "on";
}

/** Hide assistant token text on synthetic progress rows. Tool activity stays. */
export function stripLiveStreamingProgress<
  T extends { id: string; blocks: readonly MessageBlock[] },
>(messages: readonly T[]): T[] {
  let changed = false;
  const next: T[] = [];
  for (const message of messages) {
    if (!message.id.startsWith("progress:")) {
      next.push(message);
      continue;
    }
    const blocks = message.blocks.filter(
      (block) => block.kind !== "text" && (block.kind !== "progress" || block.activity === true),
    );
    if (blocks.length === message.blocks.length) {
      next.push(message);
      continue;
    }
    changed = true;
    if (blocks.length === 0) continue;
    next.push({ ...message, blocks });
  }
  return changed ? next : (messages as T[]);
}

export function withLiveStreamingProgress<
  T extends { messages: readonly U[] },
  U extends { id: string; blocks: readonly MessageBlock[] },
>(snapshot: T | null, streamResponses: boolean): T | null {
  if (!snapshot || streamResponses) return snapshot;
  const messages = stripLiveStreamingProgress(snapshot.messages);
  if (messages === snapshot.messages) return snapshot;
  return { ...snapshot, messages };
}

const RUN_FAILURE_ERROR_MAX = 300;

/** Reason a run failed, clamped for display, or null when there is no usable error to show. */
export function runFailureError(event: {
  type: string;
  payload?: Record<string, unknown>;
}): string | null {
  if (event.type !== "run.failed") return null;
  const error = event.payload?.error;
  if (typeof error !== "string" || !error.trim()) return null;
  const message = error.trim();
  // A provider can fail with a stack or a whole response body; the run record keeps the full
  // text while the UI shows a bounded first line.
  return message.length > RUN_FAILURE_ERROR_MAX
    ? `${message.slice(0, RUN_FAILURE_ERROR_MAX)}…`
    : message;
}

export type LiveMessageUpdate =
  | { type: "progress"; payload: Record<string, unknown> | undefined }
  | { type: "tool"; name: string; step?: ToolActivityStep }
  | { type: "tool.completed"; completion: ToolCompletionUpdate };

export function reduceLiveMessageBlocks(
  blocks: readonly MessageBlock[],
  update: LiveMessageUpdate,
): MessageBlock[] {
  // A step that carries an id is addressable by its completion, so it has to exist as a row
  // immediately; deferring it behind narration would strand the completion event.
  if (update.type === "tool" && update.step) {
    return appendToolStepSegment(flushLiveTail(blocks), update.step);
  }
  if (update.type === "tool.completed") {
    return applyToolCompletionToBlocks(blocks, update.completion) ?? [...blocks];
  }
  const tail = blocks.at(-1);
  const segments = tail?.kind === "progress" ? blocks.slice(0, -1) : blocks;
  const priorText = liveMessageText(blocks);
  const flushedLength =
    tail?.kind === "progress" ? priorText.length - tail.text.length : priorText.length;
  const tailText =
    update.type === "progress"
      ? progressMessageText(update.payload, priorText).slice(flushedLength)
      : tail?.kind === "progress"
        ? tail.text
        : "";
  const pendingToolNames = [
    ...(tail?.kind === "progress" ? (tail.pendingToolNames ?? []) : []),
    ...(update.type === "tool" ? [update.name] : []),
  ];
  const activity =
    update.type === "progress"
      ? update.payload?.activity === true
      : tail?.kind === "progress" && tail.activity === true;

  if (pendingToolNames.length > 0 && endsSentence(tailText)) {
    let next = activity ? [...segments] : appendTextSegment(segments, tailText);
    for (const name of pendingToolNames) next = appendToolCallSegment(next, name);
    return next;
  }
  if (!tailText) return [...segments];
  return [
    ...segments,
    {
      kind: "progress",
      text: tailText,
      ...(activity ? { activity: true as const } : {}),
      ...(pendingToolNames.length > 0 ? { pendingToolNames } : {}),
    },
  ];
}

function liveMessageText(blocks: readonly MessageBlock[]): string {
  return blocks
    .filter((block) => block.kind === "text" || block.kind === "progress")
    .map((block) => block.text)
    .join("");
}

export type ToolStep = { label: string; count: number };

export function appendToolStep(steps: readonly ToolStep[], toolName: string): ToolStep[] {
  const label = humanizeToolName(toolName);
  const last = steps.at(-1);
  if (last && last.label === label) {
    return [...steps.slice(0, -1), { label, count: last.count + 1 }];
  }
  return [...steps, { label, count: 1 }];
}

export type ToolCallUpdate = {
  name: string;
  executionId?: string;
  tool?: string;
  label?: string;
  summary?: string;
  startedAt?: string;
};

export type ToolCompletionUpdate = {
  name: string;
  executionId?: string;
  status?: ToolActivityStatus;
  outcome?: string;
  durationMs?: number;
  error?: string;
  diff?: ToolDiff;
};

const toolActivityStatuses: ReadonlySet<unknown> = new Set<ToolActivityStatus>([
  "running",
  "succeeded",
  "failed",
  "paused",
  "interrupted",
]);

/** Completions emitted before the executor added `status` still report an `outcome`. */
const outcomeStatuses = new Map<string, ToolActivityStatus>([
  ["succeeded", "succeeded"],
  ["error", "failed"],
  ["paused", "paused"],
]);

export function toolCallUpdateFromPayload(payload: Record<string, unknown>): ToolCallUpdate | null {
  const name = optionalText(payload.name);
  if (!name) return null;
  return {
    name,
    executionId: optionalText(payload.executionId),
    tool: optionalText(payload.tool),
    label: optionalText(payload.label),
    summary: optionalText(payload.summary),
    startedAt: optionalText(payload.startedAt),
  };
}

export function toolCompletionUpdateFromPayload(
  payload: Record<string, unknown>,
): ToolCompletionUpdate | null {
  const name = optionalText(payload.name);
  if (!name) return null;
  const durationMs = payload.durationMs;
  return {
    name,
    executionId: optionalText(payload.executionId),
    status: asToolActivityStatus(payload.status),
    outcome: optionalText(payload.outcome),
    durationMs:
      typeof durationMs === "number" && Number.isFinite(durationMs) ? durationMs : undefined,
    error: optionalText(payload.error),
    diff: asToolDiff(payload.diff),
  };
}

/**
 * Build the timeline row for one tool start.
 *
 * Returns null for the name-only calls persisted before steps carried an id: those keep the
 * legacy `{ label, count }` shape so a replayed old conversation renders exactly as before.
 */
export function toolStepFromCall(call: ToolCallUpdate): ToolActivityStep | null {
  if (!call.executionId && !call.label) return null;
  const label = call.label?.trim() || humanizeToolName(call.name);
  return {
    ...(call.executionId ? { id: call.executionId } : {}),
    label,
    count: 1,
    tool: call.tool ?? call.name,
    ...(call.summary ? { summary: call.summary } : {}),
    status: "running",
    ...(call.startedAt ? { startedAt: call.startedAt } : {}),
  };
}

/**
 * Append one start to the timeline.
 *
 * A step with an id is its own chronological row: repeated calls stay separate even when the
 * label matches, because each one can be completed independently. Only the legacy id-less
 * steps keep collapsing into a count.
 */
export function appendToolActivityStep(
  steps: readonly ToolActivityStep[],
  step: ToolActivityStep,
): ToolActivityStep[] {
  if (step.id) {
    // A re-delivered start (SSE replay) must not add a second row for the same action.
    if (steps.some((candidate) => candidate.id === step.id)) return [...steps];
    return [...steps, step];
  }
  const last = steps.at(-1);
  if (last && !last.id && last.label === step.label) {
    return [...steps.slice(0, -1), { ...last, count: last.count + 1 }];
  }
  return [...steps, step];
}

/** How a completion ended, from `status` when present and the older `outcome` otherwise. */
export function toolCompletionStatus(completion: ToolCompletionUpdate): ToolActivityStatus {
  if (completion.status) return completion.status;
  const mapped = completion.outcome ? outcomeStatuses.get(completion.outcome) : undefined;
  if (mapped) return mapped;
  // No explicit outcome: an error still means failure, and anything else settled, which is
  // the success tick this row showed before completions were applied at all.
  return completion.error ? "failed" : "succeeded";
}

function isSettledToolStatus(status: ToolActivityStatus | undefined): boolean {
  return status === "succeeded" || status === "failed" || status === "interrupted";
}

/**
 * Apply a completion to the timeline, in place.
 *
 * Returns null when no row belongs to the completion: inventing one would show a finished
 * action the run never started. The label fallback covers steps persisted without ids and a
 * completion whose start event the client never saw.
 */
export function applyToolCompletion(
  steps: readonly ToolActivityStep[],
  completion: ToolCompletionUpdate,
): ToolActivityStep[] | null {
  let index = completion.executionId
    ? steps.findIndex((step) => step.id === completion.executionId)
    : -1;
  if (index < 0) {
    const label = humanizeToolName(completion.name);
    for (let candidate = steps.length - 1; candidate >= 0; candidate--) {
      const step = steps[candidate];
      if (!step || step.label !== label || isSettledToolStatus(step.status)) continue;
      index = candidate;
      break;
    }
  }
  const current = index >= 0 ? steps[index] : undefined;
  if (!current) return null;
  const error = completion.error?.slice(0, TOOL_ACTIVITY_ERROR_MAX_CHARS);
  const next: ToolActivityStep = {
    ...current,
    status: toolCompletionStatus(completion),
    ...(completion.durationMs === undefined
      ? {}
      : { durationMs: Math.max(0, Math.round(completion.durationMs)) }),
    ...(error ? { error } : {}),
    ...(completion.diff ? { diff: completion.diff } : {}),
  };
  return steps.map((step, position) => (position === index ? next : step));
}

/** Apply a completion to the first block that owns a matching step. */
export function applyToolCompletionToBlocks(
  blocks: readonly MessageBlock[],
  completion: ToolCompletionUpdate,
): MessageBlock[] | null {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    if (block?.kind !== "steps") continue;
    const steps = applyToolCompletion(block.steps, completion);
    if (!steps) continue;
    return blocks.map((candidate, position) =>
      position === index ? { ...block, steps } : candidate,
    );
  }
  return null;
}

/**
 * Land a completion on whichever message holds its step: the live progress bubble while the
 * run is streaming, or the durable message a mid-turn publish moved the timeline onto.
 */
export function reduceToolCompletionMessages<
  Message extends { id: string; role?: string; runId?: string | null; blocks: MessageBlock[] },
>(
  messages: readonly Message[],
  liveId: string,
  runId: string | undefined,
  completion: ToolCompletionUpdate,
): Message[] | null {
  const liveIndex = messages.findIndex((message) => message.id === liveId);
  if (liveIndex >= 0) {
    const blocks = applyToolCompletionToBlocks(messages[liveIndex]!.blocks, completion);
    if (blocks) {
      return messages.map((message, index) =>
        index === liveIndex ? { ...message, blocks } : message,
      );
    }
  }
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "bot" || !runId || message.runId !== runId) continue;
    if (message.id.startsWith("progress:")) continue;
    const blocks = applyToolCompletionToBlocks(message.blocks, completion);
    if (!blocks) continue;
    return messages.map((candidate, position) =>
      position === index ? { ...message, blocks } : candidate,
    );
  }
  return null;
}

/**
 * Settle steps a run left running. A run that ended before an action reported back has no
 * completion to apply, so the row would otherwise spin forever.
 */
export function settleInterruptedToolSteps(blocks: readonly MessageBlock[]): MessageBlock[] | null {
  let changed = false;
  const next = blocks.map((block) => {
    if (block.kind !== "steps") return block;
    let blockChanged = false;
    const steps = block.steps.map((step) => {
      if (step.status !== "running") return step;
      blockChanged = true;
      return { ...step, status: "interrupted" as const };
    });
    if (!blockChanged) return block;
    changed = true;
    return { ...block, steps };
  });
  return changed ? next : null;
}

/** Settle the running steps of every message a finished run published. */
export function settleInterruptedRunMessages<
  Message extends { id: string; runId?: string | null; blocks: MessageBlock[] },
>(messages: readonly Message[], runId: string | undefined): Message[] | null {
  if (!runId) return null;
  let changed = false;
  const next = messages.map((message) => {
    if (message.runId !== runId || message.id.startsWith("progress:")) return message;
    const blocks = settleInterruptedToolSteps(message.blocks);
    if (!blocks) return message;
    changed = true;
    return { ...message, blocks };
  });
  return changed ? next : null;
}

function appendToolStepSegment(
  segments: readonly MessageBlock[],
  step: ToolActivityStep,
): MessageBlock[] {
  const last = segments.at(-1);
  const steps = appendToolActivityStep(last?.kind === "steps" ? last.steps : [], step);
  if (last?.kind === "steps") return [...segments.slice(0, -1), { ...last, steps }];
  return [...segments, { kind: "steps", steps }];
}

/** Settle a trailing progress bubble into text (plus any held-back legacy calls) first. */
function flushLiveTail(blocks: readonly MessageBlock[]): MessageBlock[] {
  const tail = blocks.at(-1);
  if (tail?.kind !== "progress") return [...blocks];
  let flushed = appendTextSegment(blocks.slice(0, -1), tail.text);
  for (const name of tail.pendingToolNames ?? []) flushed = appendToolCallSegment(flushed, name);
  return flushed;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function asToolActivityStatus(value: unknown): ToolActivityStatus | undefined {
  return toolActivityStatuses.has(value) ? (value as ToolActivityStatus) : undefined;
}

function asToolDiff(value: unknown): ToolDiff | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const path = optionalText(record.path);
  if (!path) return undefined;
  const diff: ToolDiff = { path };
  if (typeof record.patch === "string") diff.patch = record.patch;
  if (isCount(record.additions)) diff.additions = record.additions;
  if (isCount(record.deletions)) diff.deletions = record.deletions;
  if (typeof record.truncated === "boolean") diff.truncated = record.truncated;
  const unavailableReason = optionalText(record.unavailableReason);
  if (unavailableReason) diff.unavailableReason = unavailableReason;
  return diff;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export type ToolCallStreak = { key: string | undefined; count: number };

export function trackToolCallStreak(
  streak: ToolCallStreak,
  name: string,
  args: unknown,
): ToolCallStreak {
  const key = `${name}:${JSON.stringify(args)}`;
  return key === streak.key ? { key, count: streak.count + 1 } : { key, count: 1 };
}

export type ToolNameStreak = { name: string | undefined; count: number };

export function trackToolNameStreak(streak: ToolNameStreak, name: string): ToolNameStreak {
  return name === streak.name ? { name, count: streak.count + 1 } : { name, count: 1 };
}

const SENTENCE_END_RE = /[.!?]["'”’)\]]*\s*$/;

/** True once `text` ends at a sentence boundary (or is empty) — safe to flush without cutting a clause. */
export function endsSentence(text: string): boolean {
  return text.trim() === "" || SENTENCE_END_RE.test(text);
}

export function appendTextSegment(segments: readonly MessageBlock[], text: string): MessageBlock[] {
  if (!text) return [...segments];
  const last = segments.at(-1);
  if (last?.kind === "text") {
    return [...segments.slice(0, -1), { kind: "text", text: last.text + text }];
  }
  return [...segments, { kind: "text", text }];
}

/**
 * Append a fully described action. The executor knows the tool, its safe summary and the
 * execution id at call time; the name-only variant below remains for older callers.
 */
export function appendToolStepToSegments(
  segments: readonly MessageBlock[],
  step: ToolActivityStep,
): MessageBlock[] {
  const last = segments.at(-1);
  const steps = appendToolActivityStep(last?.kind === "steps" ? last.steps : [], step);
  if (last?.kind === "steps") return [...segments.slice(0, -1), { ...last, steps }];
  return [...segments, { kind: "steps", steps }];
}

export function appendToolCallSegment(
  segments: readonly MessageBlock[],
  toolName: string,
): MessageBlock[] {
  const last = segments.at(-1);
  const priorSteps = last?.kind === "steps" ? last.steps : [];
  const steps = appendToolStep(priorSteps, toolName);
  if (last?.kind === "steps") {
    return [...segments.slice(0, -1), { kind: "steps", steps }];
  }
  return [...segments, { kind: "steps", steps }];
}

export function humanizeToolName(name: string): string {
  const spaced = name.replace(/_/g, " ").trim();
  if (!spaced) return name;
  const lower = spaced.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function progressMessageText(
  payload: Record<string, unknown> | undefined,
  previousText = "",
): string {
  return typeof payload?.delta === "string"
    ? previousText + payload.delta
    : String(payload?.text ?? "");
}

export function subagentBlockFromPayload(
  payload: Record<string, unknown>,
): Extract<MessageBlock, { kind: "subagent" }> {
  const status = payload.status;
  return {
    kind: "subagent",
    agentId: String(payload.agentId ?? ""),
    name: String(payload.name ?? "subagent"),
    task: String(payload.task ?? ""),
    status: status === "completed" || status === "failed" ? status : "running",
    progress: payload.progress ? String(payload.progress) : undefined,
    result: payload.result ? String(payload.result) : undefined,
  };
}

export function redactSecrets(value: string, secrets: string[]): string {
  return secrets.reduce((acc, secret) => {
    if (!secret) return acc;
    return acc.split(secret).join("[redacted]");
  }, value);
}

export function containsSecret(value: unknown, secrets: string[]): boolean {
  const active = secrets.filter((secret) => secret.length > 0);
  if (active.length === 0) return false;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return false;
  const pending: unknown[] = [JSON.parse(serialized)];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (active.some((secret) => current.includes(secret))) return true;
      continue;
    }
    if (current === null || typeof current === "number" || typeof current === "boolean") {
      const primitive = String(current);
      if (active.some((secret) => primitive.includes(secret))) return true;
      continue;
    }
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (current && typeof current === "object") {
      for (const [key, nested] of Object.entries(current)) {
        if (active.some((secret) => key.includes(secret))) return true;
        pending.push(nested);
      }
    }
  }
  return false;
}

/** UTF-16 high surrogates (0xD800–0xDBFF) must be paired with a low surrogate for valid JSON. */
const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;

function isHighSurrogate(code: number): boolean {
  return code >= HIGH_SURROGATE_START && code <= HIGH_SURROGATE_END;
}

function isLowSurrogate(code: number): boolean {
  return code >= LOW_SURROGATE_START && code <= LOW_SURROGATE_END;
}

function endsWithHighSurrogate(value: string): boolean {
  return value.length > 0 && isHighSurrogate(value.charCodeAt(value.length - 1));
}

/**
 * Replace unpaired UTF-16 surrogates so the string is safe for JSON (Postgres rejects them).
 */
export function sanitizeUtf16ForJson(value: string): string {
  let result = "";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (isHighSurrogate(code)) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : -1;
      if (isLowSurrogate(next)) {
        result += value[i]! + value[i + 1]!;
        i += 1;
      } else {
        result += "\uFFFD";
      }
    } else if (isLowSurrogate(code)) {
      result += "\uFFFD";
    } else {
      result += value[i]!;
    }
  }
  return result;
}

/** Deep-sanitize string leaves so event payloads never carry unpaired surrogates into JSON. */
export function sanitizeJsonValue<T>(value: T): T {
  if (typeof value === "string") return sanitizeUtf16ForJson(value) as T;
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonValue(item)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    const used = new Map<string, number>();
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      let safeKey = sanitizeUtf16ForJson(key);
      const seen = used.get(safeKey) ?? 0;
      used.set(safeKey, seen + 1);
      // Deterministic collision handling when sanitizing collapses distinct keys.
      if (seen > 0) safeKey = `${safeKey}#${seen + 1}`;
      out[safeKey] = sanitizeJsonValue(nested);
    }
    return out as T;
  }
  return value;
}

export function createStreamingRedactor(secrets: string[]) {
  const values = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  const maxLength = values[0]?.length ?? 0;
  let buffer = "";

  const drain = (final: boolean) => {
    let output: string;
    if (values.length === 0) {
      output = buffer;
      buffer = "";
    } else {
      const safeStartLimit = final ? buffer.length : Math.max(0, buffer.length - maxLength + 1);
      let offset = 0;
      output = "";
      while (offset < safeStartLimit) {
        const secret = values.find((value) => buffer.startsWith(value, offset));
        if (secret) {
          output += "[redacted]";
          offset += secret.length;
          continue;
        }
        const code = buffer.charCodeAt(offset);
        if (isHighSurrogate(code)) {
          const hasNext = offset + 1 < buffer.length;
          const next = hasNext ? buffer.charCodeAt(offset + 1) : -1;
          if (hasNext && isLowSurrogate(next)) {
            // Keep the pair together; hold both if the low unit is outside this drain window.
            if (!final && offset + 1 >= safeStartLimit) break;
            output += buffer[offset]! + buffer[offset + 1]!;
            offset += 2;
            continue;
          }
          if (!final && !hasNext) break; // trailing high surrogate — wait for the next chunk
        }
        output += buffer[offset];
        offset += 1;
      }
      buffer = buffer.slice(offset);
    }
    // No-secret path emits the whole buffer; hold a trailing high until the next chunk.
    if (!final && endsWithHighSurrogate(output)) {
      buffer = output.slice(-1) + buffer;
      output = output.slice(0, -1);
    }
    return sanitizeUtf16ForJson(output);
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      return drain(false);
    },
    finish() {
      return drain(true);
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
