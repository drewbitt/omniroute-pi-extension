# OmniRoute Pi Extension

A native [Pi](https://pi.dev) provider for an OmniRoute gateway. It uses Pi's current provider/auth/catalog APIs, keeps OmniRoute model IDs unchanged, and routes requests through OmniRoute's OpenAI-compatible Chat Completions endpoint.

## Install

```bash
pi install git:github.com/drewbitt/omniroute-pi-extension
```

The extension targets `@earendil-works/pi-*` 0.84.2.

## Configure

The provider is always registered, so it appears in Pi's login UI even before it has models:

```text
/login omniroute
```

Enter the OmniRoute server URL (for example `http://127.0.0.1:20128`) and an API key. The key is optional for local/public servers. Pi stores the credential in its normal auth store; this extension never writes credentials or catalogs to `models.json`.

Environment fallback is also supported:

```bash
export OMNIROUTE_BASE_URL=http://127.0.0.1:20128
export OMNIROUTE_API_KEY=your-key   # optional for public/local servers
```

Root URLs and URLs ending in `/v1` are both accepted and normalized to exactly one `/v1`.

## Commands

- `/omni` or `/omni status` — show endpoint, auth source, cached model count, and pricing caveat.
- `/omni sync` — force a live catalog refresh with Pi's public model registry.
- `/omni help` — show command help.

Opening Pi's model picker and `pi update --models` also use the provider's normal refresh lifecycle.

## Behavior

- Fetches authenticated `GET /v1/models?prefix=alias&configuredOnly=true` and accepts both `{ "data": [...] }` and bare-array responses.
- Preserves every returned model ID exactly, including bare combo IDs, `auto/*`, and provider-prefixed IDs.
- Filters only explicit non-conversational models and maps reasoning, vision, context, and output limits conservatively from catalog metadata.
- Uses `openai-completions` and Pi's built-in streaming implementation; there is no custom prompt-tool protocol.
- Uses Pi's generation-checked dynamic model store. Failed refreshes retain the last-known-good catalog. Stored catalogs are restored only when their endpoint matches the current credential, preventing endpoint-switch leakage.
- Uses zeroes for Pi's required cost fields because `/v1/models` does not provide reliable resolved-route pricing. **Zero means unknown, not free**, especially for combos.

## Migrating from md-riaz's extension

Older `md-riaz/omniroute-agent-extension` or `omniroute-pi-ext-integration` installs may leave a `providers.omni` entry with `api: "omni-prompt-tools"` in `~/.pi/agent/models.json`. That identifier is invalid in current Pi and is the root cause described in md-riaz issues #7/#8 and PR #9.

This extension registers a separate `omniroute` provider and intentionally does not edit user-owned `models.json`. Before use:

1. remove the old extension/package;
2. back up `~/.pi/agent/models.json`;
3. remove only the legacy `providers.omni` block if it uses `omni-prompt-tools` (preserve unrelated providers and overrides);
4. run `/login omniroute`, then `/omni sync`.

Do not copy a plaintext legacy key into this repository; let Pi's login flow store it.

## Development

```bash
npm install
npm run check
```

`npm run check` runs strict TypeScript checking, syntax checks, and the Node test suite. Tests cover loader registration, environment/login auth, URL normalization, dynamic refresh/offline restore/endpoint isolation, cancellation and catalog failures, exact IDs, and Chat Completions text/tool round-trips.

## Provenance

This repository is a fork of [xz-dev/omniroute-pi-extension](https://github.com/xz-dev/omniroute-pi-extension), whose Pi-native provider lifecycle and test approach are the foundation. Migration analysis also credits [md-riaz/omniroute-agent-extension](https://github.com/md-riaz/omniroute-agent-extension) and contributor RaviTharuma's [PR #9](https://github.com/md-riaz/omniroute-agent-extension/pull/9).

## License

MIT
