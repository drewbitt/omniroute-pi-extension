# OmniRoute for Pi

Use models from an [OmniRoute](https://github.com/diegosouzapw/OmniRoute) gateway in [Pi](https://pi.dev). The extension loads the gateway's live model catalog and sends requests through Pi's built-in OpenAI Chat Completions transport.

## Install

```bash
pi install git:github.com/drewbitt/omniroute-pi-extension
```

Restart Pi after installation, or run `/reload` in an existing session.

Tested with Pi 0.84.2.

## Set up

You need a running, reachable [OmniRoute server](https://github.com/diegosouzapw/OmniRoute). Start Pi and run:

```text
/login omniroute
```

Enter your OmniRoute URL, such as `http://127.0.0.1:20128`, and an API key if your server requires one. Then refresh the catalog and choose a model:

```text
/omni sync
/model
```

You can also set environment variables before starting Pi:

```bash
export OMNIROUTE_BASE_URL=http://127.0.0.1:20128
export OMNIROUTE_API_KEY=your-key  # optional on servers without API-key auth
```

Both root URLs and URLs ending in `/v1` work.

## Commands

| Command | Description |
| --- | --- |
| `/omni` | Show the current endpoint and model count |
| `/omni sync` | Refresh models from OmniRoute |
| `/omni help` | Show command help |
| `/login omniroute` | Change the endpoint or API key |

After a sync the footer shows the loaded model count and sync time. If the extension is registered but never configured, the first session start points at `/login omniroute`.

## How models are handled

OmniRoute remains the source of truth for model IDs, aliases, combos, `auto/*` routes, reasoning variants, visibility, and catalog metadata. The extension does not create or rename those entries. Rows that exactly mirror their declared parent under another namespace are dropped as duplicates. For chat-capable models exposed to Pi, the OmniRoute model ID is preserved unchanged.

Pi handles credentials, streaming, and tool calls. Secret-key catalogs are refreshed instead of being reused across credentials. The extension does not modify `models.json` or keep its own cache.

## Moving from an older OmniRoute extension

Remove the old package before installing this one. Older releases may also leave a `providers.omni` entry with `"api": "omni-prompt-tools"` in `~/.pi/agent/models.json`. That API no longer exists in Pi.

Back up the file, remove only that legacy `providers.omni` block, then run `/login omniroute`. Leave unrelated providers and model overrides alone.

## Development

Development requires Node.js 22.19 or newer.

```bash
npm install
npm run check
```

The check command runs the TypeScript compiler, Biome (lint + formatting), syntax checks, and tests for provider loading, authentication, catalog refresh, persistence, cancellation, and Chat Completions tool calls. Run `npm run format` to apply fixes.

This project is based on [xz-dev/omniroute-pi-extension](https://github.com/xz-dev/omniroute-pi-extension). See [CONTEXT.md](./CONTEXT.md) for implementation notes and history.

## License

MIT
