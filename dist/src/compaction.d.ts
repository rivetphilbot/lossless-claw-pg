import type { ConversationStore } from "./store/conversation-store.js";
import type { SummaryStore } from "./store/summary-store.js";
export interface CompactionDecision {
    shouldCompact: boolean;
    reason: "threshold" | "manual" | "none";
    currentTokens: number;
    threshold: number;
}
export interface CompactionResult {
    actionTaken: boolean;
    /** Tokens before compaction */
    tokensBefore: number;
    /** Tokens after compaction */
    tokensAfter: number;
    /** Summary created (if any) */
    createdSummaryId?: string;
    /** Whether condensation was performed */
    condensed: boolean;
    /** Escalation level used: "normal" | "aggressive" | "fallback" */
    level?: CompactionLevel;
}
export interface CompactionConfig {
    /** Context threshold as fraction of budget (default 0.75) */
    contextThreshold: number;
    /** Number of fresh tail turns to protect (default 8) */
    freshTailCount: number;
    /** Minimum number of depth-0 summaries needed for condensation. */
    leafMinFanout: number;
    /** Minimum number of depth>=1 summaries needed for condensation. */
    condensedMinFanout: number;
    /** Relaxed minimum fanout for hard-trigger sweeps. */
    condensedMinFanoutHard: number;
    /** Incremental depth passes to run after each leaf compaction (default 0). */
    incrementalMaxDepth: number;
    /** Max source tokens to compact per leaf/condensed chunk (default 20000) */
    leafChunkTokens?: number;
    /** Target tokens for leaf summaries (default 600) */
    leafTargetTokens: number;
    /** Target tokens for condensed summaries (default 900) */
    condensedTargetTokens: number;
    /** Maximum compaction rounds (default 10) */
    maxRounds: number;
    /** IANA timezone for timestamps in summaries (default: UTC) */
    timezone?: string;
}
type CompactionLevel = "normal" | "aggressive" | "fallback";
type CompactionSummarizeOptions = {
    previousSummary?: string;
    isCondensed?: boolean;
    depth?: number;
};
type CompactionSummarizeFn = (text: string, aggressive?: boolean, options?: CompactionSummarizeOptions) => Promise<string>;
export declare class CompactionEngine {
    private conversationStore;
    private summaryStore;
    private config;
    constructor(conversationStore: ConversationStore, summaryStore: SummaryStore, config: CompactionConfig);
    /** Evaluate whether compaction is needed. */
    evaluate(conversationId: number, tokenBudget: number, observedTokenCount?: number): Promise<CompactionDecision>;
    /**
     * Evaluate whether the raw-message leaf trigger is active.
     *
     * Counts message tokens outside the protected fresh tail and compares against
     * `leafChunkTokens`. This lets callers trigger a soft incremental leaf pass
     * before the full context threshold is breached.
     */
    evaluateLeafTrigger(conversationId: number): Promise<{
        shouldCompact: boolean;
        rawTokensOutsideTail: number;
        threshold: number;
    }>;
    /** Run a full compaction sweep for a conversation. */
    compact(input: {
        conversationId: number;
        tokenBudget: number;
        /** LLM call function for summarization */
        summarize: CompactionSummarizeFn;
        force?: boolean;
        hardTrigger?: boolean;
    }): Promise<CompactionResult>;
    /**
     * Run a single leaf pass against the oldest compactable raw chunk.
     *
     * This is the soft-trigger path used for incremental maintenance.
     */
    compactLeaf(input: {
        conversationId: number;
        tokenBudget: number;
        summarize: CompactionSummarizeFn;
        force?: boolean;
        previousSummaryContent?: string;
    }): Promise<CompactionResult>;
    /**
     * Run a hard-trigger sweep:
     *
     * Phase 1: repeatedly compact raw-message chunks outside the fresh tail.
     * Phase 2: repeatedly condense oldest summary chunks while chunk utilization
     *          remains high enough to be worthwhile.
     */
    compactFullSweep(input: {
        conversationId: number;
        tokenBudget: number;
        summarize: CompactionSummarizeFn;
        force?: boolean;
        hardTrigger?: boolean;
    }): Promise<CompactionResult>;
    /** Compact until under the requested target, running up to maxRounds. */
    compactUntilUnder(input: {
        conversationId: number;
        tokenBudget: number;
        targetTokens?: number;
        currentTokens?: number;
        summarize: CompactionSummarizeFn;
    }): Promise<{
        success: boolean;
        rounds: number;
        finalTokens: number;
    }>;
    /** Normalize configured leaf chunk size to a safe positive integer. */
    private resolveLeafChunkTokens;
    /** Normalize configured fresh tail count to a safe non-negative integer. */
    private resolveFreshTailCount;
    /**
     * Compute the ordinal boundary for protected fresh messages.
     *
     * Messages with ordinal >= returned value are preserved as fresh tail.
     */
    private resolveFreshTailOrdinal;
    /** Resolve message token count with a content-length fallback. */
    private getMessageTokenCount;
    /** Sum raw message tokens outside the protected fresh tail. */
    private countRawTokensOutsideFreshTail;
    /**
     * Select the oldest contiguous raw-message chunk outside fresh tail.
     *
     * The selected chunk size is capped by `leafChunkTokens`, but we always pick
     * at least one message when any compactable message exists.
     */
    private selectOldestLeafChunk;
    /**
     * Resolve recent summary continuity for a leaf pass.
     *
     * Collects up to two most recent summary context items that precede the
     * compacted raw-message chunk and returns their combined content.
     */
    private resolvePriorLeafSummaryContext;
    /** Resolve summary token count with content-length fallback. */
    private resolveSummaryTokenCount;
    /** Resolve message token count with content-length fallback. */
    private resolveMessageTokenCount;
    private resolveLeafMinFanout;
    private resolveCondensedMinFanout;
    private resolveCondensedMinFanoutHard;
    private resolveIncrementalMaxDepth;
    private resolveFanoutForDepth;
    /** Minimum condensed input size before we run another condensed pass. */
    private resolveCondensedMinChunkTokens;
    /**
     * Find the shallowest depth with an eligible same-depth summary chunk.
     */
    private selectShallowestCondensationCandidate;
    /**
     * Select the oldest contiguous summary chunk at a specific summary depth.
     *
     * Once selection starts, any non-summary item or depth mismatch terminates
     * the chunk to prevent mixed-depth condensation.
     */
    private selectOldestChunkAtDepth;
    private resolvePriorSummaryContextAtDepth;
    /**
     * Run three-level summarization escalation:
     * normal -> aggressive -> deterministic fallback.
     */
    private summarizeWithEscalation;
    /**
     * Summarize a chunk of messages into one leaf summary.
     */
    private leafPass;
    /**
     * Condense one ratio-sized summary chunk into a single condensed summary.
     */
    private condensedPass;
    /**
     * Persist durable compaction events into canonical history as message parts.
     *
     * Event persistence is best-effort: failures are swallowed to avoid
     * compromising the core compaction path.
     */
    private persistCompactionEvents;
    /** Write one compaction event message + part atomically where possible. */
    private persistCompactionEvent;
}
export {};
