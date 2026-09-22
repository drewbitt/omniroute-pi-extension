# OmniRoute for Pi

[![CI](https://github.com/drewbitt/omniroute-pi-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/drewbitt/omniroute-pi-extension/actions/workflows/ci.yml)
![Pi](https://img.shields.io/badge/pi-0.87.1-blue)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Use models from an [OmniRoute](https://github.com/diegosouzapw/OmniRoute) gateway in [Pi](https://pi.dev). The extension loads the gateway's live model catalog and sends requests through Pi's built-in OpenAI Chat Completions transport.

## Features

- Model list synced through Pi's provider lifecycle, so `/model`, Ctrl+P, and `pi --list-models` all see gateway models.
- Token costs on every turn, merged from OmniRoute's pricing table.
- Duplicate rows cleaned up before they reach the picker: effort-suffixed variants fold into their base models, and aliases of an existing row are dropped.
- Reasoning effort follows what each model supports, with safe defaults for models that advertise no tiers.
- Session affinity sent to the gateway as `x-session-id`, so sticky routing and prompt-cache affinity survive compaction instead of falling back to a hash of the first message.
- Optional per-request gateway controls (memory/skills injection, prompt compression, response cache, strict tool schemas) that default to off and need no config file.
- A failed sync keeps your current model list, and cached catalogs stay available offline for subagents.

## Install

```bash
pi install git:github.com/drewbitt/omniroute-pi-extension
```

Restart Pi after installing, or run `/reload` in an open session.

## Set up

Start Pi and run:

```text
/login omniroute
```

- Enter your OmniRoute URL, such as `http://127.0.0.1:20128`. Both root URLs and URLs ending in `/v1` work.
- Enter an API key if your server requires one.
- Run `/omni sync`, then pick a model with `/model`.

Environment variables work instead of `/login`:

```bash
export OMNIROUTE_BASE_URL=http://127.0.0.1:20128
export OMNIROUTE_API_KEY=your-key  # optional on servers without API-key auth
```

## Gateway controls

These are optional, read from the environment on every request, and off by default, so an unconfigured install sends exactly the same bytes as one without this feature. Values accept `1`, `true`, `yes`, or `on`.

| Variable | Effect |
| --- | --- |
| `OMNIROUTE_NO_MEMORY` | Skip OmniRoute's memory + skills injection, which costs tokens on every call and duplicates what Pi already provides |
| `OMNIROUTE_COMPRESSION` | Override OmniRoute's prompt-compression plan: `off`, `default`, `engine:<id>`, or a combo id |
| `OMNIROUTE_NO_CACHE` | Bypass OmniRoute's response cache |
| `OMNIROUTE_STRICT_TOOLS` | Send strict JSON-schema tool definitions for models that advertise structured output; run `/omni sync` after changing it |

OmniRoute reports the plan it applied in the `X-OmniRoute-Compression` response header, so `/omni`-side behavior is verifiable from a response. Session affinity needs no configuration: Pi's session id is always sent as `x-session-id`.

## Commands

| Command | Description |
| --- | --- |
| `/omni` | Show the current endpoint and model count |
| `/omni sync` | Refresh models from OmniRoute |
| `/omni help` | Show command help |
| `/login omniroute` | Change the endpoint or API key |

While an OmniRoute model is your active model, the footer shows the gateway's model count. On first use, before you configure anything, Pi shows a hint pointing at `/login omniroute`.

## How models are handled

- OmniRoute stays the source of truth. The extension does not create or rename model IDs, aliases, combos, `auto/*` routes, or reasoning variants.
- Chat-capable models keep their OmniRoute IDs unchanged in Pi's model picker.
- Pi handles credentials, streaming, and tool calls.
- Each secret-key credential gets its own refreshed catalog instead of sharing one.
- The extension never writes `models.json` and keeps no cache of its own.

## Development

```bash
npm install
npm run check    # typecheck, lint, format check, syntax checks, tests
npm run format   # apply fixes
```

Tests also run against a real gateway when you opt in:

```bash
OMNIROUTE_LIVE=1 \
OMNIROUTE_LIVE_BASE_URL=http://127.0.0.1:20128/v1 \
OMNIROUTE_LIVE_API_KEY=your-key \
npm test
```

Set `OMNIROUTE_LIVE_INFERENCE=1` as well to send real completions. Gateway routes vary in reliability: `cmd/*` and `openrouter/*` models answer consistently, while many other namespaces sit behind cooldowns or broken upstreams at any given moment.

A few checks only work against a running gateway: that every catalog row still opts into session affinity, and that a real request comes back with the session id and the applied compression plan echoed in the response headers. Run them after changing catalog normalization or request headers — a fixture cannot tell you the gateway stopped honoring a header.

This project started as a fork of [xz-dev/omniroute-pi-extension](https://github.com/xz-dev/omniroute-pi-extension) and has diverged substantially. See [CONTEXT.md](./CONTEXT.md) for implementation notes.

## License

[MIT](./LICENSE).
