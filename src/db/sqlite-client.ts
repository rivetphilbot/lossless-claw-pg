import type { DatabaseSync } from "node:sqlite";
import type { DbClient, QueryResult, RunResult } from "./db-interface.js";

/**
 * Wraps the existing SQLite DatabaseSync in the DbClient interface
 */
export class SqliteClient implements DbClient {
  constructor(private db: DatabaseSync) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const rows = this.db.prepare(sql).all(...params.map(p => p as any)) as T[];
    return { rows };
  }

  async queryOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const row = this.db.prepare(sql).get(...params.map(p => p as any)) as T | undefined;
    return row ?? null;
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    const result = this.db.prepare(sql).run(...params.map(p => p as any));
    const lastId = result.lastInsertRowid;
    let insertId: number | undefined;
    if (lastId != null) {
      // @ts-ignore
      insertId = Number(lastId);
    }
    return {
      rowCount: result.changes,
      lastInsertId: insertId
    };
  }

  async transaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = await fn(this);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }

  /**
   * Get the underlying SQLite database for operations that need direct access
   */
  getUnderlyingDatabase(): DatabaseSync {
    return this.db;
  }
}