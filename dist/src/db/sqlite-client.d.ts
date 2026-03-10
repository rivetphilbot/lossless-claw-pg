import type { DatabaseSync } from "node:sqlite";
import type { DbClient, QueryResult, RunResult } from "./db-interface.js";
/**
 * Wraps the existing SQLite DatabaseSync in the DbClient interface
 */
export declare class SqliteClient implements DbClient {
    private db;
    constructor(db: DatabaseSync);
    query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
    queryOne<T>(sql: string, params?: unknown[]): Promise<T | null>;
    run(sql: string, params?: unknown[]): Promise<RunResult>;
    transaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T>;
    close(): Promise<void>;
    /**
     * Get the underlying SQLite database for operations that need direct access
     */
    getUnderlyingDatabase(): DatabaseSync;
}
