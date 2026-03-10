import type { LcmContextEngine } from "../engine.js";
import type { LcmDependencies } from "../types.js";
export type LcmConversationScope = {
    conversationId?: number;
    allConversations: boolean;
};
/**
 * Parse an ISO-8601 timestamp tool parameter into a Date.
 *
 * Throws when the value is not a parseable timestamp string.
 */
export declare function parseIsoTimestampParam(params: Record<string, unknown>, key: string): Date | undefined;
/**
 * Resolve LCM conversation scope for tool calls.
 *
 * Priority:
 * 1. Explicit conversationId parameter
 * 2. allConversations=true (cross-conversation mode)
 * 3. Current session's LCM conversation
 */
export declare function resolveLcmConversationScope(input: {
    lcm: LcmContextEngine;
    params: Record<string, unknown>;
    sessionId?: string;
    sessionKey?: string;
    deps?: Pick<LcmDependencies, "resolveSessionIdFromSessionKey">;
}): Promise<LcmConversationScope>;
