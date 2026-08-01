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
- Restores the catalog from Pi's provider-scoped model store (`omniroute` in `models-store.json`) and revalidates on a four-hour freshness window, with `force` (including `pi update --models`) bypassing freshness when network is allowed.
- On first upgrade with an empty matching store, can stage a valid legacy OmniRoute cache for the current base URL without copying secrets, and keeps the per-URL legacy file for downgrade (not rewritten).
- Isolates catalogs per base URL: store entries from a different or malformed URL are deleted and never served.
- Discovers models from the primary alias catalog and supplemental VS Code metadata as one atomic current-gateway snapshot. Either participant failure cancels the sibling and rejects without writing a partial catalog; dual success publishes one fresh snapshot only.
- Keeps conversational text models only (excludes embedding/image/video/audio and non-text output), folds verified reasoning suffixes into exact bases, and filters a fixed set of synthetic Codex ultra alias IDs. Reasoning efforts come from primary tiers, verified suffixes, and matched supplemental metadata; `ultra` is never treated as a Pi effort.
- Stays available to ordinary subagent and headless/SDK child sessions once registered into Pi's `modelRuntime` and restored from the provider model store. Default pi-subagents workers pass the parent's `modelRuntime` and load extensions; intentional `extensions: false` / isolated agents are out of scope for this guarantee.

Exact atomic refresh, error sanitization, supplemental matching, reasoning fail-closed rules, and cache/store contracts live in [`docs/features.md`](docs/features.md) and [`docs/adr/0001-discover-reasoning-effort-metadata.md`](docs/adr/0001-discover-reasoning-effort-metadata.md).

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
