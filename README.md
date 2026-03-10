# lossless-claw-pg

A fork of [@martian-engineering/lossless-claw](https://github.com/Martian-Engineering/lossless-claw) that adds **PostgreSQL backend support** alongside the existing SQLite backend.

## Why?

The original lossless-claw uses SQLite via Node.js's built-in `node:sqlite` (`DatabaseSync`). This works great for single-node setups, but PostgreSQL unlocks:

- **Multi-agent shared memory** — multiple OpenClaw instances can read/write the same conversation store
- **Native full-text search** — `tsvector`/`tsquery` with GIN indexes replaces FTS5
- **Trigram similarity** — `pg_trgm` for fuzzy matching
- **pgvector** — future path for semantic search embeddings
- **Centralized backups** — one database to back up instead of per-agent SQLite files
- **Proper connection pooling** — concurrent access without SQLite locking issues

## Architecture

**Dual backend** — SQLite remains the default. Set `connectionString` in your LCM config to use PostgreSQL instead.

```
connectionString: postgres://user:pass@host:5432/dbname
```

The adapter introduces a `DbClient` interface that both backends implement, keeping the store layer backend-agnostic.

### Key Changes from Upstream

| Component | SQLite (upstream) | PostgreSQL (this fork) |
|-----------|-------------------|----------------------|
| Connection | `node:sqlite` DatabaseSync | `pg` Pool |
| Params | `?` placeholders | `$1, $2, ...` numbered |
| FTS | FTS5 virtual tables | tsvector + GIN indexes |
| Fuzzy search | N/A | pg_trgm |
| Transactions | `BEGIN IMMEDIATE` | `BEGIN` / pool client |
| Migrations | In-code ALTER TABLE | External SQL scripts |

### Files Added/Modified

- `src/db/db-interface.ts` — Backend-agnostic database client interface
- `src/db/postgres-client.ts` — PostgreSQL implementation
- `src/db/sqlite-client.ts` — SQLite wrapper (same behavior, new interface)
- `src/store/tsquery-sanitize.ts` — PostgreSQL FTS query sanitizer

All existing store files (`conversation-store.ts`, `summary-store.ts`) are modified to use `DbClient` instead of `DatabaseSync` directly.

## PostgreSQL Schema

The required schema (8 tables, 20 indexes) must be deployed before use. See `POSTGRES-ADAPTER-SPEC.md` for the full schema and setup instructions.

Required extensions:
```sql
CREATE EXTENSION IF NOT EXISTS pgvector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

## Upstream Sync

This fork tracks upstream releases. Check for updates:

```bash
./scripts/check-upstream.sh
```

## License

MIT — same as upstream. Original work by [Josh Lehman / Martian Engineering](https://github.com/Martian-Engineering).

## Credits

- **Upstream:** [@martian-engineering/lossless-claw](https://github.com/Martian-Engineering/lossless-claw) by Josh Lehman
- **PostgreSQL adapter:** Philip Tompkins ([@philbert440](https://github.com/philbert440))
