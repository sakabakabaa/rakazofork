import { Plural } from "@lingui/react/macro";
import type { ThreadMessage } from "@rakazo/contracts";
import {
  Bot,
  Check,
  ChevronRight,
  FileText,
  Globe,
  LoaderCircle,
  type LucideIcon,
  Mail,
  MessageSquare,
  MousePointer2,
  Pencil,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import type { ReactNode } from "react";
import { formatToolActivityDuration } from "../lib/tool-activity-view";

type ToolStep = Extract<ThreadMessage["blocks"][number], { kind: "steps" }>["steps"][number];

function toolIcon(label: string): LucideIcon {
  const name = label.toLowerCase();
  if (name.includes("search")) return Search;
  if (name.includes("browser") || name.includes("web fetch") || name.includes("navigate")) {
    return Globe;
  }
  if (name.includes("shell") || name.includes("terminal") || name.includes("command")) {
    return Terminal;
  }
  if (name.includes("file") || name.includes("read") || name.includes("write")) return FileText;
  if (name.includes("edit") || name.includes("update")) return Pencil;
  if (name.includes("click") || name.includes("computer")) return MousePointer2;
  if (name.includes("mail") || name.includes("email")) return Mail;
  if (name.includes("message") || name.includes("slack") || name.includes("whatsapp")) {
    return MessageSquare;
  }
  if (name.includes("agent") || name.includes("subagent")) return Bot;
  return Wrench;
}

export function ToolSteps({
  steps,
  currentIndex,
  limit,
}: {
  steps: readonly ToolStep[];
  currentIndex?: number;
  /** Show only the last `limit` steps, with a count of the earlier ones above them. */
  limit?: number;
}) {
  const actions = steps.flatMap((step, index) =>
    Array.from({ length: Math.max(1, step.count) }, (_, occurrence) => ({
      step,
      index,
      occurrence,
    })),
  );
  const hidden = limit !== undefined && actions.length > limit ? actions.length - limit : 0;
  const shown = hidden > 0 ? actions.slice(hidden) : actions;
  return (
    <div className="space-y-0.5" data-testid="tool-rows">
      {hidden > 0 ? (
        <div className="text-[12px] leading-5 text-muted-foreground" data-testid="tool-rows-hidden">
          <Plural value={hidden} one="+# earlier step" other="+# earlier steps" />
        </div>
      ) : null}
      {shown.map(({ step, index, occurrence }) => {
        const isCurrent = index === currentIndex && occurrence === step.count - 1;
        const Icon = toolIcon(step.label);
        return (
          <div
            key={`${index}-${occurrence}`}
            className="flex min-w-0 items-start gap-2 leading-5"
            data-testid="tool-action"
          >
            {isCurrent ? (
              <LoaderCircle
                aria-hidden
                size={13}
                className="shrink-0 animate-spin text-warning motion-reduce:animate-none"
              />
            ) : (
              <Check aria-hidden size={13} className="shrink-0 text-success" />
            )}
            <Icon aria-hidden size={13} className="shrink-0 text-muted-foreground" />
            <span
              className={`min-w-0 flex-1 whitespace-normal break-words [overflow-wrap:anywhere] text-[13px] ${
                isCurrent ? "text-foreground" : "text-muted-foreground"
              }`}
              title={step.label}
            >
              {step.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * One compact latest-action line. The full chronological action list stays collapsed by
 * default, and a manual expansion stays open as live actions arrive.
 */
export function ToolActivityDisclosure({
  live,
  latestAction,
  durationMs,
  children,
}: {
  live: boolean;
  latestAction?: string;
  durationMs?: number;
  children: ReactNode;
}) {
  const duration = formatToolActivityDuration(durationMs);
  const latest = latestAction?.trim() || "Tool activity";
  const ActionIcon = toolIcon(latest);
  return (
    <details data-testid="tool-activity" data-live={live || undefined} className="group">
      <summary
        className={`flex min-h-7 w-full max-w-full flex-wrap cursor-pointer list-none items-start gap-x-1.5 gap-y-0.5 rounded-md py-0.5 pe-1.5 text-[13px] font-medium outline-none hover:text-foreground/75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
          live ? "text-foreground/75" : "text-muted-foreground"
        }`}
      >
        <span className="flex min-w-[min(8rem,100%)] flex-1 items-start gap-1.5">
          <ChevronRight
            aria-hidden
            size={14}
            strokeWidth={1.8}
            className="shrink-0 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none"
          />
          {live ? (
            <LoaderCircle
              aria-hidden
              size={13}
              className="mt-0.5 shrink-0 animate-spin text-warning motion-reduce:animate-none"
            />
          ) : (
            <ActionIcon aria-hidden size={13} className="mt-0.5 shrink-0 text-muted-foreground" />
          )}
          <span
            className="min-w-0 flex-1 whitespace-normal break-words [overflow-wrap:anywhere]"
            data-testid="tool-latest-action"
          >
            {latest}
          </span>
        </span>
        {live ? (
          <span className="ms-auto shrink-0 text-muted-foreground">· Working</span>
        ) : (
          <span className="ms-auto shrink-0 text-muted-foreground">
            · Done{duration ? ` · ${duration}` : ""}
          </span>
        )}
      </summary>
      <div className="ms-[7px] mt-0.5 w-[calc(100%-7px)] border-s border-border ps-3">
        {children}
      </div>
    </details>
  );
}

/**
 * A tools-only message: a plain muted line between messages, not a chat bubble.
 */
export function StandaloneToolActivity({
  live,
  active = live,
  steps,
  latestAction,
  durationMs,
}: {
  live: boolean;
  active?: boolean;
  steps: readonly ToolStep[];
  latestAction?: string;
  durationMs?: number;
}) {
  return (
    <div className="flex justify-start" dir="ltr" data-testid="tool-activity-line">
      <div className="w-full max-w-full min-w-0 ps-1">
        <ToolActivityDisclosure
          live={live}
          latestAction={latestAction ?? steps.at(-1)?.label}
          durationMs={durationMs}
        >
          <ToolSteps steps={steps} currentIndex={active ? steps.length - 1 : undefined} />
        </ToolActivityDisclosure>
      </div>
    </div>
  );
}

/** A bot message whose only visible blocks are tool activity: one slim line, no bubble. */
export function ToolOnlyNarration({
  blocks,
  live,
}: {
  blocks: readonly ThreadMessage["blocks"][number][];
  live: boolean;
}) {
  const actionBlocks = blocks.filter(
    (block): block is Extract<ThreadMessage["blocks"][number], { kind: "steps" }> =>
      block.kind === "steps",
  );
  const steps = actionBlocks.flatMap((block) => block.steps);
  const liveAction = blocks.findLast(
    (block) => block.kind === "progress" && block.activity === true && block.text.trim(),
  );
  const visibleSteps =
    liveAction?.kind === "progress" ? [...steps, { label: liveAction.text, count: 1 }] : steps;
  if (visibleSteps.length === 0) return null;
  const durationMs = actionBlocks.reduce((total, block) => total + (block.durationMs ?? 0), 0);
  return (
    <StandaloneToolActivity
      live={live}
      active={liveAction?.kind === "progress"}
      steps={visibleSteps}
      latestAction={liveAction?.kind === "progress" ? liveAction.text : undefined}
      durationMs={durationMs || undefined}
    />
  );
}
