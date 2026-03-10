const featureCache = new WeakMap();
function probeFts5(db) {
    try {
        db.exec("DROP TABLE IF EXISTS temp.__lcm_fts5_probe");
        db.exec("CREATE VIRTUAL TABLE temp.__lcm_fts5_probe USING fts5(content)");
        db.exec("DROP TABLE temp.__lcm_fts5_probe");
        return true;
    }
    catch {
        try {
            db.exec("DROP TABLE IF EXISTS temp.__lcm_fts5_probe");
        }
        catch {
            // Ignore cleanup failures after a failed probe.
        }
        return false;
    }
}
/**
 * Detect database features based on the backend type and configuration.
 *
 * For SQLite: probe for FTS5 availability (runtime-specific)
 * For PostgreSQL: tsvector is always available (built-in)
 */
export function getLcmDbFeatures(config, dbOrClient) {
    if (config.backend === 'postgres') {
        // PostgreSQL has built-in full-text search with tsvector
        return {
            fullTextAvailable: true, // We map FTS5 concept to tsvector availability
            backend: 'postgres'
        };
    }
    // SQLite backend - probe for FTS5 if we have a DatabaseSync handle
    if (dbOrClient && 'prepare' in dbOrClient) {
        const db = dbOrClient;
        const cached = featureCache.get(db);
        if (cached) {
            return cached;
        }
        const detected = {
            fullTextAvailable: probeFts5(db),
            backend: 'sqlite'
        };
        featureCache.set(db, detected);
        return detected;
    }
    // Fallback for SQLite when no database handle available
    return {
        fullTextAvailable: false,
        backend: 'sqlite'
    };
}
/**
 * Legacy function for backward compatibility with existing SQLite code
 */
export function getLcmDbFeaturesLegacy(db) {
    const cached = featureCache.get(db);
    if (cached) {
        return cached;
    }
    const detected = {
        fullTextAvailable: probeFts5(db),
        backend: 'sqlite'
    };
    featureCache.set(db, detected);
    return detected;
}
//# sourceMappingURL=features.js.map