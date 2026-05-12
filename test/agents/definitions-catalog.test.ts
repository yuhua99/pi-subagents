import {
	assert,
	mkdirSync,
	writeFileSync,
	join,
	afterEach,
	describe,
	it,
	subagentsExtension,
	getAmbientCatalogEntriesForTest,
	getEffectiveAgentDefinitionsForTest,
	getExtensionLaunchArgsForTest,
	getSubagentCatalogSignatureForTest,
	loadAgentDefaults,
	resetSubagentStateForTest,
	resolveDenyToolsForTest,
	resolveEffectiveSessionModeForTest,
	resolveSubagentExtensionsForTest,
	resolveTaskSessionModeForTest,
	createTestDir,
} from "../support/index.ts";

describe("agent definitions and catalog", () => {
	afterEach(() => {
		resetSubagentStateForTest();
	});

	it("reads extensions from extensions frontmatter", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "tester.md"),
			`---\nname: tester\nextensions: ./extensions/caveman.ts, npm:@foo/bar, https://example.com/ext.ts\n---\n\nYou are the tester.`,
		);
		process.env.PI_CODING_AGENT_DIR = configDir;

		const defs = loadAgentDefaults("tester");
		assert.equal(
			defs?.extensions,
			"./extensions/caveman.ts, npm:@foo/bar, https://example.com/ext.ts",
		);
		assert.deepEqual(resolveSubagentExtensionsForTest(defs), [
			join(configDir, "extensions", "caveman.ts"),
			"npm:@foo/bar",
			"https://example.com/ext.ts",
		]);
		assert.deepEqual(
			getExtensionLaunchArgsForTest(
				resolveSubagentExtensionsForTest(defs),
				"/tmp/subagent-done.ts",
			),
			[
				"--no-extensions",
				"-e",
				"/tmp/subagent-done.ts",
				"-e",
				join(configDir, "extensions", "caveman.ts"),
				"-e",
				"npm:@foo/bar",
				"-e",
				"https://example.com/ext.ts",
			],
		);
	});

	it("allows extensions none to launch child with only mandatory internal extension", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "tester.md"),
			`---\nname: tester\nextensions: none\nskills: research, exa\n---\n\nYou are the tester.`,
		);
		process.env.PI_CODING_AGENT_DIR = configDir;

		const defs = loadAgentDefaults("tester");
		assert.equal(defs?.extensions, "none");
		assert.deepEqual(resolveSubagentExtensionsForTest(defs), []);
		assert.deepEqual(
			getExtensionLaunchArgsForTest(
				resolveSubagentExtensionsForTest(defs),
				"/tmp/subagent-done.ts",
			),
			["--no-extensions", "-e", "/tmp/subagent-done.ts"],
		);
	});

	it("reads skills from skills frontmatter only", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "tester.md"),
			`---\nname: tester\nskill: debugger\nskills: pua\n---\n\nYou are the tester.`,
		);
		process.env.PI_CODING_AGENT_DIR = configDir;

		const defs = loadAgentDefaults("tester");
		assert.equal(defs?.skills, "pua");
	});

	it("parses session-mode frontmatter and lets fork override it per launch", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = configDir;

		writeFileSync(
			join(agentsDir, "tester.md"),
			`---\nname: tester\nsession-mode: lineage-only\n---\n\nYou are the tester.`,
		);

		const defs = loadAgentDefaults("tester");
		assert.equal(defs?.sessionMode, "lineage-only");
		assert.equal(
			resolveEffectiveSessionModeForTest({ agent: "tester" }, defs),
			"lineage-only",
		);
		assert.equal(
			resolveEffectiveSessionModeForTest({ agent: "tester", fork: true }, defs),
			"lineage-only",
		);
		assert.equal(resolveTaskSessionModeForTest(defs), "lineage-only");

		writeFileSync(
			join(agentsDir, "compat.md"),
			`---\nname: compat\nfork: true\n---\n\nCompatibility body.`,
		);
		const compat = loadAgentDefaults("compat");
		assert.equal(compat?.sessionMode, "fork");
		assert.equal(
			resolveEffectiveSessionModeForTest({ agent: "default" }, null),
			"lineage-only",
		);
		assert.equal(resolveTaskSessionModeForTest(null), "lineage-only");
		assert.equal(
			resolveTaskSessionModeForTest({
				sessionMode: "lineage-only",
				noSession: true,
			}),
			"fork",
		);
	});

	it("skips disabled agents and falls back to the next available definition", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		const projectAgentsDir = join(dir, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		mkdirSync(projectAgentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "tester.md"),
			`---\nname: tester\ndescription: Global tester\nmode: background\n---\n\nYou are the global tester.`,
		);
		writeFileSync(
			join(projectAgentsDir, "tester.md"),
			`---\nname: tester\nenabled: false\ndescription: Disabled local tester\nmode: interactive\n---\n\nYou are the disabled local tester.`,
		);
		process.env.PI_CODING_AGENT_DIR = configDir;

		const defs = loadAgentDefaults("tester", null, dir);
		assert.equal(defs?.mode, "background");
		assert.equal(defs?.cwdBase, configDir);
	});

	it("discovers project-scoped agents only from .pi/agents in cwd", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		mkdirSync(join(configDir, "agents"), { recursive: true });
		process.env.PI_CODING_AGENT_DIR = configDir;
		const ignoredProjectConfigAgentsDir = join(dir, ".pi", "agent", "agents");
		const projectAgentsDir = join(dir, ".pi", "agents");
		mkdirSync(ignoredProjectConfigAgentsDir, { recursive: true });
		mkdirSync(projectAgentsDir, { recursive: true });
		writeFileSync(
			join(ignoredProjectConfigAgentsDir, "ignored.md"),
			`---\nname: ignored\ndescription: Wrong project config path\nmode: background\n---\n\nYou are ignored.`,
		);
		writeFileSync(
			join(projectAgentsDir, "local.md"),
			`---\nname: local\ndescription: Project local\nmode: background\n---\n\nYou are local.`,
		);

		const defs = getEffectiveAgentDefinitionsForTest(dir);
		assert.deepEqual(
			defs.map((entry) => entry.name),
			["local"],
		);
		assert.equal(defs[0].source, "project");
		assert.equal(defs[0].cwdBase, dir);
	});

	it("resolves the effective agent set deterministically after overrides", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		const projectAgentsDir = join(dir, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		mkdirSync(projectAgentsDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = configDir;

		writeFileSync(
			join(agentsDir, "zeta.md"),
			`---\nname: zeta\ndescription: Global zeta\nmode: background\n---\n\nYou are zeta.`,
		);
		writeFileSync(
			join(agentsDir, "alpha.md"),
			`---\nname: alpha\ndescription: Global alpha\nmode: background\n---\n\nYou are alpha.`,
		);
		writeFileSync(
			join(projectAgentsDir, "middle.md"),
			`---\nname: middle\ndescription: Project middle\nmode: interactive\n---\n\nYou are middle.`,
		);
		writeFileSync(
			join(projectAgentsDir, "zeta.md"),
			`---\nname: zeta\ndescription: Project zeta\nmode: interactive\n---\n\nYou are project zeta.`,
		);

		const defs = getEffectiveAgentDefinitionsForTest(dir);
		assert.deepEqual(
			defs.map((entry) => entry.name),
			["alpha", "middle", "zeta"],
		);
		assert.deepEqual(
			defs.map((entry) => entry.source),
			["global", "project", "project"],
		);
		assert.equal(defs.at(-1)?.description, "Project zeta");
		assert.equal(defs.at(-1)?.mode, "interactive");
	});

	it("uses descriptions for ambient catalog eligibility", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		const projectAgentsDir = join(dir, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		mkdirSync(projectAgentsDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = configDir;

		writeFileSync(
			join(agentsDir, "global-agent.md"),
			`---\nname: global-agent\ndescription: Use the global route\nmode: background\nsession-mode: fork\n---\n\nGlobal body.`,
		);
		writeFileSync(
			join(agentsDir, "description-only.md"),
			`---\nname: description-only\ndescription: Fallback description\nmode: interactive\nsession-mode: lineage-only\n---\n\nDescription body.`,
		);
		writeFileSync(
			join(agentsDir, "disabled.md"),
			`---\nname: disabled\nenabled: false\ndescription: Should never appear\n---\n\nDisabled body.`,
		);
		writeFileSync(
			join(projectAgentsDir, "project-agent.md"),
			`---\nname: project-agent\ndescription: Project description\nmode: interactive\n---\n\nProject body.`,
		);
		writeFileSync(
			join(projectAgentsDir, "hidden-agent.md"),
			`---\nname: hidden-agent\nmode: background\n---\n\nHidden body.`,
		);
		writeFileSync(
			join(projectAgentsDir, "lenient-enabled.md"),
			`---\nname: lenient-enabled\nenabled: maybe\ndescription: Lenient enabled fallback\n---\n\nLenient body.`,
		);

		const defs = getEffectiveAgentDefinitionsForTest(dir);
		assert.equal(
			defs.find((entry) => entry.name === "project-agent")?.description,
			"Project description",
		);
		assert.equal(
			defs.find((entry) => entry.name === "global-agent")?.description,
			"Use the global route",
		);
		assert.equal(
			defs.some((entry) => entry.name === "disabled"),
			false,
		);
		assert.equal(
			defs.some((entry) => entry.name === "lenient-enabled"),
			true,
		);

		const ambient = getAmbientCatalogEntriesForTest(dir);
		assert.deepEqual(
			ambient.map((entry) => entry.name),
			["description-only", "global-agent", "lenient-enabled", "project-agent"],
		);
		assert.equal(
			ambient.find((entry) => entry.name === "project-agent")?.description,
			"Project description",
		);
		assert.equal(
			ambient.find((entry) => entry.name === "description-only")?.description,
			"Fallback description",
		);
		assert.equal(
			ambient.find((entry) => entry.name === "description-only")?.sessionMode,
			"lineage-only",
		);
		assert.equal(
			ambient.find((entry) => entry.name === "global-agent")?.sessionMode,
			"fork",
		);
		assert.equal(
			ambient.find((entry) => entry.name === "project-agent")?.sessionMode,
			"lineage-only",
		);
		assert.equal(
			ambient.some((entry) => entry.name === "hidden-agent"),
			false,
		);
	});

	it("defaults spawning to false for named agent definitions", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = configDir;

		writeFileSync(
			join(agentsDir, "worker.md"),
			`---\nname: worker\ndescription: Do focused work\n---\n\nWorker body.`,
		);
		writeFileSync(
			join(agentsDir, "coordinator.md"),
			`---\nname: coordinator\ndescription: Coordinate work\nspawning: true\n---\n\nCoordinator body.`,
		);

		const defs = getEffectiveAgentDefinitionsForTest(dir);
		const worker = defs.find((entry) => entry.name === "worker");
		const coordinator = defs.find((entry) => entry.name === "coordinator");
		assert.equal(worker?.spawning, false);
		assert.equal(coordinator?.spawning, true);
		assert.deepEqual([...resolveDenyToolsForTest(worker ?? null)].sort(), [
			"subagent",
			"subagent_resume",
			"subagents_list",
		]);
		assert.deepEqual([...resolveDenyToolsForTest(coordinator ?? null)], []);
	});

	it("keeps catalog signatures stable until the effective ambient catalog changes", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = configDir;

		writeFileSync(
			join(agentsDir, "reviewer.md"),
			`---\nname: reviewer\ndescription: Review changes for regressions\nmode: background\n---\n\nReviewer body.`,
		);

		const first = getAmbientCatalogEntriesForTest(dir);
		const second = getAmbientCatalogEntriesForTest(dir);
		assert.equal(
			getSubagentCatalogSignatureForTest(first),
			getSubagentCatalogSignatureForTest(second),
		);

		writeFileSync(
			join(agentsDir, "reviewer.md"),
			`---\nname: reviewer\ndescription: Review critical changes for regressions\nmode: background\n---\n\nReviewer body.`,
		);

		const changed = getAmbientCatalogEntriesForTest(dir);
		assert.notEqual(
			getSubagentCatalogSignatureForTest(first),
			getSubagentCatalogSignatureForTest(changed),
		);
	});

	it("lists descriptions and sparse launchable agents in subagents_list when ambient awareness is disabled", async () => {
		const dir = createTestDir();
		const prevCwd = process.cwd();
		const prevKillSwitch = process.env.PI_SUBAGENT_DISABLE_AMBIENT_AWARENESS;
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		const projectAgentsDir = join(dir, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		mkdirSync(projectAgentsDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = configDir;
		process.env.PI_SUBAGENT_DISABLE_AMBIENT_AWARENESS = "1";

		writeFileSync(
			join(agentsDir, "global-reviewer.md"),
			`---\nname: global-reviewer\ndescription: Review changes\nmode: background\n---\n\nReviewer body.`,
		);
		writeFileSync(
			join(projectAgentsDir, "sparse-agent.md"),
			`---\nname: sparse-agent\nmode: interactive\n---\n\nSparse body.`,
		);
		writeFileSync(
			join(projectAgentsDir, "disabled-agent.md"),
			`---\nname: disabled-agent\nenabled: false\ndescription: hidden\n---\n\nDisabled body.`,
		);

		const tools = new Map<string, any>();
		try {
			process.chdir(dir);
			subagentsExtension({
				on() {},
				registerCommand() {},
				registerMessageRenderer() {},
				sendMessage() {},
				registerTool(definition: any) {
					tools.set(definition.name, definition);
					return definition;
				},
			} as any);

			const listTool = tools.get("subagents_list");
			assert.ok(listTool);
			const result = await listTool.execute();
			const listed = result.details.agents;
			assert.deepEqual(
				listed.map((entry: any) => entry.name),
				getEffectiveAgentDefinitionsForTest(dir).map((entry) => entry.name),
			);
			assert.equal(
				listed.some((entry: any) => entry.name === "disabled-agent"),
				false,
			);
			assert.equal(
				listed.some((entry: any) => entry.name === "sparse-agent"),
				true,
			);
			assert.equal(
				listed.find((entry: any) => entry.name === "global-reviewer")
					?.description,
				"Review changes",
			);
			assert.match(
				result.content[0].text,
				/global-reviewer \[isolated context\] — Review changes/,
			);
			assert.doesNotMatch(
				result.content[0].text,
				/\(background\)|\[.*claude.*\]|\[.*glm.*\]|\| use:/i,
			);
			assert.match(result.content[0].text, /sparse-agent/);
		} finally {
			process.chdir(prevCwd);
			if (prevKillSwitch == null)
				delete process.env.PI_SUBAGENT_DISABLE_AMBIENT_AWARENESS;
			else process.env.PI_SUBAGENT_DISABLE_AMBIENT_AWARENESS = prevKillSwitch;
		}
	});

	it("registers conservative delegation guidance on the subagent tool", () => {
		const tools = new Map<string, any>();

		subagentsExtension({
			on() {},
			registerCommand() {},
			registerMessageRenderer() {},
			sendMessage() {},
			registerTool(definition: any) {
				tools.set(definition.name, definition);
				return definition;
			},
		} as any);

		const tool = tools.get("subagent");
		assert.ok(tool);
		assert.match(tool.description, /specialist or parallelizable work/);
		assert.match(
			tool.promptSnippet,
			/Use subagents for specialist, complex, or parallelizable work/,
		);
		assert.match(
			tool.promptSnippet,
			/Agent frontmatter is authoritative for all runtime settings/,
		);
		assert.match(tool.promptSnippet, /CRITICAL multi-agent rule/);
		assert.match(tool.promptSnippet, /call subagent once with children/);
		assert.match(tool.promptSnippet, /Do not emit separate subagent tool calls/);
		assert.match(
			tool.promptSnippet,
			/Use exact catalog names in each child agent field/,
		);
		assert.match(tool.promptSnippet, /include each named agent exactly once/);
		assert.match(
			tool.promptSnippet,
			/do not reuse one agent as a substitute for another/,
		);
		assert.match(
			tool.promptSnippet,
			/call-time duplicates for named agents are ignored/,
		);
		assert.match(
			tool.promptSnippet,
			/translate the user's request into each child task/,
		);
		assert.match(
			tool.promptSnippet,
			/do not change the work based on the agent name/,
		);
		assert.match(
			tool.promptSnippet,
			/Use the catalog\/list memory label only to decide context/,
		);
		assert.match(tool.promptSnippet, /isolated context starts a fresh chat/);
		assert.match(
			tool.promptSnippet,
			/write a self-contained task with objective, relevant facts\/files, constraints, and expected output/,
		);
		assert.match(
			tool.promptSnippet,
			/forked context continues this conversation on a new branch/,
		);
		assert.match(
			tool.promptSnippet,
			/Handle trivial single-file reads, quick direct answers, and tiny one-shot edits yourself instead of delegating/,
		);
		assert.match(tool.promptSnippet, /Delegation ownership rule/);
		assert.match(
			tool.promptSnippet,
			/explicitly non-overlapping parent-owned work/,
		);
		assert.match(
			tool.promptSnippet,
			/end the response and let async results arrive by steer/,
		);
		assert.match(
			tool.promptSnippet,
			/Async launches request a graceful stop after the current tool batch/,
		);
		assert.match(
			tool.promptSnippet,
			/PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN=1 disables only that runtime stop/,
		);
		assert.doesNotMatch(
			tool.promptSnippet,
			/Coordinator-only turn stop is disabled/,
		);
	});

	it("registers opt-out delegation guidance when coordinator-only turn stop is disabled", () => {
		process.env.PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN = "1";
		const tools = new Map<string, any>();

		subagentsExtension({
			on() {},
			registerCommand() {},
			registerMessageRenderer() {},
			sendMessage() {},
			registerTool(definition: any) {
				tools.set(definition.name, definition);
				return definition;
			},
		} as any);

		const tool = tools.get("subagent");
		assert.ok(tool);
		assert.match(
			tool.promptSnippet,
			/Coordinator-only turn stop is disabled by PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN=1/,
		);
		assert.match(
			tool.promptSnippet,
			/you may continue only with explicitly non-overlapping parent-owned work/,
		);
		assert.match(tool.promptSnippet, /Do not redo delegated work/);
		assert.doesNotMatch(
			tool.promptSnippet,
			/Async launches request a graceful stop after the current tool batch/,
		);
	});

});
