import { Trans } from "@lingui/react/macro";
import type { ComputerCommand } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { Check, ChevronRight, Code, FileText, LoaderCircle, Terminal, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  applyComputerCommandHistory,
  capComputerCommands,
  mergeComputerCommand,
  subscribeComputerCommands,
} from "../lib/computer-workspace";
import { rpc } from "../lib/rpc";

export function CoderPanel({ botId, onStop }: { botId: string; onStop: () => Promise<void> }) {
  const [commands, setCommands] = useState<ComputerCommand[]>([]);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let cancelled = false;
    let pending: ComputerCommand[] = [];
    let inFlight = false;
    const unsubscribe = subscribeComputerCommands((id, command) => {
      if (id !== botId || !command.coder) return;
      pending = capComputerCommands(mergeComputerCommand(pending, command));
      setCommands((previous) => capComputerCommands(mergeComputerCommand(previous, command)));
    });
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const history = await rpc.computer.commands(
          { botId },
          { signal: AbortSignal.timeout(10000) },
        );
        if (!cancelled) {
          setCommands(
            applyComputerCommandHistory(
              history.filter((c) => c.coder),
              pending,
            ),
          );
          pending = [];
          setError(false);
        }
      } catch {
        if (!cancelled) setError(true);
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const timer = setInterval(() => {
      setNow(Date.now());
      void refresh();
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      unsubscribe();
    };
  }, [botId]);
  const command = commands.at(-1);
  const coder = command?.coder;
  const running = command?.status === "running";
  const elapsed = coder
    ? Math.max(
        0,
        Math.floor(
          ((coder.finishedAt ? Date.parse(coder.finishedAt) : now) - Date.parse(coder.startedAt)) /
            1000,
        ),
      )
    : 0;
  return (
    <section
      aria-label="Coder activity"
      className="my-5 rounded-xl border border-border bg-card p-3 text-sm"
      data-testid="coder-panel"
    >
      <div className="flex items-center gap-2">
        <Code size={16} aria-hidden />
        <span className="font-medium">
          <Trans>Coder</Trans>
          {coder ? " · DSH" : ""}
        </span>
        {coder ? <span className="ml-auto text-xs text-muted-foreground">{elapsed}s</span> : null}
        {running ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={stopping}
            onClick={async () => {
              setStopping(true);
              try {
                await onStop();
              } finally {
                setStopping(false);
              }
            }}
          >
            <Trans>Stop run</Trans>
          </Button>
        ) : null}
      </div>
      {!coder ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {error ? (
            <Trans>Could not load coder activity.</Trans>
          ) : (
            <Trans>No coder runs yet.</Trans>
          )}
        </p>
      ) : (
        <>
          <details className="mt-2 break-words text-xs text-muted-foreground">
            <summary className="cursor-pointer">
              {coder.task.slice(0, 100)}
              {coder.task.length > 100 ? "…" : ""}
            </summary>
            <p className="mt-2">{coder.task}</p>
          </details>
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
            className="mt-3 flex w-full items-start gap-2 text-left"
          >
            <ChevronRight
              size={14}
              className={expanded ? "mt-0.5 shrink-0 rotate-90" : "mt-0.5 shrink-0"}
            />
            {running ? (
              <LoaderCircle size={14} className="mt-0.5 shrink-0 animate-spin" />
            ) : command.exitCode === 0 ? (
              <Check size={14} className="mt-0.5 shrink-0 text-success" />
            ) : (
              <X size={14} className="mt-0.5 shrink-0 text-destructive" />
            )}
            <span className="min-w-0 break-words">
              {running
                ? coder.phase
                : command.exitCode === 0
                  ? "Finished"
                  : command.exitCode === 130
                    ? "Stopped"
                    : "Failed"}
            </span>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
              {coder.actions.length}
            </span>
          </button>
          {error ? (
            <p className="mt-2 text-xs text-destructive">
              <Trans>Reconnecting…</Trans>
            </p>
          ) : null}
          {expanded ? (
            <div className="mt-3 max-h-80 space-y-2 overflow-y-auto border-t border-border pt-3">
              {coder.actions.map((action) => (
                <details key={action.id} className="text-xs">
                  <summary className="flex cursor-pointer items-start gap-2">
                    {action.status === "running" ? (
                      <LoaderCircle size={13} className="shrink-0 animate-spin" />
                    ) : action.tool === "bash" ? (
                      <Terminal size={13} className="shrink-0" />
                    ) : (
                      <FileText size={13} className="shrink-0" />
                    )}
                    <span className="min-w-0 break-words">{action.label}</span>
                    <span className="ml-auto shrink-0 text-muted-foreground">
                      {command.exitCode === 130 && action.status === "failed"
                        ? "stopped"
                        : action.status}
                    </span>
                  </summary>
                  {action.output ? (
                    <pre className="mt-2 whitespace-pre-wrap break-words rounded bg-muted p-2">
                      {action.output}
                    </pre>
                  ) : null}
                </details>
              ))}
              {coder.text ? (
                <p className="whitespace-pre-wrap break-words border-t border-border pt-2">
                  {coder.text}
                </p>
              ) : null}
              {command.status === "done" &&
              command.exitCode !== 0 &&
              command.exitCode !== 130 &&
              command.output ? (
                <pre className="whitespace-pre-wrap break-words text-destructive">
                  {command.output}
                </pre>
              ) : null}
              {command.status === "done" ? (
                <p className="text-muted-foreground">Exit {command.exitCode ?? "unknown"}</p>
              ) : null}
              {commands.length > 1 ? (
                <details>
                  <summary>
                    <Trans>Earlier runs</Trans>
                  </summary>
                  {commands
                    .slice(0, -1)
                    .reverse()
                    .map((previous) => (
                      <div key={previous.executionId} className="mt-2 border-t border-border pt-2">
                        <p>{previous.coder?.task}</p>
                        <p className="text-muted-foreground">
                          {previous.coder?.text || previous.coder?.phase}
                        </p>
                      </div>
                    ))}
                </details>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
