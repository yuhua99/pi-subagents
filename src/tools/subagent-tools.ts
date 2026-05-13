import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import type { AgentDefaults } from "../agents/definitions.ts";
import {
	enforceAgentFrontmatter,
	getSubagentAgentRequirementError,
	getUnknownForkContextWindowError,
	resolveSubagentBlocking,
	resolveSubagentNoSession,
} from "../launch/policy.ts";
import type { SubagentLaunchContext } from "../launch/prep.ts";
import { isMuxAvailable, muxSetupHint, renameCurrentTab, renameWorkspace } from "../mux.ts";
import { findRunningSubagent } from "../runtime/running-registry.ts";
import type { RunningSubagent, SubagentParamsInput, SubagentResult } from "../types.ts";
import { asSubagentToolResult, getCoordinatorOnlyTurnPrompt, markSubagentBatchBlocking } from "../runtime/state.ts";
import { getNoSessionSeedMode } from "../launch/seed-child-session.ts";
import { isSetTabTitleToolEnabled } from "../agents/titles.ts";
import { formatSubagentBatchLines, formatTaskPreview, renderSubagentCompletionText } from "./message-renderers.ts";
import { getSubagentToolsConfigError } from "./policy.ts";

const SubagentChildParams = Type.Object({
	name: Type.String({ description: "Display name for the subagent" }),
	task: Type.String({ description: "Task/prompt for the sub-agent. For non-trivial work, write readable Markdown: short paragraphs, bullets, or headings as appropriate. Use a one-line task only for trivial work." }),
	title: Type.String({ description: "Required human title for this child session/widget. The parent agent must write it from its delegation context: sentence case, 3-15 words, outcome/objective focused, and not a prompt or instruction." }),
	agent: Type.String({ description: "Required agent definition name. Reads .pi/agents/<name>.md or ~/.pi/agent/agents/<name>.md and refuses ad-hoc unnamed subagents." }),
});

const SubagentParams = Type.Object({
	name: Type.Optional(Type.String({ description: "Display name for a single subagent launch" })),
	task: Type.Optional(Type.String({ description: "Task/prompt for a single sub-agent launch. For non-trivial work, write readable Markdown: short paragraphs, bullets, or headings as appropriate. Use a one-line task only for trivial work." })),
	title: Type.Optional(Type.String({ description: "Required human title for a single child session/widget. Sentence case, 3-15 words, outcome/objective focused, and not a prompt or instruction." })),
	agent: Type.Optional(Type.String({ description: "Required agent definition name for a single subagent launch." })),
	children: Type.Optional(Type.Array(SubagentChildParams, { description: "Spawn multiple children in one deterministic launch. Use this instead of multiple separate subagent tool calls when a user asks for more than one agent." })),
});
const SubagentKillParams = Type.Object({ id: Type.String({ description: "Running subagent id or display name to stop" }) });

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

type SubagentToolParams = Partial<SubagentParamsInput> & { children?: SubagentParamsInput[] };

function getRequestedChildren(params: SubagentToolParams): SubagentParamsInput[] {
	if (Array.isArray(params.children) && params.children.length > 0) return params.children;
	return [params as SubagentParamsInput];
}

function getLaunchError(params: SubagentParamsInput, agentDefs: AgentDefaults | null, currentAgent: string | undefined): string | null {
	const agentError = getSubagentAgentRequirementError(params, agentDefs);
	if (agentError) return agentError.content[0]?.text ?? "Agent requirement error";
	const toolsConfigError = getSubagentToolsConfigError(agentDefs?.tools, params.agent);
	if (toolsConfigError) return toolsConfigError.content[0]?.text ?? "Tools config error";
	if (params.agent && currentAgent && params.agent === currentAgent) {
		return `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`;
	}
	return null;
}

async function launchOneSubagent(
	toolCallId: string,
	params: SubagentParamsInput,
	agentDefs: AgentDefaults | null,
	ctx: ExtensionContext,
	runtime: SubagentToolRuntime,
): Promise<RunningSubagent> {
	const headlessAutoExit = !ctx.hasUI && agentDefs?.autoExit !== true ? true : undefined;
	const effectiveParams = enforceAgentFrontmatter(params, agentDefs);
	// In headless mode there is no steer mechanism, so async subagent results
	// would be lost. Force blocking to deliver the result synchronously.
	if (!ctx.hasUI) {
		effectiveParams.async = false;
		effectiveParams.blocking = true;
	}
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
		running = await runtime.launchBackgroundSubagent(effectiveParams, launchCtx);
		const watcherAbort = new AbortController();
		running.abortController = watcherAbort;
		running.completionPromise = runtime.watchBackgroundSubagent(running, runtime.getWatcherSignal(running, watcherAbort), agentDefs?.timeout);
	}
	return running;
}

