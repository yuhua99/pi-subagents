#!/usr/bin/env node
/**
 * Orchestrator for all frontmatter live tests.
 *
 * Runs each test script sequentially and reports results.
 * Passes through env vars like PI_SUBAGENT_LIVE_MODEL and
 * PI_SUBAGENT_KEEP_E2E_TMP.
 *
 * Usage:
 *   node scripts/run-frontmatter-tests.mjs
 *
 * To run only specific tests:
 *   TESTS=cwd,flags node scripts/run-frontmatter-tests.mjs
 */

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const ALL_TESTS = [
  { file: "test-frontmatter-cwd.mjs", label: "cwd" },
  { file: "test-frontmatter-model-thinking.mjs", label: "model+thinking" },
  { file: "test-frontmatter-enabled.mjs", label: "enabled: false" },
  { file: "test-frontmatter-flags.mjs", label: "flags" },
  { file: "test-frontmatter-spawning-true.mjs", label: "spawning: true" },
  { file: "test-frontmatter-spawning-false.mjs", label: "spawning: false" },
  { file: "test-frontmatter-session-mode.mjs", label: "session-mode" },
  { file: "test-frontmatter-auto-exit-no-session.mjs", label: "auto-exit + no-session" },
  { file: "test-frontmatter-parent-close-policy.mjs", label: "parent-close-policy" },
  { file: "test-frontmatter-mode-interactive.mjs", label: "mode: interactive (tmux)" },
];

const filterEnv = (process.env.TESTS ?? "").trim();
const filterSet = filterEnv ? new Set(filterEnv.split(",").map(s => s.trim())) : null;

const testsToRun = filterSet
  ? ALL_TESTS.filter(t => filterSet.has(t.label.split(" ")[0]))
  : ALL_TESTS;

const results = { passed: 0, failed: 0, skipped: 0 };
const failures = [];

console.log(`\n=== Frontmatter live test suite ===`);
console.log(`Model: ${process.env.PI_SUBAGENT_LIVE_MODEL ?? "default"}`);
console.log(`Tests: ${testsToRun.length} (${ALL_TESTS.length} total)\n`);

for (const test of testsToRun) {
  const scriptPath = resolve(__dirname, test.file);
  process.stdout.write(`  [RUN]    ${test.label}... `);

  try {
    execFileSync("node", [scriptPath], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
      timeout: 300_000, // 5 min per test
    });
    results.passed++;
    process.stdout.write("PASS\n");
  } catch (err) {
    const output = err.stdout || "";
    const stderr = err.stderr || "";
    const isSkipped = output.includes("Skipping") || stderr.includes("Skipping");
    
    if (isSkipped) {
      results.skipped++;
      process.stdout.write("SKIP\n");
      console.log(`    ${output.split("\n").filter(l => l.trim()).slice(-3).join("\n    ")}`);
    } else {
      results.failed++;
      process.stdout.write("FAIL\n");
      
      const lastLines = [...(output || "").split("\n"), ...(stderr || "").split("\n")]
        .filter(l => l.trim())
        .slice(-10)
        .join("\n    ");
      console.error(`    ${err.message?.split("\n").slice(-3).join("\n    ")}`);
      if (lastLines) console.error(`    Last output:\n    ${lastLines}`);
      
      failures.push({ label: test.label, output, stderr, error: err.message });
    }
  }
}

// Summary
console.log(`\n=== Results ===`);
console.log(`  Passed:  ${results.passed}`);
console.log(`  Failed:  ${results.failed}`);
console.log(`  Skipped: ${results.skipped}`);

if (failures.length > 0) {
  console.log(`\n=== Failures ===`);
  for (const f of failures) {
    console.log(`  ${f.label}: ${f.error}`);
  }
  process.exit(1);
}
