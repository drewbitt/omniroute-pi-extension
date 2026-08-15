# Feature contract

## Native Pi provider

The extension unconditionally registers one complete `Provider<"openai-completions">` named `omniroute`. It uses Pi's provider auth, dynamic model refresh, persisted model store, and built-in Chat Completions streams. It does not register a custom API identifier, write `models.json`, or implement a custom stream parser.

## Authentication

`/login omniroute` prompts for an HTTP(S) server URL and an optional key. The normalized `/v1` URL is stored in the provider credential's environment and the key in Pi's credential store. `OMNIROUTE_BASE_URL` and `OMNIROUTE_API_KEY` are ambient fallbacks. A configured key always produces `Authorization: Bearer <key>`; public/local servers receive a harmless placeholder so Pi and OpenAI-compatible clients have a configured credential.

## Catalog discovery

The sole discovery dependency is authenticated `GET <baseUrl>/models?prefix=alias&configuredOnly=true`, where `baseUrl` ends in `/v1`. Both OpenAI's `{data:[...]}` envelope and a bare array are accepted. Network errors, non-2xx responses, malformed JSON, invalid envelopes, or invalid row shapes reject the refresh. Abort signals are passed directly to `fetch`.

No management, pricing, OpenCode, or VS Code endpoint is required. Listing is not treated as proof that every route is callable.

## Model normalization

- Model IDs are byte-for-byte catalog IDs. Bare combos are not prefixed or slugged.
- Explicit embedding/image/video/audio model types and explicit non-text output models are omitted.
- Exact duplicate IDs select the row with vision support, then larger context/output limits.
- Reasoning is enabled only by explicit `capabilities.reasoning`, `capabilities.thinking`, or a recognized adjustable `capabilities.effort_tiers` value; `none` alone fails closed.
- Vision is enabled only by image input or explicit vision/attachment capability.
- Positive reported limits are used; defaults are 128,000 context and 16,384 output, with output capped to context.
- Required Pi cost fields are zero because reliable resolved-route pricing is unavailable. This represents unknown cost, not free service.

## Persistence and endpoint isolation

Pi owns the provider-scoped model store and generation-checked publication. A refresh restores stored models only when provider ID, API, and normalized model `baseUrl` match the current credential. An endpoint switch therefore starts with an empty catalog instead of briefly exposing the previous endpoint's models. A failed online refresh retains a matching restored last-known-good catalog.

## Commands

`/omni status` reads public provider auth and current provider models. `/omni sync` calls `ctx.modelRegistry.refresh({ providers: ["omniroute"], force: true, signal })`. Commands do not maintain independent state.
