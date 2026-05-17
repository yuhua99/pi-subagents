import { execFileSync, execSync, spawnSync } from "node:child_process";
import {
	getMuxBackend,
	requireMuxBackend,
	shellEscape,
	zellijActionSync,
} from "./core.ts";
import { createZellijSurface } from "./zellij-placement.ts";

// ── Cmux focus snapshot/restore ────────────────────────────────────────────

type CmuxFocusSnapshot = {
	surfaceRef?: string;
	paneRef?: string;
};

type CmuxCreatedSurface = {
	surface: string;
	paneRef?: string;
};

type CmuxIdentifySnapshot = {
	focused: CmuxFocusSnapshot | null;
	caller: CmuxFocusSnapshot | null;
};

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function parseCmuxFocusedSnapshot(value: unknown): CmuxFocusSnapshot | null {
	if (!value || typeof value !== "object") return null;

	const focused = (value as { focused?: unknown }).focused;
	if (!focused || typeof focused !== "object") return null;

	const record = focused as {
		surface_ref?: unknown;
		pane_ref?: unknown;
	};
	const surfaceRef = nonEmptyString(record.surface_ref)
		? record.surface_ref
		: undefined;
	const paneRef = nonEmptyString(record.pane_ref)
		? record.pane_ref
		: undefined;

	if (!surfaceRef && !paneRef) return null;
	return { surfaceRef, paneRef };
}

function parseCmuxJson(value: string): unknown | null {
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function parseCmuxCallerSnapshot(value: unknown): CmuxFocusSnapshot | null {
	if (!value || typeof value !== "object") return null;

	const caller = (value as { caller?: unknown }).caller;
	if (!caller || typeof caller !== "object") return null;

	const record = caller as {
		surface_ref?: unknown;
		pane_ref?: unknown;
	};
	const surfaceRef = nonEmptyString(record.surface_ref)
		? record.surface_ref
		: undefined;
	const paneRef = nonEmptyString(record.pane_ref)
		? record.pane_ref
		: undefined;

	if (!surfaceRef && !paneRef) return null;
	return { surfaceRef, paneRef };
}

function parseCmuxCreatedSurface(
	output: string,
	command: string,
): CmuxCreatedSurface {
	const surfaceMatch = output.match(/surface:\d+/);
	if (!surfaceMatch) {
		throw new Error(`Unexpected cmux ${command} output: ${output}`);
	}
	return {
		surface: surfaceMatch[0],
		paneRef: output.match(/pane:\d+/)?.[0],
	};
}

function parseCmuxPaneRefForSurface(
	value: unknown,
	surface: string,
): string | null {
	if (!value || typeof value !== "object") return null;

	const record = value as {
		surface_ref?: unknown;
		pane_ref?: unknown;
		caller?: unknown;
	};
	if (record.surface_ref === surface && nonEmptyString(record.pane_ref))
		return record.pane_ref;

	const caller = record.caller;
	if (!caller || typeof caller !== "object") return null;

	const callerRecord = caller as {
		surface_ref?: unknown;
		pane_ref?: unknown;
	};
	if (callerRecord.surface_ref === surface && nonEmptyString(callerRecord.pane_ref)) {
		return callerRecord.pane_ref;
	}

	return null;
}

function readCmux(args: string[]): string | null {
	const result = spawnSync("cmux", args, { encoding: "utf8" });
	if (result.error || result.status !== 0 || !result.stdout.trim()) return null;
	return result.stdout;
}

function parseCmuxIdentifySnapshot(value: string | null): CmuxIdentifySnapshot {
	const parsed = value ? parseCmuxJson(value) : null;
	return {
		focused: parseCmuxFocusedSnapshot(parsed),
		caller: parseCmuxCallerSnapshot(parsed),
	};
}

function captureCmuxIdentifySnapshot(): CmuxIdentifySnapshot {
	return parseCmuxIdentifySnapshot(readCmux(["identify", "--json"]));
}

function captureCmuxFocusSnapshot(): CmuxFocusSnapshot | null {
	return captureCmuxIdentifySnapshot().focused;
}

function readCmuxPaneRefForSurface(surface: string): string | null {
	const info = readCmux(["identify", "--surface", surface]);
	return info ? parseCmuxPaneRefForSurface(parseCmuxJson(info), surface) : null;
}

function restoreCmuxFocusSnapshot(snapshot: CmuxFocusSnapshot | null): void {
	if (!snapshot) return;

	if (snapshot.paneRef) {
		spawnSync("cmux", ["focus-pane", "--pane", snapshot.paneRef], {
			encoding: "utf8",
		});
	}

	if (snapshot.surfaceRef) {
		spawnSync("cmux", ["focus-panel", "--panel", snapshot.surfaceRef], {
			encoding: "utf8",
		});
	}
}

function waitForCmuxFocusSettle(): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
}

