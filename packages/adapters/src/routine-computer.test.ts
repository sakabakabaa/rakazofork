import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, expect, it, vi } from "vitest";
import { LocalAgentHomeStore } from "./home.js";
import { routineComputer, seedRoutineComputer } from "./routine-computer.js";

vi.mock("@rakazo/db", () => ({
  Prisma: { sql: () => "lock" },
  ComputerLimitError: class extends Error {},
  resolveMaxComputersPerUser: () => Number(process.env.SANDBOX_MAX_COMPUTERS_PER_USER ?? 0),
}));
const source = { id: "main-computer", kind: "docker", scope: "team", homeKey: "team-home" };
const run = { routineId: "routine-a", botId: "bot-a", spaceId: "space-a", userId: "user-a" };
function database() {
  const computers = new Map<string, object>();
  const tx = {
    $queryRaw: vi.fn(async () => []),
    routine: { findFirst: vi.fn(async ({ where }) => ({ id: where.id })) },
    computer: {
      findUnique: vi.fn(async ({ where }) => computers.get(where.scopeKey) ?? null),
      count: vi.fn(async () => computers.size),
      create: vi.fn(async ({ data }) => {
        const row = { id: `computer-${computers.size}`, ...data };
        computers.set(data.scopeKey, row);
        return row;
      }),
    },
  };
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaClient;
  return { prisma, tx };
}
afterEach(() => vi.unstubAllEnvs());
it("gives two routines different sandboxes and reuses the same routine sandbox", async () => {
  const { prisma, tx } = database();
  const a = await routineComputer(prisma, run, source);
  const b = await routineComputer(prisma, { ...run, routineId: "routine-b" }, source);
  expect(a.id).not.toBe(b.id);
  expect(a.homeKey).not.toBe(b.homeKey);
  expect(await routineComputer(prisma, run, source)).toBe(a);
  expect(tx.computer.create).toHaveBeenCalledTimes(2);
});
it("leaves interactive and trusted host execution on the original computer", async () => {
  const { prisma, tx } = database();
  expect(await routineComputer(prisma, { ...run, routineId: null }, source)).toBe(source);
  const host = { ...source, kind: "desktop" };
  expect(await routineComputer(prisma, run, host)).toBe(host);
  expect(tx.computer.create).not.toHaveBeenCalled();
});
it("checks routine ownership before allocating", async () => {
  const { prisma, tx } = database();
  tx.routine.findFirst.mockResolvedValueOnce(null as never);
  await expect(routineComputer(prisma, run, source)).rejects.toThrow("no longer available");
  expect(tx.computer.create).not.toHaveBeenCalled();
});
it("honors the computer cap without blocking reuse", async () => {
  vi.stubEnv("SANDBOX_MAX_COMPUTERS_PER_USER", "1");
  const { prisma } = database();
  await routineComputer(prisma, run, source);
  await expect(
    routineComputer(prisma, { ...run, routineId: "routine-b" }, source),
  ).rejects.toThrow();
  await expect(routineComputer(prisma, run, source)).resolves.toBeDefined();
});

it("seeds a routine workspace once and keeps later routine writes independent", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "routine-seed-test-"));
  const home = new LocalAgentHomeStore(directory);
  const context = {
    operationId: "test",
    spaceId: "space-1",
    userId: "user-1",
    traceId: "test",
    signal: new AbortController().signal,
  };
  const target = { id: "computer-a", homeKey: "routine-a", homeRevision: "empty" };
  const prisma = {
    computer: {
      update: async () => {
        target.homeRevision = "working";
      },
    },
  } as unknown as PrismaClient;
  try {
    await home.writeFile("main-home", "script.py", "original", context);
    await seedRoutineComputer(prisma, home, "main-home", target, context);
    expect(await home.readFile(target.homeKey, "script.py", context)).toBe("original");
    await home.writeFile(target.homeKey, "script.py", "routine change", context);
    await seedRoutineComputer(prisma, home, "main-home", target, context);
    expect(await home.readFile("main-home", "script.py", context)).toBe("original");
    expect(await home.readFile(target.homeKey, "script.py", context)).toBe("routine change");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
