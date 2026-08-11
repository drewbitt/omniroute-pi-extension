# OmniRoute Pi Extension

A Pi extension that registers an `omniroute` provider backed by an OmniRoute-compatible gateway.

## Installation

```bash
pi install git:github.com/xz-dev/omniroute-pi-extension
```

Requires Pi 0.83-compatible public `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` APIs. The package declares both as peers and development dependencies so it uses Pi's installed core rather than bundling another one.

## What it does

- Activates only when `OMNIROUTE_BASE_URL` is valid and non-empty.
- Registers one complete public Pi provider with `createProvider`, `envApiKeyAuth("OmniRoute API key", ["OMNIROUTE_API_KEY"])`, and `openAIResponsesApi()` from Pi's public compatibility entrypoint.
- Leaves credential resolution, store restore/write, refresh scheduling, in-flight refresh de-duplication, and offline fallback to Pi's provider lifecycle.
- Fetches configured public alias routes from the primary catalog and grouped VS Code reasoning metadata concurrently as required atomic participants. Either failure cancels the other and returns a sanitized error; dual success—including empty arrays—publishes one fresh model list.
- Uses primary rows for model IDs, friendly display names, and base metadata. Reasoning effort is the union of primary effort tiers, verified exact-base suffix variants, and matched supplemental metadata. Unknown effort values (including `ultra`) are ignored; no adjustable effort and `none` alone fail closed.
- Keeps conversational text models, de-duplicates them, and excludes only the four accepted synthetic `codex`/`cx` ultra aliases.
- Remains available to ordinary shared-modelRuntime subagents and headless services through Pi's provider store and public lifecycle.

The exact gateway contracts are documented in [`docs/features.md`](docs/features.md) and [`docs/adr/0001-discover-reasoning-effort-metadata.md`](docs/adr/0001-discover-reasoning-effort-metadata.md).

## Configuration

| Variable | Purpose |
| --- | --- |
| `OMNIROUTE_BASE_URL` | Required OmniRoute base URL; trailing slashes are normalized. |
| `OMNIROUTE_API_KEY` | Pi's environment fallback for the OmniRoute credential lifecycle. |

There is no extension-owned cache path, freshness interval, legacy cache import, base-URL store isolation, or offline-mode branch. Pi supplies `allowNetwork`, persistence, restoration, and fallback through the public provider API.

## Commands

- `npm test` — run loopback provider, loader, Responses, and subagent compatibility tests.
- `npm run check` — run syntax checks and the full test suite.
- `npm run check:syntax` — run the syntax check used by the test flow.

## Repository

https://github.com/xz-dev/omniroute-pi-extension
