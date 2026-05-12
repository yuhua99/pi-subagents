import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentToolResult, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { getArtifactStorageRoot } from "../artifact-storage.ts";
import { getPiInvocation, getPiShellParts, getSubagentChildProcessEnv } from "../launch/child-command.ts";
import { getExtensionLaunchArgs, getPersistedPromptLaunchArgs, getPersistedSessionParityArgs } from "../launch/prep.ts";
import { createSurface, exitStatusVar, sendCommand, sendShellCommand, shellEscape, muxSetupHint } from "../mux.ts";
import { buildResumePiArgs, buildShellChangeDirectoryPrefix, getResumeCwd, resolveResumeLaunchMetadata } from "../launch/resume.ts";
import type { ResumeToolDetails, RunningSubagent, SubagentResult } from "../types.ts";
import { getEntryCount } from "../session/session.ts";
import { getDoneSentinelFile, isResumeMode, readSubagentExtensionEntry, readSubagentLaunchMetadata } from "../session/session-files.ts";
import { formatTaskPreview, renderSubagentCompletionText } from "./message-renderers.ts";

export interface ResumeToolRuntime {
	getShellReadyDelayMs(): number;
	isMuxAvailable(): boolean;
	watchBackgroundSubagent(running: RunningSubagent, signal: AbortSignal): Promise<SubagentResult>;
	watchSubagent(running: RunningSubagent, signal: AbortSignal): Promise<SubagentResult>;
	getWatcherSignal(running: RunningSubagent, controller: AbortController): AbortSignal;
	wireSubagentSteerBack(pi: ExtensionAPI, running: RunningSubagent, promise: Promise<SubagentResult>): void;
	startWidgetRefresh(): void;
	getLaunchedSubagentResult(running: RunningSubagent, signal?: AbortSignal): Promise<AgentToolResult<unknown>>;
	runningSubagents: Map<string, RunningSubagent>;
}

function rememberTail(current: string | undefined, chunk: Buffer | string) {
	return `${current ?? ""}${chunk.toString()}`.slice(-4000);
}

