-- Per-routine operational memory and learned guidance.
--
-- A routine fires a fresh run on a fresh task each time, so nothing carried progress
-- between completed runs. Run.checkpoint stays dedicated to resuming one interrupted
-- execution; these tables remember progress across separate runs.

ALTER TABLE "routines" ADD COLUMN "doneCondition" TEXT;

CREATE TABLE "routine_states" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "routineId" TEXT NOT NULL REFERENCES "routines"("id") ON DELETE CASCADE,
 "schemaVersion" INTEGER NOT NULL DEFAULT 1,
 "lastCheckpoint" JSONB,
 "checkpointNote" TEXT,
 "verifiedNotes" TEXT,
 "unresolvedIssue" TEXT,
 "lastRunId" TEXT,
 "checkpointedAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX "routine_states_routineId_key" ON "routine_states"("routineId");

CREATE TABLE "routine_guidance" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "routineId" TEXT NOT NULL REFERENCES "routines"("id") ON DELETE CASCADE,
 "version" INTEGER NOT NULL,
 "text" TEXT NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'proposed',
 "sourceRunId" TEXT,
 "reason" TEXT,
 "evaluation" JSONB,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "activatedAt" TIMESTAMP(3)
);

CREATE UNIQUE INDEX "routine_guidance_routineId_version_key" ON "routine_guidance"("routineId", "version");
CREATE INDEX "routine_guidance_routineId_status_idx" ON "routine_guidance"("routineId", "status");

-- At most one active addendum per routine: a rollback activates an older row rather than
-- keeping two live versions that a run could pick from ambiguously.
CREATE UNIQUE INDEX "routine_guidance_one_active" ON "routine_guidance"("routineId") WHERE "status" = 'active';
