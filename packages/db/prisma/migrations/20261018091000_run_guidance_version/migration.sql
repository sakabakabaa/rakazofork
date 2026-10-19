-- Which learned-guidance version a routine run executed with.
--
-- The exact instructions already live in the run's task prompt; this column makes the
-- version attributable without parsing prose, so the editor can show which runs support
-- the active guidance and a rollback can be traced to the runs it affects.

ALTER TABLE "runs" ADD COLUMN "guidanceVersion" INTEGER;
