import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { ThreadMessage, ToolActivityStatus, ToolActivityStep } from "@rakazo/contracts";
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
  Pause,
  Pencil,
  Search,
  Target,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { formatToolActivityDuration } from "../lib/tool-activity-view";
import { ToolDiffView } from "./ToolActivityDiff";

type ToolStep = ToolActivityStep;

/** Prefer the raw tool name; fall back to the label for rows stored before `tool` existed. */
function toolIcon(name: string | undefined): LucideIcon {
  const key = (name ?? "").toLowerCase();
  if (key.includes("goal")) return Target;
  if (key.includes("search")) return Search;
  if (key.includes("browser") || key.includes("web fetch") || key.includes("navigate")) {
    return Globe;
  }
  if (key.includes("shell") || key.includes("terminal") || key.includes("command")) {
    return Terminal;
  }
  if (key.includes("file") || key.includes("read") || key.includes("write")) return FileText;
  if (key.includes("edit") || key.includes("update")) return Pencil;
  if (key.includes("click") || key.includes("computer")) return MousePointer2;
  if (key.includes("mail") || key.includes("email")) return Mail;
  if (key.includes("message") || key.includes("slack") || key.includes("whatsapp")) {
    return MessageSquare;
  }
  if (key.includes("agent") || key.includes("subagent")) return Bot;
  return Wrench;
}

const STATUS_TONE: Record<ToolActivityStatus, string> = {
  running: "text-warning",
  succeeded: "text-success",
  failed: "text-destructive",
  paused: "text-warning",
  interrupted: "text-warning",
};

/**
 * One action's status, kept as its own element so the row text stays plain and the state is
 * announced separately. A row stored without a status renders nothing here: an action that
 * never reported back is not a success.
 */
function StepStatus({ status }: { status: ToolActivityStatus }) {
  const { t } = useLingui();
  const Icon =
    status === "succeeded"
      ? Check
      : status === "failed"
        ? X
        : status === "running"
          ? LoaderCircle
          : Pause;
  const label =
    status === "succeeded"
      ? t`Succeeded`
      : status === "failed"
        ? t`Failed`
        : status === "running"
          ? t`Running`
          : t`Waiting`;
  return (
    <span
      data-testid="tool-activity-status"
      role="img"
      aria-label={label}
      className="mt-0.5 shrink-0"
    >
      <Icon
        aria-hidden
        size={13}
        className={`${STATUS_TONE[status]} ${
          status === "running" ? "animate-spin motion-reduce:animate-none" : ""
        }`}
      />
    </span>
  );
}

function ToolStepRow({ step, isCurrent }: { step: ToolStep; isCurrent: boolean }) {
  const Icon = toolIcon(step.tool ?? step.label);
  const status = step.status ?? (isCurrent ? "running" : undefined);
  const error = status === "failed" ? step.error?.trim() : undefined;
  const active = status === "running" || status === "failed";
  return (
    <li className="min-w-0" data-testid="tool-activity-step">
      <div className="flex min-w-0 items-start gap-2 leading-5">
        <Icon aria-hidden size={13} className="mt-0.5 shrink-0 text-muted-foreground" />
        <span
          className={`min-w-0 flex-1 whitespace-normal break-words [overflow-wrap:anywhere] text-[13px] ${
            active ? "text-foreground" : "text-muted-foreground"
          }`}
          title={step.label}
        >
          {step.label}
          {step.summary ? <span className="text-muted-foreground"> · {step.summary}</span> : null}
          {step.count > 1 ? (
            <span className="ms-1 shrink-0 text-muted-foreground/80">×{step.count}</span>
          ) : null}
        </span>
        {status ? <StepStatus status={status} /> : null}
      </div>
      {error ? (
        <p className="ms-[21px] mt-0.5 whitespace-normal break-words [overflow-wrap:anywhere] text-[12px] leading-4 text-muted-foreground">
          {error}
        </p>
      ) : null}
      {step.diff ? (
        <div className="ms-[21px]">
          <ToolDiffView diff={step.diff} />
        </div>
      ) : null}
    </li>
  );
}

