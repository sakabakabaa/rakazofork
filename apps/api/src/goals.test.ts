import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

function fixture() {
  const bot = { findFirst: vi.fn().mockResolvedValue({ id: "bot" }) };
  const taskGoal = {
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn().mockResolvedValue(null),
    updateMany: vi.fn(),
  };
  const actor: Actor = {
    spaceId: "space",
    userId: "owner",
    email: "owner@example.test",
    isDeploymentOwner: true,
  };
  const deps = {
    prisma: { bot, taskGoal } as unknown as PrismaClient,
    env: {},
    dataDir: "/tmp/goals-fixture",
  } as unknown as RouterDeps;
  const client = createRouterClient(createRouter(deps), { context: { actor } as never });
  return { bot, taskGoal, client };
}
describe("goal API isolation", () => {
  it("checks bot ownership before listing goals and scopes every row", async () => {
    const f = fixture();
    expect(await f.client.goals.list({ botId: "bot" })).toEqual([]);
    expect(f.bot.findFirst.mock.calls[0]![0].where).toMatchObject({
      id: "bot",
      spaceId: "space",
      userId: "owner",
    });
    expect(f.taskGoal.findMany.mock.calls[0]![0].where).toEqual({
      botId: "bot",
      spaceId: "space",
      userId: "owner",
    });
  });
  it("does not expose another owner's goal to controls", async () => {
    const f = fixture();
    await expect(
      f.client.goals.control({ goalId: "foreign", revision: 1, action: "resume" }),
    ).rejects.toBeDefined();
    expect(f.taskGoal.findFirst.mock.calls[0]![0].where).toEqual({
      id: "foreign",
      spaceId: "space",
      userId: "owner",
    });
    expect(f.taskGoal.updateMany).not.toHaveBeenCalled();
  });
  it("rejects stale controls without creating a second run", async () => {
    const f = fixture();
    f.taskGoal.findFirst.mockResolvedValue({
      id: "goal",
      botId: "bot",
      status: "paused",
      revision: 2,
    });
    f.taskGoal.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      f.client.goals.control({ goalId: "goal", revision: 1, action: "resume" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.taskGoal.updateMany.mock.calls[0]![0].where).toMatchObject({
      revision: 1,
      spaceId: "space",
      userId: "owner",
    });
  });
});
