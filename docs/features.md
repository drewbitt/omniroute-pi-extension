# Feature contract

## Native Pi provider

The extension unconditionally registers one complete `Provider<"openai-completions">` named `omniroute`. It uses Pi's provider auth, dynamic model refresh, persisted model store, and built-in Chat Completions streams. It does not register a custom API identifier, write `models.json`, or implement a custom stream parser.

## Authentication

`/login omniroute` prompts for an HTTP(S) server URL and an optional key. The normalized `/v1` URL is stored in the provider credential's environment and the key in Pi's credential store. Stored fields take precedence; missing fields may come from `OMNIROUTE_BASE_URL` and `OMNIROUTE_API_KEY`, which also supports Pi's runtime API-key override. An explicitly stored but invalid endpoint fails closed rather than falling back. Treat ambient environment values as trusted provider configuration. A configured key produces `Authorization: Bearer <key>`; public/local servers receive a harmless placeholder so Pi and OpenAI-compatible clients have a configured credential.

## Catalog discovery

The sole discovery dependency is authenticated `GET <baseUrl>/models?prefix=alias&configuredOnly=true`, where `baseUrl` ends in `/v1`. OmniRoute implements both query parameters: alias mode avoids canonical twins, and configured-only mode filters routes without an eligible connection. Both OpenAI's `{data:[...]}` envelope and a bare array are accepted. Network errors, non-2xx responses, malformed JSON, invalid envelopes, or invalid row shapes reject the refresh. Cancellation is preserved during connection and response-body reads.

No management, OpenCode, or VS Code endpoint is required. Listing is not treated as proof that every route is callable.

## Model normalization

- Model IDs are byte-for-byte catalog IDs. Bare combos are not prefixed or slugged.
- Explicit embedding, image, video, audio, rerank, moderation, and music model types are omitted, as are explicit non-text output models.
- Exact duplicate conversational IDs reject the refresh. OmniRoute owns catalog deduplication, so the extension does not invent a merged capability profile.
- Reasoning is enabled only by explicit `capabilities.reasoning`, `capabilities.thinking`, or a recognized adjustable `capabilities.effort_tiers` value; `none` alone fails closed.
- Vision is enabled only by image input or explicit vision/attachment capability.
- Positive reported limits are used. Missing limits use Pi's compatibility defaults of 128,000 context and 16,384 output, with output capped to context.
- Explicit `/v1/models` pricing is mapped from OmniRoute's per-million-token fields, enriched from the management `GET /api/pricing` table when present. Enrichment resolves by exact provider id, then a small catalog-prefix → namespace alias table for metered resellers (e.g. `opencode` rows use `opencode-go` rates), then an unambiguous basename. Flat-rate / subscription / web-session providers (coding plans, `*-web`, and Command Code) are deliberately left unpriced so a reseller's per-token list price is never attributed to a subscription — they map to zero, matching OmniRoute's own flat-rate treatment. Rows that stay unpriced for any other reason (missing rates, ambiguous basenames, or no management access) also map to zero — unknown rather than free. The management call is best-effort: discovery never depends on it.
- Every model's display name carries its underlying provider (the catalog `owned_by`), with redundant `prefix/` and `Vendor:` segments stripped; models without a catalog name fall back to the routing ID.
- Every model emits `compat: { sendSessionAffinityHeaders: true, sessionAffinityFormat: "openrouter" }`. That pair is the only pi-ai shape that produces `x-session-id`, the only header OmniRoute reads for session affinity; see [ADR 0003](./adr/0003-adopt-gateway-request-controls.md).
- `OMNIROUTE_STRICT_TOOLS` additionally emits `compat.supportsStrictMode: true`, but only for rows whose catalog advertises `capabilities.structured_output`. Strict sampling is an endpoint opt-in in pi, and one gateway model id can route to many upstreams, so it is off by default.

## Persistence and endpoint isolation

Pi owns the provider-scoped model store and generation-checked publication. A catalog is restored only when every stored model matches the provider, API, and normalized endpoint; a snapshot that names any other endpoint is deleted rather than partially restored, and the in-memory catalog stays empty. Every successful discovery is persisted as a snapshot, including one fetched with a secret key: the snapshot holds only model metadata, the credential lives in `auth.json`, and persisting is what lets a cache-only start (subagents) restore models offline. The endpoint + key digest is never persisted — it is in-memory only and exists to detect that the configuration moved, so models describing the previous endpoint, key, or configuration are dropped before discovery. A failed refresh retains its matching last-known-good catalog.

## Commands

`/omni status` reads public provider auth and current provider models. `/omni sync` calls `ctx.modelRegistry.refresh({ providers: ["omniroute"], force: true, signal })`. Commands do not maintain independent state.

## Gateway request controls

The extension sends every request through Pi's built-in Chat Completions transport and adds only the gateway controls the operator opts into. Values are read from the ambient environment on each request, so a running session picks them up without `/omni sync`; nothing is persisted.

| Variable | Header | Effect |
| --- | --- | --- |
| `OMNIROUTE_NO_MEMORY` | `x-omniroute-no-memory: true` | Skip the gateway's memory + skills injection for this request |
| `OMNIROUTE_NO_CACHE` | `X-OmniRoute-No-Cache: true` | Bypass the gateway response cache |
| `OMNIROUTE_COMPRESSION` | `x-omniroute-compression: <plan>` | Override the prompt-compression plan: `off`, `default`, `engine:<id>`, or a combo id |
| `OMNIROUTE_STRICT_TOOLS` | — (sets `compat.supportsStrictMode`) | Opt into strict-schema sampling on rows advertising `capabilities.structured_output`; needs `/omni sync` after a change |

Boolean switches accept `1`, `true`, `yes`, or `on`. `OMNIROUTE_COMPRESSION` is only sent when it is a header-safe token; anything else is dropped rather than rewritten. An explicit header passed by a caller wins over the environment. Unset or unparseable values send nothing, so an unconfigured install is byte-identical to one without this feature.

The gateway echoes the plan it resolved as `X-OmniRoute-Compression: <mode>; source=<source>`, and echoes a caller-supplied session as `X-OmniRoute-Session-Id: ext:<pi session id>`.

`OMNIROUTE_NO_CACHE` is rarely needed: the gateway cache is an exact-match signature that also requires an explicit numeric `temperature: 0`, and Pi only sends `temperature` when a model or the user sets it.
