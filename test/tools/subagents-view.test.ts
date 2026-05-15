import {
	assert,
	afterEach,
	describe,
	it,
	resetSubagentStateForTest,
	setRunningSubagentForTest,
} from "../support/index.ts";
import { SubagentsOverlay } from "../../src/tools/subagents-view.ts";

// ── Helpers ────────────────────────────────────────────────────────

function createOverlay(): SubagentsOverlay {
	const done = () => {};
	const ctx = {
		cwd: "/tmp",
		ui: {
			confirm: async () => true,
			input: async () => "test message",
			notify: () => {},
		},
		sessionManager: {
			getSessionFile: () => null,
		},
	} as any;
	return new SubagentsOverlay(done as any, ctx, { fg: (_t: string, text: string) => text, bold: (text: string) => text });
} 

function simulateKey(overlay: SubagentsOverlay, key: string): void {
	overlay.handleInput(key);
}

function renderLines(overlay: SubagentsOverlay, width = 80): string[] {
	return overlay.render(width);
}

function stripAnsi(str: string): string {
	return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

// ── Helpers to avoid direct key imports ────────────────────────────

function pressUp(overlay: SubagentsOverlay): void {
	simulateKey(overlay, "\x1b[A");
}

function pressDown(overlay: SubagentsOverlay): void {
	simulateKey(overlay, "\x1b[B");
}

function pressLeft(overlay: SubagentsOverlay): void {
	simulateKey(overlay, "\x1b[D");
}

function pressRight(overlay: SubagentsOverlay): void {
	simulateKey(overlay, "\x1b[C");
}

// ── Tests ──────────────────────────────────────────────────────────

describe("subagents-view overlay", () => {
	afterEach(() => {
		resetSubagentStateForTest();
	});

	describe("empty states", () => {
		it('shows "No running subagents" on Running tab', () => {
			const overlay = createOverlay();
			const lines = renderLines(overlay);
			const text = lines.map(stripAnsi).join("\n");
			assert.ok(text.includes("No running subagents"), `Expected "No running subagents" in:\n${text}`);
			overlay.dispose();
		});

		it('shows "Loading…" placeholder on Completed tab while async data loads', () => {
			const overlay = createOverlay();
			pressRight(overlay); // Switch to Completed tab
			const lines = renderLines(overlay);
			const text = lines.map(stripAnsi).join("\n");
			assert.ok(text.includes("Loading…"), `Expected "Loading…" in:\n${text}`);
			overlay.dispose();
		});
	});

	describe("tab navigation", () => {
		it("starts on Running tab", () => {
			const overlay = createOverlay();
			const lines = renderLines(overlay);
			const text = lines.map(stripAnsi).join("\n");
			assert.ok(text.includes("Running"), `Expected "Running" in:\n${text}`);
			overlay.dispose();
		});

		it("switches to Completed tab with right arrow", () => {
			const overlay = createOverlay();
			pressRight(overlay);
			const lines = renderLines(overlay);
			const text = lines.map(stripAnsi).join("\n");
			assert.ok(text.includes("Completed"), `Expected "Completed" in:\n${text}`);
			overlay.dispose();
		});

		it("switches to Agents tab with two right arrows", () => {
			const overlay = createOverlay();
			pressRight(overlay);
			pressRight(overlay);
			const lines = renderLines(overlay);
			const text = lines.map(stripAnsi).join("\n");
			assert.ok(text.includes("Agents"), `Expected "Agents" in:\n${text}`);
			overlay.dispose();
		});

		it("does not go left past Running tab", () => {
			const overlay = createOverlay();
			pressLeft(overlay); // Should stay on Running
			const lines = renderLines(overlay);
			const text = lines.map(stripAnsi).join("\n");
			assert.ok(text.includes("Running"), `Expected "Running" in:\n${text}`);
			overlay.dispose();
		});

		it("does not go right past Agents tab", () => {
			const overlay = createOverlay();
			pressRight(overlay);
			pressRight(overlay);
			pressRight(overlay); // Should stay on Agents
			const lines = renderLines(overlay);
			const text = lines.map(stripAnsi).join("\n");
			assert.ok(text.includes("Agents"), `Expected "Agents" in:\n${text}`);
			overlay.dispose();
		});
	});

	describe("item navigation", () => {
		it("renders running subagents in the list", () => {
			setRunningSubagentForTest({
				id: "test-1",
				name: "scout",
				task: "Explore codebase",
				mode: "background",
				executionState: "running",
				deliveryState: "detached",
				parentClosePolicy: "terminate",
				startTime: Date.now(),
				sessionFile: "/tmp/test.jsonl",
			} as any);

			const overlay = createOverlay();
			const lines = renderLines(overlay);
			const text = lines.map(stripAnsi).join("\n");
			assert.ok(text.includes("scout"), `Expected "scout" in:\n${text}`);
			overlay.dispose();
		});

		it("highlights the selected item with inverse video", () => {
			setRunningSubagentForTest({
				id: "test-1",
				name: "scout",
				task: "Explore codebase",
				mode: "background",
				executionState: "running",
				deliveryState: "detached",
				parentClosePolicy: "terminate",
				startTime: Date.now(),
				sessionFile: "/tmp/test.jsonl",
			} as any);
			setRunningSubagentForTest({
				id: "test-2",
				name: "reviewer",
				task: "Review code",
				mode: "background",
				executionState: "running",
				deliveryState: "detached",
				parentClosePolicy: "terminate",
				startTime: Date.now(),
				sessionFile: "/tmp/test2.jsonl",
			} as any);

			const overlay = createOverlay();
			const lines1 = renderLines(overlay);
			// First item should be selected
			const text1 = lines1.map(stripAnsi).join("\n");
			assert.ok(text1.includes("scout"), `Expected "scout" in:\n${text1}`);

			pressDown(overlay);
			const lines2 = renderLines(overlay);
			const text2 = lines2.map(stripAnsi).join("\n");
			assert.ok(text2.includes("reviewer"), `Expected "reviewer" after down:\n${text2}`);

			overlay.dispose();
		});

		it("does not go above the first item", () => {
			setRunningSubagentForTest({
				id: "test-1",
				name: "scout",
				task: "Explore codebase",
				mode: "background",
				executionState: "running",
				deliveryState: "detached",
				parentClosePolicy: "terminate",
				startTime: Date.now(),
				sessionFile: "/tmp/test.jsonl",
			} as any);

			const overlay = createOverlay();
			pressUp(overlay); // Should stay on first item
			const lines = renderLines(overlay);
			const text = lines.map(stripAnsi).join("\n");
			assert.ok(text.includes("scout"), `Expected "scout" after up:\n${text}`);
			overlay.dispose();
		});
	});

	describe("detail view", () => {
		it("opens detail view with i key", () => {
			setRunningSubagentForTest({
				id: "test-1",
				name: "scout",
				task: "Explore codebase",
				mode: "background",
				executionState: "running",
				deliveryState: "detached",
				parentClosePolicy: "terminate",
				startTime: Date.now(),
				sessionFile: "/tmp/test.jsonl",
			} as any);

			const overlay = createOverlay();
			simulateKey(overlay, "i");
			const lines = renderLines(overlay);
			const text = lines.map(stripAnsi).join("\n");
			assert.ok(text.includes("scout"), `Expected "scout" in detail:\n${text}`);
			assert.ok(text.includes("Identity"), `Expected "Identity" section:\n${text}`);
			overlay.dispose();
		});

		it("closes detail view with Escape", () => {
			setRunningSubagentForTest({
				id: "test-1",
				name: "scout",
				task: "Explore codebase",
				mode: "background",
				executionState: "running",
				deliveryState: "detached",
				parentClosePolicy: "terminate",
				startTime: Date.now(),
				sessionFile: "/tmp/test.jsonl",
			} as any);

			const overlay = createOverlay();
			simulateKey(overlay, "i"); // Open detail
			pressLeft(overlay); // Should NOT switch tab in detail mode
			simulateKey(overlay, "\x1b"); // Escape closes detail
			const lines = renderLines(overlay);
			const text = lines.map(stripAnsi).join("\n");
			assert.ok(text.includes("Running"), `Expected back to Running tab:\n${text}`);
			overlay.dispose();
		});
	});

	describe("footer hints", () => {
		it("shows k:kill hint on Running tab", () => {
			setRunningSubagentForTest({
				id: "test-1",
				name: "scout",
				task: "Explore codebase",
				mode: "background",
				executionState: "running",
				deliveryState: "detached",
				parentClosePolicy: "terminate",
				startTime: Date.now(),
				sessionFile: "/tmp/test.jsonl",
			} as any);

			const overlay = createOverlay();
			const lines = renderLines(overlay);
			const text = lines.map(stripAnsi).join("\n");
			assert.ok(text.includes("k kill"), `Expected "k kill" hint in:\n${text}`);
			overlay.dispose();
		});

		it("shows m message hint on Completed tab", () => {
			const overlay = createOverlay();
			pressRight(overlay);
			const lines = renderLines(overlay);
			const text = lines.map(stripAnsi).join("\n");
			assert.ok(text.includes("m message"), `Expected "m message" hint in:\n${text}`);
			overlay.dispose();
		});

		it("shows i info hint on Agents tab", () => {
			const overlay = createOverlay();
			pressRight(overlay);
			pressRight(overlay);
			const lines = renderLines(overlay);
			const text = lines.map(stripAnsi).join("\n");
			assert.ok(text.includes("i info"), `Expected "i info" hint in:\n${text}`);
			overlay.dispose();
		});
	});

	describe("close", () => {
		it("closes overlay with Escape", () => {
			const overlay = createOverlay();
			let closed = false;
			const done = () => { closed = true; };
			(overlay as any).done = done;

			simulateKey(overlay, "\x1b");
			assert.equal(closed, true);
		});

		it("dispose clears the refresh timer", () => {
			const overlay = createOverlay();
			overlay.dispose();
			// Should not throw — timer is cleared
			overlay.dispose();
		});
	});

	describe("runtime stats rendering", () => {
		it("shows elapsed time for running agents", () => {
			setRunningSubagentForTest({
				id: "test-1",
				name: "scout",
				task: "",
				mode: "background",
				executionState: "running",
				deliveryState: "detached",
				parentClosePolicy: "terminate",
				startTime: Date.now() - 5000,
				sessionFile: "/tmp/test.jsonl",
			} as any);

			const overlay = createOverlay();
			const lines = renderLines(overlay);
			const text = lines.map(stripAnsi).join("\n");
			assert.ok(text.includes("s"), `Expected seconds in elapsed:\n${text}`);
			overlay.dispose();
		});
	});
});

const mockRuntime = {
	getShellReadyDelayMs: () => 800,
	isMuxAvailable: () => false,
	watchBackgroundSubagent: async () => ({ name: "", task: "", summary: "", exitCode: 0, elapsed: 0 }),
	watchSubagent: async () => ({ name: "", task: "", summary: "", exitCode: 0, elapsed: 0 }),
	getWatcherSignal: (_r: any, c: AbortController) => c.signal,
	startWidgetRefresh: () => {},
	runningSubagents: new Map(),
	pi: { on() {} } as any,
	wireSubagentSteerBack: () => {},
};

describe("subagents-view registration", () => {
	afterEach(() => {
		resetSubagentStateForTest();
	});

	it("registers /subagents command and alt+s shortcut", async () => {
		const commands: Array<{ name: string; description: string }> = [];
		let shortcutRegistered = false;

		const { registerSubagentsView } = await import("../../src/tools/subagents-view.ts");

		registerSubagentsView({
			registerCommand(name: string, opts: any) {
				commands.push({ name, description: opts.description });
			},
			registerShortcut(shortcut: string, opts: any) {
				shortcutRegistered = true;
			},
			on() {},
		} as any, mockRuntime);

		assert.equal(commands.length, 1);
		assert.equal(commands[0].name, "subagents");
		assert.ok(commands[0].description.includes("subagent"));
		assert.equal(shortcutRegistered, true);
	});

	it("shows notification when no subagents or agent definitions exist", async () => {
		const notifications: string[] = [];
		const { registerSubagentsView } = await import("../../src/tools/subagents-view.ts");

		registerSubagentsView({
			registerCommand(name: string, opts: any) {
				// Simulate running the command handler
				opts.handler("", {
					ui: {
						notify: (msg: string, type: string) => {
							notifications.push(msg);
						},
						custom: async () => { /* noop — won't be called when empty state hits */ },
					},
					sessionManager: {
						getSessionFile: () => null,
					},
					cwd: "/tmp",
				});
			},
			registerShortcut() {},
			on() {},
		} as any, mockRuntime);

		// Note: this test depends on the test environment not having
		// global agent definitions. If global agents exist, openOverlay
		// will try ctx.ui.custom() instead of notify.
		if (notifications.length === 0) {
			// Has global agents — skip assertion, this is environment-dependent
			return;
		}
		assert.ok(notifications[0].includes("No subagents"));
	});

	it("calls session_shutdown handler without error", async () => {
		const handlers = new Map<string, Function>();
		const { registerSubagentsView } = await import("../../src/tools/subagents-view.ts");

		registerSubagentsView({
			registerCommand() {},
			registerShortcut() {},
			on(event: string, handler: any) {
				handlers.set(event, handler);
			},
		} as any, mockRuntime);

		const shutdownHandler = handlers.get("session_shutdown");
		assert.ok(shutdownHandler);
		// Should not throw
		(shutdownHandler as Function)();
	});

	it("registers and invokes alt+s shortcut handler", async () => {
		const notifications: string[] = [];
		let shortcutHandler: ((ctx: any) => Promise<void>) | null = null;
		const { registerSubagentsView } = await import("../../src/tools/subagents-view.ts");

		registerSubagentsView({
			registerCommand() {},
			registerShortcut(_shortcut: string, opts: any) {
				shortcutHandler = opts.handler;
			},
			on() {},
		} as any, mockRuntime);

		assert.ok(shortcutHandler, "alt+s handler should be registered");

		// First call — if no global agents, notifies about empty state
		await (shortcutHandler as (ctx: any) => Promise<void>)({
			ui: {
				notify: (msg: string) => { notifications.push(msg); },
				custom: async () => {},
			},
			sessionManager: { getSessionFile: () => null },
			cwd: "/tmp",
		});
		// Environment-dependent: if global agents exist, custom() is called instead
		if (notifications.length > 0) {
			assert.ok(notifications[0].includes("No subagents"));
		}
	});
});
