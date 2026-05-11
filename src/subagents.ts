import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { AgentDefaults } from "./agents/definitions.ts";
import type { SubagentCatalogEntry } from "./agents/catalog-message.ts";
import {
	getAmbientCatalogEntries as getAmbientCatalogEntriesFromDefinitions,
	getSubagentCatalogSignature,
	isAmbientAwarenessDisabled,
	renderSubagentCatalogReminder,
} from "./agents/catalog-message.ts";
import {
	loadAgentDefaults as loadAgentDefaultsFromDefinitions,
} from "./agents/definitions.ts";
import { areSubagentSessionTitlesDisabled } from "./agents/titles.ts";
import { getNoSessionSeedMode } from "./launch/seed-child-session.ts";
import {
	getSubagentAgentOverrideError,
	getSubagentAgentRequirementError,
	resolveSubagentBlocking,
	resolveSubagentNoSession,
} from "./launch/policy.ts";
import { resolveSubagentCwd } from "./launch/runtime-paths.ts";
export { resolveSubagentConfigDir } from "./launch/runtime-paths.ts";
import {
	resolveEffectiveSessionMode as resolveEffectiveSessionModeFromSessionFiles,
	resolveTaskSessionMode as resolveTaskSessionModeFromSessionFiles,
	type SubagentSessionMode,
} from "./session/session-files.ts";
import { isMuxAvailable, muxSetupHint } from "./mux.ts";
import type { SubagentParamsInput } from "./types.ts";
import {
	formatElapsed,
	getLaunchedSubagentResult,
	getShellReadyDelayMs,
	getWatcherSignal,
	joinSubagentResults,
	launchBackgroundSubagent,
	launchSubagent,
	moduleAbortController,
	runningSubagents,
	shutdownSubagentsForParentExit,
	startWidgetRefresh,
	stopRunningSubagent,
	watchBackgroundSubagent,
	watchSubagent,
	widgetManager,
	wireSubagentSteerBack,
} from "./runtime/wiring.ts";
export { getShellReadyDelayMs } from "./runtime/wiring.ts";
export {
	getCompletedSubagentResultForTest,
	getLaunchedSubagentResultForTest,
	getPiInvocationForTest,
	getPiShellPartsForTest,
	getStartedSubagentDetailsForTest,
	getSubagentChildProcessEnvForTest,
	joinSubagentsForTest,
	renderSubagentWidgetForTest,
	resetSubagentStateForTest,
	routeDetachedSubagentCompletionForTest,
	setRunningSubagentForTest,
	shutdownSubagentsForTest,
	waitForSubagentForTest,
} from "./runtime/wiring.ts";
import {
	requestSubagentBatchStop,
	resetSubagentBatchStopRequest,
} from "./runtime/state.ts";
import { registerSubagentCommands } from "./tools/commands.ts";
import { registerSubagentMessageRenderers } from "./tools/message-renderers.ts";
import { registerSubagentResumeTool } from "./tools/resume-tool.ts";
import { registerSubagentCoreTools } from "./tools/subagent-tools.ts";
export * from "./testing/test-helpers.ts";

export function loadAgentDefaults(
	agentName: string,
	cwdHint?: string | null,
	baseCwd = process.cwd(),
): AgentDefaults | null {
	return loadAgentDefaultsFromDefinitions(
		agentName,
		cwdHint,
		baseCwd,
		resolveSubagentCwd,
	);
}

function getAmbientCatalogEntries(
	baseCwd = process.cwd(),
): SubagentCatalogEntry[] {
	return getAmbientCatalogEntriesFromDefinitions(baseCwd, resolveTaskSessionMode);
}

function resolveEffectiveSessionMode(
	params: Partial<SubagentParamsInput>,
	agentDefs: AgentDefaults | null,
): SubagentSessionMode {
	return resolveEffectiveSessionModeFromSessionFiles(params, agentDefs);
}

function resolveTaskSessionMode(
	agentDefs: AgentDefaults | null,
): SubagentSessionMode {
	return resolveTaskSessionModeFromSessionFiles(
		agentDefs,
		resolveSubagentNoSession,
		getNoSessionSeedMode,
	);
}

let lastAmbientCatalogSignature: string | null = null;
let pendingAmbientCatalogReminder: {
	signature: string;
	content: string;
	entries: SubagentCatalogEntry[];
	supersedes?: true;
} | null = null;

function muxUnavailableResult(kind: "subagents" | "tab-title" = "subagents") {
	const text = kind === "tab-title"
		? `Terminal multiplexer not available. ${muxSetupHint()}`
		: `Subagents require a supported terminal multiplexer. ${muxSetupHint()}`;
	return {
		content: [{ type: "text" as const, text }],
		details: { error: "mux not available" },
	};
}

