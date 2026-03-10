import type { DbClient } from "../db/db-interface.js";
export type ConversationId = number;
export type MessageId = number;
export type SummaryId = string;
export type MessageRole = "system" | "user" | "assistant" | "tool";
export type MessagePartType = "text" | "reasoning" | "tool" | "patch" | "file" | "subtask" | "compaction" | "step_start" | "step_finish" | "snapshot" | "agent" | "retry";
export type CreateMessageInput = {
    conversationId: ConversationId;
    seq: number;
    role: MessageRole;
    content: string;
    tokenCount: number;
};
export type MessageRecord = {
    messageId: MessageId;
    conversationId: ConversationId;
    seq: number;
    role: MessageRole;
    content: string;
    tokenCount: number;
    createdAt: Date;
};
export type CreateMessagePartInput = {
    sessionId: string;
    partType: MessagePartType;
    ordinal: number;
    textContent?: string | null;
    toolCallId?: string | null;
    toolName?: string | null;
    toolInput?: string | null;
    toolOutput?: string | null;
    metadata?: string | null;
};
export type MessagePartRecord = {
    partId: string;
    messageId: MessageId;
    sessionId: string;
    partType: MessagePartType;
    ordinal: number;
    textContent: string | null;
    toolCallId: string | null;
    toolName: string | null;
    toolInput: string | null;
    toolOutput: string | null;
    metadata: string | null;
};
export type CreateConversationInput = {
    sessionId: string;
    title?: string;
};
export type ConversationRecord = {
    conversationId: ConversationId;
    sessionId: string;
    title: string | null;
    bootstrappedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
};
export type MessageSearchInput = {
    conversationId?: ConversationId;
    query: string;
    mode: "regex" | "full_text";
    since?: Date;
    before?: Date;
    limit?: number;
};
export type MessageSearchResult = {
    messageId: MessageId;
    conversationId: ConversationId;
    role: MessageRole;
    snippet: string;
    createdAt: Date;
    rank?: number;
};
export declare class ConversationStore {
    private db;
    private readonly fullTextAvailable;
    private readonly backend;
    constructor(db: DbClient, options?: {
        fullTextAvailable?: boolean;
        backend?: 'sqlite' | 'postgres';
    });
    withTransaction<T>(operation: () => Promise<T> | T): Promise<T>;
    createConversation(input: CreateConversationInput): Promise<ConversationRecord>;
    getConversation(conversationId: ConversationId): Promise<ConversationRecord | null>;
    getConversationBySessionId(sessionId: string): Promise<ConversationRecord | null>;
    getOrCreateConversation(sessionId: string, title?: string): Promise<ConversationRecord>;
    markConversationBootstrapped(conversationId: ConversationId): Promise<void>;
    createMessage(input: CreateMessageInput): Promise<MessageRecord>;
    createMessagesBulk(inputs: CreateMessageInput[]): Promise<MessageRecord[]>;
    getMessages(conversationId: ConversationId, opts?: {
        afterSeq?: number;
        limit?: number;
    }): Promise<MessageRecord[]>;
    getLastMessage(conversationId: ConversationId): Promise<MessageRecord | null>;
    hasMessage(conversationId: ConversationId, role: MessageRole, content: string): Promise<boolean>;
    countMessagesByIdentity(conversationId: ConversationId, role: MessageRole, content: string): Promise<number>;
    getMessageById(messageId: MessageId): Promise<MessageRecord | null>;
    createMessageParts(messageId: MessageId, parts: CreateMessagePartInput[]): Promise<void>;
    getMessageParts(messageId: MessageId): Promise<MessagePartRecord[]>;
    getMessageCount(conversationId: ConversationId): Promise<number>;
    getMaxSeq(conversationId: ConversationId): Promise<number>;
    /**
     * Delete messages and their associated records (context_items, FTS, message_parts).
     *
     * Skips messages referenced in summary_messages (already compacted) to avoid
     * breaking the summary DAG. Returns the count of actually deleted messages.
     */
    deleteMessages(messageIds: MessageId[]): Promise<number>;
    searchMessages(input: MessageSearchInput): Promise<MessageSearchResult[]>;
    private indexMessageForFullText;
    private deleteMessageFromFullText;
    private searchFullText;
    private searchFullTextSqlite;
    private searchFullTextPostgres;
    private searchLike;
    private searchRegex;
    private searchRegexSqlite;
    private searchRegexPostgres;
}
