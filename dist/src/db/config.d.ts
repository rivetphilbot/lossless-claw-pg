export type LcmConfig = {
    enabled: boolean;
    databasePath: string;
    connectionString?: string;
    backend?: 'sqlite' | 'postgres';
    contextThreshold: number;
    freshTailCount: number;
    leafMinFanout: number;
    condensedMinFanout: number;
    condensedMinFanoutHard: number;
    incrementalMaxDepth: number;
    leafChunkTokens: number;
    leafTargetTokens: number;
    condensedTargetTokens: number;
    maxExpandTokens: number;
    largeFileTokenThreshold: number;
    /** Provider override for large-file text summarization. */
    largeFileSummaryProvider: string;
    /** Model override for large-file text summarization. */
    largeFileSummaryModel: string;
    autocompactDisabled: boolean;
    /** IANA timezone for timestamps in summaries (from TZ env or system default) */
    timezone: string;
    /** When true, retroactively delete HEARTBEAT_OK turn cycles from LCM storage. */
    pruneHeartbeatOk: boolean;
};
/**
 * Resolve LCM configuration with three-tier precedence:
 *   1. Environment variables (highest — backward compat)
 *   2. Plugin config object (from plugins.entries.lossless-claw.config)
 *   3. Hardcoded defaults (lowest)
 */
export declare function resolveLcmConfig(env?: NodeJS.ProcessEnv, pluginConfig?: Record<string, unknown>): LcmConfig;
