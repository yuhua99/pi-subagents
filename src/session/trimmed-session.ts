/**
 * Fork session seeding.
 *
 * Writes a child session file from a parent session. The child receives the
 * latest "live" segment of the parent's messages — entries newer than the
 * most recent zero-usage reset marker, and older than the launch tool-call
 * that spawned this child.
 *
 * Crucially, this seed step does NOT enforce a token budget. The child's
 * authoritative byte-budget trim runs at LLM call time inside the child's
 * `context` event handler (see src/runtime/child-context-trim.ts), which is
 * the only place where the child's tokenizer, model, and context window are
 * locally and authoritatively known.
 *
 * What this step does:
 *   - Cuts the parent prefix at the launch tool-call (so the child does not
 *     re-see the very turn that spawned it).
 *   - Skips entries before the most recent zero-usage reset marker. Zero
 *     usage on an assistant message is a real signal that the entry was
 *     written by a fork seed (or equivalent reset path) — keeping it would
 *     confuse downstream consumers without adding information.
 *   - Neutralizes tool-call and tool-result blocks so foreign session-local
 *     identifiers do not leak into the child's pi runtime.
 *   - Drops `subagent_roster` custom messages (they are re-injected by the
 *     child extension on session_start with the child's own roster).
 *   - Zeroes inherited assistant `usage` because the parent's usage values
 *     are no longer accurate after trimming and the child must compute its
 *     own from scratch.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface TrimmedForkSessionOptions {
	/** The child model's total context window in tokens. Recorded for
	 * downstream tooling but not used to enforce a budget here. */
	childContextWindow: number;
	/** Tokens to reserve for the child model's output. Forwarded to the child
	 * via env so the child handler enforces the same reserve. */
	reserveTokens?: number;
	/** Tool call id for the subagent launch that is creating this fork. The
	 * spawning turn's tool call is excluded so the child does not see itself
	 * being launched. */
	launchToolCallId?: string;
	/** Session title to write into the forked child session header. */
	sessionName?: string;
}

interface ParsedEntry {
	line: string;
	parsed: Record<string, unknown>;
}

function zeroUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function readSessionEntries(sessionFile: string): ParsedEntry[] {
	const content = readFileSync(sessionFile, "utf-8");
	const entries: ParsedEntry[] = [];
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			entries.push({ line: trimmed, parsed: JSON.parse(trimmed) });
		} catch {
			// Ignore malformed historical lines; pi will report them if it loads
			// the session directly.
		}
	}
	return entries;
}

function buildSessionHeader(
	headerEntry: ParsedEntry,
	parentSessionFile: string,
	sessionName?: string,
): string {
	return JSON.stringify({
		...headerEntry.parsed,
		timestamp: new Date().toISOString(),
		parentSession: parentSessionFile,
		...(sessionName ? { name: sessionName } : {}),
	});
}

function getMessage(entry: ParsedEntry): Record<string, unknown> | undefined {
	if (entry.parsed.type !== "message") return undefined;
	return entry.parsed.message as Record<string, unknown> | undefined;
}

function isAssistantMessage(entry: ParsedEntry): boolean {
	const msg = getMessage(entry);
	return msg?.role === "assistant";
}

function hasZeroUsage(entry: ParsedEntry): boolean {
	const msg = getMessage(entry);
	if (msg?.role !== "assistant") return false;
	const usage = msg.usage as Record<string, unknown> | undefined;
	if (!usage) return false;
	const input = typeof usage.input === "number" ? usage.input : 0;
	const cacheRead =
		typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
	const totalTokens =
		typeof usage.totalTokens === "number" ? usage.totalTokens : 0;
	return input <= 0 && cacheRead <= 0 && totalTokens <= 0;
}

/**
 * Tool-call content blocks may use type "toolCall" (OpenAI) or "toolUse"
 * (Anthropic / Google).
 */
function isToolCallBlock(block: unknown): block is Record<string, unknown> {
	if (!block || typeof block !== "object") return false;
	const type = (block as Record<string, unknown>).type;
	return type === "toolCall" || type === "toolUse";
}

