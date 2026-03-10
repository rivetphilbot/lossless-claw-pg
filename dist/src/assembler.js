import { sanitizeToolUseResultPairing } from "./transcript-repair.js";
// ── Helpers ──────────────────────────────────────────────────────────────────
/** Simple token estimate: ~4 chars per token, same as VoltCode's Token.estimate */
function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
/**
 * Build LCM usage guidance for the runtime system prompt.
 *
 * Guidance is emitted only when summaries are present in assembled context.
 * Depth-aware: minimal for shallow compaction, full guidance for deep trees.
 */
function buildSystemPromptAddition(summarySignals) {
    if (summarySignals.length === 0) {
        return undefined;
    }
    const maxDepth = summarySignals.reduce((deepest, signal) => Math.max(deepest, signal.depth), 0);
    const condensedCount = summarySignals.filter((signal) => signal.kind === "condensed").length;
    const heavilyCompacted = maxDepth >= 2 || condensedCount >= 2;
    const sections = [];
    // Core recall workflow — always present when summaries exist
    sections.push("## LCM Recall", "", "Summaries above are compressed context — maps to details, not the details themselves.", "", "**Recall priority:** LCM tools first, then qmd (for Granola/Limitless/pre-LCM data), then memory_search as last resort.", "", "**Tool escalation:**", "1. `lcm_grep` — search by regex or full-text across messages and summaries", "2. `lcm_describe` — inspect a specific summary (cheap, no sub-agent)", "3. `lcm_expand_query` — deep recall: spawns bounded sub-agent, expands DAG, returns answer with cited summary IDs (~120s, don't ration it)", "", "**`lcm_expand_query` usage** — two patterns (always requires `prompt`):", "- With IDs: `lcm_expand_query(summaryIds: [\"sum_xxx\"], prompt: \"What config changes were discussed?\")`", "- With search: `lcm_expand_query(query: \"database migration\", prompt: \"What strategy was decided?\")`", "- Optional: `maxTokens` (default 2000), `conversationId`, `allConversations: true`", "", "**Summaries include \"Expand for details about:\" footers** listing compressed specifics. Use `lcm_expand_query` with that summary's ID to retrieve them.");
    // Precision/evidence rules — always present but stronger when heavily compacted
    if (heavilyCompacted) {
        sections.push("", "**\u26a0 Deeply compacted context — expand before asserting specifics.**", "", "Default recall flow for precision work:", "1) `lcm_grep` to locate relevant summary/message IDs", "2) `lcm_expand_query` with a focused prompt", "3) Answer with citations to summary IDs used", "", "**Uncertainty checklist (run before answering):**", "- Am I making exact factual claims from a condensed summary?", "- Could compaction have omitted a crucial detail?", "- Would this answer fail if the user asks for proof?", "", "If yes to any \u2192 expand first.", "", "**Do not guess** exact commands, SHAs, file paths, timestamps, config values, or causal claims from condensed summaries. Expand first or state that you need to expand.");
    }
    else {
        sections.push("", "**For precision/evidence questions** (exact commands, SHAs, paths, timestamps, config values, root-cause chains): expand before answering.", "Do not guess from condensed summaries — expand first or state uncertainty.");
    }
    return sections.join("\n");
}
/**
 * Map a DB message role to an AgentMessage role.
 *
 *   user      -> user
 *   assistant -> assistant
 *   system    -> user       (system prompts presented as user messages)
 *   tool      -> assistant  (tool results are part of assistant turns)
 */
