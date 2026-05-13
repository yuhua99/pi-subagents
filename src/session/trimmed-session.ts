/**
 * Fork session trimming.
 *
 * A forked child inherits a suffix of the parent session. The suffix must fit the
 * child model's context window, not the parent's. Pi stores cumulative input
 * checkpoints on assistant messages as usage.input + usage.cacheRead; trimming is
 * based only on those checkpoints. No tokenizer guesses are used here.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface TrimmedForkSessionOptions {
	/** The child model's total context window in tokens. */
	childContextWindow: number;
	/** Tokens to reserve for the child model's output. Defaults to 10_000. */
	reserveTokens?: number;
	/** Tool call id for the subagent launch that is creating this fork. */
	launchToolCallId?: string;
}

const DEFAULT_RESERVE_TOKENS = 10_000;

interface ParsedEntry {
	line: string;
	parsed: Record<string, unknown>;
}

interface TokenSegment {
	entries: ParsedEntry[];
	totalTokens: number;
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

function getCumulativeInputTokens(usage: Record<string, unknown>): number {
	const input = typeof usage.input === "number" ? usage.input : 0;
	const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
	return input + cacheRead;
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
			// Ignore malformed historical lines; Pi will report them if it loads the session directly.
		}
	}
	return entries;
}

function buildSessionHeader(
	headerEntry: ParsedEntry,
	parentSessionFile: string,
): string {
	return JSON.stringify({
		...headerEntry.parsed,
		timestamp: new Date().toISOString(),
		parentSession: parentSessionFile,
	});
}

function getMessage(entry: ParsedEntry): Record<string, unknown> | undefined {
	if (entry.parsed.type !== "message") return undefined;
	return entry.parsed.message as Record<string, unknown> | undefined;
}

function getAssistantUsage(
	entry: ParsedEntry,
): Record<string, unknown> | undefined {
	const msg = getMessage(entry);
	if (msg?.role !== "assistant") return undefined;
	const stopReason = msg.stopReason as string | undefined;
	if (stopReason === "aborted" || stopReason === "error") return undefined;
	return msg.usage as Record<string, unknown> | undefined;
}

function hasSuccessfulAssistant(entry: ParsedEntry): boolean {
	const msg = getMessage(entry);
	if (msg?.role !== "assistant") return false;
	const stopReason = msg.stopReason as string | undefined;
	return stopReason !== "aborted" && stopReason !== "error";
}

/**
 * Tool call content blocks can use different type strings depending on the
 * upstream API provider: "toolCall" (OpenAI), "toolUse" (Anthropic/Google),
 * or potentially other variants. Check both.
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

function getLatestTokenSegment(
	entries: ParsedEntry[],
	parentSessionFile: string,
): TokenSegment | undefined {
	let sawAssistant = false;
	let previousTokens = 0;
	let previousAssistantIndex = -1;
	let segmentStart = 0;
	let totalTokens = 0;

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!hasSuccessfulAssistant(entry)) continue;
		sawAssistant = true;

		const usage = getAssistantUsage(entry);
		if (!usage) {
			throw new Error(
				`Cannot safely fork ${parentSessionFile}: assistant message is missing usage metadata. ` +
					"Pi cannot compute a deterministic fork trim without per-turn token checkpoints.",
			);
		}

		const tokens = getCumulativeInputTokens(usage);
		if (tokens <= 0) {
			// Forked sessions intentionally zero inherited assistant usage after trimming.
			// Treat zero usage as a reset boundary so a nested fork can use later real
			// child checkpoints without mixing them with inherited parent entries.
			segmentStart = i + 1;
			previousTokens = 0;
			previousAssistantIndex = -1;
			totalTokens = 0;
			continue;
		}

		if (previousAssistantIndex >= 0 && tokens < previousTokens) {
			// A drop means compaction or another context reset happened. Start a new
			// independently-trimmable segment after the previous assistant.
			segmentStart = previousAssistantIndex + 1;
		}

		previousTokens = tokens;
		previousAssistantIndex = i;
		totalTokens = tokens;
	}

	if (!sawAssistant || previousAssistantIndex < 0) return undefined;
	return { entries: entries.slice(segmentStart), totalTokens };
}

/**
 * Check if a toolCallId exists in any assistant entry at or after `fromIndex`.
 */