function hasToolCallId(entry: ParsedEntry, toolCallId: string): boolean {
	const msg = getMessage(entry);
	if (msg?.role !== "assistant") return false;
	const content = msg.content;
	if (!Array.isArray(content)) return false;
	return content.some((block) => {
		if (!isToolCallBlock(block)) return false;
		return block.id === toolCallId;
	});
}

function getEntriesBeforeLaunch(
	entries: ParsedEntry[],
	launchToolCallId?: string,
): ParsedEntry[] {
	if (!launchToolCallId) return entries;
	const launchIndex = entries.findIndex((entry) =>
		hasToolCallId(entry, launchToolCallId),
	);
	return launchIndex < 0 ? entries : entries.slice(0, launchIndex);
}

/**
 * Returns the slice of entries starting AFTER the latest zero-usage assistant
 * (so the child does not inherit pre-reset stale content), or the full input
 * if no such marker exists.
 */
function sliceLatestSegment(entries: ParsedEntry[]): ParsedEntry[] {
	let lastResetIndex = -1;
	for (let i = 0; i < entries.length; i++) {
		if (isAssistantMessage(entries[i]) && hasZeroUsage(entries[i])) {
			lastResetIndex = i;
		}
	}
	return lastResetIndex < 0 ? entries : entries.slice(lastResetIndex + 1);
}

/**
 * Returns toolCall ids declared by assistant entries in the kept slice.
 */
function collectKeptToolCallIds(entries: ParsedEntry[]): Set<string> {
	const ids = new Set<string>();
	for (const entry of entries) {
		const msg = getMessage(entry);
		if (msg?.role !== "assistant") continue;
		const content = msg.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (!isToolCallBlock(block)) continue;
			const id = (block as Record<string, unknown>).id;
			if (typeof id === "string") ids.add(id);
		}
	}
	return ids;
}

/**
 * Drop tool-result entries whose corresponding tool-call entry is not present
 * in the kept slice. Defensive: shouldn't normally happen because we keep the
 * whole latest segment, but guards against malformed parent sessions.
 */
function pruneOrphanedToolResults(entries: ParsedEntry[]): ParsedEntry[] {
	const keptIds = collectKeptToolCallIds(entries);
	return entries.filter((entry) => {
		const msg = getMessage(entry);
		if (msg?.role !== "toolResult") return true;
		const id = msg.toolCallId;
		if (typeof id !== "string") return true;
		return keptIds.has(id);
	});
}

/**
 * Defense-in-depth: the parent-side memory ceiling.
 *
 * The child's authoritative byte-budget trim runs in the child process, but
 * the child must first load the seed file into memory. A pathological
 * parent session (multiple megabytes of inlined file contents) could OOM the
 * child process before its `context` handler can run. This ceiling caps the
 * seed bytes at a generous limit so the child always boots cleanly.
 *
 * The ceiling is bytes, not tokens. Bytes are what consume process memory.
 *
 * Configurable via PI_SUBAGENT_FORK_MAX_INHERITANCE_BYTES; default 8 MiB.
 */
const DEFAULT_MAX_INHERITANCE_BYTES = 8 * 1024 * 1024;

function readMaxInheritanceBytes(): number {
	const raw = process.env.PI_SUBAGENT_FORK_MAX_INHERITANCE_BYTES?.trim();
	if (!raw) return DEFAULT_MAX_INHERITANCE_BYTES;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_INHERITANCE_BYTES;
	return parsed;
}

function entryByteLen(entry: ParsedEntry): number {
	// Use the raw line length plus 1 (for the trailing newline). Cheap and
	// matches what gets written to disk.
	return Buffer.byteLength(entry.line, "utf8") + 1;
}

/**
 * If the kept slice exceeds the byte ceiling, drop oldest entries until the
 * remaining bytes fit. Tool-call/tool-result pairing is preserved by the
 * downstream pruneOrphanedToolResults pass — when a toolCall is dropped, its
 * matching toolResult is automatically pruned because it becomes orphaned.
 */
function applyMemoryCeiling(entries: ParsedEntry[]): ParsedEntry[] {
	const ceiling = readMaxInheritanceBytes();
	const sizes = entries.map(entryByteLen);
	let total = 0;
	for (const s of sizes) total += s;
	if (total <= ceiling) return entries;

	let firstKept = 0;
	while (total > ceiling && firstKept < entries.length) {
		total -= sizes[firstKept];
		firstKept += 1;
	}
	return entries.slice(firstKept);
}

