import type { LcmConfig } from "./db/config.js";
import type { RetrievalEngine } from "./retrieval.js";
export type ExpansionRequest = {
    /** Summary IDs to expand */
    summaryIds: string[];
    /** Max traversal depth per summary (default: 3) */
    maxDepth?: number;
    /** Max tokens across the entire expansion (default: config.maxExpandTokens) */
    tokenCap?: number;
    /** Whether to include raw source messages at leaf level */
    includeMessages?: boolean;
    /** Conversation ID scope */
    conversationId: number;
};
export type ExpansionResult = {
    /** Expanded summaries with their children/messages */
    expansions: Array<{
        summaryId: string;
        children: Array<{
            summaryId: string;
            kind: string;
            snippet: string;
            tokenCount: number;
        }>;
        messages: Array<{
            messageId: number;
            role: string;
            snippet: string;
            tokenCount: number;
        }>;
    }>;
    /** Cited IDs for follow-up traversal */
    citedIds: string[];
    /** Total tokens in the result */
    totalTokens: number;
    /** Whether any expansion was truncated */
    truncated: boolean;
};
/**
 * Resolve the effective expansion token cap by applying a configured default
 * and an explicit upper bound.
 */
export declare function resolveExpansionTokenCap(input: {
    requestedTokenCap?: number;
    maxExpandTokens: number;
}): number;
export declare class ExpansionOrchestrator {
    private retrieval;
    constructor(retrieval: RetrievalEngine);
    /**
     * Expand each summary ID using the RetrievalEngine, collecting results and
     * enforcing a global token cap across all expansions.
     */
    expand(request: ExpansionRequest): Promise<ExpansionResult>;
    /**
     * Convenience method: grep for matching summaries, then expand the top results.
     * Combines the routing pass (grep) with the deep expansion pass.
     */
    describeAndExpand(input: {
        query: string;
        mode: "regex" | "full_text";
        conversationId?: number;
        maxDepth?: number;
        tokenCap?: number;
    }): Promise<ExpansionResult>;
}
/**
 * Format an ExpansionResult into a compact text payload suitable for passing
 * to a subagent or returning to the main agent.
 */
export declare function distillForSubagent(result: ExpansionResult): string;
/**
 * Build a tool definition object for LCM expansion that can be registered as
 * an agent tool. Follows the pattern used in `src/agents/tools/`.
 *
 * Requires an already-initialised ExpansionOrchestrator and an LcmConfig
 * (for the default tokenCap).
 */
export declare function buildExpansionToolDefinition(options: {
    orchestrator: ExpansionOrchestrator;
    config: LcmConfig;
    conversationId: number;
}): {
    name: string;
    description: string;
    parameters: import("@sinclair/typebox").TObject<{
        summaryIds: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TArray<import("@sinclair/typebox").TString>>;
        query: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
        maxDepth: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
        tokenCap: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TNumber>;
        includeMessages: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TBoolean>;
    }>;
    execute: (_toolCallId: string, params: Record<string, unknown>) => Promise<{
        content: Array<{
            type: "text";
            text: string;
        }>;
        details: unknown;
    }>;
};
