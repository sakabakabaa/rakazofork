import { Trans } from "@lingui/react/macro";
import type { Goal } from "@rakazo/contracts";
import { Button, Input, Textarea } from "@rakazo/ui-web";
import {
  Check,
  ChevronRight,
  Circle,
  CircleAlert,
  LoaderCircle,
  Pause,
  Pencil,
  Play,
  Square,
  Target,
  Trash2,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import { rpc } from "../lib/rpc";

export function GoalProgressCard({ botId }: { botId: string }) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
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
  const save = async (patch: {
    title?: string;
    successCriteria?: string;
    stepTitles?: Array<{ stepId: string; title: string }>;
  }) => {
    if (!goal) return;
    setBusy(true);
    setError(false);
    try {
      const changed = await rpc.goals.update({
        goalId: goal.id,
        revision: goal.revision,
        ...patch,
      });
      setGoals((rows) => rows.map((row) => (row.id === changed.id ? changed : row)));
      setEditing(false);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!goal) return;
    setBusy(true);
    setError(false);
    try {
      await rpc.goals.delete({ goalId: goal.id, revision: goal.revision });
      setGoals((rows) => rows.filter((row) => row.id !== goal.id));
      setEditing(false);
      setConfirmDelete(false);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
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
  return (
    <>
      <GoalCard
        goal={goal}
        busy={busy}
        error={error}
        onControl={control}
        onEdit={() => setEditing(true)}
        onDelete={() => setConfirmDelete(true)}
      />
      {editing ? (
        <GoalEditForm
          goal={goal}
          busy={busy}
          onCancel={() => setEditing(false)}
          onSave={(patch) => void save(patch)}
        />
      ) : null}
      {confirmDelete ? (
        <GoalDeleteConfirm
          goal={goal}
          busy={busy}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => void remove()}
        />
      ) : null}
    </>
  );
}

export function GoalCard({
  goal,
  busy = false,
  error = false,
  onControl,
  onEdit,
  onDelete,
}: {
  goal: Goal;
  busy?: boolean;
  error?: boolean;
  onControl: (action: "pause" | "resume" | "stop") => void;
  onEdit?: () => void;
  onDelete?: () => void;
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
      <div className="mt-1 flex flex-wrap gap-1">
        {onEdit ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={onEdit}>
            <Pencil size={12} />
            <Trans>Edit goal</Trans>
          </Button>
        ) : null}
        {onDelete ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={onDelete}>
            <Trash2 size={12} className="text-destructive" />
            <Trans>Delete goal</Trans>
          </Button>
        ) : null}
      </div>
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

/**
 * Rewriting a goal's wording. Step titles can change, but their status and evidence stay
 * untouched: they are the agent's record of what it actually verified.
 */
function GoalEditForm({
  goal,
  busy,
  onCancel,
  onSave,
}: {
  goal: Goal;
  busy: boolean;
  onCancel: () => void;
  onSave: (patch: {
    title?: string;
    successCriteria?: string;
    stepTitles?: Array<{ stepId: string; title: string }>;
  }) => void;
}) {
  const inputPrefix = useId();
  const [title, setTitle] = useState(goal.title);
  const [successCriteria, setSuccessCriteria] = useState(goal.successCriteria);
  const [stepTitles, setStepTitles] = useState(() =>
    goal.steps.map((step) => ({ id: step.id, title: step.title })),
  );
  const trimmedTitle = title.trim();
  const trimmedCriteria = successCriteria.trim();
  const changedSteps = stepTitles
    .map((step) => ({ stepId: step.id, title: step.title.trim() }))
    .filter(
      (step) => step.title !== goal.steps.find((original) => original.id === step.stepId)?.title,
    );
  const dirty =
    trimmedTitle !== goal.title ||
    trimmedCriteria !== goal.successCriteria ||
    changedSteps.length > 0;
  const valid =
    trimmedTitle.length > 0 &&
    trimmedCriteria.length > 0 &&
    stepTitles.every((step) => step.title.trim().length > 0) &&
    dirty;
  return (
    <form
      className="mx-3 mt-2 rounded-xl border-border bg-card px-3 py-2 md:mx-6"
      data-testid="goal-edit-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || busy) return;
        onSave({
          ...(trimmedTitle !== goal.title ? { title: trimmedTitle } : {}),
          ...(trimmedCriteria !== goal.successCriteria ? { successCriteria: trimmedCriteria } : {}),
          ...(changedSteps.length > 0 ? { stepTitles: changedSteps } : {}),
        });
      }}
    >
      <div className="block text-sm">
        <label htmlFor={`${inputPrefix}-title`} className="text-muted-foreground">
          <Trans>Title</Trans>
        </label>
        <Input
          id={`${inputPrefix}-title`}
          value={title}
          maxLength={200}
          onChange={(event) => setTitle(event.target.value)}
          className="mt-1 h-8"
        />
      </div>
      <div className="mt-2 block text-sm">
        <label htmlFor={`${inputPrefix}-criteria`} className="text-muted-foreground">
          <Trans>Success criteria</Trans>
        </label>
        <Textarea
          id={`${inputPrefix}-criteria`}
          value={successCriteria}
          maxLength={2000}
          onChange={(event) => setSuccessCriteria(event.target.value)}
          className="mt-1 min-h-20"
        />
      </div>
      <fieldset className="mt-3 space-y-2">
        <legend className="text-sm text-muted-foreground">
          <Trans>Steps</Trans>
        </legend>
        {stepTitles.map((step, index) => {
          const id = `${inputPrefix}-step-${step.id}`;
          return (
            <div key={step.id} className="block text-sm">
              <label htmlFor={id} className="sr-only">
                <Trans>Step {index + 1}</Trans>
              </label>
              <Input
                id={id}
                value={step.title}
                maxLength={200}
                onChange={(event) =>
                  setStepTitles((rows) =>
                    rows.map((row) =>
                      row.id === step.id ? { ...row, title: event.target.value } : row,
                    ),
                  )
                }
                className="h-8"
              />
            </div>
          );
        })}
      </fieldset>
      <div className="mt-2 flex justify-end gap-1">
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" size="sm" disabled={!valid || busy}>
          <Trans>Save</Trans>
        </Button>
      </div>
    </form>
  );
}

function GoalDeleteConfirm({
  goal,
  busy,
  onCancel,
  onConfirm,
}: {
  goal: Goal;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      role="alertdialog"
      aria-label="Delete goal"
      className="mx-3 mt-2 rounded-xl border-border bg-card px-3 py-2 md:mx-6"
      data-testid="goal-delete-confirm"
    >
      <p className="text-sm">
        <Trans>Delete this goal? This cannot be undone.</Trans>
      </p>
      <p className="mt-1 break-words text-xs text-muted-foreground">{goal.title}</p>
      <div className="mt-2 flex justify-end gap-1">
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
        <Button size="sm" variant="destructive" disabled={busy} onClick={onConfirm}>
          <Trans>Delete</Trans>
        </Button>
      </div>
    </div>
  );
}
