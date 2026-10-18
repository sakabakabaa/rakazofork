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
    findUniqueOrThrow: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
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
  it("edits goal text with owner scope and revision protection", async () => {
    const f = fixture();
    const row = {
      id: "goal",
      spaceId: "space",
      userId: "owner",
      botId: "bot",
      title: "Old title",
      successCriteria: "Old criteria",
      request: "Do work",
      checkpoint: "",
      status: "active",
      steps: [{ id: "s1", title: "One", status: "pending" }],
      revision: 3,
      runId: "run",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    };
    f.taskGoal.findFirst.mockResolvedValue(row);
    f.taskGoal.updateMany.mockResolvedValue({ count: 1 });
    f.taskGoal.findUniqueOrThrow.mockResolvedValue({
      ...row,
      title: "New title",
      steps: [{ id: "s1", title: "Renamed step", status: "pending" }],
      revision: 4,
    });
    const updated = await f.client.goals.update({
      goalId: "goal",
      revision: 3,
      title: "New title",
      stepTitles: [{ stepId: "s1", title: "Renamed step" }],
    });
    expect(updated.title).toBe("New title");
    expect(updated.steps[0]).toMatchObject({ id: "s1", title: "Renamed step", status: "pending" });
    expect(f.taskGoal.updateMany.mock.calls[0]![0]).toMatchObject({
      where: { id: "goal", spaceId: "space", userId: "owner", revision: 3 },
      data: {
        title: "New title",
        steps: [{ id: "s1", title: "Renamed step", status: "pending" }],
        revision: { increment: 1 },
      },
    });
  });
  it("refuses to delete a goal after its revision changed", async () => {
    const f = fixture();
    f.taskGoal.findFirst.mockResolvedValue({
      id: "goal",
      botId: "bot",
      status: "completed",
      revision: 4,
    });
    f.taskGoal.updateMany.mockResolvedValue({ count: 0 });
    await expect(f.client.goals.delete({ goalId: "goal", revision: 3 })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(f.taskGoal.updateMany.mock.calls[0]![0].where).toMatchObject({
      id: "goal",
      revision: 3,
      spaceId: "space",
      userId: "owner",
    });
    expect(f.taskGoal.deleteMany).not.toHaveBeenCalled();
  });
  it("deletes a completed goal with compare-and-swap", async () => {
    const f = fixture();
    f.taskGoal.findFirst.mockResolvedValue({
      id: "goal",
      botId: "bot",
      status: "completed",
      revision: 4,
    });
    f.taskGoal.updateMany.mockResolvedValue({ count: 1 });
    f.taskGoal.deleteMany.mockResolvedValue({ count: 1 });
    await expect(f.client.goals.delete({ goalId: "goal", revision: 4 })).resolves.toEqual({
      ok: true,
    });
    expect(f.taskGoal.updateMany.mock.calls[0]![0]).toMatchObject({
      where: { id: "goal", spaceId: "space", userId: "owner", revision: 4 },
      data: { revision: { increment: 1 } },
    });
    expect(f.taskGoal.deleteMany.mock.calls[0]![0].where.revision).toBe(5);
  });
});
