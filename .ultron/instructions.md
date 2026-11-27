# ULTRON coding runtime

This repository now ships a coding-agent runtime alongside the browser app. The browser and
the Cloudflare Worker stay the orchestrator; the runtime is the only thing that touches files,
commands and git.

## Layout

| Path | Responsibility |
| --- | --- |
| `protocol/schemas.js` | Tool registry, task states, event contract, input validation |
| `protocol/task-events.js` | Event construction, payload caps, SSE framing |
| `authorization/path-policy.js` | Workspace root boundary, traversal and symlink escape checks, protected files |
| `authorization/command-policy.js` | No-shell command parsing, deny -> ask -> allow |
| `authorization/approval-store.js` | Task- and user-bound approvals with expiry |
| `agent/permission-engine.js` | Modes (plan, manual, accept-edits, restricted) and rule precedence |
| `agent/tool-registry.js` | Named executors, schema validation, result sanitizing |
| `agent/task-state.js` | Validated task transitions |
| `agent/event-log.js` | Sequenced, replayable, bounded event log |
| `agent/context-manager.js` | Compact tree, retrieval, output summaries, context budget |
| `agent/agent-loop.js` | plan -> tool -> permission -> approval -> execute -> summarize |
| `runtime/patch-manager.js` | Exact-once edits, diffs, checkpoints, undo |
| `runtime/command-runner.js` | No-shell spawn, timeout, output caps, process-group kill |
| `runtime/sandbox-policy.js` | Environment allowlist, redaction, limits |
| `runtime/workspace-manager.js` | Pairing codes, hashed workspace tokens |
| `runtime/tool-executors.js` | Workspace-bound read/write/command implementations |
| `runtime/local-daemon.js` | Pairing, task API, SSE events, approvals, undo |

## Run the local runtime

```bash
node runtime/local-daemon.js --root . --owner you@example.com
```

The daemon prints a one-time pairing code, listens on `127.0.0.1:4319`, and refuses every
request without a paired token. Nothing outside `--root` is reachable, `.env` and key files
are protected, and commands are checked against `authorization/command-policy.js` before
`spawn` with no shell.

Phase 1 (read-only) is complete: `workspace.list`, `file.read`, `file.glob`, `file.search`,
`git.status`, `git.diff`, `test.detect`. Phase 2 tools (`file.write`, `file.edit`,
`file.delete`, `patch.apply`) are implemented behind approval, with diffs, checkpoints and
undo.

## Not yet implemented

- Worker routes for `/agent/tasks` (the daemon API is ready for them).
- Model-driven planning inside the Worker: the loop takes an injected planner.
- Git write workflow: task branches, commit approval, pull-request drafts.
- Subagents, hooks, MCP adapter.
- Isolated cloud workspaces.

## Rules the runtime enforces

1. The model names a tool; it never executes anything.
2. Unknown tools and unknown fields are rejected before an executor runs.
3. Deny beats ask beats allow, and command-policy denies beat every mode.
4. Paths resolve inside the approved root, with protected files refused.
5. Every edit returns a diff and is undoable; `.env` and key material are never read or written.
6. Commands run without a shell, with a timeout, output cap and process-group kill.
7. Provider keys never enter the runtime environment, a log, or a tool result.