function parseJson(value) {
    if (typeof value !== "string" || !value.trim()) {
        return undefined;
    }
    try {
        return JSON.parse(value);
    }
    catch {
        return undefined;
    }
}
function getOriginalRole(parts) {
    for (const part of parts) {
        const decoded = parseJson(part.metadata);
        if (!decoded || typeof decoded !== "object") {
            continue;
        }
        const role = decoded.originalRole;
        if (typeof role === "string" && role.length > 0) {
            return role;
        }
    }
    return null;
}
function getPartMetadata(part) {
    const decoded = parseJson(part.metadata);
    if (!decoded || typeof decoded !== "object") {
        return {};
    }
    const record = decoded;
    return {
        originalRole: typeof record.originalRole === "string" && record.originalRole.length > 0
            ? record.originalRole
            : undefined,
        rawType: typeof record.rawType === "string" && record.rawType.length > 0
            ? record.rawType
            : undefined,
        raw: record.raw,
    };
}
function parseStoredValue(value) {
    if (typeof value !== "string" || value.length === 0) {
        return undefined;
    }
    const parsed = parseJson(value);
    return parsed !== undefined ? parsed : value;
}
function reasoningBlockFromPart(part, rawType) {
    const type = rawType === "thinking" ? "thinking" : "reasoning";
    if (typeof part.textContent === "string" && part.textContent.length > 0) {
        return type === "thinking"
            ? { type, thinking: part.textContent }
            : { type, text: part.textContent };
    }
    return { type };
}
/**
 * Detect if a raw block is an OpenClaw-normalised OpenAI reasoning item.
 * OpenClaw converts OpenAI `{type:"reasoning", id:"rs_…", encrypted_content:"…"}`
 * into `{type:"thinking", thinking:"", thinkingSignature:"{…}"}`.
 * When we reassemble for the OpenAI provider we need the original back.
 */
