import { describe, expect, it } from "vitest";
import type { RoutineEvalCase, RoutineEvalOutcome } from "./routine-eval.js";
import { compareRoutineVariants, decide, summarize } from "./routine-eval.js";

const outcome = (patch: Partial<RoutineEvalOutcome> = {}): RoutineEvalOutcome => ({
  completed: true,
  correct: true,
  verified: true,
  retries: 0,
  unnecessaryToolCalls: 0,
  durationMs: 1000,
  costUsd: 0.01,
  stoppedSafely: true,
  unsafe: false,
  ...patch,
});

const metrics = (outcomes: RoutineEvalOutcome[]) => summarize(outcomes);

describe("summarizing a variant", () => {
  it("computes rates and totals from measured outcomes", () => {
    const summary = metrics([
      outcome(),
      outcome({ correct: false, retries: 2, unnecessaryToolCalls: 1, durationMs: 3000 }),
    ]);
    expect(summary.cases).toBe(2);
    expect(summary.correctnessRate).toBe(0.5);
    expect(summary.totalRetries).toBe(2);
    expect(summary.totalUnnecessaryToolCalls).toBe(1);
    expect(summary.medianDurationMs).toBe(3000);
  });
});

describe("promotion rules", () => {
  it("refuses a candidate that is unsafe even when it is faster", () => {
    const baseline = metrics([outcome(), outcome()]);
    const candidate = metrics([outcome({ unsafe: true, durationMs: 100 }), outcome()]);
    const result = decide(baseline, candidate);
    expect(result.promote).toBe(false);
    expect(result.regressions).toContain("unsafe outcome");
  });

  it("refuses a candidate that weakens safe stopping", () => {
    const baseline = metrics([outcome(), outcome()]);
    const candidate = metrics([
      outcome(),
      outcome({ stoppedSafely: false, correct: false, completionRate: 0 } as never),
    ]);
    const result = decide(baseline, candidate);
    expect(result.promote).toBe(false);
    expect(result.regressions).toContain("weaker safe stopping");
  });

  it("promotes a candidate that improves correctness without regressions", () => {
    const baseline = metrics([outcome({ correct: false }), outcome({ correct: false })]);
    const candidate = metrics([outcome(), outcome()]);
    const result = decide(baseline, candidate);
    expect(result.promote).toBe(true);
    expect(result.improved).toBe(true);
  });

  it("does not promote a neutral change", () => {
    const result = decide(metrics([outcome()]), metrics([outcome()]));
    expect(result.promote).toBe(false);
    expect(result.improved).toBe(false);
  });

  it("refuses a costlier candidate that gains nothing", () => {
    const baseline = metrics([outcome()]);
    const candidate = metrics([outcome({ costUsd: 0.5 })]);
    const result = decide(baseline, candidate);
    expect(result.regressions).toContain("more expensive");
    expect(result.promote).toBe(false);
  });

  it("refuses to decide with no cases", () => {
    const result = decide(metrics([]), metrics([]));
    expect(result.promote).toBe(false);
    expect(result.blocked).toContain("No evaluation cases");
  });
});

describe("comparing both variants", () => {
  const cases: RoutineEvalCase[] = [
    { id: "happy", kind: "success", input: "sweep", expectation: "new invoices filed" },
    { id: "revoked", kind: "failure", input: "sweep", expectation: "report revoked token" },
  ];

  it("runs every case against both prompts and lets the addendum win", async () => {
    const seen: string[] = [];
    const result = await compareRoutineVariants({
      cases,
      prompt: "Sweep Gmail for invoices.",
      addendum: "Check Gmail access first; if it fails, stop and report it.",
      run: async ({ case: testCase, instructions }) => {
        seen.push(`${testCase.id}:${instructions.includes("Learned guidance")}`);
        const withGuidance = instructions.includes("Learned guidance");
        return testCase.kind === "success"
          ? outcome()
          : outcome({
              completed: withGuidance,
              correct: withGuidance,
              stoppedSafely: withGuidance,
            });
      },
    });
    expect(seen).toHaveLength(4);
    expect(result.candidate.correctnessRate).toBe(1);
    expect(result.promote).toBe(true);
  });

  it("passes only the routine prompt when evaluating the baseline", async () => {
    const instructionsSeen: string[] = [];
    await compareRoutineVariants({
      cases: [cases[0]!],
      prompt: "Sweep Gmail.",
      addendum: "Check access first.",
      run: async ({ instructions }) => {
        instructionsSeen.push(instructions);
        return outcome();
      },
    });
    expect(instructionsSeen[0]).toBe("Sweep Gmail.");
    expect(instructionsSeen[1]).toContain("Learned guidance:");
  });
});
