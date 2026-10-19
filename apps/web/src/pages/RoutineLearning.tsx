import { Trans, useLingui } from "@lingui/react/macro";
import type { RoutineGuidance, RoutineLearning as RoutineLearningData } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { History, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

/**
 * Review and rollback controls for a routine's learned guidance.
 *
 * Shows what the routine currently follows, why it changed, which run produced it, and every
 * earlier version so a change can be undone. Activation is always explicit here: the routine
 * itself can only propose.
 */
export function RoutineLearning({ routineId }: { routineId: string }) {
  const { t } = useLingui();
  const [data, setData] = useState<RoutineLearningData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await rpc.routines.learning({ routineId }));
    } catch {
      setError(t`Could not load learned guidance.`);
    }
  }, [routineId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<RoutineLearningData>) => {
    setBusy(true);
    setError(null);
    try {
      setData(await action());
    } catch {
      setError(t`That change did not apply.`);
    } finally {
      setBusy(false);
    }
  };

  const active = data?.active ?? null;
  const pending = data?.versions.filter((row) => row.status === "proposed") ?? [];
  const history = data?.versions.filter((row) => row.status !== "proposed") ?? [];
  const state = data?.state ?? null;

  return (
    <div className="mt-5 border-t border-border pt-4 text-sm text-muted-foreground">
      <div className="flex items-baseline justify-between gap-2">
        <Trans>Learned guidance</Trans>
        {active ? (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => void run(() => rpc.routines.disableGuidance({ routineId }))}
          >
            <Trans>Turn off</Trans>
          </Button>
        ) : null}
      </div>

      {active ? (
        <div className="mt-2 rounded-md border border-border p-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs text-muted-foreground/70">
              {t`Version ${active.version}`}
            </span>
            {active.sourceRunId ? (
              <span className="text-xs text-muted-foreground/70">{t`From a previous run`}</span>
            ) : null}
          </div>
          <p className="mt-1 text-foreground">{active.text}</p>
          {active.reason ? <p className="mt-1 text-xs">{active.reason}</p> : null}
          <p className="mt-2 text-xs text-muted-foreground/70">
            <Trans>
              Guidance is subordinate to your instruction and done condition. It never changes
              what the routine is allowed to do.
            </Trans>
          </p>
        </div>
      ) : (
        <p className="mt-2">
          <Trans>
            No learned guidance. The routine runs on your instruction alone.
          </Trans>
        </p>
      )}

      {state?.unresolvedIssue ? (
        <p className="mt-3 text-xs text-warning">
          <Trans>Unresolved from a previous run:</Trans> {state.unresolvedIssue}
        </p>
      ) : null}
      {state?.checkpoint ? (
        <p className="mt-1 text-xs">
          <Trans>Last verified checkpoint:</Trans>{" "}
          <code className="text-[11px]">{JSON.stringify(state.checkpoint)}</code>
        </p>
      ) : null}

      {pending.length > 0 ? (
        <div className="mt-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground/70">
            <Trans>Waiting for your review</Trans>
          </p>
          {pending.map((row) => (
            <div key={row.version} className="mt-2 rounded-md border border-border p-3">
              <p className="text-foreground">{row.text}</p>
              {row.reason ? <p className="mt-1 text-xs">{row.reason}</p> : null}
              <div className="mt-2 flex gap-2">
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      rpc.routines.guidance({
                        routineId,
                        version: row.version,
                        action: "activate",
                      }),
                    )
                  }
                >
                  <Trans>Approve</Trans>
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      rpc.routines.guidance({
                        routineId,
                        version: row.version,
                        action: "reject",
                      }),
                    )
                  }
                >
                  <Trans>Dismiss</Trans>
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {history.length > 0 ? (
        <div className="mt-4">
          <p className="flex items-center gap-1 text-xs uppercase tracking-wide text-muted-foreground/70">
            <History className="size-3" aria-hidden />
            <Trans>History</Trans>
          </p>
          {history.map((row) => (
            <VersionRow
              key={row.version}
              row={row}
              busy={busy}
              onRestore={() =>
                void run(() =>
                  rpc.routines.guidance({ routineId, version: row.version, action: "activate" }),
                )
              }
            />
          ))}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function VersionRow({
  row,
  busy,
  onRestore,
}: {
  row: RoutineGuidance;
  busy: boolean;
  onRestore: () => void;
}) {
  const { t } = useLingui();
  const isActive = row.status === "active";
  return (
    <div className="mt-2 flex items-start justify-between gap-2 border-b border-border/50 pb-2">
      <div className="min-w-0">
        <p className={isActive ? "text-foreground" : "line-through decoration-1"}>
          {row.text}
        </p>
        <p className="text-xs text-muted-foreground/70">
          {t`Version ${row.version}`} · {statusLabel(row.status, t)}
        </p>
      </div>
      {!isActive && row.status !== "proposed" ? (
        <Button variant="ghost" disabled={busy} onClick={onRestore}>
          <RotateCcw className="size-3" aria-hidden />
          <Trans>Restore</Trans>
        </Button>
      ) : null}
    </div>
  );
}

function statusLabel(status: RoutineGuidance["status"], t: (value: string) => string): string {
  switch (status) {
    case "active":
      return t`Active`;
    case "rejected":
      return t`Dismissed`;
    case "rolled_back":
      return t`Replaced`;
    case "disabled":
      return t`Turned off`;
    default:
      return t`Proposed`;
  }
}
