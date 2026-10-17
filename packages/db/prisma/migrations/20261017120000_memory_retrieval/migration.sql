-- Retrieval and identity metadata for durable memory.
--
-- Memory documents were identified only by path, so a rename changed identity and
-- nothing could be ranked, pinned, verified, or forgotten. These columns make the
-- store retrievable rather than a recency dump, and give Obsidian sync a stable id.
--
-- A plain CREATE INDEX is used rather than CONCURRENTLY: memory_documents holds a
-- handful of rows per user, and a transactional migration keeps this atomic.

ALTER TABLE "memory_documents"
  ADD COLUMN "noteId" TEXT,
  ADD COLUMN "kind" TEXT,
  ADD COLUMN "title" TEXT,
  ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "verifiedAt" TIMESTAMP(3),
  ADD COLUMN "pinned" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "contentHash" TEXT,
  ADD COLUMN "deletedAt" TIMESTAMP(3);

-- A note keeps its identity through a rename or move. Existing rows stay NULL until
-- they are rewritten; several NULLs are permitted under a unique constraint.
CREATE UNIQUE INDEX "memory_documents_note_key"
  ON "memory_documents" ("spaceId", "userId", "noteId");

-- Ranked full-text retrieval. The 'simple' configuration matches the messages index
-- (20261007010000_history_search) and keeps tokenisation predictable for mixed prose.
CREATE INDEX "memory_documents_search_idx"
  ON "memory_documents"
  USING GIN (to_tsvector('simple', coalesce("title", '') || ' ' || "content"));

-- Every read filters deleted documents and orders pinned first.
CREATE INDEX "memory_documents_live_idx"
  ON "memory_documents" ("spaceId", "userId", "scope", "deletedAt");
