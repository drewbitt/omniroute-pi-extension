# OmniRoute Pi Extension

A Pi extension that registers the `omniroute` model provider from an OmniRoute-compatible gateway using Pi's public `refreshModels` provider contract.

## Installation

```bash
pi install git:github.com/xz-dev/omniroute-pi-extension
```

Requires Pi coding-agent APIs available in upstream `@earendil-works/pi-coding-agent` 0.83.0+ (`registerProvider` + `refreshModels` + provider-scoped model store). The published peer dependency remains `*` so Pi installs do not bundle a second core copy.

## What it does

- Reads `OMNIROUTE_BASE_URL` and `OMNIROUTE_API_KEY`.
- Registers `omniroute` once with Pi's built-in `openai-responses` API and a public `refreshModels(context)` implementation.
- Restores the catalog from Pi's provider-scoped model store (`omniroute` in `models-store.json`); the extension evaluates four-hour `checkedAt` freshness and refresh behavior.
- On first upgrade with an empty matching store, imports a valid legacy OmniRoute cache for the current base URL without copying secrets, and keeps the per-URL legacy file for downgrade (not rewritten).
- If the store holds models from a different base URL (or missing/malformed stored `baseUrl`), deletes that store entry immediately and never serves those IDs; current-URL legacy import or online discovery may repopulate.
- Ordinary refresh reuses a store fresher than four hours; `force` (including `pi update --models`) bypasses freshness and still hits the network when allowed.
- Fetches the primary alias catalog and optional supplemental reasoning metadata concurrently with independent timeouts composed with Pi's abort signal. Supplemental timeout/abort/failure is silent and never blocks primary success.
- Parent cancellation publishes no partial catalog and writes no store entry.
- Primary discovery failures reject through Pi (no `console.warn`, no configured URL/key in error text).
- Keeps conversational text models only (excludes embedding/image/video/audio and non-text output), while preserving suffix folding and synthetic Codex ultra alias filtering.
- Stays available to ordinary subagent and headless/SDK child sessions: once registered into Pi's `modelRuntime` and restored from the provider model store, OmniRoute resolves without TUI or session lifecycle hooks. Default pi-subagents workers pass the parent's `modelRuntime` and load extensions; intentional `extensions: false` / isolated agents are out of scope for this guarantee.

## Configuration

| Variable | Purpose |
| --- | --- |
| `OMNIROUTE_BASE_URL` | OmniRoute base URL, without a trailing slash. |
| `OMNIROUTE_API_KEY` | API key used for live discovery and requests. |
| `OMNIROUTE_MODEL_CACHE_PATH` | Optional explicit legacy cache path used only for one-time import. |
| `OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS` | Per-request discovery timeout in milliseconds (primary and supplemental each). |
| `PI_CODING_AGENT_DIR` | Base directory for the default legacy cache path. |
| `PI_OFFLINE` | Handled by Pi (`allowNetwork: false`); the extension does not run its own offline branch. |

Default legacy cache path (import only):

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/omniroute/models-<first 16 hex chars of sha256(baseUrl)>.json
```

Authoritative persistence after import is Pi's provider-scoped models store.

## Commands

- `npm test` — run the test suite, including the two-turn Responses consumer contract against the upstream Pi-AI bundled with the ordinary `@earendil-works/pi-coding-agent` development dependency, plus the subagent/headless model-availability regression.
- `npm run check` — run syntax checks and tests.
- `npm run check:syntax` — run the Node syntax check used by the test flow.

## Repository

https://github.com/xz-dev/omniroute-pi-extension
