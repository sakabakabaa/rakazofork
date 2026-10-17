import * as z from "zod";
import { Id } from "./ids.js";

export const GoalStatus = z.enum(["active", "paused", "blocked", "completed", "stopped"]);
export const GoalStepStatus = z.enum([
  "pending",
  "working",
  "verifying",
  "done",
  "blocked",
  "cancelled",
]);
export const GoalStep = z.object({
  id: z.string().min(1).max(80),
  title: z.string().trim().min(1).max(200),
  status: GoalStepStatus,
  evidence: z.string().max(1500).optional(),
  evidenceEventId: Id.optional(),
});
export const Goal = z.object({
  id: Id,
  botId: Id,
  title: z.string(),
  successCriteria: z.string(),
  checkpoint: z.string(),
  request: z.string(),
  status: GoalStatus,
  steps: z.array(GoalStep),
  revision: z.number().int(),
  runId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Goal = z.infer<typeof Goal>;
export type GoalStep = z.infer<typeof GoalStep>;
export const CreateGoal = z.object({
  title: z.string().trim().min(1).max(200),
  successCriteria: z.string().trim().min(1).max(2000),
  steps: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
  checkpoint: z.string().max(4000).default(""),
});
export const UpdateGoal = z.object({
  goalId: Id,
  revision: z.number().int().nonnegative(),
  checkpoint: z.string().max(4000).optional(),
  appendSteps: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  status: z.enum(["active", "blocked", "completed"]).optional(),
  stepId: z.string().optional(),
  stepStatus: GoalStepStatus.optional(),
  evidence: z.string().trim().max(1500).optional(),
  verificationTool: z.string().max(120).optional(),
});