function hasToolCallIdInRange(
	entries: ParsedEntry[],
	fromIndex: number,
	toolCallId: string,
): boolean {
	for (let i = fromIndex; i < entries.length; i++) {
		if (hasToolCallId(entries[i], toolCallId)) return true;
	}
	return false;
}

/**
 * Check if an entry is a toolResult with an orphaned tool call reference
 * (the tool call was excluded by the trim).
 */
function isOrphanedToolResult(
	entry: ParsedEntry,
	entries: ParsedEntry[],
	trimStart: number,
): boolean {
	if (entry.parsed.type !== "message") return false;
	const msg = entry.parsed.message as Record<string, unknown> | undefined;
	if (msg?.role !== "toolResult") return false;
	const toolCallId = msg.toolCallId as string | undefined;
	if (!toolCallId) return false;
	// The tool call is orphaned if it doesn't appear in any entry at or after trimStart.
	return !hasToolCallIdInRange(entries, trimStart, toolCallId);
}

function findTrimStart(
	entries: ParsedEntry[],
	totalTokens: number,
	budget: number,
): number {
	const overflow = totalTokens - budget;
	let previousAssistantTokens = 0;
	let previousAssistantIndex = -1;

	for (let i = 0; i < entries.length; i++) {
		const usage = getAssistantUsage(entries[i]);
		if (!usage) continue;

		if (previousAssistantTokens >= overflow) {
			const start = previousAssistantIndex + 1;
			// Skip orphaned tool results whose tool calls were excluded by the trim.
			// The openai-responses API rejects conversations with tool results that
			// reference non-existent tool call IDs.
			let adjusted = start;
			while (
				adjusted < entries.length &&
				isOrphanedToolResult(entries[adjusted], entries, start)
			) {
				adjusted++;
			}
			return adjusted;
		}

		previousAssistantTokens = getCumulativeInputTokens(usage);
		previousAssistantIndex = i;
	}

	return 0;
}

function serializeEntry(entry: ParsedEntry): string {
	const parsedClone = structuredClone(entry.parsed);

	if (parsedClone.type !== "message") {
		(parsedClone as any).message = {
			role: "custom",
			content: [],
			usage: zeroUsage(),
		};
		return JSON.stringify(parsedClone);
	}

	const msg = parsedClone.message as Record<string, unknown> | undefined;
	if (!msg) return JSON.stringify(parsedClone);

	// Parent usage is no longer valid after trimming. Keep a zero stub because the
	// compiled renderer expects message.usage.input on copied entries.
	msg.usage = zeroUsage();
	parsedClone.message = msg;
	return JSON.stringify(parsedClone);
}

function writeChildSession(
	entries: ParsedEntry[],
	headerEntry: ParsedEntry,
	childSessionFile: string,
	parentSessionFile: string,
): void {
	mkdirSync(dirname(childSessionFile), { recursive: true });
	const lines = [buildSessionHeader(headerEntry, parentSessionFile)];
	for (const entry of entries) {
		if (entry.parsed.type !== "session") {
			// Children never receive ambient awareness (skipped in session_start for
			// parentSession sessions). Drop the roster to avoid wasting context window.
			if (
				entry.parsed.type === "custom_message" &&
				(entry.parsed as Record<string, unknown>).customType === "subagent_roster"
			) continue;
			lines.push(serializeEntry(entry));
		}
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
	if (!headerEntry)
		throw new Error(`No session header found in ${parentSessionFile}`);

	const reserveTokens = options.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
	const budget = options.childContextWindow - reserveTokens;
	if (budget <= 0) {
		writeChildSession([], headerEntry, childSessionFile, parentSessionFile);
		return;
	}

	const entriesBeforeLaunch = getEntriesBeforeLaunch(
		entries,
		options.launchToolCallId,
	);
	const segment = getLatestTokenSegment(entriesBeforeLaunch, parentSessionFile);
	if (!segment) {
		writeChildSession([], headerEntry, childSessionFile, parentSessionFile);
		return;
	}

	const entriesToKeep =
		segment.totalTokens <= budget
			? segment.entries
			: segment.entries.slice(
					findTrimStart(segment.entries, segment.totalTokens, budget),
				);
	writeChildSession(
		entriesToKeep,
		headerEntry,
		childSessionFile,
		parentSessionFile,
	);
}
