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
- Explicit `/v1/models` pricing is mapped from OmniRoute's per-million-token fields, enriched from the management `GET /api/pricing` table when present. Enrichment resolves by exact provider id, then a small catalog-prefix → namespace alias table (Command Code's `cmd`/`command-code`/`cc-provider` rows use the `cc` rates), then an unambiguous basename. Rows that stay unpriced (missing rates, ambiguous basenames, or no management access) map to zero — unknown rather than free. The management call is best-effort: discovery never depends on it.
- An explicit catalog name is used when present; otherwise the exact routing ID is the display name.

## Persistence and endpoint isolation

Pi owns the provider-scoped model store and generation-checked publication. Public/keyless catalogs are restored only when every stored model matches the provider, API, and normalized endpoint. Catalogs fetched with a secret key are not persisted because two keys on the same endpoint may have different model permissions. Endpoint, key, or configuration changes clear stale models before discovery. A failed public refresh retains its matching last-known-good catalog.

## Commands

`/omni status` reads public provider auth and current provider models. `/omni sync` calls `ctx.modelRegistry.refresh({ providers: ["omniroute"], force: true, signal })`. Commands do not maintain independent state.
