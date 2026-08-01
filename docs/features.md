# OmniRoute Pi Extension Features

## Complete public provider registration

- Activates only with a non-empty `OMNIROUTE_BASE_URL`, normalized by trimming trailing slashes.
- Registers exactly one complete `Provider<"openai-responses">` through `pi.registerProvider(provider)`.
- Uses only public Pi 0.83 API seams from `@earendil-works/pi-ai/compat`: `createProvider`, `envApiKeyAuth`, `openAIResponsesApi`, `Model`, and `RefreshModelsContext`. Pi's extension loader aliases this compatibility entrypoint to the host-provided Pi AI implementation.
- The provider has ID `omniroute`, display name `OmniRoute`, no static models, public Responses `stream`/`streamSimple` behavior, and `envApiKeyAuth("OmniRoute API key", ["OMNIROUTE_API_KEY"])`.
- Does not attach session lifecycle handlers, manually register provider configs, import Pi internals, or bundle a second Pi core.

## Pi-owned lifecycle

`createProvider` is the owner of dynamic catalog lifecycle:

- restores Pi's provider-scoped dynamic model snapshot before each fetch;
- persists a successful fresh list and timestamp;
- de-duplicates concurrent refresh calls;
- retains/restores the prior store snapshot when Pi `Models.refresh` handles a failed network refresh through its offline retry;
- receives Pi's effective credential, `allowNetwork`, and parent abort signal.

The extension does **not** implement its own cache files, TTL/four-hour freshness, `force` branching, legacy cache import, base-URL store isolation/deletion, store payload projection/sanitization, or offline fallback. Pi's public store semantics are accepted as the product lifecycle.

## Atomic gateway discovery

- Primary request: `GET {baseUrl}/models?prefix=alias`; it solely owns model IDs, visibility, modalities, context limits, output limits, and primary `capabilities.effort_tiers`.
- Derived grouped VS Code metadata request: `/api/v1/vscode/_/models`; it may contribute recognized reasoning effort only.
- Both requests start concurrently and are mandatory participants. A network error, timeout, non-2xx response, invalid JSON/envelope/row aborts the sibling and rejects. No partial fresh list is returned.
- Both endpoints accept `{ "data": [] }`; dual empty success is a valid empty fresh snapshot.
- Per-request timeout uses `OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS` (default 15 seconds), composed with Pi's parent `RefreshModelsContext.signal`.
- Errors are fixed-category and sanitized: no URL, status text, response body, Authorization header, credential, or parser/transport detail is exposed. Parent abort and participant timeout use `AbortError`.

## Model and reasoning normalization

- Retain conversational text rows only: exclude `embedding`, `image`, `video`, and `audio` types; reject declared non-text output; filter before deduplication so a valid chat duplicate survives.
- Select the better duplicate by image-input capability, then larger context/output limits.
- Exclude exactly `codex/gpt-5.6-sol-ultra`, `cx/gpt-5.6-sol-ultra`, `codex/gpt-5.6-terra-ultra`, and `cx/gpt-5.6-terra-ultra`. No provider/root/DeepSeek heuristic is applied.
- Every returned row is a full `Model<"openai-responses">` with `provider`, `id`, `api`, `baseUrl`, input, zero cost fields, and context/output limits (128000/16384 defaults).
- Fresh effort union: primary `effort_tiers`, a suffix only when the exact base ID is also present in primary (`-none`, `-low`, `-medium`, `-high`, `-xhigh`, `-max`), then supplemental strict `id`/`root`/`parent` matches. Root fallback is used only with no strict match and exactly one contributing supplemental root.
- `ultra` is ignored. `none` remains foldable but does not itself enable reasoning. Missing adjustable effort fails closed to `reasoning: false` without `thinkingLevelMap`.

## Availability

- Pi's model runtime resolves this complete provider normally.
- Ordinary child workers sharing the parent's model runtime and standalone headless services using the same Pi models store restore OmniRoute through the public lifecycle.
- Intentional extension exclusion or isolated runtimes remain outside this guarantee.

## Configuration

| Environment variable | Purpose |
| --- | --- |
| `OMNIROUTE_BASE_URL` | Required OmniRoute endpoint. |
| `OMNIROUTE_API_KEY` | Public Pi env credential fallback. |
| `OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS` | Discovery timeout per required participant. |
