ALTER TABLE "threads" ADD COLUMN "routineId" TEXT;
ALTER TABLE "threads" ADD CONSTRAINT "threads_routineId_fkey"
  FOREIGN KEY ("routineId") REFERENCES "routines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "threads_routineId_idx" ON "threads"("routineId");
ALTER TABLE "threads" DROP CONSTRAINT "threads_owner_chk";
ALTER TABLE "threads" ADD CONSTRAINT "threads_owner_chk" CHECK (
  num_nonnulls("botId", "groupId", "externalConversationId", "routineId") = 1
);
