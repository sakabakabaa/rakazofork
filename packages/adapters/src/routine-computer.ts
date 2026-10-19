import { lchown, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, AgentHomeStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { ComputerLimitError, Prisma, resolveMaxComputersPerUser } from "@rakazo/db";
import { LocalAgentHomeStore } from "./home.js";

/** One persistent sandbox per routine; different routines never share the agent's live desktop. */
export async function routineComputer(
  prisma: PrismaClient,
  run: { routineId?: string | null; botId: string; spaceId: string; userId: string },
  source: { id: string; kind: string; scope: string; homeKey: string },
) {
  // A trusted host computer cannot be cloned. Its exclusive lease remains mandatory.
  if (!run.routineId || source.kind === "desktop") return source;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${run.userId}, 1))::text`,
    );
    const routine = await tx.routine.findFirst({
      where: {
        id: run.routineId!,
        botId: run.botId,
        spaceId: run.spaceId,
        userId: run.userId,
        bot: { archivedAt: null },
      },
      select: { id: true },
    });
    if (!routine) throw new Error("Routine is no longer available");
    const scopeKey = `routine:${routine.id}`;
    const existing = await tx.computer.findUnique({ where: { scopeKey } });
    if (existing) return existing;
    const limit = resolveMaxComputersPerUser();
    if (limit > 0) {
      const count = await tx.computer.count({
        where: {
          userId: run.userId,
          OR: [{ bots: { some: { archivedAt: null } } }, { scopeKey: { startsWith: "routine:" } }],
        },
      });
      if (count >= limit) throw new ComputerLimitError(limit);
    }
    return tx.computer.create({
      data: {
        spaceId: run.spaceId,
        userId: run.userId,
        scopeKey,
        homeKey: `routine-${routine.id}`,
        scope: source.scope,
        kind: source.kind,
      },
    });
  });
}

/** Called under the destination computer lease. Copy a persisted workspace once, never share it. */
export async function seedRoutineComputer(
  prisma: PrismaClient,
  home: AgentHomeStore,
  sourceHomeKey: string,
  target: { id: string; homeKey: string; homeRevision?: string },
  context: AdapterContext,
) {
  if (!target.homeKey.startsWith("routine-") || target.homeRevision !== "empty") return;
  const staging = await mkdtemp(path.join(tmpdir(), "routine-home-"));
  try {
    context.signal.throwIfAborted();
    await home.checkout(sourceHomeKey, staging, context);
    context.signal.throwIfAborted();
    const revision = await home.commit(target.homeKey, staging, context);
    if (home instanceof LocalAgentHomeStore) {
      // Preserve ownership too: a commit stages and renames the tree; bind-mount
      // filesystems can otherwise expose copied entries as root-owned to the supervisor.
      const owner = await stat(home.pathFor(sourceHomeKey));
      const alignOwner = async (directory: string) => {
        await lchown(directory, owner.uid, owner.gid);
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          context.signal.throwIfAborted();
          const child = path.join(directory, entry.name);
          if (entry.isDirectory()) await alignOwner(child);
          else await lchown(child, owner.uid, owner.gid);
        }
      };
      await alignOwner(home.pathFor(target.homeKey));
    }
    await prisma.computer.update({ where: { id: target.id }, data: { homeRevision: revision } });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
