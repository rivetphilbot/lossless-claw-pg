import type { DatabaseSync } from "node:sqlite";
import type { DbClient } from "./db-interface.js";
import type { LcmConfig } from "./config.js";
export type LcmDbFeatures = {
    fullTextAvailable: boolean;
    backend: 'sqlite' | 'postgres';
};
/**
 * Detect database features based on the backend type and configuration.
 *
 * For SQLite: probe for FTS5 availability (runtime-specific)
 * For PostgreSQL: tsvector is always available (built-in)
 */
export declare function getLcmDbFeatures(config: LcmConfig, dbOrClient?: DatabaseSync | DbClient): LcmDbFeatures;
/**
 * Legacy function for backward compatibility with existing SQLite code
 */
export declare function getLcmDbFeaturesLegacy(db: DatabaseSync): LcmDbFeatures;
