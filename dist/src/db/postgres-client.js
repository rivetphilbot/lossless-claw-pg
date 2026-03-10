import { Pool } from "pg";
/**
 * PostgreSQL implementation of the DbClient interface using node-postgres
 */
export class PostgresClient {
    pool;
    constructor(connectionString) {
        this.pool = new Pool({
            connectionString,
            min: 2,
            max: 10,
            idleTimeoutMillis: 30000,
        });
    }
    async query(sql, params = []) {
        const result = await this.pool.query(sql, params);
        return { rows: result.rows };
    }
    async queryOne(sql, params = []) {
        const result = await this.pool.query(sql, params);
        return result.rows.length > 0 ? result.rows[0] : null;
    }
    async run(sql, params = []) {
        const result = await this.pool.query(sql, params);
        // For INSERT with RETURNING, extract the ID from the first row
        let lastInsertId;
        if (result.rows.length > 0 && typeof result.rows[0] === "object" && result.rows[0] !== null) {
            const row = result.rows[0];
            // Look for common ID column names
            const idValue = row.conversation_id || row.message_id || row.summary_id || row.id;
            if (typeof idValue === "number") {
                lastInsertId = idValue;
            }
            else if (typeof idValue === "string" && !isNaN(Number(idValue))) {
                lastInsertId = Number(idValue);
            }
        }
        return {
            rowCount: result.rowCount ?? 0,
            lastInsertId,
        };
    }
    async transaction(fn) {
        const poolClient = await this.pool.connect();
        const txClient = new PostgresTransactionClient(poolClient);
        try {
            await poolClient.query("BEGIN");
            const result = await fn(txClient);
            await poolClient.query("COMMIT");
            return result;
        }
        catch (error) {
            await poolClient.query("ROLLBACK");
            throw error;
        }
        finally {
            poolClient.release();
        }
    }
    async close() {
        await this.pool.end();
    }
}
/**
 * Transaction-scoped PostgreSQL client that uses a single connection
 */
class PostgresTransactionClient {
    client;
    constructor(client) {
        this.client = client;
    }
    async query(sql, params = []) {
        const result = await this.client.query(sql, params);
        return { rows: result.rows };
    }
    async queryOne(sql, params = []) {
        const result = await this.client.query(sql, params);
        return result.rows.length > 0 ? result.rows[0] : null;
    }
    async run(sql, params = []) {
        const result = await this.client.query(sql, params);
        // For INSERT with RETURNING, extract the ID from the first row
        let lastInsertId;
        if (result.rows.length > 0 && typeof result.rows[0] === "object" && result.rows[0] !== null) {
            const row = result.rows[0];
            // Look for common ID column names
            const idValue = row.conversation_id || row.message_id || row.summary_id || row.id;
            if (typeof idValue === "number") {
                lastInsertId = idValue;
            }
            else if (typeof idValue === "string" && !isNaN(Number(idValue))) {
                lastInsertId = Number(idValue);
            }
        }
        return {
            rowCount: result.rowCount ?? 0,
            lastInsertId,
        };
    }
    async transaction(fn) {
        // Nested transactions in PostgreSQL use savepoints
        const savepointName = `sp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        await this.client.query(`SAVEPOINT ${savepointName}`);
        try {
            const result = await fn(this);
            await this.client.query(`RELEASE SAVEPOINT ${savepointName}`);
            return result;
        }
        catch (error) {
            await this.client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
            throw error;
        }
    }
    async close() {
        // Transaction clients don't close the underlying connection
        // The connection is managed by the parent PostgresClient
    }
}
//# sourceMappingURL=postgres-client.js.map