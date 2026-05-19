/**
 * Child-side context-event byte-budget trim tests.
 *
 * The child handler enforces the only invariant that matters for fork mode:
 * the messages sent to the child's first LLM call must fit the child's
 * context window. The metric is UTF-8 byte length of the serialized message
 * payload, which is a sound upper bound on tokens for every byte-level BPE
 * tokenizer.
 *
 * These tests probe applyByteBudgetTrim directly: it is the algorithm. The
 * pi.on("context", …) registration is exercised by the live e2e tests.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { applyByteBudgetTrim } from "../../src/runtime/child-context-trim.ts";

interface MessageLike {
	role: string;
	customType?: string;
	content?: unknown;
	toolCallId?: string;
	toolName?: string;
	timestamp?: number;
}

const BOUNDARY: MessageLike = {
	role: "custom",
	customType: "subagent_boundary",
	content: "boundary marker",
};

function userMsg(text: string): MessageLike {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: 0,
	};
}

function assistantMsg(text: string, toolCallId?: string): MessageLike {
	const content: Array<Record<string, unknown>> = [{ type: "text", text }];
	if (toolCallId) {
		content.push({
			type: "toolCall",
			id: toolCallId,
			name: "read",
			arguments: "{}",
		});
	}
	return { role: "assistant", content, timestamp: 0 };
}

function toolResultMsg(toolCallId: string, text: string): MessageLike {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
	};
}

describe("applyByteBudgetTrim", () => {
	it("returns undefined when no boundary marker is present (Phase 3)", () => {
		const messages: MessageLike[] = [
			userMsg("hello"),
			assistantMsg("hi"),
			userMsg("more"),
			assistantMsg("more"),
		];
		const result = applyByteBudgetTrim(messages, 128_000, 10_000);
		assert.equal(result, undefined, "no boundary => no trim");
	});

	it("returns undefined when total bytes already fit the budget (Phase 1)", () => {
		const messages: MessageLike[] = [
			userMsg("inherited 1"),
			assistantMsg("inherited 2"),
			BOUNDARY,
			userMsg("child task"),
		];
		const result = applyByteBudgetTrim(messages, 128_000, 10_000);
		assert.equal(result, undefined, "fits budget => no trim");
	});

	it("drops oldest inherited messages when over budget (Phase 2)", () => {
		const big = "y".repeat(50_000);
		const messages: MessageLike[] = [
			userMsg(big),
			assistantMsg(big),
			userMsg(big),
			assistantMsg(big),
			BOUNDARY,
			userMsg("small child task"),
		];
		// contextWindow 200_000, reserve max(50_000, 16_384) = 50_000
		// budget = 150_000. Each user/assistant ~50 KiB + JSON overhead.
		const result = applyByteBudgetTrim(messages, 200_000, 50_000);
		assert.ok(result, "should trim");
		// Boundary and child task must always survive.
		const boundary = result!.find((m) => {
			const mm = m as MessageLike;
			return mm.role === "custom" && mm.customType === "subagent_boundary";
		});
		assert.ok(boundary, "boundary marker must survive");
		const childTask = result!.find((m) => {
			const mm = m as MessageLike;
			if (mm.role !== "user") return false;
			const content = mm.content as Array<{ text?: string }> | undefined;
			return Array.isArray(content) && content[0]?.text === "small child task";
		});
		assert.ok(childTask, "child task must survive");
		// Total kept bytes must be ≤ budget.
		const totalBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
		assert.ok(totalBytes <= 150_000, `kept bytes ${totalBytes} > budget`);
	});

	it("never drops messages after the boundary (child's own work is sacrosanct in Phase 2)", () => {
		const big = "z".repeat(40_000);
		const messages: MessageLike[] = [
			userMsg(big),
			assistantMsg(big),
			BOUNDARY,
			userMsg("child task A"),
			assistantMsg("child reply A"),
			userMsg("child task B"),
		];
		const result = applyByteBudgetTrim(messages, 100_000, 10_000);
		// May or may not trim depending on sizes, but if it does, the post-
		// boundary messages must all be present in order.
		const survivors = result ?? messages;
		const boundaryIdx = survivors.findIndex((m) => {
			const mm = m as MessageLike;
			return mm.role === "custom" && mm.customType === "subagent_boundary";
		});
		assert.ok(boundaryIdx >= 0, "boundary should survive");
		// All child-task strings present in order
		const tail = survivors
			.slice(boundaryIdx + 1)
			.map((m) => {
				const mm = m as MessageLike;
				const content = mm.content as Array<{ text?: string }> | undefined;
				return Array.isArray(content) ? content[0]?.text : undefined;
			})
			.filter(Boolean);
		assert.deepEqual(tail, [
			"child task A",
			"child reply A",
			"child task B",
		]);
	});

	it("prunes orphaned tool results in the kept set after dropping a tool call", () => {
		const big = "p".repeat(30_000);
		const messages: MessageLike[] = [
			userMsg(big),
			assistantMsg("call read", "tc-1"),
			toolResultMsg("tc-1", big),
			userMsg(big),
			assistantMsg("call grep", "tc-2"),
			toolResultMsg("tc-2", "grep result"),
			BOUNDARY,
			userMsg("child"),
		];
		const result = applyByteBudgetTrim(messages, 80_000, 10_000);
		assert.ok(result, "should trim");
		// If tc-1 was dropped, its tool result must also be gone.
		const keptIds = new Set<string>();
		for (const m of result!) {
			const mm = m as MessageLike;
			if (mm.role !== "assistant") continue;
			const content = mm.content as Array<{ type?: string; id?: string }> | undefined;
			if (!Array.isArray(content)) continue;
			for (const block of content) {
				if (
					(block.type === "toolCall" || block.type === "toolUse") &&
					typeof block.id === "string"
				) {
					keptIds.add(block.id);
				}
			}
		}
		for (const m of result!) {
			const mm = m as MessageLike;
			if (mm.role !== "toolResult") continue;
			if (typeof mm.toolCallId !== "string") continue;
			assert.ok(
				keptIds.has(mm.toolCallId),
				`tool result for ${mm.toolCallId} survived without its tool call`,
			);
		}
	});

	it("when even dropping the entire inherited prefix does not fit, drops the boundary too", () => {
		// Construct a session where the boundary itself is large enough that
		// dropping the inherited prefix is still not sufficient. The marker is
		// pathologically large here purely as a regression case for the
		// "boundary itself drops" branch.
		const huge = "Q".repeat(50_000);
		const fatBoundary: MessageLike = {
			role: "custom",
			customType: "subagent_boundary",
			content: "Z".repeat(50_000),
		};
		const messages: MessageLike[] = [
			userMsg(huge),
			assistantMsg(huge),
			fatBoundary,
			userMsg("child task"),
		];
		// Budget = 100_000 - max(10_000, 16_384) = 83_616. Sum of all messages
		// ≈ 50_000 * 3 ≈ 150_000+. Even after dropping both inherited
		// messages, kept = boundary(50_000) + child(small) ≈ 50_000 < budget.
		// Need a tighter budget to actually trigger the boundary drop:
		const result = applyByteBudgetTrim(messages, 80_000, 50_000);
		assert.ok(result, "should trim");
		// Effective reserve max(50_000, 16_384) = 50_000, budget = 30_000.
		// Inherited dropped, boundary still ~50 KB > 30 KB, so boundary drops.
		const survivorRoles = result!.map((m) => (m as MessageLike).role);
		assert.ok(
			!survivorRoles.includes("custom"),
			"oversized boundary should also be dropped",
		);
		const childText = result!.find((m) => {
			const mm = m as MessageLike;
			if (mm.role !== "user") return false;
			const content = mm.content as Array<{ text?: string }> | undefined;
			return Array.isArray(content) && content[0]?.text === "child task";
		});
		assert.ok(childText, "child task must survive");
	});

	it("respects the larger of fork-output reserve vs Pi compaction reserve", () => {
		// Reserve 5_000 < pi-compaction default 16_384, so handler should
		// use 16_384 as the effective reserve. budget = 100_000 - 16_384 ≈ 83_616
		const big = "B".repeat(70_000);
		const messages: MessageLike[] = [
			userMsg(big),
			assistantMsg(big),
			BOUNDARY,
			userMsg("ok"),
		];
		const result = applyByteBudgetTrim(messages, 100_000, 5_000);
		assert.ok(result, "should trim");
		const totalBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
		assert.ok(
			totalBytes <= 100_000 - 16_384,
			`kept bytes ${totalBytes} exceed effective budget`,
		);
	});

	it("returns child-only suffix when budget is non-positive (reserve >= context window)", () => {
		const messages: MessageLike[] = [
			userMsg("inherited"),
			BOUNDARY,
			userMsg("child"),
		];
		const result = applyByteBudgetTrim(messages, 1_000, 10_000);
		assert.ok(result, "non-positive budget must produce a trim");
		const survivorTexts = result!
			.map((m) => {
				const mm = m as MessageLike;
				const content = mm.content as Array<{ text?: string }> | undefined;
				return Array.isArray(content) ? content[0]?.text : undefined;
			})
			.filter(Boolean);
		assert.deepEqual(survivorTexts, ["child"]);
	});

	it("handles empty messages array gracefully", () => {
		const result = applyByteBudgetTrim([], 128_000, 10_000);
		assert.equal(result, undefined);
	});
});