function cmuxFocusMatchesChild(
	currentFocus: CmuxFocusSnapshot | null,
	child: CmuxCreatedSurface,
): boolean {
	if (!currentFocus) return false;
	if (currentFocus.surfaceRef === child.surface) return true;
	return (
		!!currentFocus.paneRef && currentFocus.paneRef === child.paneRef
	);
}

function cmuxFocusMatchesSurfaceRef(
	currentFocus: CmuxFocusSnapshot | null,
	surfaceRef: string | undefined,
): boolean {
	return !!surfaceRef && currentFocus?.surfaceRef === surfaceRef;
}

function cmuxFocusMatchesPaneRef(
	currentFocus: CmuxFocusSnapshot | null,
	paneRef: string | undefined,
): boolean {
	return !!paneRef && currentFocus?.paneRef === paneRef;
}

function restoreCmuxFocusIfLaunchSurfaceFocused(
	snapshot: CmuxFocusSnapshot | null,
	child: CmuxCreatedSurface,
	options?: {
		sourceSurfaceRef?: string;
		callerSnapshot?: CmuxFocusSnapshot | null;
	},
): void {
	if (!snapshot) return;

	waitForCmuxFocusSettle();
	const currentFocus = captureCmuxFocusSnapshot();
	if (
		cmuxFocusMatchesChild(currentFocus, child) ||
		cmuxFocusMatchesSurfaceRef(currentFocus, options?.sourceSurfaceRef) ||
		cmuxFocusMatchesSurfaceRef(currentFocus, options?.callerSnapshot?.surfaceRef) ||
		cmuxFocusMatchesPaneRef(currentFocus, options?.callerSnapshot?.paneRef)
	) {
		restoreCmuxFocusSnapshot(snapshot);
	}
}

function createCmuxSplitSurface(
	name: string,
	direction: "left" | "right" | "up" | "down",
	fromSurface?: string,
): CmuxCreatedSurface {
	const identifySnapshot = captureCmuxIdentifySnapshot();
	const focusSnapshot = identifySnapshot.focused;
	const callerSnapshot = identifySnapshot.caller;
	let child: CmuxCreatedSurface | null = null;

	try {
		const args = ["new-split", direction];
		if (fromSurface) args.push("--surface", fromSurface);

		const output = execFileSync("cmux", args, { encoding: "utf8" }).trim();
		child = parseCmuxCreatedSurface(output, "new-split");
		child.paneRef ??= readCmuxPaneRefForSurface(child.surface) ?? undefined;

		// Rename the surface tab
		execFileSync("cmux", ["rename-tab", "--surface", child.surface, name], {
			encoding: "utf8",
		});

		return child;
	} finally {
		if (child) {
			restoreCmuxFocusIfLaunchSurfaceFocused(focusSnapshot, child, {
				sourceSurfaceRef: fromSurface,
				callerSnapshot,
			});
		} else {
			restoreCmuxFocusSnapshot(focusSnapshot);
		}
	}
}

// ── Surface creation ───────────────────────────────────────────────────────

export function createSurface(name: string): string {
	const backend = getMuxBackend();

	if (backend === "cmux") {
		const created = createCmuxSplitSurface(
			name,
			"right",
			process.env.CMUX_SURFACE_ID,
		);
		return created.surface;
	}

	if (backend === "zellij") {
		return createZellijSurface(name);
	}

	const surface = createSurfaceSplit(
		name,
		"right",
		backend === "tmux" ? process.env.TMUX_PANE : undefined,
	);
	return surface;
}

function createCmuxSplit(
	name: string,
	direction: "left" | "right" | "up" | "down",
	fromSurface?: string,
): string {
	return createCmuxSplitSurface(name, direction, fromSurface).surface;
}

function createTmuxSplit(
	_name: string,
	direction: "left" | "right" | "up" | "down",
	fromSurface?: string,
): string {
	const args = ["split-window", "-d"];
	args.push(direction === "left" || direction === "right" ? "-h" : "-v");
	if (direction === "left" || direction === "up") args.push("-b");
	if (fromSurface) args.push("-t", fromSurface);
	args.push("-P", "-F", "#{pane_id}");

	const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
	if (!pane.startsWith("%")) {
		throw new Error(`Unexpected tmux split-window output: ${pane}`);
	}

	return pane;
}

