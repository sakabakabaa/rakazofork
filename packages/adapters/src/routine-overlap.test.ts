import type { PrismaClient } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import { createRunExecutor } from "./executor.js";

it("advances the next schedule without creating a duplicate run when the routine is busy", async () => {
  const scheduledAt = new Date(Date.now() - 1000);
  const routine = {
    id: "routine-1",
    botId: "bot-1",
    spaceId: "space-1",
    userId: "user-1",
    prompt: "Report updates",
    crons: ["* * * * *"],
    timezone: "UTC",
    active: true,
    nextRunAt: scheduledAt,
  };
  const createThread = vi.fn();
  const createTask = vi.fn();
  const enqueue = vi.fn();
  const tx = {
    routine: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(async () => ({ modelProvider: null, modelId: null, thinkingLevel: null })),
    },
    run: { findFirst: vi.fn(async () => ({ id: "existing-run" })) },
    thread: { create: createThread },
    task: { create: createTask },
  };
  const prisma = {
    routine: { findUnique: vi.fn(async () => routine) },
    bot: { findUnique: vi.fn(async () => ({ id: "bot-1", thread: { id: "main-thread" } })) },
    agentSkill: { findMany: vi.fn(async () => []) },
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
  } as unknown as PrismaClient;
  const executor = createRunExecutor({
    prisma,
    jobs: { enqueue },
    events: {},
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  await executor.wakeRoutine(routine.id, scheduledAt.toISOString());
  expect(createTask).not.toHaveBeenCalled();
  expect(createThread).not.toHaveBeenCalled();
  expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "routine.wakeup" }));
  expect(tx.run.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({ where: expect.objectContaining({ routineId: routine.id }) }),
  );
});
