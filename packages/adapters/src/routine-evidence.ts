import type { Prisma, PrismaClient } from "@rakazo/db";
import type { RoutineEvalCase, RoutineEvalRunner } from "./routine-eval.js";
import { compareRoutineVariants } from "./routine-eval.js";

/**
 * What a routine run actually did, measured from runtime records rather than the reply.
 *
 * The assistant's final message is a claim; these numbers come from tool audit events,
 * usage records and run timing, so a confident summary cannot inflate them.
 */
export interface RoutineRunEvidence {
  runId: string;
  outcome: "completed" | "failed";
  durationMs: number | null;
  toolCalls: number;
  toolFailures: Array<{ name: string; error: string }>;
  /** Tools that eventually succeeded after at least one failure. */
  retriedTools: string[];
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

const MAX_ERROR_CHARS = 200;
const MAX_FAILURE_SAMPLES = 5;

export async function collectRunEvidence(
  prisma: PrismaClient,
  input: { runId: string; outcome: "completed" | "failed" },
): Promise<RoutineRunEvidence> {
  const [run, events, usage] = await Promise.all([
    prisma.run.findUnique({
      where: { id: input.runId },
      select: { startedAt: true, completedAt: true },
    }),
    prisma.event.findMany({
      where: { runId: input.runId, type: "agent.tool.completed" },
      select: { payload: true },
      orderBy: { seq: "asc" },
    }),
    prisma.usageRecord.aggregate({
      where: { runId: input.runId },
      _sum: {
        inputTokens: true,
        outputTokens: true,
        costUsd: true,
      },
    }),
  ]);

  const failures: Array<{ name: string; error: string }> = [];
  const succeeded = new Set<string>();
  const failedOnce = new Set<string>();
  for (const event of events) {
    const payload = event.payload as
      | { name?: unknown; outcome?: unknown; error?: unknown }
      | null;
    const name = typeof payload?.name === "string" ? payload.name : undefined;
    if (!name) continue;
    if (payload?.outcome === "succeeded") {
      succeeded.add(name);
    } else if (payload?.outcome === "error") {
      failedOnce.add(name);
      if (failures.length < MAX_FAILURE_SAMPLES) {
        failures.push({
          name,
          error: clip(
            typeof payload?.error === "string" ? payload.error : "tool reported an error",
            MAX_ERROR_CHARS,
          ),
        });
      }
    }
  }

  const started = run?.startedAt?.getTime();
  const completed = run?.completedAt?.getTime();
  return {
    runId: input.runId,
    outcome: input.outcome,
    durationMs:
      started !== undefined && completed !== undefined && completed >= started
        ? completed - started
        : null,
    toolCalls: events.length,
    toolFailures: failures,
    retriedTools: [...failedOnce].filter((name) => succeeded.has(name)),
    inputTokens: usage._sum.inputTokens ?? null,
    outputTokens: usage._sum.outputTokens ?? null,
    costUsd: usage._sum.costUsd ?? null,
  };
}

/**
 * The post-run summary written for a routine.
 *
 * Deliberately compact and derived: no transcript, no message bodies, no connector output.
 * A routine's memory should say what was verified, not replay what was read.
 */
export function summarizeRunEvidence(evidence: RoutineRunEvidence): string {
  const parts = [
    `${evidence.outcome === "completed" ? "Completed" : "Failed"}${
      evidence.durationMs === null ? "" : ` in ${formatDuration(evidence.durationMs)}`
    }`,
    `${evidence.toolCalls} tool ${evidence.toolCalls === 1 ? "call" : "calls"}`,
  ];
  if (evidence.retriedTools.length > 0) {
    parts.push(`retried ${evidence.retriedTools.join(", ")}`);
  }
  if (evidence.toolFailures.length > 0) {
    parts.push(
      `failures: ${evidence.toolFailures
        .map((failure) => `${failure.name} (${failure.error})`)
        .join("; ")}`,
    );
  }
  return parts.join("; ");
}

/**
 * Whether this run may propose a guidance change.
 *
 * Only a run that finished cleanly with real tool evidence can teach anything. A failed
 * run, or one that never used a tool, is not a basis for changing future instructions.
 */
export function mayProposeGuidance(evidence: RoutineRunEvidence): boolean {
  return evidence.outcome === "completed" && evidence.toolCalls > 0;
}

/** A proposal is only worth storing if it is a small, self-contained instruction. */
export const MAX_GUIDANCE_CHARS = 400;

export function normalizeGuidanceText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length === 0 || text.length > MAX_GUIDANCE_CHARS) return null;
  // Guidance is an addendum to instructions, so it must not smuggle in a new objective.
  if (/\b(ignore|disregard|override)\b.*\b(instruction|prompt|rule)/i.test(text)) return null;
  return text;
}

/**
 * Store a proposed addendum as the next version for a routine.
 *
 * Versions are sequential and unique per routine, and a proposal never displaces the
 * active one: promotion is a separate, reviewable step.
 */
