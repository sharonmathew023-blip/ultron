# ULTRON

A browser-based AI workspace with a responsive chat interface, conversation history, skills, HTML artifact previews, and a Cloudflare Worker backend.

**Live app:** https://sharonmathew023-blip.github.io/ultron/

## Features

- Responsive chat interface for desktop and mobile.
- Conversation creation, search, deletion, and browser-local history with signed-in KV archive sync.
- Dark and light themes.
- Streaming AI responses through an OpenAI-compatible Worker endpoint.
- Google sign-in verified by the Worker.
- Per-account and per-IP rate limiting.
- Model fallback, bounded retries, and KV-backed cooldown handling.
- Per-account persistent conversation archives and explicit preference memory (`/memory`, `/forget-memory`).
- Research-mode Google Search grounding with clickable source links.
- Built-in and imported skills with validation.
- Owner-gated connected-app integrations.
- Sandboxed HTML artifact preview, code view, and download.
- JSON conversation export.

## Architecture

| File | Responsibility |
| --- | --- |
| `index.html`, `styles.css` | Application interface |
| `skill-rules.js`, `skill-engine.js`, `builtin-skills.js` | Skill parsing, validation, activation, and UI |
| `worker.js` | API, authentication, rate limiting, AI streaming, fallback, per-user KV memory/archive, telemetry, and owner-only integrations |
| `wrangler.toml` | Cloudflare Worker configuration |
| `worker.test.mjs`, `tests/` | Automated tests |

## Run locally

Use Node.js 20+ for the test suite. Serve the frontend from the repository root:

```bash
python -m http.server 8000
```

Open http://localhost:8000.

Run tests:

```bash
node --test worker.test.mjs
node --test tests/*.test.mjs
```

The hosted chat backend still depends on the configured Cloudflare Worker services and secrets.

## Worker configuration

Set secrets in Cloudflare. Never commit provider keys or consumer credentials.

- `GEMINI_API_KEY`
- `GOOGLE_CLIENT_ID`
- `ULTRON_OWNER_EMAIL` for owner-only features
- `COMPOSIO_API_KEY` for connected-app integration

Configure rate-limiter bindings and the optional `ULTRON_STATE` KV namespace as described in `wrangler.toml`. Set `ALLOWED_ORIGINS` to the exact production origin when restricting browser access.

## Security notes

- The Worker verifies Google ID tokens. Frontend state is not an authentication boundary.
- Imported skills are untrusted input and must pass validation.
- Connected tools are owner-gated and restricted by the Worker.
- Generated HTML must remain isolated in a sandboxed preview.
- Keep all service-role keys and provider secrets out of browser code and Git history.

## Known limitations

- Cloud archive sync requires a valid Google sign-in and the `ULTRON_STATE` KV binding. The browser keeps a local copy if cloud sync is unavailable.
- Cloud conversation archives are text-only; binary attachments and generated image bytes remain local.
- Memory v1 stores explicit low-risk preference statements only. Use `/memory` to inspect and `/forget-memory [phrase]` to delete matching facts; `/forget-memory` alone clears all saved facts.
- Demo mode is a UI preview, not an offline AI model.
- Available models depend on the configured provider account and Worker settings.

## License

No license is currently specified. All rights remain with the repository owner unless a license is added.
