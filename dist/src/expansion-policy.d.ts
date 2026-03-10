export type LcmExpansionRoutingIntent = "query_probe" | "explicit_expand";
export type LcmExpansionRoutingAction = "answer_directly" | "expand_shallow" | "delegate_traversal";
export type LcmExpansionTokenRiskLevel = "low" | "moderate" | "high";
export type LcmExpansionRoutingInput = {
    intent: LcmExpansionRoutingIntent;
    query?: string;
    requestedMaxDepth?: number;
    candidateSummaryCount: number;
    tokenCap: number;
    includeMessages?: boolean;
};
export type LcmExpansionRoutingDecision = {
    action: LcmExpansionRoutingAction;
    normalizedMaxDepth: number;
    candidateSummaryCount: number;
    estimatedTokens: number;
    tokenCap: number;
    tokenRiskRatio: number;
    tokenRiskLevel: LcmExpansionTokenRiskLevel;
    indicators: {
        broadTimeRange: boolean;
        multiHopRetrieval: boolean;
    };
    triggers: {
        directByNoCandidates: boolean;
        directByLowComplexityProbe: boolean;
        delegateByDepth: boolean;
        delegateByCandidateCount: boolean;
        delegateByTokenRisk: boolean;
        delegateByBroadTimeRangeAndMultiHop: boolean;
    };
    reasons: string[];
};
export declare const EXPANSION_ROUTING_THRESHOLDS: {
    readonly defaultDepth: 3;
    readonly minDepth: 1;
    readonly maxDepth: 10;
    readonly directMaxDepth: 2;
    readonly directMaxCandidates: 1;
    readonly moderateTokenRiskRatio: 0.35;
    readonly highTokenRiskRatio: 0.7;
    readonly baseTokensPerSummary: 220;
    readonly includeMessagesTokenMultiplier: 1.9;
    readonly perDepthTokenGrowth: 0.65;
    readonly broadTimeRangeTokenMultiplier: 1.35;
    readonly multiHopTokenMultiplier: 1.25;
    readonly multiHopDepthThreshold: 3;
    readonly multiHopCandidateThreshold: 5;
};
/**
 * Detect broad time-range intent from the user query.
 *
 * This is a deterministic text heuristic used by orchestration policy only;
 * it does not perform retrieval.
 */
export declare function detectBroadTimeRangeIndicator(query?: string): boolean;
/**
 * Detect whether traversal likely requires multi-hop expansion.
 *
 * Multi-hop is inferred from depth, breadth, and explicit language in the query.
 */
export declare function detectMultiHopIndicator(input: {
    query?: string;
    requestedMaxDepth?: number;
    candidateSummaryCount: number;
}): boolean;
/**
 * Estimate expansion token volume from traversal characteristics.
 *
 * This deterministic estimate intentionally over-approximates near deep/broad
 * traversals so delegation triggers before hitting hard runtime caps.
 */
export declare function estimateExpansionTokens(input: {
    requestedMaxDepth?: number;
    candidateSummaryCount: number;
    includeMessages?: boolean;
    broadTimeRangeIndicator?: boolean;
    multiHopIndicator?: boolean;
}): number;
/** Classify token risk level relative to a provided cap. */
export declare function classifyExpansionTokenRisk(input: {
    estimatedTokens: number;
    tokenCap: number;
}): {
    ratio: number;
    level: LcmExpansionTokenRiskLevel;
};
/**
 * Decide deterministic route-vs-delegate policy for LCM expansion orchestration.
 *
 * The decision matrix supports three outcomes:
 * - answer directly (skip expansion)
 * - do shallow/direct expansion
 * - delegate deep traversal to a sub-agent
 */
export declare function decideLcmExpansionRouting(input: LcmExpansionRoutingInput): LcmExpansionRoutingDecision;
