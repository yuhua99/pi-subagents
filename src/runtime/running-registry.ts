import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	CompletedSubagentResult,
	RunningSubagent,
	StartedSubagentToolDetails,
	SubagentPingMessageDetails,
	SubagentResult,
} from "../types.ts";
import {
	buildCompletedSubagentResult,
	cacheCompletedSubagentResult,
	clearSubagentShutdownTimer,
	completedSubagentResults,
	getSubagentBatchStopMetadata,
	isSubagentBatchBlocking,
	requestSubagentBatchStop,
	runningSubagents,
	stopAfterCurrentSubagentBatch,
} from "./state.ts";

export interface RunningRegistryRuntime {
	formatElapsed(elapsed: number): string;
	updateWidget(): void;
	waitForSubagentResult(params: { id: string }, signal?: AbortSignal): Promise<unknown>;
	withSubagentBatchStop(result: any): any;
	asSubagentToolResult(result: unknown): any;
}

export function findRunningSubagent(query: string): {
	running?: RunningSubagent;
	error?: string;
} {
	const byId = runningSubagents.get(query);
	if (byId) return { running: byId };

	const exactNameMatches = [...runningSubagents.values()].filter(
		(agent) => agent.name === query,
	);
	if (exactNameMatches.length === 1) return { running: exactNameMatches[0] };
	if (exactNameMatches.length > 1) {
		return { error: `Multiple subagents named "${query}". Use the id instead.` };
	}

	const normalizedQuery = query.toLowerCase();
	const ciMatches = [...runningSubagents.values()].filter(
		(agent) => agent.name.toLowerCase() === normalizedQuery,
	);
	if (ciMatches.length === 1) return { running: ciMatches[0] };
	if (ciMatches.length > 1) {
		return { error: `Multiple subagents named "${query}". Use the id instead.` };
	}

	return { error: `No running subagent matches "${query}".` };
}

export function findTrackedSubagent(query: string): {
	id?: string;
	running?: RunningSubagent;
	cached?: CompletedSubagentResult;
	error?: string;
} {
	const cachedById = completedSubagentResults.get(query);
	if (cachedById) return { id: cachedById.id, cached: cachedById };
	const runningById = runningSubagents.get(query);
	if (runningById) return { id: runningById.id, running: runningById };

	const exactCachedMatches = [...completedSubagentResults.values()].filter(
		(agent) => agent.name === query,
	);
	if (exactCachedMatches.length === 1) {
		return { id: exactCachedMatches[0].id, cached: exactCachedMatches[0] };
	}
	if (exactCachedMatches.length > 1) {
		return {
			error: `Multiple completed subagents match "${query}". Use the id instead.`,
		};
	}

	const exactRunningMatches = [...runningSubagents.values()].filter(
		(agent) => agent.name === query,
	);
	if (exactRunningMatches.length === 1) {
		return { id: exactRunningMatches[0].id, running: exactRunningMatches[0] };
	}
	if (exactRunningMatches.length > 1) {
		return {
			error: `Multiple running subagents match "${query}". Use the id instead.`,
		};
	}

	const normalizedQuery = query.toLowerCase();
	const ciCachedMatches = [...completedSubagentResults.values()].filter(
		(agent) => agent.name.toLowerCase() === normalizedQuery,
	);
	if (ciCachedMatches.length === 1) {
		return { id: ciCachedMatches[0].id, cached: ciCachedMatches[0] };
	}
	if (ciCachedMatches.length > 1) {
		return {
			error: `Multiple completed subagents match "${query}". Use the id instead.`,
		};
	}

	const ciRunningMatches = [...runningSubagents.values()].filter(
		(agent) => agent.name.toLowerCase() === normalizedQuery,
	);
	if (ciRunningMatches.length === 1) {
		return { id: ciRunningMatches[0].id, running: ciRunningMatches[0] };
	}
	if (ciRunningMatches.length > 1) {
		return {
			error: `Multiple running subagents match "${query}". Use the id instead.`,
		};
	}

	return { error: `No subagent matches "${query}".` };
}

