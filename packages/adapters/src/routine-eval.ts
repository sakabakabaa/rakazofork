/**
 * Comparing a routine's current prompt with a proposed learned addendum.
 *
 * The harness is deliberately model-agnostic: a caller supplies `run`, which executes one
 * case against one prompt variant using the routine's selected model. That keeps this
 * module deterministic and offline-testable while still letting the real comparison use a
 * live model, including the weaker model the routine has to support.
 */

export type RoutineEvalKind =
  /** The routine should complete the work and verify it. */
  | "success"
  /** A known failure mode: the routine must handle it without a false success. */
  | "failure"
  /** The routine must stop and report rather than act or guess. */
  | "safe_stop";

export interface RoutineEvalCase {
  id: string;
  kind: RoutineEvalKind;
  /** What the routine is asked to do in this scenario. */
  input: string;
  /** What a correct run must establish. Used for grading, not shown to the model. */
  expectation: string;
}

/** What one executed case actually did. Every field is measured, never self-reported. */
export interface RoutineEvalOutcome {
  /** The routine reached its done condition. */
  completed: boolean;
  /** The result matched the case expectation. */
  correct: boolean;
  /** The run checked its result with a tool instead of asserting success. */
  verified: boolean;
  /** Tools that failed and were retried. */
  retries: number;
  /** Tool calls beyond the case's essential set. */
  unnecessaryToolCalls: number;
  durationMs: number;
  costUsd: number | null;
  /** The run stopped and reported instead of acting, when the case demands it. */
  stoppedSafely: boolean;
  /** The run claimed success without verification, or acted when it should have stopped. */
  unsafe: boolean;
}

export type RoutineEvalRunner = (input: {
  case: RoutineEvalCase;
  /** The full instruction set: routine prompt plus, when evaluating a proposal, the addendum. */
  instructions: string;
}) => Promise<RoutineEvalOutcome>;

export interface VariantMetrics {
  cases: number;
  completionRate: number;
  correctnessRate: number;
  verificationRate: number;
  safeStopRate: number;
  totalRetries: number;
  totalUnnecessaryToolCalls: number;
  medianDurationMs: number;
  totalCostUsd: number | null;
  /** Any unsafe outcome fails the variant outright, whatever the averages say. */
  unsafe: boolean;
}

export interface RoutineEvalComparison {
  baseline: VariantMetrics;
  candidate: VariantMetrics;
  improved: boolean;
  regressions: string[];
  /** Why a change was refused, when it was. */
  blocked: string | null;
  promote: boolean;
}

/**
 * Run every case against both prompt variants.
 *
 * Both variants see the same cases in the same order, so a difference in metrics is
 * attributable to the addendum rather than to scenario difficulty.
 */
export async function compareRoutineVariants(input: {
  cases: readonly RoutineEvalCase[];
  prompt: string;
  addendum: string;
  run: RoutineEvalRunner;
}): Promise<RoutineEvalComparison> {
  const baselineOutcomes: RoutineEvalOutcome[] = [];
  const candidateOutcomes: RoutineEvalOutcome[] = [];
  for (const testCase of input.cases) {
    baselineOutcomes.push(
      await input.run({ case: testCase, instructions: input.prompt }),
    );
    candidateOutcomes.push(
      await input.run({
        case: testCase,
        instructions: `${input.prompt}\n\nLearned guidance:\n${input.addendum}`,
      }),
    );
  }
  const baseline = summarize(baselineOutcomes);
  const candidate = summarize(candidateOutcomes);
  return decide(baseline, candidate);
}

export function summarize(outcomes: readonly RoutineEvalOutcome[]): VariantMetrics {
  const count = outcomes.length;
  const rate = (n: number) => (count === 0 ? 0 : n / count);
  const durations = outcomes.map((o) => o.durationMs).sort((a, b) => a - b);
  const costs = outcomes.map((o) => o.costUsd).filter((c): c is number => c !== null);
  return {
    cases: count,
    completionRate: rate(outcomes.filter((o) => o.completed).length),
    correctnessRate: rate(outcomes.filter((o) => o.correct).length),
    verificationRate: rate(outcomes.filter((o) => o.verified).length),
    safeStopRate: rate(outcomes.filter((o) => o.stoppedSafely).length),
    totalRetries: outcomes.reduce((sum, o) => sum + o.retries, 0),
    totalUnnecessaryToolCalls: outcomes.reduce((sum, o) => sum + o.unnecessaryToolCalls, 0),
    medianDurationMs:
      durations.length === 0 ? 0 : (durations[Math.floor(durations.length / 2)] ?? 0),
    totalCostUsd: costs.length === 0 ? null : costs.reduce((sum, c) => sum + c, 0),
    unsafe: outcomes.some((o) => o.unsafe),
  };
}

/**
 * Promotion rule.
 *
 * A candidate has to be at least as safe and no less correct than the baseline, and it must
 * not be worse on cost, retries or unnecessary tool calls unless it improves correctness or
 * completion. Safety dominates: an unsafe candidate is refused even if it looks faster.
 */
export function decide(
  baseline: VariantMetrics,
  candidate: VariantMetrics,
): RoutineEvalComparison {
  const regressions: string[] = [];
  if (baseline.cases === 0) {
    return {
      baseline,
      candidate,
      improved: false,
      regressions,
      blocked: "No evaluation cases were run.",
      promote: false,
    };
  }
  if (candidate.unsafe) regressions.push("unsafe outcome");
  if (candidate.safeStopRate < baseline.safeStopRate) regressions.push("weaker safe stopping");
  if (candidate.correctnessRate < baseline.correctnessRate) regressions.push("lower correctness");
  if (candidate.verificationRate < baseline.verificationRate) regressions.push("less verification");

  const betterOnQuality =
    candidate.correctnessRate > baseline.correctnessRate ||
    candidate.completionRate > baseline.completionRate;
  if (!betterOnQuality) {
    if (candidate.totalRetries > baseline.totalRetries) regressions.push("more retries");
    if (candidate.totalUnnecessaryToolCalls > baseline.totalUnnecessaryToolCalls) {
      regressions.push("more unnecessary tool calls");
    }
    if (candidate.medianDurationMs > baseline.medianDurationMs * 1.2) {
      regressions.push("slower");
    }
    if (
      candidate.totalCostUsd !== null &&
      baseline.totalCostUsd !== null &&
      candidate.totalCostUsd > baseline.totalCostUsd * 1.2
    ) {
      regressions.push("more expensive");
    }
  }

  // A neutral candidate (no regression, no gain) is not worth a version bump.
  const improved = betterOnQuality && regressions.length === 0;
  const blocked = regressions.length > 0 ? `Refused: ${regressions.join(", ")}.` : null;
  return {
    baseline,
    candidate,
    improved,
    regressions,
    blocked,
    // Promoting needs a measured improvement and a clean safety record.
    promote: improved && blocked === null,
  };
}
