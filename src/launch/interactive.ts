import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHILD_CONTEXT_BOUNDARY_SYSTEM_PROMPT } from "./context-boundary.ts";
import {
	getPiShellParts,
} from "./child-command.ts";
import {
	buildPersistedSubagentLaunchMetadata,
	getBaseSubagentEnvVars,
	getPreparedExtensionLaunchArgs,
	getPreparedModel,
	getPreparedRoleBlock,
	getPreparedSessionLaunchArgs,
	getPreparedSkillList,
	getFlagsLaunchArgs,
	prepareSubagentLaunch,
	type SubagentLaunchContext,
} from "./prep.ts";
import {
	resolveSubagentNoContextFiles,
	resolveSubagentNoSession,
	resolveSubagentParentClosePolicy,
} from "./policy.ts";
import {
	createSurface,
	exitStatusVar,
	getMuxBackend,
	sendCommand,
	sendShellCommand,
	shellEscape,
} from "../mux.ts";
import type { RunningSubagent, SubagentParamsInput } from "../types.ts";
import { getEntryCount } from "../session/session.ts";
import {
	buildPiPromptArgs,
	getDoneSentinelFile,
	resolveEffectiveSessionMode,
	writeSubagentLaunchMetadataEntry,
	writeSubagentLaunchMetadataEntryWhenReady,
} from "../session/session-files.ts";
import { getNoSessionSeedMode, seedPreparedSubagentSession } from "./seed-child-session.ts";
import { writeSystemPromptArtifact, writeTaskArtifact } from "./prompt-artifacts.ts";
import {
	getSubagentDisplayTitle,
	isSetTabTitleToolEnabled,
} from "../agents/titles.ts";
import { getSubagentToolLaunchArgs } from "../tools/policy.ts";

export interface InteractiveLaunchRuntime {
	getContextWindow(modelRef: string | undefined): number | undefined;
	getShellReadyDelayMs(): number;
	waitForInteractivePrompt(surface: string): Promise<void>;
}