function tryRestoreOpenAIReasoning(raw) {
    if (raw.type !== "thinking")
        return null;
    const sig = raw.thinkingSignature;
    if (typeof sig !== "string" || !sig.startsWith("{"))
        return null;
    try {
        const parsed = JSON.parse(sig);
        if (parsed.type === "reasoning" && typeof parsed.id === "string") {
            return parsed;
        }
    }
    catch {
        // not valid JSON — leave as-is
    }
    return null;
}
function toolCallBlockFromPart(part, rawType) {
    const type = rawType === "function_call" ||
        rawType === "functionCall" ||
        rawType === "tool_use" ||
        rawType === "tool-use" ||
        rawType === "toolUse" ||
        rawType === "toolCall"
        ? rawType
        : "toolCall";
    const input = parseStoredValue(part.toolInput);
    const block = { type };
    if (type === "function_call") {
        if (typeof part.toolCallId === "string" && part.toolCallId.length > 0) {
            block.call_id = part.toolCallId;
        }
        if (typeof part.toolName === "string" && part.toolName.length > 0) {
            block.name = part.toolName;
        }
        if (input !== undefined) {
            block.arguments = input;
        }
        return block;
    }
    if (typeof part.toolCallId === "string" && part.toolCallId.length > 0) {
        block.id = part.toolCallId;
    }
    if (typeof part.toolName === "string" && part.toolName.length > 0) {
        block.name = part.toolName;
    }
    if (input !== undefined) {
        if (type === "functionCall") {
            block.arguments = input;
        }
        else {
            block.input = input;
        }
    }
    return block;
}
function toolResultBlockFromPart(part, rawType) {
    const type = rawType === "function_call_output" || rawType === "toolResult" || rawType === "tool_result"
        ? rawType
        : "tool_result";
    const output = parseStoredValue(part.toolOutput) ?? part.textContent ?? "";
    const block = { type, output };
    if (type === "function_call_output") {
        if (typeof part.toolCallId === "string" && part.toolCallId.length > 0) {
            block.call_id = part.toolCallId;
        }
        return block;
    }
    if (typeof part.toolCallId === "string" && part.toolCallId.length > 0) {
        block.tool_use_id = part.toolCallId;
    }
    return block;
}
function toRuntimeRole(dbRole, parts) {
    const originalRole = getOriginalRole(parts);
    if (originalRole === "toolResult") {
        return "toolResult";
    }
    if (originalRole === "assistant") {
        return "assistant";
    }
    if (originalRole === "user") {
        return "user";
    }
    if (originalRole === "system") {
        // Runtime system prompts are managed via setSystemPrompt(), not message history.
        return "user";
    }
    if (dbRole === "tool") {
        return "toolResult";
    }
    if (dbRole === "assistant") {
        return "assistant";
    }
    return "user"; // user | system
}
function blockFromPart(part) {
    const metadata = getPartMetadata(part);
    if (metadata.raw && typeof metadata.raw === "object") {
        // If this is an OpenClaw-normalised OpenAI reasoning block, restore the original
        // OpenAI format so the Responses API gets the {type:"reasoning", id:"rs_…"} it expects.
        const restored = tryRestoreOpenAIReasoning(metadata.raw);
        if (restored)
            return restored;
        return metadata.raw;
    }
    if (part.partType === "reasoning") {
        return reasoningBlockFromPart(part, metadata.rawType);
    }
    if (part.partType === "tool") {
        if (metadata.originalRole === "toolResult" || metadata.rawType === "function_call_output") {
            return toolResultBlockFromPart(part, metadata.rawType);
        }
        return toolCallBlockFromPart(part, metadata.rawType);
    }
    if (metadata.rawType === "function_call" ||
        metadata.rawType === "functionCall" ||
        metadata.rawType === "tool_use" ||
        metadata.rawType === "tool-use" ||
        metadata.rawType === "toolUse" ||
        metadata.rawType === "toolCall") {
        return toolCallBlockFromPart(part, metadata.rawType);
    }
    if (metadata.rawType === "function_call_output" ||
        metadata.rawType === "tool_result" ||
        metadata.rawType === "toolResult") {
        return toolResultBlockFromPart(part, metadata.rawType);
    }
    if (part.partType === "text") {
        return { type: "text", text: part.textContent ?? "" };
    }
    if (typeof part.textContent === "string" && part.textContent.length > 0) {
        return { type: "text", text: part.textContent };
    }
    const decodedFallback = parseJson(part.metadata);
    if (decodedFallback && typeof decodedFallback === "object") {
        return {
            type: "text",
            text: JSON.stringify(decodedFallback),
        };
    }
    return { type: "text", text: "" };
}
function contentFromParts(parts, role, fallbackContent) {
    if (parts.length === 0) {
        if (role === "assistant") {
            return fallbackContent ? [{ type: "text", text: fallbackContent }] : [];
        }
        if (role === "toolResult") {
            return [{ type: "text", text: fallbackContent }];
        }
        return fallbackContent;
    }
    const blocks = parts.map(blockFromPart);
    if (role === "user" &&
        blocks.length === 1 &&
        blocks[0] &&
        typeof blocks[0] === "object" &&
        blocks[0].type === "text" &&
        typeof blocks[0].text === "string") {
        return blocks[0].text;
    }
    return blocks;
}
function pickToolCallId(parts) {
    for (const part of parts) {
        if (typeof part.toolCallId === "string" && part.toolCallId.length > 0) {
            return part.toolCallId;
        }
        const decoded = parseJson(part.metadata);
        if (!decoded || typeof decoded !== "object") {
            continue;
        }
        const raw = decoded.raw;
        if (!raw || typeof raw !== "object") {
            continue;
        }
        const maybe = raw.toolCallId;
        if (typeof maybe === "string" && maybe.length > 0) {
            return maybe;
        }
        const maybeSnake = raw.tool_call_id;
        if (typeof maybeSnake === "string" && maybeSnake.length > 0) {
            return maybeSnake;
        }
    }
    return undefined;
}
/** Format a Date for XML attributes in the agent's timezone. */
function formatDateForAttribute(date, timezone) {
    const tz = timezone ?? "UTC";
    try {
        const fmt = new Intl.DateTimeFormat("en-CA", {
            timeZone: tz,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
        });
        const p = Object.fromEntries(fmt.formatToParts(date).map((part) => [part.type, part.value]));
        return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
    }
    catch {
        return date.toISOString();
    }
}
/**
 * Format a summary record into the XML payload string the model sees.
 */
