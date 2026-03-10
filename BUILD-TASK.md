# Build Task: Finalize LCM PostgreSQL Adapter

## Context
This is a fork of `@martian-engineering/lossless-claw` (OpenClaw's context management engine) being adapted to support PostgreSQL as an alternative to SQLite. The dual-backend stores (`conversation-store.ts`, `summary-store.ts`) and connection layer are already converted and TypeScript compiles clean.

## What's Done
- `src/db/db-interface.ts` — DbClient interface
- `src/db/postgres-client.ts` — PostgreSQL Pool-based implementation  
- `src/db/sqlite-client.ts` — SQLite wrapper
- `src/db/connection.ts` — Factory (createLcmConnection) for both backends
- `src/db/config.ts` — Added `connectionString` and `backend` fields
- `src/store/conversation-store.ts` — Converted to DbClient with dual SQL
- `src/store/summary-store.ts` — Converted to DbClient with dual SQL
- `src/store/tsquery-sanitize.ts` — PostgreSQL FTS query sanitizer
- `src/engine.ts` — Backend-aware wiring, skips SQLite migrations for Postgres

## Remaining Work

### 1. Clean up stale imports
- `src/store/conversation-store.ts` line 1: `import type { DatabaseSync } from "node:sqlite"` — REMOVE (unused, DbClient is used instead)
- Check all other files for stale `DatabaseSync` imports that aren't needed

### 2. Write integration test script
Create `scripts/test-postgres.ts` that:
- Connects to PostgreSQL: `postgres://lcm_phil:pheon.lcm4@10.4.20.16:5432/phil_memory`
- Creates a test conversation
- Creates test messages
- Tests full-text search (both regex and full_text modes)
- Tests summary CRUD
- Tests summary tree operations (parents, children, subtree)
- Cleans up test data
- Reports pass/fail for each operation
- Can be run with: `npx tsx scripts/test-postgres.ts`

### 3. Write integration test for SQLite (regression)
Create `scripts/test-sqlite.ts` that:
- Runs the same test suite against a temp SQLite database
- Ensures existing SQLite functionality isn't broken
- Can be run with: `npx tsx scripts/test-sqlite.ts`

### 4. Fix any issues found by integration tests
- Run both test scripts
- Fix any SQL dialect issues, type mismatches, or logic errors
- Both backends must pass all tests

### 5. Clean up features.ts
`src/db/features.ts` still has heavy SQLite coupling with `DatabaseSync` types. Clean it up:
- When backend is 'postgres', FTS is always available (tsvector built-in)
- Don't try to probe SQLite FTS5 when running Postgres
- The `getLcmDbFeatures` function should accept either DatabaseSync or DbClient and detect backend

### 6. Verify TypeScript compiles clean
Run `npx tsc --noEmit` — must have zero errors.

## PostgreSQL Connection Info
- Host: 10.4.20.16 (postgres.home)
- Port: 5432
- Database: phil_memory
- User: lcm_phil
- Password: pheon.lcm4
- Schema already deployed: 8 tables (conversations, messages, message_parts, summaries, summary_messages, summary_parents, context_items, large_files), 20 indexes

## Rules
- Do NOT modify the public API surface (types, class interfaces, method signatures)
- Keep SQLite as the default backend — Postgres is opt-in via connectionString
- Use `$1, $2, ...` numbered placeholders for Postgres, `?` for SQLite
- Use `NOW()` for Postgres timestamps, `datetime('now')` for SQLite
- All queries must handle both backends via the existing `this.backend` pattern in stores
- Run `npx tsc --noEmit` after every change to verify
- Test both backends
