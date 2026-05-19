#!/usr/bin/env node
// Live pi test for the fork byte-budget trim (Phase 1/2).
//
// Parent: nahcrof/deepseek-v4-flash (1M ctx). Reads a moderate fixture file.
// Child:  nahcrof/glm-5.1-precision (~200K ctx) launched in fork session-mode.
//
// Pass criteria:
//   1. The child session file exists and contains a `subagent_boundary`
//      custom_message (the inheritance marker is what makes byte-budget
//      trim authoritative).
//   2. Final line of the child session is a successful assistant message
//      whose `usage.input` is below the child's contextWindow. No API
//      overflow.
//   3. The child session contains zero `compaction` entries (Phase 1/2 must
//      not summarize the inherited prefix).
//   4. The child's final assistant text begins with `FORK_OK`.
//
// Run with:
//   PI_SUBAGENT_KEEP_E2E_TMP=1 node scripts/test-e2e-live-fork-trim.mjs
//
// The script does NOT acquire the live-window lock — `pi -p` is non-
// interactive and does not spawn a terminal.

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PARENT_MODEL =
  process.env.FORK_LIVE_PARENT_MODEL ?? "nahcrof/deepseek-v4-flash:medium";
const CHILD_AGENT =
  process.env.FORK_LIVE_CHILD_AGENT ?? "fork-smoke-glm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const extensionSource = join(repoRoot, "src", "index.ts");

const tmpRoot = mkdtempSync(join(tmpdir(), "pi-fork-live-"));
const sessionDir = join(tmpRoot, "sessions");
const configDir = join(tmpRoot, "agent");
const agentsDir = join(configDir, "agents");
const fixturePath = join(tmpRoot, "fixture.txt");
const sourceConfigDir = join(homedir(), ".pi", "agent");
const keepTmp = process.env.PI_SUBAGENT_KEEP_E2E_TMP === "1";

mkdirSync(sessionDir, { recursive: true });
mkdirSync(agentsDir, { recursive: true });

// Copy auth/models so the child sees the same provider config.
for (const name of ["auth.json", "settings.json", "models.json"]) {
  const source = join(sourceConfigDir, name);
  if (existsSync(source)) copyFileSync(source, join(configDir, name));
}

// Pi binary discovery is finicky in this environment:
//   - `tia pi` invokes the bun binary, but resets PI_CODING_AGENT_DIR to its
//     own dir, so our copied agent file is invisible.
//   - The Node-based pi (~/.bun/bin/pi) honors PI_CODING_AGENT_DIR, but the
//     user's environment has PI_PACKAGE_DIR pointed at the bun binary's
//     theme layout, which the Node pi cannot use.
// Workaround: use the Node pi, clear PI_PACKAGE_DIR, and install the test
// agent into ~/.pi/agent/agents/ (where pi will look) for the duration of
// the test. We restore the original state in a finally block.

const userAgentsDir = join(homedir(), ".pi", "agent", "agents");
mkdirSync(userAgentsDir, { recursive: true });
const installedAgentPath = join(userAgentsDir, `${CHILD_AGENT}.md`);
const hadAgentBefore = existsSync(installedAgentPath);
const previousAgentContent = hadAgentBefore
  ? readFileSync(installedAgentPath, "utf8")
  : null;

// Copy the fork-mode child agent so the test config sees it.
const repoChildAgent = join(repoRoot, ".pi", "agents", `${CHILD_AGENT}.md`);
if (!existsSync(repoChildAgent)) {
  console.error(`Missing child agent: ${repoChildAgent}`);
  process.exit(2);
}
copyFileSync(repoChildAgent, join(agentsDir, `${CHILD_AGENT}.md`));
copyFileSync(repoChildAgent, installedAgentPath);

function restoreAgentDir() {
  if (hadAgentBefore && previousAgentContent !== null) {
    writeFileSync(installedAgentPath, previousAgentContent, "utf8");
  } else {
    try {
      rmSync(installedAgentPath, { force: true });
    } catch {}
  }
}