async function formatSummaryContent(summary, summaryStore, timezone) {
    const attributes = [
        `id="${summary.summaryId}"`,
        `kind="${summary.kind}"`,
        `depth="${summary.depth}"`,
        `descendant_count="${summary.descendantCount}"`,
    ];
    if (summary.earliestAt) {
        attributes.push(`earliest_at="${formatDateForAttribute(summary.earliestAt, timezone)}"`);
    }
    if (summary.latestAt) {
        attributes.push(`latest_at="${formatDateForAttribute(summary.latestAt, timezone)}"`);
    }
    const lines = [];
    lines.push(`<summary ${attributes.join(" ")}>`);
    // For condensed summaries, include parent references.
    if (summary.kind === "condensed") {
        const parents = await summaryStore.getSummaryParents(summary.summaryId);
        if (parents.length > 0) {
            lines.push("  <parents>");
            for (const parent of parents) {
                lines.push(`    <summary_ref id="${parent.summaryId}" />`);
            }
            lines.push("  </parents>");
        }
    }
    lines.push("  <content>");
    lines.push(summary.content);
    lines.push("  </content>");
    lines.push("</summary>");
    return lines.join("\n");
}
// ── ContextAssembler ─────────────────────────────────────────────────────────
export class ContextAssembler {
    conversationStore;
    summaryStore;
    timezone;
    constructor(conversationStore, summaryStore, timezone) {
        this.conversationStore = conversationStore;
        this.summaryStore = summaryStore;
        this.timezone = timezone;
    }
    /**
     * Build model context under a token budget.
     *
     * 1. Fetch all context items for the conversation (ordered by ordinal).
     * 2. Resolve each item into an AgentMessage (fetching the underlying
     *    message or summary record).
     * 3. Protect the "fresh tail" (last N items) from truncation.
     * 4. If over budget, drop oldest non-fresh items until we fit.
     * 5. Return the final ordered messages in chronological order.
     */
    async assemble(input) {
        const { conversationId, tokenBudget } = input;
        const freshTailCount = input.freshTailCount ?? 8;
        // Step 1: Get all context items ordered by ordinal
        const contextItems = await this.summaryStore.getContextItems(conversationId);
        if (contextItems.length === 0) {
            return {
                messages: [],
                estimatedTokens: 0,
                stats: { rawMessageCount: 0, summaryCount: 0, totalContextItems: 0 },
            };
        }
        // Step 2: Resolve each context item into a ResolvedItem
        const resolved = await this.resolveItems(contextItems);
        // Count stats from the full (pre-truncation) set
        let rawMessageCount = 0;
        let summaryCount = 0;
        const summarySignals = [];
        for (const item of resolved) {
            if (item.isMessage) {
                rawMessageCount++;
            }
            else {
                summaryCount++;
                if (item.summarySignal) {
                    summarySignals.push(item.summarySignal);
                }
            }
        }
        const systemPromptAddition = buildSystemPromptAddition(summarySignals);
        // Step 3: Split into evictable prefix and protected fresh tail
        const tailStart = Math.max(0, resolved.length - freshTailCount);
        const freshTail = resolved.slice(tailStart);
        const evictable = resolved.slice(0, tailStart);
        // Step 4: Budget-aware selection
        // First, compute the token cost of the fresh tail (always included).
        let tailTokens = 0;
        for (const item of freshTail) {
            tailTokens += item.tokens;
        }
        // Fill remaining budget from evictable items, oldest first.
        // If the fresh tail alone exceeds the budget we still include it
        // (we never drop fresh items), but we skip all evictable items.
        const remainingBudget = Math.max(0, tokenBudget - tailTokens);
        const selected = [];
        let evictableTokens = 0;
        // Walk evictable items from oldest to newest. We want to keep as many
        // older items as the budget allows; once we exceed the budget we start
        // dropping the *oldest* items. To achieve this we first compute the
        // total, then trim from the front.
        const evictableTotalTokens = evictable.reduce((sum, it) => sum + it.tokens, 0);
        if (evictableTotalTokens <= remainingBudget) {
            // Everything fits
            selected.push(...evictable);
            evictableTokens = evictableTotalTokens;
        }
        else {
            // Need to drop oldest items until we fit.
            // Walk from the END of evictable (newest first) accumulating tokens,
            // then reverse to restore chronological order.
            const kept = [];
            let accum = 0;
            for (let i = evictable.length - 1; i >= 0; i--) {
                const item = evictable[i];
                if (accum + item.tokens <= remainingBudget) {
                    kept.push(item);
                    accum += item.tokens;
                }
                else {
                    // Once an item doesn't fit we stop — all older items are also dropped
                    break;
                }
            }
            kept.reverse();
            selected.push(...kept);
            evictableTokens = accum;
        }
        // Append fresh tail after the evictable prefix
        selected.push(...freshTail);
        const estimatedTokens = evictableTokens + tailTokens;
        // Normalize assistant string content to array blocks (some providers return
        // content as a plain string; Anthropic expects content block arrays).
        const rawMessages = selected.map((item) => item.message);
        for (let i = 0; i < rawMessages.length; i++) {
            const msg = rawMessages[i];
            if (msg?.role === "assistant" && typeof msg.content === "string") {
                rawMessages[i] = {
                    ...msg,
                    content: [{ type: "text", text: msg.content }],
                };
            }
        }
        return {
            messages: sanitizeToolUseResultPairing(rawMessages),
            estimatedTokens,
            systemPromptAddition,
            stats: {
                rawMessageCount,
                summaryCount,
                totalContextItems: resolved.length,
            },
        };
    }
    // ── Private helpers ──────────────────────────────────────────────────────
    /**
     * Resolve a list of context items into ResolvedItems by fetching the
     * underlying message or summary record for each.
     *
     * Items that cannot be resolved (e.g. deleted message) are silently skipped.
     */
    async resolveItems(contextItems) {
        const resolved = [];
        for (const item of contextItems) {
            const result = await this.resolveItem(item);
            if (result) {
                resolved.push(result);
            }
        }
        return resolved;
    }
    /**
     * Resolve a single context item.
     */
    async resolveItem(item) {
        if (item.itemType === "message" && item.messageId != null) {
            return this.resolveMessageItem(item);
        }
        if (item.itemType === "summary" && item.summaryId != null) {
            return this.resolveSummaryItem(item);
        }
        // Malformed item — skip
        return null;
    }
    /**
     * Resolve a context item that references a raw message.
     */
    async resolveMessageItem(item) {
        const msg = await this.conversationStore.getMessageById(item.messageId);
        if (!msg) {
            return null;
        }
        const parts = await this.conversationStore.getMessageParts(msg.messageId);
        const roleFromStore = toRuntimeRole(msg.role, parts);
        const toolCallId = roleFromStore === "toolResult" ? pickToolCallId(parts) : undefined;
        // Tool results without a call id cannot be serialized for Anthropic-compatible APIs.
        // This happens for legacy/bootstrap rows that have role=tool but no message_parts.
        // Preserve the text by degrading to assistant content instead of emitting invalid toolResult.
        const role = roleFromStore === "toolResult" && !toolCallId ? "assistant" : roleFromStore;
        const content = contentFromParts(parts, role, msg.content);
        const contentText = typeof content === "string" ? content : (JSON.stringify(content) ?? msg.content);
        const tokenCount = msg.tokenCount > 0 ? msg.tokenCount : estimateTokens(contentText);
        // Cast: these are reconstructed from DB storage, not live agent messages,
        // so they won't carry the full AgentMessage metadata (timestamp, usage, etc.)
        return {
            ordinal: item.ordinal,
            message: role === "assistant"
                ? {
                    role,
                    content,
                    usage: {
                        input: 0,
                        output: tokenCount,
                        cacheRead: 0,
                        cacheWrite: 0,
                        totalTokens: tokenCount,
                        cost: {
                            input: 0,
                            output: 0,
                            cacheRead: 0,
                            cacheWrite: 0,
                            total: 0,
                        },
                    },
                }
                : {
                    role,
                    content,
                    ...(toolCallId ? { toolCallId } : {}),
                },
            tokens: tokenCount,
            isMessage: true,
        };
    }
    /**
     * Resolve a context item that references a summary.
     * Summaries are presented as user messages with a structured XML wrapper.
     */
    async resolveSummaryItem(item) {
        const summary = await this.summaryStore.getSummary(item.summaryId);
        if (!summary) {
            return null;
        }
        const content = await formatSummaryContent(summary, this.summaryStore, this.timezone);
        const tokens = estimateTokens(content);
        // Cast: summaries are synthetic user messages without full AgentMessage metadata
        return {
            ordinal: item.ordinal,
            message: { role: "user", content },
            tokens,
            isMessage: false,
            summarySignal: {
                kind: summary.kind,
                depth: summary.depth,
                descendantCount: summary.descendantCount,
            },
        };
    }
}
//# sourceMappingURL=assembler.js.map