import { randomUUID } from "node:crypto";
import type { DbClient } from "../db/db-interface.js";
import { sanitizeFts5Query } from "./fts5-sanitize.js";
import { sanitizeTsQuery } from "./tsquery-sanitize.js";
import { buildLikeSearchPlan, createFallbackSnippet } from "./full-text-fallback.js";

export type ConversationId = number;
export type MessageId = number;
export type SummaryId = string;
export type MessageRole = "system" | "user" | "assistant" | "tool";
export type MessagePartType =
  | "text"
  | "reasoning"
  | "tool"
  | "patch"
  | "file"
  | "subtask"
  | "compaction"
  | "step_start"
  | "step_finish"
  | "snapshot"
  | "agent"
  | "retry";

export type CreateMessageInput = {
  conversationId: ConversationId;
  seq: number;
  role: MessageRole;
  content: string;
  tokenCount: number;
};

export type MessageRecord = {
  messageId: MessageId;
  conversationId: ConversationId;
  seq: number;
  role: MessageRole;
  content: string;
  tokenCount: number;
  createdAt: Date;
};

export type CreateMessagePartInput = {
  sessionId: string;
  partType: MessagePartType;
  ordinal: number;
  textContent?: string | null;
  toolCallId?: string | null;
  toolName?: string | null;
  toolInput?: string | null;
  toolOutput?: string | null;
  metadata?: string | null;
};

export type MessagePartRecord = {
  partId: string;
  messageId: MessageId;
  sessionId: string;
  partType: MessagePartType;
  ordinal: number;
  textContent: string | null;
  toolCallId: string | null;
  toolName: string | null;
  toolInput: string | null;
  toolOutput: string | null;
  metadata: string | null;
};

export type CreateConversationInput = {
  sessionId: string;
  title?: string;
};