/**
 * Replace tool-call blocks with text placeholders. Tool-call IDs are
 * session-local routing tokens that belong to the parent's provider context;
 * they must not leak into the child session regardless of which provider
 * either side uses.
 */
function neutralizeToolCallBlocks(content: unknown[]): unknown[] {
	if (!Array.isArray(content)) return content;
	const result: unknown[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") {
			result.push(block);
			continue;
		}
		const b = block as Record<string, unknown>;
		if (b.type === "toolCall" || b.type === "toolUse") {
			const name = typeof b.name === "string" ? b.name : "unknown";
			result.push({ type: "text", text: `[tool call: ${name}]` });
		} else {
			result.push(block);
		}
	}
	return result;
}

function serializeEntry(entry: ParsedEntry): string {
	const parsedClone = structuredClone(entry.parsed);

	if (parsedClone.type !== "message") {
		// Non-message entries (e.g. label, model_change) get a stub message so
		// the compiled renderer's expectations are satisfied without leaking
		// stale token counts.
		(parsedClone as Record<string, unknown>).message = {
			role: "custom",
			content: [],
			usage: zeroUsage(),
		};
		return JSON.stringify(parsedClone);
	}

	const msg = parsedClone.message as Record<string, unknown> | undefined;
	if (!msg) return JSON.stringify(parsedClone);

	// Parent usage is no longer valid after trimming. Zero it so the child
	// recomputes from scratch and so downstream consumers cannot mistake the
	// stale value for live data.
	msg.usage = zeroUsage();

	if (msg.role === "assistant" && Array.isArray(msg.content)) {
		msg.content = neutralizeToolCallBlocks(msg.content);
	}

	// Tool-result rows are converted to user messages so the child's pi
	// runtime never tries to resolve foreign tool-call IDs.
	if (msg.role === "toolResult" && Array.isArray(msg.content)) {
		msg.role = "user";
		delete msg.toolCallId;
	}

	parsedClone.message = msg;
	return JSON.stringify(parsedClone);
}

function writeChildSession(
	entries: ParsedEntry[],
	headerEntry: ParsedEntry,
	childSessionFile: string,
	parentSessionFile: string,
	sessionName?: string,
): void {
	mkdirSync(dirname(childSessionFile), { recursive: true });
	const lines = [
		buildSessionHeader(headerEntry, parentSessionFile, sessionName),
	];
	for (const entry of entries) {
		if (entry.parsed.type === "session") continue;
		// Children never receive ambient awareness (skipped in session_start
		// for parentSession sessions). Drop the inherited roster so the child's
		// extension can re-emit a fresh roster.
		if (
			entry.parsed.type === "custom_message" &&
			(entry.parsed as Record<string, unknown>).customType ===
				"subagent_roster"
		) {
			continue;
		}
		lines.push(serializeEntry(entry));
	}
	writeFileSync(childSessionFile, `${lines.join("\n")}\n`, "utf-8");
}

export function writeTrimmedForkSession(
	parentSessionFile: string,
	childSessionFile: string,
	options: TrimmedForkSessionOptions,
): void {
	const entries = readSessionEntries(parentSessionFile);
	const headerEntry = entries.find((entry) => entry.parsed.type === "session");
	if (!headerEntry) {
		throw new Error(`No session header found in ${parentSessionFile}`);
	}

	const beforeLaunch = getEntriesBeforeLaunch(
		entries,
		options.launchToolCallId,
	);
	const segment = sliceLatestSegment(beforeLaunch);

	// If the latest segment contains no successful assistant turn, there is no
	// meaningful context to fork. Write a header-only child session so the
	// child boots cleanly. (Preserves prior behavior; downstream tooling
	// relies on header-only output in this edge case.)
	const hasAssistant = segment.some(isAssistantMessage);
	if (!hasAssistant) {
		writeChildSession(
			[],
			headerEntry,
			childSessionFile,
			parentSessionFile,
			options.sessionName,
		);
		return;
	}

	const capped = applyMemoryCeiling(segment);
	const cleaned = pruneOrphanedToolResults(capped);

	writeChildSession(
		cleaned,
		headerEntry,
		childSessionFile,
		parentSessionFile,
		options.sessionName,
	);
}
