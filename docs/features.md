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
- On first upgraded run (empty matching store), a valid legacy schemaVersion=2 OmniRoute cache matching the configured base URL is staged in memory without copying secrets. Persist that import only when returning without online discovery (fresh legacy timestamp, `allowNetwork: false`, or no API key). If online dual discovery is attempted and either participant fails, write nothing to the store; the legacy file remains for a later attempt. Successful dual discovery writes only the fresh gateway snapshot once and does not also persist the staged legacy catalog.
- The legacy per-URL cache file is retained for downgrade compatibility and is not rewritten or deleted by discovery.
- **Expiry**: ordinary refreshes reuse a stored catalog when `checkedAt` is within four hours; older catalogs revalidate when network is allowed.
- **Forced refresh**: Pi-native `context.force` bypasses the four-hour window (`pi update --models` invokes force) and still hits the network when allowed.

## Discovery refresh

- Primary request: `GET {baseUrl}/models?prefix=alias`. This is the sole authority for model existence, IDs, visibility, limits, modalities, and core capabilities, including primary `capabilities.effort_tiers`.
- Supplemental grouped VS Code metadata is fetched concurrently from the derived `/api/v1/vscode/_/models` URL and may only add recognized effort levels for models already present in the primary catalog. It is a **mandatory atomic participant**, not optional/non-fatal.
- **Supplemental matching priority** (matches code): for each primary model, first merge efforts keyed by normalized strict keys from supplemental `id`, `root`, and `parent`. Only when that primary model has no strict match, use root fallback: the primary model's root (or id if root is absent) if that root appears **exactly once** among supplemental metadata rows that contribute efforts. Ambiguous multi-row roots never fall back.
- Each request uses an independent timeout (`OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS`, default 15s) composed with Pi's parent `context.signal`.
- Both requests start concurrently as the two required participants of one current-gateway snapshot. **All failure classes cancel the sibling immediately and write/publish nothing.** Failure class distinction:
  - Network errors, non-2xx HTTP, invalid JSON, invalid catalog envelope (`data` missing or not an array), or invalid endpoint-role row shapes (primary: non-empty string `id` plus safe types for consumed identity/modality/limit/capabilities fields; supplemental: every row a record with safe identity types and non-throwing nested config shape) => sanitized fixed-category `Error` (for example `Model discovery failed with HTTP <status>` or `...: invalid response body`; no statusText, URL, API key, Authorization header, exception message, or response body). Any invalid row fails that participant atomically, cancels the sibling, and writes nothing.
  - Endpoint/child timeout (parent-independent) and parent abort => sanitized `AbortError` (no timeout reason leak).
  - Successful JSON `{ data: [] }` from either participant is valid, not failure.
- Successful dual-participant refresh writes an atomic snapshot of the current gateway merge only. Never carry forward or merge per-model metadata from an older Provider Model Store or legacy cache into a fresh snapshot.
- Effort data is the union of primary `capabilities.effort_tiers`, verified primary suffix variants (`none`/`low`/`medium`/`high`/`xhigh`/`max` only when the exact base ID is present), and matched supplemental metadata. `ultra` is not a Pi effort and is never mapped to `max`. `none` remains parseable/foldable and maps to Pi off/omission, but alone it is not an adjustable strength and must not set `reasoning: true` or produce an all-null map. Adjustable reasoning is true only when the fresh set contains at least one recognized adjustable strength (`low`/`medium`/`high`/`xhigh`/`max`). If primary marks reasoning/thinking true (or explicit non-reasoning) but no such adjustable strength is available from the three fresh sources (including none-only), fail closed: `reasoning: false` and omit `thinkingLevelMap` (never publish all-null maps); the model remains in the catalog with fresh base metadata.
- `thinkingLevelMap` is not free-form `string|null` values. Fresh generation and store/legacy restore both require the exact complete Pi key set with per-level wire efforts only: `off: null`; `minimal`/`low`: `null` or `'low'`; `medium`: `null` or `'medium'`; `high`: `null` or `'high'`; `xhigh`: `null` or `'xhigh'`; `max`: `null` or `'max'`. Incomplete/extra maps, unknown strings, wrong-level recognized values (e.g. `high: 'low'`), and all-null maps fail closed on restore (`reasoning: false`, map omitted). Do not synthesize or rewrite invalid values.
- Parent abort or either participant's discovery failure before a successful dual write yields no partial return and no store write (including no deferred legacy-import write when discovery was attempted after an empty matching store). Sibling cancel must not leave unhandled rejection races. The extension does not `console.warn` discovery failures.
- When both participants succeed and the normalized Pi catalog is empty, that is still a valid current snapshot: atomically write `{ models: [], checkedAt }` and return `[]`. Never fall back to stale stored or legacy models after successful empty discovery.

## Conversational model boundary

- Pi separates chat `Model` catalogs from image-generation `ImagesModel` catalogs.
- OmniRoute's mixed catalog is filtered to conversational text models:
  - exclude known non-chat types `embedding`, `image`, `video`, `audio`;
  - filter non-chat rows individually before deduplication so a valid conversational row survives when a non-chat duplicate reuses the same id;
  - require text output when `output_modalities` is declared.
- Explicitly exclude only complete normalized alias IDs `codex/gpt-5.6-sol-ultra`, `cx/gpt-5.6-sol-ultra`, `codex/gpt-5.6-terra-ultra`, and `cx/gpt-5.6-terra-ultra`. No `owned_by`/root/prefix heuristics. Same-root different-provider IDs remain. `ultra` is ignored as an effort tier.

## Configuration

| Environment variable | Purpose |
| --- | --- |
| `OMNIROUTE_BASE_URL` | Required base URL for OmniRoute, normalized by trimming trailing slashes. |
| `OMNIROUTE_API_KEY` | Used for live discovery and request authentication (also via Pi credential resolution). |
| `OMNIROUTE_MODEL_CACHE_PATH` | Optional explicit legacy cache path for one-time import only. |
| `OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS` | Per-request discovery timeout in milliseconds. |
| `PI_CODING_AGENT_DIR` | Base directory for the default legacy cache path. |
| `PI_OFFLINE` | Interpreted by Pi as `allowNetwork: false` during refresh. |

## Subagent and headless availability

- OmniRoute is a standard Pi `registerProvider` + `refreshModels` provider. After registration and offline store restore, models are resolved through Pi's public `modelRuntime.getModel('omniroute', id)`.
- Ordinary subagent/worker sessions that inherit the parent `modelRuntime` (pi-subagents default path with `extensions: true`) keep the same OmniRoute catalog without requiring interactive TUI or `session_start` hooks.
- A fresh headless/SDK services instance with the same agent directory can restore the catalog from Pi's `models-store.json` via `createAgentSessionServices` + `refresh({ allowNetwork: false })`.
- Intentional exclusions: agents with `extensions: false` or `isolated: true` do not load extension tools; this guarantee covers the ordinary shared-`modelRuntime` worker path and store-backed standalone restore, not user-disabled extension loading.

## Security invariants

- Never log, warn, snapshot, or embed configured OmniRoute URL or API key values.
- Cache/store payloads contain model catalog fields only.
- Tests use loopback/fake credentials only and assert error sanitization.
