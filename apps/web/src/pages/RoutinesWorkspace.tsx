import { Trans } from "@lingui/react/macro";
import type { Routine, RoutineHistory, RoutineOutput, ThreadSnapshot } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { ChevronDown, Clock, Pause, Pencil, Play, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { ArtifactFileCard } from "../components/ArtifactFileCard";
import { AskCard } from "../components/AskCard";
import { CloudAgentCard } from "../components/CloudAgentCard";
import { LongReplyMarkdown } from "../components/LongReplyMarkdown";
import { StandaloneToolActivity } from "../components/ToolActivityDisclosure";
import { rpc } from "../lib/rpc";
import { reduceThreadSnapshot } from "../lib/thread-events";
import { toolActivityByRun } from "../lib/tool-activity-view";
import { statusLabel, statusTone } from "./ActivityList";
import { ArtifactImage, ChartBlockView, McpApprovalCard } from "./shell/message-cards";

function useRoutines(botId?: string) {
  const [loaded, setLoaded] = useState<{ botId?: string; rows: Routine[] }>({ rows: [] });
  const [error, setError] = useState(false);
  useEffect(() => {
    let disposed = false;
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const next = botId
          ? await rpc.routines.list({ botId }, { signal: AbortSignal.timeout(8000) })
          : [];
        if (!disposed) {
          setLoaded({ botId, rows: next.filter((row) => row.botId === botId) });
          setError(false);
        }
      } catch {
        if (!disposed) setError(true);
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 10000);
    document.addEventListener("visibilitychange", load);
    window.addEventListener("routines-changed", load);
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener("routines-changed", load);
      document.removeEventListener("visibilitychange", load);
    };
  }, [botId]);
  return { rows: loaded.botId === botId ? loaded.rows : [], error };
}

function RoutineRunPhase({ output }: { output: RoutineOutput }) {
  const [now, setNow] = useState(Date.now);
  const live = ["queued", "leased", "running"].includes(output.status);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  if (!live) return null;
  const event = output.events.findLast(
    (event) =>
      event.type === "agent.tool.called" ||
      event.type === "agent.tool.completed" ||
      (event.type === "thread.meta" && event.payload?.phase === "waiting_model"),
  );
  const elapsed = event ? Math.max(0, Math.floor((now - Date.parse(event.createdAt)) / 1000)) : 0;
  return (
    <p role="status" className="text-xs text-muted-foreground">
      {output.status === "queued" ? (
        output.error || <Trans>Waiting to start</Trans>
      ) : event?.type === "agent.tool.called" ? (
        <>
          <Trans>Running tool</Trans>: {String(event.payload.name ?? "")}
        </>
      ) : event ? (
        <Trans>Waiting for model response</Trans>
      ) : (
        <Trans>Starting computer</Trans>
      )}
      {elapsed > 0 ? ` · ${elapsed}s` : ""}
    </p>
  );
}

export function RoutinesNavigation({
  botId,
  selected,
  onOpen,
}: {
  botId?: string;
  selected?: string;
  onOpen: (id?: string) => void;
}) {
  const { rows, error } = useRoutines(botId);
  const [expanded, setExpanded] = useState(true);
  const [more, setMore] = useState(false);
  if (!botId) return null;
  return (
    <section className="mt-3 border-t border-border pt-2" aria-label="Routines">
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="flex flex-1 items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground hover:bg-sidebar-accent"
          onClick={() => onOpen()}
        >
          <Clock size={14} />
          <Trans>Routines</Trans>
          <span className="ms-auto text-xs">{rows.length}</span>
        </button>
        <button
          type="button"
          aria-label="Toggle routines"
          aria-expanded={expanded}
          className="rounded p-2 hover:bg-sidebar-accent"
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronDown size={14} className={expanded ? "" : "-rotate-90"} />
        </button>
      </div>
      {error ? (
        <p role="alert" className="px-3 text-xs text-destructive">
          <Trans>Could not load routines</Trans>
        </p>
      ) : null}
      {expanded
        ? (more ? rows : rows.slice(0, 4)).map((routine) => (
            <button
              key={routine.id}
              type="button"
              onClick={() => onOpen(routine.id)}
              className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-sidebar-accent ${selected === routine.id ? "bg-sidebar-accent" : ""}`}
            >
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${routine.latestRunStatus === "failed" ? "bg-destructive" : ["running", "leased", "waiting_input", "waiting_takeover"].includes(routine.latestRunStatus ?? "") ? "bg-warning" : routine.active ? "bg-success" : "bg-muted-foreground"}`}
                role="img"
                aria-label={routine.latestRunStatus ?? (routine.active ? "Active" : "Paused")}
              />
              <span className="min-w-0 flex-1 truncate">{routine.name}</span>
            </button>
          ))
        : null}
      {expanded && rows.length > 4 ? (
        <button
          type="button"
          className="px-3 py-2 text-xs text-muted-foreground"
          onClick={() => setMore(!more)}
        >
          {more ? <Trans>Show less</Trans> : <Trans>Show more</Trans>}
        </button>
      ) : null}
    </section>
  );
}

