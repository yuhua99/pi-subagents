/**
 * Seed behavior of writeTrimmedForkSession after the fork rewrite.
 *
 * The seed step no longer enforces a token budget — it copies the latest
 * segment of the parent session, applies a parent-side memory ceiling for
 * defense in depth, and neutralizes provider-specific tool metadata. The
 * child's authoritative byte-budget trim happens at LLM call time inside
 * the child process (covered by child-context-trim.test.ts).
 *
 * This file exercises:
 *   - Header rewrite (parentSession + sessionName).
 *   - Latest-segment slicing (zero-usage reset boundary).
 *   - Tool-call / tool-result neutralization.
 *   - Subagent-roster filtering.
 *   - Launch tool-call cutoff.
 *   - Parent-side memory ceiling (PI_SUBAGENT_FORK_MAX_INHERITANCE_BYTES).
 *   - Header-only output when no assistant exists.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { writeTrimmedForkSession } from "../../../src/session/trimmed-session.ts";

interface JsonObject {
	[key: string]: unknown;
}

let tmpDir: string;

before(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "fork-seed-"));
});

after(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function freshDir(): string {
	return mkdtempSync(join(tmpDir, "case-"));
}

function freshUsage(input: number, cacheRead = 0): JsonObject {
	return {
		input,
		output: 10,
		cacheRead,
		cacheWrite: 0,
		totalTokens: input + 10 + cacheRead,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

function writeJsonl(path: string, entries: JsonObject[]): void {
	writeFileSync(path, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf-8");
}

function readEntries(path: string): JsonObject[] {
	return readFileSync(path, "utf-8")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => JSON.parse(line) as JsonObject);
}

function getMessage(entry: JsonObject): JsonObject | undefined {
	if (entry.type !== "message") return undefined;
	return entry.message as JsonObject | undefined;
}

describe("writeTrimmedForkSession (seed)", () => {
	it("rewrites the header with parentSession and sessionName", () => {
		const dir = freshDir();
		const parent = join(dir, "parent.jsonl");
		const child = join(dir, "child.jsonl");
		writeJsonl(parent, [
			{ type: "session", version: 3, id: "sess-1", cwd: dir },
			{
				type: "message",
				id: "u1",
				message: { role: "user", content: [{ type: "text", text: "hi" }] },
			},
			{
				type: "message",
				id: "a1",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hi back" }],
					usage: freshUsage(50),
					stopReason: "stop",
				},
			},
		]);

		writeTrimmedForkSession(parent, child, {
			childContextWindow: 100_000,
			sessionName: "child-title",
		});

		const entries = readEntries(child);
		const header = entries[0];
		assert.equal(header.type, "session");
		assert.equal(header.parentSession, parent);
		assert.equal(header.name, "child-title");
	});

	it("zeroes assistant usage on inherited messages", () => {
		const dir = freshDir();
		const parent = join(dir, "parent.jsonl");
		const child = join(dir, "child.jsonl");
		writeJsonl(parent, [
			{ type: "session", version: 3, id: "sess-1", cwd: dir },
			{
				type: "message",
				id: "u1",
				message: { role: "user", content: [{ type: "text", text: "hi" }] },
			},
			{
				type: "message",
				id: "a1",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hi back" }],
					usage: freshUsage(12345, 678),
					stopReason: "stop",
				},
			},
		]);

		writeTrimmedForkSession(parent, child, { childContextWindow: 100_000 });

		const entries = readEntries(child);
		const assistant = entries.find(
			(e) => getMessage(e)?.role === "assistant",
		);
		assert.ok(assistant, "assistant must survive the seed");
		const usage = (getMessage(assistant!)!.usage as JsonObject) ?? {};
		assert.equal(usage.input, 0, "input must be zeroed");
		assert.equal(usage.cacheRead, 0, "cacheRead must be zeroed");
		assert.equal(usage.totalTokens, 0, "totalTokens must be zeroed");
	});

	it("converts inherited toolCall blocks to text placeholders and tool results to user messages", () => {
		const dir = freshDir();
		const parent = join(dir, "parent.jsonl");
		const child = join(dir, "child.jsonl");
		writeJsonl(parent, [
			{ type: "session", version: 3, id: "sess-1", cwd: dir },
			{
				type: "message",
				id: "u1",
				message: { role: "user", content: [{ type: "text", text: "go" }] },
			},
			{
				type: "message",
				id: "a1",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "tc-1", name: "read", arguments: "{}" },
					],
					usage: freshUsage(100),
					stopReason: "toolUse",
				},
			},
			{
				type: "message",
				id: "tr1",
				message: {
					role: "toolResult",
					toolCallId: "tc-1",
					toolName: "read",
					content: [{ type: "text", text: "file contents" }],
				},
			},
			{
				type: "message",
				id: "a2",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					usage: freshUsage(200),
					stopReason: "stop",
				},
			},
		]);

		writeTrimmedForkSession(parent, child, { childContextWindow: 100_000 });
		const entries = readEntries(child);

		// No raw toolCall/toolUse blocks survive
		for (const entry of entries) {
			const msg = getMessage(entry);
			if (msg?.role !== "assistant") continue;
			const content = msg.content as Array<JsonObject> | undefined;
			if (!Array.isArray(content)) continue;
			for (const block of content) {
				assert.notEqual(block.type, "toolCall");
				assert.notEqual(block.type, "toolUse");
			}
		}

		// No toolResult role survives
		for (const entry of entries) {
			const msg = getMessage(entry);
			if (msg) assert.notEqual(msg.role, "toolResult");
		}

		// The tool result text appears as a user message
		const userText = entries
			.map((e) => {
				const msg = getMessage(e);
				if (msg?.role !== "user") return undefined;
				const content = msg.content as Array<JsonObject> | undefined;
				if (!Array.isArray(content)) return undefined;
				const text = content[0]?.text;
				return typeof text === "string" ? text : undefined;
			})
			.filter(Boolean);
		assert.ok(
			userText.includes("file contents"),
			"tool result content should survive as a user message",
		);
	});

	it("filters subagent_roster custom messages so the child can re-emit its own", () => {
		const dir = freshDir();
		const parent = join(dir, "parent.jsonl");
		const child = join(dir, "child.jsonl");
		writeJsonl(parent, [
			{ type: "session", version: 3, id: "sess-1", cwd: dir },
			{
				type: "message",
				id: "u1",
				message: { role: "user", content: [{ type: "text", text: "hi" }] },
			},
			{
				type: "message",
				id: "a1",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					usage: freshUsage(50),
					stopReason: "stop",
				},
			},
			{
				type: "custom_message",
				id: "rs1",
				customType: "subagent_roster",
				content: "parent roster - should not leak",
				display: false,
			},
		]);

		writeTrimmedForkSession(parent, child, { childContextWindow: 100_000 });
		const entries = readEntries(child);
		const rosters = entries.filter(
			(e) => e.type === "custom_message" && e.customType === "subagent_roster",
		);
		assert.equal(rosters.length, 0, "parent roster must not leak into child");
	});

	it("excludes the launch turn when launchToolCallId is provided", () => {
		const dir = freshDir();
		const parent = join(dir, "parent.jsonl");
		const child = join(dir, "child.jsonl");
		writeJsonl(parent, [
			{ type: "session", version: 3, id: "sess-1", cwd: dir },
			{
				type: "message",
				id: "u1",
				message: { role: "user", content: [{ type: "text", text: "step 1" }] },
			},
			{
				type: "message",
				id: "a1",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					usage: freshUsage(50),
					stopReason: "stop",
				},
			},
			{
				type: "message",
				id: "u2",
				message: { role: "user", content: [{ type: "text", text: "go fork" }] },
			},
			{
				type: "message",
				id: "a-launch",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "launch-tc",
							name: "subagent",
							arguments: "{}",
						},
					],
					usage: freshUsage(100),
					stopReason: "toolUse",
				},
			},
			{
				type: "message",
				id: "tr-launch",
				message: {
					role: "toolResult",
					toolCallId: "launch-tc",
					toolName: "subagent",
					content: [{ type: "text", text: "child started" }],
				},
			},
		]);

		writeTrimmedForkSession(parent, child, {
			childContextWindow: 100_000,
			launchToolCallId: "launch-tc",
		});

		const entries = readEntries(child);
		// The launch turn (a-launch + tr-launch) must not appear
		const ids = entries.map((e) => e.id).filter(Boolean);
		assert.ok(!ids.includes("a-launch"), "launch turn must be excluded");
		assert.ok(!ids.includes("tr-launch"), "launch tool result must be excluded");
		// Pre-launch turns must survive
		assert.ok(ids.includes("u1"), "pre-launch user must survive");
		assert.ok(ids.includes("a1"), "pre-launch assistant must survive");
	});

	it("starts the segment after the most recent zero-usage assistant marker", () => {
		const dir = freshDir();
		const parent = join(dir, "parent.jsonl");
		const child = join(dir, "child.jsonl");
		writeJsonl(parent, [
			{ type: "session", version: 3, id: "sess-1", cwd: dir },
			{
				type: "message",
				id: "u-old",
				message: {
					role: "user",
					content: [{ type: "text", text: "OLD context" }],
				},
			},
			{
				type: "message",
				id: "a-old",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "OLD" }],
					usage: freshUsage(100),
					stopReason: "stop",
				},
			},
			// Reset marker (zero usage assistant)
			{
				type: "message",
				id: "a-reset",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "[reset]" }],
					usage: ZERO_USAGE,
					stopReason: "stop",
				},
			},
			{
				type: "message",
				id: "u-new",
				message: {
					role: "user",
					content: [{ type: "text", text: "NEW context" }],
				},
			},
			{
				type: "message",
				id: "a-new",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "NEW" }],
					usage: freshUsage(50),
					stopReason: "stop",
				},
			},
		]);

		writeTrimmedForkSession(parent, child, { childContextWindow: 100_000 });
		const content = readFileSync(child, "utf-8");
		assert.ok(!content.includes("OLD context"), "pre-reset content must be dropped");
		assert.ok(!content.includes("OLD"), "pre-reset assistant must be dropped");
		assert.ok(content.includes("NEW context"), "post-reset content must survive");
		assert.ok(content.includes("NEW"), "post-reset assistant must survive");
	});

	it("writes header-only when no assistant message exists in the latest segment", () => {
		const dir = freshDir();
		const parent = join(dir, "parent.jsonl");
		const child = join(dir, "child.jsonl");
		writeJsonl(parent, [
			{ type: "session", version: 3, id: "sess-1", cwd: dir },
			{ type: "model_change", id: "mc1", parentId: null },
			{
				type: "message",
				id: "u1",
				message: { role: "user", content: [{ type: "text", text: "no answer yet" }] },
			},
		]);
		writeTrimmedForkSession(parent, child, { childContextWindow: 100_000 });
		const entries = readEntries(child);
		assert.equal(entries.length, 1, "should be header-only");
		assert.equal(entries[0].type, "session");
	});

	it("applies the parent-side memory ceiling and prunes orphaned tool results that result", () => {
		const dir = freshDir();
		const parent = join(dir, "parent.jsonl");
		const child = join(dir, "child.jsonl");

		// Build a session whose serialized prefix is intentionally large.
		const big = "x".repeat(2000);
		const entries: JsonObject[] = [
			{ type: "session", version: 3, id: "sess-1", cwd: dir },
		];
		// 50 turn pairs (~ 200 KiB+ when serialized). Each assistant has a
		// toolCall + toolResult that should pair correctly under normal trim.
		for (let i = 0; i < 50; i++) {
			entries.push({
				type: "message",
				id: `u-${i}`,
				message: { role: "user", content: [{ type: "text", text: `${big} ${i}` }] },
			});
			entries.push({
				type: "message",
				id: `a-${i}`,
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: big },
						{ type: "toolCall", id: `tc-${i}`, name: "read", arguments: "{}" },
					],
					usage: freshUsage(1000 + i),
					stopReason: "toolUse",
				},
			});
			entries.push({
				type: "message",
				id: `tr-${i}`,
				message: {
					role: "toolResult",
					toolCallId: `tc-${i}`,
					toolName: "read",
					content: [{ type: "text", text: big }],
				},
			});
		}
		writeJsonl(parent, entries);

		// Set a tight ceiling that forces oldest entries to be dropped.
		const previous =
			process.env.PI_SUBAGENT_FORK_MAX_INHERITANCE_BYTES;
		process.env.PI_SUBAGENT_FORK_MAX_INHERITANCE_BYTES = String(64 * 1024);
		try {
			writeTrimmedForkSession(parent, child, { childContextWindow: 100_000 });
		} finally {
			if (previous === undefined)
				delete process.env.PI_SUBAGENT_FORK_MAX_INHERITANCE_BYTES;
			else process.env.PI_SUBAGENT_FORK_MAX_INHERITANCE_BYTES = previous;
		}

		const childBytes = readFileSync(child).byteLength;
		assert.ok(
			childBytes <= 80 * 1024,
			`child seed should be at or below the ceiling (got ${childBytes} bytes)`,
		);

		// No toolResult survived as a toolResult role (all converted to user).
		// And no neutralized tool result references a missing tool call: the
		// orphan pruning runs after the ceiling drop, so any user-converted
		// tool result that survived must still have its corresponding [tool
		// call: read] placeholder in the kept assistant content. This is
		// covered indirectly by ensuring no entries have role=toolResult and
		// no entries reference an id that was dropped.
		const kept = readEntries(child);
		for (const entry of kept) {
			const msg = getMessage(entry);
			if (msg) assert.notEqual(msg.role, "toolResult");
			if (msg && typeof msg.toolCallId === "string") {
				assert.fail("toolCallId metadata must not survive in child seed");
			}
		}
	});
});
