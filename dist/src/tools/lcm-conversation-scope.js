/**
 * Parse an ISO-8601 timestamp tool parameter into a Date.
 *
 * Throws when the value is not a parseable timestamp string.
 */
export function parseIsoTimestampParam(params, key) {
    const raw = params[key];
    if (typeof raw !== "string") {
        return undefined;
    }
    const value = raw.trim();
    if (!value) {
        return undefined;
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        throw new Error(`${key} must be a valid ISO timestamp.`);
    }
    return parsed;
}
/**
 * Resolve LCM conversation scope for tool calls.
 *
 * Priority:
 * 1. Explicit conversationId parameter
 * 2. allConversations=true (cross-conversation mode)
 * 3. Current session's LCM conversation
 */
export async function resolveLcmConversationScope(input) {
    const { lcm, params } = input;
    const explicitConversationId = typeof params.conversationId === "number" && Number.isFinite(params.conversationId)
        ? Math.trunc(params.conversationId)
        : undefined;
    if (explicitConversationId != null) {
        return { conversationId: explicitConversationId, allConversations: false };
    }
    if (params.allConversations === true) {
        return { conversationId: undefined, allConversations: true };
    }
    let normalizedSessionId = input.sessionId?.trim();
    if (!normalizedSessionId && input.sessionKey && input.deps) {
        normalizedSessionId = await input.deps.resolveSessionIdFromSessionKey(input.sessionKey.trim());
    }
    if (!normalizedSessionId) {
        return { conversationId: undefined, allConversations: false };
    }
    const conversation = await lcm.getConversationStore().getConversationBySessionId(normalizedSessionId);
    if (!conversation) {
        return { conversationId: undefined, allConversations: false };
    }
    return { conversationId: conversation.conversationId, allConversations: false };
}
//# sourceMappingURL=lcm-conversation-scope.js.map