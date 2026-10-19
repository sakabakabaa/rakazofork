-- Let a routine run in the bot's main chat or in the background.
--
-- "main" keeps the current behaviour: the run posts into the bot's own conversation.
-- "background" runs in a thread owned by the routine, created on first use, so a chatty
-- schedule does not bury the conversation. Existing routines keep posting to main.

ALTER TABLE "routines" ADD COLUMN "threadMode" TEXT NOT NULL DEFAULT 'main';
