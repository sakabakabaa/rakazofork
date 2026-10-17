import { createHash, randomUUID } from "node:crypto";
import type {
  AdapterContext,
  MemoryCommitRequest,
  MemoryExportRequest,
  MemoryForgetRequest,
  MemoryForgetResult,
  MemoryRankedDocument,
  MemoryRankRequest,
  MemoryReadRequest,
  MemoryRevision,
  MemorySearchRequest,
  MemorySearchResult,
  MemorySnapshot,
  MemoryStore,
  PortableFile,
} from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import { Prisma, type PrismaClient, withTransactionRetry } from "@rakazo/db";

/** Columns that make up a document's retrieval metadata, shared by every read path. */
const META_SELECT = {
  noteId: true,
  kind: true,
  title: true,
  tags: true,
  verifiedAt: true,
  pinned: true,
  contentHash: true,
} as const;

export class MarkdownMemoryStore implements MemoryStore {
  constructor(private readonly prisma: PrismaClient) {}

  describe() {
    return {
      id: "markdown",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { search: true, revisions: true, markdownPortable: true },
    };
  }

  async read(request: MemoryReadRequest, context: AdapterContext): Promise<MemorySnapshot> {
    // A bot-scope read must name its bot. Without one the filter would silently widen
    // to every bot's private memory in the space, which is not a read any caller wants.
    if (request.scope === "bot" && !request.botId) {
      throw new Error("A bot-scope memory read requires a botId");
    }
    const documents = await this.prisma.memoryDocument.findMany({
      where: {
        spaceId: context.spaceId,
        userId: context.userId,
        scope: request.scope,
        ...(request.botId ? { botId: request.botId } : {}),
        ...(request.path ? { path: request.path } : {}),
        ...(request.includeDeleted ? {} : { deletedAt: null }),
      },
      orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }, { path: "asc" }],
      select: {
        id: true,
        path: true,
        content: true,
        revision: true,
        updatedAt: true,
        ...META_SELECT,
      },
    });
    return {
      documents: documents.map(toSnapshotDocument),
    };
  }

  async search(
    request: MemorySearchRequest,
    context: AdapterContext,
  ): Promise<MemorySearchResult[]> {
    const where = {
      spaceId: context.spaceId,
      userId: context.userId,
      deletedAt: null,
      ...(request.scope === "all" ? {} : { scope: request.scope }),
      ...(request.botId ? { botId: request.botId } : {}),
    };
    const query = request.query.trim();
    if (!query) return [];

    // Full-text first: it ranks by term frequency and ignores documents that do not
    // contain the terms, which a substring scan cannot do.
    const ranked = await this.rankIds(query, where);
    if (ranked.length > 0) {
      const byId = new Map(ranked.map((row) => [row.id, row.score]));
      const documents = await this.prisma.memoryDocument.findMany({
        where: { ...where, id: { in: [...byId.keys()] } },
        select: { id: true, path: true, content: true },
      });
      return documents
        .map((doc) => ({
          path: doc.path,
          snippet: snippet(doc.content, query),
          score: byId.get(doc.id) ?? 0,
        }))
        .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
    }

    // Fallback for partial words and paths, which plainto_tsquery does not match.
    const documents = await this.prisma.memoryDocument.findMany({
      where,
      select: { path: true, content: true },
    });
    const needle = query.toLowerCase();
    return documents
      .filter(
        (doc) =>
          doc.content.toLowerCase().includes(needle) || doc.path.toLowerCase().includes(needle),
      )
      .map((doc) => ({
        path: doc.path,
        snippet: snippet(doc.content, query),
        score: 1,
      }));
  }

  /**
   * Rank one bot's live documents: its own bot-scope documents plus the user-scope
   * documents shared within the space. Pinned documents lead, then full-text rank,
   * then recency — so a fresh prompt still sees the newest context when nothing matches.
   */
  async rank(request: MemoryRankRequest, context: AdapterContext): Promise<MemoryRankedDocument[]> {
    const limit = request.limit ?? 50;
    const scopeFilter = {
      spaceId: context.spaceId,
      userId: context.userId,
      deletedAt: null,
      OR: [{ scope: "user" }, { scope: "bot", botId: request.botId }],
    };
    const query = request.query.trim();
    const scores = query
      ? new Map((await this.rankIds(query, scopeFilter)).map((row) => [row.id, row.score]))
      : new Map<string, number>();

    const documents = await this.prisma.memoryDocument.findMany({
      where: scopeFilter,
      select: {
        id: true,
        path: true,
        content: true,
        revision: true,
        updatedAt: true,
        scope: true,
        ...META_SELECT,
      },
      orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
      take: limit,
    });

    return documents
      .map((doc) => ({
        ...toSnapshotDocument(doc),
        scope: doc.scope === "bot" ? ("bot" as const) : ("user" as const),
        score: scores.get(doc.id) ?? 0,
      }))
      .sort(
        (left, right) =>
          Number(right.pinned ?? false) - Number(left.pinned ?? false) ||
          right.score - left.score ||
          memoryTimestamp(right.updatedAt) - memoryTimestamp(left.updatedAt) ||
          left.path.localeCompare(right.path),
      );
  }

  async forget(request: MemoryForgetRequest, context: AdapterContext): Promise<MemoryForgetResult> {
    if (request.scope === "bot" && !request.botId) {
      throw new Error("A bot-scope memory forget requires a botId");
    }
    const where = {
      spaceId: context.spaceId,
      userId: context.userId,
      scope: request.scope,
      botId: request.botId ?? null,
      path: request.path,
      deletedAt: null,
    };
    const deletedAt = new Date();
    // Revisions are kept: forgetting a memory is not the same as losing the history
    // that explains where it came from.
    const { count } = await this.prisma.memoryDocument.updateMany({
      where,
      data: { deletedAt },
    });
    return count > 0
      ? { path: request.path, forgotten: true, deletedAt: deletedAt.toISOString() }
      : { path: request.path, forgotten: false };
  }

  async commit(request: MemoryCommitRequest, context: AdapterContext): Promise<MemoryRevision> {
    // A save replaces the current content and appends its history atomically.
    // Conflicts retry the whole transaction so revision numbers use fresh state.
    return withTransactionRetry(() =>
      this.prisma.$transaction(
        async (tx) => {
          const existing = await tx.memoryDocument.findFirst({
            where: {
              spaceId: context.spaceId,
              userId: context.userId,
              scope: request.scope,
              botId: request.botId ?? null,
              path: request.path,
            },
          });
          if (request.expectedRevision !== undefined) {
            const live = existing?.revision ?? 0;
            if (live !== request.expectedRevision) throw new Error(MEMORY_REVISION_CONFLICT_ERROR);
          }
          const meta = metadataPatch(request);
          const doc = existing
            ? await tx.memoryDocument.update({
                where: { id: existing.id },
                data: {
                  content: request.content,
                  revision: existing.revision + 1,
                  contentHash: contentHash(request.content),
                  // Re-saving a forgotten path brings it back deliberately.
                  deletedAt: null,
                  ...meta,
                },
              })
            : await tx.memoryDocument.create({
                data: {
                  spaceId: context.spaceId,
                  userId: context.userId,
                  botId: request.botId,
                  scope: request.scope,
                  path: request.path,
                  content: request.content,
                  contentHash: contentHash(request.content),
                  noteId: request.noteId ?? randomUUID(),
                  ...meta,
                },
              });
          await tx.memoryRevision.create({
            data: {
              documentId: doc.id,
              revision: doc.revision,
              content: request.content,
              sourceRunId: request.sourceRunId,
              sourceThreadId: request.sourceThreadId,
            },
          });
          return { id: doc.id, path: doc.path, revision: doc.revision, content: doc.content };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }

  async *exportMarkdown(
    request: MemoryExportRequest,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    const snapshot = await this.read(
      { scope: request.scope === "all" ? "user" : request.scope, botId: request.botId },
      context,
    );
    for (const doc of snapshot.documents) {
      yield { path: doc.path, content: new TextEncoder().encode(doc.content) };
    }
  }

  async importMarkdown(
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<MemoryRevision> {
    let last: MemoryRevision | undefined;
    for await (const file of files) {
      last = await this.commit(
        {
          scope: "user",
          path: file.path,
          content: new TextDecoder().decode(file.content),
        },
        context,
      );
    }
    if (!last) throw new Error("No memory files to import");
    return last;
  }

  /**
   * Full-text ranking over a scoped set. The scoped ids come from Prisma rather than
   * hand-written SQL, so ranking cannot drift from the isolation rules; the raw query
   * then only computes `ts_rank` for those ids. `plainto_tsquery` matches whole terms,
   * which is what ranks a prompt against stored prose.
   */
  private async rankIds(
    query: string,
    where: Prisma.MemoryDocumentWhereInput,
  ): Promise<Array<{ id: string; score: number }>> {
    const documents = await this.prisma.memoryDocument.findMany({
      where,
      select: { id: true },
    });
    if (documents.length === 0) return [];
    const ids = documents.map((doc) => doc.id);
    return this.prisma.$queryRaw<Array<{ id: string; score: number }>>`
      SELECT "id",
             ts_rank(
               to_tsvector('simple', coalesce("title", '') || ' ' || "content"),
               plainto_tsquery('simple', ${query})
             ) AS "score"
      FROM "memory_documents"
      WHERE "id" = ANY(${ids})
        AND to_tsvector('simple', coalesce("title", '') || ' ' || "content")
            @@ plainto_tsquery('simple', ${query})
      ORDER BY "score" DESC
    `;
  }
}

/** Only fields the caller supplied are written, so a partial commit keeps the rest. */
function metadataPatch(request: MemoryCommitRequest) {
  return {
    ...(request.kind !== undefined ? { kind: request.kind } : {}),
    ...(request.title !== undefined ? { title: request.title } : {}),
    ...(request.tags !== undefined ? { tags: request.tags } : {}),
    ...(request.pinned !== undefined ? { pinned: request.pinned } : {}),
    ...(request.verifiedAt !== undefined ? { verifiedAt: new Date(request.verifiedAt) } : {}),
  };
}

function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function toSnapshotDocument(doc: {
  id: string;
  path: string;
  content: string;
  revision: number;
  updatedAt: Date;
  noteId?: string | null;
  kind?: string | null;
  title?: string | null;
  tags?: string[];
  verifiedAt?: Date | null;
  pinned?: boolean;
  contentHash?: string | null;
}): MemorySnapshot["documents"][number] {
  return {
    id: doc.id,
    path: doc.path,
    content: doc.content,
    revision: doc.revision,
    updatedAt: doc.updatedAt.toISOString(),
    ...(doc.noteId ? { noteId: doc.noteId } : {}),
    ...(doc.kind ? { kind: doc.kind } : {}),
    ...(doc.title ? { title: doc.title } : {}),
    ...(doc.tags && doc.tags.length > 0 ? { tags: doc.tags } : {}),
    ...(doc.verifiedAt ? { verifiedAt: doc.verifiedAt.toISOString() } : {}),
    ...(doc.pinned ? { pinned: true } : {}),
    ...(doc.contentHash ? { contentHash: doc.contentHash } : {}),
  };
}

function snippet(content: string, q: string): string {
  const idx = content.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return content.slice(0, 140);
  return content.slice(Math.max(0, idx - 40), idx + q.length + 80);
}

function memoryTimestamp(updatedAt: string | undefined): number {
  const timestamp = Date.parse(updatedAt ?? "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}
