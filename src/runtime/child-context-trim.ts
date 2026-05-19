/**
 * Child-side fork context trimming.
 *
 * When a subagent runs in `session-mode: fork`, it inherits a prefix of the
 * parent session's messages. Those inherited messages must fit the child's
 * context window before any LLM call is made. This handler enforces that
 * invariant deterministically using a sound upper bound:
 *
 *   tokens(message) ≤ utf8_bytes(message_payload)
 *
 * which holds for every byte-level BPE tokenizer (Claude, GPT, Llama, Mistral,
 * DeepSeek, Qwen, Gemini, etc.). For an N-byte input, the encoder produces at
 * most N tokens, because every BPE token decodes to ≥ 1 byte. This is a
 * mathematical bound, not a `bytes/4` heuristic; it over-trims rather than
 * under-trim and it does not depend on per-provider Usage semantics.
 *
 * Lifecycle (relative to the inherited prefix marked by the
 * `subagent_boundary` custom_message written at seed time):
 *
 *   Phase 1 (boundary present, kept set fits): handler returns messages
 *     unchanged. Pi's compaction does not trigger because token usage is
 *     low. No work for us.
 *
 *   Phase 2 (boundary present, kept set exceeds budget): handler drops the
 *     oldest *inherited* messages (those before the boundary) until the
 *     kept tail fits the budget. Tool-call/result pairing is preserved by
 *     dropping orphaned tool results that lose their tool call. The child's
 *     own messages (after the boundary) are never dropped here.
 *
 *   Phase 3 (boundary no longer present, child's own work has grown):
 *     handler returns messages unchanged. Pi's native compaction fires
 *     normally on the child's own oldest turns.
 *
 * The "phase transition" is just the handler stopping its trim once it can
 * no longer find the boundary marker in `event.messages`. There is no
 * explicit setAutoCompactionEnabled toggle — Pi's compaction stays inactive
 * during Phase 1/2 because the trimmed `messages` we return drive the
 * provider's reported usage, and reactivates in Phase 3 by simple arithmetic.
 */

import type {
	ContextEvent,
	ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

/** Inline `ContextEventResult` shape — the type is not re-exported from the
 * top-level barrel, but the contract is documented in the extension docs:
 * returning `{ messages?: AgentMessage[] }` from a `context` handler replaces
 * the message list before the LLM call. */
type ContextEventResult = { messages?: ContextEvent["messages"] };

/** Minimum context-window override used when ctx cannot resolve a model. */
const FALLBACK_CONTEXT_WINDOW = 128_000;

/**
 * Default reserve for the child's first response when the child agent
 * frontmatter did not set `fork-output-reserve-tokens`. Matches the seed-side
 * default in src/session/trimmed-session.ts so behavior is consistent across
 * the parent-side memory ceiling and the child-side authoritative trim.
 */
const DEFAULT_RESERVE_TOKENS = 10_000;

/**
 * Compaction's own reserveTokens default. We never let our budget undershoot
 * Pi's compaction trigger — otherwise we would trim only enough to be just
 * under the API limit but still over Pi's threshold, and Pi would compact
 * anyway. See node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js
 * (DEFAULT_COMPACTION_SETTINGS).
 */
const PI_COMPACTION_RESERVE_FALLBACK = 16_384;

const BOUNDARY_CUSTOM_TYPE = "subagent_boundary";

/**
 * Read PI_SUBAGENT_FORK_RESERVE_TOKENS from the environment. Set by the
 * parent's launch path so the child knows the same reserve the seed used.
 * Falls back to DEFAULT_RESERVE_TOKENS.
 */
function readReserveTokensFromEnv(): number {
	const raw = process.env.PI_SUBAGENT_FORK_RESERVE_TOKENS?.trim();
	if (!raw) return DEFAULT_RESERVE_TOKENS;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RESERVE_TOKENS;
	return parsed;
}

/**
 * Sound UTF-8 byte length of a message's serialized payload. The exact
 * serialization shape doesn't matter; we just need a stable, monotone-in-size
 * count that an encoder cannot exceed.
 *
 * We serialize via JSON.stringify because:
 *   1. AgentMessage shapes vary (user, assistant, toolResult, custom, etc.)
 *      and each role has different fields the LLM ultimately reads.
 *   2. JSON.stringify covers nested content blocks, tool args, and image
 *      placeholders without us picking favorites.
 *   3. The result is deterministic for a given input — no randomness, no
 *      heuristics.
 *
 * The byte count is conservative: it includes JSON quoting/braces, which the
 * encoder will not see. That makes our budget tighter than strictly required,
 * which is the correct direction for a soundness-first design.
 */
function messageByteLen(message: unknown): number {
	try {
		return Buffer.byteLength(JSON.stringify(message), "utf8");
	} catch {
		// Defensive: if the message is not serializable for some reason, treat
		// it as expensive so we drop it rather than silently underbudget.
		return Number.MAX_SAFE_INTEGER;
	}
}

interface MessageLike {
	role?: string;
	customType?: string;
	toolCallId?: string;
	content?: unknown;
}

function isBoundaryMessage(msg: unknown): boolean {
	if (!msg || typeof msg !== "object") return false;
	const m = msg as MessageLike;
	return m.role === "custom" && m.customType === BOUNDARY_CUSTOM_TYPE;
}

/**
 * Returns the index of the boundary marker in messages, or -1 when absent
 * (Phase 3, or non-fork session).
 */
function findBoundaryIndex(messages: unknown[]): number {
	for (let i = 0; i < messages.length; i++) {
		if (isBoundaryMessage(messages[i])) return i;
	}
	return -1;
}

/**
 * Collects the set of toolCall IDs present in the kept tail. Used to detect
 * orphaned tool results in the kept tail (whose corresponding tool call was
 * dropped).
 *
 * Tool call blocks may use type "toolCall" (OpenAI-style) or "toolUse"
 * (Anthropic-style). Both are handled.
 */
function collectKeptToolCallIds(messages: unknown[]): Set<string> {
	const ids = new Set<string>();
	for (const msg of messages) {
		if (!msg || typeof msg !== "object") continue;
		const m = msg as MessageLike & { content?: unknown };
		if (m.role !== "assistant") continue;
		const content = m.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const b = block as { type?: string; id?: string };
			if ((b.type === "toolCall" || b.type === "toolUse") && typeof b.id === "string") {
				ids.add(b.id);
			}
		}
	}
	return ids;
}