export async function launchInteractiveSubagent(
	params: SubagentParamsInput,
	ctx: SubagentLaunchContext,
	runtime: InteractiveLaunchRuntime,
	options?: { surface?: string },
): Promise<RunningSubagent> {
	const startTime = Date.now();
	const id = Math.random().toString(16).slice(2, 10);
	const prepared = prepareSubagentLaunch(params, ctx);
	const sessionMode = resolveEffectiveSessionMode(params, prepared.agentDefs);
	const noSession = resolveSubagentNoSession(prepared.agentDefs);
	const noSessionSeedMode = noSession ? getNoSessionSeedMode(sessionMode) : null;
	const directTask = sessionMode === "fork" || noSessionSeedMode === "fork";
	const surfacePreCreated = !!options?.surface;
	const surface = options?.surface ?? createSurface(params.name);
	const doneSentinelFile = getDoneSentinelFile(prepared.subagentSessionFile, id);
	if (!surfacePreCreated) {
		await new Promise<void>((resolve) =>
			setTimeout(resolve, runtime.getShellReadyDelayMs()),
		);
	}
	const modeHint = prepared.agentDefs?.autoExit
		? "Complete your task autonomously."
		: "Manual lifecycle: do not stop after your final text. After completing the task, you MUST call the subagent_done tool unless you intentionally need the human operator to close this foreground pane. If operator close is required, say exactly `MANUAL CLOSE REQUIRED:` followed by the reason and wait for the operator. The user can interact with you at any time.";
	const summaryInstruction = prepared.agentDefs?.autoExit
		? "Your FINAL assistant message should summarize what you accomplished."
		: "Your FINAL assistant message before calling subagent_done, or before asking for manual close, should summarize what you accomplished. After that final message, immediately call subagent_done.";
	const agentType = params.agent ?? params.name;
	const tabTitleInstruction =
		!isSetTabTitleToolEnabled() || prepared.denySet.has("set_tab_title")
			? ""
			: `As your FIRST action, set the tab title using set_tab_title. ` +
			`The title MUST start with [${agentType}] followed by a short description of your current task. ` +
			`Example: "[${agentType}] Analyzing auth module". Keep it concise.`;
	const roleBlock = getPreparedRoleBlock(prepared);
	const fullTask = directTask
		? params.task
		: `${roleBlock}\n\n${modeHint}\n\n${tabTitleInstruction}\n\n${params.task}\n\n${summaryInstruction}`;

	const parts = getPiShellParts(getPreparedSessionLaunchArgs(prepared));
	const { boundarySystemPrompt: shouldWriteChildBoundary } =
		seedPreparedSubagentSession(prepared, params, ctx, sessionMode, noSession);
	const subagentDonePath = join(dirname(dirname(fileURLToPath(import.meta.url))), "tools", "subagent-done.ts");
	for (const arg of getPreparedExtensionLaunchArgs(prepared, subagentDonePath)) {
		parts.push(shellEscape(arg));
	}

	const model = getPreparedModel(prepared);
	if (model) parts.push("--model", shellEscape(model));
	if (resolveSubagentNoContextFiles(prepared.agentDefs)) {
		parts.push("--no-context-files");
	}

	let systemPrompt: string | undefined;
	if (prepared.identityInSystemPrompt && prepared.identity) {
		const flag = prepared.agentDefs?.systemPromptMode === "replace"
			? "--system-prompt"
			: "--append-system-prompt";
		systemPrompt = prepared.identity;
		const systemPromptPath = writeSystemPromptArtifact(params.name, systemPrompt, ctx);
		parts.push(flag, shellEscape(systemPromptPath));
	}
	if (shouldWriteChildBoundary) {
		parts.push("--append-system-prompt", shellEscape(CHILD_CONTEXT_BOUNDARY_SYSTEM_PROMPT));
	}
	const launchMetadata = buildPersistedSubagentLaunchMetadata(
		prepared,
		params,
		"interactive",
		sessionMode,
		shouldWriteChildBoundary,
		systemPrompt,
	);
	if (existsSync(prepared.subagentSessionFile)) {
		writeSubagentLaunchMetadataEntry(prepared.subagentSessionFile, launchMetadata);
	}
	for (const arg of getSubagentToolLaunchArgs(prepared.effectiveTools, prepared.denySet)) {
		parts.push(shellEscape(arg));
	}
	for (const flag of getFlagsLaunchArgs(prepared.agentDefs?.flags)) {
		parts.push(shellEscape(flag));
	}

	const envVars = getBaseSubagentEnvVars(prepared, params, resolveEffectiveSessionMode);
	if (prepared.agentDefs?.autoExit) envVars.PI_SUBAGENT_AUTO_EXIT = "1";
	envVars.PI_SUBAGENT_SESSION = prepared.subagentSessionFile;
	envVars.PI_SUBAGENT_SURFACE = surface;
	const envPrefix = `${Object.entries(envVars)
		.map(([key, value]) => `${key}=${shellEscape(value)}`)
		.join(" ")} `;

	const taskArg = `@${writeTaskArtifact(params.name, fullTask, ctx)}`;
	const promptArgs = buildPiPromptArgs(
		getPreparedSkillList(prepared),
		taskArg,
		directTask,
	);
	for (const promptArg of promptArgs) parts.push(shellEscape(promptArg));

	const cdPrefix = prepared.runtimePaths.effectiveCwd
		? `cd ${shellEscape(prepared.runtimePaths.effectiveCwd)} && `
		: "";
	const launchEntryCount = existsSync(prepared.subagentSessionFile)
		? getEntryCount(prepared.subagentSessionFile)
		: 0;
	const command = `${cdPrefix}${envPrefix}${parts.join(" ")}; printf '__SUBAGENT_DONE_'${exitStatusVar()}'__\n' | tee ${shellEscape(doneSentinelFile)}`;
	sendShellCommand(surface, command);
	if (!existsSync(prepared.subagentSessionFile)) {
		await writeSubagentLaunchMetadataEntryWhenReady(prepared.subagentSessionFile, launchMetadata);
	}

	return {
		id,
		name: params.name,
		task: params.task,
		title: getSubagentDisplayTitle(params),
		agent: params.agent,
		mode: "interactive",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: resolveSubagentParentClosePolicy(prepared.agentDefs),
		blocking: params.blocking ?? false,
		async: params.async ?? !(params.blocking ?? false),
		autoExit: prepared.agentDefs?.autoExit ?? false,
		noSession,
		surface,
		startTime,
		sessionFile: prepared.subagentSessionFile,
		launchEntryCount,
		modelContextWindow: runtime.getContextWindow(prepared.effectiveModelRef),
		doneSentinelFile,
	};
}
