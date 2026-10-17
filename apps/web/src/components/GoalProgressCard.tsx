import { Trans } from "@lingui/react/macro";
import type { Goal } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import {
  Check,
  ChevronRight,
  Circle,
  CircleAlert,
  LoaderCircle,
  Pause,
  Play,
  Square,
  Target,
} from "lucide-react";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

export function GoalProgressCard({ botId }: { botId: string }) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let disposed = false;
    let loading = false;
    const refresh = async () => {
      if (loading || document.visibilityState === "hidden") return;
      loading = true;
      try {
        const rows = await rpc.goals.list({ botId }, { signal: AbortSignal.timeout(8000) });
        if (!disposed) {
          setGoals(rows);
          setError(false);
        }
      } catch {
        if (!disposed) setError(true);
      } finally {
        loading = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [botId]);
  const goal =
    goals.find((goal) => ["active", "paused", "blocked"].includes(goal.status)) ?? goals[0];
  if (!goal) return null;
  const control = async (action: "pause" | "resume" | "stop") => {
    setBusy(true);
    setError(false);
    try {
      const changed = await rpc.goals.control({ goalId: goal.id, revision: goal.revision, action });
      setGoals((rows) => rows.map((row) => (row.id === changed.id ? changed : row)));
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return <GoalCard goal={goal} busy={busy} error={error} onControl={control} />;
}

export function GoalCard({
  goal,
  busy = false,
  error = false,
  onControl,
}: {
  goal: Goal;
  busy?: boolean;
  error?: boolean;
  onControl: (action: "pause" | "resume" | "stop") => void;
}) {
  const completed = goal.steps.filter((step) => step.status === "done").length;
  const current = goal.steps.find((step) =>
    ["working", "verifying", "blocked"].includes(step.status),
  );
  const ended = ["completed", "stopped"].includes(goal.status);
  return (
    <section
      className="w-full min-w-0 shrink-0 px-3 pt-2 md:px-6"
      aria-label="Goal progress"
      data-testid="goal-progress"
    >
      <details className="group rounded-xl border border-border bg-card px-3 py-2">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <ChevronRight size={14} aria-hidden className="shrink-0 group-open:rotate-90" />
          <Target size={15} aria-hidden className="shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 break-words font-medium">{goal.title}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {completed}/{goal.steps.length}
          </span>
          <span className="text-xs text-muted-foreground">{goal.status}</span>
        </summary>
        <progress
          className="mt-2 h-1 w-full accent-primary"
          value={completed}
          max={goal.steps.length}
          aria-label="Verified steps"
        />
        <div className="max-h-[min(50vh,24rem)] overflow-y-auto">
          <p className="mt-2 text-xs text-muted-foreground">{goal.successCriteria}</p>
          <ol className="mt-3 space-y-2">
            {goal.steps.map((step) => {
              const Icon =
                step.status === "done"
                  ? Check
                  : step.status === "working" || step.status === "verifying"
                    ? LoaderCircle
                    : step.status === "blocked"
                      ? CircleAlert
                      : Circle;
              return (
                <li
                  key={step.id}
                  className="flex items-start gap-2 text-sm"
                  data-step-status={step.status}
                >
                  <Icon
                    aria-hidden
                    size={14}
                    className={`mt-1 shrink-0 ${step.status === "done" ? "text-success" : step.status === "blocked" ? "text-warning" : "text-muted-foreground"} ${step.status === "working" ? "animate-spin motion-reduce:animate-none" : ""}`}
                  />
                  <div className="min-w-0 flex-1">
                    <span className="break-words">{step.title}</span>
                    <span className="ms-2 text-xs text-muted-foreground">{step.status}</span>
                    {step.evidence ? (
                      <details className="mt-1 text-xs text-muted-foreground">
                        <summary className="cursor-pointer">
                          <Trans>Verification</Trans>
                        </summary>
                        <p className="mt-1 whitespace-pre-wrap break-words">{step.evidence}</p>
                      </details>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
          {goal.checkpoint ? (
            <details className="mt-3 text-xs text-muted-foreground">
              <summary className="cursor-pointer">
                <Trans>Task checkpoint</Trans>
              </summary>
              <p className="mt-1 whitespace-pre-wrap break-words">{goal.checkpoint}</p>
            </details>
          ) : null}
        </div>
      </details>
      {current && !ended ? (
        <p className="mt-1 break-words text-xs text-muted-foreground" title={current.title}>
          {current.status}: {current.title}
        </p>
      ) : null}
      {!ended ? (
        <div className="mt-1 flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => onControl(goal.status === "active" ? "pause" : "resume")}
          >
            {goal.status === "active" ? (
              <>
                <Pause size={12} />
                <Trans>Pause goal</Trans>
              </>
            ) : (
              <>
                <Play size={12} />
                <Trans>Resume goal</Trans>
              </>
            )}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onControl("stop")}>
            <Square size={12} />
            <Trans>Stop goal</Trans>
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-1 text-xs text-destructive">
          <Trans>Could not refresh goal. Try again.</Trans>
        </p>
      ) : null}
    </section>
  );
}
