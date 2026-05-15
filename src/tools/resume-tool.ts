import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import { requestSubagentBatchStop, getSubagentBatchStopMetadata } from "../runtime/state.ts";
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
			"Continue a previous subagent session from its session file, optionally sending a follow-up task.",
		promptSnippet:
			"Use subagent_resume when an earlier helper session was cancelled, left open, or needs follow-up work with its existing context.\n" +
			"\n" +
			"Provide sessionFile from the earlier subagent output. If you include task, it is sent as the next instruction in that resumed session.\n" +
			"\n" +
			"The resumed helper may run in a visible terminal or hidden process depending on saved metadata or the mode argument. The tool usually returns after starting it; the helper's final report appears later in this chat when it finishes. Do not invent or assume resumed-session results before that later message appears. " +
			"The result arrives automatically as a steer message. Do not poll for it.",
		parameters: Type.Object({
			sessionFile: Type.String({ description: "Path to the session .jsonl file to resume" }),
			name: Type.Optional(Type.String({ description: "Display name for the terminal tab. Default: 'Resume'" })),
			task: Type.Optional(Type.String({ description: "Optional follow-up task to send after resuming" })),
			agent: Type.Optional(Type.String({ description: "Agent name for display. Use the original agent name from the session being resumed." })),
			mode: Type.Optional(Type.Union([Type.Literal("background"), Type.Literal("interactive")], { description: "Explicit resume mode when launch metadata cannot be inferred. Defaults to the original mode when known, otherwise interactive fallback." })),
		}),
		renderCall(args, theme, context) {
			let name = args.name && args.name !== "Resume" ? args.name : "subagent";
			let agent = args.agent;
			if (args.sessionFile) {
				try {
					const lm = readSubagentLaunchMetadata(args.sessionFile);
					if (lm?.name) name = lm.name;
					if (lm?.agent) agent = lm.agent;
				} catch {}
			}
			const agentBadge = agent ? theme.fg("dim", ` (${agent})`) : "";
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
			const name = launchMetadata?.name ?? metadata.name ?? "Resume";
			const displayName = params.name ?? name;
			if (metadata.mode === "interactive" && !runtime.isMuxAvailable()) {
				throw new Error(`Subagents require a supported terminal multiplexer. ${muxSetupHint()}`);
			}
			// Guard: reject duplicate resume of the same session file
			const normalizedFile = resolve(sessionFile);
			for (const existing of runtime.runningSubagents.values()) {
				if (existing.sessionFile && resolve(existing.sessionFile) === normalizedFile) {
					throw new Error(
						`Session "${existing.name}" (${existing.agent ?? "subagent"}) is already running with id ${existing.id}. ` +
						"Use subagent_kill first or wait for it to complete.",
					);
				}
			}
			const entryCountBefore = getEntryCount(sessionFile);
			const subagentDonePath = join(dirname(fileURLToPath(import.meta.url)), "subagent-done.ts");
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
				const surface = createSurface(displayName);
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
			requestSubagentBatchStop();
			return {
				content: [{ type: "text", text: `Session "${name}" resumed.` }],
				details: { id, name, sessionFile, status: "started", mode: metadata.mode, modeSource: metadata.modeSource, agent: metadata.agent, deliveryState: "detached", parentClosePolicy: running.parentClosePolicy, blocking: running.blocking ?? false, async: running.async ?? !(running.blocking ?? false) },
				...getSubagentBatchStopMetadata(),
			};
		},
	});
}
