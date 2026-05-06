/**
 * Context-window-aware fork session trimming.
 *
 * When forking a parent session into a child, this module ensures the child
 * session file does not exceed the child model's context window (minus reserved
 * output tokens).
 *
 * Token counting strategy:
 *   For assistant messages, pi records usage.input + usage.cacheRead as the
 *   total input tokens sent to the API for that request — this IS the cumulative
 *   context size at that point (system prompt + conversation history + cached
 *   prompt). We walk backwards through assistant messages, accumulating the
 *   incremental cost between consecutive assistants. When the accumulated cost
 *   reaches the budget, everything after that cut point is kept; everything
 *   before is trimmed.
 *
 *   This prevents immediate compaction when the child session loads a forked
 *   parent context that is larger than the child model's window.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";


/**
 * Options for writeTrimmedForkSession.
 */
export interface TrimmedForkSessionOptions {
  /** The child model's total context window in tokens. */
  childContextWindow: number;
  /** Tokens to reserve for the child model's output. Defaults to 10_000. */
  reserveTokens?: number;
}

const DEFAULT_RESERVE_TOKENS = 10_000;

interface ParsedEntry {
  line: string;
  parsed: Record<string, unknown>;
}

/**
 * Get the cumulative input context size from an assistant message's usage.
 * This is input + cacheRead (total input tokens sent to the API for this request).
 */
function getCumulativeInputTokens(usage: Record<string, unknown>): number {
  const input = typeof usage.input === "number" ? usage.input : 0;
  const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
  return input + cacheRead;
}

/**
 * Read all entries from a session JSONL file.
 */
function readSessionEntries(sessionFile: string): ParsedEntry[] {
  const content = readFileSync(sessionFile, "utf-8");
  const entries: ParsedEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push({ line: trimmed, parsed: JSON.parse(trimmed) });
    } catch {
      // skip unparseable lines
    }
  }
  return entries;
}

/**
 * Build a new session header that references the parent session.
 */
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

/**
 * Strip the `usage` field from an assistant message entry.
 * Usage data from the parent session reflects the OLD context size (including
 * portions that may have been trimmed). The child must start fresh; keeping
 * stale usage would cause pi's compaction to overestimate context size.
 */
function serializeEntry(entry: ParsedEntry): string {
  if (entry.parsed.type !== "message") return entry.line;
  const msg = entry.parsed.message as Record<string, unknown> | undefined;
  if (!msg || msg.role !== "assistant") return entry.line;
  if (!msg.usage) return entry.line;

  // Clone and strip usage
  const parsedClone = structuredClone(entry.parsed);
  const msgClone = (parsedClone as any).message as Record<string, unknown>;
  delete msgClone.usage;
  (parsedClone as any).message = msgClone;
  return JSON.stringify(parsedClone);
}

/**
 * Write a trimmed fork session to `childSessionFile` containing only the most
 * recent parent session entries that fit within the child model's context window
 * minus reserved output tokens.
 *
 * The trim strategy:
 * 1. Find the last assistant message and read usage.input + usage.cacheRead
 *    (= cumulative input tokens for that request).
 * 2. If it fits within budget, write all entries as-is.
 * 3. If not, walk backwards through assistant messages to find the newest one
 *    whose cumulative input fits within budget. Keep everything from that
 *    entry onward; discard everything before it.
 *
 * All written entries have their `usage` metadata stripped from assistant
 * messages, since those values reflect the parent conversation's context size
 * (including trimmed portions) and would cause pi to overestimate the child's
 * context usage, triggering unnecessary early compaction.
 *
 * Throws on fundamental errors (missing source file, no session header).
 */
