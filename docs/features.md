# OmniRoute Pi Extension Features

This document records the runtime features and invariants implemented by the OmniRoute Pi extension.

## Provider registration

- Registers a Pi model provider named `omniroute` with display name `OmniRoute` exactly once during extension load.
- Uses Pi's built-in `openai-responses` provider API for every model.
- Registers via public `pi.registerProvider` with `refreshModels(context)` and empty initial `models`; Pi owns refresh scheduling, store wiring, and cached-model error UI.
- Does not attach `session_start` / `session_shutdown` refresh handlers, refresh queues, argv/TTY routing, or repeated provider re-registration.
- Sends requests to `OMNIROUTE_BASE_URL` and uses the literal Pi config reference `$OMNIROUTE_API_KEY` for request authentication.
- Development baseline is `@earendil-works/pi-coding-agent` 0.83.0; peer dependency remains `*` per Pi package packaging guidance.

## Catalog persistence

- **Ownership**: Pi owns persistence in the provider-scoped models store (`context.store`, typically the `omniroute` entry in `~/.pi/agent/models-store.json`). The extension owns four-hour freshness evaluation and refresh/import behavior.
- Stored dynamic model rows include `baseUrl` (written by discovery/import).
- **URL changes**: Before projecting or stamping freshness, if a non-empty store has missing/malformed `baseUrl` or any row whose normalized base URL (trailing slash ignored) differs from the current `OMNIROUTE_BASE_URL`, the extension immediately calls `context.store.delete()` and treats the catalog as empty. It never serves IDs learned from another URL, even if a later refresh fails offline or without credentials.
- After a URL-switch delete, a current-URL-matching legacy schemaVersion=2 cache may still import once; otherwise offline/unavailable remains empty. Online discovery writes only the current URL catalog atomically.
- On first upgraded run (empty matching store), a valid legacy schemaVersion=2 OmniRoute cache matching the configured base URL is imported into the Pi store without copying secrets.
- The legacy per-URL cache file is retained for downgrade compatibility and is not rewritten or deleted by discovery.
- **Expiry**: ordinary refreshes reuse a stored catalog when `checkedAt` is within four hours; older catalogs revalidate when network is allowed.
- **Forced refresh**: Pi-native `context.force` bypasses the four-hour window (`pi update --models` invokes force) and still hits the network when allowed.

## Discovery refresh

- Primary request: `GET {baseUrl}/models?prefix=alias`.
- Optional supplemental reasoning metadata is fetched concurrently from the derived `/api/v1/vscode/_/models` URL.
- Each request uses an independent timeout (`OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS`, default 15s) composed with Pi's parent `context.signal`.
- Supplemental timeout/abort/failure is silent: it never delays, invalidates, or warns after primary success. Metadata is used only if already settled when primary is ready; otherwise the request is cancelled/ignored and normalization proceeds from alias suffixes alone.
- Parent abort before a successful write yields no partial return and no store write.
- Primary HTTP failures and successful responses with undecodable bodies reject with a sanitized fixed-category message such as `Model discovery failed with HTTP <status>` or `Model discovery failed with HTTP <status>: invalid response body` (no statusText, URL, API key, Authorization header, exception message, or response body). The extension does not `console.warn` discovery failures.
- Empty discovery results leave any previously stored catalog in place.

## Conversational model boundary

- Pi separates chat `Model` catalogs from image-generation `ImagesModel` catalogs.
- OmniRoute's mixed catalog is filtered to conversational text models:
  - exclude known non-chat types `embedding`, `image`, `video`, `audio`;
  - filter non-chat rows individually before deduplication so a valid conversational row survives when a non-chat duplicate reuses the same id;
  - require text output when `output_modalities` is declared.
- Synthetic Codex ultra aliases remain hidden; verified reasoning-effort suffix variants still fold into the base model.

## Configuration

| Environment variable | Purpose |
| --- | --- |
| `OMNIROUTE_BASE_URL` | Required base URL for OmniRoute, normalized by trimming trailing slashes. |
| `OMNIROUTE_API_KEY` | Used for live discovery and request authentication (also via Pi credential resolution). |
| `OMNIROUTE_MODEL_CACHE_PATH` | Optional explicit legacy cache path for one-time import only. |
| `OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS` | Per-request discovery timeout in milliseconds. |
| `PI_CODING_AGENT_DIR` | Base directory for the default legacy cache path. |
| `PI_OFFLINE` | Interpreted by Pi as `allowNetwork: false` during refresh. |

## Security invariants

- Never log, warn, snapshot, or embed configured OmniRoute URL or API key values.
- Cache/store payloads contain model catalog fields only.
- Tests use loopback/fake credentials only and assert error sanitization.