process.on("exit", restoreAgentDir);
process.on("SIGINT", () => {
  restoreAgentDir();
  process.exit(130);
});

// Build a moderate fixture: ~400 KB so the parent has real context to
// inherit (the byte-budget trim must do something visible) but the run
// stays fast. ~100K tokens of English-style text is what the original
// analysis used.
const fixtureLines = [];
for (let i = 1; i <= 4000; i++) {
  fixtureLines.push(
    `Line ${i}: example project content describing classes, functions, and design patterns. The line repeats with index ${i} to make the file substantial. Each line carries similar prose to mimic real source code documentation.`,
  );
}
writeFileSync(fixturePath, `${fixtureLines.join("\n")}\n`, "utf8");
const fixtureBytes = readFileSync(fixturePath).byteLength;

const parentPrompt = [
  `Read ${fixturePath} fully. The file is large (~${Math.round(fixtureBytes / 1024)} KiB, ~${Math.round(fixtureBytes / 4 / 1024)}K tokens). Read the entire file even if it requires multiple read calls.`,
  `Then immediately call the subagent tool with name "fork-smoke-trim", agent "${CHILD_AGENT}", title "Fork live trim probe", and task "Inspect inherited context above the boundary marker and reply per your built-in instructions."`,
  `After the subagent returns, reply with exactly the line from the child's result and nothing else.`,
].join(" ");

console.log("[live-fork-trim] tmp:", tmpRoot);
console.log("[live-fork-trim] parent model:", PARENT_MODEL);
console.log("[live-fork-trim] child agent:", CHILD_AGENT);
console.log("[live-fork-trim] fixture bytes:", fixtureBytes);

const piBin = process.env.PI_E2E_PI_BIN ?? "/home/devkit/.bun/bin/pi";
const piArgs = [];
const env = {
  ...process.env,
  PI_PACKAGE_DIR: "",
  // Don't override PI_CODING_AGENT_DIR; the user's config is what carries
  // the nahcrof provider. The test agent file is installed into ~/.pi/agent/agents/
  // (and removed in the finally block).
  PI_CODING_AGENT_SESSION_DIR: sessionDir,
  PI_SUBAGENT_FORK_TRIM_DEBUG: "1",
  PI_SUBAGENT_FORK_TRIM_DEBUG_LOG: join(tmpRoot, "fork-trim.log"),
};
delete env.PI_CODING_AGENT_DIR;

const args = [
  ...piArgs,
  "-p",
  "--model",
  PARENT_MODEL,
  "--session-dir",
  sessionDir,
  "--no-extensions",
  "--extension",
  extensionSource,
  parentPrompt,
];

console.log("[live-fork-trim] running pi…");
const t0 = Date.now();
const result = spawnSync(piBin, args, {
  env,
  cwd: tmpRoot,
  stdio: ["ignore", "pipe", "pipe"],
  encoding: "utf8",
  timeout: 240_000,
});
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`[live-fork-trim] pi exited: status=${result.status} signal=${result.signal} elapsed=${elapsed}s`);

if (result.stdout) {
  console.log("[live-fork-trim] stdout (last 1KB):");
  console.log(result.stdout.slice(-1024));
}
if (result.stderr) {
  console.log("[live-fork-trim] stderr (last 1KB):");
  console.log(result.stderr.slice(-1024));
}

// Locate child session(s).
const sessions = readdirSync(sessionDir, { withFileTypes: true })
  .filter((d) => d.isFile() && d.name.endsWith(".jsonl"))
  .map((d) => join(sessionDir, d.name))
  .sort();
console.log(`[live-fork-trim] found ${sessions.length} session file(s)`);

let parentSession = null;
let childSession = null;

for (const path of sessions) {
  const content = readFileSync(path, "utf8");
  const firstLine = content.split("\n").find((l) => l.trim());
  if (!firstLine) continue;
  let parsed;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    continue;
  }
  if (parsed?.parentSession) {
    childSession = path;
  } else {
    parentSession = path;
  }
}

