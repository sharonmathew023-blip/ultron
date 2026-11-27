# ULTRON

A browser-based AI chat app with two modes: **Chat** and **Research**. It includes Google sign-in, streaming responses, conversation history, per-account memory, imported skills, and sandboxed HTML artifact previews.

**Live app:** https://sharonmathew023-blip.github.io/ultron/

## Modes

- **Chat:** everyday questions, writing, coding, and creative work.
- **Research:** Google Search grounding with clickable source links.

The browser sends abstract intelligence tiers. Provider model IDs, API keys, routing, retries, and fallback stay in the Worker.

## Architecture

| File | Responsibility |
| --- | --- |
| `index.html`, `styles.css` | Responsive browser interface |
| `modes.js` | Server-owned Chat and Research prompts |
| `skill-rules.js`, `skill-engine.js`, `builtin-skills.js` | Skill parsing, validation, activation, and UI |
| `worker.js` | Authentication, rate limits, AI routing, streaming, citations, fallback, memory/archive APIs, telemetry, owner-only integrations |
| `agent/`, `authorization/`, `protocol/`, `runtime/` | Secure coding-agent runtime (see below) |
| `.ultron/` | Project instructions, permission settings, and coding skills |
| `wrangler.toml` | Cloudflare Worker bindings and public configuration |
| `worker.test.mjs`, `tests/` | Worker, security, UI, retry, mode, and coding-runtime tests |

## Run locally

Requirements: Node.js 22+ and Python 3.

```bash
python -m http.server 8000
```

Open http://localhost:8000. Google sign-in and AI requests still need the hosted Worker and a valid OAuth client configuration.

Run the complete test suite:

```bash
node --check worker.js
node tests/inline-scripts.test.mjs
node tests/skill-engine.test.mjs
node tests/security.test.mjs
node --test worker.test.mjs
node --test tests/composer-regression.test.mjs
node --test modes.test.mjs
node --test tests/client-timeout.test.mjs
node --test identity.test.mjs
node --test tests/device-registry.test.mjs
node --test memory.test.mjs
```

## Coding runtime

The browser app answers questions. The coding runtime is what can inspect a repository, edit
files, run checks and show diffs. It is a separate Node.js process, so the Worker never gets
shell access and the browser is never trusted with it.

```bash
node runtime/local-daemon.js --root . --owner you@example.com
```

The daemon prints a one-time pairing code, listens on `127.0.0.1:4319`, and rejects every
request without a paired token. Its task API is small and explicit:

| Route | Purpose |
| --- | --- |
| `POST /pair` | Exchange the one-time code for a short-lived token |
| `GET /workspace` | Workspace identity and the enabled tool list |
| `POST /tasks` | Create a task bound to the paired owner |
| `POST /tasks/:id/tools/:tool` | Run one validated tool call |
| `GET /tasks/:id/events` | Server-Sent Events, replayable with `?after=` or `Last-Event-ID` |
| `POST /tasks/:id/approvals/:id` | `once`, `task`, or `deny` |
| `POST /tasks/:id/cancel` | Cancel a task; later tool calls are refused |
| `POST /tasks/:id/undo` | Restore every path the task changed |

Tools are a fixed registry, never arbitrary shell. Read-only: `workspace.list`, `file.read`,
`file.glob`, `file.search`, `git.status`, `git.diff`, `test.detect`. Approved edits:
`file.write`, `file.edit`, `file.delete`, `patch.apply`. Policy-checked commands:
`shell.run`, `test.run`, `lint.run`, `build.run`.

How a call is decided, in order:

1. The tool name must exist in `protocol/schemas.js`, and input is rebuilt from declared fields only.
2. The path must resolve inside the workspace, and protected files (`.env`, `.ssh`, keys, credentials) are refused.
3. Command policy denies beat everything; then `deny` rules, then `ask`, then `allow`, then the mode baseline.
4. An `ask` result becomes an approval bound to that user and task, with an expiry.
5. Every edit returns a diff, keeps a checkpoint, and can be undone.

Nothing is committed, pushed, deployed or installed without an explicit approval, and the runtime
holds no provider key: planning stays in the Worker, execution stays in the runtime.

The runtime is covered by dependency-free tests:

```bash
node --test tests/agent-loop.test.mjs
node --test tests/runtime-daemon.test.mjs
```

`.ultron/instructions.md` documents the layout, the enforced rules, and what is still planned
(Worker task routes, git write workflow, subagents, hooks, MCP, cloud workspaces).

## Deploy the Worker

Install Wrangler and authenticate to the Cloudflare account:

```bash
npm install --global wrangler
wrangler login
```

Set secrets. Never put provider credentials in browser code or commit them:

```bash
wrangler secret put GEMINI_API_KEY
wrangler secret put ULTRON_OWNER_EMAIL
wrangler secret put COMPOSIO_API_KEY
```

Owner-only website reading is disabled until `BROWSE_ALLOWED_HOSTS` is configured in Cloudflare Worker Variables. Set it to a comma-separated list of exact hostnames, for example `docs.example.com,developer.mozilla.org`. The reader permits HTTPS on the standard port only, and every redirect must stay on a listed hostname. Wildcards are not supported.

The `ULTRON_STATE` KV namespace, Workers AI binding, rate-limit bindings, Google OAuth client ID, and default model settings are declared in `wrangler.toml`. Confirm the namespace and rate-limit IDs belong to the target Cloudflare account before deploying.

Deploy from the repository root:

```bash
wrangler deploy
```

For GitHub Pages, configure the repository's Pages source to deploy from `main` and the repository root. Every successful push to `main` triggers the Pages workflow.

## Memory and privacy

- Signed-in conversation archives and explicit preference facts are scoped to the verified Google subject ID.
- Use `/memory` to inspect saved preference facts and `/memory search <phrase>` to find relevant notes.
- Explicit new preferences replace simple contradictory preferences; exact duplicates are collapsed server-side.
- Relevant notes are ranked and passed as untrusted user context, never injected as system instructions.
- Use `/forget-memory [phrase]` to remove matching facts. Use `/forget-memory` alone to clear all saved facts.
- Cloud archives are text-only; binary attachments remain local.
- Memory v1 stores explicit low-risk preferences only. It does not infer sensitive traits.
- Cloud sync needs the `ULTRON_STATE` KV binding. Local conversation history remains available if cloud sync fails.

## Security

- The Worker verifies Google ID tokens; browser state is not an authentication boundary.
- Provider keys and owner credentials remain Worker secrets.
- Public chat is rate-limited per account and IP.
- Retry attempts are bounded across the provider chain.
- Imported skills are untrusted and must pass validation.
- Generated HTML runs in a sandboxed preview.
- Owner-only page reading is restricted to exact `BROWSE_ALLOWED_HOSTS` entries; redirects must remain on listed hosts.
- Worker logs contain operational metadata, not prompts, tokens, or account emails.
- The coding runtime is workspace-bound: traversal, absolute paths, escaping symlinks and protected files are refused.
- Runtime commands never use a shell, are policy-checked, time out, cap output, and kill their process group.
- Runtime tokens are stored hashed; approvals are bound to one user, one task, and expire.

## Known limitations

- Research citations are available only when Google Search grounding succeeds. Backup providers cannot claim live source verification.
- The demo link above opens the live app; a recorded animated demo GIF has not yet been added.
- Cloud conversation archives are bounded and text-only. They are not an unlimited raw transcript store.
- Connected-app tools remain owner-only.
- Available intelligence tiers depend on the model IDs configured in Cloudflare Worker variables.

## License

No license is currently specified. All rights remain with the repository owner unless a license is added.
