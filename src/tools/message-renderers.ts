import type { AgentToolResult, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import type {
	SubagentPingMessageDetails,
	SubagentResultMessageDetails,
} from "../types.ts";

type ThemeLike = Parameters<Parameters<ExtensionAPI["registerMessageRenderer"]>[1]>[2];
type RenderOptions = { expanded: boolean };

function formatElapsedDefault(seconds: number): string {
	const s = Math.round(seconds);
	const m = Math.floor(s / 60);
	return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function expandHint(): string {
	try {
		return keyHint("app.tools.expand", "to expand");
	} catch {
		return "ctrl+o to expand";
	}
}

function stripSessionRef(text: string): string {
	return text.replace(/\n\nSession: .+\nResume: .+$/, "");
}

function firstTextContent(result: AgentToolResult<unknown>): string {
	const first = result.content?.[0];
	return first?.type === "text" ? first.text : "";
}

function extractSummary(
	rawContent: string,
	details: (SubagentResultMessageDetails & { summary?: string; status?: string }) | undefined,
	elapsed: string,
): string {
	if (typeof details?.summary === "string") return details.summary;
	const name = details?.name ?? "subagent";
	const exitCode = details?.exitCode ?? 0;
	return stripSessionRef(rawContent)
		.replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
		.replace(`Sub-agent "${name}" completed (exit code ${exitCode}).\n\n`, "")
		.replace(`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`, "")
		.replace(`Sub-agent "${name}" failed (status failed).\n\n`, "")
		.replace(`Sub-agent "${name}" was cancelled (status cancelled).\n\n`, "");
}

export function appendExpandableLines(
	lines: string[],
	body: string,
	options: RenderOptions,
	theme: ThemeLike,
	maxCollapsedLines = 10,
	color: "dim" | "toolOutput" = "dim",
): void {
	if (!body) return;
	const bodyLines = body.split("\n");
	const visibleLines = options.expanded
		? bodyLines
		: bodyLines.slice(0, maxCollapsedLines);
	for (const line of visibleLines) {
		lines.push(theme.fg(color, line));
	}
	const remaining = bodyLines.length - visibleLines.length;
	if (!options.expanded && remaining > 0) {
		lines.push(
			theme.fg("muted", `... (${remaining} more lines,`) +
				` ${expandHint()}` +
				theme.fg("muted", ")"),
		);
	}
}

export function formatTaskPreview(
	task: string | undefined,
	options: RenderOptions,
	theme: ThemeLike,
): string {
	if (!task) return "";
	const lines: string[] = [];
	appendExpandableLines(lines, task, options, theme, 10, "toolOutput");
	return lines.length ? `\n${lines.join("\n")}` : "";
}

export function formatSubagentCompletionLines(
	result: AgentToolResult<unknown>,
	options: RenderOptions,
	theme: ThemeLike,
	formatElapsed: (elapsed: number) => string = formatElapsedDefault,
): string[] {
	const details = result.details as
		| (SubagentResultMessageDetails & {
				summary?: string;
				status?: string;
				task?: string;
		  })
		| undefined;
	const rawContent = firstTextContent(result);
	const name = details?.name ?? "subagent";
	const exitCode = details?.exitCode ?? 0;
	const elapsed = details?.elapsed != null ? formatElapsed(details.elapsed) : "?";
	const agentTag = details?.agent ? theme.fg("dim", ` (${details.agent})`) : "";
	const status =
		details?.status === "cancelled"
			? "cancelled"
			: exitCode === 0
				? "completed"
				: `failed (exit ${exitCode})`;
	const icon = exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
	const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`;
	const lines = [header];
	const summary = extractSummary(rawContent, details, elapsed);
	appendExpandableLines(lines, summary, options, theme);
	if (options.expanded && details?.sessionFile) {
		lines.push("");
		lines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
		lines.push(theme.fg("dim", `Resume:  pi --session ${details.sessionFile}`));
	}
	return lines;
}

export function renderSubagentCompletionText(
	result: AgentToolResult<unknown>,
	options: RenderOptions,
	theme: ThemeLike,
	component?: Text,
	prefixBlankLine = false,
): Text {
	const text = component ?? new Text("", 0, 0);
	const rendered = formatSubagentCompletionLines(result, options, theme).join("\n");
	text.setText(prefixBlankLine ? `\n${rendered}` : rendered);
	return text;
}

export function registerSubagentMessageRenderers(
	pi: ExtensionAPI,
	formatElapsed: (elapsed: number) => string,
): void {
	pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
		const details = message.details as SubagentResultMessageDetails | undefined;
		if (!details) return undefined;

		return {
			invalidate() {},
			render(width: number): string[] {
				const bgFn =
					(details.exitCode ?? 0) === 0
						? (text: string) => theme.bg("toolSuccessBg", text)
						: (text: string) => theme.bg("toolErrorBg", text);
				const result = {
					content: [
						{
							type: "text" as const,
							text: typeof message.content === "string" ? message.content : "",
						},
					],
					details,
				};
				const box = new Box(1, 1, bgFn);
				box.addChild(
					new Text(
						formatSubagentCompletionLines(
							result,
							options,
							theme,
							formatElapsed,
						).join("\n"),
						0,
						0,
					),
				);
				return ["", ...box.render(width)];
			},
		};
	});

	pi.registerMessageRenderer("subagent_ping", (message, options, theme) => {
		const details = message.details as SubagentPingMessageDetails | undefined;
		if (!details) return undefined;

		return {
			invalidate() {},
			render(width: number): string[] {
				const name = details.name ?? "subagent";
				const elapsed =
					details.elapsed != null ? formatElapsed(details.elapsed) : "?";
				const agentTag = details.agent
					? theme.fg("dim", ` (${details.agent})`)
					: "";
				const header = `${theme.fg("accent", "?")} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} needs help ${theme.fg("dim", `(${elapsed})`)}`;
				const rawMessage =
					details.message ??
					(typeof message.content === "string" ? message.content : "");
				const body = stripSessionRef(rawMessage);
				const contentLines = [header];

				appendExpandableLines(contentLines, body, options, theme, 4);
				if (options.expanded && details.sessionFile) {
					contentLines.push("");
					contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
					contentLines.push(
						theme.fg("dim", `Resume:  pi --session ${details.sessionFile}`),
					);
				}

				const box = new Box(1, 1, (text: string) =>
					theme.bg("toolPendingBg", text),
				);
				box.addChild(new Text(contentLines.join("\n"), 0, 0));
				return ["", ...box.render(width)];
			},
		};
	});
}
