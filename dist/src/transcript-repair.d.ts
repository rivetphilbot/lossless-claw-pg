/**
 * Tool use/result pairing repair for assembled context.
 *
 * Copied from openclaw core (src/agents/session-transcript-repair.ts +
 * src/agents/tool-call-id.ts) to avoid depending on unexported internals.
 * When the plugin SDK exports sanitizeToolUseResultPairing, this file can
 * be removed in favor of the SDK import.
 */
type AgentMessageLike = {
    role: string;
    content?: unknown;
    toolCallId?: string;
    toolUseId?: string;
    toolName?: string;
    stopReason?: string;
    isError?: boolean;
    timestamp?: number;
};
/**
 * Repair tool use/result pairing in an assembled message transcript.
 *
 * Anthropic (and Cloud Code Assist) reject transcripts where assistant tool
 * calls are not immediately followed by matching tool results. This function:
 * - Moves matching toolResult messages directly after their assistant toolCall turn
 * - Inserts synthetic error toolResults for missing IDs
 * - Drops duplicate toolResults for the same ID
 * - Drops orphaned toolResults with no matching tool call
 */
export declare function sanitizeToolUseResultPairing<T extends AgentMessageLike>(messages: T[]): T[];
export {};