export function registerSubagentCoreTools(
	pi: ExtensionAPI,
	shouldRegister: (name: string) => boolean,
	runtime: SubagentToolRuntime,
): void {
	if (shouldRegister("subagent")) pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Launch one or more named helper agents from the subagent roster. " +
			"Agent definitions control model, tools, context, UI mode, wait behavior, and completion lifecycle; " +
			"this call only chooses the agent name(s) and task(s).",
		promptSnippet:
			"Subagents are separate helper processes you can launch to do work outside this chat turn.\n" +
			"\n" +
			"Use this tool when a listed agent is a clear fit for specialist, complex, or parallel work. Do small direct work yourself: quick answers, simple file reads, and tiny one-shot edits.\n" +
			"\n" +
			"Use exact agent names and behavior fields from the subagent roster when present; field meanings are defined in <subagent-rules>.\n" +
			"\n" +
			"How to call:\n" +
			"- Use exact roster names in agent fields.\n" +
			"- If launching one helper, pass agent/name/title/task normally.\n" +
			"- If launching multiple helpers for one user request, make one subagent call with children:[...] so all helpers start before any waiting happens.\n" +
			"- If the user names multiple agents, include each named agent exactly once. Do not substitute one agent for another.\n" +
			"\n" +
			"Writing tasks:\n" +
			"- Translate the user's request into each helper's task; do not change the work just because of the agent name.\n" +
			"- For non-trivial work, write readable Markdown with objective, scope, relevant files/facts, constraints, and requested output.\n" +
			"- For parallel helpers, make each task non-overlapping.\n" +
			"\n" +
			"After launch:\n" +
			"- If a helper returns later, continue only with clearly independent work. Do not redo delegated work and do not claim the helper's findings before its later message appears.\n" +
			"- If no safe independent work is clear, stop your response and wait for the later helper message.\n" +
			"- Ask the user only when there is a plausible next step but ownership is ambiguous.\n" +
			getCoordinatorOnlyTurnPrompt(),
		parameters: SubagentParams,
		execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
			const children = getRequestedChildren(params as SubagentToolParams);
			const currentAgent = process.env.PI_SUBAGENT_AGENT;
			const prepared = children.map((child) => {
				const agentDefs = runtime.loadAgentDefaults(child.agent, ctx.cwd);
				const error = getLaunchError(child, agentDefs, currentAgent);
				if (error) throw new Error(error);
				return { child, agentDefs, blocking: resolveSubagentBlocking(child, agentDefs) };
			});
			const hasBlockingChild = prepared.some((entry) => entry.blocking);
			if (prepared.length > 1 && hasBlockingChild) {
				markSubagentBatchBlocking();
			}

			const launched: RunningSubagent[] = [];
			for (const entry of prepared) {
				const running = await launchOneSubagent(toolCallId, entry.child, entry.agentDefs, ctx, runtime);
				launched.push(running);
				runtime.wireSubagentSteerBack(pi, running, running.completionPromise!);
			}
			runtime.startWidgetRefresh();
			if (launched.length === 1) return runtime.getLaunchedSubagentResult(launched[0], signal);

			const results = await Promise.all(launched.map((running) => runtime.getLaunchedSubagentResult(running, signal)));
			const texts = results.flatMap((result) => result.content).filter((block) => block.type === "text").map((block) => block.text);
			return asSubagentToolResult({
				content: [{ type: "text", text: texts.join("\n\n") }],
				details: {
					status: hasBlockingChild ? "batch" : "started",
					children: results.map((result, index) => ({
						...(result.details as Record<string, unknown>),
						task: prepared[index]?.child.task,
						title: prepared[index]?.child.title,
						agent: prepared[index]?.child.agent,
						name: (result.details as { name?: string } | undefined)?.name ?? prepared[index]?.child.name,
					})),
				},
			});
		},
		renderCall(args, theme, context) {
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			const children = Array.isArray(args.children) ? args.children : undefined;
			if (children?.length) {
				const lines = [`▸ ${theme.fg("toolTitle", theme.bold("Spawn"))} ${theme.fg("toolTitle", theme.bold(`${children.length} agents`))}`, ""];
				children.forEach((child, index) => {
					if (index > 0) lines.push("");
					const agent = child.agent ? theme.fg("dim", ` (${child.agent})`) : "";
					lines.push(`${theme.fg("accent", theme.bold(child.name ?? "subagent"))}${agent}`);
					const taskPreview = formatTaskPreview(child.task, context, theme).replace(/^\n/, "");
					if (taskPreview) lines.push(taskPreview);
				});
				text.setText(lines.join("\n"));
				return text;
			}
			const agent = args.agent ? theme.fg("dim", ` (${args.agent})`) : "";
			text.setText("▸ " + theme.fg("toolTitle", theme.bold("Spawn")) + " " + theme.fg("accent", theme.bold(args.name ?? "subagent")) + agent + formatTaskPreview(args.task, context, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const details = result.details as { status?: string; children?: unknown[] } | undefined;
			if (details?.children) {
				if (details.status !== "batch") return new Text("", 0, 0);
				const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
				component.setText(`\n${formatSubagentBatchLines(result, context.args, options, theme).join("\n")}`);
				return component;
			}
			if (details?.status !== "completed" && details?.status !== "failed" && details?.status !== "cancelled") {
				return new Text("", 0, 0);
			}
			return renderSubagentCompletionText(result, options, theme, context.lastComponent instanceof Text ? context.lastComponent : undefined, true);
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
