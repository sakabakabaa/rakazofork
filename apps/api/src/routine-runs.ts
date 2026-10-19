import { ORPCError } from "@orpc/server";
import type {
  Actor,
  RoutineHistory,
  RoutineOutput,
  RoutineRun,
  RoutineRunCursor,
} from "@rakazo/contracts";
import { ProductEventSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { Prisma } from "@rakazo/db";
import { toThreadMessage } from "./thread-message-pages.js";

export async function listRoutineRuns(
  prisma: PrismaClient,
  actor: Actor,
  routineId: string,
  before?: RoutineRunCursor,
): Promise<RoutineHistory> {
  const routine = await prisma.routine.findFirst({
    where: {
      id: routineId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      bot: { archivedAt: null },
    },
    select: { botId: true },
  });
  if (!routine) throw new ORPCError("NOT_FOUND");

  const rows = await prisma.run.findMany({
    where: {
      routineId,
      botId: routine.botId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      ...(before
        ? {
            OR: [
              { createdAt: { lt: new Date(before.createdAt) } },
              { createdAt: new Date(before.createdAt), id: { lt: before.id } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      botId: true,
      threadId: true,
      thread: { select: { groupId: true, botId: true } },
      status: true,
      createdAt: true,
      startedAt: true,
      completedAt: true,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 21,
  });
  const runs = rows.slice(0, 20);
  const last = runs.at(-1);
  const nextCursor =
    rows.length > 20 && last ? { id: last.id, createdAt: last.createdAt.toISOString() } : null;
  // Routine runs can finish silently. A chat link is offered only when a message exists.
  const messages = runs.length
    ? await prisma.$queryRaw<Array<{ id: string; runId: string; threadId: string }>>(Prisma.sql`
        SELECT DISTINCT ON (m."runId") m.id, m."runId", m."threadId"
        FROM messages m
        INNER JOIN runs r ON r.id = m."runId" AND r."threadId" = m."threadId"
        INNER JOIN threads t ON t.id = m."threadId"
        WHERE r.id IN (${Prisma.join(runs.map((run) => run.id))})
          AND r."spaceId" = ${actor.spaceId} AND r."userId" = ${actor.userId}
          AND t."spaceId" = ${actor.spaceId} AND t."userId" = ${actor.userId}
          AND m.role = 'bot'
        ORDER BY m."runId", m."createdAt" DESC, m.id DESC
      `)
    : [];
  const replyByRun = new Map(messages.map((message) => [message.runId, message.id]));
  return {
    nextCursor,
    runs: runs.map((run) => ({
      id: run.id,
      botId: run.botId,
      groupId: run.thread.groupId,
      status: run.status as RoutineRun["status"],
      createdAt: run.createdAt.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      completedAt: run.completedAt?.toISOString() ?? null,
      messageId:
        run.thread.botId === null && !run.thread.groupId ? null : (replyByRun.get(run.id) ?? null),
    })),
  };
}

/** Run output is scoped to the owner and run, including legacy runs in a shared chat. */
export async function routineOutput(
  prisma: PrismaClient,
  actor: Actor,
  runId: string,
  before?: number,
): Promise<RoutineOutput> {
  const run = await prisma.run.findFirst({
    where: {
      id: runId,
      trigger: "routine",
      spaceId: actor.spaceId,
      userId: actor.userId,
      bot: { archivedAt: null },
    },
    select: {
      id: true,
      threadId: true,
      status: true,
      error: true,
      thread: { select: { botId: true, groupId: true, externalConversationId: true } },
    },
  });
  if (!run) throw new ORPCError("NOT_FOUND");
  const rows = await prisma.message.findMany({
    where: {
      runId,
      threadId: run.threadId,
      ...(before === undefined ? {} : { seq: { lt: before } }),
    },
    orderBy: { seq: "desc" },
    take: 101,
  });
  const events = await prisma.event.findMany({
    where: { runId, threadId: run.threadId, spaceId: actor.spaceId },
    orderBy: { seq: "desc" },
    take: 500,
  });
  const messages = rows.slice(0, 100).reverse();
  return {
    runId,
    threadId: run.threadId,
    isolated: Boolean(
      run.thread && !run.thread.botId && !run.thread.groupId && !run.thread.externalConversationId,
    ),
    status: run.status as RoutineRun["status"],
    error: run.error,
    messages: messages.map(toThreadMessage),
    olderCursor: rows.length > 100 ? messages[0]!.seq : null,
    events: events.reverse().flatMap((event) => {
      const parsed = ProductEventSchema.safeParse({
        ...event,
        runId: event.runId ?? undefined,
        createdAt: event.createdAt.toISOString(),
      });
      return parsed.success ? [parsed.data] : [];
    }),
  };
}
