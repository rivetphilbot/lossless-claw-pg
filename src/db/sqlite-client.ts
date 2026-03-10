import type { DatabaseSync } from "node:sqlite";
import type { DbClient, QueryResult, RunResult } from "./db-interface.js";

/**
 * Wraps the existing SQLite DatabaseSync in the DbClient interface
 */
export class SqliteClient implements DbClient {
  constructor(private db: DatabaseSync) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const rows = this.db.prepare(sql).all(...params) as T[];
    return { rows };
  }

  async queryOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const row = this.db.prepare(sql).get(...params) as T | undefined;
    return row ?? null;
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    const result = this.db.prepare(sql).run(...params);
    return {
      rowCount: result.changes,
      lastInsertId: typeof result.lastInsertRowid === "bigint" 
        ? Number(result.lastInsertRowid) 
        : result.lastInsertRowid as number
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