import type { MessageBlock, ThreadMessage } from "@rakazo/contracts";
import { isToolActivityBlock } from "@rakazo/core";

type ToolStep = Extract<MessageBlock, { kind: "steps" }>['steps'][number];

export type RunToolActivity = {
  steps: ToolStep[];
  durationMs: number;
  latestMessageId: string;
};

/** Collect a run's chronological tool history, including calls split across messages. */
export function toolActivityByRun(
  messages: readonly Pick<ThreadMessage, "id" | "role" | "runId" | "blocks">[],
): Map<string, RunToolActivity> {
  const activity = new Map<string, RunToolActivity>();
  for (const message of messages) {
    if (message.role !== "bot" || !message.runId) continue;
    const hasActivity = message.blocks.some(
      (block) =>
        block.kind === "steps" || (block.kind === "progress" && block.activity === true),
    );
    if (!hasActivity) continue;

    const current = activity.get(message.runId) ?? {
      steps: [],
      durationMs: 0,
      latestMessageId: message.id,
    };
    for (const block of message.blocks) {
      if (block.kind !== "steps") continue;
      current.steps.push(...block.steps);
      current.durationMs += block.durationMs ?? 0;
    }
    current.latestMessageId = message.id;
    activity.set(message.runId, current);
  }
  return activity;
}

/**
 * Compact human duration for a tool-activity card summary.
 * Returns null when there is no usable duration (missing, non-finite or negative),
 * so the caller can omit the segment entirely.
 */
export function formatToolActivityDuration(durationMs: number | null | undefined): string | null {
  if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 0) return null;
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 10_000) {
    const seconds = Math.round(durationMs / 100) / 10;
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
  }
  if (durationMs < 60_000) return `${Math.round(durationMs / 1000)}s`;
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** Number of tool calls behind a steps block: the sum of each row's count. */
export function toolStepCount(steps: readonly { count: number }[]): number {
  return steps.reduce((total, step) => total + step.count, 0);
}

/**
 * Completed steps and live tool progress render only when tool activity is enabled.
 */
export function shouldRenderToolCard(
  block: MessageBlock,
  showToolActivity: boolean,
  live = false,
): boolean {
  return (
    showToolActivity &&
    (block.kind === "steps" || (live && block.kind === "progress" && block.activity === true))
  );
}

/** Blocks that survive into a message render: everything except hidden tool activity. */
export function renderableMessageBlocks(
  blocks: readonly MessageBlock[],
  showToolActivity: boolean,
  live = false,
): MessageBlock[] {
  return blocks.filter(
    (block) => !isToolActivityBlock(block) || shouldRenderToolCard(block, showToolActivity, live),
  );
}

/**
 * True when a bot message's only visible blocks are tool cards, such as a live run that
 * has called tools but not written anything yet. Such a message renders as slim lines
 * between messages instead of inside a chat bubble.
 */
export function isToolOnlyNarration(
  blocks: readonly MessageBlock[],
  showToolActivity: boolean,
  live = false,
): boolean {
  const visible = renderableMessageBlocks(blocks, showToolActivity, live);
  return visible.length > 0 && visible.every(isToolActivityBlock);
}

/** True when a message still has at least one block to show under the preference. */
export function messageHasVisibleBlocks(
  blocks: readonly MessageBlock[],
  showToolActivity: boolean,
  live = false,
): boolean {
  return blocks.some(
    (block) => !isToolActivityBlock(block) || shouldRenderToolCard(block, showToolActivity, live),
  );
}
