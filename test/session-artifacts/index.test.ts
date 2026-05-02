import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

import sessionArtifactsExtension from "../../src/session-artifacts/index.ts";
import { getProjectArtifactsDir, getSessionArtifactDir } from "../../src/shared/artifacts.ts";

async function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void> | void) {
  const original = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    original.set(key, process.env[key]);
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  const finish = () => {
    for (const [key, value] of original) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  };

  try {
    await fn();
  } finally {
    finish();
  }
}

function registerTools() {
  const tools = new Map<string, any>();
  sessionArtifactsExtension({
    registerTool(definition: { name: string }) {
      tools.set(definition.name, definition);
    },
  } as any);
  return tools;
}

describe("session-artifacts direct module tests", () => {
  it("hides write_artifact in the top-level session", async () => {
    await withEnv(
      {
        PI_SUBAGENT_NAME: undefined,
        PI_SUBAGENT_AGENT: undefined,
        PI_DENY_TOOLS: undefined,
      },
      () => {
        const tools = registerTools();
        assert.equal(tools.has("write_artifact"), false);
        assert.equal(tools.has("read_artifact"), true);
      },
    );
  });

  it("keeps write_artifact available for spawned subagents and root can read the result", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "pi-subagents-artifacts-"));
    const cwd = join(projectRoot, "src");
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    mkdirSync(cwd, { recursive: true });

    const sessionId = `session-${Date.now()}`;
    const nextSessionId = `${sessionId}-next`;
    const projectArtifactsDir = getProjectArtifactsDir(cwd);

    try {
      await withEnv(
        {
          PI_SUBAGENT_NAME: "Child Writer",
          PI_SUBAGENT_AGENT: "artifact-writer",
          PI_DENY_TOOLS: undefined,
        },
        async () => {
          const tools = registerTools();
          const writeArtifact = tools.get("write_artifact");
          const readArtifact = tools.get("read_artifact");

          assert.ok(writeArtifact);
          assert.ok(readArtifact);

          await writeArtifact.execute(
            "tool-1",
            { name: "notes/direct.md", content: "direct coverage" },
            undefined,
            undefined,
            { cwd, sessionManager: { getSessionId: () => sessionId } },
          );
        },
      );

      assert.equal(
        readFileSync(join(getSessionArtifactDir(cwd, sessionId), "notes", "direct.md"), "utf8"),
        "direct coverage",
      );

      await withEnv(
        {
          PI_SUBAGENT_NAME: undefined,
          PI_SUBAGENT_AGENT: undefined,
          PI_DENY_TOOLS: undefined,
        },
        async () => {
          const tools = registerTools();
          const readArtifact = tools.get("read_artifact");

          assert.ok(readArtifact);
          assert.equal(tools.has("write_artifact"), false);

          const readResult = await readArtifact.execute(
            "tool-2",
            { name: "notes/direct.md" },
            undefined,
            undefined,
            { cwd, sessionManager: { getSessionId: () => nextSessionId } },
          );
          assert.equal(readResult.details.content, "direct coverage");
          assert.equal(readResult.isError, undefined);
        },
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(projectArtifactsDir, { recursive: true, force: true });
    }
  });

  it("writes under the configured artifact storage root without changing the project name", async () => {
    const storageRoot = mkdtempSync(join(tmpdir(), "pi-subagents-artifact-root-"));
    const projectRoot = mkdtempSync(join(tmpdir(), "pi-subagents-project-"));
    const cwd = join(projectRoot, "src");
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    mkdirSync(cwd, { recursive: true });

    const sessionId = `session-${Date.now()}`;
    const projectArtifactsDir = join(storageRoot, basename(projectRoot), "artifacts");

    try {
      await withEnv(
        {
          PI_ARTIFACT_PROJECT_ROOT: storageRoot,
          PI_SUBAGENT_NAME: "Child Writer",
          PI_SUBAGENT_AGENT: "artifact-writer",
          PI_DENY_TOOLS: undefined,
        },
        async () => {
          const tools = registerTools();
          const writeArtifact = tools.get("write_artifact");
          assert.ok(writeArtifact);

          await writeArtifact.execute(
            "tool-3",
            { name: "notes/custom-root.md", content: "custom root coverage" },
            undefined,
            undefined,
            { cwd, sessionManager: { getSessionId: () => sessionId } },
          );
        },
      );

      assert.equal(
        readFileSync(join(projectArtifactsDir, sessionId, "notes", "custom-root.md"), "utf8"),
        "custom root coverage",
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(storageRoot, { recursive: true, force: true });
    }
  });
});
