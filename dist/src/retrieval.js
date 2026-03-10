// ── Helpers ──────────────────────────────────────────────────────────────────
/** Rough token estimate: ~4 chars per token. */
function estimateTokens(content) {
    return Math.ceil(content.length / 4);
}
// ── RetrievalEngine ──────────────────────────────────────────────────────────
export class RetrievalEngine {
    conversationStore;
    summaryStore;
    constructor(conversationStore, summaryStore) {
        this.conversationStore = conversationStore;
        this.summaryStore = summaryStore;
    }
    // ── describe ─────────────────────────────────────────────────────────────
    /**
     * Describe an LCM item by ID.
     *
     * - IDs starting with "sum_" are looked up as summaries (with lineage).
     * - IDs starting with "file_" are looked up as large files.
     * - Returns null if the item is not found.
     */
    async describe(id) {
        if (id.startsWith("sum_")) {
            return this.describeSummary(id);
        }
        if (id.startsWith("file_")) {
            return this.describeFile(id);
        }
        return null;
    }
    async describeSummary(id) {
        const summary = await this.summaryStore.getSummary(id);
        if (!summary) {
            return null;
        }
        // Fetch lineage in parallel
        const [parents, children, messageIds, subtree] = await Promise.all([
            this.summaryStore.getSummaryParents(id),
            this.summaryStore.getSummaryChildren(id),
            this.summaryStore.getSummaryMessages(id),
            this.summaryStore.getSummarySubtree(id),
        ]);
        return {
            id,
            type: "summary",
            summary: {
                conversationId: summary.conversationId,
                kind: summary.kind,
                content: summary.content,
                depth: summary.depth,
                tokenCount: summary.tokenCount,
                descendantCount: summary.descendantCount,
                descendantTokenCount: summary.descendantTokenCount,
                sourceMessageTokenCount: summary.sourceMessageTokenCount,
                fileIds: summary.fileIds,
                parentIds: parents.map((p) => p.summaryId),
                childIds: children.map((c) => c.summaryId),
                messageIds,
                earliestAt: summary.earliestAt,
                latestAt: summary.latestAt,
                subtree: subtree.map((node) => ({
                    summaryId: node.summaryId,
                    parentSummaryId: node.parentSummaryId,
                    depthFromRoot: node.depthFromRoot,
                    kind: node.kind,
                    depth: node.depth,
                    tokenCount: node.tokenCount,
                    descendantCount: node.descendantCount,
                    descendantTokenCount: node.descendantTokenCount,
                    sourceMessageTokenCount: node.sourceMessageTokenCount,
                    earliestAt: node.earliestAt,
                    latestAt: node.latestAt,
                    childCount: node.childCount,
                    path: node.path,
                })),
                createdAt: summary.createdAt,
            },
        };
    }
    async describeFile(id) {
        const file = await this.summaryStore.getLargeFile(id);
        if (!file) {
            return null;
        }
        return {
            id,
            type: "file",
            file: {
                conversationId: file.conversationId,
                fileName: file.fileName,
                mimeType: file.mimeType,
                byteSize: file.byteSize,
                storageUri: file.storageUri,
                explorationSummary: file.explorationSummary,
                createdAt: file.createdAt,
            },
        };
    }
    // ── grep ─────────────────────────────────────────────────────────────────
    /**
     * Search compacted history using regex or full-text search.
     *
     * Depending on `scope`, searches messages, summaries, or both (in parallel).
     */
    async grep(input) {
        const { query, mode, scope, conversationId, since, before, limit } = input;
        const searchInput = { query, mode, conversationId, since, before, limit };
        let messages = [];
        let summaries = [];
        if (scope === "messages") {
            messages = await this.conversationStore.searchMessages(searchInput);
        }
        else if (scope === "summaries") {
            summaries = await this.summaryStore.searchSummaries(searchInput);
        }
        else {
            // scope === "both" — run in parallel
            [messages, summaries] = await Promise.all([
                this.conversationStore.searchMessages(searchInput),
                this.summaryStore.searchSummaries(searchInput),
            ]);
        }
        messages.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        summaries.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return {
            messages,
            summaries,
            totalMatches: messages.length + summaries.length,
        };
    }
    // ── expand ───────────────────────────────────────────────────────────────
    /**
     * Expand a summary to its children and/or source messages.
     *
     * - Condensed summaries: returns child summaries, recursing up to `depth`.
     * - Leaf summaries with `includeMessages`: fetches the source messages.
     * - Respects `tokenCap` and sets `truncated` when the cap is exceeded.
     */
    async expand(input) {
        const depth = input.depth ?? 1;
        const includeMessages = input.includeMessages ?? false;
        const tokenCap = input.tokenCap ?? Infinity;
        const result = {
            children: [],
            messages: [],
            estimatedTokens: 0,
            truncated: false,
        };
        await this.expandRecursive(input.summaryId, depth, includeMessages, tokenCap, result);
        return result;
    }
    async expandRecursive(summaryId, depth, includeMessages, tokenCap, result) {
        if (depth <= 0) {
            return;
        }
        if (result.truncated) {
            return;
        }
        const summary = await this.summaryStore.getSummary(summaryId);
        if (!summary) {
            return;
        }
        if (summary.kind === "condensed") {
            const children = await this.summaryStore.getSummaryChildren(summaryId);
            for (const child of children) {
                if (result.truncated) {
                    break;
                }
                // Check if adding this child would exceed the token cap
                if (result.estimatedTokens + child.tokenCount > tokenCap) {
                    result.truncated = true;
                    break;
                }
                result.children.push({
                    summaryId: child.summaryId,
                    kind: child.kind,
                    content: child.content,
                    tokenCount: child.tokenCount,
                });
                result.estimatedTokens += child.tokenCount;
                // Recurse into children if depth allows
                if (depth > 1) {
                    await this.expandRecursive(child.summaryId, depth - 1, includeMessages, tokenCap, result);
                }
            }
        }
        else if (summary.kind === "leaf" && includeMessages) {
            // Leaf summary — fetch source messages
            const messageIds = await this.summaryStore.getSummaryMessages(summaryId);
            for (const msgId of messageIds) {
                if (result.truncated) {
                    break;
                }
                const msg = await this.conversationStore.getMessageById(msgId);
                if (!msg) {
                    continue;
                }
                const tokenCount = msg.tokenCount || estimateTokens(msg.content);
                if (result.estimatedTokens + tokenCount > tokenCap) {
                    result.truncated = true;
                    break;
                }
                result.messages.push({
                    messageId: msg.messageId,
                    role: msg.role,
                    content: msg.content,
                    tokenCount,
                });
                result.estimatedTokens += tokenCount;
            }
        }
    }
}
//# sourceMappingURL=retrieval.js.map