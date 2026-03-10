import type { DbClient } from "../db/db-interface.js";
import { sanitizeFts5Query } from "./fts5-sanitize.js";
import { sanitizeTsQuery } from "./tsquery-sanitize.js";
import { buildLikeSearchPlan, createFallbackSnippet } from "./full-text-fallback.js";

export type SummaryKind = "leaf" | "condensed";
export type ContextItemType = "message" | "summary";

export type CreateSummaryInput = {
  summaryId: string;
  conversationId: number;
  kind: SummaryKind;
  depth?: number;
  content: string;
  tokenCount: number;
  fileIds?: string[];
  earliestAt?: Date;
  latestAt?: Date;
  descendantCount?: number;
  descendantTokenCount?: number;
  sourceMessageTokenCount?: number;
};

export type SummaryRecord = {
  summaryId: string;
  conversationId: number;
  kind: SummaryKind;
  depth: number;
  content: string;
  tokenCount: number;
  fileIds: string[];
  earliestAt: Date | null;
  latestAt: Date | null;
  descendantCount: number;
  descendantTokenCount: number;
  sourceMessageTokenCount: number;
  createdAt: Date;
};

export type SummarySubtreeNodeRecord = SummaryRecord & {
  depthFromRoot: number;
  parentSummaryId: string | null;
  path: string;
  childCount: number;
};

export type ContextItemRecord = {
  conversationId: number;
  ordinal: number;
  itemType: ContextItemType;
  messageId: number | null;
  summaryId: string | null;
  createdAt: Date;
};

export type SummarySearchInput = {
  conversationId?: number;
  query: string;
  mode: "regex" | "full_text";
  since?: Date;
  before?: Date;
  limit?: number;
};

export type SummarySearchResult = {
  summaryId: string;
  conversationId: number;
  kind: SummaryKind;
  snippet: string;
  createdAt: Date;
  rank?: number;
};

export type CreateLargeFileInput = {
  fileId: string;
  conversationId: number;
  fileName?: string;
  mimeType?: string;
  byteSize?: number;
  storageUri: string;
  explorationSummary?: string;
};

export type LargeFileRecord = {
  fileId: string;
  conversationId: number;
  fileName: string | null;
  mimeType: string | null;
  byteSize: number | null;
  storageUri: string;
  explorationSummary: string | null;
  createdAt: Date;
};

// ── DB row shapes (snake_case) ────────────────────────────────────────────────

interface SummaryRow {
  summary_id: string;
  conversation_id: number;
  kind: SummaryKind;
  depth: number;
  content: string;
  token_count: number;
  file_ids: string;
  earliest_at: string | null;
  latest_at: string | null;
  descendant_count: number | null;
  descendant_token_count: number | null;
  source_message_token_count: number | null;
  created_at: string;
}

interface SummarySubtreeRow extends SummaryRow {
  depth_from_root: number;
  parent_summary_id: string | null;
  path: string;
  child_count: number | null;
}

interface ContextItemRow {
  conversation_id: number;
  ordinal: number;
  item_type: ContextItemType;
  message_id: number | null;
  summary_id: string | null;
  created_at: string;
}

interface SummarySearchRow {
  summary_id: string;
  conversation_id: number;
  kind: SummaryKind;
  snippet: string;
  rank: number;
  created_at: string;
}

interface MaxOrdinalRow {
  max_ordinal: number;
}

interface DistinctDepthRow {
  depth: number;
}

interface TokenSumRow {
  total: number;
}

interface MessageIdRow {
  message_id: number;
}

interface LargeFileRow {
  file_id: string;
  conversation_id: number;
  file_name: string | null;
  mime_type: string | null;
  byte_size: number | null;
  storage_uri: string;
  exploration_summary: string | null;
  created_at: string;
}

// ── Row mappers ───────────────────────────────────────────────────────────────

