import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import type { AgentDefaults } from "../agents/definitions.ts";
import { getEffectiveAgentDefinitions } from "../agents/definitions.ts";
import { getSessionModeMemoryLabel } from "../agents/catalog-message.ts";
import {
	enforceAgentFrontmatter,
	getSubagentAgentRequirementError,
	getUnknownForkContextWindowError,
	resolveSubagentNoSession,
} from "../launch/policy.ts";
import type { SubagentLaunchContext } from "../launch/prep.ts";
import { isMuxAvailable, muxSetupHint, renameCurrentTab, renameWorkspace } from "../mux.ts";
import { findRunningSubagent } from "../runtime/running-registry.ts";
import type { RunningSubagent, SubagentParamsInput, SubagentsListToolDetails, SubagentResult } from "../types.ts";
import { asSubagentToolResult, getCoordinatorOnlyTurnPrompt } from "../runtime/state.ts";
import { getNoSessionSeedMode } from "../launch/seed-child-session.ts";
import { isSetTabTitleToolEnabled } from "../agents/titles.ts";
import { getSubagentToolsConfigError } from "./policy.ts";

const SubagentParams = Type.Object({
	name: Type.String({ description: "Display name for the subagent" }),
	task: Type.String({ description: "Task/prompt for the sub-agent" }),
	title: Type.String({ description: "Required human title for this child session/widget. The parent agent must write it from its delegation context: sentence case, 3-15 words, outcome/objective focused, and not a prompt or instruction." }),
	agent: Type.String({ description: "Required agent definition name. Reads .pi/agents/<name>.md or ~/.pi/agent/agents/<name>.md and refuses ad-hoc unnamed subagents." }),
});
const SubagentKillParams = Type.Object({ id: Type.String({ description: "Running subagent id or display name to stop" }) });
const SubagentJoinParams = Type.Object({
	ids: Type.Array(Type.String({ description: "Child id or unique display name to join" }), { description: "Child ids or unique display names to join" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
	onTimeout: Type.Optional(Type.Union([Type.Literal("error"), Type.Literal("return_partial"), Type.Literal("detach"), Type.Literal("return")], { description: "How to handle a timeout. Defaults to error. Use return_partial, detach, or return to release ownership and return partial results." })),
});

type ToolResult = ReturnType<typeof asSubagentToolResult>;

export interface SubagentToolRuntime {
	loadAgentDefaults(agentName: string | undefined, cwd: string): AgentDefaults | null;
	resolveEffectiveSessionMode(params: Partial<SubagentParamsInput>, defs: AgentDefaults | null): string;
	resolveTaskSessionMode(defs: AgentDefaults): string;
	launchBackgroundSubagent(params: SubagentParamsInput, ctx: SubagentLaunchContext): Promise<RunningSubagent>;
	launchSubagent(params: SubagentParamsInput, ctx: SubagentLaunchContext): Promise<RunningSubagent>;
	watchBackgroundSubagent(running: RunningSubagent, signal: AbortSignal, timeout?: number): Promise<SubagentResult>;
	watchSubagent(running: RunningSubagent, signal: AbortSignal): Promise<SubagentResult>;
	getWatcherSignal(running: RunningSubagent, controller: AbortController): AbortSignal;
	wireSubagentSteerBack(pi: ExtensionAPI, running: RunningSubagent, promise: Promise<SubagentResult>): void;
	startWidgetRefresh(): void;
	getLaunchedSubagentResult(running: RunningSubagent, signal?: AbortSignal): Promise<ToolResult>;
	joinSubagentResults(params: unknown, signal: AbortSignal | undefined, pi: ExtensionAPI): Promise<unknown>;
	stopRunningSubagent(running: RunningSubagent): void;
	muxUnavailableResult(action: string): unknown;
}

function resolveModelContextWindow(ctx: ExtensionContext, modelRef: string | undefined) {
	if (!modelRef || !ctx.modelRegistry) return undefined;
	const slashIdx = modelRef.indexOf("/");
	if (slashIdx <= 0) return undefined;
	const provider = modelRef.slice(0, slashIdx);
	const modelId = modelRef.slice(slashIdx + 1);
	const candidates = [modelId, modelId.replace(/:[^:]+$/, "")].filter(Boolean);
	const model = [...new Set(candidates)].map((c) => ctx.modelRegistry?.find(provider, c)).find(Boolean);
	return model?.contextWindow;
}

function renderTaskPreview(task: string | undefined, theme: Parameters<NonNullable<Parameters<ExtensionAPI["registerTool"]>[0]["renderCall"]>>[1]) {
	if (!task) return "";
	const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
	const preview = firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine;
	let text = preview ? `\n${theme.fg("toolOutput", preview)}` : "";
	const totalLines = task.split("\n").length;
	if (totalLines > 1) text += theme.fg("muted", ` (${totalLines} lines)`);
	return text;
}

export function registerSubagentCoreTools(
	pi: ExtensionAPI,
	shouldRegister: (name: string) => boolean,
	hideSubagentsListForAmbientTopLevel: boolean,
	runtime: SubagentToolRuntime,
): void {
	if (shouldRegister("subagent")) pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: "Spawn a named sub-agent from an existing agent definition for specialist or parallelizable work. When multiple independent subagents are needed, emit all of their subagent tool calls in the same assistant message before waiting or replying. The agent frontmatter is authoritative for all runtime settings; the parent only provides name, task, title, and which agent to launch. ",
		promptSnippet: "Use subagents for specialist, complex, or parallelizable work when the named-agent catalog suggests a good match. Agent frontmatter is authoritative for all runtime settings — mode, model, async/sync policy, tools, session mode — the parent only provides name, task, title, and which agent to launch. CRITICAL parallel-launch rule: when a task calls for multiple independent subagents, emit every independent subagent tool call in the same assistant message/tool-call batch before waiting, reading results, or replying. Do not serialize independent subagent launches one at a time, even when a named agent is sync; the runtime will handle the launch policy after the launch batch is emitted. Keep launches explicit and use one subagent tool call per child. Use exact catalog names in the agent field. If the user names several agents, launch each named agent exactly once; do not reuse one agent as a substitute for another. Interactive agents run in panes; background agents run headlessly; named-agent frontmatter is authoritative for runtime settings, and call-time duplicates for named agents are ignored instead of overriding it. Before calling subagent, translate the user's request into the child task; do not change the work based on the agent name. Use the catalog/list memory label only to decide context: isolated context starts a fresh chat, so write a self-contained task with objective, relevant facts/files, constraints, and expected output; forked context continues this conversation on a new branch, so give goal, boundary, and expected output without re-explaining everything. Handle trivial single-file reads, quick direct answers, and tiny one-shot edits yourself instead of delegating. Delegation ownership rule: after launching subagents, the parent may continue only with explicitly non-overlapping parent-owned work. Do not redo delegated work. If no safe independent work is clear, end the response and let async results arrive by steer. Ask the user only when there is a plausible next step but ownership is ambiguous. Use subagent_join only for explicit sync gates or short non-blocking status probes. " + getCoordinatorOnlyTurnPrompt(),
		parameters: SubagentParams,
		execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
			const agentDefs = runtime.loadAgentDefaults(params.agent, ctx.cwd);
			const agentError = getSubagentAgentRequirementError(params, agentDefs);
			if (agentError) throw new Error(agentError.content[0]?.text ?? "Agent requirement error");
			const toolsConfigError = getSubagentToolsConfigError(agentDefs?.tools, params.agent);
			if (toolsConfigError) throw new Error(toolsConfigError.content[0]?.text ?? "Tools config error");
			// In headless mode (no UI / print mode), force auto-exit so that
			// manual-lifecycle agents don't hang forever without an operator.
			// The override is applied in prepareSubagentLaunch via ctx.autoExit.
			const headlessAutoExit = !ctx.hasUI && agentDefs?.autoExit !== true ? true : undefined;
			const effectiveParams = enforceAgentFrontmatter(params, agentDefs);
			const currentAgent = process.env.PI_SUBAGENT_AGENT;
			if (effectiveParams.agent && currentAgent && effectiveParams.agent === currentAgent) {
				throw new Error(`You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`);
			}
			if (!ctx.sessionManager.getSessionFile()) throw new Error("No session file. Start pi with a persistent session to use subagents.");
			const isBackground = effectiveParams.background ?? agentDefs?.mode === "background";
			const childModelRef = effectiveParams.model ?? agentDefs?.model;
			const childModelContextWindow = resolveModelContextWindow(ctx, childModelRef);
			const effectiveSessionMode = runtime.resolveEffectiveSessionMode(effectiveParams, agentDefs);
			const effectiveNoSession = resolveSubagentNoSession(agentDefs);
			const effectiveSeedMode = effectiveNoSession ? getNoSessionSeedMode(effectiveSessionMode as never) : effectiveSessionMode === "standalone" ? null : effectiveSessionMode;
			if (effectiveSeedMode === "fork" && !childModelContextWindow) {
				const err = getUnknownForkContextWindowError(effectiveParams.agent, childModelRef);
				throw new Error(err.content[0]?.text ?? "Unknown fork context window");
			}
			const launchCtx: SubagentLaunchContext = { sessionManager: ctx.sessionManager, cwd: ctx.cwd, childModelContextWindow, launchToolCallId: toolCallId, autoExit: headlessAutoExit };
			let running: RunningSubagent;
			if (isBackground) {
				running = await runtime.launchBackgroundSubagent(effectiveParams, launchCtx);
				const watcherAbort = new AbortController();
				running.abortController = watcherAbort;
				running.completionPromise = runtime.watchBackgroundSubagent(running, runtime.getWatcherSignal(running, watcherAbort), agentDefs?.timeout);
			} else if (ctx.hasUI && isMuxAvailable()) {
				running = await runtime.launchSubagent(effectiveParams, launchCtx);
				const watcherAbort = new AbortController();
				running.abortController = watcherAbort;
				running.completionPromise = runtime.watchSubagent(running, runtime.getWatcherSignal(running, watcherAbort));
			} else {
				// Fall back to background when there's no UI (print/RPC mode) or no
				// multiplexer. Interactive panes need a live parent session to deliver
				// results — in one-shot mode the parent exits after the tool result.
				running = await runtime.launchBackgroundSubagent(effectiveParams, launchCtx);
				const watcherAbort = new AbortController();
				running.abortController = watcherAbort;
				running.completionPromise = runtime.watchBackgroundSubagent(running, runtime.getWatcherSignal(running, watcherAbort), agentDefs?.timeout);
			}
			runtime.startWidgetRefresh();
			runtime.wireSubagentSteerBack(pi, running, running.completionPromise);
			return runtime.getLaunchedSubagentResult(running, signal);
		},
		renderCall(args, theme) {
			const agent = args.agent ? theme.fg("dim", ` (${args.agent})`) : "";
			return new Text("▸ " + theme.fg("toolTitle", theme.bold("Start")) + " " + theme.fg("toolTitle", theme.bold(args.name ?? "subagent")) + agent + renderTaskPreview(args.task, theme), 0, 0);
		},
		renderResult() { return new Text("", 0, 0); },
	});

	if (shouldRegister("subagent_join")) pi.registerTool({
		name: "subagent_join", label: "Join Subagents",
		description: "Wait for a fixed set of child results by id or unique display name and return one grouped result.",
		promptSnippet: "Wait for a fixed set of child results by id or unique display name and return one grouped result. This creates a sync gate and blocks unless you provide a short timeout with onTimeout return_partial/detach/return. Do not use it by default after async launches; prefer yielding for steer delivery unless the user requested a sync gate or the next step truly depends on these results.",
		parameters: SubagentJoinParams,
		async execute(_toolCallId, params, signal) {
			const result = await runtime.joinSubagentResults(params, signal, pi);
			const details = (result as { details?: Record<string, unknown> }).details;
			if (details?.error) {
				const content = (result as { content?: Array<{ text?: string }> }).content;
				throw new Error(content?.[0]?.text ?? String(details.error));
			}
			return asSubagentToolResult(result);
		},
		renderCall(args, theme) {
			const count = Array.isArray(args.ids) ? args.ids.length : 0;
			return new Text("▸ " + theme.fg("toolTitle", theme.bold("Await")) + theme.fg("dim", ` ${count} agent${count === 1 ? "" : "s"}`), 0, 0);
		},
		renderResult() { return new Text("", 0, 0); },
	});

	if (shouldRegister("subagents_list") && !hideSubagentsListForAmbientTopLevel) pi.registerTool({
		name: "subagents_list", label: "List Subagents",
		description: "List all available subagent definitions. Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. Project-local agents override global ones with the same name.",
		promptSnippet: "List all available subagent definitions. Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. Project-local agents override global ones with the same name.",
		parameters: Type.Object({}),
		async execute() {
			const agents = getEffectiveAgentDefinitions();
			if (agents.length === 0) return { content: [{ type: "text", text: "No subagent definitions found." }], details: { agents: [] } };
			const lines = agents.map((a) => {
				const badge = a.source === "project" ? " (project)" : "";
				const sessionTag = ` [${getSessionModeMemoryLabel(runtime.resolveTaskSessionMode(a) as never)}]`;
				const desc = a.description ? ` — ${a.description}` : "";
				return `• ${a.name}${badge}${sessionTag}${desc}`;
			});
			return { content: [{ type: "text", text: lines.join("\n") }], details: { agents } };
		},
		renderResult(result, _opts, theme) {
			const details = result.details as SubagentsListToolDetails | undefined;
			const agents = details?.agents ?? [];
			if (agents.length === 0) return new Text(theme.fg("dim", "No subagent definitions found."), 0, 0);
			const lines = agents.map((a) => {
				const badge = a.source === "project" ? theme.fg("accent", " (project)") : "";
				const sessionTag = theme.fg("dim", ` [${getSessionModeMemoryLabel(runtime.resolveTaskSessionMode(a as AgentDefaults) as never)}]`);
				const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
				return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${sessionTag}${desc}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	pi.registerTool({
		name: "subagent_kill", label: "Kill Subagent",
		description: "Stop a running subagent by id or display name. Works for both background and interactive subagents.",
		promptSnippet: "Stop a running subagent by id or display name. Works for both background and interactive subagents.",
		parameters: SubagentKillParams,
		execute: async (_toolCallId, params) => {
			const match = findRunningSubagent(params.id);
			if (!match.running) return asSubagentToolResult({ content: [{ type: "text" as const, text: match.error ?? "Subagent not found." }], details: { error: match.error ?? "not found" } });
			runtime.stopRunningSubagent(match.running);
			return asSubagentToolResult({ content: [{ type: "text" as const, text: `Stopping subagent "${match.running.name}" (${match.running.id}).` }], details: { id: match.running.id, name: match.running.name, status: "stopping" } });
		},
	});

	if (isSetTabTitleToolEnabled() && shouldRegister("set_tab_title")) pi.registerTool({
		name: "set_tab_title", label: "Set Tab Title",
		description: "Update the current tab/window and workspace/session title. Use to show progress during multi-phase workflows (e.g. setup, executing todos, reviewing). Keep titles short and informative.",
		promptSnippet: "Update the current tab/window and workspace/session title. Use to show progress during multi-phase workflows (e.g. setup, executing todos, reviewing). Keep titles short and informative.",
		parameters: Type.Object({ title: Type.String({ description: "New tab title (also applied to workspace/session when supported)" }) }),
		execute: async (_toolCallId, params) => {
			if (!isMuxAvailable()) return asSubagentToolResult(runtime.muxUnavailableResult("tab-title"));
			try {
				renameCurrentTab(params.title); renameWorkspace(params.title);
				return asSubagentToolResult({ content: [{ type: "text" as const, text: `Title set to: ${params.title}` }], details: { title: params.title } });
			} catch (err: unknown) {
				const errorMessage = err instanceof Error ? err.message : String(err);
				return asSubagentToolResult({ content: [{ type: "text" as const, text: `Failed to set title: ${errorMessage}` }], details: { error: errorMessage } });
			}
		},
	});
}
