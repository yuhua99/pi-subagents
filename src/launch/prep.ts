import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { getArtifactStorageRoot } from "../artifact-storage.ts";
import type { AgentDefaults } from "../agents/definitions.ts";
import {
	loadAgentDefaults as loadAgentDefaultsFromDefinitions,
	resolveForkOutputReserveTokens,
} from "../agents/definitions.ts";
import { CHILD_CONTEXT_BOUNDARY_SYSTEM_PROMPT } from "./context-boundary.ts";
import { parseCommandWords } from "./child-command.ts";
import {
	resolveSubagentNoContextFiles,
	resolveSubagentNoSession,
	resolveSubagentParentClosePolicy,
	resolveSubagentExtensions,
} from "./policy.ts";
import type { ResumeMode } from "./resume.ts";
import { resolveSubagentCwd, resolveSubagentRuntimePaths, type ResolvedSubagentRuntimePaths } from "./runtime-paths.ts";
import type { RunningSubagent, SubagentParamsInput } from "../types.ts";
import {
	buildIdentityBlock,
	generateSubagentSessionFile,
	type PersistedSubagentLaunchMetadata,
	type SubagentSessionMode,
} from "../session/session-files.ts";
import { buildSubagentSessionTitle } from "../agents/titles.ts";
import { addToolModeDeniedNames, getSubagentToolLaunchArgs, resolveDenyTools } from "../tools/policy.ts";

export interface SubagentLaunchContext {
	sessionManager: {
		getSessionFile(): string | null | undefined;
		getSessionId(): string;
	};
	cwd: string;
	childModelContextWindow?: number;
	launchToolCallId?: string;
	/** Override for auto-exit (used in headless mode to force auto-exit on). */
	autoExit?: boolean;
}

export interface PreparedSubagentLaunch {
	agentDefs: AgentDefaults | null;
	effectiveModel?: string;
	effectiveThinking?: string;
	effectiveModelRef?: string;
	effectiveTools?: string;
	effectiveSkills?: string;
	sessionFile: string;
	runtimePaths: ResolvedSubagentRuntimePaths;
	subagentSessionFile: string;
	denySet: Set<string>;
	effectiveExtensions?: string[];
	identity: string;
	identityInSystemPrompt: boolean;
}

function loadAgentDefaults(
	agentName: string,
	cwdHint: string | null | undefined,
	baseCwd: string,
): AgentDefaults | null {
	return loadAgentDefaultsFromDefinitions(
		agentName,
		cwdHint,
		baseCwd,
		resolveSubagentCwd,
	);
}

export function prepareSubagentLaunch(
	params: SubagentParamsInput,
	ctx: SubagentLaunchContext,
): PreparedSubagentLaunch {
	const agentDefs = params.agent
		? loadAgentDefaults(params.agent, params.cwd, ctx.cwd)
		: null;
	// Apply headless-mode auto-exit override so downstream consumers (mode hint,
	// env vars, deny set, metadata) all see the effective value.
	if (ctx.autoExit !== undefined && agentDefs) {
		agentDefs.autoExit = ctx.autoExit;
	}
	const effectiveModel = params.model ?? agentDefs?.model;
	const effectiveTools = params.tools ?? agentDefs?.tools;
	const effectiveSkills = params.skills ?? agentDefs?.skills;
	const effectiveThinking = agentDefs?.thinking;
	const effectiveModelRef = effectiveThinking
		? `${effectiveModel}:${effectiveThinking}`
		: effectiveModel;

	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("No session file");

	const runtimePaths = resolveSubagentRuntimePaths(
		params,
		agentDefs,
		ctx.cwd,
		dirname(sessionFile),
	);
	const subagentSessionFile = generateSubagentSessionFile(
		resolveSubagentNoSession(agentDefs)
			? join(tmpdir(), "pi-subagents", "sessions")
			: runtimePaths.sessionDir,
	);
	const denySet = addToolModeDeniedNames(
		resolveDenyTools(agentDefs),
		effectiveTools,
	);
	const effectiveExtensions = resolveSubagentExtensions(agentDefs);
	const identity = buildIdentityBlock(agentDefs, params.systemPrompt);
	const identityInSystemPrompt = !!(agentDefs?.systemPromptMode && identity);

	return {
		agentDefs,
		effectiveModel,
		effectiveThinking,
		effectiveModelRef,
		effectiveTools,
		effectiveSkills,
		sessionFile,
		runtimePaths,
		subagentSessionFile,
		denySet,
		effectiveExtensions,
		identity,
		identityInSystemPrompt,
	};
}