function createWezTermSplit(
	name: string,
	direction: "left" | "right" | "up" | "down",
	fromSurface?: string,
): string {
	const args = ["cli", "split-pane"];
	if (direction === "left") args.push("--left");
	else if (direction === "right") args.push("--right");
	else if (direction === "up") args.push("--top");
	else args.push("--bottom");
	args.push("--cwd", process.cwd());
	if (fromSurface) args.push("--pane-id", fromSurface);
	const paneId = execFileSync("wezterm", args, { encoding: "utf8" }).trim();
	if (!paneId || !/^\d+$/.test(paneId)) {
		throw new Error(
			`Unexpected wezterm split-pane output: ${paneId || "(empty)"}`,
		);
	}
	try {
		execFileSync(
			"wezterm",
			["cli", "set-tab-title", "--pane-id", paneId, name],
			{ encoding: "utf8" },
		);
	} catch {}
	return paneId;
}

function createZellijSplit(
	name: string,
	direction: "left" | "right" | "up" | "down",
	fromSurface?: string,
): string {
	const directionArg =
		direction === "left" || direction === "right" ? "right" : "down";
	const args = [
		"new-pane",
		"--direction",
		directionArg,
		"--name",
		name,
		"--cwd",
		process.cwd(),
	];

	let paneOut = "";
	try {
		paneOut = zellijActionSync(args, fromSurface);
	} catch {
		if (!fromSurface) throw new Error("Failed to create zellij pane");
		paneOut = zellijActionSync(args);
	}

	const paneId = paneOut.match(/(?:terminal_)?(\d+)/)?.[1] ?? "";
	if (!paneId || !/^\d+$/.test(paneId)) {
		throw new Error(
			`Unexpected zellij pane id: ${paneOut.trim() || "(empty)"}`,
		);
	}

	const surface = `pane:${paneId}`;
	if (direction === "left" || direction === "up") {
		try {
			zellijActionSync(["move-pane", direction], surface);
		} catch {}
	}
	try {
		zellijActionSync(["rename-pane", name], surface);
	} catch {}
	return surface;
}

export function createSurfaceSplit(
	name: string,
	direction: "left" | "right" | "up" | "down",
	fromSurface?: string,
): string {
	const backend = requireMuxBackend();
	if (backend === "cmux")
		return createCmuxSplit(name, direction, fromSurface);
	if (backend === "tmux")
		return createTmuxSplit(name, direction, fromSurface);
	if (backend === "wezterm")
		return createWezTermSplit(name, direction, fromSurface);
	return createZellijSplit(name, direction, fromSurface);
}

export function renameCurrentTab(title: string): void {
	const backend = requireMuxBackend();
	if (backend === "cmux") {
		const surfaceId = process.env.CMUX_SURFACE_ID;
		if (!surfaceId) throw new Error("CMUX_SURFACE_ID not set");
		execSync(
			`cmux rename-tab --surface ${shellEscape(surfaceId)} ${shellEscape(title)}`,
			{
				encoding: "utf8",
			},
		);
		return;
	}
	if (backend === "tmux") {
		if (process.env.PI_SUBAGENT_RENAME_TMUX_WINDOW !== "1") return;
		const paneId = process.env.TMUX_PANE;
		if (!paneId) throw new Error("TMUX_PANE not set");
		const windowId = execFileSync(
			"tmux",
			["display-message", "-p", "-t", paneId, "#{window_id}"],
			{ encoding: "utf8" },
		).trim();
		execFileSync("tmux", ["rename-window", "-t", windowId, title], {
			encoding: "utf8",
		});
		return;
	}
	if (backend === "wezterm") {
		const paneId = process.env.WEZTERM_PANE;
		const args = ["cli", "set-tab-title"];
		if (paneId) args.push("--pane-id", paneId);
		args.push(title);
		execFileSync("wezterm", args, { encoding: "utf8" });
		return;
	}
	const paneId = process.env.ZELLIJ_PANE_ID;
	if (paneId)
		zellijActionSync(["rename-pane", title], `pane:${paneId}`);
	else zellijActionSync(["rename-tab", title]);
}

export function renameWorkspace(title: string): void {
	const backend = requireMuxBackend();
	if (backend === "cmux") {
		execSync(
			`cmux workspace-action --action rename --title ${shellEscape(title)}`,
			{ encoding: "utf8" },
		);
		return;
	}
	if (backend === "tmux") {
		if (process.env.PI_SUBAGENT_RENAME_TMUX_SESSION !== "1") return;
		const paneId = process.env.TMUX_PANE;
		if (!paneId) throw new Error("TMUX_PANE not set");
		const sessionId = execFileSync(
			"tmux",
			["display-message", "-p", "-t", paneId, "#{session_id}"],
			{ encoding: "utf8" },
		).trim();
		execFileSync("tmux", ["rename-session", "-t", sessionId, title], {
			encoding: "utf8",
		});
		return;
	}
	if (backend === "wezterm") {
		const paneId = process.env.WEZTERM_PANE;
		const args = ["cli", "set-window-title"];
		if (paneId) args.push("--pane-id", paneId);
		args.push(title);
		try {
			execFileSync("wezterm", args, { encoding: "utf8" });
		} catch {}
	}
}
