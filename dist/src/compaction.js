import { createHash } from "node:crypto";
import { extractFileIdsFromContent } from "./large-files.js";
// ── Helpers ──────────────────────────────────────────────────────────────────
/** Estimate token count from character length (~4 chars per token). */
function estimateTokens(content) {
    return Math.ceil(content.length / 4);
}
/** Format a timestamp as `YYYY-MM-DD HH:mm TZ` for prompt source text. */
function formatTimestamp(value, timezone = "UTC") {
    try {
        const fmt = new Intl.DateTimeFormat("en-CA", {
            timeZone: timezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        });
        const parts = Object.fromEntries(fmt.formatToParts(value).map((p) => [p.type, p.value]));
        const tzAbbr = timezone === "UTC" ? "UTC" : shortTzAbbr(value, timezone);
        return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${tzAbbr}`;
    }
    catch {
        // Fallback to UTC on invalid timezone
        const year = value.getUTCFullYear();
        const month = String(value.getUTCMonth() + 1).padStart(2, "0");
        const day = String(value.getUTCDate()).padStart(2, "0");
        const hours = String(value.getUTCHours()).padStart(2, "0");
        const minutes = String(value.getUTCMinutes()).padStart(2, "0");
        return `${year}-${month}-${day} ${hours}:${minutes} UTC`;
    }
}
/** Extract short timezone abbreviation (e.g. "PST", "PDT", "EST"). */
function shortTzAbbr(value, timezone) {
    try {
        const abbr = new Intl.DateTimeFormat("en-US", {
            timeZone: timezone,
            timeZoneName: "short",
        })
            .formatToParts(value)
            .find((p) => p.type === "timeZoneName")?.value;
        return abbr ?? timezone;
    }
    catch {
        return timezone;
    }
}
/** Generate a deterministic summary ID from content + timestamp. */
function generateSummaryId(content) {
    return ("sum_" +
        createHash("sha256")
            .update(content + Date.now().toString())
            .digest("hex")
            .slice(0, 16));
}
/** Maximum characters for the deterministic fallback truncation (512 tokens * 4 chars). */
const FALLBACK_MAX_CHARS = 512 * 4;
const DEFAULT_LEAF_CHUNK_TOKENS = 20_000;
const CONDENSED_MIN_INPUT_RATIO = 0.1;
function dedupeOrderedIds(ids) {
    const seen = new Set();
    const ordered = [];
    for (const id of ids) {
        if (!seen.has(id)) {
            seen.add(id);
            ordered.push(id);
        }
    }
    return ordered;
}
// ── CompactionEngine ─────────────────────────────────────────────────────────
export class CompactionEngine {
    conversationStore;
    summaryStore;
    config;
    constructor(conversationStore, summaryStore, config) {
        this.conversationStore = conversationStore;
        this.summaryStore = summaryStore;
        this.config = config;
    }
    // ── evaluate ─────────────────────────────────────────────────────────────
    /** Evaluate whether compaction is needed. */
    async evaluate(conversationId, tokenBudget, observedTokenCount) {
        const storedTokens = await this.summaryStore.getContextTokenCount(conversationId);
        const liveTokens = typeof observedTokenCount === "number" &&
            Number.isFinite(observedTokenCount) &&
            observedTokenCount > 0
            ? Math.floor(observedTokenCount)
            : 0;
        const currentTokens = Math.max(storedTokens, liveTokens);
        const threshold = Math.floor(this.config.contextThreshold * tokenBudget);
        if (currentTokens > threshold) {
            return {
                shouldCompact: true,
                reason: "threshold",
                currentTokens,
                threshold,
            };
        }
        return {
            shouldCompact: false,
            reason: "none",
            currentTokens,
            threshold,
        };
    }
    /**
     * Evaluate whether the raw-message leaf trigger is active.
     *
     * Counts message tokens outside the protected fresh tail and compares against
     * `leafChunkTokens`. This lets callers trigger a soft incremental leaf pass
     * before the full context threshold is breached.
     */
    async evaluateLeafTrigger(conversationId) {
        const rawTokensOutsideTail = await this.countRawTokensOutsideFreshTail(conversationId);
        const threshold = this.resolveLeafChunkTokens();
        return {
            shouldCompact: rawTokensOutsideTail >= threshold,
            rawTokensOutsideTail,
            threshold,
        };
    }
    // ── compact ──────────────────────────────────────────────────────────────
    /** Run a full compaction sweep for a conversation. */
    async compact(input) {
        return this.compactFullSweep(input);
    }
    /**
     * Run a single leaf pass against the oldest compactable raw chunk.
     *
     * This is the soft-trigger path used for incremental maintenance.
     */
    async compactLeaf(input) {
        const { conversationId, tokenBudget, summarize, force } = input;
        const tokensBefore = await this.summaryStore.getContextTokenCount(conversationId);
        const threshold = Math.floor(this.config.contextThreshold * tokenBudget);
        const leafTrigger = await this.evaluateLeafTrigger(conversationId);
        if (!force && tokensBefore <= threshold && !leafTrigger.shouldCompact) {
            return {
                actionTaken: false,
                tokensBefore,
                tokensAfter: tokensBefore,
                condensed: false,
            };
        }
        const leafChunk = await this.selectOldestLeafChunk(conversationId);
        if (leafChunk.items.length === 0) {
            return {
                actionTaken: false,
                tokensBefore,
                tokensAfter: tokensBefore,
                condensed: false,
            };
        }
        const previousSummaryContent = input.previousSummaryContent ??
            (await this.resolvePriorLeafSummaryContext(conversationId, leafChunk.items));
        const leafResult = await this.leafPass(conversationId, leafChunk.items, summarize, previousSummaryContent);
        const tokensAfterLeaf = await this.summaryStore.getContextTokenCount(conversationId);
        await this.persistCompactionEvents({
            conversationId,
            tokensBefore,
            tokensAfterLeaf,
            tokensAfterFinal: tokensAfterLeaf,
            leafResult: { summaryId: leafResult.summaryId, level: leafResult.level },
            condenseResult: null,
        });
        let tokensAfter = tokensAfterLeaf;
        let condensed = false;
        let createdSummaryId = leafResult.summaryId;
        let level = leafResult.level;
        const incrementalMaxDepth = this.resolveIncrementalMaxDepth();
        const condensedMinChunkTokens = this.resolveCondensedMinChunkTokens();
        if (incrementalMaxDepth > 0) {
            for (let targetDepth = 0; targetDepth < incrementalMaxDepth; targetDepth++) {
                const fanout = this.resolveFanoutForDepth(targetDepth, false);
                const chunk = await this.selectOldestChunkAtDepth(conversationId, targetDepth);
                if (chunk.items.length < fanout || chunk.summaryTokens < condensedMinChunkTokens) {
                    break;
                }
                const passTokensBefore = await this.summaryStore.getContextTokenCount(conversationId);
                const condenseResult = await this.condensedPass(conversationId, chunk.items, targetDepth, summarize);
                const passTokensAfter = await this.summaryStore.getContextTokenCount(conversationId);
                await this.persistCompactionEvents({
                    conversationId,
                    tokensBefore: passTokensBefore,
                    tokensAfterLeaf: passTokensBefore,
                    tokensAfterFinal: passTokensAfter,
                    leafResult: null,
                    condenseResult,
                });
                tokensAfter = passTokensAfter;
                condensed = true;
                createdSummaryId = condenseResult.summaryId;
                level = condenseResult.level;
                if (passTokensAfter >= passTokensBefore) {
                    break;
                }
            }
        }
        return {
            actionTaken: true,
            tokensBefore,
            tokensAfter,
            createdSummaryId,
            condensed,
            level,
        };
    }
    /**
     * Run a hard-trigger sweep:
     *
     * Phase 1: repeatedly compact raw-message chunks outside the fresh tail.
     * Phase 2: repeatedly condense oldest summary chunks while chunk utilization
     *          remains high enough to be worthwhile.
     */
    async compactFullSweep(input) {
        const { conversationId, tokenBudget, summarize, force, hardTrigger } = input;
        const tokensBefore = await this.summaryStore.getContextTokenCount(conversationId);
        const threshold = Math.floor(this.config.contextThreshold * tokenBudget);
        const leafTrigger = await this.evaluateLeafTrigger(conversationId);
        if (!force && tokensBefore <= threshold && !leafTrigger.shouldCompact) {
            return {
                actionTaken: false,
                tokensBefore,
                tokensAfter: tokensBefore,
                condensed: false,
            };
        }
        const contextItems = await this.summaryStore.getContextItems(conversationId);
        if (contextItems.length === 0) {
            return {
                actionTaken: false,
                tokensBefore,
                tokensAfter: tokensBefore,
                condensed: false,
            };
        }
        let actionTaken = false;
        let condensed = false;
        let createdSummaryId;
        let level;
        let previousSummaryContent;
        let previousTokens = tokensBefore;
        // Phase 1: leaf passes over oldest raw chunks outside the protected tail.
        while (true) {
            const leafChunk = await this.selectOldestLeafChunk(conversationId);
            if (leafChunk.items.length === 0) {
                break;
            }
            const passTokensBefore = await this.summaryStore.getContextTokenCount(conversationId);
            const leafResult = await this.leafPass(conversationId, leafChunk.items, summarize, previousSummaryContent);
            const passTokensAfter = await this.summaryStore.getContextTokenCount(conversationId);
            await this.persistCompactionEvents({
                conversationId,
                tokensBefore: passTokensBefore,
                tokensAfterLeaf: passTokensAfter,
                tokensAfterFinal: passTokensAfter,
                leafResult: { summaryId: leafResult.summaryId, level: leafResult.level },
                condenseResult: null,
            });
            actionTaken = true;
            createdSummaryId = leafResult.summaryId;
            level = leafResult.level;
            previousSummaryContent = leafResult.content;
            if (passTokensAfter >= passTokensBefore || passTokensAfter >= previousTokens) {
                break;
            }
            previousTokens = passTokensAfter;
        }
        // Phase 2: depth-aware condensed passes, always processing shallowest depth first.
        while (true) {
            const candidate = await this.selectShallowestCondensationCandidate({
                conversationId,
                hardTrigger: hardTrigger === true,
            });
            if (!candidate) {
                break;
            }
            const passTokensBefore = await this.summaryStore.getContextTokenCount(conversationId);
            const condenseResult = await this.condensedPass(conversationId, candidate.chunk.items, candidate.targetDepth, summarize);
            const passTokensAfter = await this.summaryStore.getContextTokenCount(conversationId);
            await this.persistCompactionEvents({
                conversationId,
                tokensBefore: passTokensBefore,
                tokensAfterLeaf: passTokensBefore,
                tokensAfterFinal: passTokensAfter,
                leafResult: null,
                condenseResult,
            });
            actionTaken = true;
            condensed = true;
            createdSummaryId = condenseResult.summaryId;
            level = condenseResult.level;
            if (passTokensAfter >= passTokensBefore || passTokensAfter >= previousTokens) {
                break;
            }
            previousTokens = passTokensAfter;
        }
        const tokensAfter = await this.summaryStore.getContextTokenCount(conversationId);
        return {
            actionTaken,
            tokensBefore,
            tokensAfter,
            createdSummaryId,
            condensed,
            level,
        };
    }
    // ── compactUntilUnder ────────────────────────────────────────────────────
    /** Compact until under the requested target, running up to maxRounds. */
    async compactUntilUnder(input) {
        const { conversationId, tokenBudget, summarize } = input;
        const targetTokens = typeof input.targetTokens === "number" &&
            Number.isFinite(input.targetTokens) &&
            input.targetTokens > 0
            ? Math.floor(input.targetTokens)
            : tokenBudget;
        const storedTokens = await this.summaryStore.getContextTokenCount(conversationId);
        const liveTokens = typeof input.currentTokens === "number" &&
            Number.isFinite(input.currentTokens) &&
            input.currentTokens > 0
            ? Math.floor(input.currentTokens)
            : 0;
        let lastTokens = Math.max(storedTokens, liveTokens);
        // For forced overflow recovery, callers may pass an observed count that
        // equals the context budget. Treat equality as still needing a compaction
        // attempt so we can create headroom for provider-side framing overhead.
        if (lastTokens < targetTokens) {
            return { success: true, rounds: 0, finalTokens: lastTokens };
        }
        for (let round = 1; round <= this.config.maxRounds; round++) {
            const result = await this.compact({
                conversationId,
                tokenBudget,
                summarize,
                force: true,
            });
            if (result.tokensAfter <= targetTokens) {
                return {
                    success: true,
                    rounds: round,
                    finalTokens: result.tokensAfter,
                };
            }
            // No progress -- bail to avoid infinite loop
            if (!result.actionTaken || result.tokensAfter >= lastTokens) {
                return {
                    success: false,
                    rounds: round,
                    finalTokens: result.tokensAfter,
                };
            }
            lastTokens = result.tokensAfter;
        }
        // Exhausted all rounds
        const finalTokens = await this.summaryStore.getContextTokenCount(conversationId);
        return {
            success: finalTokens <= targetTokens,
            rounds: this.config.maxRounds,
            finalTokens,
        };
    }
    // ── Private helpers ──────────────────────────────────────────────────────
    /** Normalize configured leaf chunk size to a safe positive integer. */
    resolveLeafChunkTokens() {
        if (typeof this.config.leafChunkTokens === "number" &&
            Number.isFinite(this.config.leafChunkTokens) &&
            this.config.leafChunkTokens > 0) {
            return Math.floor(this.config.leafChunkTokens);
        }
        return DEFAULT_LEAF_CHUNK_TOKENS;
    }
    /** Normalize configured fresh tail count to a safe non-negative integer. */
    resolveFreshTailCount() {
        if (typeof this.config.freshTailCount === "number" &&
            Number.isFinite(this.config.freshTailCount) &&
            this.config.freshTailCount > 0) {
            return Math.floor(this.config.freshTailCount);
        }
        return 0;
    }
    /**
     * Compute the ordinal boundary for protected fresh messages.
     *
     * Messages with ordinal >= returned value are preserved as fresh tail.
     */
    resolveFreshTailOrdinal(contextItems) {
        const freshTailCount = this.resolveFreshTailCount();
        if (freshTailCount <= 0) {
            return Infinity;
        }
        const rawMessageItems = contextItems.filter((item) => item.itemType === "message" && item.messageId != null);
        if (rawMessageItems.length === 0) {
            return Infinity;
        }
        const tailStartIdx = Math.max(0, rawMessageItems.length - freshTailCount);
        return rawMessageItems[tailStartIdx]?.ordinal ?? Infinity;
    }
    /** Resolve message token count with a content-length fallback. */
    async getMessageTokenCount(messageId) {
        const message = await this.conversationStore.getMessageById(messageId);
        if (!message) {
            return 0;
        }
        if (typeof message.tokenCount === "number" &&
            Number.isFinite(message.tokenCount) &&
            message.tokenCount > 0) {
            return message.tokenCount;
        }
        return estimateTokens(message.content);
    }
    /** Sum raw message tokens outside the protected fresh tail. */
    async countRawTokensOutsideFreshTail(conversationId) {
        const contextItems = await this.summaryStore.getContextItems(conversationId);
        const freshTailOrdinal = this.resolveFreshTailOrdinal(contextItems);
        let rawTokens = 0;
        for (const item of contextItems) {
            if (item.ordinal >= freshTailOrdinal) {
                break;
            }
            if (item.itemType !== "message" || item.messageId == null) {
                continue;
            }
            rawTokens += await this.getMessageTokenCount(item.messageId);
        }
        return rawTokens;
    }
    /**
     * Select the oldest contiguous raw-message chunk outside fresh tail.
     *
     * The selected chunk size is capped by `leafChunkTokens`, but we always pick
     * at least one message when any compactable message exists.
     */
    async selectOldestLeafChunk(conversationId) {
        const contextItems = await this.summaryStore.getContextItems(conversationId);
        const freshTailOrdinal = this.resolveFreshTailOrdinal(contextItems);
        const threshold = this.resolveLeafChunkTokens();
        let rawTokensOutsideTail = 0;
        for (const item of contextItems) {
            if (item.ordinal >= freshTailOrdinal) {
                break;
            }
            if (item.itemType !== "message" || item.messageId == null) {
                continue;
            }
            rawTokensOutsideTail += await this.getMessageTokenCount(item.messageId);
        }
        const chunk = [];
        let chunkTokens = 0;
        let started = false;
        for (const item of contextItems) {
            if (item.ordinal >= freshTailOrdinal) {
                break;
            }
            if (!started) {
                if (item.itemType !== "message" || item.messageId == null) {
                    continue;
                }
                started = true;
            }
            else if (item.itemType !== "message" || item.messageId == null) {
                break;
            }
            if (item.messageId == null) {
                continue;
            }
            const messageTokens = await this.getMessageTokenCount(item.messageId);
            if (chunk.length > 0 && chunkTokens + messageTokens > threshold) {
                break;
            }
            chunk.push(item);
            chunkTokens += messageTokens;
            if (chunkTokens >= threshold) {
                break;
            }
        }
        return { items: chunk, rawTokensOutsideTail, threshold };
    }
    /**
     * Resolve recent summary continuity for a leaf pass.
     *
     * Collects up to two most recent summary context items that precede the
     * compacted raw-message chunk and returns their combined content.
     */
    async resolvePriorLeafSummaryContext(conversationId, messageItems) {
        if (messageItems.length === 0) {
            return undefined;
        }
        const startOrdinal = Math.min(...messageItems.map((item) => item.ordinal));
        const priorSummaryItems = (await this.summaryStore.getContextItems(conversationId))
            .filter((item) => item.ordinal < startOrdinal &&
            item.itemType === "summary" &&
            typeof item.summaryId === "string")
            .slice(-2);
        if (priorSummaryItems.length === 0) {
            return undefined;
        }
        const summaryContents = [];
        for (const item of priorSummaryItems) {
            if (typeof item.summaryId !== "string") {
                continue;
            }
            const summary = await this.summaryStore.getSummary(item.summaryId);
            const content = summary?.content.trim();
            if (content) {
                summaryContents.push(content);
            }
        }
        if (summaryContents.length === 0) {
            return undefined;
        }
        return summaryContents.join("\n\n");
    }
    /** Resolve summary token count with content-length fallback. */
    resolveSummaryTokenCount(summary) {
        if (typeof summary.tokenCount === "number" &&
            Number.isFinite(summary.tokenCount) &&
            summary.tokenCount > 0) {
            return summary.tokenCount;
        }
        return estimateTokens(summary.content);
    }
    /** Resolve message token count with content-length fallback. */
    resolveMessageTokenCount(message) {
        if (typeof message.tokenCount === "number" &&
            Number.isFinite(message.tokenCount) &&
            message.tokenCount > 0) {
            return message.tokenCount;
        }
        return estimateTokens(message.content);
    }
    resolveLeafMinFanout() {
        if (typeof this.config.leafMinFanout === "number" &&
            Number.isFinite(this.config.leafMinFanout) &&
            this.config.leafMinFanout > 0) {
            return Math.floor(this.config.leafMinFanout);
        }
        return 8;
    }
    resolveCondensedMinFanout() {
        if (typeof this.config.condensedMinFanout === "number" &&
            Number.isFinite(this.config.condensedMinFanout) &&
            this.config.condensedMinFanout > 0) {
            return Math.floor(this.config.condensedMinFanout);
        }
        return 4;
    }
    resolveCondensedMinFanoutHard() {
        if (typeof this.config.condensedMinFanoutHard === "number" &&
            Number.isFinite(this.config.condensedMinFanoutHard) &&
            this.config.condensedMinFanoutHard > 0) {
            return Math.floor(this.config.condensedMinFanoutHard);
        }
        return 2;
    }
    resolveIncrementalMaxDepth() {
        if (typeof this.config.incrementalMaxDepth === "number" &&
            Number.isFinite(this.config.incrementalMaxDepth)) {
            if (this.config.incrementalMaxDepth < 0)
                return Infinity;
            if (this.config.incrementalMaxDepth > 0)
                return Math.floor(this.config.incrementalMaxDepth);
        }
        return 0;
    }
    resolveFanoutForDepth(targetDepth, hardTrigger) {
        if (hardTrigger) {
            return this.resolveCondensedMinFanoutHard();
        }
        if (targetDepth === 0) {
            return this.resolveLeafMinFanout();
        }
        return this.resolveCondensedMinFanout();
    }
    /** Minimum condensed input size before we run another condensed pass. */
    resolveCondensedMinChunkTokens() {
        const chunkTarget = this.resolveLeafChunkTokens();
        const ratioFloor = Math.floor(chunkTarget * CONDENSED_MIN_INPUT_RATIO);
        return Math.max(this.config.condensedTargetTokens, ratioFloor);
    }
    /**
     * Find the shallowest depth with an eligible same-depth summary chunk.
     */
    async selectShallowestCondensationCandidate(params) {
        const { conversationId, hardTrigger } = params;
        const contextItems = await this.summaryStore.getContextItems(conversationId);
        const freshTailOrdinal = this.resolveFreshTailOrdinal(contextItems);
        const minChunkTokens = this.resolveCondensedMinChunkTokens();
        const depthLevels = await this.summaryStore.getDistinctDepthsInContext(conversationId, {
            maxOrdinalExclusive: freshTailOrdinal,
        });
        for (const targetDepth of depthLevels) {
            const fanout = this.resolveFanoutForDepth(targetDepth, hardTrigger);
            const chunk = await this.selectOldestChunkAtDepth(conversationId, targetDepth, freshTailOrdinal);
            if (chunk.items.length < fanout) {
                continue;
            }
            if (chunk.summaryTokens < minChunkTokens) {
                continue;
            }
            return { targetDepth, chunk };
        }
        return null;
    }
    /**
     * Select the oldest contiguous summary chunk at a specific summary depth.
     *
     * Once selection starts, any non-summary item or depth mismatch terminates
     * the chunk to prevent mixed-depth condensation.
     */
    async selectOldestChunkAtDepth(conversationId, targetDepth, freshTailOrdinalOverride) {
        const contextItems = await this.summaryStore.getContextItems(conversationId);
        const freshTailOrdinal = typeof freshTailOrdinalOverride === "number"
            ? freshTailOrdinalOverride
            : this.resolveFreshTailOrdinal(contextItems);
        const chunkTokenBudget = this.resolveLeafChunkTokens();
        const chunk = [];
        let summaryTokens = 0;
        for (const item of contextItems) {
            if (item.ordinal >= freshTailOrdinal) {
                break;
            }
            if (item.itemType !== "summary" || item.summaryId == null) {
                if (chunk.length > 0) {
                    break;
                }
                continue;
            }
            const summary = await this.summaryStore.getSummary(item.summaryId);
            if (!summary) {
                if (chunk.length > 0) {
                    break;
                }
                continue;
            }
            if (summary.depth !== targetDepth) {
                if (chunk.length > 0) {
                    break;
                }
                continue;
            }
            const tokenCount = this.resolveSummaryTokenCount(summary);
            if (chunk.length > 0 && summaryTokens + tokenCount > chunkTokenBudget) {
                break;
            }
            chunk.push(item);
            summaryTokens += tokenCount;
            if (summaryTokens >= chunkTokenBudget) {
                break;
            }
        }
        return { items: chunk, summaryTokens };
    }
    async resolvePriorSummaryContextAtDepth(conversationId, summaryItems, targetDepth) {
        if (summaryItems.length === 0) {
            return undefined;
        }
        const startOrdinal = Math.min(...summaryItems.map((item) => item.ordinal));
        const priorSummaryItems = (await this.summaryStore.getContextItems(conversationId))
            .filter((item) => item.ordinal < startOrdinal &&
            item.itemType === "summary" &&
            typeof item.summaryId === "string")
            .slice(-4);
        if (priorSummaryItems.length === 0) {
            return undefined;
        }
        const summaryContents = [];
        for (const item of priorSummaryItems) {
            if (typeof item.summaryId !== "string") {
                continue;
            }
            const summary = await this.summaryStore.getSummary(item.summaryId);
            if (!summary || summary.depth !== targetDepth) {
                continue;
            }
            const content = summary.content.trim();
            if (content) {
                summaryContents.push(content);
            }
        }
        if (summaryContents.length === 0) {
            return undefined;
        }
        return summaryContents.slice(-2).join("\n\n");
    }
    /**
     * Run three-level summarization escalation:
     * normal -> aggressive -> deterministic fallback.
     */
    async summarizeWithEscalation(params) {
        const sourceText = params.sourceText.trim();
        if (!sourceText) {
            return {
                content: "[Truncated from 0 tokens]",
                level: "fallback",
            };
        }
        const inputTokens = Math.max(1, estimateTokens(sourceText));
        let summaryText = await params.summarize(sourceText, false, params.options);
        let level = "normal";
        if (estimateTokens(summaryText) >= inputTokens) {
            summaryText = await params.summarize(sourceText, true, params.options);
            level = "aggressive";
            if (estimateTokens(summaryText) >= inputTokens) {
                const truncated = sourceText.length > FALLBACK_MAX_CHARS
                    ? sourceText.slice(0, FALLBACK_MAX_CHARS)
                    : sourceText;
                summaryText = `${truncated}\n[Truncated from ${inputTokens} tokens]`;
                level = "fallback";
            }
        }
        return { content: summaryText, level };
    }
    // ── Private: Leaf Pass ───────────────────────────────────────────────────
    /**
     * Summarize a chunk of messages into one leaf summary.
     */
    async leafPass(conversationId, messageItems, summarize, previousSummaryContent) {
        // Fetch full message content for each context item
        const messageContents = [];
        for (const item of messageItems) {
            if (item.messageId == null) {
                continue;
            }
            const msg = await this.conversationStore.getMessageById(item.messageId);
            if (msg) {
                messageContents.push({
                    messageId: msg.messageId,
                    content: msg.content,
                    createdAt: msg.createdAt,
                    tokenCount: this.resolveMessageTokenCount(msg),
                });
            }
        }
        const concatenated = messageContents
            .map((message) => `[${formatTimestamp(message.createdAt, this.config.timezone)}]\n${message.content}`)
            .join("\n\n");
        const fileIds = dedupeOrderedIds(messageContents.flatMap((message) => extractFileIdsFromContent(message.content)));
        const summary = await this.summarizeWithEscalation({
            sourceText: concatenated,
            summarize,
            options: {
                previousSummary: previousSummaryContent,
                isCondensed: false,
            },
        });
        // Persist the leaf summary
        const summaryId = generateSummaryId(summary.content);
        const tokenCount = estimateTokens(summary.content);
        await this.summaryStore.insertSummary({
            summaryId,
            conversationId,
            kind: "leaf",
            depth: 0,
            content: summary.content,
            tokenCount,
            fileIds,
            earliestAt: messageContents.length > 0
                ? new Date(Math.min(...messageContents.map((message) => message.createdAt.getTime())))
                : undefined,
            latestAt: messageContents.length > 0
                ? new Date(Math.max(...messageContents.map((message) => message.createdAt.getTime())))
                : undefined,
            descendantCount: 0,
            descendantTokenCount: 0,
            sourceMessageTokenCount: messageContents.reduce((sum, message) => sum + Math.max(0, Math.floor(message.tokenCount)), 0),
        });
        // Link to source messages
        const messageIds = messageContents.map((m) => m.messageId);
        await this.summaryStore.linkSummaryToMessages(summaryId, messageIds);
        // Replace the message range in context with the new summary
        const ordinals = messageItems.map((ci) => ci.ordinal);
        const startOrdinal = Math.min(...ordinals);
        const endOrdinal = Math.max(...ordinals);
        await this.summaryStore.replaceContextRangeWithSummary({
            conversationId,
            startOrdinal,
            endOrdinal,
            summaryId,
        });
        return { summaryId, level: summary.level, content: summary.content };
    }
    // ── Private: Condensed Pass ──────────────────────────────────────────────
    /**
     * Condense one ratio-sized summary chunk into a single condensed summary.
     */
    async condensedPass(conversationId, summaryItems, targetDepth, summarize) {
        // Fetch full summary records
        const summaryRecords = [];
        for (const item of summaryItems) {
            if (item.summaryId == null) {
                continue;
            }
            const rec = await this.summaryStore.getSummary(item.summaryId);
            if (rec) {
                summaryRecords.push(rec);
            }
        }
        const concatenated = summaryRecords
            .map((summary) => {
            const earliestAt = summary.earliestAt ?? summary.createdAt;
            const latestAt = summary.latestAt ?? summary.createdAt;
            const tz = this.config.timezone;
            const header = `[${formatTimestamp(earliestAt, tz)} - ${formatTimestamp(latestAt, tz)}]`;
            return `${header}\n${summary.content}`;
        })
            .join("\n\n");
        const fileIds = dedupeOrderedIds(summaryRecords.flatMap((summary) => [
            ...summary.fileIds,
            ...extractFileIdsFromContent(summary.content),
        ]));
        const previousSummaryContent = targetDepth === 0
            ? await this.resolvePriorSummaryContextAtDepth(conversationId, summaryItems, targetDepth)
            : undefined;
        const condensed = await this.summarizeWithEscalation({
            sourceText: concatenated,
            summarize,
            options: {
                previousSummary: previousSummaryContent,
                isCondensed: true,
                depth: targetDepth + 1,
            },
        });
        // Persist the condensed summary
        const summaryId = generateSummaryId(condensed.content);
        const tokenCount = estimateTokens(condensed.content);
        await this.summaryStore.insertSummary({
            summaryId,
            conversationId,
            kind: "condensed",
            depth: targetDepth + 1,
            content: condensed.content,
            tokenCount,
            fileIds,
            earliestAt: summaryRecords.length > 0
                ? new Date(Math.min(...summaryRecords.map((summary) => (summary.earliestAt ?? summary.createdAt).getTime())))
                : undefined,
            latestAt: summaryRecords.length > 0
                ? new Date(Math.max(...summaryRecords.map((summary) => (summary.latestAt ?? summary.createdAt).getTime())))
                : undefined,
            descendantCount: summaryRecords.reduce((count, summary) => {
                const childDescendants = typeof summary.descendantCount === "number" && Number.isFinite(summary.descendantCount)
                    ? Math.max(0, Math.floor(summary.descendantCount))
                    : 0;
                return count + childDescendants + 1;
            }, 0),
            descendantTokenCount: summaryRecords.reduce((count, summary) => {
                const childDescendantTokens = typeof summary.descendantTokenCount === "number" &&
                    Number.isFinite(summary.descendantTokenCount)
                    ? Math.max(0, Math.floor(summary.descendantTokenCount))
                    : 0;
                return count + Math.max(0, Math.floor(summary.tokenCount)) + childDescendantTokens;
            }, 0),
            sourceMessageTokenCount: summaryRecords.reduce((count, summary) => {
                const sourceTokens = typeof summary.sourceMessageTokenCount === "number" &&
                    Number.isFinite(summary.sourceMessageTokenCount)
                    ? Math.max(0, Math.floor(summary.sourceMessageTokenCount))
                    : 0;
                return count + sourceTokens;
            }, 0),
        });
        // Link to parent summaries
        const parentSummaryIds = summaryRecords.map((s) => s.summaryId);
        await this.summaryStore.linkSummaryToParents(summaryId, parentSummaryIds);
        // Replace all summary items in context with the condensed summary
        const ordinals = summaryItems.map((ci) => ci.ordinal);
        const startOrdinal = Math.min(...ordinals);
        const endOrdinal = Math.max(...ordinals);
        await this.summaryStore.replaceContextRangeWithSummary({
            conversationId,
            startOrdinal,
            endOrdinal,
            summaryId,
        });
        return { summaryId, level: condensed.level };
    }
    /**
     * Persist durable compaction events into canonical history as message parts.
     *
     * Event persistence is best-effort: failures are swallowed to avoid
     * compromising the core compaction path.
     */
    async persistCompactionEvents(input) {
        const { conversationId, tokensBefore, tokensAfterLeaf, tokensAfterFinal, leafResult, condenseResult, } = input;
        if (!leafResult && !condenseResult) {
            return;
        }
        const conversation = await this.conversationStore.getConversation(conversationId);
        if (!conversation) {
            return;
        }
        const createdSummaryIds = [leafResult?.summaryId, condenseResult?.summaryId].filter((id) => typeof id === "string" && id.length > 0);
        const condensedPassOccurred = condenseResult !== null;
        if (leafResult) {
            await this.persistCompactionEvent({
                conversationId,
                sessionId: conversation.sessionId,
                pass: "leaf",
                level: leafResult.level,
                tokensBefore,
                tokensAfter: tokensAfterLeaf,
                createdSummaryId: leafResult.summaryId,
                createdSummaryIds,
                condensedPassOccurred,
            });
        }
        if (condenseResult) {
            await this.persistCompactionEvent({
                conversationId,
                sessionId: conversation.sessionId,
                pass: "condensed",
                level: condenseResult.level,
                tokensBefore: tokensAfterLeaf,
                tokensAfter: tokensAfterFinal,
                createdSummaryId: condenseResult.summaryId,
                createdSummaryIds,
                condensedPassOccurred,
            });
        }
    }
    /** Write one compaction event message + part atomically where possible. */
    async persistCompactionEvent(input) {
        const content = `LCM compaction ${input.pass} pass (${input.level}): ${input.tokensBefore} -> ${input.tokensAfter}`;
        const metadata = JSON.stringify({
            conversationId: input.conversationId,
            pass: input.pass,
            level: input.level,
            tokensBefore: input.tokensBefore,
            tokensAfter: input.tokensAfter,
            createdSummaryId: input.createdSummaryId,
            createdSummaryIds: input.createdSummaryIds,
            condensedPassOccurred: input.condensedPassOccurred,
        });
        const writeEvent = async () => {
            const seq = (await this.conversationStore.getMaxSeq(input.conversationId)) + 1;
            const eventMessage = await this.conversationStore.createMessage({
                conversationId: input.conversationId,
                seq,
                role: "system",
                content,
                tokenCount: estimateTokens(content),
            });
            const parts = [
                {
                    sessionId: input.sessionId,
                    partType: "compaction",
                    ordinal: 0,
                    textContent: content,
                    metadata,
                },
            ];
            await this.conversationStore.createMessageParts(eventMessage.messageId, parts);
        };
        try {
            await this.conversationStore.withTransaction(() => writeEvent());
        }
        catch {
            // Compaction should still succeed if event persistence fails.
        }
    }
}
//# sourceMappingURL=compaction.js.map