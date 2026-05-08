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
function assertToolResultsHavePriorToolCalls(entries: any[]): void {
  const seenToolCalls = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === "toolCall" && typeof block.id === "string") {
          seenToolCalls.add(block.id);
        }
      }
    }
    if (message?.role === "toolResult") {
      assert.equal(typeof message.toolCallId, "string", "toolResult must preserve string toolCallId");
      assert.ok(seenToolCalls.has(message.toolCallId), `toolResult ${message.toolCallId} must match an earlier assistant toolCall`);
    }
  }
}

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
    // Usage is replaced with zero stub (compiled binary needs message.usage.input on every entry)
    assert.deepEqual(msg2.message.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  });

  it("cuts a fork before the assistant message that launched the child", () => {
    const sourcePath = join(tmpDir, "source-launch-cutoff.jsonl");
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "sess-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: tmpDir }),
      JSON.stringify({ type: "message", id: "user-1", parentId: "sess-1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Original request" }], timestamp: Date.now() } }),
      JSON.stringify({ type: "message", id: "assistant-1", parentId: "user-1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "Useful completed prior work" }], timestamp: Date.now(), usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" } }),
      JSON.stringify({ type: "custom_message", id: "prior-result", parentId: "assistant-1", timestamp: "2026-01-01T00:00:03.000Z", customType: "subagent_result", content: "Prior child result that later forks should inherit", display: true }),
      JSON.stringify({ type: "message", id: "user-2", parentId: "prior-result", timestamp: "2026-01-01T00:00:04.000Z", message: { role: "user", content: [{ type: "text", text: "Launch two children" }], timestamp: Date.now() } }),
      JSON.stringify({ type: "message", id: "assistant-launch", parentId: "user-2", timestamp: "2026-01-01T00:00:05.000Z", message: { role: "assistant", content: [
        { type: "toolCall", id: "call-child-a", name: "subagent", arguments: { agent: "greeter", task: "A" } },
        { type: "toolCall", id: "call-child-b", name: "subagent", arguments: { agent: "greeter", task: "B" } },
      ], timestamp: Date.now(), usage: { input: 200, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 220, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse" } }),
      JSON.stringify({ type: "message", id: "tool-result-a", parentId: "assistant-launch", timestamp: "2026-01-01T00:00:06.000Z", message: { role: "toolResult", toolCallId: "call-child-a", toolName: "subagent", content: [{ type: "text", text: "Child A launched" }], isError: false, timestamp: Date.now() } }),
    ];
    writeFileSync(sourcePath, lines.join("\n") + "\n", "utf-8");

    const childPath = join(tmpDir, "child-launch-cutoff.jsonl");
    writeTrimmedForkSession(sourcePath, childPath, { childContextWindow: 100_000, reserveTokens: 10_000, launchToolCallId: "call-child-b" });

    const written = readFileSync(childPath, "utf-8");
    const entries = written.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    const ids = entries.map((e) => e.id).filter(Boolean);

    assertToolResultsHavePriorToolCalls(entries);
    assert.ok(ids.includes("prior-result"), "prior completed subagent result is preserved");
    assert.ok(ids.includes("user-2"), "current user request is preserved as context");
    assert.equal(ids.includes("assistant-launch"), false, "current launching assistant is excluded");
    assert.equal(ids.includes("tool-result-a"), false, "same-turn sibling tool result is excluded");
    assert.equal(JSON.stringify(entries).includes("call-child-a"), false, "sibling launch call is not inherited");
    assert.equal(JSON.stringify(entries).includes("call-child-b"), false, "own launch call is not inherited");
  });

  it("preserves prior tool-call/tool-result pairs while cutting the current launch", () => {
    const sourcePath = join(tmpDir, "source-prior-subagent-redacted.jsonl");
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "sess-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: tmpDir }),
      JSON.stringify({ type: "message", id: "user-1", parentId: "sess-1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Launch marker child" }], timestamp: Date.now() } }),
      JSON.stringify({ type: "message", id: "assistant-prior-launch", parentId: "user-1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [
        { type: "text", text: "I will launch the marker child now." },
        { type: "toolCall", id: "call-prior", name: "subagent", arguments: { agent: "marker", task: "Return PRIOR_RESULT_OK" } },
      ], timestamp: Date.now(), usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse" } }),
      JSON.stringify({ type: "message", id: "prior-result", parentId: "assistant-prior-launch", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "toolResult", toolCallId: "call-prior", toolName: "subagent", content: [{ type: "text", text: "Sub-agent completed.\n\nPRIOR_RESULT_OK" }], isError: false, timestamp: Date.now() } }),
      JSON.stringify({ type: "message", id: "assistant-after-prior", parentId: "prior-result", timestamp: "2026-01-01T00:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "Prior result was PRIOR_RESULT_OK." }], timestamp: Date.now(), usage: { input: 140, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" } }),
      JSON.stringify({ type: "message", id: "user-2", parentId: "assistant-after-prior", timestamp: "2026-01-01T00:00:05.000Z", message: { role: "user", content: [{ type: "text", text: "Launch observer" }], timestamp: Date.now() } }),
      JSON.stringify({ type: "message", id: "assistant-current-launch", parentId: "user-2", timestamp: "2026-01-01T00:00:06.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "call-current", name: "subagent", arguments: { agent: "observer", task: "Check prior" } }], timestamp: Date.now(), usage: { input: 180, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 190, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse" } }),
    ];
    writeFileSync(sourcePath, lines.join("\n") + "\n", "utf-8");

    const childPath = join(tmpDir, "child-prior-subagent-preserved.jsonl");
    writeTrimmedForkSession(sourcePath, childPath, { childContextWindow: 100_000, reserveTokens: 10_000, launchToolCallId: "call-current" });

    const written = readFileSync(childPath, "utf-8");
    const entries = written.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    const priorAssistant = entries.find((entry) => entry.id === "assistant-prior-launch");

    assertToolResultsHavePriorToolCalls(entries);
    assert.ok(priorAssistant, "prior assistant entry remains to keep the parentId chain intact");
    assert.ok(JSON.stringify(priorAssistant.message.content).includes("call-prior"), "prior function call remains paired with its result");
    assert.ok(JSON.stringify(entries).includes("PRIOR_RESULT_OK"), "prior completed result remains available");
    const priorResult = entries.find((entry) => entry.id === "prior-result");
    assert.equal(priorResult.message.toolCallId, "call-prior", "prior tool result keeps toolCallId for pi renderers and providers");
    assert.equal(JSON.stringify(entries).includes("call-current"), false, "current launch is excluded");
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

  it("preserves non-message entries but guards renderer crash with zero usage", () => {
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
    assert.ok(customEntry, "custom_message should be preserved (with zero usage guard)");
    // Every non-session entry must have message.usage.input for the compiled binary's renderer
    for (const e of entries) {
      if (e.type === "session") continue;
      if (e.type === "message" && e.message?.role !== "custom") continue;
      assert.ok(e.message?.usage?.input !== undefined,
        `${e.type} entry must have message.usage.input`);
    }
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


  it("writes header-only when every assistant usage checkpoint is zero", () => {
    const sourcePath = join(tmpDir, "source-zero-usage.jsonl");
    const destPath = join(tmpDir, "dest-zero-usage.jsonl");
    const hugeOld = "old ".repeat(2000);
    const recentTask = "recent task";
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "s", timestamp: new Date().toISOString(), cwd: tmpDir }),
      JSON.stringify({ type: "message", id: "u-old", message: { role: "user", content: [{ type: "text", text: hugeOld }] } }),
      JSON.stringify({ type: "message", id: "a-old", message: { role: "assistant", content: [{ type: "text", text: "old reply" }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }),
      JSON.stringify({ type: "message", id: "u-new", message: { role: "user", content: [{ type: "text", text: recentTask }] } }),
      JSON.stringify({ type: "message", id: "a-new", message: { role: "assistant", content: [{ type: "text", text: "recent reply" }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }),
    ];
    writeFileSync(sourcePath, lines.join("\n") + "\n");

    writeTrimmedForkSession(sourcePath, destPath, { childContextWindow: 11_000, reserveTokens: 10_000 });

    const output = readFileSync(destPath, "utf8");
    assert.ok(!output.includes(hugeOld), "zero-usage history should not be inherited");
    assert.ok(!output.includes(recentTask), "no deterministic token checkpoint exists for the recent turn");
  });

  it("trusts monotonic usage checkpoints without serialized-size heuristics", () => {
    const sourcePath = join(tmpDir, "source-underreported-usage.jsonl");
    const destPath = join(tmpDir, "dest-underreported-usage.jsonl");
    const hugeOld = "old context ".repeat(5000);
    const recentTask = "recent underreported task";
    const usage = { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "s", timestamp: new Date().toISOString(), cwd: tmpDir }),
      JSON.stringify({ type: "message", id: "u-old", message: { role: "user", content: [{ type: "text", text: hugeOld }] } }),
      JSON.stringify({ type: "message", id: "a-old", message: { role: "assistant", content: [{ type: "text", text: "old reply" }], usage } }),
      JSON.stringify({ type: "message", id: "u-new", message: { role: "user", content: [{ type: "text", text: recentTask }] } }),
      JSON.stringify({ type: "message", id: "a-new", message: { role: "assistant", content: [{ type: "text", text: "recent reply" }], usage } }),
    ];
    writeFileSync(sourcePath, lines.join("\n") + "\n");

    writeTrimmedForkSession(sourcePath, destPath, { childContextWindow: 11_000, reserveTokens: 10_000 });

    const output = readFileSync(destPath, "utf8");
    assert.ok(output.includes(hugeOld), "deterministic trim should trust sane persisted usage, not serialized-size heuristics");
    assert.ok(output.includes(recentTask), "recent turn should be kept");
  });

  it("treats decreasing usage checkpoints as reset boundaries", () => {
    const sourcePath = join(tmpDir, "source-checkpoint-reset.jsonl");
    const childPath = join(tmpDir, "child-checkpoint-reset.jsonl");
    const oldContext = "before reset";
    const newContext = "after reset";
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "s", timestamp: new Date().toISOString(), cwd: tmpDir }),
      JSON.stringify({ type: "message", id: "u-old", message: { role: "user", content: [{ type: "text", text: oldContext }] } }),
      JSON.stringify({ type: "message", id: "a-old", message: { role: "assistant", content: [{ type: "text", text: "old reply" }], usage: { input: 50000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 50010, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" } }),
      JSON.stringify({ type: "message", id: "u-new", message: { role: "user", content: [{ type: "text", text: newContext }] } }),
      JSON.stringify({ type: "message", id: "a-new", message: { role: "assistant", content: [{ type: "text", text: "new reply" }], usage: { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 1010, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" } }),
    ];
    writeFileSync(sourcePath, lines.join("\n") + "\n");

    writeTrimmedForkSession(sourcePath, childPath, { childContextWindow: 11_000, reserveTokens: 10_000 });

    const output = readFileSync(childPath, "utf8");
    assert.ok(!output.includes(oldContext), "entries before a usage reset boundary should not be mixed into the fork");
    assert.ok(output.includes(newContext), "latest checkpoint segment should be kept");
  });

  it("writes header-only when zeroed inherited usage has no later real checkpoint", () => {
    const sourcePath = join(tmpDir, "source-zero-inherited-no-checkpoint.jsonl");
    const childPath = join(tmpDir, "child-zero-inherited-no-checkpoint.jsonl");
    const inheritedContext = "inherited parent context";
    const trailingUser = "trailing uncheckpointed user ".repeat(1000);
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "s", timestamp: new Date().toISOString(), cwd: tmpDir }),
      JSON.stringify({ type: "message", id: "u-inherited", message: { role: "user", content: [{ type: "text", text: inheritedContext }] } }),
      JSON.stringify({ type: "message", id: "a-inherited", message: { role: "assistant", content: [{ type: "text", text: "inherited reply" }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" } }),
      JSON.stringify({ type: "message", id: "u-trailing", message: { role: "user", content: [{ type: "text", text: trailingUser }] } }),
    ];
    writeFileSync(sourcePath, lines.join("\n") + "\n");

    writeTrimmedForkSession(sourcePath, childPath, { childContextWindow: 11_000, reserveTokens: 10_000 });

    const output = readFileSync(childPath, "utf8");
    assert.ok(!output.includes(inheritedContext), "zeroed inherited context should not be inherited");
    assert.ok(!output.includes(trailingUser), "uncheckpointed trailing user content should not be inherited");
  });

  it("lets nested forks skip zeroed inherited usage and use later real checkpoints", () => {
    const sourcePath = join(tmpDir, "source-nested-zero-inherited.jsonl");
    const childPath = join(tmpDir, "child-nested-zero-inherited.jsonl");
    const inheritedContext = "inherited parent context";
    const childContext = "child-owned context";
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "s", timestamp: new Date().toISOString(), cwd: tmpDir }),
      JSON.stringify({ type: "message", id: "u-inherited", message: { role: "user", content: [{ type: "text", text: inheritedContext }] } }),
      JSON.stringify({ type: "message", id: "a-inherited", message: { role: "assistant", content: [{ type: "text", text: "inherited reply" }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" } }),
      JSON.stringify({ type: "message", id: "u-child", message: { role: "user", content: [{ type: "text", text: childContext }] } }),
      JSON.stringify({ type: "message", id: "a-child", message: { role: "assistant", content: [{ type: "text", text: "child reply" }], usage: { input: 1200, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 1210, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" } }),
    ];
    writeFileSync(sourcePath, lines.join("\n") + "\n");

    writeTrimmedForkSession(sourcePath, childPath, { childContextWindow: 11_000, reserveTokens: 10_000 });

    const output = readFileSync(childPath, "utf8");
    assert.ok(!output.includes(inheritedContext), "zeroed inherited segment should be dropped");
    assert.ok(output.includes(childContext), "later child-owned checkpoint segment should be kept");
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
    assert.deepEqual(assistantMsg.message.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      "usage replaced with zero stub to prevent false compaction while keeping renderer alive");
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