function toSummaryRecord(row: SummaryRow): SummaryRecord {
  let fileIds: string[] = [];
  try {
    fileIds = JSON.parse(row.file_ids);
  } catch {
    // ignore malformed JSON
  }
  return {
    summaryId: row.summary_id,
    conversationId: row.conversation_id,
    kind: row.kind,
    depth: row.depth,
    content: row.content,
    tokenCount: row.token_count,
    fileIds,
    earliestAt: row.earliest_at ? new Date(row.earliest_at) : null,
    latestAt: row.latest_at ? new Date(row.latest_at) : null,
    descendantCount:
      typeof row.descendant_count === "number" &&
      Number.isFinite(row.descendant_count) &&
      row.descendant_count >= 0
        ? Math.floor(row.descendant_count)
        : 0,
    descendantTokenCount:
      typeof row.descendant_token_count === "number" &&
      Number.isFinite(row.descendant_token_count) &&
      row.descendant_token_count >= 0
        ? Math.floor(row.descendant_token_count)
        : 0,
    sourceMessageTokenCount:
      typeof row.source_message_token_count === "number" &&
      Number.isFinite(row.source_message_token_count) &&
      row.source_message_token_count >= 0
        ? Math.floor(row.source_message_token_count)
        : 0,
    createdAt: new Date(row.created_at),
  };
}

function toContextItemRecord(row: ContextItemRow): ContextItemRecord {
  return {
    conversationId: row.conversation_id,
    ordinal: row.ordinal,
    itemType: row.item_type,
    messageId: row.message_id,
    summaryId: row.summary_id,
    createdAt: new Date(row.created_at),
  };
}

function toSearchResult(row: SummarySearchRow): SummarySearchResult {
  return {
    summaryId: row.summary_id,
    conversationId: row.conversation_id,
    kind: row.kind,
    snippet: row.snippet,
    createdAt: new Date(row.created_at),
    rank: row.rank,
  };
}

function toLargeFileRecord(row: LargeFileRow): LargeFileRecord {
  return {
    fileId: row.file_id,
    conversationId: row.conversation_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    storageUri: row.storage_uri,
    explorationSummary: row.exploration_summary,
    createdAt: new Date(row.created_at),
  };
}

// ── SummaryStore ──────────────────────────────────────────────────────────────

export class SummaryStore {
  private readonly fts5Available: boolean;
  private readonly backend: 'sqlite' | 'postgres';

  constructor(
    private db: DbClient,
    options?: { fts5Available?: boolean; backend?: 'sqlite' | 'postgres' },
  ) {
    this.fts5Available = options?.fts5Available ?? true;
    this.backend = options?.backend ?? 'sqlite';
  }

  // ── Summary CRUD ──────────────────────────────────────────────────────────

