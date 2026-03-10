import type { DatabaseSync } from "node:sqlite";
import type { DbClient } from "./db-interface.js";
import type { LcmConfig } from "./config.js";

export type LcmDbFeatures = {
  fullTextAvailable: boolean;
  backend: 'sqlite' | 'postgres';
};

const featureCache = new WeakMap<DatabaseSync, LcmDbFeatures>();

function probeFts5(db: DatabaseSync): boolean {
  try {
    db.exec("DROP TABLE IF EXISTS temp.__lcm_fts5_probe");
    db.exec("CREATE VIRTUAL TABLE temp.__lcm_fts5_probe USING fts5(content)");
    db.exec("DROP TABLE temp.__lcm_fts5_probe");
    return true;
  } catch {
    try {
      db.exec("DROP TABLE IF EXISTS temp.__lcm_fts5_probe");
    } catch {
      // Ignore cleanup failures after a failed probe.
    }
    return false;
  }
}

/**
 * Detect database features for the configured backend.
 *
 * PostgreSQL: tsvector always available (built-in).
 * SQLite: probe for FTS5 at runtime.
 */
export function getLcmDbFeatures(config: LcmConfig, dbOrClient?: DatabaseSync | DbClient): LcmDbFeatures {
  if (config.backend === 'postgres') {
    return { fullTextAvailable: true, backend: 'postgres' };
  }

  // SQLite — probe for FTS5 if we have a handle
  if (dbOrClient && 'prepare' in dbOrClient) {
    const db = dbOrClient as DatabaseSync;
    const cached = featureCache.get(db);
    if (cached) return cached;

    const detected: LcmDbFeatures = { fullTextAvailable: probeFts5(db), backend: 'sqlite' };
    featureCache.set(db, detected);
    return detected;
  }

  return { fullTextAvailable: false, backend: 'sqlite' };
}
