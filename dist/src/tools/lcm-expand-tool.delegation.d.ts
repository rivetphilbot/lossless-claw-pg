import type { LcmContextEngine } from "../engine.js";
import type { LcmDependencies } from "../types.js";
type DelegatedPassStatus = "ok" | "timeout" | "error";
type DelegatedExpansionPassResult = {
    pass: number;
    status: DelegatedPassStatus;
    runId: string;
    childSessionKey: string;
    summary: string;
    citedIds: string[];
    followUpSummaryIds: string[];
    totalTokens: number;
    truncated: boolean;
    rawReply?: string;
    error?: string;
};
export type DelegatedExpansionLoopResult = {
    status: DelegatedPassStatus;
    passes: DelegatedExpansionPassResult[];
    citedIds: string[];
    totalTokens: number;
    truncated: boolean;
    text: string;
    error?: string;
};
export declare function normalizeSummaryIds(input: string[] | undefined): string[];
/**
 * Resolve the requester's active LCM conversation ID from the session store.
 * This allows delegated expansion to stay scoped even when conversationId
 * wasn't passed explicitly in the tool call.
 */
export declare function resolveRequesterConversationScopeId(params: {
    deps: Pick<LcmDependencies, "resolveSessionIdFromSessionKey">;
    requesterSessionKey: string;
    lcm: LcmContextEngine;
}): Promise<number | undefined>;
export declare function runDelegatedExpansionLoop(params: {
    deps: Pick<LcmDependencies, "callGateway" | "parseAgentSessionKey" | "normalizeAgentId" | "buildSubagentSystemPrompt" | "readLatestAssistantReply" | "agentLaneSubagent" | "log">;
    requesterSessionKey: string;
    conversationId: number;
    summaryIds: string[];
    maxDepth?: number;
    tokenCap?: number;
    includeMessages: boolean;
    query?: string;
    requestId?: string;
}): Promise<DelegatedExpansionLoopResult>;
export {};