  async insertSummary(input: CreateSummaryInput): Promise<SummaryRecord> {
    const fileIds = JSON.stringify(input.fileIds ?? []);
    const earliestAt = input.earliestAt instanceof Date ? input.earliestAt.toISOString() : null;
    const latestAt = input.latestAt instanceof Date ? input.latestAt.toISOString() : null;
    const descendantCount =
      typeof input.descendantCount === "number" &&
      Number.isFinite(input.descendantCount) &&
      input.descendantCount >= 0
        ? Math.floor(input.descendantCount)
        : 0;
    const descendantTokenCount =
      typeof input.descendantTokenCount === "number" &&
      Number.isFinite(input.descendantTokenCount) &&
      input.descendantTokenCount >= 0
        ? Math.floor(input.descendantTokenCount)
        : 0;
    const sourceMessageTokenCount =
      typeof input.sourceMessageTokenCount === "number" &&
      Number.isFinite(input.sourceMessageTokenCount) &&
      input.sourceMessageTokenCount >= 0
        ? Math.floor(input.sourceMessageTokenCount)
        : 0;
    const depth =
      typeof input.depth === "number" && Number.isFinite(input.depth) && input.depth >= 0
        ? Math.floor(input.depth)
        : input.kind === "leaf"
          ? 0
          : 1;

    await this.db.run(
      `INSERT INTO summaries (
        summary_id,
        conversation_id,
        kind,
        depth,
        content,
        token_count,
        file_ids,
        earliest_at,
        latest_at,
        descendant_count,
        descendant_token_count,
        source_message_token_count
      )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.summaryId,
        input.conversationId,
        input.kind,
        depth,
        input.content,
        input.tokenCount,
        fileIds,
        earliestAt,
        latestAt,
        descendantCount,
        descendantTokenCount,
        sourceMessageTokenCount,
      ],
    );

    const row = await this.db.queryOne<SummaryRow>(
      `SELECT summary_id, conversation_id, kind, depth, content, token_count, file_ids,
              earliest_at, latest_at, descendant_count, created_at
              , descendant_token_count, source_message_token_count
     FROM summaries WHERE summary_id = ?`,
      [input.summaryId],
    );

    if (!row) {
      throw new Error(`Failed to retrieve inserted summary ${input.summaryId}`);
    }

    // Index in FTS5 as best-effort; compaction flow must continue even if
    // FTS indexing fails for any reason.
    if (!this.fts5Available) {
      return toSummaryRecord(row);
    }

    try {
      await this.db.run(`INSERT INTO summaries_fts(summary_id, content) VALUES (?, ?)`, [
        input.summaryId,
        input.content,
      ]);
    } catch {
      // FTS indexing failed — search won't find this summary but
      // compaction and assembly will still work correctly.
    }

    return toSummaryRecord(row);
  }

  async getSummary(summaryId: string): Promise<SummaryRecord | null> {
    const row = await this.db.queryOne<SummaryRow>(
      `SELECT summary_id, conversation_id, kind, depth, content, token_count, file_ids,
              earliest_at, latest_at, descendant_count, created_at
              , descendant_token_count, source_message_token_count
     FROM summaries WHERE summary_id = ?`,
      [summaryId],
    );
    return row ? toSummaryRecord(row) : null;
  }

  async getSummariesByConversation(conversationId: number): Promise<SummaryRecord[]> {
    const result = await this.db.query<SummaryRow>(
      `SELECT summary_id, conversation_id, kind, depth, content, token_count, file_ids,
              earliest_at, latest_at, descendant_count, created_at
              , descendant_token_count, source_message_token_count
     FROM summaries
     WHERE conversation_id = ?
     ORDER BY created_at`,
      [conversationId],
    );
    return result.rows.map(toSummaryRecord);
  }

  // ── Lineage ───────────────────────────────────────────────────────────────

  async linkSummaryToMessages(summaryId: string, messageIds: number[]): Promise<void> {
    if (messageIds.length === 0) {
      return;
    }

    for (let idx = 0; idx < messageIds.length; idx++) {
      await this.db.run(
        `INSERT INTO summary_messages (summary_id, message_id, ordinal)
         VALUES (?, ?, ?)
         ON CONFLICT (summary_id, message_id) DO NOTHING`,
        [summaryId, messageIds[idx], idx],
      );
    }
  }

  async linkSummaryToParents(summaryId: string, parentSummaryIds: string[]): Promise<void> {
    if (parentSummaryIds.length === 0) {
      return;
    }

    for (let idx = 0; idx < parentSummaryIds.length; idx++) {
      await this.db.run(
        `INSERT INTO summary_parents (summary_id, parent_summary_id, ordinal)
         VALUES (?, ?, ?)
         ON CONFLICT (summary_id, parent_summary_id) DO NOTHING`,
        [summaryId, parentSummaryIds[idx], idx],
      );
    }
  }

  async getSummaryMessages(summaryId: string): Promise<number[]> {
    const result = await this.db.query<MessageIdRow>(
      `SELECT message_id FROM summary_messages
     WHERE summary_id = ?
     ORDER BY ordinal`,
      [summaryId],
    );
    return result.rows.map((r) => r.message_id);
  }

  async getSummaryChildren(parentSummaryId: string): Promise<SummaryRecord[]> {
    const result = await this.db.query<SummaryRow>(
      `SELECT s.summary_id, s.conversation_id, s.kind, s.depth, s.content, s.token_count,
              s.file_ids, s.earliest_at, s.latest_at, s.descendant_count, s.created_at
              , s.descendant_token_count, s.source_message_token_count
     FROM summaries s
     JOIN summary_parents sp ON sp.summary_id = s.summary_id
     WHERE sp.parent_summary_id = ?
     ORDER BY sp.ordinal`,
      [parentSummaryId],
    );
    return result.rows.map(toSummaryRecord);
  }

  async getSummaryParents(summaryId: string): Promise<SummaryRecord[]> {
    const result = await this.db.query<SummaryRow>(
      `SELECT s.summary_id, s.conversation_id, s.kind, s.depth, s.content, s.token_count,
              s.file_ids, s.earliest_at, s.latest_at, s.descendant_count, s.created_at
              , s.descendant_token_count, s.source_message_token_count
     FROM summaries s
     JOIN summary_parents sp ON sp.parent_summary_id = s.summary_id
     WHERE sp.summary_id = ?
     ORDER BY sp.ordinal`,
      [summaryId],
    );
    return result.rows.map(toSummaryRecord);
  }

  async getSummarySubtree(summaryId: string): Promise<SummarySubtreeNodeRecord[]> {
    const result = await this.db.query<SummarySubtreeRow>(
      `WITH RECURSIVE subtree(summary_id, parent_summary_id, depth_from_root, path) AS (
         SELECT ?, NULL, 0, ''
         UNION ALL
         SELECT
           sp.summary_id,
           sp.parent_summary_id,
           subtree.depth_from_root + 1,
           CASE
             WHEN subtree.path = '' THEN printf('%04d', sp.ordinal)
             ELSE subtree.path || '.' || printf('%04d', sp.ordinal)
           END
         FROM summary_parents sp
         JOIN subtree ON sp.parent_summary_id = subtree.summary_id
       )
       SELECT
         s.summary_id,
         s.conversation_id,
         s.kind,
         s.depth,
         s.content,
         s.token_count,
         s.file_ids,
         s.earliest_at,
         s.latest_at,
         s.descendant_count,
         s.descendant_token_count,
         s.source_message_token_count,
         s.created_at,
         subtree.depth_from_root,
         subtree.parent_summary_id,
         subtree.path,
         (
           SELECT COUNT(*) FROM summary_parents sp2
           WHERE sp2.parent_summary_id = s.summary_id
         ) AS child_count
       FROM subtree
       JOIN summaries s ON s.summary_id = subtree.summary_id
       ORDER BY subtree.depth_from_root ASC, subtree.path ASC, s.created_at ASC`,
      [summaryId],
    );

    const rows = result.rows;
    const seen = new Set<string>();
    const output: SummarySubtreeNodeRecord[] = [];
    for (const row of rows) {
      if (seen.has(row.summary_id)) {
        continue;
      }
      seen.add(row.summary_id);
      output.push({
        ...toSummaryRecord(row),
        depthFromRoot: Math.max(0, Math.floor(row.depth_from_root ?? 0)),
        parentSummaryId: row.parent_summary_id ?? null,
        path: typeof row.path === "string" ? row.path : "",
        childCount:
          typeof row.child_count === "number" && Number.isFinite(row.child_count)
            ? Math.max(0, Math.floor(row.child_count))
            : 0,
      });
    }
    return output;
  }

  // ── Context items ─────────────────────────────────────────────────────────

  async getContextItems(conversationId: number): Promise<ContextItemRecord[]> {
    const result = await this.db.query<ContextItemRow>(
      `SELECT conversation_id, ordinal, item_type, message_id, summary_id, created_at
     FROM context_items
     WHERE conversation_id = ?
     ORDER BY ordinal`,
      [conversationId],
    );
    return result.rows.map(toContextItemRecord);
  }

  async getDistinctDepthsInContext(
    conversationId: number,
    options?: { maxOrdinalExclusive?: number },
  ): Promise<number[]> {
    const maxOrdinalExclusive = options?.maxOrdinalExclusive;
    const useOrdinalBound =
      typeof maxOrdinalExclusive === "number" &&
      Number.isFinite(maxOrdinalExclusive) &&
      maxOrdinalExclusive !== Infinity;

    const sql = useOrdinalBound
      ? `SELECT DISTINCT s.depth
         FROM context_items ci
         JOIN summaries s ON s.summary_id = ci.summary_id
         WHERE ci.conversation_id = ?
           AND ci.item_type = 'summary'
           AND ci.ordinal < ?
         ORDER BY s.depth ASC`
      : `SELECT DISTINCT s.depth
         FROM context_items ci
         JOIN summaries s ON s.summary_id = ci.summary_id
         WHERE ci.conversation_id = ?
           AND ci.item_type = 'summary'
         ORDER BY s.depth ASC`;

    const result = useOrdinalBound
      ? await this.db.query<DistinctDepthRow>(sql, [conversationId, Math.floor(maxOrdinalExclusive)])
      : await this.db.query<DistinctDepthRow>(sql, [conversationId]);

    return result.rows.map((row) => row.depth);
  }

  async appendContextMessage(conversationId: number, messageId: number): Promise<void> {
    const row = await this.db.queryOne<MaxOrdinalRow>(
      `SELECT COALESCE(MAX(ordinal), -1) AS max_ordinal
     FROM context_items WHERE conversation_id = ?`,
      [conversationId],
    );

    await this.db.run(
      `INSERT INTO context_items (conversation_id, ordinal, item_type, message_id)
     VALUES (?, ?, 'message', ?)`,
      [conversationId, row?.max_ordinal ?? -1 + 1, messageId],
    );
  }

  async appendContextMessages(conversationId: number, messageIds: number[]): Promise<void> {
    if (messageIds.length === 0) {
      return;
    }

    const row = await this.db.queryOne<MaxOrdinalRow>(
      `SELECT COALESCE(MAX(ordinal), -1) AS max_ordinal
     FROM context_items WHERE conversation_id = ?`,
      [conversationId],
    );
    const baseOrdinal = (row?.max_ordinal ?? -1) + 1;

    for (let idx = 0; idx < messageIds.length; idx++) {
      await this.db.run(
        `INSERT INTO context_items (conversation_id, ordinal, item_type, message_id)
         VALUES (?, ?, 'message', ?)`,
        [conversationId, baseOrdinal + idx, messageIds[idx]],
      );
    }
  }

  async appendContextSummary(conversationId: number, summaryId: string): Promise<void> {
    const row = await this.db.queryOne<MaxOrdinalRow>(
      `SELECT COALESCE(MAX(ordinal), -1) AS max_ordinal
     FROM context_items WHERE conversation_id = ?`,
      [conversationId],
    );

    await this.db.run(
      `INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id)
     VALUES (?, ?, 'summary', ?)`,
      [conversationId, row?.max_ordinal ?? -1 + 1, summaryId],
    );
  }

  async replaceContextRangeWithSummary(input: {
    conversationId: number;
    startOrdinal: number;
    endOrdinal: number;
    summaryId: string;
  }): Promise<void> {
    const { conversationId, startOrdinal, endOrdinal, summaryId } = input;

    await this.db.run("BEGIN");
    try {
      // 1. Delete context items in the range [startOrdinal, endOrdinal]
      await this.db.run(
        `DELETE FROM context_items
       WHERE conversation_id = ?
         AND ordinal >= ?
         AND ordinal <= ?`,
        [conversationId, startOrdinal, endOrdinal],
      );

      // 2. Insert the replacement summary item at startOrdinal
      await this.db.run(
        `INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id)
       VALUES (?, ?, 'summary', ?)`,
        [conversationId, startOrdinal, summaryId],
      );

      // 3. Resequence all ordinals to maintain contiguity (no gaps).
      //    Fetch current items, then update ordinals in order.
      const result = await this.db.query<{ ordinal: number }>(
        `SELECT ordinal FROM context_items
       WHERE conversation_id = ?
       ORDER BY ordinal`,
        [conversationId],
      );
      const items = result.rows;

      // Use negative temp ordinals first to avoid unique constraint conflicts
      for (let i = 0; i < items.length; i++) {
        await this.db.run(
          `UPDATE context_items
         SET ordinal = ?
         WHERE conversation_id = ? AND ordinal = ?`,
          [-(i + 1), conversationId, items[i].ordinal],
        );
      }
      for (let i = 0; i < items.length; i++) {
        await this.db.run(
          `UPDATE context_items
         SET ordinal = ?
         WHERE conversation_id = ? AND ordinal = ?`,
          [i, conversationId, -(i + 1)],
        );
      }

      await this.db.run("COMMIT");
    } catch (err) {
      await this.db.run("ROLLBACK");
      throw err;
    }
  }

  async getContextTokenCount(conversationId: number): Promise<number> {
    const row = await this.db.queryOne<TokenSumRow>(
      `SELECT COALESCE(SUM(token_count), 0) AS total
     FROM (
       SELECT m.token_count
       FROM context_items ci
       JOIN messages m ON m.message_id = ci.message_id
       WHERE ci.conversation_id = ?
         AND ci.item_type = 'message'

       UNION ALL

       SELECT s.token_count
       FROM context_items ci
       JOIN summaries s ON s.summary_id = ci.summary_id
       WHERE ci.conversation_id = ?
         AND ci.item_type = 'summary'
     ) sub`,
      [conversationId, conversationId],
    );
    return row?.total ?? 0;
  }

  // ── Search ────────────────────────────────────────────────────────────────

  async searchSummaries(input: SummarySearchInput): Promise<SummarySearchResult[]> {
    const limit = input.limit ?? 50;

    if (input.mode === "full_text") {
      if (this.fts5Available) {
        try {
          return this.searchFullText(
            input.query,
            limit,
            input.conversationId,
            input.since,
            input.before,
          );
        } catch {
          return this.searchLike(
            input.query,
            limit,
            input.conversationId,
            input.since,
            input.before,
          );
        }
      }
      return this.searchLike(input.query, limit, input.conversationId, input.since, input.before);
    }
    return this.searchRegex(input.query, limit, input.conversationId, input.since, input.before);
  }

  private async searchFullText(
    query: string,
    limit: number,
    conversationId?: number,
    since?: Date,
    before?: Date,
  ): Promise<SummarySearchResult[]> {
    const where: string[] = ["summaries_fts MATCH ?"];
    const args: Array<string | number> = [sanitizeFts5Query(query)];
    if (conversationId != null) {
      where.push("s.conversation_id = ?");
      args.push(conversationId);
    }
    if (since) {
      where.push("julianday(s.created_at) >= julianday(?)");
      args.push(since.toISOString());
    }
    if (before) {
      where.push("julianday(s.created_at) < julianday(?)");
      args.push(before.toISOString());
    }
    args.push(limit);

    const sql = `SELECT
         summaries_fts.summary_id,
         s.conversation_id,
         s.kind,
         snippet(summaries_fts, 1, '', '', '...', 32) AS snippet,
         rank,
         s.created_at
       FROM summaries_fts
       JOIN summaries s ON s.summary_id = summaries_fts.summary_id
       WHERE ${where.join(" AND ")}
       ORDER BY s.created_at DESC
       LIMIT ?`;
    const result = await this.db.query<SummarySearchRow>(sql, args);
    return result.rows.map(toSearchResult);
  }

  private async searchLike(
    query: string,
    limit: number,
    conversationId?: number,
    since?: Date,
    before?: Date,
  ): Promise<SummarySearchResult[]> {
    const plan = buildLikeSearchPlan("content", query);
    if (plan.terms.length === 0) {
      return [];
    }

    const where: string[] = [...plan.where];
    const args: Array<string | number> = [...plan.args];
    if (conversationId != null) {
      where.push("conversation_id = ?");
      args.push(conversationId);
    }
    if (since) {
      where.push("julianday(created_at) >= julianday(?)");
      args.push(since.toISOString());
    }
    if (before) {
      where.push("julianday(created_at) < julianday(?)");
      args.push(before.toISOString());
    }
    args.push(limit);

    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const result = await this.db.query<SummaryRow>(
      `SELECT summary_id, conversation_id, kind, depth, content, token_count, file_ids,
              earliest_at, latest_at, descendant_count, descendant_token_count,
              source_message_token_count, created_at
       FROM summaries
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT ?`,
      args,
    );

    return result.rows.map((row) => ({
      summaryId: row.summary_id,
      conversationId: row.conversation_id,
      kind: row.kind,
      snippet: createFallbackSnippet(row.content, plan.terms),
      createdAt: new Date(row.created_at),
      rank: 0,
    }));
  }

  private async searchRegex(
    pattern: string,
    limit: number,
    conversationId?: number,
    since?: Date,
    before?: Date,
  ): Promise<SummarySearchResult[]> {
    const re = new RegExp(pattern);

    const where: string[] = [];
    const args: Array<string | number> = [];
    if (conversationId != null) {
      where.push("conversation_id = ?");
      args.push(conversationId);
    }
    if (since) {
      where.push("julianday(created_at) >= julianday(?)");
      args.push(since.toISOString());
    }
    if (before) {
      where.push("julianday(created_at) < julianday(?)");
      args.push(before.toISOString());
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const result = await this.db.query<SummaryRow>(
      `SELECT summary_id, conversation_id, kind, depth, content, token_count, file_ids,
              earliest_at, latest_at, descendant_count, descendant_token_count,
              source_message_token_count, created_at
       FROM summaries
       ${whereClause}
       ORDER BY created_at DESC`,
      args,
    );

    const results: SummarySearchResult[] = [];
    for (const row of result.rows) {
      if (results.length >= limit) {
        break;
      }
      const match = re.exec(row.content);
      if (match) {
        results.push({
          summaryId: row.summary_id,
          conversationId: row.conversation_id,
          kind: row.kind,
          snippet: match[0],
          createdAt: new Date(row.created_at),
          rank: 0,
        });
      }
    }
    return results;
  }

  // ── Large files ───────────────────────────────────────────────────────────

  async insertLargeFile(input: CreateLargeFileInput): Promise<LargeFileRecord> {
    await this.db.run(
      `INSERT INTO large_files (file_id, conversation_id, file_name, mime_type, byte_size, storage_uri, exploration_summary)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.fileId,
        input.conversationId,
        input.fileName ?? null,
        input.mimeType ?? null,
        input.byteSize ?? null,
        input.storageUri,
        input.explorationSummary ?? null,
      ],
    );

    const row = await this.db.queryOne<LargeFileRow>(
      `SELECT file_id, conversation_id, file_name, mime_type, byte_size, storage_uri, exploration_summary, created_at
     FROM large_files WHERE file_id = ?`,
      [input.fileId],
    );

    if (!row) {
      throw new Error(`Failed to retrieve inserted large file ${input.fileId}`);
    }

    return toLargeFileRecord(row);
  }

  async getLargeFile(fileId: string): Promise<LargeFileRecord | null> {
    const row = await this.db.queryOne<LargeFileRow>(
      `SELECT file_id, conversation_id, file_name, mime_type, byte_size, storage_uri, exploration_summary, created_at
     FROM large_files WHERE file_id = ?`,
      [fileId],
    );
    return row ? toLargeFileRecord(row) : null;
  }

  async getLargeFilesByConversation(conversationId: number): Promise<LargeFileRecord[]> {
    const result = await this.db.query<LargeFileRow>(
      `SELECT file_id, conversation_id, file_name, mime_type, byte_size, storage_uri, exploration_summary, created_at
     FROM large_files
     WHERE conversation_id = ?
     ORDER BY created_at`,
      [conversationId],
    );
    return result.rows.map(toLargeFileRecord);
  }
}
