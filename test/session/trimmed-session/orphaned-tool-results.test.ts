import {
	assert,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
	tmpdir,
	join,
	after,
	before,
	describe,
	it,
	writeTrimmedForkSession,
	assertToolResultsHavePriorToolCalls,
} from "./support.ts";

describe("fork trim orphaned tool results", () => {
	let tmpDir: string;

	before(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "orphaned-tool-test-"));
	});

	after(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function makeBaseSession(style: "toolCall" | "toolUse"): string {
		const path = join(tmpDir, `source-${style}.jsonl`);
		// Tool call block format differs by provider
		const toolCallBlock =
			style === "toolCall"
				? { type: "toolCall", id: "call_read", name: "read", arguments: '{"path":"/test"}' }
				: { type: "toolUse", id: "call_read", name: "read", input: { path: "/test" } };

		const usage = { input: 800, output: 10, cacheRead: 200, cacheWrite: 0, totalTokens: 1010, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "sess-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: tmpDir }),
			JSON.stringify({ type: "message", id: "user-1", parentId: "sess-1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "do something" }] } }),
			// Assistant with tool call (800 input + 200 cache = 1000 cumulative)
			JSON.stringify({ type: "message", id: "asst-1", parentId: "user-1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [toolCallBlock], usage, stopReason: "toolUse" } }),
			// Tool result for the above tool call
			JSON.stringify({ type: "message", id: "tr-1", parentId: "asst-1", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "toolResult", toolCallId: "call_read", toolName: "read", content: [{ type: "text", text: "file content" }] } }),
			// Second assistant (1800 cumulative input) — this one overflows a tight budget
			JSON.stringify({ type: "message", id: "asst-2", parentId: "asst-1", timestamp: "2026-01-01T00:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { ...usage, input: 1600, cacheRead: 200 }, stopReason: "stop" } }),
		];
		writeFileSync(path, `${lines.join("\n")}\n`, "utf-8");
		return path;
	}

	it("skips orphaned toolResult when trim cuts before its toolCall (toolCall style)", () => {
		const sourcePath = makeBaseSession("toolCall");
		const childPath = join(tmpDir, "child-toolCall.jsonl");

		// asst-1 has 1000 cumulative, asst-2 has 1800. Budget=800:
		// overflow=1000, asst-1 prev_tokens(0) < 1000, asst-2 prev_tokens(1000) >= 1000
		// → trim at prev_idx+1=3. Entry 3 (tr-1) is orphaned → skip to 4.
		writeTrimmedForkSession(sourcePath, childPath, {
			childContextWindow: 1800,
			reserveTokens: 1000, // budget = 800
		});

		const written = readFileSync(childPath, "utf-8");
		const lines = written.split("\n").filter((l) => l.trim());
		const entries = lines.map((l) => JSON.parse(l));

		// Should NOT contain any orphaned tool results
		assertToolResultsHavePriorToolCalls(entries);

		// The orphaned tr-1 entry should be absent; only asst-2 (and header) should remain
		const toolResults = entries.filter(
			(e) => e.type === "message" && e.message?.role === "toolResult",
		);
		assert.equal(toolResults.length, 0, "orphaned toolResult should be dropped");
	});

	it("skips orphaned toolResult when trim cuts before its toolCall (toolUse style)", () => {
		const sourcePath = makeBaseSession("toolUse");
		const childPath = join(tmpDir, "child-toolUse.jsonl");

		writeTrimmedForkSession(sourcePath, childPath, {
			childContextWindow: 1800,
			reserveTokens: 1000,
		});

		const written = readFileSync(childPath, "utf-8");
		const lines = written.split("\n").filter((l) => l.trim());
		const entries = lines.map((l) => JSON.parse(l));

		assertToolResultsHavePriorToolCalls(entries);

		const toolResults = entries.filter(
			(e) => e.type === "message" && e.message?.role === "toolResult",
		);
		assert.equal(toolResults.length, 0, "orphaned toolResult should be dropped (toolUse)");
	});

	it("preserves toolResult when toolCall is also kept", () => {
		const sourcePath = makeBaseSession("toolCall");
		const childPath = join(tmpDir, "child-kept.jsonl");

		// Generous budget — everything fits
		writeTrimmedForkSession(sourcePath, childPath, {
			childContextWindow: 100_000,
			reserveTokens: 10_000,
		});

		const written = readFileSync(childPath, "utf-8");
		const lines = written.split("\n").filter((l) => l.trim());
		const entries = lines.map((l) => JSON.parse(l));

		// All tool results should have valid tool calls
		assertToolResultsHavePriorToolCalls(entries);

		// Should still have the toolResult entry
		const toolResults = entries.filter(
			(e) => e.type === "message" && e.message?.role === "toolResult",
		);
		assert.equal(toolResults.length, 1, "toolResult should be preserved when its toolCall is kept");
	});

	it("handles mixed toolCall/toolUse formats in the same session", () => {
		const path = join(tmpDir, "source-mixed.jsonl");
		const usage = { input: 800, output: 10, cacheRead: 200, cacheWrite: 0, totalTokens: 1010, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "sess-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: tmpDir }),
			JSON.stringify({ type: "message", id: "user-1", parentId: "sess-1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "do something" }] } }),
			// OpenAI-style toolCall
			JSON.stringify({ type: "message", id: "asst-1", parentId: "user-1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "call_read", name: "read", arguments: '{"path":"/test"}' }], usage, stopReason: "toolUse" } }),
			// Result for OpenAI call
			JSON.stringify({ type: "message", id: "tr-1", parentId: "asst-1", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "toolResult", toolCallId: "call_read", toolName: "read", content: [{ type: "text", text: "content" }] } }),
			// Anthropic-style toolUse
			JSON.stringify({ type: "message", id: "asst-2", parentId: "asst-1", timestamp: "2026-01-01T00:00:04.000Z", message: { role: "assistant", content: [{ type: "toolUse", id: "call_find", name: "find", input: { pattern: "test" } }], usage: { ...usage, input: 1600, cacheRead: 200 }, stopReason: "toolUse" } }),
			// Result for Anthropic call
			JSON.stringify({ type: "message", id: "tr-2", parentId: "asst-2", timestamp: "2026-01-01T00:00:05.000Z", message: { role: "toolResult", toolCallId: "call_find", toolName: "find", content: [{ type: "text", text: "/found" }] } }),
			// Final assistant
			JSON.stringify({ type: "message", id: "asst-3", parentId: "asst-1", timestamp: "2026-01-01T00:00:06.000Z", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { ...usage, input: 2400, cacheRead: 200 }, stopReason: "stop" } }),
		];
		writeFileSync(path, `${lines.join("\n")}\n`, "utf-8");

		// asst-1(1000) + tr-1 kept, asst-2(1800) overflows budget=1200
		// overflow=1400, asst-1 prev_tokens(0) < 1400, asst-2 prev_tokens(1000) < 1400, asst-3 prev_tokens(1800) >= 1400 → trim at asst-2+1=5
		const childPath = join(tmpDir, "child-mixed.jsonl");
		writeTrimmedForkSession(path, childPath, {
			childContextWindow: 2200,
			reserveTokens: 1000,
		});

		const written = readFileSync(childPath, "utf-8");
		const lines2 = written.split("\n").filter((l) => l.trim());
		const entries = lines2.map((l) => JSON.parse(l));

		// No orphaned tool results
		assertToolResultsHavePriorToolCalls(entries);

		// tr-1 (call_read, OpenAI style) should be kept with its toolCall
		// tr-2 (call_find, Anthropic style) should be kept or dropped cleanly
		const trEntries = entries.filter(
			(e) => e.type === "message" && e.message?.role === "toolResult",
		);
		for (const tr of trEntries) {
			const tcId = tr.message.toolCallId;
			const hasToolCall = entries.some(
				(e) =>
					e.type === "message" &&
					e.message?.role === "assistant" &&
					e.message.content?.some(
						(b: any) =>
							(b.type === "toolCall" || b.type === "toolUse") &&
							b.id === tcId,
					),
			);
			assert.ok(hasToolCall, `toolResult(${tcId}) must have matching toolCall in kept entries`);
		}
	});

	it("skips multiple consecutive orphaned toolResults", () => {
		const path = join(tmpDir, "source-multi-orphan.jsonl");
		const usage = { input: 800, output: 10, cacheRead: 200, cacheWrite: 0, totalTokens: 1010, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "sess-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: tmpDir }),
			JSON.stringify({ type: "message", id: "user-1", parentId: "sess-1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "multi" }] } }),
			// Assistant with TWO tool calls (both OpenAI style)
			JSON.stringify({ type: "message", id: "asst-1", parentId: "user-1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [
				{ type: "toolCall", id: "call_a", name: "read", arguments: '{"path":"/a"}' },
				{ type: "toolCall", id: "call_b", name: "grep", arguments: '{"pattern":"x"}' },
			], usage, stopReason: "toolUse" } }),
			// Both results come in sequence
			JSON.stringify({ type: "message", id: "tr-a", parentId: "asst-1", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "toolResult", toolCallId: "call_a", toolName: "read", content: [{ type: "text", text: "a content" }] } }),
			JSON.stringify({ type: "message", id: "tr-b", parentId: "asst-1", timestamp: "2026-01-01T00:00:04.000Z", message: { role: "toolResult", toolCallId: "call_b", toolName: "grep", content: [{ type: "text", text: "match" }] } }),
			// Next assistant
			JSON.stringify({ type: "message", id: "asst-2", parentId: "asst-1", timestamp: "2026-01-01T00:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { ...usage, input: 1600, cacheRead: 200 }, stopReason: "stop" } }),
		];
		writeFileSync(path, `${lines.join("\n")}\n`, "utf-8");

		const childPath = join(tmpDir, "child-multi.jsonl");
		writeTrimmedForkSession(path, childPath, {
			childContextWindow: 1800,
			reserveTokens: 1000,
		});

		const written = readFileSync(childPath, "utf-8");
		const lines2 = written.split("\n").filter((l) => l.trim());
		const entries = lines2.map((l) => JSON.parse(l));

		// No orphaned tool results
		assertToolResultsHavePriorToolCalls(entries);

		// Both tr-a and tr-b should be absent (they're orphaned without asst-1)
		const toolResults = entries.filter(
			(e) => e.type === "message" && e.message?.role === "toolResult",
		);
		assert.equal(toolResults.length, 0, "both orphaned toolResults should be dropped");
	});
});
