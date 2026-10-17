CREATE TABLE "task_goals" (
 "id" TEXT NOT NULL PRIMARY KEY, "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE,
 "botId" TEXT NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE, "userId" TEXT NOT NULL,
 "title" TEXT NOT NULL, "successCriteria" TEXT NOT NULL, "request" TEXT NOT NULL DEFAULT '', "checkpoint" TEXT NOT NULL DEFAULT '',
 "status" TEXT NOT NULL DEFAULT 'active', "steps" JSONB NOT NULL, "revision" INTEGER NOT NULL DEFAULT 0,
 "runId" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "task_goals_spaceId_botId_updatedAt_idx" ON "task_goals"("spaceId", "botId", "updatedAt");
CREATE UNIQUE INDEX "task_goals_one_open_per_bot" ON "task_goals"("botId") WHERE "status" IN ('active','paused','blocked');
