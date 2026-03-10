import type { LcmDependencies } from "./types.js";
export type LcmSummarizeOptions = {
    previousSummary?: string;
    isCondensed?: boolean;
    depth?: number;
};
export type LcmSummarizeFn = (text: string, aggressive?: boolean, options?: LcmSummarizeOptions) => Promise<string>;
export type LcmSummarizerLegacyParams = {
    provider?: unknown;
    model?: unknown;
    config?: unknown;
    agentDir?: unknown;
    authProfileId?: unknown;
};
/**
 * Builds a model-backed LCM summarize callback from runtime legacy params.
 *
 * Returns `undefined` when model/provider context is unavailable so callers can
 * choose a fallback summarizer.
 */
export declare function createLcmSummarizeFromLegacyParams(params: {
    deps: LcmDependencies;
    legacyParams: LcmSummarizerLegacyParams;
    customInstructions?: string;
}): Promise<LcmSummarizeFn | undefined>;