export function writeTrimmedForkSession(
  parentSessionFile: string,
  childSessionFile: string,
  options: TrimmedForkSessionOptions,
): void {
  const reserveTokens = options.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
  const budget = options.childContextWindow - reserveTokens;

  // If the budget is zero or negative (e.g. reserveTokens >= contextWindow),
  // no context can fit — write header-only.
  if (budget <= 0) {
    const entries = readSessionEntries(parentSessionFile);
    const headerEntry = entries.find((e) => e.parsed.type === "session");
    if (headerEntry) {
      mkdirSync(dirname(childSessionFile), { recursive: true });
      writeFileSync(childSessionFile, buildSessionHeader(headerEntry, parentSessionFile) + "\n", "utf-8");
    } else {
      throw new Error(`No session header found in ${parentSessionFile}`);
    }
    return;
  }

  const entries = readSessionEntries(parentSessionFile);
  const headerEntry = entries.find((e) => e.parsed.type === "session");
  if (!headerEntry) {
    throw new Error(`No session header found in ${parentSessionFile}`);
  }

  // Find the last assistant message's usage to get total cumulative context size
  const lastUsage = findLastAssistantUsage(entries);
  if (!lastUsage) {
    // No assistant messages — nothing useful to fork, just write the header
    mkdirSync(dirname(childSessionFile), { recursive: true });
    writeFileSync(childSessionFile, buildSessionHeader(headerEntry, parentSessionFile) + "\n", "utf-8");
    return;
  }

  const totalContext = getCumulativeInputTokens(lastUsage);

  if (totalContext <= budget) {
    // Whole session fits — write everything as-is
    writeAllEntries(entries, headerEntry, childSessionFile, parentSessionFile);
    return;
  }

  // Session exceeds budget. Walk FORWARD through assistant messages to find
  // the first turn where the suffix (everything from that turn onward) fits
  // within budget.
  //
  // Suffix from turn i to end ≈ totalContext - cumulative[i-1], where cumulative[i-1]
  // is the cumulative input tokens at the assistant BEFORE turn i.
  // We need: totalContext - cumulative[i-1] <= budget
  //      =>  cumulative[i-1] >= totalContext - budget = overflow
  //
  // For the first assistant, cumulative[i-1] = 0 (no preceding assistant).
  const overflow = totalContext - budget;
  let firstKeptIndex = 0;
  let prevAssistantCumulative = 0;
  let prevAssistantIndex = -1;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.parsed.type !== "message") continue;
    const msg = entry.parsed.message as Record<string, unknown> | undefined;
    if (msg?.role !== "assistant") continue;
    const usage = msg.usage as Record<string, unknown> | undefined;
    if (!usage) continue;

    // cumulativeBefore = cumulative of the assistant BEFORE this one.
    // For the first assistant, cumulativeBefore = 0.
    if (prevAssistantCumulative >= overflow) {
      // The suffix from this assistant's turn onward fits within budget.
      // Start the kept session at the entry right after the previous assistant.
      firstKeptIndex = prevAssistantIndex + 1;
      break;
    }
    prevAssistantCumulative = getCumulativeInputTokens(usage);
    prevAssistantIndex = i;
  }

  // If no cut was found (unusual — first assistant's cumulative already >= overflow),
  // the whole session fits from the start. firstKeptIndex stays at 0.

  // Write from firstKeptIndex to end, skipping session-type entries
  mkdirSync(dirname(childSessionFile), { recursive: true });
  const trimmedLines: string[] = [buildSessionHeader(headerEntry, parentSessionFile)];
  for (let i = firstKeptIndex; i < entries.length; i++) {
    if (entries[i].parsed.type !== "session") {
      trimmedLines.push(serializeEntry(entries[i]));
    }
  }
  writeFileSync(childSessionFile, trimmedLines.join("\n") + "\n", "utf-8");
}

/**
 * Find the last non-aborted assistant message's usage from session entries.
 */
function findLastAssistantUsage(entries: ParsedEntry[]): Record<string, unknown> | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.parsed.type !== "message") continue;
    const msg = entry.parsed.message as Record<string, unknown> | undefined;
    if (msg?.role !== "assistant") continue;
    const usage = msg.usage as Record<string, unknown> | undefined;
    if (!usage) continue;
    // Skip aborted/error messages (no stopReason means it's valid)
    const stopReason = msg.stopReason as string | undefined;
    if (stopReason === "aborted" || stopReason === "error") continue;
    return usage;
  }
  return undefined;
}

/**
 * Write all entries with a new session header.
 */
function writeAllEntries(
  entries: ParsedEntry[],
  headerEntry: ParsedEntry,
  childSessionFile: string,
  parentSessionFile: string,
): void {
  mkdirSync(dirname(childSessionFile), { recursive: true });
  const lines: string[] = [buildSessionHeader(headerEntry, parentSessionFile)];
  for (const entry of entries) {
    if (entry.parsed.type !== "session") {
      lines.push(serializeEntry(entry));
    }
  }
  writeFileSync(childSessionFile, lines.join("\n") + "\n", "utf-8");
}