/**
 * Drops orphaned tool results from the kept tail: tool results whose
 * corresponding tool call was dropped during the trim. The OpenAI
 * /v1/responses API rejects conversations with tool results that reference
 * non-existent tool call IDs.
 */
function pruneOrphanedToolResults(messages: unknown[]): unknown[] {
	const keptIds = collectKeptToolCallIds(messages);
	return messages.filter((msg) => {
		if (!msg || typeof msg !== "object") return true;
		const m = msg as MessageLike;
		if (m.role !== "toolResult") return true;
		if (typeof m.toolCallId !== "string") return true;
		return keptIds.has(m.toolCallId);
	});
}

/**
 * The byte budget the kept set must fit. Computed once per context event
 * because the model and reserveTokens never change mid-event.
 */
function computeBudgetBytes(contextWindow: number, reserveTokens: number): number {
	// We bound `tokens ≤ bytes`, and Pi's compaction bound is
	//   shouldCompact = contextTokens > contextWindow - settings.reserveTokens
	// where settings.reserveTokens defaults to 16384. To keep compaction
	// dormant in Phase 1/2, we must keep `contextTokens` under both
	// `(contextWindow - childOutputReserve)` and Pi's threshold. We take the
	// larger of the two reserves so we satisfy both.
	const reserve = Math.max(reserveTokens, PI_COMPACTION_RESERVE_FALLBACK);
	const budgetTokens = Math.max(0, contextWindow - reserve);
	// `tokens ≤ bytes` ⇒ requiring `bytes ≤ budgetTokens` is a sufficient,
	// sound condition for `tokens ≤ budgetTokens`.
	return budgetTokens;
}

/**
 * Trim algorithm:
 *
 *   1. Locate the boundary. If absent → Phase 3 → return undefined.
 *   2. Sum the kept tail's bytes. If under budget → Phase 1 → return undefined.
 *   3. Phase 2: drop oldest *inherited* messages (indices 0 .. boundary-1)
 *      one at a time, recomputing the kept set's bytes after each drop, until
 *      the kept set fits the budget OR the entire inherited prefix has been
 *      consumed. After the trim, prune orphaned tool results from the kept
 *      tail.
 *   4. If the whole prefix was consumed and we still don't fit, return what
 *      we have anyway. The child's own work alone might overflow; Pi will
 *      raise its native context-overflow error which is the appropriate
 *      failure mode for "your task is too big for the model."
 */
