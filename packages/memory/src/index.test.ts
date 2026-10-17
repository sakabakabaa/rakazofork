import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { MarkdownMemoryStore } from "./index.js";

const context: AdapterContext = {
  operationId: "read-memory",
  traceId: "read-memory",
  spaceId: "workspace-1",
  userId: "user-1",
  signal: new AbortController().signal,
};

describe("memory store contract shape", () => {
  it("declares markdown portability", () => {
    const store = new MarkdownMemoryStore({} as never);
    expect(store.describe().capabilities.markdownPortable).toBe(true);
  });

  it("reads the most recently updated documents first", async () => {
    const updatedAt = new Date("2026-08-16T10:00:00.000Z");
    const findMany = vi
      .fn()
      .mockResolvedValue([
        { id: "memory-1", path: "facts.md", content: "A fact", revision: 3, updatedAt },
      ]);
    const store = new MarkdownMemoryStore({ memoryDocument: { findMany } } as never);

    await expect(store.read({ scope: "bot", botId: "bot-1" }, context)).resolves.toEqual({
      documents: [
        {
          id: "memory-1",
          path: "facts.md",
          content: "A fact",
          revision: 3,
          updatedAt: updatedAt.toISOString(),
        },
      ],
    });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        spaceId: "workspace-1",
        userId: "user-1",
        scope: "bot",
        botId: "bot-1",
        deletedAt: null,
      },
      // Pinned documents lead the list; a forgotten one is filtered out above.
      orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }, { path: "asc" }],
      select: {
        id: true,
        path: true,
        content: true,
        revision: true,
        updatedAt: true,
        noteId: true,
        kind: true,
        title: true,
        tags: true,
        verifiedAt: true,
        pinned: true,
        contentHash: true,
      },
    });
  });
});

describe("retrieval and forgetting", () => {
  it("refuses a bot-scope read that names no bot", async () => {
    const store = new MarkdownMemoryStore({ memoryDocument: { findMany: vi.fn() } } as never);
    // Without this guard the filter silently widens to every bot's private memory.
    await expect(store.read({ scope: "bot" }, context)).rejects.toThrow(/requires a botId/);
  });

  it("orders pinned first, then full-text rank, then recency", async () => {
    const updatedAt = new Date("2026-08-16T10:00:00.000Z");
    const rows = [
      {
        id: "old-match",
        path: "b.md",
        content: "deploy notes",
        revision: 1,
        updatedAt,
        scope: "user",
      },
      {
        id: "new-nomatch",
        path: "c.md",
        content: "unrelated",
        revision: 1,
        updatedAt: new Date("2026-08-17T10:00:00.000Z"),
        scope: "user",
      },
      {
        id: "pinned",
        path: "a.md",
        content: "unrelated",
        revision: 1,
        updatedAt,
        scope: "user",
        pinned: true,
      },
    ];
    const store = new MarkdownMemoryStore({
      memoryDocument: { findMany: vi.fn().mockResolvedValue(rows) },
      $queryRaw: vi.fn().mockResolvedValue([{ id: "old-match", score: 0.5 }]),
    } as never);

    const ranked = await store.rank({ query: "deploy", botId: "bot-1" }, context);
    expect(ranked.map((doc) => doc.path)).toEqual(["a.md", "b.md", "c.md"]);
    expect(ranked[1]?.score).toBe(0.5);
  });

  it("keeps revisions when a document is forgotten", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const store = new MarkdownMemoryStore({ memoryDocument: { updateMany } } as never);

    const result = await store.forget({ scope: "user", path: "MEMORY.md" }, context);
    expect(result.forgotten).toBe(true);
    // Soft delete only: no delete call anywhere, so the history survives.
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        spaceId: "workspace-1",
        userId: "user-1",
        scope: "user",
        botId: null,
        path: "MEMORY.md",
        deletedAt: null,
      },
      data: { deletedAt: expect.any(Date) },
    });
  });

  it("reports a miss when there is nothing live to forget", async () => {
    const store = new MarkdownMemoryStore({
      memoryDocument: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    } as never);
    await expect(store.forget({ scope: "user", path: "gone.md" }, context)).resolves.toEqual({
      path: "gone.md",
      forgotten: false,
    });
  });
});
