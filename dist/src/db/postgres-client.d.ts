import type { DbClient, QueryResult as DbQueryResult, RunResult } from "./db-interface.js";
/**
 * PostgreSQL implementation of the DbClient interface using node-postgres
 */
export declare class PostgresClient implements DbClient {
    private pool;
    constructor(connectionString: string);
    query<T>(sql: string, params?: unknown[]): Promise<DbQueryResult<T>>;
    queryOne<T>(sql: string, params?: unknown[]): Promise<T | null>;
    run(sql: string, params?: unknown[]): Promise<RunResult>;
    transaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T>;
    close(): Promise<void>;
}
