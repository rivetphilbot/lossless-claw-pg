import type { LcmDependencies } from "../types.js";
export declare const EXPANSION_RECURSION_ERROR_CODE = "EXPANSION_RECURSION_BLOCKED";
type TelemetryEvent = "start" | "block" | "timeout" | "success";
export type DelegatedExpansionContext = {
    requestId: string;
    expansionDepth: number;
    originSessionKey: string;
    stampedBy: string;
    createdAt: string;
};
export type ExpansionRecursionBlockReason = "depth_cap" | "idempotent_reentry";
export type ExpansionRecursionGuardDecision = {
    blocked: false;
    requestId: string;
    expansionDepth: number;
    originSessionKey: string;
} | {
    blocked: true;
    code: typeof EXPANSION_RECURSION_ERROR_CODE;
    reason: ExpansionRecursionBlockReason;
    message: string;
    requestId: string;
    expansionDepth: number;
    originSessionKey: string;
};
/**
 * Create a stable request identifier for delegated expansion orchestration.
 */
export declare function createExpansionRequestId(): string;
/**
 * Resolve the active expansion request id for a session, inheriting from any
 * stamped delegated context when present.
 */
export declare function resolveExpansionRequestId(sessionKey?: string): string;
/**
 * Resolve the next delegated expansion depth to stamp onto a child session.
 */
export declare function resolveNextExpansionDepth(sessionKey?: string): number;
/**
 * Stamp delegated expansion metadata for a child session so re-entry checks can
 * enforce recursion and depth policies deterministically.
 */
export declare function stampDelegatedExpansionContext(params: {
    sessionKey: string;
    requestId: string;
    expansionDepth: number;
    originSessionKey: string;
    stampedBy: string;
}): DelegatedExpansionContext;
/**
 * Remove delegated expansion metadata for a child session after cleanup.
 */
export declare function clearDelegatedExpansionContext(sessionKey: string): void;
/**
 * Evaluate whether a session is allowed to delegate expansion work.
 * Delegated contexts are blocked at depth >= 1, with repeated request id
 * re-entry mapped to an explicit idempotency block reason.
 */
export declare function evaluateExpansionRecursionGuard(params: {
    sessionKey?: string;
    requestId: string;
}): ExpansionRecursionGuardDecision;
/**
 * Emit structured delegated expansion telemetry with monotonic counters.
 */
export declare function recordExpansionDelegationTelemetry(params: {
    deps: Pick<LcmDependencies, "log">;
    component: string;
    event: TelemetryEvent;
    requestId: string;
    sessionKey?: string;
    expansionDepth: number;
    originSessionKey: string;
    reason?: string;
    runId?: string;
}): void;
/**
 * Return the currently stamped delegated expansion context for test assertions.
 */
export declare function getDelegatedExpansionContextForTests(sessionKey: string): DelegatedExpansionContext | undefined;
/**
 * Return the delegated expansion telemetry counters for tests.
 */
export declare function getExpansionDelegationTelemetrySnapshotForTests(): Record<TelemetryEvent, number>;
/**
 * Reset delegated expansion context and telemetry state between tests.
 */
export declare function resetExpansionDelegationGuardForTests(): void;
export {};
