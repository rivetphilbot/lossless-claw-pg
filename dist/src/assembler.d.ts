import type { ContextEngine } from "openclaw/plugin-sdk";
import type { ConversationStore } from "./store/conversation-store.js";
import type { SummaryStore } from "./store/summary-store.js";
type AgentMessage = Parameters<ContextEngine["ingest"]>[0]["message"];
export interface AssembleContextInput {
    conversationId: number;
    tokenBudget: number;
    /** Number of most recent raw turns to always include (default: 8) */
    freshTailCount?: number;
}
export interface AssembleContextResult {
    /** Ordered messages ready for the model */
    messages: AgentMessage[];
    /** Total estimated tokens */
    estimatedTokens: number;
    /** Optional dynamic system prompt guidance derived from DAG state */
    systemPromptAddition?: string;
    /** Stats about what was assembled */
    stats: {
        rawMessageCount: number;
        summaryCount: number;
        totalContextItems: number;
    };
}
export declare class ContextAssembler {
    private conversationStore;
    private summaryStore;
    private timezone?;
    constructor(conversationStore: ConversationStore, summaryStore: SummaryStore, timezone?: string | undefined);
    /**
     * Build model context under a token budget.
     *
     * 1. Fetch all context items for the conversation (ordered by ordinal).
     * 2. Resolve each item into an AgentMessage (fetching the underlying
     *    message or summary record).
     * 3. Protect the "fresh tail" (last N items) from truncation.
     * 4. If over budget, drop oldest non-fresh items until we fit.
     * 5. Return the final ordered messages in chronological order.
     */
    assemble(input: AssembleContextInput): Promise<AssembleContextResult>;
    /**
     * Resolve a list of context items into ResolvedItems by fetching the
     * underlying message or summary record for each.
     *
     * Items that cannot be resolved (e.g. deleted message) are silently skipped.
     */
    private resolveItems;
    /**
     * Resolve a single context item.
     */
    private resolveItem;
    /**
     * Resolve a context item that references a raw message.
     */
    private resolveMessageItem;
    /**
     * Resolve a context item that references a summary.
     * Summaries are presented as user messages with a structured XML wrapper.
     */
    private resolveSummaryItem;
}
export {};
