/**
 * Sanitize a user-provided query for use with PostgreSQL's plainto_tsquery.
 *
 * plainto_tsquery is much more forgiving than FTS5 MATCH expressions:
 * - It automatically handles most special characters
 * - It treats input as plain text and extracts meaningful words
 * - It doesn't require manual escaping of operators like AND, OR, NOT
 *
 * However, we still need to handle some edge cases:
 * - Very long queries should be truncated
 * - Empty/whitespace-only queries should return a safe default
 * - Control characters should be stripped
 *
 * Examples:
 *   "sub-agent restrict"  →  "sub-agent restrict" (unchanged)
 *   "lcm_expand OR crash" →  "lcm_expand OR crash" (unchanged, plainto_tsquery handles OR)
 *   'hello "world"'       →  'hello "world"' (unchanged, quotes are fine)
 *   ""                    →  "default" (fallback for empty queries)
 */
export declare function sanitizeTsQuery(raw: string): string;
