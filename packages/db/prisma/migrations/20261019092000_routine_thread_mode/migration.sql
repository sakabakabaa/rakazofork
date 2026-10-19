-- Let a routine run in the bot's main chat or in the background.
--
-- Every routine in production already posts into its own output thread, so "background" is
-- the default: deploying must not move a chatty schedule's output into the bot's
-- conversation. "main" is an opt-in for routines whose output belongs in the chat.

ALTER TABLE "routines" ADD COLUMN "threadMode" TEXT NOT NULL DEFAULT 'background';
