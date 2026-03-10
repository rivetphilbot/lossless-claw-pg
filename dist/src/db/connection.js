import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { SqliteClient } from "./sqlite-client.js";
import { PostgresClient } from "./postgres-client.js";
const _connections = new Map();
function isConnectionHealthy(entry) {
    try {
        if ("db" in entry) {
            // SQLite connection health check
            entry.db.prepare("SELECT 1").get();
            return true;
        }
        else {
            // PostgreSQL connection health is checked by the pool internally
            return true;
        }
    }
    catch {
        return false;
    }
}
async function forceCloseConnection(entry) {
    try {
        if ("db" in entry) {
            entry.db.close();
        }
        else {
            await entry.client.close();
        }
    }
    catch {
        // Ignore close failures; caller is already replacing/removing this handle.
    }
}
export function createLcmConnection(config) {
    if (config.backend === 'postgres' && config.connectionString) {
        return createPostgresConnection(config.connectionString);
    }
    else {
        return createSqliteConnection(config.databasePath);
    }
}
function createSqliteConnection(dbPath) {
    const existing = _connections.get(dbPath);
    if (existing && "db" in existing) {
        if (isConnectionHealthy(existing)) {
            existing.refs += 1;
            return existing.client;
        }
        forceCloseConnection(existing);
        _connections.delete(dbPath);
    }
    // Ensure parent directory exists
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    // Enable WAL mode for better concurrent read performance
    db.exec("PRAGMA journal_mode = WAL");
    // Enable foreign key enforcement
    db.exec("PRAGMA foreign_keys = ON");
    const client = new SqliteClient(db);
    _connections.set(dbPath, { db, client, refs: 1 });
    return client;
}
function createPostgresConnection(connectionString) {
    const existing = _connections.get(connectionString);
    if (existing && !("db" in existing)) {
        if (isConnectionHealthy(existing)) {
            existing.refs += 1;
            return existing.client;
        }
        forceCloseConnection(existing);
        _connections.delete(connectionString);
    }
    const client = new PostgresClient(connectionString);
    _connections.set(connectionString, { client, refs: 1 });
    return client;
}
export async function closeLcmConnection(key) {
    if (typeof key === "string" && key.trim()) {
        const entry = _connections.get(key);
        if (!entry) {
            return;
        }
        entry.refs = Math.max(0, entry.refs - 1);
        if (entry.refs === 0) {
            await forceCloseConnection(entry);
            _connections.delete(key);
        }
        return;
    }
    for (const entry of _connections.values()) {
        await forceCloseConnection(entry);
    }
    _connections.clear();
}
// Legacy function for backward compatibility
export function getLcmConnection(dbPath) {
    const client = createSqliteConnection(dbPath);
    if (client instanceof SqliteClient) {
        return client.getUnderlyingDatabase();
    }
    throw new Error("Legacy getLcmConnection only supports SQLite");
}
//# sourceMappingURL=connection.js.map