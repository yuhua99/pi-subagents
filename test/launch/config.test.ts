import {
	assert,
	mkdirSync,
	writeFileSync,
	join,
	afterEach,
	describe,
	it,
	buildResumePiArgsForTest,
	buildShellChangeDirectoryPrefixForTest,
	getFlagsLaunchArgs,
	getNoSessionSeedModeForTest,
	getPiInvocationForTest,
	getPiShellPartsForTest,
	getPreparedSessionLaunchArgsForTest,
	getResumeCwdForTest,
	getSubagentChildProcessEnvForTest,
	loadAgentDefaults,
	readSubagentLaunchMetadataForTest,
	resetSubagentStateForTest,
	resolveForkOutputReserveTokensForTest,
	resolveResumeLaunchMetadataForTest,
	resolveSubagentBlockingForTest,
	resolveSubagentNoContextFilesForTest,
	resolveSubagentNoSessionForTest,
	writeSubagentLaunchMetadataEntryForTest,
	getEntries,
	createTestDir,
	createSessionFile,
	getAgentConfigDirForTest,
} from "../support/index.ts";

describe("agent launch configuration", () => {
	afterEach(() => {
		resetSubagentStateForTest();
	});

	it("uses PI_CODING_AGENT_DIR for the global agent config root", () => {
		process.env.PI_CODING_AGENT_DIR = "/tmp/custom-agent-root";
		assert.equal(getAgentConfigDirForTest(), "/tmp/custom-agent-root");
	});

	it("parses getFlagsLaunchArgs from a flags string", () => {
		assert.deepEqual(getFlagsLaunchArgs("--plan"), ["--plan"]);
		assert.deepEqual(getFlagsLaunchArgs("--plan --foo bar"), [
			"--plan",
			"--foo",
			"bar",
		]);
	});

	it("returns empty array for undefined, empty, or whitespace-only flags", () => {
		assert.deepEqual(getFlagsLaunchArgs(undefined), []);
		assert.deepEqual(getFlagsLaunchArgs(""), []);
		assert.deepEqual(getFlagsLaunchArgs("   "), []);
	});

	it("handles quoted flag values via parseCommandWords", () => {
		assert.deepEqual(getFlagsLaunchArgs("--plan 'arg with spaces'"), [
			"--plan",
			"arg with spaces",
		]);
	});

	it("passes flags through getPiInvocation for background children", () => {
		const args = ["-p", "--session", "/tmp/test.jsonl", "--flags-injected"];
		const invocation = getPiInvocationForTest(args);
		assert.ok(
			invocation.args.includes("--flags-injected"),
			"flags should appear in pi invocation args",
		);
	});

	it("shell-escapes flags in getPiShellParts for interactive children", () => {
		const parts = getPiShellPartsForTest([
			"--session",
			"/tmp/s.jsonl",
			"--custom-flag",
		]);
		assert.ok(
			parts.join(" ").includes("--custom-flag"),
			"custom flag should be in shell parts",
		);
	});

	it("preserves the default launcher when no subagent command override is set", () => {
		delete process.env.PI_SUBAGENT_PI_COMMAND;
		delete process.env.PI_PACKAGE_DIR;
		delete process.env.PI_CODING_AGENT_DIR;
		const invocation = getPiInvocationForTest([
			"--session",
			"/tmp/session.jsonl",
		]);
		assert.equal(invocation.command, process.execPath);
		assert.deepEqual(invocation.args.slice(-2), [
			"--session",
			"/tmp/session.jsonl",
		]);
	});

	it("uses PI_SUBAGENT_PI_COMMAND as an opt-in wrapper for child pi launches", () => {
		process.env.PI_SUBAGENT_PI_COMMAND = "wrapper pi";
		assert.deepEqual(
			getPiInvocationForTest(["--session", "/tmp/session.jsonl"]),
			{
				command: "wrapper",
				args: ["pi", "--session", "/tmp/session.jsonl"],
			},
		);
		assert.deepEqual(
			getPiShellPartsForTest(["--session", "/tmp/with space.jsonl"]),
			["'wrapper'", "'pi'", "'--session'", "'/tmp/with space.jsonl'"],
		);
	});

	it("parses quoted PI_SUBAGENT_PI_COMMAND values", () => {
		process.env.PI_SUBAGENT_PI_COMMAND = "'/opt/wrapper bin/pi-wrapper' pi";
		assert.deepEqual(
			getPiInvocationForTest(["--session", "/tmp/session.jsonl"]),
			{
				command: "/opt/wrapper bin/pi-wrapper",
				args: ["pi", "--session", "/tmp/session.jsonl"],
			},
		);
	});

	it("preserves child process environment while applying launch vars", () => {
		process.env.PI_PACKAGE_DIR = "/tmp/pi-package";
		process.env.PI_CODING_AGENT_DIR = "/tmp/pi-agent";
		const env = getSubagentChildProcessEnvForTest(
			{ command: "pi", args: [] },
			{ PI_SUBAGENT_NAME: "x" },
		);
		assert.equal(env.PI_PACKAGE_DIR, "/tmp/pi-package");
		assert.equal(env.PI_CODING_AGENT_DIR, "/tmp/pi-agent");
		assert.equal(env.PI_SUBAGENT_NAME, "x");
	});

	it("lets explicit child config override inherited config", () => {
		process.env.PI_PACKAGE_DIR = "/tmp/pi-package";
		process.env.PI_CODING_AGENT_DIR = "/tmp/pi-agent";
		const env = getSubagentChildProcessEnvForTest(
			{ command: "pi", args: [] },
			{ PI_CODING_AGENT_DIR: "/tmp/project/.pi/agent", PI_SUBAGENT_NAME: "x" },
		);
		assert.equal(env.PI_PACKAGE_DIR, "/tmp/pi-package");
		assert.equal(env.PI_CODING_AGENT_DIR, "/tmp/project/.pi/agent");
		assert.equal(env.PI_SUBAGENT_NAME, "x");
	});

	it("loads global agent defaults from PI_CODING_AGENT_DIR and records cwd base", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "tester.md"),
			`---\nname: tester\nsystem-prompt: append\ncwd: ./roles/tester\nmode: background\nasync: false\n---\n\nYou are the tester.`,
		);
		process.env.PI_CODING_AGENT_DIR = configDir;

		const defs = loadAgentDefaults("tester");
		assert.equal(defs?.systemPromptMode, "append");
		assert.equal(defs?.cwd, "./roles/tester");
		assert.equal(defs?.cwdBase, configDir);
		assert.equal(defs?.mode, "background");
		assert.equal(defs?.async, false);
		assert.equal(resolveSubagentBlockingForTest({}, defs), true);
	});

	it("defaults context-file injection to on and can disable it in agent frontmatter", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = configDir;

		writeFileSync(
			join(agentsDir, "tester.md"),
			`---\nname: tester\nno-context-files: true\n---\n\nYou are the tester.`,
		);

		const defs = loadAgentDefaults("tester");
		assert.equal(defs?.noContextFiles, true);
		assert.equal(resolveSubagentNoContextFilesForTest(defs), true);
		assert.equal(resolveSubagentNoContextFilesForTest(null), false);

		writeFileSync(
			join(agentsDir, "tester.md"),
			`---\nname: tester\n---\n\nYou are the tester.`,
		);

		const defaults = loadAgentDefaults("tester");
		assert.equal(defaults?.noContextFiles, undefined);
		assert.equal(resolveSubagentNoContextFilesForTest(defaults), false);
	});

	it("defaults session storage on and can disable it in agent frontmatter", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = configDir;

		writeFileSync(
			join(agentsDir, "tester.md"),
			`---\nname: tester\nno-session: true\n---\n\nYou are the tester.`,
		);

		const defs = loadAgentDefaults("tester");
		assert.equal(defs?.noSession, true);
		assert.equal(resolveSubagentNoSessionForTest(defs), true);
		assert.equal(resolveSubagentNoSessionForTest(null), false);
		assert.deepEqual(getPreparedSessionLaunchArgsForTest(defs), [
			"--session",
			"child.jsonl",
			"--no-session",
		]);

		writeFileSync(
			join(agentsDir, "tester.md"),
			`---\nname: tester\n---\n\nYou are the tester.`,
		);

		const defaults = loadAgentDefaults("tester");
		assert.equal(defaults?.noSession, undefined);
		assert.equal(resolveSubagentNoSessionForTest(defaults), false);
		assert.deepEqual(getPreparedSessionLaunchArgsForTest(defaults), [
			"--session",
			"child.jsonl",
		]);
	});

	it("reads fork output reserve tokens from agent frontmatter", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = configDir;

		writeFileSync(
			join(agentsDir, "tester.md"),
			`---\nname: tester\nfork-output-reserve-tokens: 20000\n---\n\nYou are the tester.`,
		);

		const defs = loadAgentDefaults("tester");
		assert.equal(defs?.forkOutputReserveTokens, 20000);
		assert.equal(resolveForkOutputReserveTokensForTest(defs), 20000);
		assert.equal(resolveForkOutputReserveTokensForTest(null), undefined);

		writeFileSync(
			join(agentsDir, "tester.md"),
			`---\nname: tester\nfork-output-reserve-tokens: lol\n---\n\nYou are the tester.`,
		);

		const invalid = loadAgentDefaults("tester");
		assert.equal(invalid?.forkOutputReserveTokens, undefined);
	});

	it("parses flags frontmatter and makes it available on AgentDefaults", () => {
		const dir = createTestDir();
		const agentsDir = join(dir, ".pi", "agents");
		const configDir = join(dir, "config");
		mkdirSync(agentsDir, { recursive: true });
		mkdirSync(join(configDir, "agents"), { recursive: true });
		writeFileSync(
			join(configDir, "agents", "tester.md"),
			`---\nname: tester\nflags: --plan --foo bar\n---\n\nTester body.`,
		);
		process.env.PI_CODING_AGENT_DIR = configDir;

		const defs = loadAgentDefaults("tester");
		assert.equal(defs?.flags, "--plan --foo bar");

		// Clean up
		process.env.PI_CODING_AGENT_DIR = "/tmp";
	});

	it("returns undefined for agents without flags", () => {
		const dir = createTestDir();
		const configDir = join(dir, "config");
		mkdirSync(join(configDir, "agents"), { recursive: true });
		writeFileSync(
			join(configDir, "agents", "tester.md"),
			`---\nname: tester\nauto-exit: true\n---\n\nTester body.`,
		);
		process.env.PI_CODING_AGENT_DIR = configDir;

		const defs = loadAgentDefaults("tester");
		assert.equal(defs?.flags, undefined);

		process.env.PI_CODING_AGENT_DIR = "/tmp";
	});

	it("launches no-session children through an ephemeral session path", () => {
		assert.deepEqual(
			getPreparedSessionLaunchArgsForTest({
				noSession: true,
				sessionMode: "fork",
			}),
			["--session", "child.jsonl", "--no-session"],
		);
		assert.deepEqual(
			getPreparedSessionLaunchArgsForTest({
				noSession: true,
				sessionMode: "lineage-only",
			}),
			["--session", "child.jsonl", "--no-session"],
		);
		assert.equal(getNoSessionSeedModeForTest("standalone"), null);
		assert.equal(getNoSessionSeedModeForTest("fork"), "fork");
		assert.equal(getNoSessionSeedModeForTest("lineage-only"), "fork");
	});

	it("restores persisted resume cwd without putting task text in CLI argv", () => {
		const weirdTask =
			"--help @not-a-file ' \" ` ; | && $(echo bad) $HOME\nこんにちは 🚀";
		assert.deepEqual(buildResumePiArgsForTest("child.jsonl", "background"), [
			"-p",
			"--session",
			"child.jsonl",
		]);
		assert.deepEqual(buildResumePiArgsForTest("child.jsonl", "interactive"), [
			"--session",
			"child.jsonl",
		]);
		assert.equal(
			buildResumePiArgsForTest("child.jsonl", "background").includes(weirdTask),
			false,
		);
		assert.equal(
			buildResumePiArgsForTest("child.jsonl", "interactive").includes(
				weirdTask,
			),
			false,
		);

		const metadata = {
			version: 1 as const,
			timestamp: "2026-05-08T00:00:00.000Z",
			name: "resumed-child",
			mode: "background" as const,
			sessionMode: "fork" as const,
			parentClosePolicy: "terminate" as const,
			blocking: false,
			async: true,
			denyTools: [],
			noContextFiles: false,
			noSession: false,
			agentConfigDir: "/tmp/agent",
			cwd: "/tmp/child cwd/with spaces",
			boundarySystemPrompt: true,
		};
		assert.equal(getResumeCwdForTest(metadata), "/tmp/child cwd/with spaces");
		assert.equal(
			buildShellChangeDirectoryPrefixForTest(metadata.cwd),
			"cd '/tmp/child cwd/with spaces' && ",
		);
	});

	it("infers resume mode from parent launch metadata", () => {
		const dir = createTestDir();
		const parent = join(dir, "parent.jsonl");
		const child = join(dir, "child.jsonl");
		writeFileSync(
			parent,
			`${[
				JSON.stringify({
					type: "session",
					timestamp: new Date().toISOString(),
					cwd: dir,
				}),
				JSON.stringify({
					type: "custom_message",
					customType: "subagent_started",
					details: {
						id: "child-1",
						name: "Worker",
						agent: "bg-mode",
						mode: "background",
						sessionFile: child,
						parentClosePolicy: "continue",
						autoExit: true,
					},
				}),
			].join("\n")}\n`,
		);
		writeFileSync(
			child,
			`${JSON.stringify({ type: "session", timestamp: new Date().toISOString(), cwd: dir, parentSession: parent })}\n`,
		);

		assert.deepEqual(resolveResumeLaunchMetadataForTest(child), {
			mode: "background",
			modeSource: "metadata",
			agent: "bg-mode",
			name: "Worker",
			autoExit: true,
			parentClosePolicy: "continue",
			blocking: undefined,
			async: undefined,
		});
		assert.deepEqual(resolveResumeLaunchMetadataForTest(child, "interactive"), {
			mode: "interactive",
			modeSource: "explicit",
		});
	});

	it("falls back to interactive resume mode when metadata is unavailable", () => {
		const dir = createTestDir();
		const child = createSessionFile(dir, [
			{ type: "session", timestamp: new Date().toISOString(), cwd: dir },
		]);
		assert.deepEqual(resolveResumeLaunchMetadataForTest(child), {
			mode: "interactive",
			modeSource: "fallback",
		});
	});

	it("prefers direct launch metadata when inferring resume mode", async () => {
		const dir = createTestDir();
		const child = join(dir, "direct-metadata-child.jsonl");
		await writeSubagentLaunchMetadataEntryForTest(child, {
			version: 1,
			timestamp: "2026-05-08T00:00:00.000Z",
			name: "direct-child",
			mode: "background",
			sessionMode: "fork",
			autoExit: true,
			parentClosePolicy: "continue",
			blocking: false,
			async: true,
			denyTools: [],
			noContextFiles: false,
			noSession: false,
			agentConfigDir: dir,
			cwd: dir,
			boundarySystemPrompt: true,
		});

		assert.deepEqual(resolveResumeLaunchMetadataForTest(child), {
			mode: "background",
			modeSource: "metadata",
			agent: undefined,
			name: "direct-child",
			autoExit: true,
			parentClosePolicy: "continue",
			blocking: false,
			async: true,
		});
	});

	it("persists launch metadata as non-message JSONL custom state even for missing session files", async () => {
		const dir = createTestDir();
		const child = join(dir, "standalone-child.jsonl");
		await writeSubagentLaunchMetadataEntryForTest(child, {
			version: 1,
			timestamp: "2026-05-08T00:00:00.000Z",
			name: "standalone-child",
			mode: "background",
			sessionMode: "standalone",
			parentClosePolicy: "continue",
			blocking: false,
			async: true,
			modelRef: "nahcrof/kimi-k2.6-precision",
			denyTools: [],
			noContextFiles: false,
			noSession: false,
			agentConfigDir: dir,
			cwd: dir,
			systemPromptMode: "replace",
			systemPrompt: "STANDALONE_CHILD_PROMPT_TOKEN",
			boundarySystemPrompt: false,
		});

		const entries = getEntries(child) as any[];
		assert.equal(entries[0].type, "session");
		assert.equal(entries[1].type, "custom");
		assert.equal(entries[1].customType, "pi-subagents_launch_metadata");
		assert.equal(JSON.stringify(entries).includes("custom_message"), false);
		assert.equal(
			readSubagentLaunchMetadataForTest(child)?.systemPrompt,
			"STANDALONE_CHILD_PROMPT_TOKEN",
		);
	});

});
