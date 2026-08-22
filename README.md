# OmniRoute for Pi

[![CI](https://github.com/drewbitt/omniroute-pi-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/drewbitt/omniroute-pi-extension/actions/workflows/ci.yml)
![Pi](https://img.shields.io/badge/pi-0.84.2-blue)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Use models from an [OmniRoute](https://github.com/diegosouzapw/OmniRoute) gateway in [Pi](https://pi.dev). The extension loads the gateway's live model catalog and sends requests through Pi's built-in OpenAI Chat Completions transport.

## Features

- Model list synced through Pi's provider lifecycle, so `/model`, Ctrl+P, and `pi --list-models` all see gateway models.
- Token costs on every turn, merged from OmniRoute's pricing table.
- Duplicate rows cleaned up before they reach the picker: effort-suffixed variants fold into their base models, and aliases of an existing row are dropped.
- Reasoning effort follows what each model supports, with safe defaults for models that advertise no tiers.
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

## Commands

| Command | Description |
| --- | --- |
| `/omni` | Show the current endpoint and model count |
| `/omni sync` | Refresh models from OmniRoute |
| `/omni help` | Show command help |
| `/login omniroute` | Change the endpoint or API key |

After a sync the footer shows the loaded model count and sync time. On first use, before you configure anything, Pi shows a hint pointing at `/login omniroute`.

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

This project started as a fork of [xz-dev/omniroute-pi-extension](https://github.com/xz-dev/omniroute-pi-extension) and has diverged substantially. See [CONTEXT.md](./CONTEXT.md) for implementation notes.

## License

[MIT](./LICENSE).