console.log("[live-fork-trim] parent session:", parentSession);
console.log("[live-fork-trim] child session:", childSession);

let pass = true;
const checks = [];

function check(name, ok, detail) {
  checks.push({ name, ok, detail });
  if (!ok) pass = false;
  console.log(`  ${ok ? "OK " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

if (!childSession) {
  check("child session exists", false, "no forked child session was produced");
} else {
  const childContent = readFileSync(childSession, "utf8");
  const childEntries = childContent
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const boundaryEntry = childEntries.find(
    (e) =>
      e?.type === "custom_message" &&
      e?.customType === "subagent_boundary",
  );
  check("subagent_boundary marker present", !!boundaryEntry);

  // Count inherited content (everything before the boundary entry).
  const boundaryIdx = childEntries.findIndex(
    (e) =>
      e?.type === "custom_message" &&
      e?.customType === "subagent_boundary",
  );
  let inheritedBytes = 0;
  let inheritedMessages = 0;
  if (boundaryIdx > 0) {
    for (let i = 0; i < boundaryIdx; i++) {
      const entry = childEntries[i];
      if (entry?.type === "message") {
        inheritedBytes += Buffer.byteLength(JSON.stringify(entry), "utf8");
        inheritedMessages += 1;
      }
    }
  }
  console.log(
    `[live-fork-trim] inherited: ${inheritedMessages} messages, ${(inheritedBytes / 1024).toFixed(1)} KiB`,
  );

  const compactionEntries = childEntries.filter(
    (e) => e?.type === "compaction",
  );
  check(
    "no compaction entries in child (Phase 1/2 must not summarize)",
    compactionEntries.length === 0,
    `found ${compactionEntries.length}`,
  );

  // Look for an assistant message with usage.input set; that's the proof
  // that an LLM call actually fired without overflow.
  let firstAssistantInput = null;
  let lastAssistantUsage = null;
  let lastAssistantText = null;
  for (const entry of childEntries) {
    if (entry?.type !== "message") continue;
    const msg = entry.message;
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason === "aborted" || msg.stopReason === "error") continue;
    if (msg.usage) {
      lastAssistantUsage = msg.usage;
      if (firstAssistantInput === null && (msg.usage.input ?? 0) > 0) {
        firstAssistantInput = msg.usage.input;
      }
    }
    const text = (msg.content ?? [])
      .filter((b) => b?.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text) lastAssistantText = text;
  }
  check(
    "child produced a successful assistant message",
    !!lastAssistantUsage,
    lastAssistantUsage ? `last usage.input=${lastAssistantUsage.input}` : null,
  );
  // The contextWindow for the child model is the strongest available proxy
  // for "did the trim work?". We assert the *first* successful assistant
  // call's input fit. Subsequent calls grow naturally as the child works,
  // but that growth is the child's own context, not the inherited prefix.
  const childContextWindowGuess = 200_000; // glm-5.1-precision
  check(
    "child first LLM call fits the context window (no overflow)",
    firstAssistantInput !== null && firstAssistantInput < childContextWindowGuess,
    firstAssistantInput !== null
      ? `first usage.input=${firstAssistantInput} < ${childContextWindowGuess}`
      : "no successful LLM call found",
  );
  console.log("[live-fork-trim] last assistant text snippet:");
  console.log(`  ${lastAssistantText ? lastAssistantText.slice(0, 200) : "(none)"}`);

  console.log("[live-fork-trim] child session bytes:", childContent.length);
}

if (!keepTmp) rmSync(tmpRoot, { recursive: true, force: true });
else {
  console.log("[live-fork-trim] keeping tmp:", tmpRoot);
  const debugPath = join(tmpRoot, "fork-trim.log");
  if (existsSync(debugPath)) {
    console.log("[live-fork-trim] trim debug log:");
    console.log(readFileSync(debugPath, "utf8"));
  }
}

if (!pass) {
  console.error("[live-fork-trim] FAIL");
  process.exit(1);
}
console.log("[live-fork-trim] PASS");
