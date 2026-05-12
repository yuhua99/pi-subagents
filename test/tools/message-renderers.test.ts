import { assert, describe, it } from "../support/index.ts";
import {
	formatSubagentCompletionLines,
	formatTaskPreview,
} from "../../src/tools/message-renderers.ts";

const theme = {
	fg(_tone: string, text: string) {
		return text;
	},
	bg(_tone: string, text: string) {
		return text;
	},
	bold(text: string) {
		return text;
	},
} as any;

describe("subagent message renderers", () => {
	it("renders expandable task previews with the native tool expand hint", () => {
		const preview = formatTaskPreview(
			Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"),
			{ expanded: false },
			theme,
		);

		assert.match(preview, /line 1\nline 2/);
		assert.match(preview, /\.\.\. \(2 more lines,.*to expand\)/);
		assert.doesNotMatch(preview, /line 11/);
	});

	it("does not character-truncate long single-line tasks", () => {
		const task = `${"a".repeat(220)} final words`;
		const preview = formatTaskPreview(task, { expanded: false }, theme);

		assert.match(preview, /final words/);
		assert.doesNotMatch(preview, /more chars/);
	});

	it("renders completed subagent tool results with summary and expandable tail", () => {
		const lines = formatSubagentCompletionLines(
			{
				content: [
					{
						type: "text",
						text: "Sub-agent \"astronaut\" completed (exit code 0).\n\nignored fallback",
					},
				],
				details: {
					name: "astronaut",
					agent: "astronaut",
					status: "completed",
					exitCode: 0,
					elapsed: 7,
					summary: [
						"result",
						"a",
						"b",
						"c",
						"d",
						"e",
						"f",
						"g",
						"h",
						"i",
						"j",
					].join("\n"),
				},
			},
			{ expanded: false },
			theme,
		);

		assert.equal(lines[0], "✓ astronaut (astronaut) — completed (7s)");
		assert.deepEqual(lines.slice(1, 11), ["result", "a", "b", "c", "d", "e", "f", "g", "h", "i"]);
		assert.match(lines[11], /\.\.\. \(1 more lines,.*to expand\)/);
	});
});
