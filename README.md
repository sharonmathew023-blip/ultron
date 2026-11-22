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
| `wrangler.toml` | Cloudflare Worker bindings and public configuration |
| `worker.test.mjs`, `tests/` | Worker, security, UI, retry, and mode regression tests |

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
```

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

The `ULTRON_STATE` KV namespace, Workers AI binding, rate-limit bindings, Google OAuth client ID, and default model settings are declared in `wrangler.toml`. Confirm the namespace and rate-limit IDs belong to the target Cloudflare account before deploying.

Deploy from the repository root:

```bash
wrangler deploy
```

For GitHub Pages, configure the repository's Pages source to deploy from `main` and the repository root. Every successful push to `main` triggers the Pages workflow.

## Memory and privacy

- Signed-in conversation archives and explicit preference facts are scoped to the verified Google subject ID.
- Use `/memory` to inspect saved preference facts.
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
- Worker logs contain operational metadata, not prompts, tokens, or account emails.

## Known limitations

- Research citations are available only when Google Search grounding succeeds. Backup providers cannot claim live source verification.
- The demo link above opens the live app; a recorded animated demo GIF has not yet been added.
- Cloud conversation archives are bounded and text-only. They are not an unlimited raw transcript store.
- Connected-app tools remain owner-only.
- Available intelligence tiers depend on the model IDs configured in Cloudflare Worker variables.

## License

No license is currently specified. All rights remain with the repository owner unless a license is added.


## Worker deadlines and lifecycle diagnostics

`npm test` runs every dependency-free CI check, including deadline and stream regressions.
The Worker creates one absolute **55-second** budget when it receives a request. Authentication,
provider retries, backoff, Gemini model changes, Groq/Cloudflare AI fallback, tool execution and
response streaming all consume that same budget; a new attempt or tool round never resets it.
Existing per-attempt/primary-provider limits may stop a stage sooner.

Before a streaming response is returned, expiry produces HTTP **504** using the existing JSON
error envelope and CORS rules. After the response is committed, expiry produces an OpenAI-compatible
SSE error with code **504**, followed by `[DONE]`, and cancels upstream reads/fetches. An AI binding
without a cancellation API is bounded for the caller; a late result is ignored rather than causing
another fallback. This does not guarantee cancellation of already-started provider computation.

Diagnostics separate `request.received`, `provider.headers_received`, `stream.first_token`,
`stream.completed` and `stream.failed`. `chat.completed` is emitted only at actual stream completion
(or when a consumer closes after `[DONE]`), never at response construction. First-token timing is
measured when the proxy forwards a visible content frame, not as a browser/network TTFB measurement.
The Cloudflare AI binding exposes a response result rather than HTTP headers, so it records
`provider.response_received` instead of inventing a headers timestamp.

Unknown-route events contain only a fixed method label and route category, plus the fixed event
metadata. The diagnostic allowlist excludes raw paths, query strings, prompts, model IDs, credentials,
headers, personal data and arbitrary error text. No production log retention, secrets, bindings,
deployment triggers or rate-limit settings are enabled or changed by this code change.


Each upstream attempt has an anonymous numeric attempt ID and independent start, header/result,
and completion/failure durations. `provider.fallback` records only allowlisted source/destination
provider names, a fixed reason category and an HTTP status when available. `stream.first_byte`
records proxy-observed TTFB from request receipt (distinct from first visible content), while
`streamDurationMs` measures response-stream handoff through completion/failure. These server-side
measurements do not claim to include browser/network transit time.

Stream `ttfbMs` measures backend receipt to the first forwarded response byte; `streamDurationMs` measures response handoff to end, and `totalDurationMs` includes pre-stream work. These are proxy observations, not browser network timings.