export default function subagentsExtension(pi: ExtensionAPI) {
	function attachWidgetContext(ctx: ExtensionContext) {
		widgetManager.attachContext(ctx);
	}

	function applySubagentLineage(ctx: ExtensionContext) {
		const parentSession = process.env.PI_SUBAGENT_PARENT_SESSION?.trim();
		if (!parentSession) return;
		const header = ctx.sessionManager.getHeader?.();
		if (!header || header.parentSession) return;
		header.parentSession = parentSession;
	}

	function applySubagentSessionTitle(ctx: ExtensionContext) {
		if (areSubagentSessionTitlesDisabled()) return;
		const title = process.env.PI_SUBAGENT_SESSION_TITLE?.trim();
		if (!title || ctx.sessionManager.getSessionName?.() === title) return;
		pi.setSessionName(title);
	}

	// Capture the UI context early so the widget keeps a stable slot above tasks.
	pi.on("session_start", (event, ctx) => {
		resetSubagentBatchStopRequest();
		applySubagentLineage(ctx);
		applySubagentSessionTitle(ctx);
		attachWidgetContext(ctx);
		if (isAmbientAwarenessDisabled()) {
			pendingAmbientCatalogReminder = null;
			return;
		}
		if (!shouldRegister("subagent")) return;
		if (ctx.sessionManager.getHeader()?.parentSession) return;

		// Reset the cached signature on every fresh session so that module-level
		// state does not persist across TIA sessions. The reload path still uses
		// the cached signature to avoid duplicating the notification within the
		// same session.
		if (event.reason !== "reload") {
			lastAmbientCatalogSignature = null;
		}

		const entries = getAmbientCatalogEntries(ctx.cwd);
		const signature = getSubagentCatalogSignature(entries);
		if (entries.length === 0) {
			if (event.reason === "reload") pendingAmbientCatalogReminder = null;
			lastAmbientCatalogSignature = null;
			return;
		}

		if (signature === lastAmbientCatalogSignature) {
			pendingAmbientCatalogReminder = null;
			return;
		}

		pendingAmbientCatalogReminder = {
			signature,
			content: renderSubagentCatalogReminder(entries),
			entries,
			supersedes: event.reason === "reload" ? true : undefined,
		};
	});

	pi.on("before_agent_start", () => {
		if (isAmbientAwarenessDisabled()) {
			pendingAmbientCatalogReminder = null;
			return undefined;
		}
		if (!pendingAmbientCatalogReminder) return undefined;

		const reminder = pendingAmbientCatalogReminder;
		lastAmbientCatalogSignature = reminder.signature;
		pendingAmbientCatalogReminder = null;
		return {
			message: {
				customType: "subagent_catalog",
				content: reminder.content,
				display: false,
				details: {
					entries: reminder.entries,
					signature: reminder.signature,
					...(reminder.supersedes ? { supersedes: true } : {}),
				},
			},
		};
	});

	pi.on("input", () => {
		resetSubagentBatchStopRequest();
		return { action: "continue" as const };
	});

	pi.on("tool_call", (event) => {
		if (event.toolName !== "subagent") return {};
		const input = event.input as Partial<SubagentParamsInput>;
		const agentDefs =
			typeof input.agent === "string"
				? loadAgentDefaults(
						input.agent,
						typeof input.cwd === "string" ? input.cwd : undefined,
					)
				: null;
		const agentError = getSubagentAgentRequirementError(input, agentDefs);
		const agentOverrideError = getSubagentAgentOverrideError(input, agentDefs);
		if (
			!agentError &&
			!agentOverrideError &&
			!resolveSubagentBlocking(input, agentDefs)
		) {
			requestSubagentBatchStop();
		}
		return {};
	});

	pi.on("turn_start", () => {
		resetSubagentBatchStopRequest();
	});

	pi.on("agent_end", () => {
		resetSubagentBatchStopRequest();
	});

	// Clean up on session shutdown
	pi.on("session_shutdown", (_event, ctx) => {
		moduleAbortController.abort();
		widgetManager.reset();
		resetSubagentBatchStopRequest();
		shutdownSubagentsForParentExit();
		if (ctx.hasUI) {
			ctx.ui.setWidget("subagent-status", undefined);
		}
	});

	// Tools denied via PI_DENY_TOOLS env var (set by parent agent based on frontmatter)
	const deniedTools = new Set(
		(process.env.PI_DENY_TOOLS ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);

	const shouldRegister = (name: string) => !deniedTools.has(name);
	const hideSubagentsListForAmbientTopLevel =
		!process.env.PI_SUBAGENT_SESSION &&
		!isAmbientAwarenessDisabled() &&
		shouldRegister("subagent");

	registerSubagentCoreTools(pi, shouldRegister, hideSubagentsListForAmbientTopLevel, {
		loadAgentDefaults: (agentName, cwd) => agentName ? loadAgentDefaults(agentName, undefined, cwd) : null,
		resolveEffectiveSessionMode,
		resolveTaskSessionMode,
		launchBackgroundSubagent,
		launchSubagent,
		watchBackgroundSubagent,
		watchSubagent,
		getWatcherSignal,
		wireSubagentSteerBack,
		startWidgetRefresh,
		getLaunchedSubagentResult,
		joinSubagentResults,
		stopRunningSubagent,
		muxUnavailableResult: () => muxUnavailableResult("tab-title"),
	});

	registerSubagentResumeTool(pi, shouldRegister, {
		getShellReadyDelayMs,
		isMuxAvailable,
		watchBackgroundSubagent,
		watchSubagent,
		getWatcherSignal,
		wireSubagentSteerBack,
		startWidgetRefresh,
		runningSubagents,
	});

	registerSubagentCommands(pi, {
		loadAgentDefaults: (agentName, cwd) => loadAgentDefaults(agentName, null, cwd),
		stopRunningSubagent,
	});

	registerSubagentMessageRenderers(pi, formatElapsed);
}
