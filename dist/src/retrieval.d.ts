import type { ConversationStore, MessageSearchResult } from "./store/conversation-store.js";
import type { SummaryStore, SummarySearchResult } from "./store/summary-store.js";
export interface DescribeResult {
    id: string;
    type: "summary" | "file";
    /** Summary-specific fields */
    summary?: {
        conversationId: number;
        kind: "leaf" | "condensed";
        content: string;
        depth: number;
        tokenCount: number;
        descendantCount: number;
        descendantTokenCount: number;
        sourceMessageTokenCount: number;
        fileIds: string[];
        parentIds: string[];
        childIds: string[];
        messageIds: number[];
        earliestAt: Date | null;
        latestAt: Date | null;
        subtree: Array<{
            summaryId: string;
            parentSummaryId: string | null;
            depthFromRoot: number;
            kind: "leaf" | "condensed";
            depth: number;
            tokenCount: number;
            descendantCount: number;
            descendantTokenCount: number;
            sourceMessageTokenCount: number;
            earliestAt: Date | null;
            latestAt: Date | null;
            childCount: number;
            path: string;
        }>;
        createdAt: Date;
    };
    /** File-specific fields */
    file?: {
        conversationId: number;
        fileName: string | null;
        mimeType: string | null;
        byteSize: number | null;
        storageUri: string;
        explorationSummary: string | null;
        createdAt: Date;
    };
}
export interface GrepInput {
    query: string;
    mode: "regex" | "full_text";
    scope: "messages" | "summaries" | "both";
    conversationId?: number;
    since?: Date;
    before?: Date;
    limit?: number;
}
export interface GrepResult {
    messages: MessageSearchResult[];
    summaries: SummarySearchResult[];
    totalMatches: number;
}
export interface ExpandInput {
    summaryId: string;
    /** Max traversal depth (default 1) */
    depth?: number;
    /** Include raw source messages at leaf level */
    includeMessages?: boolean;
    /** Max tokens to return before truncating */
    tokenCap?: number;
}
export interface ExpandResult {
    /** Child summaries found */
    children: Array<{
        summaryId: string;
        kind: "leaf" | "condensed";
        content: string;
        tokenCount: number;
    }>;
    /** Source messages (only if includeMessages=true and hitting leaf summaries) */
    messages: Array<{
        messageId: number;
        role: string;
        content: string;
        tokenCount: number;
    }>;
    /** Total estimated tokens in result */
    estimatedTokens: number;
    /** Whether result was truncated due to tokenCap */
    truncated: boolean;
}
export declare class RetrievalEngine {
    private conversationStore;
    private summaryStore;
    constructor(conversationStore: ConversationStore, summaryStore: SummaryStore);
    /**
     * Describe an LCM item by ID.
     *
     * - IDs starting with "sum_" are looked up as summaries (with lineage).
     * - IDs starting with "file_" are looked up as large files.
     * - Returns null if the item is not found.
     */
    describe(id: string): Promise<DescribeResult | null>;
    private describeSummary;
    private describeFile;
    /**
     * Search compacted history using regex or full-text search.
     *
     * Depending on `scope`, searches messages, summaries, or both (in parallel).
     */
    grep(input: GrepInput): Promise<GrepResult>;
    /**
     * Expand a summary to its children and/or source messages.
     *
     * - Condensed summaries: returns child summaries, recursing up to `depth`.
     * - Leaf summaries with `includeMessages`: fetches the source messages.
     * - Respects `tokenCap` and sets `truncated` when the cap is exceeded.
     */
    expand(input: ExpandInput): Promise<ExpandResult>;
    private expandRecursive;
}