export function stopRunningSubagent(
	running: RunningSubagent,
	closeSurface: (surface: string) => void,
): void {
	clearSubagentShutdownTimer(running);
	running.abortController?.abort();

	// Always kill the child process/surface regardless of abortController.
	// abortController only stops the watcher polling loop; the child would
	// otherwise keep running and deliver stale results via steer.
	if (running.childProcess?.pid) {
		try {
			process.kill(-running.childProcess.pid, "SIGTERM");
		} catch {
			running.childProcess.kill("SIGTERM");
		}
	}
	if (running.surface) {
		try {
			closeSurface(running.surface);
		} catch {}
	}
}

export function getStartedSubagentDetails(
	running: RunningSubagent,
): StartedSubagentToolDetails & Record<string, unknown> {
	return {
		id: running.id,
		name: running.name,
		title: running.title,
		task: running.task,
		agent: running.agent,
		sessionFile: running.noSession ? undefined : running.sessionFile,
		noSession: running.noSession,
		status: "started" as const,
		mode: running.mode,
		deliveryState: running.deliveryState,
		parentClosePolicy: running.parentClosePolicy,
		async: running.async !== false,
		autoExit: running.autoExit,
	};
}

function getStartedSubagentResult(running: RunningSubagent) {
	const isAsync = running.async ?? !(running.blocking ?? false);
	if (isAsync) requestSubagentBatchStop();
	return {
		content: [
			{
				type: "text" as const,
				text:
					`Sub-agent "${running.name}" launched ${isAsync ? "async" : "sync"} with id ${running.id}. ` +
					(isAsync
						? `Results will be delivered automatically as a steer message when it finishes. `
						: `The parent is waiting for this result before continuing. `) +
					`Use this exact id if you need to resume or stop this child.`,
			},
		],
		details: getStartedSubagentDetails(running),
		...getSubagentBatchStopMetadata(),
	};
}

export async function getLaunchedSubagentResult(
	running: RunningSubagent,
	runtime: RunningRegistryRuntime,
	signal?: AbortSignal,
) {
	const parentShouldWait = (running.blocking ?? false) || isSubagentBatchBlocking();
	if (!parentShouldWait) return getStartedSubagentResult(running);
	const result = await runtime.waitForSubagentResult({ id: running.id }, signal);
	return runtime.withSubagentBatchStop(runtime.asSubagentToolResult(result));
}

export function deliverCompletedSubagentResultViaSteer(
	pi: Pick<ExtensionAPI, "sendMessage">,
	cached: CompletedSubagentResult,
	formatElapsed: (elapsed: number) => string,
): CompletedSubagentResult {
	if (cached.deliveryState !== "detached" || cached.deliveredTo) return cached;

	const deliverAs = stopAfterCurrentSubagentBatch ? "nextTurn" : "steer";
	cached.deliveredTo = "steer";
	const sessionRef = cached.sessionFile
		? `\n\nSession: ${cached.sessionFile}\nResume: pi --session ${cached.sessionFile}`
		: "";
	let content: string;
	if (cached.errorMessage) {
		// Provider/agent error after auto-retry exhausted.
		content =
			`Sub-agent "${cached.name}" failed after ${formatElapsed(cached.elapsed)} ` +
			`(provider/agent error — auto-retry exhausted).\n\n` +
			`Error: ${cached.errorMessage}\n\n` +
			`The subagent did not produce a result. You can retry by spawning a new ` +
			`subagent or resume the session with subagent_resume.${sessionRef}`;
	} else {
		content =
			cached.exitCode !== 0
				? `Sub-agent "${cached.name}" failed (exit ${cached.exitCode}).\n\n${cached.summary}${sessionRef}`
				: `Sub-agent "${cached.name}" completed (${formatElapsed(cached.elapsed)}).\n\n${cached.summary}${sessionRef}`;
	}

	pi.sendMessage(
		{
			customType: "subagent_result",
			content,
			display: true,
			details: {
				id: cached.id,
				name: cached.name,
				task: cached.task,
				agent: cached.agent,
				mode: cached.mode,
				status: cached.status,
				deliveryState: cached.deliveryState,
				parentClosePolicy: cached.parentClosePolicy,
				blocking: cached.blocking,
				async: cached.async,
				exitCode: cached.exitCode,
				elapsed: cached.elapsed,
				outputTokens: cached.outputTokens,
				sessionFile: cached.sessionFile,
				...(cached.errorMessage
					? { errorMessage: cached.errorMessage }
					: {}),
			},
		},
		{ triggerTurn: true, deliverAs },
	);

	return cached;
}

