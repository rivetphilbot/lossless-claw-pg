import type { ContextEngine, ContextEngineInfo, AssembleResult, BootstrapResult, CompactResult, IngestBatchResult, IngestResult, SubagentEndReason, SubagentSpawnPreparation } from "openclaw/plugin-sdk";
import { RetrievalEngine } from "./retrieval.js";
import { ConversationStore } from "./store/conversation-store.js";
import { SummaryStore } from "./store/summary-store.js";
import type { LcmDependencies } from "./types.js";
type AgentMessage = Parameters<ContextEngine["ingest"]>[0]["message"];
export declare class LcmContextEngine implements ContextEngine {
    readonly info: ContextEngineInfo;
    private config;
    private conversationStore;
    private summaryStore;
    private assembler;
    private compaction;
    private retrieval;
    private migrated;
    private readonly fullTextAvailable;
    private sessionOperationQueues;
    private largeFileTextSummarizerResolved;
    private largeFileTextSummarizer?;
    private deps;
    constructor(deps: LcmDependencies);
    /** Ensure DB schema is up-to-date. Called lazily on first bootstrap/ingest/assemble/compact. */
    private ensureMigrated;
    /**
     * Serialize mutating operations per session to prevent ingest/compaction races.
     */
    private withSessionQueue;
    /** Normalize optional live token estimates supplied by runtime callers. */
    private normalizeObservedTokenCount;
    /** Resolve token budget from direct params or legacy fallback input. */
    private resolveTokenBudget;
    /** Resolve an LCM conversation id from a session key via the session store. */
    private resolveConversationIdForSessionKey;
    /** Build a summarize callback with runtime provider fallback handling. */
    private resolveSummarize;
    /**
     * Resolve an optional model-backed summarizer for large text file exploration.
     *
     * This is opt-in via env so ingest remains deterministic and lightweight when
     * no summarization model is configured.
     */
    private resolveLargeFileTextSummarizer;
    /** Persist intercepted large-file text payloads to ~/.openclaw/lcm-files. */
    private storeLargeFileContent;
    /**
     * Intercept oversized <file> blocks before persistence and replace them with
     * compact file references backed by large_files records.
     */
    private interceptLargeFiles;
    /**
     * Reconcile session-file history with persisted messages and append only the
     * tail that is present in JSONL but missing from LCM.
     */
    private reconcileSessionTail;
    bootstrap(params: {
        sessionId: string;
        sessionFile: string;
    }): Promise<BootstrapResult>;
    private ingestSingle;
    ingest(params: {
        sessionId: string;
        message: AgentMessage;
        isHeartbeat?: boolean;
    }): Promise<IngestResult>;
    ingestBatch(params: {
        sessionId: string;
        messages: AgentMessage[];
        isHeartbeat?: boolean;
    }): Promise<IngestBatchResult>;
    afterTurn(params: {
        sessionId: string;
        sessionFile: string;
        messages: AgentMessage[];
        prePromptMessageCount: number;
        autoCompactionSummary?: string;
        isHeartbeat?: boolean;
        tokenBudget?: number;
        legacyCompactionParams?: Record<string, unknown>;
    }): Promise<void>;
    assemble(params: {
        sessionId: string;
        messages: AgentMessage[];
        tokenBudget?: number;
    }): Promise<AssembleResult>;
    /** Evaluate whether incremental leaf compaction should run for a session. */
    evaluateLeafTrigger(sessionId: string): Promise<{
        shouldCompact: boolean;
        rawTokensOutsideTail: number;
        threshold: number;
    }>;
    /** Run one incremental leaf compaction pass in the per-session queue. */
    compactLeafAsync(params: {
        sessionId: string;
        sessionFile: string;
        tokenBudget?: number;
        currentTokenCount?: number;
        customInstructions?: string;
        legacyParams?: Record<string, unknown>;
        force?: boolean;
        previousSummaryContent?: string;
    }): Promise<CompactResult>;
    compact(params: {
        sessionId: string;
        sessionFile: string;
        tokenBudget?: number;
        currentTokenCount?: number;
        compactionTarget?: "budget" | "threshold";
        customInstructions?: string;
        legacyParams?: Record<string, unknown>;
        /** Force compaction even if below threshold */
        force?: boolean;
    }): Promise<CompactResult>;
    prepareSubagentSpawn(params: {
        parentSessionKey: string;
        childSessionKey: string;
        ttlMs?: number;
    }): Promise<SubagentSpawnPreparation | undefined>;
    onSubagentEnded(params: {
        childSessionKey: string;
        reason: SubagentEndReason;
    }): Promise<void>;
    dispose(): Promise<void>;
    getRetrieval(): RetrievalEngine;
    getConversationStore(): ConversationStore;
    getSummaryStore(): SummaryStore;
    /**
     * Detect HEARTBEAT_OK turn cycles in a conversation and delete them.
     *
     * A HEARTBEAT_OK turn is: a user message (the heartbeat prompt), followed by
     * any tool call/result messages, ending with an assistant message that is a
     * heartbeat ack. The entire sequence has no durable information value for LCM.
     *
     * Detection: assistant content (trimmed, lowercased) starts with "heartbeat_ok"
     * and any text after is not alphanumeric (matches OpenClaw core's ack detection).
     * This catches both exact "HEARTBEAT_OK" and chatty variants like
     * "HEARTBEAT_OK — weekend, no market".
     *
     * Returns the number of messages deleted.
     */
    private pruneHeartbeatOkTurns;
}
export {};
