import type { DbClient } from "../db/db-interface.js";
export type SummaryKind = "leaf" | "condensed";
export type ContextItemType = "message" | "summary";
export type CreateSummaryInput = {
    summaryId: string;
    conversationId: number;
    kind: SummaryKind;
    depth?: number;
    content: string;
    tokenCount: number;
    fileIds?: string[];
    earliestAt?: Date;
    latestAt?: Date;
    descendantCount?: number;
    descendantTokenCount?: number;
    sourceMessageTokenCount?: number;
};
export type SummaryRecord = {
    summaryId: string;
    conversationId: number;
    kind: SummaryKind;
    depth: number;
    content: string;
    tokenCount: number;
    fileIds: string[];
    earliestAt: Date | null;
    latestAt: Date | null;
    descendantCount: number;
    descendantTokenCount: number;
    sourceMessageTokenCount: number;
    createdAt: Date;
};
export type SummarySubtreeNodeRecord = SummaryRecord & {
    depthFromRoot: number;
    parentSummaryId: string | null;
    path: string;
    childCount: number;
};
export type ContextItemRecord = {
    conversationId: number;
    ordinal: number;
    itemType: ContextItemType;
    messageId: number | null;
    summaryId: string | null;
    createdAt: Date;
};
export type SummarySearchInput = {
    conversationId?: number;
    query: string;
    mode: "regex" | "full_text";
    since?: Date;
    before?: Date;
    limit?: number;
};
export type SummarySearchResult = {
    summaryId: string;
    conversationId: number;
    kind: SummaryKind;
    snippet: string;
    createdAt: Date;
    rank?: number;
};
export type CreateLargeFileInput = {
    fileId: string;
    conversationId: number;
    fileName?: string;
    mimeType?: string;
    byteSize?: number;
    storageUri: string;
    explorationSummary?: string;
};
export type LargeFileRecord = {
    fileId: string;
    conversationId: number;
    fileName: string | null;
    mimeType: string | null;
    byteSize: number | null;
    storageUri: string;
    explorationSummary: string | null;
    createdAt: Date;
};
export declare class SummaryStore {
    private db;
    private readonly fullTextAvailable;
    private readonly backend;
    constructor(db: DbClient, options?: {
        fullTextAvailable?: boolean;
        backend?: 'sqlite' | 'postgres';
    });
    insertSummary(input: CreateSummaryInput): Promise<SummaryRecord>;
    getSummary(summaryId: string): Promise<SummaryRecord | null>;
    getSummariesByConversation(conversationId: number): Promise<SummaryRecord[]>;
    linkSummaryToMessages(summaryId: string, messageIds: number[]): Promise<void>;
    linkSummaryToParents(summaryId: string, parentSummaryIds: string[]): Promise<void>;
    getSummaryMessages(summaryId: string): Promise<number[]>;
    getSummaryChildren(parentSummaryId: string): Promise<SummaryRecord[]>;
    getSummaryParents(summaryId: string): Promise<SummaryRecord[]>;
    getSummarySubtree(summaryId: string): Promise<SummarySubtreeNodeRecord[]>;
    getContextItems(conversationId: number): Promise<ContextItemRecord[]>;
    getDistinctDepthsInContext(conversationId: number, options?: {
        maxOrdinalExclusive?: number;
    }): Promise<number[]>;
    appendContextMessage(conversationId: number, messageId: number): Promise<void>;
    appendContextMessages(conversationId: number, messageIds: number[]): Promise<void>;
    appendContextSummary(conversationId: number, summaryId: string): Promise<void>;
    replaceContextRangeWithSummary(input: {
        conversationId: number;
        startOrdinal: number;
        endOrdinal: number;
        summaryId: string;
    }): Promise<void>;
    getContextTokenCount(conversationId: number): Promise<number>;
    searchSummaries(input: SummarySearchInput): Promise<SummarySearchResult[]>;
    private searchFullText;
    private searchSummariesFullTextSqlite;
    private searchSummariesFullTextPostgres;
    private searchLike;
    private searchRegex;
    insertLargeFile(input: CreateLargeFileInput): Promise<LargeFileRecord>;
    getLargeFile(fileId: string): Promise<LargeFileRecord | null>;
    getLargeFilesByConversation(conversationId: number): Promise<LargeFileRecord[]>;
}
