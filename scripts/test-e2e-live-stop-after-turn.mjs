#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { LIVE_TEST_MODEL } from "./live-test-guard.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const extensionSource = join(repoRoot, "src", "index.ts");
const tmpRoot = join(tmpdir(), `pi-subagents-live-stop-after-turn-${process.pid}`);
const configDir = join(tmpRoot, "agent");
const workDir = join(tmpRoot, "work");
const agentsDir = join(workDir, ".pi", "agents");
const singleSessionDir = join(tmpRoot, "single-sessions");
const mixedSessionDir = join(tmpRoot, "mixed-sessions");
const envConfigDir = process.env.PI_CODING_AGENT_DIR;
const sourceConfigDir = envConfigDir && existsSync(join(envConfigDir, "auth.json"))
  ? envConfigDir
  : join(homedir(), ".pi", "agent");
const keepTmp = process.env.PI_SUBAGENT_KEEP_E2E_TMP === "1";

mkdirSync(configDir, { recursive: true });
mkdirSync(agentsDir, { recursive: true });
mkdirSync(singleSessionDir, { recursive: true });
mkdirSync(mixedSessionDir, { recursive: true });
for (const name of ["auth.json", "settings.json", "models.json", "mcp.json"]) {
  const source = join(sourceConfigDir, name);
  if (existsSync(source)) copyFileSync(source, join(configDir, name));
}

writeFileSync(
  join(agentsDir, "live-stop-bg.md"),
  `---\nname: live-stop-bg\ndescription: Async child for stop-after-turn live regression.\nthinking: off\nauto-exit: true\nmode: background\nblocking: false\n---\n\nReply exactly: LIVE_STOP_BG_OK`,
  "utf8",
);
writeFileSync(
  join(agentsDir, "live-stop-sync.md"),
  `---\nname: live-stop-sync\ndescription: Sync child for mixed stop-after-turn live regression.\nthinking: off\nauto-exit: true\nmode: background\nblocking: true\n---\n\nReply exactly: LIVE_STOP_SYNC_OK`,
  "utf8",
);

function listJsonlFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsonlFiles(fullPath));
      continue;
    }
    if (entry.isFile() && fullPath.endsWith(".jsonl")) files.push(fullPath);
  }
  return files;
}

function parseJsonl(file) {
  const events = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
  return events;
}

function getUserText(events) {
  return events
    .filter((event) => event.type === "message" && event.message?.role === "user")
    .flatMap((event) => event.message.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function getAssistantTexts(events) {
  return events
    .filter((event) => event.type === "message" && event.message?.role === "assistant")
    .flatMap((event) => event.message.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text.trim());
}

function getToolResults(events, toolName) {
  return events
    .filter(
      (event) =>
        event.type === "message" &&
        event.message?.role === "toolResult" &&
        event.message.toolName === toolName,
    )
    .map((event) => event.message);
}

function findParentSession(sessionDir, marker) {
  for (const file of listJsonlFiles(sessionDir)) {
    const events = parseJsonl(file);
    if (getUserText(events).includes(marker)) return { file, events };
  }
  throw new Error(`Could not find parent session for ${marker}.`);
}

function runPi(sessionDir, prompt) {
  execFileSync(
    "tia",
    [
      "pi",
      "-p",
      "--model",
      LIVE_TEST_MODEL,
      "--no-extensions",
      "-e",
      extensionSource,
      "--session-dir",
      sessionDir,
      prompt,
    ],
    {
      cwd: workDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PI_PACKAGE_DIR: "",
        PI_CODING_AGENT_DIR: configDir,
        PI_SUBAGENT_DISABLE_AMBIENT_AWARENESS: "1",
        PI_SUBAGENT_AGENT: "",
        PI_SUBAGENT_NAME: "",
        PI_SUBAGENT_AUTO_EXIT: "",
        PI_DENY_TOOLS: "",
        PI_ARTIFACT_PROJECT_ROOT: "",
      },
    },
  );
}

function assertNoContinuation(events, forbiddenText) {
  const texts = getAssistantTexts(events).join("\n");
  if (texts.includes(forbiddenText)) {
    throw new Error(`Parent continued unexpectedly with ${forbiddenText}.`);
  }
}

try {
  const singleMarker = "LIVE_STOP_SINGLE_MARKER";
  runPi(
    singleSessionDir,
    [
      singleMarker,
      'First write exactly: "I’ll wait for the async child result unless you want me to work on something else while we wait."',
      'Then call subagent with name "live-stop-bg", agent "live-stop-bg", title "Live stop async check", task "Run the async stop-after-turn check.", parentClosePolicy "terminate", and async true.',
      "Do not call any other tools. If the runtime continues after the tool result, write BAD_CONTINUED_SINGLE.",
    ].join("\n"),
  );

  const single = findParentSession(singleSessionDir, singleMarker);
  const singleResults = getToolResults(single.events, "subagent");
  if (singleResults.length !== 1) throw new Error(`Expected one async subagent result, got ${singleResults.length}.`);
  if (singleResults[0].details?.status !== "started") {
    throw new Error(`Expected async subagent status started, got ${singleResults[0].details?.status ?? "missing"}.`);
  }
  if (singleResults[0].details?.async !== true) {
    throw new Error("Expected async subagent result to report async true.");
  }
  assertNoContinuation(single.events, "BAD_CONTINUED_SINGLE");

  const mixedMarker = "LIVE_STOP_MIXED_MARKER";
  runPi(
    mixedSessionDir,
    [
      mixedMarker,
      "In one assistant response, call subagent twice and do not call any other tools.",
      'Call subagent with name "live-stop-bg", agent "live-stop-bg", title "Live mixed async check", task "Run the mixed async stop-after-turn check.", parentClosePolicy "terminate", and async true.',
      'Call subagent with name "live-stop-sync", agent "live-stop-sync", title "Live mixed sync check", task "Run the mixed sync stop-after-turn check.", parentClosePolicy "terminate", and async false.',
      "If the runtime continues after the tool results, write BAD_CONTINUED_MIXED.",
    ].join("\n"),
  );

  const mixed = findParentSession(mixedSessionDir, mixedMarker);
  const mixedResults = getToolResults(mixed.events, "subagent");
  if (mixedResults.length !== 2) throw new Error(`Expected two mixed subagent results, got ${mixedResults.length}.`);
  if (!mixedResults.some((result) => result.details?.status === "started" && result.details?.async === true)) {
    throw new Error("Mixed run did not include a started async subagent result.");
  }
  if (!mixedResults.some((result) => result.details?.status === "completed" && result.details?.async === false)) {
    throw new Error("Mixed run did not include a completed sync subagent result.");
  }
  assertNoContinuation(mixed.events, "BAD_CONTINUED_MIXED");

  console.log(`live stop-after-turn ok: async and mixed batches stopped parent continuation (${LIVE_TEST_MODEL})`);
} finally {
  if (!keepTmp) {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  }
}
