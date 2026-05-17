/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+J)
 * - Provides a `subagent_done` tool for autonomous agents to self-terminate
 */

import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	findLatestAssistantError,
	shouldAutoExitOnAgentEnd,
	shouldMarkUserTookOver,
} from "../auto-exit.ts";
import { areSubagentSessionTitlesDisabled } from "../agents/titles.ts";

const require = createRequire(import.meta.url);

function applySubagentSessionTitle(
	ctx:
		| {
				sessionManager?: {
					getHeader?: () => unknown;
					getSessionName?: () => string | undefined;
				};
			}
		| undefined,
	pi: ExtensionAPI,
) {
	if (areSubagentSessionTitlesDisabled()) return;

	const title = process.env.PI_SUBAGENT_SESSION_TITLE?.trim();
	if (!title) return;

	const header = ctx?.sessionManager?.getHeader?.() as
		| { name?: string }
		| null
		| undefined;
	if (header && header.name !== title) header.name = title;

	if (ctx?.sessionManager?.getSessionName?.() === title) return;
	pi.setSessionName(title);
}

function isMissingOptionalDependency(error: unknown, id: string): boolean {
	const maybeError = error as { code?: unknown; message?: unknown } | null;
	const message =
		typeof maybeError?.message === "string" ? maybeError.message : "";
	const code = maybeError?.code;
	return (
		(code === "MODULE_NOT_FOUND" || code == null) &&
		(message.includes("Cannot find module") ||
			message.includes("Cannot find package")) &&
		message.includes(id)
	);
}

export function isMissingOptionalDependencyForTest(
	error: unknown,
	id: string,
): boolean {
	return isMissingOptionalDependency(error, id);
}

function optionalRequire(id: string): unknown | null {
	try {
		return require(id);
	} catch (error) {
		if (isMissingOptionalDependency(error, id)) {
			return null;
		}
		throw error;
	}
}

export function getDeniedToolNames(
	autoExit: boolean,
	deniedEnv = process.env.PI_DENY_TOOLS ?? "",
): string[] {
	const denied = deniedEnv
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (autoExit && !denied.includes("subagent_done")) {
		denied.push("subagent_done");
	}
	return denied;
}

export function filterToolNames(
	toolNames: string[],
	deniedTools: string[],
): string[] {
	const denied = new Set(deniedTools);
	const seen = new Set<string>();
	return toolNames.filter((name) => {
		if (!name || denied.has(name) || seen.has(name)) return false;
		seen.add(name);
		return true;
	});
}

export function shouldRegisterSubagentDone(
	autoExit: boolean,
	deniedTools: string[],
	isInteractive = false,
): boolean {
	if (deniedTools.includes("subagent_done")) return false;
	if (autoExit) return false;
	if (isInteractive) return false;
	return true;
}

type ToolControlAPI = Pick<
	ExtensionAPI,
	"getAllTools" | "getActiveTools" | "setActiveTools" | "registerTool"
>;

type WidgetThemeLike = {
	bg(tone: string, text: string): string;
	bold(text: string): string;
	fg(tone: string, text: string): string;
};

export function installDeniedToolGuards(
	pi: ToolControlAPI,
	autoExit: boolean,
	onChange?: (activeTools: string[], deniedTools: string[]) => void,
) {
	const originalRegisterTool = pi.registerTool.bind(pi);
	const originalSetActiveTools = pi.setActiveTools.bind(pi);

	const notify = (activeTools: string[], deniedTools: string[]) => {
		onChange?.([...activeTools].sort(), [...deniedTools]);
	};

	const applyDeniedTools = (): string[] => {
		const deniedTools = getDeniedToolNames(autoExit);
		const allowedTools = filterToolNames(pi.getActiveTools(), deniedTools);
		originalSetActiveTools(allowedTools);
		notify(allowedTools, deniedTools);
		return allowedTools;
	};

	pi.setActiveTools = (toolNames: string[]) => {
		const deniedTools = getDeniedToolNames(autoExit);
		const allowedTools = filterToolNames(toolNames, deniedTools);
		originalSetActiveTools(allowedTools);
		notify(allowedTools, deniedTools);
	};

	pi.registerTool = (definition) => {
		const result = originalRegisterTool(definition);
		applyDeniedTools();
		return result;
	};

	return { applyDeniedTools };
}