function deliverSubagentPingViaSteer(
	pi: Pick<ExtensionAPI, "sendMessage">,
	running: RunningSubagent,
	result: SubagentResult,
	formatElapsed: (elapsed: number) => string,
): void {
	if (!result.ping) return;
	const sessionRef = result.sessionFile
		? `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`
		: "";
	pi.sendMessage(
		{
			customType: "subagent_ping",
			content:
				`Sub-agent "${result.ping.name}" needs help (${formatElapsed(result.elapsed)}).\n\n` +
				`${result.ping.message}${sessionRef}`,
			display: true,
			details: {
				id: running.id,
				name: result.ping.name,
				task: running.task,
				agent: running.agent,
				mode: running.mode,
				deliveryState: running.deliveryState,
				parentClosePolicy: running.parentClosePolicy,
				blocking: running.blocking,
				async: running.async ?? !running.blocking,
				elapsed: result.elapsed,
				outputTokens: result.outputTokens,
				sessionFile: result.sessionFile,
				message: result.ping.message,
			} as SubagentPingMessageDetails,
		},
		{ triggerTurn: true, deliverAs: "steer" },
	);
}

export function routeDetachedSubagentCompletion(
	pi: ExtensionAPI,
	running: RunningSubagent,
	result: SubagentResult,
	formatElapsed: (elapsed: number) => string,
	updateWidget: () => void,
): CompletedSubagentResult {
	clearSubagentShutdownTimer(running);
	const cached =
		running.allowSteerDelivery === false && !running.resultOwner
			? buildCompletedSubagentResult(running, result)
			: cacheCompletedSubagentResult(running, result);
	runningSubagents.delete(running.id);
	updateWidget();
	if (running.allowSteerDelivery === false) return cached;
	return deliverCompletedSubagentResultViaSteer(pi, cached, formatElapsed);
}

function handleDetachedSubagentOutcome(
	pi: ExtensionAPI,
	running: RunningSubagent,
	result: SubagentResult,
	formatElapsed: (elapsed: number) => string,
	updateWidget: () => void,
): void {
	if (result.ping) {
		clearSubagentShutdownTimer(running);
		runningSubagents.delete(running.id);
		updateWidget();
		if (running.allowSteerDelivery === false) return;
		deliverSubagentPingViaSteer(pi, running, result, formatElapsed);
		return;
	}
	routeDetachedSubagentCompletion(pi, running, result, formatElapsed, updateWidget);
}

export function wireSubagentSteerBack(
	pi: ExtensionAPI,
	running: RunningSubagent,
	watchPromise: Promise<SubagentResult>,
	formatElapsed: (elapsed: number) => string,
	updateWidget: () => void,
): void {
	watchPromise
		.then((result) => {
			handleDetachedSubagentOutcome(pi, running, result, formatElapsed, updateWidget);
		})
		.catch((err) => {
			runningSubagents.delete(running.id);
			updateWidget();
			pi.sendMessage(
				{
					customType: "subagent_result",
					content: `Sub-agent "${running.name}" error: ${err?.message ?? String(err)}`,
					display: true,
					details: {
						id: running.id,
						name: running.name,
						task: running.task,
						deliveryState: running.deliveryState,
						parentClosePolicy: running.parentClosePolicy,
						error: err?.message,
					},
				},
				{ triggerTurn: true, deliverAs: "steer" },
			);
		});
}
