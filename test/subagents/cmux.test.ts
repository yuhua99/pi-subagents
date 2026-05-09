import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createSurface, createSurfaceSplit } from "../../src/subagents/mux.ts";

const ORIGINAL_ENV = {
  PATH: process.env.PATH,
  PI_SUBAGENT_MUX: process.env.PI_SUBAGENT_MUX,
  CMUX_SOCKET_PATH: process.env.CMUX_SOCKET_PATH,
};

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

function installFakeCmux(): { dir: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-subagents-cmux-test-"));
  const log = join(dir, "cmux.log");
  const bin = join(dir, "cmux");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const log = process.env.FAKE_CMUX_LOG;
const args = process.argv.slice(2);
if (log) fs.appendFileSync(log, JSON.stringify(args) + "\\n");
const cmd = args[0];
if (cmd === "new-split") {
  console.log("OK surface:101 workspace:1");
} else if (cmd === "new-surface") {
  console.log("OK surface:102 pane:9 workspace:1");
} else if (cmd === "rename-tab") {
  console.log("OK rename-tab");
} else if (cmd === "identify") {
  console.log(JSON.stringify({ caller: { pane_ref: "pane:9" } }));
} else if (cmd === "tree") {
  console.log("workspace:1\\n  pane:9");
} else {
  console.error("unexpected cmux command", args.join(" "));
  process.exit(2);
}
`,
  );
  chmodSync(bin, 0o755);
  process.env.PATH = `${dir}:${ORIGINAL_ENV.PATH ?? ""}`;
  process.env.PI_SUBAGENT_MUX = "cmux";
  process.env.CMUX_SOCKET_PATH = join(dir, "cmux.sock");
  process.env.FAKE_CMUX_LOG = log;
  return { dir, log };
}

function readLog(log: string): string[][] {
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("cmux surface creation", () => {
  it("focuses new cmux splits so terminal-backed read-screen works", () => {
    const { dir, log } = installFakeCmux();
    try {
      assert.equal(createSurfaceSplit("Focused Split", "right"), "surface:101");
      const calls = readLog(log);
      assert.ok(
        calls.some((args) =>
          args[0] === "new-split" &&
          args.includes("right") &&
          args.includes("--focus") &&
          args.includes("true"),
        ),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates separate focused cmux splits for separate interactive subagents", () => {
    const { dir, log } = installFakeCmux();
    try {
      assert.equal(createSurface("First"), "surface:101");
      assert.equal(createSurface("Second"), "surface:101");
      const calls = readLog(log);
      const splitCalls = calls.filter((args) => args[0] === "new-split");
      assert.equal(splitCalls.length, 2);
      assert.ok(
        splitCalls.every((args) =>
          args.includes("right") &&
          args.includes("--focus") &&
          args.includes("true"),
        ),
      );
      assert.equal(calls.some((args) => args[0] === "new-surface"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
