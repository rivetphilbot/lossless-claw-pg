import type { ExpansionOrchestrator, ExpansionRequest, ExpansionResult } from "./expansion.js";
export type ExpansionGrant = {
    /** Unique grant ID */
    grantId: string;
    /** Session ID that issued the grant */
    issuerSessionId: string;
    /** Conversation IDs the grantee is allowed to traverse */
    allowedConversationIds: number[];
    /** Specific summary IDs the grantee is allowed to expand (if empty, all within conversation are allowed) */
    allowedSummaryIds: string[];
    /** Maximum traversal depth */
    maxDepth: number;
    /** Maximum tokens the grantee can retrieve */
    tokenCap: number;
    /** When the grant expires */
    expiresAt: Date;
    /** Whether this grant has been revoked */
    revoked: boolean;
    /** Creation timestamp */
    createdAt: Date;
};
export type CreateGrantInput = {
    issuerSessionId: string;
    allowedConversationIds: number[];
    allowedSummaryIds?: string[];
    maxDepth?: number;
    tokenCap?: number;
    /** TTL in milliseconds (default: 5 minutes) */
    ttlMs?: number;
};
export type CreateDelegatedExpansionGrantInput = CreateGrantInput & {
    delegatedSessionKey: string;
};
export type ValidationResult = {
    valid: boolean;
    reason?: string;
};
export type AuthorizedExpansionOrchestrator = {
    expand(grantId: string, request: ExpansionRequest): Promise<ExpansionResult>;
};
export declare class ExpansionAuthManager {
    private grants;
    private consumedTokensByGrantId;
    /**
     * Create a new expansion grant with the given parameters.
     * Generates a unique grant ID and applies defaults for optional fields.
     */
    createGrant(input: CreateGrantInput): ExpansionGrant;
    /**
     * Retrieve a grant by ID. Returns null if the grant does not exist,
     * has been revoked, or has expired.
     */
    getGrant(grantId: string): ExpansionGrant | null;
    /**
     * Revoke a grant, preventing any further use.
     * Returns true if the grant was found and revoked, false if not found.
     */
    revokeGrant(grantId: string): boolean;
    /**
     * Resolve remaining token budget for an active grant.
     */
    getRemainingTokenBudget(grantId: string): number | null;
    /**
     * Consume token budget for a grant, clamped to the grant token cap.
     */
    consumeTokenBudget(grantId: string, consumedTokens: number): number | null;
    /**
     * Validate an expansion request against a grant.
     * Checks existence, expiry, revocation, conversation scope, and summary scope.
     */
    validateExpansion(grantId: string, request: {
        conversationId: number;
        summaryIds: string[];
        depth: number;
        tokenCap: number;
    }): ValidationResult;
    /**
     * Remove all expired and revoked grants from the store.
     * Returns the number of grants removed.
     */
    cleanup(): number;
}
/**
 * Return the singleton auth manager used by runtime delegated expansion flows.
 */
export declare function getRuntimeExpansionAuthManager(): ExpansionAuthManager;
/**
 * Create a delegated expansion grant and bind it to the child session key.
 */
export declare function createDelegatedExpansionGrant(input: CreateDelegatedExpansionGrantInput): ExpansionGrant;
/**
 * Resolve the delegated expansion grant id bound to a session key.
 */
export declare function resolveDelegatedExpansionGrantId(sessionKey: string): string | null;
/**
 * Revoke the delegated grant bound to a session key.
 * Optionally remove the binding after revocation.
 */
export declare function revokeDelegatedExpansionGrantForSession(sessionKey: string, opts?: {
    removeBinding?: boolean;
}): boolean;
/**
 * Remove delegated grant binding for a session key without revoking.
 */
export declare function removeDelegatedExpansionGrantForSession(sessionKey: string): boolean;
/**
 * Test-only reset helper for delegated runtime grants.
 */
export declare function resetDelegatedExpansionGrantsForTests(): void;
/**
 * Create a thin authorization wrapper around an ExpansionOrchestrator.
 * The wrapper validates the grant before delegating to the underlying
 * orchestrator.
 */
export declare function wrapWithAuth(orchestrator: ExpansionOrchestrator, authManager: ExpansionAuthManager): AuthorizedExpansionOrchestrator;