export function RoutinesWorkspace({
  botId,
  routineId,
  runId,
  onOpen,
  onClose,
  onEdit,
}: {
  botId?: string;
  routineId?: string;
  runId?: string;
  onOpen: (routineId?: string, runId?: string) => void;
  onClose: () => void;
  onEdit: (routine: Routine) => void;
}) {
  const { rows, error: loadError } = useRoutines(botId);
  const routine = rows.find((row) => row.id === routineId);
  const [history, setHistory] = useState<RoutineHistory | null>(null);
  const [output, setOutput] = useState<RoutineOutput | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [actionError, setActionError] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let disposed = false;
    let loading = false;
    setHistory(null);
    setOutput(null);
    setConfirmDelete(false);
    setError(false);
    const load = async () => {
      if (!routineId || loading) return;
      loading = true;
      try {
        const next = await rpc.routines.history(
          { routineId },
          { signal: AbortSignal.timeout(8000) },
        );
        if (disposed) return;
        setHistory((current) => ({
          ...next,
          runs: [
            ...next.runs,
            ...(current?.runs.filter((run) => !next.runs.some((row) => row.id === run.id)) ?? []),
          ],
          nextCursor:
            current && current.runs.length > next.runs.length
              ? current.nextCursor
              : next.nextCursor,
        }));
        const selected = runId ?? next.runs[0]?.id;
        if (selected) {
          const result = await rpc.routines.output(
            { runId: selected },
            { signal: AbortSignal.timeout(8000) },
          );
          if (!disposed)
            setOutput((current) => {
              if (!current || current.runId !== result.runId) return result;
              const boundary = result.messages[0]?.seq;
              const earlier =
                boundary === undefined
                  ? []
                  : current.messages.filter((message) => message.seq < boundary);
              return {
                ...result,
                messages: [...earlier, ...result.messages],
                olderCursor: earlier.length ? current.olderCursor : result.olderCursor,
              };
            });
        }
        if (!disposed) setError(false);
      } catch {
        if (!disposed) setError(true);
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 2000);
    document.addEventListener("visibilitychange", load);
    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [routineId, runId, revision]);
  async function action(work: () => Promise<unknown>, refresh = true) {
    if (busy) return;
    setBusy(true);
    setActionError(false);
    try {
      await work();
      window.dispatchEvent(new Event("routines-changed"));
      if (refresh) setRevision((value) => value + 1);
    } catch {
      setActionError(true);
    } finally {
      setBusy(false);
    }
  }
  const snapshot = output?.events.reduce<ThreadSnapshot | null>(
    (current, event) => reduceThreadSnapshot(current, event),
    output
      ? {
          threadId: output.threadId,
          cursor: -1,
          messages: output.messages,
          olderCursor: output.olderCursor,
          run: null,
        }
      : null,
  );
  const live = output && !["completed", "failed", "cancelled"].includes(output.status);
  const messages = snapshot?.messages.filter((message) => message.runId === output?.runId) ?? [];
  const activity = output ? toolActivityByRun(messages).get(output.runId) : undefined;
  const latestProgress = messages
    .flatMap((message) => message.blocks)
    .findLast((block) => block.kind === "progress" && block.activity);
  return (
    <section className="flex min-h-0 flex-1 flex-col" data-testid="routines-workspace">
      <header className="flex items-center justify-between gap-3 border-b border-border p-4">
        <h1 className="min-w-0 truncate text-lg font-medium">
          {routine?.name ?? <Trans>Routines</Trans>}
        </h1>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close routines">
          <X size={16} />
        </Button>
      </header>
      <div className="rk-scroll min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        {loadError || error || actionError ? (
          <p role="alert" className="mb-3 text-sm text-destructive">
            <Trans>Could not load or update routine. Try again.</Trans>
            <Button variant="ghost" size="sm" onClick={() => setRevision((value) => value + 1)}>
              <Trans>Retry</Trans>
            </Button>
          </p>
        ) : null}
        {!routineId ? (
          <div className="space-y-2">
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                <Trans>No routines yet</Trans>
              </p>
            ) : null}
            {rows.map((row) => (
              <button
                key={row.id}
                type="button"
                onClick={() => onOpen(row.id)}
                className="flex w-full items-center justify-between gap-3 rounded-xl border border-border p-4 text-left hover:bg-accent"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{row.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {row.nextRunAt
                      ? new Date(row.nextRunAt).toLocaleString()
                      : row.active
                        ? "Active"
                        : "Paused"}
                  </span>
                </span>
                <Clock size={16} />
              </button>
            ))}
          </div>
        ) : routine ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    const result = await rpc.routines.testRun({
                      routineId: routine.id,
                      clientNonce: crypto.randomUUID(),
                    });
                    onOpen(routine.id, result.runId);
                  })
                }
              >
                <Play size={13} />
                <Trans>Run now</Trans>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void action(() =>
                    rpc.routines.update({ routineId: routine.id, active: !routine.active }),
                  )
                }
              >
                {routine.active ? <Pause size={13} /> : <Play size={13} />}
                {routine.active ? <Trans>Pause</Trans> : <Trans>Resume</Trans>}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onEdit(routine)}>
                <Pencil size={13} />
                <Trans>Edit</Trans>
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
                <Trash2 size={13} />
                <Trans>Delete</Trans>
              </Button>
            </div>
            {confirmDelete ? (
              <div className="my-3 flex flex-wrap items-center gap-2 rounded-lg border border-border p-3">
                <span className="text-sm">
                  <Trans>Delete this routine and its run history?</Trans>
                </span>
                <Button
                  size="sm"
                  disabled={busy}
                  variant="destructive"
                  onClick={() =>
                    void action(async () => {
                      await rpc.routines.remove({ routineId: routine.id });
                      onOpen();
                    })
                  }
                >
                  <Trans>Delete</Trans>
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
                  <Trans>Cancel</Trans>
                </Button>
              </div>
            ) : null}
            <p className="mt-2 text-xs text-muted-foreground">
              {routine.nextRunAt
                ? `Next run: ${new Date(routine.nextRunAt).toLocaleString()} · ${routine.timezone}`
                : routine.active
                  ? "Active"
                  : "Paused"}
            </p>
            <label className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={routine.notify}
                disabled={busy}
                onChange={(event) =>
                  void action(() =>
                    rpc.routines.update({ routineId: routine.id, notify: event.target.checked }),
                  )
                }
              />
              <Trans>Notifications</Trans>
            </label>
            <details className="my-4 text-sm">
              <summary className="cursor-pointer text-muted-foreground">
                <Trans>Instructions</Trans>
              </summary>
              <p className="mt-2 whitespace-pre-wrap">{routine.prompt}</p>
            </details>
            <h2 className="mb-2 text-sm font-medium">
              <Trans>Run history</Trans>
            </h2>
            <div className="mb-5 flex flex-wrap gap-2">
              {history?.runs.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  aria-pressed={output?.runId === run.id}
                  onClick={() => onOpen(routine.id, run.id)}
                  className={`rounded-lg border border-border px-3 py-2 text-left text-xs ${output?.runId === run.id ? "bg-accent" : "hover:bg-accent"}`}
                >
                  <time className="block">{new Date(run.createdAt).toLocaleString()}</time>
                  <span className={statusTone(run.status)}>{statusLabel(run.status)}</span>
                </button>
              ))}
              {history?.runs.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  <Trans>No runs yet</Trans>
                </p>
              ) : null}
            </div>
            {history?.nextCursor ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    const older = await rpc.routines.history({
                      routineId: routine.id,
                      before: history.nextCursor!,
                    });
                    setHistory({
                      runs: [...history.runs, ...older.runs],
                      nextCursor: older.nextCursor,
                    });
                  }, false)
                }
              >
                <Trans>Load older runs</Trans>
              </Button>
            ) : null}
            {output ? (
              <article
                className="space-y-4 rounded-xl border border-border p-4"
                aria-label="Run output"
              >
                <div className={`text-sm ${statusTone(output.status)}`}>
                  {statusLabel(output.status)}
                </div>
                <RoutineRunPhase output={output} />
                {live && output.isolated ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void action(() => rpc.routines.stopRun({ runId: output.runId }))}
                  >
                    <Trans>Stop run</Trans>
                  </Button>
                ) : null}
                {activity || latestProgress ? (
                  <StandaloneToolActivity
                    live={Boolean(live)}
                    steps={activity?.steps ?? []}
                    latestAction={
                      !activity?.steps.length && latestProgress?.kind === "progress"
                        ? latestProgress.text
                        : undefined
                    }
                    durationMs={activity?.durationMs}
                  />
                ) : null}
                {output.error && output.status !== "queued" ? (
                  <p role="alert" className="text-sm text-destructive">
                    {output.error}
                  </p>
                ) : null}
                {snapshot?.messages
                  .filter((message) => message.runId === output.runId)
                  .map((message) => (
                    <div key={message.id} className="space-y-3">
                      {message.blocks.map((block, index) => {
                        if (block.kind === "text" || (block.kind === "progress" && !block.activity))
                          return (
                            <LongReplyMarkdown
                              key={index}
                              streaming={Boolean(live && block.kind === "progress")}
                            >
                              {block.text}
                            </LongReplyMarkdown>
                          );
                        if (block.kind === "chart")
                          return (
                            <ChartBlockView
                              key={index}
                              name={block.name}
                              spec={block.spec}
                              data={block.data}
                            />
                          );
                        if (block.kind === "image")
                          return (
                            <ArtifactImage
                              key={index}
                              target={{ botId: routine.botId }}
                              artifactId={block.artifactId}
                              name={block.name}
                            />
                          );
                        if (block.kind === "mcp_approval")
                          return (
                            <McpApprovalCard
                              key={index}
                              botId={routine.botId}
                              threadId={message.threadId}
                              block={block}
                            />
                          );
                        if (block.kind === "cloud_agent")
                          return <CloudAgentCard key={index} block={block} />;
                        if (block.kind === "file")
                          return (
                            <ArtifactFileCard
                              key={index}
                              target={{ botId: routine.botId }}
                              artifactId={block.artifactId}
                              name={block.name}
                              mimeType={block.mimeType}
                              size={block.size}
                            />
                          );
                        if (block.kind === "ask")
                          return (
                            <AskCard
                              key={index}
                              block={block}
                              canAnswer={output.status === "waiting_input"}
                              onAnswer={async (answer, username) => {
                                await rpc.routines.answerRun({
                                  runId: output.runId,
                                  messageId: message.id,
                                  answer,
                                  username,
                                });
                                setRevision((value) => value + 1);
                              }}
                            />
                          );
                        return null;
                      })}
                    </div>
                  ))}
                {snapshot?.messages.length === 0 && !live ? (
                  <p className="text-sm text-muted-foreground">
                    <Trans>No output for this run</Trans>
                  </p>
                ) : null}
                {output.olderCursor !== null ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        const older = await rpc.routines.output({
                          runId: output.runId,
                          before: output.olderCursor!,
                        });
                        setOutput((current) =>
                          current?.runId === output.runId
                            ? {
                                ...current,
                                messages: [
                                  ...older.messages,
                                  ...current.messages.filter(
                                    (message) =>
                                      !older.messages.some((row) => row.id === message.id),
                                  ),
                                ],
                                olderCursor: older.olderCursor,
                              }
                            : current,
                        );
                      }, false)
                    }
                  >
                    <Trans>Load earlier output</Trans>
                  </Button>
                ) : null}
              </article>
            ) : null}
          </>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            <Trans>Loading routine…</Trans>
          </p>
        )}
      </div>
    </section>
  );
}
