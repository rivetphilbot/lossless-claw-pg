export type LikeSearchPlan = {
    terms: string[];
    where: string[];
    args: string[];
};
/**
 * Convert a free-text query into a conservative LIKE search plan.
 *
 * The fallback keeps phrase tokens when the query uses double quotes, and
 * otherwise searches for all normalized tokens as case-insensitive substrings.
 */
export declare function buildLikeSearchPlan(column: string, query: string): LikeSearchPlan;
/**
 * Build a compact snippet centered around the earliest matching term.
 */
export declare function createFallbackSnippet(content: string, terms: string[]): string;
