# pi-subagents

`pi-subagents` is a highly curated multi-agent framework for [Pi agent harness](https://github.com/earendil-works/pi-mono).

It began as a fork of [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents), then grew into a monumental refactor: named agents, interactive panes, background workers, async parallelism, blocking agents, child-to-parent communication, forked context, a beautiful TUI widget, and much more!

Use it when one agent should hand work to another agent instead of trying to do everything in one transcript.

https://github.com/user-attachments/assets/e0b97493-6c9b-4710-ba26-a6c08230ba28

## Install

```bash
pi install git:github.com/edxeth/pi-subagents
```

## The model

A subagent is a named agent file plus a launch policy.

The agent file says who the child is and how it should run. The parent still owns the decision to launch it. The child owns the task it receives.

Two axes matter:

- `interactive` or `background`: where the child runs
- async or sync: whether the parent waits

`interactive` means foreground. Pi opens a pane through cmux, tmux, zellij, or WezTerm.

`background` means headless. Pi starts a `pi -p` child process without opening a pane.

Async means the parent gets a “started” result and the child answer comes back later. Sync means the parent waits for the child answer before it continues.

## Agent definitions

Agents live here:

- `.pi/agents/` in the project
- `~/.pi/agent/agents/` globally, or `$PI_CODING_AGENT_DIR/agents/` when that env var is set

Project agents override global agents with the same name.

A minimal agent:

```md
---
name: scout
description: Inspect the codebase and report the relevant files.
mode: background
auto-exit: true
tools: read,grep,find,ls
---

You are a codebase scout. Find the relevant files, read enough to be useful, and return a concise map of what matters.
```

The `description` matters. Pi uses it for ambient awareness, explained next.

For a fuller example of the intended style, see the [scout agent gist by edxeth](https://gist.github.com/edxeth/11b6a6cdf7c6068771a5e3f96ab5e34b). It shows the shape this package works best with: a sharp role, an explicit contract, and little room for interpretation.

### Frontmatter reference

| Field | Default | What it controls |
| --- | --- | --- |
| `name` | filename | Stable agent name used by `agent: "..."` |
| `description` | unset | One-line routing hint for ambient awareness |
| `enabled` | `true` | Set `false` to hide and block the agent |
| `model` | Pi default | Child model, including optional thinking suffix |
| `thinking` | model default | Child thinking level |
| `cwd` | parent cwd | Working directory for the child |
| `extensions` | all extensions | Comma-separated extension allowlist for the child |
| `tools` | `all` | Built-in Pi tools: `all`, `none`, or a comma-separated subset of `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` |
| `deny-tools` | unset | Extra tool names to remove from the child |
| `skills` | unset | Comma-separated skills loaded into the child prompt |
| `no-context-files` | `false` | Skip `AGENTS.md` and `CLAUDE.md` discovery in the child |
| `no-session` | `false` | Use an ephemeral child session file and delete it after completion |
| `auto-exit` | `false` | Close the child after a normal completion |
| `system-prompt` | task body | `append` uses `--append-system-prompt`; `replace` uses `--system-prompt` |
| `session-mode` | `lineage-only` | `standalone`, `lineage-only`, or `fork` |
| `fork-output-reserve-tokens` | `10000` | Room reserved for the child task and answer when Pi trims forked history |
| `flags` | unset | Extra CLI flags passed to the child pi process (e.g. `--verbose` or `--some-custom-flag`). Appended after all generated args — last-wins semantics against conflicting generated args. Useful for extension-registered flags or pi built-in flags not covered by other frontmatter fields. |
| `spawning` | `false` | Allow the child to launch subagents |
| `async` | `true` | `false` makes the launch sync |
| `blocking` | `false` | Legacy sync flag. Prefer `async: false` |
| `mode` | `interactive` | `interactive` pane or `background` process |
| `parent-close-policy` | `terminate` | What happens to the child when the parent session exits: `terminate` (kill) or `continue` (leave running) |

Named-agent frontmatter wins over duplicate launch-time fields such as `model`, `tools`, `cwd`, and `mode`. The parent can still request `async: false` to wait, though agent frontmatter with `blocking: true` overrides. Parent can request `fork: true` for a forked launch.

## Ambient awareness

Ambient awareness is the quiet note Pi gives the parent model about available agents.

Pi stores that note as a hidden custom message. The user does not see it as chat. The LLM sees it as context before it decides whether to call `subagent`.

The note contains agents with `description` fields and labels each one by what the child would see:

- `isolated context` means the child starts clean. The parent must write a self-contained task.
- `forked context` means the child sees the parent transcript. The parent can rely on context already in the chat.

Pi sends ambient awareness once when a top-level session first needs it, then sends a fresh copy after reload if the agent list changed.

Normal child sessions do not receive ambient awareness, even with `spawning: true`. They sit under a parent that made the first routing decision. A `standalone` child can receive its own ambient awareness because Pi treats it as a root session.

Agents without descriptions remain launchable, but they do not appear in ambient awareness.

Disable it with:

```bash
PI_SUBAGENT_DISABLE_AMBIENT_AWARENESS=1 pi
```

## Launching and waiting

Async launch:

1. parent calls `subagent`
2. child starts
3. parent receives a “started” result
4. child result comes back later by steer

Sync launch:

1. the agent has `async: false` in frontmatter
2. parent waits
3. tool result contains the child result

#### Mixed sync and async batches

When one tool-call batch contains at least one sync/blocking subagent, the whole batch becomes a barrier. Pi still launches every child with its own frontmatter, so an `async: true` child keeps async launch metadata for resume, but the parent waits until every child in that batch completes and receives all results as tool results.

```
subagent(sync), subagent(async), subagent(async) → all launch
→ parent waits until all three finish
→ returns all three completed results
```

Pure async batches stay detached: the parent receives started results and child results arrive later by steer.

After a pure async launch, the parent should get out of the way unless it has separate work. If the parent keeps solving the delegated task, you paid for two agents to race each other.

By default, a successful async launch ends the parent turn after the current tool batch. The children keep running. Their results come back later.

Leave `PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN` unset, or set it to `0`, to keep that guard. Set it to `1` when you want the parent model to keep going after async launches.

```bash
PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN=1 pi
```

That only removes the runtime stop. The parent still owns only work it did not delegate.

## Session modes

A child session has two questions:

- should Pi attach it to the parent session tree?
- should the child model see the parent transcript?

`lineage-only` attaches the child to the tree and starts the model clean. This is the default. You keep lineage, resume paths, and artifact attribution without copying the whole parent chat.

`standalone` starts clean and skips the parent link. Use it for unrelated work.

`fork` attaches the child to the tree and copies parent context. Use it when the child needs decisions, files, or prior results already in the parent transcript.

The `isolated context` and `forked context` labels from ambient awareness describe model memory. They do not describe where Pi stores the child in the session tree. A `lineage-only` child is still a child of the parent session even though its model starts clean.

For nested launches, `parent` means the session that spawned the child:

```text
top-level session
└── child session
    └── grandchild session
```

### Forked sessions

A fork copies the parent notebook into a new child run.

Pi trims that notebook before the child sees it. It reads the parent's recorded input-token checkpoints, keeps the newest useful slice, and drops old turns until the inherited history fits inside the child model's context window.

The context window is the child's total token budget for inherited history, the new task, tool chatter, and the answer it will write. If the copied parent history would exceed that budget, Pi cuts from the oldest safe point.

A fork needs to know the child model's context window. Pin the agent to a registered model when Pi cannot infer it. If Pi cannot know the context window, it refuses the fork instead of guessing and overflowing the child.

`fork-output-reserve-tokens` sets the part of the child context window that Pi refuses to fill with parent history. The child needs that space for the new task and its answer. A larger reserve gives the child more room to work. A smaller reserve lets it inherit more history.

A fork also gets a handoff marker. Pi appends a short system-prompt note, then writes a hidden custom message with a `<subagent-boundary>` tag at the end of the copied transcript. The tag says: the old messages are background, and the next user message is the child task.

That marker prevents a common failure. A child can read the parent's old role, old tools, or old task and start acting like the parent. The marker tells it where the fork begins.

The marker also steers the model. If you want a raw fork with no marker and no boundary instruction, set:

```bash
PI_SUBAGENT_DISABLE_CHILD_CONTEXT_BOUNDARY=1
```

### `no-session: true`

`no-session: true` gives the child a temporary session file and deletes it after completion.

For `fork`, Pi seeds that temporary file with trimmed parent history. For `lineage-only`, Pi also gives the child inherited context because there is no persistent child file where it can store lineage metadata.

Use `no-session: true` for disposable children. Do not use it when you need resume, `caller_ping`, or durable child history.

## Child lifecycle

A child can finish in three ways.

### `auto-exit`

Use `auto-exit: true` for autonomous agents. The child exits after a normal assistant completion.

### `subagent_done`

Manual-lifecycle children get a `subagent_done` tool. The child writes its final assistant message, calls `subagent_done`, and Pi returns that final message to the parent.

Pi hides `subagent_done` for `auto-exit: true` agents. If you want an interactive child that only the operator can close, add `subagent_done` to `deny-tools`.

### `caller_ping`

Use `caller_ping` when the child needs the parent. The child sends a message up, exits, and leaves a session file that the parent can resume.

## Resuming child sessions

`subagent_resume` starts an existing child session again. You can pass a follow-up task.

Resume tries to preserve the original launch shape: mode, model, prompt style, cwd, tools, extensions, and lifecycle settings. A resumed child should continue as the same child, even if the agent file changed after the first launch.

## Child output

The child's final assistant message is its output.

For large output, let the child use Pi's `write` tool and mention the path in its final message.

## Child tools and extensions

Children load all extensions by default. Set `extensions` when you want a smaller child environment.

```md
---
name: reviewer
extensions: .pi/extensions/safe-tools.ts, npm:@foo/bar
---
```

When `extensions` is set, Pi launches the child with `--no-extensions`, injects the subagent protocol helper, then loads only the allowlisted extensions.

Local paths stay paths. Package and remote sources keep their normal prefixes:

```md
---
name: reviewer
extensions: ./extensions/local.ts, npm:@foo/bar, git:github.com/user/repo
---
```

The `tools` field narrows built-in Pi tools. Protocol tools such as `caller_ping` and `subagent_done` stay available unless you deny them.

`spawning` defaults to `false`. That removes `subagent`, `subagents_list`, and `subagent_resume` from children. Set `spawning: true` only for coordinator agents.

## Parent shutdown policy

Set `parent-close-policy` in the agent frontmatter:

```yaml
---
name: scout
parent-close-policy: continue
---
```

| Value | Effect |
| --- | --- |
| `terminate` | Stop the child when the parent session exits |
| `continue` | Leave the child running and stop delivering its result to the closed parent |

The default is `terminate`.

## UI

The parent session gets a live widget above the editor. It shows running children, elapsed time, activity, and context usage.

Every `subagent` call requires a short `title`. The widget shows that title instead of a raw task preview.

Child sessions can also get session titles like:

```text
[scout agent] Auth flow reconnaissance
```

Disable child session titles with `PI_SUBAGENT_DISABLE_SESSION_TITLES=1`.

## Launching children through a wrapper

By default, the extension launches children with the same Pi entrypoint it can infer from the parent. If your real Pi command goes through a wrapper, set it:

```bash
PI_SUBAGENT_PI_COMMAND="my-wrapper pi" my-wrapper pi
```

The wrapper applies to new children and resumed children. Quoted paths work:

```bash
PI_SUBAGENT_PI_COMMAND="'/path with spaces/my-wrapper' pi" pi
```

## Environment variables

User-facing knobs:

| Variable | Use |
| --- | --- |
| `PI_SUBAGENT_PI_COMMAND` | Launch children through a wrapper command |
| `PI_SUBAGENT_MUX` | Force `cmux`, `tmux`, `zellij`, or `wezterm` |
| `PI_CODING_AGENT_DIR` | Use a different Pi agent config root |
| `PI_SUBAGENT_DISABLE_AMBIENT_AWARENESS` | Disable ambient awareness |
| `PI_SUBAGENT_DISABLE_COORDINATOR_ONLY_TURN` | Set `1` to let the parent keep running after async launches |
| `PI_SUBAGENT_DISABLE_CHILD_CONTEXT_BOUNDARY` | Set `1` for raw forks with no boundary marker |
| `PI_SUBAGENT_DISABLE_SESSION_TITLES` | Disable automatic child session names |
| `PI_ARTIFACT_PROJECT_ROOT` | Override internal artifact storage root |
| `PI_SUBAGENT_SHELL_READY_DELAY_MS` | Change the pane startup delay before Pi sends the child command |
| `PI_SUBAGENT_ENABLE_SET_TAB_TITLE` | Register the optional `set_tab_title` tool |
| `PI_SUBAGENT_RENAME_TMUX_WINDOW` | Let `set_tab_title` rename the tmux window |
| `PI_SUBAGENT_RENAME_TMUX_SESSION` | Let `set_tab_title` rename the tmux session |

Runtime internals you may see while debugging:

- `PI_DENY_TOOLS`
- `PI_SUBAGENT_EXTENSIONS`
- `PI_SUBAGENT_NAME`
- `PI_SUBAGENT_AGENT`
- `PI_SUBAGENT_PARENT_SESSION`
- `PI_SUBAGENT_SESSION`
- `PI_SUBAGENT_SURFACE`
- `PI_SUBAGENT_SESSION_TITLE`
- `PI_SUBAGENT_AUTO_EXIT`

Live test knobs:

- `PI_SUBAGENT_ALLOW_LIVE_WINDOWS`
- `PI_SUBAGENT_LIVE_MODEL`
- `PI_SUBAGENT_KEEP_E2E_TMP`
- `PI_SUBAGENT_LIVE_LOCK_PATH`

## Testing

Unit tests:

```bash
npm test
```

Live tests:

```bash
PI_SUBAGENT_ALLOW_LIVE_WINDOWS=1 npm run test:e2e-live-blocking
PI_SUBAGENT_ALLOW_LIVE_WINDOWS=1 npm run test:e2e-live-mix-blocking
npm run test:e2e-live-deny-tools
npm run test:e2e-live-tools
npm run test:e2e-live-extensions
npm run test:e2e-live-stop-after-turn
```

The live window tests require an explicit opt-in because they open real terminal windows.

## Credits

- upstream foundation: [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents)
- this fork: [edxeth/pi-subagents](https://github.com/edxeth/pi-subagents)

## License

MIT
