/**
 * Integration test: pi-core compaction must remain functional inside subagent
 * sessions. Specifically:
 *
 *   1. When there's no inheritance-boundary marker (Phase 3, or non-fork
 *      session), the byte-budget handler must be a no-op so pi-core sees
 *      unmodified usage and triggers compaction normally.
 *
 *   2. When the boundary IS present and the kept set fits the byte cap, the
 *      handler is also a no-op — pi-core gets the same messages, sees the
 *      real usage, and decides whether to compact based on its own logic.
 *
 *   3. When the handler DOES trim (Phase 2), the trimmed result reduces the
 *      byte count (and therefore the upper-bound on tokens) to under the
 *      compaction threshold. So pi-core will not fire compaction on the
 *      first turn.
 *
 * This test validates the integration without needing a live LLM. The LLM
 * loop is replaced by direct imports from pi-core: shouldCompact,
 * DEFAULT_COMPACTION_SETTINGS, calculateContextTokens.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	DEFAULT_COMPACTION_SETTINGS,
	calculateContextTokens,
	shouldCompact,
} from "@earendil-works/pi-coding-agent";

import { applyByteBudgetTrim } from "../../src/runtime/child-context-trim.ts";

interface MessageLike {
	role: string;
	customType?: string;
	content?: unknown;
}

const BOUNDARY: MessageLike = {
	role: "custom",
	customType: "subagent_boundary",
	content: "boundary marker",
};

function userMsg(text: string): MessageLike {
	return { role: "user", content: [{ type: "text", text }] };
}

function makeUsage(input: number, cacheRead = 0, cacheWrite = 0) {
	return {
		input,
		output: 100,
		cacheRead,
		cacheWrite,
		totalTokens: input + 100 + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("child-context-trim ↔ pi-core compaction integration", () => {
	const settings = DEFAULT_COMPACTION_SETTINGS;
	// settings.reserveTokens should be 16384 (per docs/compaction.md).
	// Verify it's there so the test is grounded in the real pi-core default.
	assert.ok(
		settings.enabled === true,
		"pi-core compaction must default to enabled",
	);
	assert.equal(
		settings.reserveTokens,
		16384,
		"pi-core's documented reserveTokens default is 16384",
	);

	const childContextWindow = 200_000;
	const compactionThreshold =
		childContextWindow - settings.reserveTokens; // 183616

	it("Phase 3: with no boundary marker, handler is a no-op so pi-core sees unmodified state", () => {
		const messages: MessageLike[] = [
			userMsg("turn 1"),
			userMsg("turn 2"),
			userMsg("turn 3"),
		];
		const result = applyByteBudgetTrim(messages, childContextWindow, 10_000);
		assert.equal(result, undefined, "no boundary => handler must return undefined");

		// The handler returning undefined means pi sends the unmodified messages
		// to the LLM. Pi-core's compaction trigger then operates on whatever
		// usage the LLM returns. We simulate that with a usage that crosses the
		// threshold:
		const usage = makeUsage(compactionThreshold + 1);
		const contextTokens = calculateContextTokens(usage);
		assert.ok(
			shouldCompact(contextTokens, childContextWindow, settings),
			"with no handler interference, pi-core compaction must trigger when usage exceeds threshold",
		);
	});

	it("Phase 1: boundary present + small kept set => handler is a no-op, pi-core path unobstructed", () => {
		const messages: MessageLike[] = [
			userMsg("inherited 1"),
			userMsg("inherited 2"),
			BOUNDARY,
			userMsg("child task"),
		];
		const result = applyByteBudgetTrim(messages, childContextWindow, 10_000);
		assert.equal(result, undefined, "small kept set => no trim");

		// And again pi-core is the gate:
		const lowUsage = makeUsage(50_000);
		assert.ok(
			!shouldCompact(
				calculateContextTokens(lowUsage),
				childContextWindow,
				settings,
			),
			"low usage => no compaction (matches our intent in Phase 1)",
		);
	});

	it("Phase 2: handler trims oversized inherited set; result keeps pi-core's compaction trigger dormant", () => {
		const big = "x".repeat(200_000);
		const messages: MessageLike[] = [
			userMsg(big), // ~200 KiB
			userMsg(big), // ~200 KiB
			BOUNDARY,
			userMsg("child task"),
		];
		const result = applyByteBudgetTrim(messages, childContextWindow, 10_000);
		assert.ok(result, "Phase 2 must trim");

		// After trim: kept bytes ≤ contextWindow - max(10000, 16384) = 183616.
		const keptBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
		assert.ok(
			keptBytes <= compactionThreshold,
			`kept bytes ${keptBytes} must be ≤ compactionThreshold ${compactionThreshold}`,
		);

		// Sound bound (tokens ≤ bytes) means tokens(kept) ≤ keptBytes ≤
		// compactionThreshold. So even if the LLM reports usage.input equal to
		// the upper bound, shouldCompact must NOT fire.
		const upperBoundUsage = makeUsage(keptBytes);
		assert.ok(
			!shouldCompact(
				calculateContextTokens(upperBoundUsage),
				childContextWindow,
				settings,
			),
			"Phase 2 trim must keep pi-core compaction dormant — that's the design contract",
		);
	});

	it("Phase 3 transition: when prefix and boundary are both dropped, handler stops trimming on next turn", () => {
		// First call: oversized inherited content, undersized budget => handler
		// drops everything including the boundary.
		const huge = "Q".repeat(50_000);
		const fatBoundary: MessageLike = {
			role: "custom",
			customType: "subagent_boundary",
			content: "Z".repeat(50_000),
		};
		const turn1: MessageLike[] = [
			userMsg(huge),
			userMsg(huge),
			fatBoundary,
			userMsg("child task"),
		];
		const trimmed = applyByteBudgetTrim(turn1, 80_000, 50_000);
		assert.ok(trimmed, "should trim");
		assert.ok(
			!trimmed!.some(
				(m) =>
					(m as MessageLike).role === "custom" &&
					(m as MessageLike).customType === "subagent_boundary",
			),
			"oversized boundary should have been dropped",
		);

		// Next turn: pi reloads the conversation. The boundary is gone, the
		// child has done some real work. Handler must now be a no-op (Phase 3).
		const turn2: MessageLike[] = [
			userMsg("child task"),
			userMsg("child reply 1"),
			userMsg("child reply 2"),
			userMsg("child reply 3"),
		];
		const phase3Result = applyByteBudgetTrim(turn2, 80_000, 50_000);
		assert.equal(
			phase3Result,
			undefined,
			"with no boundary, handler must defer to pi-core — Phase 3",
		);

		// And pi-core's compaction is now free to fire when the child's own
		// usage crosses the threshold:
		const phase3Threshold = 80_000 - settings.reserveTokens;
		const acrossThreshold = makeUsage(phase3Threshold + 1);
		assert.ok(
			shouldCompact(
				calculateContextTokens(acrossThreshold),
				80_000,
				settings,
			),
			"Phase 3: pi-core compaction must fire when child usage exceeds threshold",
		);
	});

	it("regression: handler never overrides pi-core's compaction decision via state mutation", () => {
		// Sanity: applyByteBudgetTrim must not mutate the input messages array.
		// Pi-agent-core relies on transformContext returning a new array; if
		// the handler mutated event.messages it could corrupt downstream state.
		const original: MessageLike[] = [
			userMsg("a"),
			userMsg("b"),
			BOUNDARY,
			userMsg("c"),
		];
		const snapshot = JSON.stringify(original);
		applyByteBudgetTrim(original, childContextWindow, 10_000);
		assert.equal(
			JSON.stringify(original),
			snapshot,
			"handler must not mutate the input messages array",
		);
	});
});
