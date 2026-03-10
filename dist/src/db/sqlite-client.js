/**
 * Wraps the existing SQLite DatabaseSync in the DbClient interface
 */
export class SqliteClient {
    db;
    constructor(db) {
        this.db = db;
    }
    async query(sql, params = []) {
        const rows = this.db.prepare(sql).all(...params.map(p => p));
        return { rows };
    }
    async queryOne(sql, params = []) {
        const row = this.db.prepare(sql).get(...params.map(p => p));
        return row ?? null;
    }
    async run(sql, params = []) {
        const result = this.db.prepare(sql).run(...params.map(p => p));
        const rowCount = typeof result.changes === "bigint" ? Number(result.changes) : result.changes;
        const lastInsertId = result.lastInsertRowid != null
            ? (typeof result.lastInsertRowid === "bigint" ? Number(result.lastInsertRowid) : result.lastInsertRowid)
            : undefined;
        return { rowCount, lastInsertId };
    }
    async transaction(fn) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const result = await fn(this);
            this.db.exec("COMMIT");
            return result;
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    async close() {
        this.db.close();
    }
    /**
     * Get the underlying SQLite database for operations that need direct access
     */
    getUnderlyingDatabase() {
        return this.db;
    }
}
//# sourceMappingURL=sqlite-client.js.map