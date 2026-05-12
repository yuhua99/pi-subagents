import {
	assert,
	mkdirSync,
	writeFileSync,
	join,
	afterEach,
	describe,
	it,
	subagentsExtension,
	getCompletedSubagentResultForTest,
	getLaunchedSubagentResultForTest,
	markSubagentBatchBlockingForTest,
	getSubagentCatalogSignatureForTest,
	renderSubagentCatalogReminderForTest,
	resetSubagentStateForTest,
	routeDetachedSubagentCompletionForTest,
	setRunningSubagentForTest,
	waitForSubagentForTest,
	createTestDir,
} from "../support/index.ts";

describe("subagent launch result delivery", () => {
	afterEach(() => {
		resetSubagentStateForTest();
	});

	it("marks async detached launch results as terminating the current tool batch", async () => {
		const running = {
			id: "child-terminate",
			name: "Child",
			task: "Do work",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: false,
			async: true,
			startTime: Date.now(),
			sessionFile: "/tmp/child-terminate.jsonl",
		};

		const result = (await getLaunchedSubagentResultForTest(
			running as any,
		)) as any;
		assert.equal((result.details as any).status, "started");
		assert.equal((result.details as any).blocking, false);
		assert.equal(result.terminate, true);
	});

	it("does not terminate async launch results when coordinator-only turn stop is disabled", async () => {
		process.env.PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN = "1";
		const running = {
			id: "child-no-terminate-opt-out",
			name: "Child",
			task: "Do work",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: false,
			async: true,
			startTime: Date.now(),
			sessionFile: "/tmp/child-no-terminate-opt-out.jsonl",
		};

		const result = (await getLaunchedSubagentResultForTest(
			running as any,
		)) as any;
		assert.equal((result.details as any).status, "started");
		assert.equal((result.details as any).async, true);
		assert.equal(result.terminate, undefined);
	});

	it("does not defer same-turn detached async completion when coordinator-only turn stop is disabled", async () => {
		process.env.PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN = "1";
		const sent: Array<{ message: any; options: any }> = [];
		const running = {
			id: "child-no-defer-opt-out",
			name: "Async child",
			task: "Start work",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: false,
			async: true,
			startTime: Date.now(),
			sessionFile: "/tmp/child-no-defer-opt-out.jsonl",
		};

		setRunningSubagentForTest(running as any);
		const asyncResult = (await getLaunchedSubagentResultForTest(
			running as any,
		)) as any;
		routeDetachedSubagentCompletionForTest(
			{
				sendMessage(message: any, options: any) {
					sent.push({ message, options });
				},
			},
			running as any,
			{
				name: running.name,
				task: running.task,
				summary: "Async done",
				sessionFile: running.sessionFile,
				exitCode: 0,
				elapsed: 1,
			},
		);

		assert.equal(asyncResult.terminate, undefined);
		assert.equal(sent.length, 1);
		assert.equal(sent[0].options.deliverAs, "steer");
	});

	it("defers same-turn detached async completion delivery until the next user turn", async () => {
		const sent: Array<{ message: any; options: any }> = [];
		const running = {
			id: "child-deferred-steer",
			name: "Async child",
			task: "Start work",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: false,
			async: true,
			startTime: Date.now(),
			sessionFile: "/tmp/child-deferred-steer.jsonl",
		};

		setRunningSubagentForTest(running as any);
		const asyncResult = (await getLaunchedSubagentResultForTest(
			running as any,
		)) as any;
		routeDetachedSubagentCompletionForTest(
			{
				sendMessage(message: any, options: any) {
					sent.push({ message, options });
				},
			},
			running as any,
			{
				name: running.name,
				task: running.task,
				summary: "Async done",
				sessionFile: running.sessionFile,
				exitCode: 0,
				elapsed: 1,
			},
		);

		assert.equal(asyncResult.terminate, true);
		assert.equal(sent.length, 1);
		assert.equal(sent[0].options.deliverAs, "nextTurn");
		assert.equal(
			getCompletedSubagentResultForTest(running.id)?.deliveredTo,
			"steer",
		);
	});

	it("awaits async children when the current subagent batch has a sync child", async () => {
		markSubagentBatchBlockingForTest();
		const asyncRunning = {
			id: "child-mixed-async-awaited",
			name: "Async child",
			task: "Start work",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: false,
			async: true,
			startTime: Date.now(),
			sessionFile: "/tmp/child-mixed-async-awaited.jsonl",
			completionPromise: Promise.resolve({
				name: "Async child",
				task: "Start work",
				summary: "Async done",
				sessionFile: "/tmp/child-mixed-async-awaited.jsonl",
				exitCode: 0,
				elapsed: 1,
			}),
		};

		setRunningSubagentForTest(asyncRunning as any);
		const asyncResult = (await getLaunchedSubagentResultForTest(
			asyncRunning as any,
		)) as any;
		assert.equal((asyncResult.details as any).status, "completed");
		assert.equal((asyncResult.details as any).deliveryState, "awaited");
		assert.equal((asyncResult.details as any).blocking, false);
		assert.equal((asyncResult.details as any).async, true);
		assert.equal(asyncResult.terminate, undefined);
		assert.equal(
			getCompletedSubagentResultForTest(asyncRunning.id)?.deliveredTo,
			"wait",
		);
	});

	it("does not mark mixed async and sync launch results as terminating when coordinator-only turn stop is disabled", async () => {
		process.env.PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN = "1";
		const asyncRunning = {
			id: "child-mixed-async-opt-out",
			name: "Async child",
			task: "Start work",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: false,
			async: true,
			startTime: Date.now(),
			sessionFile: "/tmp/child-mixed-async-opt-out.jsonl",
		};
		const syncRunning = {
			id: "child-mixed-sync-opt-out",
			name: "Sync child",
			task: "Gate work",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: true,
			async: false,
			startTime: Date.now(),
			sessionFile: "/tmp/child-mixed-sync-opt-out.jsonl",
			completionPromise: Promise.resolve({
				name: "Sync child",
				task: "Gate work",
				summary: "Done",
				sessionFile: "/tmp/child-mixed-sync-opt-out.jsonl",
				exitCode: 0,
				elapsed: 1,
			}),
		};

		setRunningSubagentForTest(asyncRunning as any);
		setRunningSubagentForTest(syncRunning as any);
		const asyncResult = (await getLaunchedSubagentResultForTest(
			asyncRunning as any,
		)) as any;
		const syncResult = (await getLaunchedSubagentResultForTest(
			syncRunning as any,
		)) as any;
		assert.equal(asyncResult.terminate, undefined);
		assert.equal((syncResult.details as any).status, "completed");
		assert.equal(syncResult.terminate, undefined);
	});

	it("does not mark sync launch results as terminating the current tool batch", async () => {
		const running = {
			id: "child-sync-no-terminate",
			name: "Child",
			task: "Do work",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			blocking: true,
			async: false,
			startTime: Date.now(),
			sessionFile: "/tmp/child-sync-no-terminate.jsonl",
			completionPromise: Promise.resolve({
				name: "Child",
				task: "Do work",
				summary: "Done",
				sessionFile: "/tmp/child-sync-no-terminate.jsonl",
				exitCode: 0,
				elapsed: 1,
			}),
		};

		setRunningSubagentForTest(running as any);
		const result = (await getLaunchedSubagentResultForTest(
			running as any,
		)) as any;
		assert.equal((result.details as any).status, "completed");
		assert.equal(result.terminate, undefined);
	});

	it("keeps parent tools available after waiting for detached children", async () => {
		const running = {
			id: "child-guard",
			name: "Child",
			task: "Do work",
			mode: "background" as const,
			executionState: "running" as const,
			deliveryState: "detached" as const,
			parentClosePolicy: "terminate" as const,
			startTime: Date.now(),
			sessionFile: "/tmp/child-guard.jsonl",
			completionPromise: Promise.resolve({
				name: "Child",
				task: "Do work",
				summary: "Done",
				sessionFile: "/tmp/child-guard.jsonl",
				exitCode: 0,
				elapsed: 1,
			}),
		};

		setRunningSubagentForTest(running);
		const waited = await waitForSubagentForTest({ id: "Child" });
		assert.equal((waited.details as any).status, "completed");
		assert.equal(
			getCompletedSubagentResultForTest(running.id)?.deliveredTo,
			"wait",
		);
	});

	it("injects one hidden startup catalog for top-level actionable sessions", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = configDir;
		writeFileSync(
			join(agentsDir, "reviewer.md"),
			`---\nname: reviewer\ndescription: Review changes for regressions\nmode: background\n---\n\nReviewer body.`,
		);

		const handlers = new Map<string, any>();
		subagentsExtension({
			on(event: string, handler: any) {
				handlers.set(event, handler);
			},
			registerCommand() {},
			registerMessageRenderer() {},
			registerTool() {},
			sendMessage() {},
		} as any);

		handlers.get("session_start")(
			{ type: "session_start", reason: "startup" },
			{
				cwd: dir,
				hasUI: false,
				ui: { setWidget() {} },
				sessionManager: {
					getHeader: () => ({
						id: "root",
						type: "session",
						timestamp: "",
						cwd: dir,
					}),
				},
			},
		);

		const result = handlers.get("before_agent_start")({
			type: "before_agent_start",
			prompt: "hi",
			systemPrompt: "sys",
		});
		const message = result?.message;
		assert.ok(message);
		assert.equal(message.customType, "subagent_catalog");
		assert.equal(message.display, false);
		assert.equal((message.details as any).entries[0].name, "reviewer");
		assert.equal(
			(message.details as any).signature,
			getSubagentCatalogSignatureForTest((message.details as any).entries),
		);
		assert.match(message.content, /^<system-reminder>\n/);
		assert.match(message.content, /Available named subagents:/);
		assert.match(
			message.content,
			/reviewer \(background\) \[isolated context\] — Review changes for regressions/,
		);
		assert.match(
			message.content,
			/Memory label rule: isolated context means the subagent starts a fresh chat and cannot see this conversation/,
		);
		assert.match(
			message.content,
			/forked context means the subagent continues from this conversation on a new branch/,
		);
		assert.match(message.content, /\n<\/system-reminder>$/);
		assert.equal(
			renderSubagentCatalogReminderForTest((message.details as any).entries),
			message.content,
		);
		assert.doesNotMatch(message.content, /subagents_list/);
		assert.match(
			message.content,
			/call subagent once with children: \[\.\.\.\] so the runtime starts every child before waiting/,
		);
		assert.equal(
			handlers.get("before_agent_start")({
				type: "before_agent_start",
				prompt: "again",
				systemPrompt: "sys",
			}),
			undefined,
		);
	});

	it("does not register subagents_list for top-level ambient-aware sessions", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = configDir;
		writeFileSync(
			join(agentsDir, "reviewer.md"),
			`---\nname: reviewer\ndescription: Review changes for regressions\nmode: background\n---\n\nReviewer body.`,
		);

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

		assert.ok(tools.get("subagent"));
		assert.equal(tools.has("subagents_list"), false);
	});

	it("queues reload catalog changes for the next turn instead of interrupting immediately", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = configDir;
		writeFileSync(
			join(agentsDir, "reviewer.md"),
			`---\nname: reviewer\ndescription: Review changes for regressions\n---\n\nReviewer body.`,
		);

		const handlers = new Map<string, any>();
		const ctx = {
			cwd: dir,
			hasUI: false,
			ui: { setWidget() {} },
			sessionManager: {
				getHeader: () => ({
					id: "root",
					type: "session",
					timestamp: "",
					cwd: dir,
				}),
			},
		};

		subagentsExtension({
			on(event: string, handler: any) {
				handlers.set(event, handler);
			},
			registerCommand() {},
			registerMessageRenderer() {},
			registerTool() {},
			sendMessage() {},
		} as any);

		handlers.get("session_start")(
			{ type: "session_start", reason: "startup" },
			ctx,
		);
		const startup = handlers.get("before_agent_start")({
			type: "before_agent_start",
			prompt: "start",
			systemPrompt: "sys",
		});
		assert.ok(startup?.message);
		assert.equal((startup.message.details as any).supersedes, undefined);

		writeFileSync(
			join(agentsDir, "researcher.md"),
			`---\nname: researcher\ndescription: Investigate open-ended questions\nmode: background\n---\n\nResearcher body.`,
		);

		handlers.get("session_start")(
			{ type: "session_start", reason: "reload" },
			ctx,
		);
		const reloaded = handlers.get("before_agent_start")({
			type: "before_agent_start",
			prompt: "continue",
			systemPrompt: "sys",
		});
		assert.ok(reloaded?.message);
		assert.equal((reloaded.message.details as any).supersedes, true);
		assert.match(
			reloaded.message.content,
			/researcher \(background\) \[isolated context\] — Investigate open-ended questions/,
		);

		handlers.get("session_start")(
			{ type: "session_start", reason: "reload" },
			ctx,
		);
		assert.equal(
			handlers.get("before_agent_start")({
				type: "before_agent_start",
				prompt: "continue again",
				systemPrompt: "sys",
			}),
			undefined,
		);
	});

});