export function registerSubagentResumeTool(
	pi: ExtensionAPI,
	shouldRegister: (name: string) => boolean,
	runtime: ResumeToolRuntime,
): void {
	if (!shouldRegister("subagent_resume")) return;
	pi.registerTool({
		name: "subagent_resume",
		label: "Resume Subagent",
		description:
			"Resume a previous sub-agent session in a new multiplexer pane. " +
			"IMPORTANT: Returns IMMEDIATELY — the resumed session runs asynchronously in the background. " +
			"Results are delivered later via a steer message. Do NOT fabricate or assume results. " +
			"Use when a sub-agent was cancelled or needs follow-up work.",
		promptSnippet:
			"Resume a previous sub-agent session in a new multiplexer pane. " +
			"IMPORTANT: Returns IMMEDIATELY — the resumed session runs asynchronously in the background. " +
			"Results are delivered later via a steer message. Do NOT fabricate or assume results. " +
			"Use when a sub-agent was cancelled or needs follow-up work.",
		parameters: Type.Object({
			sessionFile: Type.Optional(Type.String({ description: "Path to the session .jsonl file to resume" })),
			name: Type.Optional(Type.String({ description: "Display name for the terminal tab. Default: 'Resume'" })),
			task: Type.Optional(Type.String({ description: "Optional follow-up task to send after resuming" })),
			agent: Type.Optional(Type.String({ description: "Agent name for display. Use the original agent name from the session being resumed." })),
			mode: Type.Optional(Type.Union([Type.Literal("background"), Type.Literal("interactive")], { description: "Explicit resume mode when launch metadata cannot be inferred. Defaults to the original mode when known, otherwise interactive fallback." })),
		}),
		renderCall(args, theme, context) {
			const name = args.name && args.name !== "Resume" ? args.name : "subagent";
			const agentBadge = args.agent ? theme.fg("dim", ` (${args.agent})`) : "";
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			text.setText("▸ " + theme.fg("toolTitle", theme.bold("Resume")) + " " + theme.fg("accent", theme.bold(name)) + agentBadge + formatTaskPreview(args.task ?? "", context, theme));
			return text;
		},
		renderResult(result, opts, theme, context) {
			const details = result.details as ResumeToolDetails | undefined;
			if (details?.status === "started") return new Text("", 0, 0);
			if (details?.status === "completed" || details?.status === "failed" || details?.status === "cancelled") {
				return renderSubagentCompletionText(result, opts, theme, context.lastComponent instanceof Text ? context.lastComponent : undefined, true);
			}
			const firstContent = result.content?.[0];
			const text = firstContent?.type === "text" ? firstContent.text : "";
			const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			component.setText(theme.fg("dim", text));
			return component;
		},
		async execute(_toolCallId, params, signal) {
			const sessionFile = params.sessionFile;
			const task = params.task;
			const startTime = Date.now();
			if (!sessionFile) throw new Error("Session file is required.");
			if (!existsSync(sessionFile)) throw new Error(`Session file not found: ${sessionFile}`);
			const explicitMode = isResumeMode(params.mode) ? params.mode : undefined;
			const metadata = resolveResumeLaunchMetadata(sessionFile, explicitMode);
			const launchMetadata = readSubagentLaunchMetadata(sessionFile);
			const name = params.name ?? launchMetadata?.name ?? "Resume";
			if (metadata.mode === "interactive" && !runtime.isMuxAvailable()) {
				throw new Error(`Subagents require a supported terminal multiplexer. ${muxSetupHint()}`);
			}
			const entryCountBefore = getEntryCount(sessionFile);
			const subagentDonePath = join(dirname(new URL(import.meta.url).pathname), "subagent-done.ts");
			const savedExtensions = launchMetadata?.extensions ?? readSubagentExtensionEntry(sessionFile);
			const extensionArgs = savedExtensions ? getExtensionLaunchArgs(savedExtensions, subagentDonePath) : ["--no-extensions", "-e", subagentDonePath];
			const parityArgs = [...getPersistedPromptLaunchArgs(launchMetadata), ...getPersistedSessionParityArgs(launchMetadata)];
			const resumeCwd = getResumeCwd(launchMetadata);
			const resumeEnvVars: Record<string, string> = {};
			if (launchMetadata?.agentConfigDir) resumeEnvVars.PI_CODING_AGENT_DIR = launchMetadata.agentConfigDir;
			else if (process.env.PI_CODING_AGENT_DIR) resumeEnvVars.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
			if (launchMetadata?.denyTools.length) resumeEnvVars.PI_DENY_TOOLS = launchMetadata.denyTools.join(",");
			else if (process.env.PI_DENY_TOOLS) resumeEnvVars.PI_DENY_TOOLS = process.env.PI_DENY_TOOLS;
			if (savedExtensions !== undefined) resumeEnvVars.PI_SUBAGENT_EXTENSIONS = savedExtensions.join(",");
			else if (process.env.PI_SUBAGENT_EXTENSIONS) resumeEnvVars.PI_SUBAGENT_EXTENSIONS = process.env.PI_SUBAGENT_EXTENSIONS;
			resumeEnvVars.PI_SUBAGENT_NAME = launchMetadata?.name ?? name;
			const resumedAgent = launchMetadata?.agent ?? metadata.agent;
			if (resumedAgent) resumeEnvVars.PI_SUBAGENT_AGENT = resumedAgent;
			resumeEnvVars.PI_SUBAGENT_SESSION = sessionFile;
			const resumedAutoExit = launchMetadata?.autoExit ?? metadata.autoExit ?? true;
			if (resumedAutoExit) resumeEnvVars.PI_SUBAGENT_AUTO_EXIT = "1";
			resumeEnvVars.PI_ARTIFACT_PROJECT_ROOT = getArtifactStorageRoot();
			const id = Math.random().toString(16).slice(2, 10);
			const running: RunningSubagent = {
				id, name, task: task ?? "resumed session", agent: resumedAgent,
				mode: metadata.mode, executionState: "running", deliveryState: "detached",
				parentClosePolicy: launchMetadata?.parentClosePolicy ?? metadata.parentClosePolicy ?? "terminate",
				blocking: launchMetadata?.blocking ?? false, async: launchMetadata?.async ?? true,
				autoExit: resumedAutoExit, startTime, sessionFile, launchEntryCount: entryCountBefore,
			};
			if (metadata.mode === "background") {
				const invocation = getPiInvocation([...buildResumePiArgs(sessionFile, "background"), ...extensionArgs, ...parityArgs]);
				const child = spawn(invocation.command, invocation.args, {
					...(resumeCwd ? { cwd: resumeCwd } : {}), detached: true,
					stdio: running.parentClosePolicy === "continue" ? ["pipe", "ignore", "ignore"] : ["pipe", "pipe", "pipe"],
					env: getSubagentChildProcessEnv(invocation, resumeEnvVars),
				});
				if (task) child.stdin?.end(task); else child.stdin?.end();
				child.unref();
				running.childProcess = child;
				child.stdout?.on("data", (chunk) => { running.stdoutTail = rememberTail(running.stdoutTail, chunk); });
				child.stderr?.on("data", (chunk) => { running.stderrTail = rememberTail(running.stderrTail, chunk); });
			} else {
				const surface = createSurface(name);
				await new Promise<void>((resolve) => setTimeout(resolve, runtime.getShellReadyDelayMs()));
				const doneSentinelFile = getDoneSentinelFile(sessionFile, id);
				const parts = getPiShellParts(buildResumePiArgs(sessionFile, "interactive"));
				for (const arg of [...extensionArgs, ...parityArgs]) parts.push(shellEscape(arg));
				resumeEnvVars.PI_SUBAGENT_SURFACE = surface;
				const resumeEnvPrefix = `${Object.entries(resumeEnvVars).map(([key, value]) => `${key}=${shellEscape(value)}`).join(" ")} `;
				const command = `${buildShellChangeDirectoryPrefix(resumeCwd)}${resumeEnvPrefix}${parts.join(" ")}; printf '__SUBAGENT_DONE_'${exitStatusVar()}'__\n' | tee ${shellEscape(doneSentinelFile)}`;
				sendShellCommand(surface, command);
				if (task) {
					await new Promise<void>((resolve) => setTimeout(resolve, Math.max(3000, runtime.getShellReadyDelayMs())));
					sendCommand(surface, "");
					await new Promise<void>((resolve) => setTimeout(resolve, 500));
					sendCommand(surface, task);
				}
				running.surface = surface;
				running.doneSentinelFile = doneSentinelFile;
			}
			runtime.runningSubagents.set(id, running);
			runtime.startWidgetRefresh();
			const watcherAbort = new AbortController();
			running.abortController = watcherAbort;
			running.completionPromise = metadata.mode === "background"
				? runtime.watchBackgroundSubagent(running, runtime.getWatcherSignal(running, watcherAbort))
				: runtime.watchSubagent(running, runtime.getWatcherSignal(running, watcherAbort));
			runtime.wireSubagentSteerBack(pi, running, running.completionPromise);
			const shouldAwait = (running.blocking ?? false) || running.async === false;
			if (shouldAwait) return runtime.getLaunchedSubagentResult(running, signal);
			return {
				content: [{ type: "text", text: `Session "${name}" resumed.` }],
				details: { id, name, sessionFile, status: "started", mode: metadata.mode, modeSource: metadata.modeSource, agent: metadata.agent, deliveryState: "detached", parentClosePolicy: running.parentClosePolicy, blocking: running.blocking ?? false, async: running.async ?? !(running.blocking ?? false) },
			};
		},
	});
}
