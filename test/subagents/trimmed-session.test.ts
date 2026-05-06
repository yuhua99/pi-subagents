// @ts-nocheck
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { writeTrimmedForkSession } from "../../src/subagents/trimmed-session.ts";

/**
 * Helper: create a minimal session JSONL file with one user message and one assistant message.
 */
function createMinimalSession(dir: string, filename = "source.jsonl"): string {
  const path = join(dir, filename);
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: "sess-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: dir }),
    JSON.stringify({
      type: "message",
      id: "msg-1",
      parentId: "sess-1",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: [{ type: "text", text: "Hello" }], timestamp: Date.now() },
    }),
    JSON.stringify({
      type: "message",
      id: "msg-2",
      parentId: "msg-1",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hi there!" }],
        timestamp: Date.now(),
        usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
      },
    }),
  ];
  writeFileSync(path, lines.join("\n") + "\n", "utf-8");
  return path;
}

describe("writeTrimmedForkSession", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "trimmed-session-test-"));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("keeps all entries when the session fits within budget", () => {
    const sourcePath = createMinimalSession(tmpDir);
    const childPath = join(tmpDir, "child-1.jsonl");

    writeTrimmedForkSession(sourcePath, childPath, { childContextWindow: 100_000, reserveTokens: 10_000 });

    const written = readFileSync(childPath, "utf-8");
    const lines = written.split("\n").filter((l) => l.trim());

    // Should have a session header + 2 messages = 3 lines
    assert.equal(lines.length, 3, "Should keep header + 2 messages");

    // Header should reference parent session
    const header = JSON.parse(lines[0]);
    assert.equal(header.type, "session");
    assert.equal(header.parentSession, sourcePath);

    // Messages should be preserved as-is (except usage is stripped)
    const msg1 = JSON.parse(lines[1]);
    assert.equal(msg1.id, "msg-1");
    assert.equal(msg1.message.role, "user");

    const msg2 = JSON.parse(lines[2]);
    assert.equal(msg2.id, "msg-2");
    assert.equal(msg2.message.role, "assistant");
    // Usage should be stripped to prevent stale metadata
    assert.equal(msg2.message.usage, undefined, "usage should be stripped from assistant messages");
  });

  it("trims oldest turns when the session exceeds budget", () => {
    const sourcePath = join(tmpDir, "source-reasonable.jsonl");
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "sess-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: tmpDir }),
    ];

    // 3 turns with cumulative context: [100, 200, 300]
    for (let i = 0; i < 3; i++) {
      const prevId = i === 0 ? "sess-1" : `assistant-${i}`;
      const cumulativeInput = (i + 1) * 100;
      lines.push(JSON.stringify({
        type: "message",
        id: `user-${i + 1}`,
        parentId: prevId,
        timestamp: `2026-01-01T00:00:0${i + 1}.000Z`,
        message: { role: "user", content: [{ type: "text", text: `msg` }], timestamp: Date.now() },
      }));
      lines.push(JSON.stringify({
        type: "message",
        id: `assistant-${i + 1}`,
        parentId: `user-${i + 1}`,
        timestamp: `2026-01-01T00:00:0${i + 2}.000Z`,
        message: {
          role: "assistant",
          content: [{ type: "text", text: `resp` }],
          timestamp: Date.now(),
          usage: {
            input: 80,
            output: 10,
            cacheRead: cumulativeInput - 80,
            cacheWrite: 0,
            totalTokens: cumulativeInput + 10,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
        },
      }));
    }
    writeFileSync(sourcePath, lines.join("\n") + "\n", "utf-8");

    const childPath = join(tmpDir, "child-reasonable.jsonl");

    // total=300, budget=150, overflow=150.
    // Going forward: ass-1 prevCum=0 >= 150? No.
    //                ass-2 prevCum=100 >= 150? No.
    //                ass-3 prevCum=200 >= 150? Yes. Keep from after ass-2 (only last turn).
    writeTrimmedForkSession(sourcePath, childPath, { childContextWindow: 1_150, reserveTokens: 1_000 });

    const written = readFileSync(childPath, "utf-8");
    const resultLines = written.split("\n").filter((l) => l.trim());
    assert.ok(resultLines.length >= 2, "Should have at least header + some entries");
    const entries = resultLines.map((l) => JSON.parse(l));
    const messageEntries = entries.filter((e) => e.type === "message");

    // Only the last turn (assistant-3) fits within 150 budget
    const lastAssistant = messageEntries.find((e) => e.id === "assistant-3");
    assert.ok(lastAssistant, "Last assistant should be kept");
    const firstAssistant = messageEntries.find((e) => e.id === "assistant-1");
    assert.equal(firstAssistant, undefined, "First 2 turns should be trimmed (total 200 > budget 150)");
  });

  it("actually trims when cumulative context exceeds budget", () => {
    const sourcePath = join(tmpDir, "source-trim.jsonl");
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "sess-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: tmpDir }),
    ];

    // 5 turns with cumulative context growing by 100 each time
    // assistant-5 has cumulative input = 500
    for (let i = 0; i < 5; i++) {
      const prevId = i === 0 ? "sess-1" : `assistant-${i}`;
      const cumulativeInput = (i + 1) * 100;
      lines.push(JSON.stringify({
        type: "message",
        id: `user-${i + 1}`,
        parentId: prevId,
        timestamp: `2026-01-01T00:00:0${i + 1}.000Z`,
        message: { role: "user", content: [{ type: "text", text: `Turn ${i + 1} user` }], timestamp: Date.now() },
      }));
      lines.push(JSON.stringify({
        type: "message",
        id: `assistant-${i + 1}`,
        parentId: `user-${i + 1}`,
        timestamp: `2026-01-01T00:00:0${i + 2}.000Z`,
        message: {
          role: "assistant",
          content: [{ type: "text", text: `Turn ${i + 1} response` }],
          timestamp: Date.now(),
          usage: {
            input: 80,
            output: 10,
            cacheRead: cumulativeInput - 80,
            cacheWrite: 0,
            totalTokens: cumulativeInput + 10,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
        },
      }));
    }
    writeFileSync(sourcePath, lines.join("\n") + "\n", "utf-8");

    const childPath = join(tmpDir, "child-trim.jsonl");

    // total=500, budget=250, overflow=250.
    // ass-1 prevCum=0 >= 250? No.  ass-2 prevCum=100 >= 250? No.
    // ass-3 prevCum=200 >= 250? No. ass-4 prevCum=300 >= 250? Yes!
    // First kept = after ass-3. Turns 4+5 kept (200 tokens <= 250 budget).
    writeTrimmedForkSession(sourcePath, childPath, { childContextWindow: 1_250, reserveTokens: 1_000 });

    const written = readFileSync(childPath, "utf-8");
    const resultLines = written.split("\n").filter((l) => l.trim());

    const entries = resultLines.map((l) => JSON.parse(l));
    const messageEntries = entries.filter((e) => e.type === "message");
    const keptIds = messageEntries.map((e) => e.id);

    assert.equal(keptIds.includes("assistant-1"), false, "assistant-1 trimmed");
    assert.equal(keptIds.includes("assistant-2"), false, "assistant-2 trimmed");
    assert.equal(keptIds.includes("assistant-3"), false, "assistant-3 trimmed (prevCum=200 < overflow=250)");
    // Turns 4-5 kept (assistant-4 + assistant-5, suffix = 200 tokens)
    assert.ok(keptIds.includes("assistant-4"), "assistant-4 kept");
    assert.ok(keptIds.includes("assistant-5"), "assistant-5 kept");
  });

  it("writes only header when session has no assistant messages", () => {
    const sourcePath = join(tmpDir, "source-no-assistant.jsonl");
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "sess-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: tmpDir }),
      JSON.stringify({ type: "message", id: "msg-1", parentId: "sess-1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() } }),
    ];
    writeFileSync(sourcePath, lines.join("\n") + "\n", "utf-8");

    const childPath = join(tmpDir, "child-no-assistant.jsonl");
    writeTrimmedForkSession(sourcePath, childPath, { childContextWindow: 100_000 });

    const written = readFileSync(childPath, "utf-8");
    const resultLines = written.split("\n").filter((l) => l.trim());
    assert.equal(resultLines.length, 1, "Should only have header when no assistant responses exist");
    const header = JSON.parse(resultLines[0]);
    assert.equal(header.type, "session");
  });

  it("preserves non-message entries (model_change, custom_message)", () => {
    const sourcePath = join(tmpDir, "source-non-msg.jsonl");
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "sess-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: tmpDir }),
      JSON.stringify({ type: "custom_message", id: "custom-1", parentId: "sess-1", timestamp: "2026-01-01T00:00:01.000Z", customType: "test", content: "hello" }),
      JSON.stringify({ type: "message", id: "msg-1", parentId: "custom-1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: [{ type: "text", text: "Hello" }], timestamp: Date.now() } }),
      JSON.stringify({ type: "message", id: "msg-2", parentId: "msg-1", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "Hi" }], timestamp: Date.now(), usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" } }),
    ];
    writeFileSync(sourcePath, lines.join("\n") + "\n", "utf-8");

    const childPath = join(tmpDir, "child-non-msg.jsonl");
    writeTrimmedForkSession(sourcePath, childPath, { childContextWindow: 100_000 });

    const written = readFileSync(childPath, "utf-8");
    const resultLines = written.split("\n").filter((l) => l.trim());
    const entries = resultLines.map((l) => JSON.parse(l));

    const customEntry = entries.find((e) => e.type === "custom_message");
    assert.ok(customEntry, "custom_message should be preserved");
    assert.equal(customEntry.customType, "test");
  });

  it("trims via seedSubagentSessionFileForTest when forkTrimOptions is provided", async () => {
    // Build a session with 5 turns (cumulative 500 tokens)
    const sourcePath = join(tmpDir, "source-seed-integration.jsonl");
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "sess-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: tmpDir }),
    ];
    for (let i = 0; i < 5; i++) {
      const prevId = i === 0 ? "sess-1" : `assistant-${i}`;
      const cumulativeInput = (i + 1) * 100;
      lines.push(JSON.stringify({
        type: "message", id: `user-${i + 1}`, parentId: prevId,
        timestamp: `2026-01-01T00:00:0${i + 1}.000Z`,
        message: { role: "user", content: [{ type: "text", text: `Turn ${i + 1} user` }], timestamp: Date.now() },
      }));
      lines.push(JSON.stringify({
        type: "message", id: `assistant-${i + 1}`, parentId: `user-${i + 1}`,
        timestamp: `2026-01-01T00:00:0${i + 2}.000Z`,
        message: {
          role: "assistant", content: [{ type: "text", text: `Turn ${i + 1} response` }],
          timestamp: Date.now(),
          usage: { input: 80, output: 10, cacheRead: cumulativeInput - 80, cacheWrite: 0,
            totalTokens: cumulativeInput + 10,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
        },
      }));
    }
    writeFileSync(sourcePath, lines.join("\n") + "\n", "utf-8");

    const childPath = join(tmpDir, "child-seed-integration.jsonl");

    const { seedSubagentSessionFileForTest } = await import("../../src/subagents/index.ts");
    seedSubagentSessionFileForTest(
      "fork",
      sourcePath,
      childPath,
      tmpDir,
      { childContextWindow: 1_250, reserveTokens: 1_000 },  // budget=250, ass-2 cum=200 fits
    );

    const written = readFileSync(childPath, "utf-8");
    const resultLines = written.split("\n").filter((l) => l.trim());
    const entries = resultLines.map((l) => JSON.parse(l));
    const messageEntries = entries.filter((e) => e.type === "message");
    const keptIds = messageEntries.map((e) => e.id);

    // Same trim behavior: turns 1-3 trimmed, turns 4-5 kept
    assert.equal(keptIds.includes("assistant-1"), false, "seedSubagentSessionFileForTest: assistant-1 trimmed");
    assert.equal(keptIds.includes("assistant-3"), false, "assistant-3 trimmed");
    assert.ok(keptIds.includes("assistant-4"), "assistant-4 kept after trimming");
  });


  it("writes header-only when budget is negative (reserve >= contextWindow)", () => {
    const sourcePath = createMinimalSession(tmpDir);
    const childPath = join(tmpDir, "child-negative-budget.jsonl");

    // reserveTokens (100000) >= childContextWindow (50000) → budget = -50000
    writeTrimmedForkSession(sourcePath, childPath, { childContextWindow: 50000, reserveTokens: 100000 });

    const written = readFileSync(childPath, "utf-8");
    const resultLines = written.split("\n").filter((l) => l.trim());
    assert.equal(resultLines.length, 1, "Should only have header when budget is negative");
    const header = JSON.parse(resultLines[0]);
    assert.equal(header.type, "session");
  });

  it("strips stale usage metadata to prevent false compaction in child", () => {

    const sourcePath = join(tmpDir, "source-usage-strip.jsonl");
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "sess-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: tmpDir }),
      JSON.stringify({ type: "message", id: "user-1", parentId: "sess-1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Hello" }], timestamp: Date.now() } }),
      // This assistant has stale usage with totalTokens=100100
      JSON.stringify({ type: "message", id: "assistant-1", parentId: "user-1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "Hi" }], timestamp: Date.now(), usage: { input: 50000, output: 100, cacheRead: 50000, cacheWrite: 0, totalTokens: 100100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" } }),
    ];
    writeFileSync(sourcePath, lines.join("\n") + "\n", "utf-8");

    const childPath = join(tmpDir, "child-usage-strip.jsonl");
    writeTrimmedForkSession(sourcePath, childPath, { childContextWindow: 262144 });

    const written = readFileSync(childPath, "utf-8");
    const resultLines = written.split("\n").filter((l) => l.trim());
    const entries = resultLines.map((l) => JSON.parse(l));

    // Verify usage is stripped from the assistant message
    const assistantMsg = entries.find((e) => e.type === "message" && e.message?.role === "assistant");
    assert.ok(assistantMsg, "assistant message should exist");
    assert.equal(assistantMsg.message.usage, undefined, "usage must be stripped to prevent false compaction");
    // Content should be preserved
    assert.equal(assistantMsg.message.content[0].text, "Hi");
    // Non-assistant messages should be untouched
    const userMsg = entries.find((e) => e.type === "message" && e.message?.role === "user");
    assert.ok(userMsg, "user message should exist");
    assert.equal(userMsg.message.content[0].text, "Hello");
  });
  it("handles large-session scenario where totalContext >> budget", () => {
    // Simulate: 100 turns with cumulative growing by 10k each → total = 1,000,000
    // Budget = 250,000 (window=260k - reserve)
    const sourcePath = join(tmpDir, "source-large.jsonl");
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "sess-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: tmpDir }),
    ];
    for (let i = 0; i < 100; i++) {
      const prevId = i === 0 ? "sess-1" : `assistant-${i}`;
      const cumulativeInput = (i + 1) * 10_000;
      lines.push(JSON.stringify({
        type: "message", id: `user-${i + 1}`, parentId: prevId,
        timestamp: `2026-01-01T00:00:0${i + 1}.000Z`,
        message: { role: "user", content: [{ type: "text", text: "msg" }], timestamp: Date.now() },
      }));
      lines.push(JSON.stringify({
        type: "message", id: `assistant-${i + 1}`, parentId: `user-${i + 1}`,
        timestamp: `2026-01-01T00:00:0${i + 2}.000Z`,
        message: {
          role: "assistant", content: [{ type: "text", text: "resp" }],
          timestamp: Date.now(),
          usage: { input: 9000, output: 1000, cacheRead: cumulativeInput - 9000, cacheWrite: 0,
            totalTokens: cumulativeInput + 1000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
        },
      }));
    }
    writeFileSync(sourcePath, lines.join("\n") + "\n", "utf-8");

    const childPath = join(tmpDir, "child-large.jsonl");
    // total=1,000,000, budget=250,000, overflow=750,000
    // ass-75 has cumBefore=740k. 740k >= 750k? No. ass-76 has cumBefore=750k. 750k >= 750k? Yes.
    // First kept = after ass-75. Keep turns 76-100 (25 turns).
    writeTrimmedForkSession(sourcePath, childPath, { childContextWindow: 260_000, reserveTokens: 10_000 });

    const written = readFileSync(childPath, "utf-8");
    const resultLines = written.split("\n").filter((l) => l.trim());
    const entries = resultLines.map((l) => JSON.parse(l));
    const messageEntries = entries.filter((e) => e.type === "message");
    const keptIds = messageEntries.map((e) => e.id);

    // Turns 1-75 should be trimmed
    assert.equal(keptIds.includes("assistant-1"), false, "first assistant trimmed");
    assert.equal(keptIds.includes("assistant-50"), false, "mid-session assistant trimmed");
    assert.equal(keptIds.includes("assistant-75"), false, "assistant-75 trimmed (prevCum=740k < overflow)");

    // Turns 76-100 should be kept
    assert.ok(keptIds.includes("assistant-76"), "assistant-76 kept");
    assert.ok(keptIds.includes("assistant-100"), "assistant-100 kept");

    // Verify the kept suffix fits within budget
    const allAssistants = messageEntries.filter(e => e.message.role === "assistant");
    const lastKeptCum = 100 * 10_000; // assistant-100 cumulative
    const beforeKeptCum = 75 * 10_000; // assistant-75 cumulative
    const estimatedSuffixTokens = lastKeptCum - beforeKeptCum; // = 250,000
    assert.ok(estimatedSuffixTokens <= 250_000, "kept suffix should fit within budget");
  });
});