export async function proposeGuidance(
  prisma: PrismaClient,
  input: { routineId: string; runId: string; text: string; reason: string },
): Promise<{ version: number; text: string } | null> {
  const text = normalizeGuidanceText(input.text);
  if (!text) return null;
  const latest = await prisma.routineGuidance.findFirst({
    where: { routineId: input.routineId },
    orderBy: { version: "desc" },
    select: { version: true, text: true, status: true },
  });
  if (latest?.status === "active" && latest.text === text) return null;
  const duplicate = await prisma.routineGuidance.findFirst({
    where: { routineId: input.routineId, text, status: { in: ["proposed", "active"] } },
    select: { version: true },
  });
  if (duplicate) return null;
  const version = (latest?.version ?? 0) + 1;
  await prisma.routineGuidance.create({
    data: {
      routineId: input.routineId,
      version,
      text,
      status: "proposed",
      sourceRunId: input.runId,
      reason: clip(input.reason, MAX_ERROR_CHARS),
    },
  });
  return { version, text };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Activate one guidance version and retire whatever was active.
 *
 * Rollback is the same operation pointed at an older version, so there is exactly one code
 * path that decides which addendum a run reads.
 */
export async function activateGuidanceVersion(
  prisma: PrismaClient,
  input: { routineId: string; version: number },
): Promise<{ version: number; text: string } | null> {
  const target = await prisma.routineGuidance.findFirst({
    where: { routineId: input.routineId, version: input.version },
    select: { id: true, version: true, text: true },
  });
  if (!target) return null;
  await prisma.$transaction([
    prisma.routineGuidance.updateMany({
      where: { routineId: input.routineId, status: "active", version: { not: target.version } },
      data: { status: "rolled_back" },
    }),
    prisma.routineGuidance.update({
      where: { id: target.id },
      data: { status: "active", activatedAt: new Date() },
    }),
  ]);
  return { version: target.version, text: target.text };
}

/** Turn learned guidance off entirely, keeping the history so it can be restored. */
export async function disableGuidance(
  prisma: PrismaClient,
  routineId: string,
): Promise<boolean> {
  const changed = await prisma.routineGuidance.updateMany({
    where: { routineId, status: "active" },
    data: { status: "disabled" },
  });
  return changed.count > 0;
}

/**
 * Reject a proposal. Kept rather than deleted so the reason stays visible in the history.
 */
export async function rejectGuidanceVersion(
  prisma: PrismaClient,
  input: { routineId: string; version: number; reason?: string },
): Promise<boolean> {
  const changed = await prisma.routineGuidance.updateMany({
    where: { routineId: input.routineId, version: input.version, status: "proposed" },
    data: { status: "rejected" },
  });
  return changed.count === 1;
}

/**
 * Whether a proposal may activate without review.
 *
 * Only wording or sequencing guidance qualifies. Anything that changes what the routine is
 * for, what it may touch, or which external actions it takes always needs a human, however
 * well it scored.
 */
export function isAutoPromotable(text: string): boolean {
  const risky =
    /\b(delete|remove|destroy|drop|purge|wipe|overwrite|send|post|publish|submit|purchase|pay|transfer|grant|permission|scope|credential|token|password|secret|approve|allow)\b/i;
  if (risky.test(text)) return false;
  // Sequencing and verification wording is the low-risk category this allows.
  return /\b(first|before|after|check|verify|confirm|then|stop|report|retry|skip|only|if)\b/i.test(
    text,
  );
}

/**
 * Evaluate a proposal and promote it only if it is both low-risk and measurably better.
 *
 * Promotion is refused by default: with no evaluator configured, or a proposal that touches
 * intent, permissions or external actions, the change waits for a human. When an evaluator
 * is supplied, the comparison is recorded on the row either way, so a refusal is as
 * reviewable as an approval.
 */
export async function maybeAutoPromote(
  prisma: PrismaClient,
  input: {
    routineId: string;
    version: number;
    text: string;
    prompt: string;
    cases: readonly RoutineEvalCase[];
    run?: RoutineEvalRunner;
  },
): Promise<{ promoted: boolean; reason: string }> {
  if (!isAutoPromotable(input.text)) {
    return { promoted: false, reason: "Changes to actions or permissions always need review." };
  }
  if (!input.run) {
    return { promoted: false, reason: "No evaluator is configured, so this waits for review." };
  }
  const comparison = await compareRoutineVariants({
    cases: input.cases,
    prompt: input.prompt,
    addendum: input.text,
    run: input.run,
  });
  await prisma.routineGuidance.updateMany({
    where: { routineId: input.routineId, version: input.version },
    data: {
      evaluation: {
        baseline: comparison.baseline,
        candidate: comparison.candidate,
        promote: comparison.promote,
        blocked: comparison.blocked,
      } as Prisma.InputJsonValue,
    },
  });
  if (!comparison.promote) {
    return { promoted: false, reason: comparison.blocked ?? "No measured improvement." };
  }
  await activateGuidanceVersion(prisma, { routineId: input.routineId, version: input.version });
  return { promoted: true, reason: "Low-risk change passed its evaluation." };
}