export default function (pi: ExtensionAPI) {
	const tui = optionalRequire("@earendil-works/pi-tui") as
		| typeof import("@earendil-works/pi-tui")
		| null;
	const typebox = optionalRequire("typebox") as typeof import("typebox") | null;
	const Box = tui?.Box;
	const Text = tui?.Text;
	const doneParams = typebox?.Type?.Object
		? typebox.Type.Object({})
		: { type: "object", properties: {}, additionalProperties: false };
	const callerPingParams = typebox?.Type?.Object
		? typebox.Type.Object({
				message: typebox.Type.String({
					description: "What you need help with",
				}),
			})
		: {
				type: "object",
				properties: {
					message: { type: "string", description: "What you need help with" },
				},
				required: ["message"],
				additionalProperties: false,
			};

	const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
	const isInteractive = !!process.env.PI_SUBAGENT_SURFACE;
	let toolNames: string[] = [];
	let denied: string[] = getDeniedToolNames(autoExit);
	let expanded = false;
	let latestCtx: { ui: { setWidget: Function } } | null = null;
	let outputTokens = 0;

	// Read subagent identity from env vars (set by parent orchestrator)
	const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
	const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";

	function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: unknown) {
		if (!Box || !Text) return;
		ctx.ui.setWidget(
			"subagent-tools",
			(_tui: unknown, theme: WidgetThemeLike) => {
				const box = new Box(1, 0, (text: string) =>
					theme.bg("toolSuccessBg", text),
				);

				const label = subagentAgent || subagentName;
				const agentTag = label
					? theme.bold(theme.fg("accent", `[${label}]`))
					: "";

				if (expanded) {
					// Expanded: full tool list + denied
					const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
					const hint = theme.fg("muted", "  (Ctrl+J to collapse)");

					const toolList = toolNames
						.map((name: string) => theme.fg("dim", name))
						.join(theme.fg("muted", ", "));

					let deniedLine = "";
					if (denied.length > 0) {
						const deniedList = denied
							.map((name: string) => theme.fg("error", name))
							.join(theme.fg("muted", ", "));
						deniedLine = `\n${theme.fg("muted", "denied: ")}${deniedList}`;
					}

					const content = new Text(
						`${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
						0,
						0,
					);
					box.addChild(content);
				} else {
					// Collapsed: one-line summary
					const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
					const deniedInfo =
						denied.length > 0
							? theme.fg("dim", " · ") +
								theme.fg("error", `${denied.length} denied`)
							: "";
					const hint = theme.fg("muted", "  (Ctrl+J to expand)");

					const content = new Text(
						`${agentTag}${countInfo}${deniedInfo}${hint}`,
						0,
						0,
					);
					box.addChild(content);
				}

				return box;
			},
			{ placement: "aboveEditor" },
		);
	}

	function requestShutdown(ctx: { shutdown: () => void }) {
		setTimeout(() => {
			try {
				ctx.shutdown();
			} catch {
				// Context may already be stale after session shutdown/reload.
				// This is harmless — exit file was already written above.
			}
		}, 0);
	}

	function writeExitSignal(payload: object) {
		const sessionFile = process.env.PI_SUBAGENT_SESSION;
		if (!sessionFile) return;
		const exitFile = `${sessionFile}.exit`;
		if (existsSync(exitFile)) return;
		writeFileSync(exitFile, JSON.stringify(payload), "utf8");
	}

	function refreshDeniedTools(ctx?: { ui: { setWidget: Function } } | null) {
		if (ctx) latestCtx = ctx;
		denied = getDeniedToolNames(autoExit);
		toolNames = filterToolNames(pi.getActiveTools(), denied);
		try {
			pi.setActiveTools(toolNames);
		} catch {}
		if (latestCtx) renderWidget(latestCtx, null);
	}

	// Show widget + status bar on session start
	pi.on("session_start", (_event, ctx) => {
		applySubagentSessionTitle(ctx, pi);
		refreshDeniedTools(ctx);
		setTimeout(() => refreshDeniedTools(), 0);
		setTimeout(() => refreshDeniedTools(), 250);
	});

	pi.on("before_agent_start", (_event, ctx) => {
		refreshDeniedTools(ctx);
		return undefined;
	});

	pi.on("message_end", (event) => {
		const message = event.message as {
			role?: string;
			usage?: { output?: number };
		};
		if (message.role !== "assistant" || !message.usage) return;
		outputTokens += message.usage.output ?? 0;
	});

	// Every subagent child reports Pi shutdown through the session sidecar. This is
	// the primary lifecycle signal; mux/shell sentinels are only pane-death fallback.
	pi.on("session_shutdown", () => {
		writeExitSignal({ type: "done", outputTokens });
	});

	// Auto-exit: when the agent loop ends, shut down automatically.
	// If the user interrupts (Escape) or sends any input, auto-exit is disabled
	// for that cycle — the user wants to steer. Once they're done and the agent
	// completes normally again, auto-exit re-engages.
	// Enabled via `auto-exit: true` in agent frontmatter.
	if (autoExit) {
		let userTookOver = false;
		let agentStarted = false;

		pi.on("agent_start", () => {
			agentStarted = true;
		});

		pi.on("input", () => {
			// Ignore the initial task message that starts an autonomous subagent.
			// Only inputs after the first agent run has started count as user takeover.
			if (!shouldMarkUserTookOver(agentStarted)) return;
			userTookOver = true;
		});

		pi.on("agent_end", (event, ctx) => {
			const messages = event.messages as Parameters<
				typeof shouldAutoExitOnAgentEnd
			>[0];
			const shouldExit = shouldAutoExitOnAgentEnd(messages);
			if (!shouldExit) {
				// Agent turn was aborted (Escape). Leave the session open for
				// inspection or another prompt.
				return;
			}

			// Surface stopReason: "error" (auto-retry exhausted, provider overload, etc.)
			// via the .exit sidecar so the watcher reports a clear failure instead of
			// mistaking the crash for a successful completion.
			const errorInfo = findLatestAssistantError(messages);
			if (errorInfo) {
				const sessionFile = process.env.PI_SUBAGENT_SESSION;
				if (sessionFile) {
					try {
						writeFileSync(
							`${sessionFile}.exit`,
							JSON.stringify({
								type: "error",
								errorMessage: errorInfo.errorMessage,
								stopReason: errorInfo.stopReason,
							}),
						);
					} catch {
						// Best effort — session-file fallback can still recover errorMessage.
					}
				}
			}

			writeExitSignal({ type: "done", outputTokens });
			requestShutdown(ctx);
		});
	}

	// Toggle expand/collapse with Ctrl+J
	pi.registerShortcut("ctrl+j", {
		description: "Toggle subagent tools widget",
		handler: (ctx) => {
			expanded = !expanded;
			renderWidget(ctx, null);
		},
	});

	// caller_ping is registered for most agents as an escape hatch.
	// Only interactive agents with autoExit: false don't get it —
	// the operator is in the pane and can handle things directly.
	if (!isInteractive || autoExit) {
		pi.registerTool({
			name: "caller_ping",
			label: "Caller Ping",
			description:
				"Ask the launching chat for help, send your message there, then close this helper session. " +
				"The launching chat can later send follow-up instructions to continue this helper.",
			parameters: callerPingParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sessionFile = process.env.PI_SUBAGENT_SESSION;
			if (!sessionFile) {
				throw new Error(
					"caller_ping is only available in subagent contexts. " +
						"PI_SUBAGENT_SESSION environment variable is not set.",
				);
			}

			writeExitSignal({
				type: "ping",
				name: process.env.PI_SUBAGENT_NAME ?? "subagent",
				message: params.message,
				outputTokens,
			});
			requestShutdown(ctx);
			return {
				content: [
					{ type: "text", text: "Ping sent. Parent will be notified." },
				],
				details: {},
			};
		},
	});
}

	if (shouldRegisterSubagentDone(autoExit, denied, isInteractive)) {
		pi.registerTool({
			name: "subagent_done",
			label: "Subagent Done",
			description:
				"Call this tool when you have completed your task. " +
				"It will close this session and return your results to the main session. " +
				"Your LAST assistant message before calling this becomes the summary returned to the caller.",
			parameters: doneParams,
			async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
				writeExitSignal({ type: "done", outputTokens });
				requestShutdown(ctx);
				return {
					content: [{ type: "text", text: "Shutting down subagent session." }],
					details: {},
				};
			},
		});
	}
}