export function getPreparedModel(
	prepared: PreparedSubagentLaunch,
): string | undefined {
	if (!prepared.effectiveModel) return undefined;
	return prepared.effectiveThinking
		? `${prepared.effectiveModel}:${prepared.effectiveThinking}`
		: prepared.effectiveModel;
}

export function getPreparedSkillList(prepared: PreparedSubagentLaunch): string[] {
	if (!prepared.effectiveSkills) return [];
	return prepared.effectiveSkills
		.split(",")
		.map((skill) => skill.trim())
		.filter(Boolean);
}

export function getExtensionLaunchArgs(
	extensionSpecs: string[] | undefined,
	mandatoryExtensionPath: string,
): string[] {
	const args: string[] = [];
	if (extensionSpecs !== undefined) args.push("--no-extensions");
	args.push("-e", mandatoryExtensionPath);
	for (const extension of extensionSpecs ?? []) args.push("-e", extension);
	return args;
}

export function getFlagsLaunchArgs(flags: string | undefined): string[] {
	if (!flags?.trim()) return [];
	return parseCommandWords(flags);
}

export function getPreparedExtensionLaunchArgs(
	prepared: PreparedSubagentLaunch,
	mandatoryExtensionPath: string,
): string[] {
	return getExtensionLaunchArgs(
		prepared.effectiveExtensions,
		mandatoryExtensionPath,
	);
}

export function getPreparedSessionLaunchArgs(
	prepared: Pick<PreparedSubagentLaunch, "agentDefs" | "subagentSessionFile">,
): string[] {
	return resolveSubagentNoSession(prepared.agentDefs)
		? ["--session", prepared.subagentSessionFile, "--no-session"]
		: ["--session", prepared.subagentSessionFile];
}

export function getPersistedPromptLaunchArgs(
	metadata: PersistedSubagentLaunchMetadata | undefined,
): string[] {
	const args: string[] = [];
	if (metadata?.systemPromptMode && metadata.systemPrompt) {
		args.push(
			metadata.systemPromptMode === "replace"
				? "--system-prompt"
				: "--append-system-prompt",
			metadata.systemPrompt,
		);
	}
	if (metadata?.boundarySystemPrompt) {
		args.push("--append-system-prompt", CHILD_CONTEXT_BOUNDARY_SYSTEM_PROMPT);
	}
	return args;
}

export function getPersistedSessionParityArgs(
	metadata: PersistedSubagentLaunchMetadata | undefined,
): string[] {
	const args: string[] = [];
	if (!metadata) return args;
	if (metadata.modelRef) args.push("--model", metadata.modelRef);
	if (metadata.noContextFiles) args.push("--no-context-files");
	args.push(
		...getSubagentToolLaunchArgs(metadata.tools, new Set(metadata.denyTools)),
	);
	args.push(...getFlagsLaunchArgs(metadata.flags));
	return args;
}

export function cleanupNoSessionSessionFile(
	running: Pick<RunningSubagent, "noSession" | "sessionFile">,
): void {
	if (!running.noSession || !existsSync(running.sessionFile)) return;
	try {
		rmSync(running.sessionFile, { force: true });
	} catch {}
}

export function getPreparedRoleBlock(prepared: PreparedSubagentLaunch): string {
	return prepared.identity && !prepared.identityInSystemPrompt
		? `\n\n${prepared.identity}`
		: "";
}

