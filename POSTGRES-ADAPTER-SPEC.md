# PostgreSQL Adapter Spec for Lossless-Claw

## Overview
Convert lossless-claw from SQLite (`node:sqlite` DatabaseSync) to PostgreSQL (`pg` Pool) while keeping the same public API surface (all types, class interfaces, tool signatures unchanged).

## Database Target
- **Host:** <postgres-host> (CT 106, postgres.home)
- **Port:** 5432
- **Databases:** `phil_memory` (user: `lcm_phil`, password: `<password>`), `coco_memory` (user: `lcm_coco`, password: `<password>`)
- **Schema:** Already deployed — 8 tables, 20 indexes including GIN for full-text and trigram search
- **Extensions:** pgvector, pg_trgm already enabled

## Architecture Decisions

### 1. Dual Backend (SQLite fallback)
- Add `backend: 'sqlite' | 'postgres'` to LcmConfig
- When `connectionString` is set → use Postgres
- When `databasePath` is set → use SQLite (current behavior)
- Default: SQLite (backwards compatible)

### 2. Connection Layer (`src/db/connection.ts`)
- Add `pg` dependency to package.json
- Create `PostgresConnectionManager` class alongside existing SQLite `ConnectionManager`
- Postgres pool: min 2, max 10, idle timeout 30s
- Export factory function: `createConnectionManager(config)` → returns SQLite or Postgres manager
- Both implement the same interface with `query()`, `transaction()`, `close()`

### 3. Database Abstraction Interface (`src/db/db-interface.ts`) — NEW FILE
```typescript
export interface DbClient {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  queryOne<T>(sql: string, params?: unknown[]): Promise<T | null>;
  run(sql: string, params?: unknown[]): Promise<{ rowCount: number; lastInsertId?: number }>;
  transaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
```

### 4. Store Conversion
Both `ConversationStore` and `SummaryStore` currently take `DatabaseSync` in constructor.

**Change to:**
```typescript
constructor(private db: DbClient, options?: { backend: 'sqlite' | 'postgres' })
```

**Query changes:**
- SQLite `?` placeholders → Postgres `$1, $2, ...` (numbered)
- `datetime('now')` → `NOW()`
- `julianday(x) >= julianday(y)` → `x >= y` (Postgres handles timestamp comparison natively)
- `COALESCE(MAX(ordinal), -1)` → same (works in both)
- `result.lastInsertRowid` → `RETURNING conversation_id` clause
- `db.prepare(sql).get(...)` → `db.queryOne(sql, [...])`
- `db.prepare(sql).all(...)` → `db.query(sql, [...])`
- `db.prepare(sql).run(...)` → `db.run(sql, [...])`
- SQLite `BEGIN IMMEDIATE` → Postgres `BEGIN`

### 5. Full-Text Search
**SQLite:** FTS5 virtual table (`messages_fts`, `summaries_fts`)
**Postgres:** `tsvector` column + GIN index (already set up on CT 106)

- `messages_fts MATCH ?` → `to_tsvector('english', content) @@ plainto_tsquery('english', $1)`
- `snippet(messages_fts, 0, '', '', '...', 32)` → `ts_headline('english', content, plainto_tsquery('english', $1), 'MaxWords=32')`
- `summaries_fts MATCH ?` → same pattern
- `fts5-sanitize.ts` → `tsquery-sanitize.ts` (simpler — plainto_tsquery handles most escaping)
- `full-text-fallback.ts` → still useful for LIKE fallback, but Postgres FTS is always available so rarely needed

### 6. Migration System (`src/db/migration.ts`)
- Skip entirely for Postgres — schema already deployed via SQL on CT 106
- Add a version check: query `schema_version` or check table existence
- Postgres migration path: maintain a separate `migrations/postgres/` directory with numbered SQL files

### 7. Features Detection (`src/db/features.ts`)
- For Postgres: FTS5 → always true (tsvector is built-in), WAL → N/A
- Simplify to: `{ fts5Available: true, backend: 'postgres' }`

### 8. Config (`src/db/config.ts`)
Add to `LcmConfig`:
```typescript
connectionString?: string;  // postgres://lcm_phil:<password>@<postgres-host>:5432/phil_memory
backend?: 'sqlite' | 'postgres';  // auto-detected from connectionString
```

### 9. Files That DON'T Change
- `src/engine.ts` — orchestrates compaction, only calls store methods
- `src/compaction.ts` — compaction logic, store-agnostic
- `src/assembler.ts` — context assembly, store-agnostic
- `src/expansion.ts` — expansion logic
- `src/summarize.ts` — LLM calls
- `src/tools/*.ts` — tool implementations, call store methods
- `src/types.ts` — type definitions
- `src/transcript-repair.ts`
- `src/large-files.ts`
- `src/openclaw-bridge.ts` — except wiring up the new connection factory

## Files to Modify/Create

| Action | File | Description |
|--------|------|-------------|
| NEW | `src/db/db-interface.ts` | DbClient interface |
| NEW | `src/db/postgres-client.ts` | Postgres implementation of DbClient |
| NEW | `src/db/sqlite-client.ts` | SQLite wrapper implementing DbClient |
| NEW | `src/store/tsquery-sanitize.ts` | Postgres FTS query sanitizer |
| MODIFY | `src/db/config.ts` | Add connectionString, backend |
| MODIFY | `src/db/connection.ts` | Factory for SQLite/Postgres |
| MODIFY | `src/db/features.ts` | Backend-aware feature detection |
| MODIFY | `src/db/migration.ts` | Skip for Postgres, add version check |
| MODIFY | `src/store/conversation-store.ts` | Use DbClient, dual SQL |
| MODIFY | `src/store/summary-store.ts` | Use DbClient, dual SQL |
| MODIFY | `src/openclaw-bridge.ts` | Wire up connection factory |
| MODIFY | `package.json` | Add `pg` dependency |

## Testing Strategy
1. Install `pg` in the fork
2. Write a simple connection test script that connects to CT 106 and runs basic CRUD
3. Once stores compile, run OpenClaw with `connectionString` pointed at CT 106
4. Verify lcm_grep, lcm_describe, lcm_expand all work
5. Check that compaction creates summaries in Postgres

## Connection String
```
postgres://lcm_phil:<password>@<postgres-host>:5432/phil_memory
```