export function applyByteBudgetTrim(
	messages: unknown[],
	contextWindow: number,
	reserveTokens: number,
): unknown[] | undefined {
	if (!Array.isArray(messages) || messages.length === 0) return undefined;

	const boundary = findBoundaryIndex(messages);
	if (boundary < 0) return undefined; // Phase 3

	const budgetBytes = computeBudgetBytes(contextWindow, reserveTokens);
	if (budgetBytes <= 0) {
		// Pathological: reserve is larger than the model's window. Drop everything
		// before the boundary inclusive; the child must run on its own task only.
		return messages.slice(boundary + 1);
	}

	// Compute byte size of every message once. JSON.stringify is O(n) per
	// message; a single linear pass is enough.
	const sizes: number[] = messages.map(messageByteLen);

	// Total bytes of the current kept set (full messages array).
	let total = 0;
	for (const s of sizes) total += s;

	if (total <= budgetBytes) return undefined; // Phase 1

	// Phase 2: drop oldest inherited messages until we fit, or until we've
	// dropped everything before the boundary.
	let firstKept = 0;
	while (total > budgetBytes && firstKept < boundary) {
		total -= sizes[firstKept];
		firstKept += 1;
	}

	// If we couldn't fit even by dropping all inherited messages, also drop the
	// boundary marker itself; nothing else to give. Phase 3 takes over from
	// here on: subsequent context events will see no boundary and let Pi's
	// native compaction handle child-only context.
	if (total > budgetBytes && firstKept === boundary) {
		total -= sizes[firstKept];
		firstKept += 1;
	}

	const trimmed = messages.slice(firstKept);
	return pruneOrphanedToolResults(trimmed);
}

/**
 * Resolves the child's context window from the extension context. Falls back
 * to a safe default if the model is not yet known (rare; the agent loop only
 * fires `context` events with an active model, but defensive code is cheap).
 */
function resolveContextWindow(
	getModelContextWindow: () => number | undefined,
): number {
	const w = getModelContextWindow();
	return typeof w === "number" && w > 0 ? w : FALLBACK_CONTEXT_WINDOW;
}

/**
 * Public entry: register the child-side context-event handler with the
 * extension API. Idempotent in that the handler is harmless on non-fork
 * sessions (no boundary marker → returns undefined → no-op).
 */
export function registerChildContextTrim(pi: ExtensionAPI): void {
	let logged = false;
	pi.on("context", async (event: ContextEvent, ctx): Promise<ContextEventResult | undefined> => {
		if (process.env.PI_SUBAGENT_DISABLE_CHILD_CONTEXT_TRIM === "1") return undefined;
		const contextWindow = resolveContextWindow(() => ctx.model?.contextWindow);
		const reserveTokens = readReserveTokensFromEnv();
		const trimmed = applyByteBudgetTrim(
			event.messages as unknown[],
			contextWindow,
			reserveTokens,
		);
		if (process.env.PI_SUBAGENT_FORK_TRIM_DEBUG === "1" && !logged) {
			logged = true;
			const inputBytes = Buffer.byteLength(JSON.stringify(event.messages), "utf8");
			const outputBytes = trimmed
				? Buffer.byteLength(JSON.stringify(trimmed), "utf8")
				: inputBytes;
			const summary =
				`[pi-subagents fork-trim] ctx=${contextWindow} reserve=${reserveTokens} ` +
				`in_msgs=${event.messages.length} out_msgs=${trimmed ? trimmed.length : event.messages.length} ` +
				`in_bytes=${inputBytes} out_bytes=${outputBytes} ` +
				`trimmed=${trimmed ? "yes" : "no"}`;
			const debugPath = process.env.PI_SUBAGENT_FORK_TRIM_DEBUG_LOG;
			if (debugPath) {
				try {
					const fs = await import("node:fs");
					fs.appendFileSync(debugPath, `${summary}\n`, "utf8");
				} catch {
					// best-effort logging; never throw from the handler
				}
			} else {
				// eslint-disable-next-line no-console
				console.error(summary);
			}
		}
		if (!trimmed) return undefined;
		return { messages: trimmed as ContextEvent["messages"] };
	});
}
