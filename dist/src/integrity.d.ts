import type { ConversationStore } from "./store/conversation-store.js";
import type { SummaryStore } from "./store/summary-store.js";
export type IntegrityCheck = {
    name: string;
    status: "pass" | "fail" | "warn";
    message: string;
    details?: unknown;
};
export type IntegrityReport = {
    conversationId: number;
    checks: IntegrityCheck[];
    passCount: number;
    failCount: number;
    warnCount: number;
    scannedAt: Date;
};
export type LcmMetrics = {
    conversationId: number;
    contextTokens: number;
    messageCount: number;
    summaryCount: number;
    contextItemCount: number;
    leafSummaryCount: number;
    condensedSummaryCount: number;
    largeFileCount: number;
    collectedAt: Date;
};
export declare class IntegrityChecker {
    private conversationStore;
    private summaryStore;
    constructor(conversationStore: ConversationStore, summaryStore: SummaryStore);
    /**
     * Run all integrity checks for a conversation and return a full report.
     * Each check runs independently -- a failure in one does not short-circuit
     * the remaining checks.
     */
    scan(conversationId: number): Promise<IntegrityReport>;
    private checkConversationExists;
    private checkContextItemsContiguous;
    private checkContextItemsValidRefs;
    private checkSummariesHaveLineage;
    private checkNoOrphanSummaries;
    private checkContextTokenConsistency;
    private checkMessageSeqContiguous;
    private checkNoDuplicateContextRefs;
}
/**
 * Generate human-readable repair suggestions for each failing or warning check
 * in an integrity report. Does not perform any actual repairs.
 */
export declare function repairPlan(report: IntegrityReport): string[];
/**
 * Collect LCM observability metrics for a conversation by querying the stores.
 */
export declare function collectMetrics(conversationId: number, conversationStore: ConversationStore, summaryStore: SummaryStore): Promise<LcmMetrics>;