/**
 * The run's full chronological timeline. Every action stays listed, including the ones that
 * already finished, so an expansion never loses history.
 */
export function ToolSteps({
  steps,
  currentIndex,
}: {
  steps: readonly ToolStep[];
  /** Index of the action still in flight, for rows stored before statuses existed. */
  currentIndex?: number;
}) {
  return (
    <ul className="space-y-0.5" data-testid="tool-rows">
      {steps.map((step, index) => (
        <ToolStepRow key={step.id ?? index} step={step} isCurrent={index === currentIndex} />
      ))}
    </ul>
  );
}

type CollapsedState =
  | { kind: "live" }
  | { kind: "failed"; label: string; interrupted: boolean }
  | { kind: "paused" }
  | { kind: "done"; count: number }
  | { kind: "legacy" };

/**
 * One compact latest-action line. The full chronological action list stays collapsed by
 * default, and a manual expansion stays open as live actions arrive.
 */
export function ToolActivityDisclosure({
  live,
  latestAction,
  durationMs,
  steps,
  children,
}: {
  live: boolean;
  latestAction?: string;
  durationMs?: number;
  /** The timeline the rows show; the collapsed line reads its count and outcome. */
  steps?: readonly ToolStep[];
  children: ReactNode;
}) {
  const timeline = steps ?? [];
  const failure = live
    ? undefined
    : timeline.findLast((step) => step.status === "failed" || step.status === "interrupted");
  const paused = !live && !failure && timeline.some((step) => step.status === "paused");
  const count = timeline.reduce((total, step) => total + Math.max(1, step.count), 0);
  const state: CollapsedState = live
    ? { kind: "live" }
    : failure
      ? {
          kind: "failed",
          label: failure.label,
          interrupted: failure.status === "interrupted",
        }
      : paused
        ? { kind: "paused" }
        : steps
          ? { kind: "done", count }
          : { kind: "legacy" };
  const duration = formatToolActivityDuration(durationMs);
  const failed = state.kind === "failed";
  const latest = (failed ? state.label : latestAction?.trim()) || "Tool activity";
  const ActionIcon =
    state.kind === "failed" ? X : state.kind === "paused" ? Pause : toolIcon(latest);
  return (
    <details data-testid="tool-activity" data-live={live || undefined} className="group">
      <summary
        className={`flex min-h-7 w-full max-w-full flex-wrap cursor-pointer list-none items-start gap-x-1.5 gap-y-0.5 rounded-md py-0.5 pe-1.5 text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
          failed
            ? "text-destructive hover:text-destructive/80"
            : live
              ? "text-foreground/75 hover:text-foreground"
              : "text-muted-foreground hover:text-foreground/75"
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
            <ActionIcon
              aria-hidden
              size={13}
              className={`mt-0.5 shrink-0 ${
                failed
                  ? "text-destructive"
                  : state.kind === "paused"
                    ? "text-warning"
                    : "text-muted-foreground"
              }`}
            />
          )}
          <span
            className="min-w-0 flex-1 whitespace-normal break-words [overflow-wrap:anywhere]"
            data-testid="tool-latest-action"
          >
            {latest}
          </span>
        </span>
        <span
          className={`ms-auto shrink-0 ${failed ? "text-destructive" : "text-muted-foreground"}`}
        >
          ·{" "}
          {state.kind === "live" ? (
            <Trans>Working</Trans>
          ) : state.kind === "failed" ? (
            state.interrupted ? (
              <Trans>Interrupted</Trans>
            ) : (
              <Trans>Failed</Trans>
            )
          ) : state.kind === "paused" ? (
            <Trans>Waiting</Trans>
          ) : state.kind === "done" ? (
            <Plural value={state.count} one="Completed # action" other="Completed # actions" />
          ) : (
            <Trans>Done</Trans>
          )}
          {state.kind === "live" || state.kind === "failed" || !duration ? null : ` · ${duration}`}
        </span>
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
          steps={steps}
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
  const visibleSteps: ToolStep[] =
    liveAction?.kind === "progress"
      ? [
          ...steps,
          {
            label: liveAction.text,
            count: 1,
            ...(live ? { status: "running" as const } : {}),
          },
        ]
      : steps;
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