export function buildPersistedSubagentLaunchMetadata(
	prepared: PreparedSubagentLaunch,
	params: SubagentParamsInput,
	mode: ResumeMode,
	sessionMode: SubagentSessionMode,
	boundarySystemPrompt: boolean,
	systemPrompt?: string,
): PersistedSubagentLaunchMetadata {
	const forkOutputReserveTokens = resolveForkOutputReserveTokens(
		prepared.agentDefs,
	);
	return {
		version: 1,
		timestamp: new Date().toISOString(),
		name: params.name,
		...(params.title ? { title: params.title } : {}),
		...(params.agent ? { agent: params.agent } : {}),
		mode,
		sessionMode,
		...(prepared.agentDefs?.autoExit !== undefined
			? { autoExit: prepared.agentDefs.autoExit }
			: {}),
		parentClosePolicy: resolveSubagentParentClosePolicy(prepared.agentDefs),
		blocking: params.blocking === true,
		async: params.async !== false,
		...(prepared.effectiveModel ? { model: prepared.effectiveModel } : {}),
		...(prepared.effectiveThinking
			? { thinking: prepared.effectiveThinking }
			: {}),
		...(prepared.effectiveModelRef
			? { modelRef: prepared.effectiveModelRef }
			: {}),
		...(prepared.effectiveTools ? { tools: prepared.effectiveTools } : {}),
		...(prepared.effectiveSkills ? { skills: prepared.effectiveSkills } : {}),
		denyTools: [...prepared.denySet],
		...(prepared.effectiveExtensions !== undefined
			? { extensions: prepared.effectiveExtensions }
			: {}),
		noContextFiles: resolveSubagentNoContextFiles(prepared.agentDefs),
		noSession: resolveSubagentNoSession(prepared.agentDefs),
		agentConfigDir: prepared.runtimePaths.effectiveAgentConfigDir,
		cwd: prepared.runtimePaths.targetCwdForSession,
		...(prepared.agentDefs?.systemPromptMode
			? { systemPromptMode: prepared.agentDefs.systemPromptMode }
			: {}),
		...(systemPrompt ? { systemPrompt } : {}),
		boundarySystemPrompt,
		...(forkOutputReserveTokens !== undefined
			? { forkOutputReserveTokens }
			: {}),
		...(prepared.agentDefs?.flags ? { flags: prepared.agentDefs.flags } : {}),
	};
}

export function getBaseSubagentEnvVars(
	prepared: PreparedSubagentLaunch,
	params: SubagentParamsInput,
	resolveEffectiveSessionMode: (
		params: SubagentParamsInput,
		agentDefs: AgentDefaults | null,
	) => SubagentSessionMode,
): Record<string, string> {
	const envVars: Record<string, string> = {};
	if (prepared.runtimePaths.localAgentConfigDir) {
		envVars.PI_CODING_AGENT_DIR = prepared.runtimePaths.localAgentConfigDir;
	} else if (process.env.PI_CODING_AGENT_DIR) {
		envVars.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
	}
	if (prepared.denySet.size > 0)
		envVars.PI_DENY_TOOLS = [...prepared.denySet].join(",");
	if (prepared.effectiveExtensions !== undefined) {
		envVars.PI_SUBAGENT_EXTENSIONS = prepared.effectiveExtensions.join(",");
	}
	envVars.PI_SUBAGENT_NAME = params.name;
	if (params.agent) envVars.PI_SUBAGENT_AGENT = params.agent;
	const sessionMode = resolveEffectiveSessionMode(params, prepared.agentDefs);
	if (sessionMode !== "standalone")
		envVars.PI_SUBAGENT_PARENT_SESSION = prepared.sessionFile;
	const sessionTitle = buildSubagentSessionTitle(params);
	if (sessionTitle) envVars.PI_SUBAGENT_SESSION_TITLE = sessionTitle;
	envVars.PI_ARTIFACT_PROJECT_ROOT = getArtifactStorageRoot();
	return envVars;
}