export type ConversationRecord = {
  conversationId: ConversationId;
  sessionId: string;
  title: string | null;
  bootstrappedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type MessageSearchInput = {
  conversationId?: ConversationId;
  query: string;
  mode: "regex" | "full_text";
  since?: Date;
  before?: Date;
  limit?: number;
};

export type MessageSearchResult = {
  messageId: MessageId;
  conversationId: ConversationId;
  role: MessageRole;
  snippet: string;
  createdAt: Date;
  rank?: number;
};

// ── DB row shapes (snake_case) ────────────────────────────────────────────────

interface ConversationRow {
  conversation_id: number;
  session_id: string;
  title: string | null;
  bootstrapped_at: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  message_id: number;
  conversation_id: number;
  seq: number;
  role: MessageRole;
  content: string;
  token_count: number;
  created_at: string;
}

interface MessageSearchRow {
  message_id: number;
  conversation_id: number;
  role: MessageRole;
  snippet: string;
  rank: number;
  created_at: string;
}

interface MessagePartRow {
  part_id: string;
  message_id: number;
  session_id: string;
  part_type: MessagePartType;
  ordinal: number;
  text_content: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  tool_input: string | null;
  tool_output: string | null;
  metadata: string | null;
}

interface CountRow {
  count: number;
}

interface MaxSeqRow {
  max_seq: number;
}

// ── Row mappers ───────────────────────────────────────────────────────────────

function toConversationRecord(row: ConversationRow): ConversationRecord {
  return {
    conversationId: row.conversation_id,
    sessionId: row.session_id,
    title: row.title,
    bootstrappedAt: row.bootstrapped_at ? new Date(row.bootstrapped_at) : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function toMessageRecord(row: MessageRow): MessageRecord {
  return {
    messageId: row.message_id,
    conversationId: row.conversation_id,
    seq: row.seq,
    role: row.role,
    content: row.content,
    tokenCount: row.token_count,
    createdAt: new Date(row.created_at),
  };
}

function toSearchResult(row: MessageSearchRow): MessageSearchResult {
  return {
    messageId: row.message_id,
    conversationId: row.conversation_id,
    role: row.role,
    snippet: row.snippet,
    createdAt: new Date(row.created_at),
    rank: row.rank,
  };
}

function toMessagePartRecord(row: MessagePartRow): MessagePartRecord {
  return {
    partId: row.part_id,
    messageId: row.message_id,
    sessionId: row.session_id,
    partType: row.part_type,
    ordinal: row.ordinal,
    textContent: row.text_content,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    toolInput: row.tool_input,
    toolOutput: row.tool_output,
    metadata: row.metadata,
  };
}

// ── ConversationStore ─────────────────────────────────────────────────────────

export class ConversationStore {
  private readonly fullTextAvailable: boolean;
  private readonly backend: 'sqlite' | 'postgres';

  constructor(
    private db: DbClient,
    options?: { fullTextAvailable?: boolean; backend?: 'sqlite' | 'postgres' },
  ) {
    this.fullTextAvailable = options?.fullTextAvailable ?? true;
    this.backend = options?.backend ?? 'sqlite';
  }

  // ── Transaction helpers ──────────────────────────────────────────────────

  async withTransaction<T>(operation: () => Promise<T> | T): Promise<T> {
    return this.db.transaction(async () => {
      return await operation();
    });
  }

  // ── Conversation operations ───────────────────────────────────────────────

  async createConversation(input: CreateConversationInput): Promise<ConversationRecord> {
    let sql: string;
    let params: unknown[];

    if (this.backend === 'postgres') {
      sql = `INSERT INTO conversations (session_id, title) VALUES ($1, $2) RETURNING conversation_id`;
      params = [input.sessionId, input.title ?? null];
    } else {
      sql = `INSERT INTO conversations (session_id, title) VALUES (?, ?)`;
      params = [input.sessionId, input.title ?? null];
    }

    const result = await this.db.run(sql, params);

    // Get the inserted conversation
    const selectSql = this.backend === 'postgres'
      ? `SELECT conversation_id, session_id, title, bootstrapped_at, created_at, updated_at
         FROM conversations WHERE conversation_id = $1`
      : `SELECT conversation_id, session_id, title, bootstrapped_at, created_at, updated_at
         FROM conversations WHERE conversation_id = ?`;

    const conversationId = result.lastInsertId!;
    const row = await this.db.queryOne<ConversationRow>(selectSql, [conversationId]);

    if (!row) {
      throw new Error(`Failed to retrieve created conversation with ID ${conversationId}`);
    }

    return toConversationRecord(row);
  }

  async getConversation(conversationId: ConversationId): Promise<ConversationRecord | null> {
    const sql = this.backend === 'postgres'
      ? `SELECT conversation_id, session_id, title, bootstrapped_at, created_at, updated_at
         FROM conversations WHERE conversation_id = $1`
      : `SELECT conversation_id, session_id, title, bootstrapped_at, created_at, updated_at
         FROM conversations WHERE conversation_id = ?`;

    const row = await this.db.queryOne<ConversationRow>(sql, [conversationId]);
    return row ? toConversationRecord(row) : null;
  }

  async getConversationBySessionId(sessionId: string): Promise<ConversationRecord | null> {
    const sql = this.backend === 'postgres'
      ? `SELECT conversation_id, session_id, title, bootstrapped_at, created_at, updated_at
         FROM conversations
         WHERE session_id = $1
         ORDER BY created_at DESC
         LIMIT 1`
      : `SELECT conversation_id, session_id, title, bootstrapped_at, created_at, updated_at
         FROM conversations
         WHERE session_id = ?
         ORDER BY created_at DESC
         LIMIT 1`;

    const row = await this.db.queryOne<ConversationRow>(sql, [sessionId]);
    return row ? toConversationRecord(row) : null;
  }

  async getOrCreateConversation(sessionId: string, title?: string): Promise<ConversationRecord> {
    const existing = await this.getConversationBySessionId(sessionId);
    if (existing) {
      return existing;
    }
    return this.createConversation({ sessionId, title });
  }

  async markConversationBootstrapped(conversationId: ConversationId): Promise<void> {
    let sql: string;
    
    if (this.backend === 'postgres') {
      sql = `UPDATE conversations
             SET bootstrapped_at = COALESCE(bootstrapped_at, NOW()),
                 updated_at = NOW()
             WHERE conversation_id = $1`;
    } else {
      sql = `UPDATE conversations
             SET bootstrapped_at = COALESCE(bootstrapped_at, datetime('now')),
                 updated_at = datetime('now')
             WHERE conversation_id = ?`;
    }

    await this.db.run(sql, [conversationId]);
  }

  // ── Message operations ────────────────────────────────────────────────────

  async createMessage(input: CreateMessageInput): Promise<MessageRecord> {
    let sql: string;
    let params: unknown[];

    if (this.backend === 'postgres') {
      sql = `INSERT INTO messages (conversation_id, seq, role, content, token_count)
             VALUES ($1, $2, $3, $4, $5) RETURNING message_id`;
      params = [input.conversationId, input.seq, input.role, input.content, input.tokenCount];
    } else {
      sql = `INSERT INTO messages (conversation_id, seq, role, content, token_count)
             VALUES (?, ?, ?, ?, ?)`;
      params = [input.conversationId, input.seq, input.role, input.content, input.tokenCount];
    }

    const result = await this.db.run(sql, params);
    const messageId = result.lastInsertId!;

    await this.indexMessageForFullText(messageId, input.content);

    const selectSql = this.backend === 'postgres'
      ? `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
         FROM messages WHERE message_id = $1`
      : `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
         FROM messages WHERE message_id = ?`;

    const row = await this.db.queryOne<MessageRow>(selectSql, [messageId]);

    if (!row) {
      throw new Error(`Failed to retrieve created message with ID ${messageId}`);
    }

    return toMessageRecord(row);
  }

  async createMessagesBulk(inputs: CreateMessageInput[]): Promise<MessageRecord[]> {
    if (inputs.length === 0) {
      return [];
    }

    const records: MessageRecord[] = [];
    for (const input of inputs) {
      let insertSql: string;
      let insertParams: unknown[];

      if (this.backend === 'postgres') {
        insertSql = `INSERT INTO messages (conversation_id, seq, role, content, token_count)
                     VALUES ($1, $2, $3, $4, $5) RETURNING message_id`;
        insertParams = [input.conversationId, input.seq, input.role, input.content, input.tokenCount];
      } else {
        insertSql = `INSERT INTO messages (conversation_id, seq, role, content, token_count)
                     VALUES (?, ?, ?, ?, ?)`;
        insertParams = [input.conversationId, input.seq, input.role, input.content, input.tokenCount];
      }

      const result = await this.db.run(insertSql, insertParams);
      const messageId = result.lastInsertId!;

      await this.indexMessageForFullText(messageId, input.content);

      const selectSql = this.backend === 'postgres'
        ? `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
           FROM messages WHERE message_id = $1`
        : `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
           FROM messages WHERE message_id = ?`;

      const row = await this.db.queryOne<MessageRow>(selectSql, [messageId]);
      if (row) {
        records.push(toMessageRecord(row));
      }
    }

    return records;
  }

  async getMessages(
    conversationId: ConversationId,
    opts?: { afterSeq?: number; limit?: number },
  ): Promise<MessageRecord[]> {
    const afterSeq = opts?.afterSeq ?? -1;
    const limit = opts?.limit;

    let sql: string;
    let params: unknown[];

    if (limit != null) {
      if (this.backend === 'postgres') {
        sql = `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
               FROM messages
               WHERE conversation_id = $1 AND seq > $2
               ORDER BY seq
               LIMIT $3`;
        params = [conversationId, afterSeq, limit];
      } else {
        sql = `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
               FROM messages
               WHERE conversation_id = ? AND seq > ?
               ORDER BY seq
               LIMIT ?`;
        params = [conversationId, afterSeq, limit];
      }
    } else {
      if (this.backend === 'postgres') {
        sql = `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
               FROM messages
               WHERE conversation_id = $1 AND seq > $2
               ORDER BY seq`;
        params = [conversationId, afterSeq];
      } else {
        sql = `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
               FROM messages
               WHERE conversation_id = ? AND seq > ?
               ORDER BY seq`;
        params = [conversationId, afterSeq];
      }
    }

    const result = await this.db.query<MessageRow>(sql, params);
    return result.rows.map(toMessageRecord);
  }

  async getLastMessage(conversationId: ConversationId): Promise<MessageRecord | null> {
    const sql = this.backend === 'postgres'
      ? `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
         FROM messages
         WHERE conversation_id = $1
         ORDER BY seq DESC
         LIMIT 1`
      : `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
         FROM messages
         WHERE conversation_id = ?
         ORDER BY seq DESC
         LIMIT 1`;

    const row = await this.db.queryOne<MessageRow>(sql, [conversationId]);
    return row ? toMessageRecord(row) : null;
  }

  async hasMessage(
    conversationId: ConversationId,
    role: MessageRole,
    content: string,
  ): Promise<boolean> {
    const sql = this.backend === 'postgres'
      ? `SELECT 1 AS count
         FROM messages
         WHERE conversation_id = $1 AND role = $2 AND content = $3
         LIMIT 1`
      : `SELECT 1 AS count
         FROM messages
         WHERE conversation_id = ? AND role = ? AND content = ?
         LIMIT 1`;

    const row = await this.db.queryOne<CountRow>(sql, [conversationId, role, content]);
    return row?.count === 1;
  }

  async countMessagesByIdentity(
    conversationId: ConversationId,
    role: MessageRole,
    content: string,
  ): Promise<number> {
    const sql = this.backend === 'postgres'
      ? `SELECT COUNT(*) AS count
         FROM messages
         WHERE conversation_id = $1 AND role = $2 AND content = $3`
      : `SELECT COUNT(*) AS count
         FROM messages
         WHERE conversation_id = ? AND role = ? AND content = ?`;

    const row = await this.db.queryOne<CountRow>(sql, [conversationId, role, content]);
    return row?.count ?? 0;
  }

  async getMessageById(messageId: MessageId): Promise<MessageRecord | null> {
    const sql = this.backend === 'postgres'
      ? `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
         FROM messages WHERE message_id = $1`
      : `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
         FROM messages WHERE message_id = ?`;

    const row = await this.db.queryOne<MessageRow>(sql, [messageId]);
    return row ? toMessageRecord(row) : null;
  }

  async createMessageParts(messageId: MessageId, parts: CreateMessagePartInput[]): Promise<void> {
    if (parts.length === 0) {
      return;
    }

    for (const part of parts) {
      let sql: string;
      if (this.backend === 'postgres') {
        sql = `INSERT INTO message_parts (
                 part_id,
                 message_id,
                 session_id,
                 part_type,
                 ordinal,
                 text_content,
                 tool_call_id,
                 tool_name,
                 tool_input,
                 tool_output,
                 metadata
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`;
      } else {
        sql = `INSERT INTO message_parts (
                 part_id,
                 message_id,
                 session_id,
                 part_type,
                 ordinal,
                 text_content,
                 tool_call_id,
                 tool_name,
                 tool_input,
                 tool_output,
                 metadata
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      }

      await this.db.run(sql, [
        randomUUID(),
        messageId,
        part.sessionId,
        part.partType,
        part.ordinal,
        part.textContent ?? null,
        part.toolCallId ?? null,
        part.toolName ?? null,
        part.toolInput ?? null,
        part.toolOutput ?? null,
        part.metadata ?? null,
      ]);
    }
  }

  async getMessageParts(messageId: MessageId): Promise<MessagePartRecord[]> {
    const sql = this.backend === 'postgres'
      ? `SELECT
         part_id,
         message_id,
         session_id,
         part_type,
         ordinal,
         text_content,
         tool_call_id,
         tool_name,
         tool_input,
         tool_output,
         metadata
       FROM message_parts
       WHERE message_id = $1
       ORDER BY ordinal`
      : `SELECT
         part_id,
         message_id,
         session_id,
         part_type,
         ordinal,
         text_content,
         tool_call_id,
         tool_name,
         tool_input,
         tool_output,
         metadata
       FROM message_parts
       WHERE message_id = ?
       ORDER BY ordinal`;

    const result = await this.db.query<MessagePartRow>(sql, [messageId]);
    return result.rows.map(toMessagePartRecord);
  }

  async getMessageCount(conversationId: ConversationId): Promise<number> {
    const sql = this.backend === 'postgres'
      ? `SELECT COUNT(*) AS count FROM messages WHERE conversation_id = $1`
      : `SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?`;

    const row = await this.db.queryOne<CountRow>(sql, [conversationId]);
    return row?.count ?? 0;
  }

  async getMaxSeq(conversationId: ConversationId): Promise<number> {
    const sql = this.backend === 'postgres'
      ? `SELECT COALESCE(MAX(seq), 0) AS max_seq
         FROM messages WHERE conversation_id = $1`
      : `SELECT COALESCE(MAX(seq), 0) AS max_seq
         FROM messages WHERE conversation_id = ?`;

    const row = await this.db.queryOne<MaxSeqRow>(sql, [conversationId]);
    return row?.max_seq ?? 0;
  }

  // ── Deletion ──────────────────────────────────────────────────────────────

  /**
   * Delete messages and their associated records (context_items, FTS, message_parts).
   *
   * Skips messages referenced in summary_messages (already compacted) to avoid
   * breaking the summary DAG. Returns the count of actually deleted messages.
   */
  async deleteMessages(messageIds: MessageId[]): Promise<number> {
    if (messageIds.length === 0) {
      return 0;
    }

    return this.db.transaction(async () => {
      let deleted = 0;
      for (const messageId of messageIds) {
        // Skip if referenced by a summary (ON DELETE RESTRICT would fail anyway)
        const refSql = this.backend === 'postgres'
          ? `SELECT 1 AS found FROM summary_messages WHERE message_id = $1 LIMIT 1`
          : `SELECT 1 AS found FROM summary_messages WHERE message_id = ? LIMIT 1`;
        
        const refRow = await this.db.queryOne<{ found: number }>(refSql, [messageId]);
        if (refRow) {
          continue;
        }

        // Remove from context_items first (RESTRICT constraint)
        const deleteContextSql = this.backend === 'postgres'
          ? `DELETE FROM context_items WHERE item_type = 'message' AND message_id = $1`
          : `DELETE FROM context_items WHERE item_type = 'message' AND message_id = ?`;
        
        await this.db.run(deleteContextSql, [messageId]);

        await this.deleteMessageFromFullText(messageId);

        // Delete the message (message_parts cascade via ON DELETE CASCADE)
        const deleteMessageSql = this.backend === 'postgres'
          ? `DELETE FROM messages WHERE message_id = $1`
          : `DELETE FROM messages WHERE message_id = ?`;
        
        await this.db.run(deleteMessageSql, [messageId]);

        deleted += 1;
      }

      return deleted;
    });
  }

  // ── Search ────────────────────────────────────────────────────────────────

  async searchMessages(input: MessageSearchInput): Promise<MessageSearchResult[]> {
    const limit = input.limit ?? 50;

    if (input.mode === "full_text") {
      if (this.fullTextAvailable) {
        try {
          return await this.searchFullText(
            input.query,
            limit,
            input.conversationId,
            input.since,
            input.before,
          );
        } catch {
          return await this.searchLike(
            input.query,
            limit,
            input.conversationId,
            input.since,
            input.before,
          );
        }
      }
      return await this.searchLike(input.query, limit, input.conversationId, input.since, input.before);
    }
    return await this.searchRegex(input.query, limit, input.conversationId, input.since, input.before);
  }

  private async indexMessageForFullText(messageId: MessageId, content: string): Promise<void> {
    if (!this.fullTextAvailable) {
      return;
    }
    try {
      if (this.backend === 'postgres') {
        // PostgreSQL uses tsvector columns that are automatically updated via triggers
        // No explicit indexing needed - the database handles this automatically
        return;
      } else {
        await this.db.run(`INSERT INTO messages_fts(rowid, content) VALUES (?, ?)`, [messageId, content]);
      }
    } catch {
      // Full-text indexing is optional. Message persistence must still succeed.
    }
  }

  private async deleteMessageFromFullText(messageId: MessageId): Promise<void> {
    if (!this.fullTextAvailable) {
      return;
    }
    try {
      if (this.backend === 'postgres') {
        // PostgreSQL tsvector columns are automatically updated via triggers
        // No explicit deletion needed
        return;
      } else {
        await this.db.run(`DELETE FROM messages_fts WHERE rowid = ?`, [messageId]);
      }
    } catch {
      // Ignore FTS cleanup failures; the source row deletion is authoritative.
    }
  }

  private async searchFullText(
    query: string,
    limit: number,
    conversationId?: ConversationId,
    since?: Date,
    before?: Date,
  ): Promise<MessageSearchResult[]> {
    if (this.backend === 'postgres') {
      return this.searchFullTextPostgres(query, limit, conversationId, since, before);
    } else {
      return this.searchFullTextSqlite(query, limit, conversationId, since, before);
    }
  }

  private async searchFullTextSqlite(
    query: string,
    limit: number,
    conversationId?: ConversationId,
    since?: Date,
    before?: Date,
  ): Promise<MessageSearchResult[]> {
    const where: string[] = ["messages_fts MATCH ?"];
    const args: Array<string | number> = [sanitizeFts5Query(query)];
    
    if (conversationId != null) {
      where.push("m.conversation_id = ?");
      args.push(conversationId);
    }
    if (since) {
      where.push("m.created_at >= ?");
      args.push(since.toISOString());
    }
    if (before) {
      where.push("m.created_at < ?");
      args.push(before.toISOString());
    }
    args.push(limit);

    const sql = `SELECT
         m.message_id,
         m.conversation_id,
         m.role,
         snippet(messages_fts, 0, '', '', '...', 32) AS snippet,
         rank,
         m.created_at
       FROM messages_fts
       JOIN messages m ON m.message_id = messages_fts.rowid
       WHERE ${where.join(" AND ")}
       ORDER BY m.created_at DESC
       LIMIT ?`;
    
    const result = await this.db.query<MessageSearchRow>(sql, args);
    return result.rows.map(toSearchResult);
  }

  private async searchFullTextPostgres(
    query: string,
    limit: number,
    conversationId?: ConversationId,
    since?: Date,
    before?: Date,
  ): Promise<MessageSearchResult[]> {
    const where: string[] = ["content_tsv @@ plainto_tsquery('english', $1)"];
    const args: Array<string | number> = [sanitizeTsQuery(query)];
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
         message_id,
         conversation_id,
         role,
         ts_headline('english', content, plainto_tsquery('english', $1), 'MaxWords=32') AS snippet,
         ts_rank(content_tsv, plainto_tsquery('english', $1)) AS rank,
         created_at
       FROM messages
       WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT $${paramIndex}`;
    
    args.push(limit);
    const result = await this.db.query<MessageSearchRow>(sql, args);
    return result.rows.map(toSearchResult);
  }

  private async searchLike(
    query: string,
    limit: number,
    conversationId?: ConversationId,
    since?: Date,
    before?: Date,
  ): Promise<MessageSearchResult[]> {
    const plan = buildLikeSearchPlan("content", query);
    if (plan.terms.length === 0) {
      return [];
    }

    let where: string[] = [...plan.where];
    let args: Array<string | number> = [...plan.args];
    let paramCounter = 1;

    if (this.backend === 'postgres') {
      // Convert ? placeholders to $n for PostgreSQL
      where = plan.where.map((clause) => {
        return clause.replace(/\?/g, () => `$${paramCounter++}`);
      });
    }

    if (conversationId != null) {
      where.push(this.backend === 'postgres' ? `conversation_id = $${paramCounter}` : 'conversation_id = ?');
      args.push(conversationId);
      paramCounter++;
    }
    if (since) {
      where.push(this.backend === 'postgres' ? `created_at >= $${paramCounter}` : 'created_at >= ?');
      args.push(since.toISOString());
      paramCounter++;
    }
    if (before) {
      where.push(this.backend === 'postgres' ? `created_at < $${paramCounter}` : 'created_at < ?');
      args.push(before.toISOString());
      paramCounter++;
    }
    args.push(limit);

    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const limitPlaceholder = this.backend === 'postgres' ? `$${paramCounter}` : '?';
    const limitClause = `LIMIT ${limitPlaceholder}`;
    
    const sql = `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
                 FROM messages
                 ${whereClause}
                 ORDER BY created_at DESC
                 ${limitClause}`;

    const result = await this.db.query<MessageRow>(sql, args);

    return result.rows.map((row) => ({
      messageId: row.message_id,
      conversationId: row.conversation_id,
      role: row.role,
      snippet: createFallbackSnippet(row.content, plan.terms),
      createdAt: new Date(row.created_at),
      rank: 0,
    }));
  }

  private async searchRegex(
    pattern: string,
    limit: number,
    conversationId?: ConversationId,
    since?: Date,
    before?: Date,
  ): Promise<MessageSearchResult[]> {
    if (this.backend === 'postgres') {
      return this.searchRegexPostgres(pattern, limit, conversationId, since, before);
    } else {
      return this.searchRegexSqlite(pattern, limit, conversationId, since, before);
    }
  }

  private async searchRegexSqlite(
    pattern: string,
    limit: number,
    conversationId?: ConversationId,
    since?: Date,
    before?: Date,
  ): Promise<MessageSearchResult[]> {
    // SQLite has no native POSIX regex; fetch candidates and filter in JS
    const re = new RegExp(pattern);

    const where: string[] = [];
    const args: Array<string | number> = [];
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
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    
    const sql = `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
                 FROM messages
                 ${whereClause}
                 ORDER BY created_at DESC`;

    const result = await this.db.query<MessageRow>(sql, args);

    const results: MessageSearchResult[] = [];
    for (const row of result.rows) {
      if (results.length >= limit) {
        break;
      }
      const match = re.exec(row.content);
      if (match) {
        results.push({
          messageId: row.message_id,
          conversationId: row.conversation_id,
          role: row.role,
          snippet: match[0],
          createdAt: new Date(row.created_at),
          rank: 0,
        });
      }
    }
    return results;
  }

  private async searchRegexPostgres(
    pattern: string,
    limit: number,
    conversationId?: ConversationId,
    since?: Date,
    before?: Date,
  ): Promise<MessageSearchResult[]> {
    // PostgreSQL has native POSIX regex support
    const where: string[] = ["content ~ $1"];
    const args: Array<string | number> = [pattern];
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

    const sql = `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
                 FROM messages
                 WHERE ${where.join(" AND ")}
                 ORDER BY created_at DESC
                 LIMIT $${paramIndex}`;

    args.push(limit);
    const result = await this.db.query<MessageRow>(sql, args);

    return result.rows.map((row) => {
      // Extract the first regex match for snippet
      const re = new RegExp(pattern);
      const match = re.exec(row.content);
      
      return {
        messageId: row.message_id,
        conversationId: row.conversation_id,
        role: row.role,
        snippet: match ? match[0] : row.content.substring(0, 100),
        createdAt: new Date(row.created_at),
        rank: 0,
      };
    });
  }
}
