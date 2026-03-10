import { sanitizeFts5Query } from "./fts5-sanitize.js";
import { sanitizeTsQuery } from "./tsquery-sanitize.js";
import { buildLikeSearchPlan, createFallbackSnippet } from "./full-text-fallback.js";
// ── Row mappers ───────────────────────────────────────────────────────────────
function toSummaryRecord(row) {
    let fileIds = [];
    try {
        fileIds = JSON.parse(row.file_ids);
    }
    catch {
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
        descendantCount: typeof row.descendant_count === "number" &&
            Number.isFinite(row.descendant_count) &&
            row.descendant_count >= 0
            ? Math.floor(row.descendant_count)
            : 0,
        descendantTokenCount: typeof row.descendant_token_count === "number" &&
            Number.isFinite(row.descendant_token_count) &&
            row.descendant_token_count >= 0
            ? Math.floor(row.descendant_token_count)
            : 0,
        sourceMessageTokenCount: typeof row.source_message_token_count === "number" &&
            Number.isFinite(row.source_message_token_count) &&
            row.source_message_token_count >= 0
            ? Math.floor(row.source_message_token_count)
            : 0,
        createdAt: new Date(row.created_at),
    };
}
function toContextItemRecord(row) {
    return {
        conversationId: row.conversation_id,
        ordinal: row.ordinal,
        itemType: row.item_type,
        messageId: row.message_id,
        summaryId: row.summary_id,
        createdAt: new Date(row.created_at),
    };
}
function toSearchResult(row) {
    return {
        summaryId: row.summary_id,
        conversationId: row.conversation_id,
        kind: row.kind,
        snippet: row.snippet,
        createdAt: new Date(row.created_at),
        rank: row.rank,
    };
}
function toLargeFileRecord(row) {
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
    db;
    fullTextAvailable;
    backend;
    constructor(db, options) {
        this.db = db;
        this.fullTextAvailable = options?.fullTextAvailable ?? true;
        this.backend = options?.backend ?? 'sqlite';
    }
    // ── Summary CRUD ──────────────────────────────────────────────────────────
    async insertSummary(input) {
        const fileIds = JSON.stringify(input.fileIds ?? []);
        const earliestAt = input.earliestAt instanceof Date ? input.earliestAt.toISOString() : null;
        const latestAt = input.latestAt instanceof Date ? input.latestAt.toISOString() : null;
        const descendantCount = typeof input.descendantCount === "number" &&
            Number.isFinite(input.descendantCount) &&
            input.descendantCount >= 0
            ? Math.floor(input.descendantCount)
            : 0;
        const descendantTokenCount = typeof input.descendantTokenCount === "number" &&
            Number.isFinite(input.descendantTokenCount) &&
            input.descendantTokenCount >= 0
            ? Math.floor(input.descendantTokenCount)
            : 0;
        const sourceMessageTokenCount = typeof input.sourceMessageTokenCount === "number" &&
            Number.isFinite(input.sourceMessageTokenCount) &&
            input.sourceMessageTokenCount >= 0
            ? Math.floor(input.sourceMessageTokenCount)
            : 0;
        const depth = typeof input.depth === "number" && Number.isFinite(input.depth) && input.depth >= 0
            ? Math.floor(input.depth)
            : input.kind === "leaf"
                ? 0
                : 1;
        const insertSql = this.backend === 'postgres'
            ? `INSERT INTO summaries (
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
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`
            : `INSERT INTO summaries (
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        await this.db.run(insertSql, [
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
        ]);
        const selectSql = this.backend === 'postgres'
            ? `SELECT summary_id, conversation_id, kind, depth, content, token_count, file_ids,
                earliest_at, latest_at, descendant_count, created_at
                , descendant_token_count, source_message_token_count
       FROM summaries WHERE summary_id = $1`
            : `SELECT summary_id, conversation_id, kind, depth, content, token_count, file_ids,
                earliest_at, latest_at, descendant_count, created_at
                , descendant_token_count, source_message_token_count
       FROM summaries WHERE summary_id = ?`;
        const row = await this.db.queryOne(selectSql, [input.summaryId]);
        if (!row) {
            throw new Error(`Failed to retrieve inserted summary ${input.summaryId}`);
        }
        // Index in FTS5 as best-effort; compaction flow must continue even if
        // FTS indexing fails for any reason.
        if (!this.fullTextAvailable) {
            return toSummaryRecord(row);
        }
        try {
            await this.db.run(`INSERT INTO summaries_fts(summary_id, content) VALUES (?, ?)`, [
                input.summaryId,
                input.content,
            ]);
        }
        catch {
            // FTS indexing failed — search won't find this summary but
            // compaction and assembly will still work correctly.
        }
        return toSummaryRecord(row);
    }
    async getSummary(summaryId) {
        const sql = this.backend === 'postgres'
            ? `SELECT summary_id, conversation_id, kind, depth, content, token_count, file_ids,
                earliest_at, latest_at, descendant_count, created_at
                , descendant_token_count, source_message_token_count
       FROM summaries WHERE summary_id = $1`
            : `SELECT summary_id, conversation_id, kind, depth, content, token_count, file_ids,
                earliest_at, latest_at, descendant_count, created_at
                , descendant_token_count, source_message_token_count
       FROM summaries WHERE summary_id = ?`;
        const row = await this.db.queryOne(sql, [summaryId]);
        return row ? toSummaryRecord(row) : null;
    }
    async getSummariesByConversation(conversationId) {
        const sql = this.backend === 'postgres'
            ? `SELECT summary_id, conversation_id, kind, depth, content, token_count, file_ids,
                earliest_at, latest_at, descendant_count, created_at
                , descendant_token_count, source_message_token_count
       FROM summaries
       WHERE conversation_id = $1
       ORDER BY created_at`
            : `SELECT summary_id, conversation_id, kind, depth, content, token_count, file_ids,
                earliest_at, latest_at, descendant_count, created_at
                , descendant_token_count, source_message_token_count
       FROM summaries
       WHERE conversation_id = ?
       ORDER BY created_at`;
        const result = await this.db.query(sql, [conversationId]);
        return result.rows.map(toSummaryRecord);
    }
    // ── Lineage ───────────────────────────────────────────────────────────────
    async linkSummaryToMessages(summaryId, messageIds) {
        if (messageIds.length === 0) {
            return;
        }
        const sql = this.backend === 'postgres'
            ? `INSERT INTO summary_messages (summary_id, message_id, ordinal)
         VALUES ($1, $2, $3)
         ON CONFLICT (summary_id, message_id) DO NOTHING`
            : `INSERT INTO summary_messages (summary_id, message_id, ordinal)
         VALUES (?, ?, ?)
         ON CONFLICT (summary_id, message_id) DO NOTHING`;
        for (let idx = 0; idx < messageIds.length; idx++) {
            await this.db.run(sql, [summaryId, messageIds[idx], idx]);
        }
    }
    async linkSummaryToParents(summaryId, parentSummaryIds) {
        if (parentSummaryIds.length === 0) {
            return;
        }
        const sql = this.backend === 'postgres'
            ? `INSERT INTO summary_parents (summary_id, parent_summary_id, ordinal)
         VALUES ($1, $2, $3)
         ON CONFLICT (summary_id, parent_summary_id) DO NOTHING`
            : `INSERT INTO summary_parents (summary_id, parent_summary_id, ordinal)
         VALUES (?, ?, ?)
         ON CONFLICT (summary_id, parent_summary_id) DO NOTHING`;
        for (let idx = 0; idx < parentSummaryIds.length; idx++) {
            await this.db.run(sql, [summaryId, parentSummaryIds[idx], idx]);
        }
    }
    async getSummaryMessages(summaryId) {
        const sql = this.backend === 'postgres'
            ? `SELECT message_id FROM summary_messages
       WHERE summary_id = $1
       ORDER BY ordinal`
            : `SELECT message_id FROM summary_messages
       WHERE summary_id = ?
       ORDER BY ordinal`;
        const result = await this.db.query(sql, [summaryId]);
        return result.rows.map((r) => r.message_id);
    }
    async getSummaryChildren(parentSummaryId) {
        const sql = this.backend === 'postgres'
            ? `SELECT s.summary_id, s.conversation_id, s.kind, s.depth, s.content, s.token_count,
                s.file_ids, s.earliest_at, s.latest_at, s.descendant_count, s.created_at
                , s.descendant_token_count, s.source_message_token_count
       FROM summaries s
       JOIN summary_parents sp ON sp.summary_id = s.summary_id
       WHERE sp.parent_summary_id = $1
       ORDER BY sp.ordinal`
            : `SELECT s.summary_id, s.conversation_id, s.kind, s.depth, s.content, s.token_count,
                s.file_ids, s.earliest_at, s.latest_at, s.descendant_count, s.created_at
                , s.descendant_token_count, s.source_message_token_count
       FROM summaries s
       JOIN summary_parents sp ON sp.summary_id = s.summary_id
       WHERE sp.parent_summary_id = ?
       ORDER BY sp.ordinal`;
        const result = await this.db.query(sql, [parentSummaryId]);
        return result.rows.map(toSummaryRecord);
    }
    async getSummaryParents(summaryId) {
        const sql = this.backend === 'postgres'
            ? `SELECT s.summary_id, s.conversation_id, s.kind, s.depth, s.content, s.token_count,
                s.file_ids, s.earliest_at, s.latest_at, s.descendant_count, s.created_at
                , s.descendant_token_count, s.source_message_token_count
       FROM summaries s
       JOIN summary_parents sp ON sp.parent_summary_id = s.summary_id
       WHERE sp.summary_id = $1
       ORDER BY sp.ordinal`
            : `SELECT s.summary_id, s.conversation_id, s.kind, s.depth, s.content, s.token_count,
                s.file_ids, s.earliest_at, s.latest_at, s.descendant_count, s.created_at
                , s.descendant_token_count, s.source_message_token_count
       FROM summaries s
       JOIN summary_parents sp ON sp.parent_summary_id = s.summary_id
       WHERE sp.summary_id = ?
       ORDER BY sp.ordinal`;
        const result = await this.db.query(sql, [summaryId]);
        return result.rows.map(toSummaryRecord);
    }
    async getSummarySubtree(summaryId) {
        const pathSql = this.backend === 'postgres'
            ? `CASE
           WHEN subtree.path = '' THEN LPAD(sp.ordinal::text, 4, '0')
           ELSE subtree.path || '.' || LPAD(sp.ordinal::text, 4, '0')
         END`
            : `CASE
           WHEN subtree.path = '' THEN printf('%04d', sp.ordinal)
           ELSE subtree.path || '.' || printf('%04d', sp.ordinal)
         END`;
        const placeholder = this.backend === 'postgres' ? '$1' : '?';
        const result = await this.db.query(`WITH RECURSIVE subtree(summary_id, parent_summary_id, depth_from_root, path) AS (
         SELECT ${placeholder}, NULL, 0, ''
         UNION ALL
         SELECT
           sp.summary_id,
           sp.parent_summary_id,
           subtree.depth_from_root + 1,
           ${pathSql}
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
       ORDER BY subtree.depth_from_root ASC, subtree.path ASC, s.created_at ASC`, [summaryId]);
        const rows = result.rows;
        const seen = new Set();
        const output = [];
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
                childCount: typeof row.child_count === "number" && Number.isFinite(row.child_count)
                    ? Math.max(0, Math.floor(row.child_count))
                    : 0,
            });
        }
        return output;
    }
    // ── Context items ─────────────────────────────────────────────────────────
    async getContextItems(conversationId) {
        const sql = this.backend === 'postgres'
            ? `SELECT conversation_id, ordinal, item_type, message_id, summary_id, created_at
       FROM context_items
       WHERE conversation_id = $1
       ORDER BY ordinal`
            : `SELECT conversation_id, ordinal, item_type, message_id, summary_id, created_at
       FROM context_items
       WHERE conversation_id = ?
       ORDER BY ordinal`;
        const result = await this.db.query(sql, [conversationId]);
        return result.rows.map(toContextItemRecord);
    }
    async getDistinctDepthsInContext(conversationId, options) {
        const maxOrdinalExclusive = options?.maxOrdinalExclusive;
        const useOrdinalBound = typeof maxOrdinalExclusive === "number" &&
            Number.isFinite(maxOrdinalExclusive) &&
            maxOrdinalExclusive !== Infinity;
        let sql;
        let params;
        if (this.backend === 'postgres') {
            sql = useOrdinalBound
                ? `SELECT DISTINCT s.depth
           FROM context_items ci
           JOIN summaries s ON s.summary_id = ci.summary_id
           WHERE ci.conversation_id = $1
             AND ci.item_type = 'summary'
             AND ci.ordinal < $2
           ORDER BY s.depth ASC`
                : `SELECT DISTINCT s.depth
           FROM context_items ci
           JOIN summaries s ON s.summary_id = ci.summary_id
           WHERE ci.conversation_id = $1
             AND ci.item_type = 'summary'
           ORDER BY s.depth ASC`;
            params = useOrdinalBound ? [conversationId, Math.floor(maxOrdinalExclusive)] : [conversationId];
        }
        else {
            sql = useOrdinalBound
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
            params = useOrdinalBound ? [conversationId, Math.floor(maxOrdinalExclusive)] : [conversationId];
        }
        const result = await this.db.query(sql, params);
        return result.rows.map((row) => row.depth);
    }
    async appendContextMessage(conversationId, messageId) {
        const selectSql = this.backend === 'postgres'
            ? `SELECT COALESCE(MAX(ordinal), -1) AS max_ordinal
       FROM context_items WHERE conversation_id = $1`
            : `SELECT COALESCE(MAX(ordinal), -1) AS max_ordinal
       FROM context_items WHERE conversation_id = ?`;
        const row = await this.db.queryOne(selectSql, [conversationId]);
        const insertSql = this.backend === 'postgres'
            ? `INSERT INTO context_items (conversation_id, ordinal, item_type, message_id)
       VALUES ($1, $2, 'message', $3)`
            : `INSERT INTO context_items (conversation_id, ordinal, item_type, message_id)
       VALUES (?, ?, 'message', ?)`;
        await this.db.run(insertSql, [conversationId, (row?.max_ordinal ?? -1) + 1, messageId]);
    }
    async appendContextMessages(conversationId, messageIds) {
        if (messageIds.length === 0) {
            return;
        }
        const selectSql = this.backend === 'postgres'
            ? `SELECT COALESCE(MAX(ordinal), -1) AS max_ordinal
       FROM context_items WHERE conversation_id = $1`
            : `SELECT COALESCE(MAX(ordinal), -1) AS max_ordinal
       FROM context_items WHERE conversation_id = ?`;
        const row = await this.db.queryOne(selectSql, [conversationId]);
        const baseOrdinal = (row?.max_ordinal ?? -1) + 1;
        const insertSql = this.backend === 'postgres'
            ? `INSERT INTO context_items (conversation_id, ordinal, item_type, message_id)
       VALUES ($1, $2, 'message', $3)`
            : `INSERT INTO context_items (conversation_id, ordinal, item_type, message_id)
       VALUES (?, ?, 'message', ?)`;
        for (let idx = 0; idx < messageIds.length; idx++) {
            await this.db.run(insertSql, [conversationId, baseOrdinal + idx, messageIds[idx]]);
        }
    }
    async appendContextSummary(conversationId, summaryId) {
        const selectSql = this.backend === 'postgres'
            ? `SELECT COALESCE(MAX(ordinal), -1) AS max_ordinal
       FROM context_items WHERE conversation_id = $1`
            : `SELECT COALESCE(MAX(ordinal), -1) AS max_ordinal
       FROM context_items WHERE conversation_id = ?`;
        const row = await this.db.queryOne(selectSql, [conversationId]);
        const insertSql = this.backend === 'postgres'
            ? `INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id)
       VALUES ($1, $2, 'summary', $3)`
            : `INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id)
       VALUES (?, ?, 'summary', ?)`;
        await this.db.run(insertSql, [conversationId, (row?.max_ordinal ?? -1) + 1, summaryId]);
    }
    async replaceContextRangeWithSummary(input) {
        const { conversationId, startOrdinal, endOrdinal, summaryId } = input;
        return this.db.transaction(async () => {
            const deleteSql = this.backend === 'postgres'
                ? `DELETE FROM context_items
         WHERE conversation_id = $1
           AND ordinal >= $2
           AND ordinal <= $3`
                : `DELETE FROM context_items
         WHERE conversation_id = ?
           AND ordinal >= ?
           AND ordinal <= ?`;
            // 1. Delete context items in the range [startOrdinal, endOrdinal]
            await this.db.run(deleteSql, [conversationId, startOrdinal, endOrdinal]);
            const insertSql = this.backend === 'postgres'
                ? `INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id)
         VALUES ($1, $2, 'summary', $3)`
                : `INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id)
         VALUES (?, ?, 'summary', ?)`;
            // 2. Insert the replacement summary item at startOrdinal
            await this.db.run(insertSql, [conversationId, startOrdinal, summaryId]);
            // 3. Resequence all ordinals to maintain contiguity (no gaps).
            //    Fetch current items, then update ordinals in order.
            const selectSql = this.backend === 'postgres'
                ? `SELECT ordinal FROM context_items
         WHERE conversation_id = $1
         ORDER BY ordinal`
                : `SELECT ordinal FROM context_items
         WHERE conversation_id = ?
         ORDER BY ordinal`;
            const result = await this.db.query(selectSql, [conversationId]);
            const items = result.rows;
            const updateSql = this.backend === 'postgres'
                ? `UPDATE context_items
         SET ordinal = $1
         WHERE conversation_id = $2 AND ordinal = $3`
                : `UPDATE context_items
         SET ordinal = ?
         WHERE conversation_id = ? AND ordinal = ?`;
            // Use negative temp ordinals first to avoid unique constraint conflicts
            for (let i = 0; i < items.length; i++) {
                await this.db.run(updateSql, [-(i + 1), conversationId, items[i].ordinal]);
            }
            for (let i = 0; i < items.length; i++) {
                await this.db.run(updateSql, [i, conversationId, -(i + 1)]);
            }
        });
    }
    async getContextTokenCount(conversationId) {
        const sql = this.backend === 'postgres'
            ? `SELECT COALESCE(SUM(token_count), 0) AS total
       FROM (
         SELECT m.token_count
         FROM context_items ci
         JOIN messages m ON m.message_id = ci.message_id
         WHERE ci.conversation_id = $1
           AND ci.item_type = 'message'

         UNION ALL

         SELECT s.token_count
         FROM context_items ci
         JOIN summaries s ON s.summary_id = ci.summary_id
         WHERE ci.conversation_id = $1
           AND ci.item_type = 'summary'
       ) sub`
            : `SELECT COALESCE(SUM(token_count), 0) AS total
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
       ) sub`;
        const row = await this.db.queryOne(sql, [conversationId]);
        return row?.total ?? 0;
    }
    // ── Search ────────────────────────────────────────────────────────────────
    async searchSummaries(input) {
        const limit = input.limit ?? 50;
        if (input.mode === "full_text") {
            if (this.fullTextAvailable) {
                try {
                    return await this.searchFullText(input.query, limit, input.conversationId, input.since, input.before);
                }
                catch {
                    return await this.searchLike(input.query, limit, input.conversationId, input.since, input.before);
                }
            }
            return await this.searchLike(input.query, limit, input.conversationId, input.since, input.before);
        }
        return this.searchRegex(input.query, limit, input.conversationId, input.since, input.before);
    }
    async searchFullText(query, limit, conversationId, since, before) {
        if (this.backend === 'postgres') {
            return this.searchSummariesFullTextPostgres(query, limit, conversationId, since, before);
        }
        else {
            return this.searchSummariesFullTextSqlite(query, limit, conversationId, since, before);
        }
    }
    async searchSummariesFullTextSqlite(query, limit, conversationId, since, before) {
        const where = ["summaries_fts MATCH ?"];
        const args = [sanitizeFts5Query(query)];
        if (conversationId != null) {
            where.push("s.conversation_id = ?");
            args.push(conversationId);
        }
        if (since) {
            where.push("s.created_at >= ?");
            args.push(since.toISOString());
        }
        if (before) {
            where.push("s.created_at < ?");
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
        const result = await this.db.query(sql, args);
        return result.rows.map(toSearchResult);
    }
    async searchSummariesFullTextPostgres(query, limit, conversationId, since, before) {
        const where = ["content_tsv @@ plainto_tsquery('english', $1)"];
        const args = [sanitizeTsQuery(query)];
        let paramIndex = 2;
        if (conversationId != null) {
            where.push(`conversation_id = $${paramIndex}`);
            args.push(conversationId);
            paramIndex++;
        }
        if (since) {
            where.push(`created_at >= $${paramIndex}`);
            args.push(since.toISOString());
            paramIndex++;
        }
        if (before) {
            where.push(`created_at < $${paramIndex}`);
            args.push(before.toISOString());
            paramIndex++;
        }
        const sql = `SELECT
         summary_id,
         conversation_id,
         kind,
         ts_headline('english', content, plainto_tsquery('english', $1), 'MaxWords=32') AS snippet,
         ts_rank(content_tsv, plainto_tsquery('english', $1)) AS rank,
         created_at
       FROM summaries
       WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT $${paramIndex}`;
        args.push(limit);
        const result = await this.db.query(sql, args);
        return result.rows.map(toSearchResult);
    }
    async searchLike(query, limit, conversationId, since, before) {
        const plan = buildLikeSearchPlan("content", query);
        if (plan.terms.length === 0) {
            return [];
        }
        let where = [...plan.where];
        let args = [...plan.args];
        let paramCounter = 1;
        if (this.backend === 'postgres') {
            // Convert ? placeholders to $n for PostgreSQL
            where = plan.where.map((clause) => {
                return clause.replace(/\?/g, () => `$${paramCounter++}`);
            });
            if (conversationId != null) {
                where.push(`conversation_id = $${paramCounter}`);
                args.push(conversationId);
                paramCounter++;
            }
            if (since) {
                where.push(`created_at >= $${paramCounter}`);
                args.push(since.toISOString());
                paramCounter++;
            }
            if (before) {
                where.push(`created_at < $${paramCounter}`);
                args.push(before.toISOString());
                paramCounter++;
            }
            args.push(limit);
        }
        else {
            // SQLite
            if (conversationId != null) {
                where.push("conversation_id = ?");
                args.push(conversationId);
            }
            if (since) {
                where.push("created_at >= ?");
                args.push(since.toISOString());
            }
            if (before) {
                where.push("created_at < ?");
                args.push(before.toISOString());
            }
            args.push(limit);
        }
        const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
        const limitPlaceholder = this.backend === 'postgres' ? `$${paramCounter}` : '?';
        const limitClause = `LIMIT ${limitPlaceholder}`;
        const result = await this.db.query(`SELECT summary_id, conversation_id, kind, depth, content, token_count, file_ids,
              earliest_at, latest_at, descendant_count, descendant_token_count,
              source_message_token_count, created_at
       FROM summaries
       ${whereClause}
       ORDER BY created_at DESC
       ${limitClause}`, args);
        return result.rows.map((row) => ({
            summaryId: row.summary_id,
            conversationId: row.conversation_id,
            kind: row.kind,
            snippet: createFallbackSnippet(row.content, plan.terms),
            createdAt: new Date(row.created_at),
            rank: 0,
        }));
    }
    async searchRegex(pattern, limit, conversationId, since, before) {
        const re = new RegExp(pattern);
        const where = [];
        const args = [];
        if (this.backend === 'postgres') {
            let paramIdx = 1;
            if (conversationId != null) {
                where.push(`conversation_id = $${paramIdx}`);
                args.push(conversationId);
                paramIdx++;
            }
            if (since) {
                where.push(`created_at >= $${paramIdx}`);
                args.push(since.toISOString());
                paramIdx++;
            }
            if (before) {
                where.push(`created_at < $${paramIdx}`);
                args.push(before.toISOString());
                paramIdx++;
            }
        }
        else {
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
        }
        const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
        const result = await this.db.query(`SELECT summary_id, conversation_id, kind, depth, content, token_count, file_ids,
              earliest_at, latest_at, descendant_count, descendant_token_count,
              source_message_token_count, created_at
       FROM summaries
       ${whereClause}
       ORDER BY created_at DESC`, args);
        const results = [];
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
    async insertLargeFile(input) {
        const insertSql = this.backend === 'postgres'
            ? `INSERT INTO large_files (file_id, conversation_id, file_name, mime_type, byte_size, storage_uri, exploration_summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`
            : `INSERT INTO large_files (file_id, conversation_id, file_name, mime_type, byte_size, storage_uri, exploration_summary)
       VALUES (?, ?, ?, ?, ?, ?, ?)`;
        await this.db.run(insertSql, [
            input.fileId,
            input.conversationId,
            input.fileName ?? null,
            input.mimeType ?? null,
            input.byteSize ?? null,
            input.storageUri,
            input.explorationSummary ?? null,
        ]);
        const selectSql = this.backend === 'postgres'
            ? `SELECT file_id, conversation_id, file_name, mime_type, byte_size, storage_uri, exploration_summary, created_at
       FROM large_files WHERE file_id = $1`
            : `SELECT file_id, conversation_id, file_name, mime_type, byte_size, storage_uri, exploration_summary, created_at
       FROM large_files WHERE file_id = ?`;
        const row = await this.db.queryOne(selectSql, [input.fileId]);
        if (!row) {
            throw new Error(`Failed to retrieve inserted large file ${input.fileId}`);
        }
        return toLargeFileRecord(row);
    }
    async getLargeFile(fileId) {
        const sql = this.backend === 'postgres'
            ? `SELECT file_id, conversation_id, file_name, mime_type, byte_size, storage_uri, exploration_summary, created_at
       FROM large_files WHERE file_id = $1`
            : `SELECT file_id, conversation_id, file_name, mime_type, byte_size, storage_uri, exploration_summary, created_at
       FROM large_files WHERE file_id = ?`;
        const row = await this.db.queryOne(sql, [fileId]);
        return row ? toLargeFileRecord(row) : null;
    }
    async getLargeFilesByConversation(conversationId) {
        const sql = this.backend === 'postgres'
            ? `SELECT file_id, conversation_id, file_name, mime_type, byte_size, storage_uri, exploration_summary, created_at
       FROM large_files
       WHERE conversation_id = $1
       ORDER BY created_at`
            : `SELECT file_id, conversation_id, file_name, mime_type, byte_size, storage_uri, exploration_summary, created_at
       FROM large_files
       WHERE conversation_id = ?
       ORDER BY created_at`;
        const result = await this.db.query(sql, [conversationId]);
        return result.rows.map(toLargeFileRecord);
    }
}
//# sourceMappingURL=summary-store.js.map