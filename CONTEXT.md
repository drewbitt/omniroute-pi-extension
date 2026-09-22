# OmniRoute Pi Extension

## Language

**OmniRoute Provider**: A complete Pi `Provider<"openai-completions">` backed by an OmniRoute gateway.
_Avoid_: legacy provider-config registration, custom API identifiers, Responses-only transport.

**Model Catalog**: The authenticated public `/v1/models` result normalized into complete Pi models.
_Avoid_: extension-owned cache files, management endpoints as mandatory dependencies.

**Pi Provider Lifecycle**: Pi owns credentials, generation-checked catalog publication, refresh scheduling, and provider-scoped snapshot persistence. The extension validates restores by endpoint, persists every discovered catalog (it holds only model metadata), and never persists the credential scope, which stays in memory to detect a configuration change.
_Avoid_: direct `models.json` mutation, plaintext extension config, automatic legacy migration.

**Exact Routing ID**: Every Pi model ID is the exact OmniRoute catalog ID.
_Avoid_: `combo/` prefixing, OpenCode provider prefixes, suffix folding, synthesized IDs.

**Catalog Pricing**: `/v1/models` per-million-token prices map to Pi cost fields, enriched from the management `GET /api/pricing` table (exact provider id, then prefix→namespace aliases for metered resellers like `opencode`→`opencode-go`, then unambiguous basename). Flat-rate / subscription / web-session providers (Command Code, Claude Code `claude`/`cc`, `*-web`, coding plans) are left at zero to match OmniRoute's flat-rate treatment. The management call is best-effort and never blocks discovery. Missing or ambiguous prices remain zero because Pi requires numbers.
_Avoid_: treating missing zeroes as proof that a model or combo is free, or depending on the management endpoint for catalog discovery.

## Structure

- `index.ts` constructs the provider and registers `/omni` status/sync commands.
- `src/gateway-catalog.ts` owns URL normalization, native auth, and authenticated catalog retrieval.
- `src/model-normalizer.ts` conservatively converts gateway rows to Pi Chat Completions models.

## Gateway behavior notes (verified against v3.8.50, 2026-08-22)

- Thinking "off" omits `reasoning_effort` entirely. Some providers reject explicit `none` even when they advertise it, and pi sends map.off on every no-effort request (title generation, quick tasks), so any non-null value causes 400s. Omitting lets the gateway's default-effort injection (#10957) apply, which is acceptable: that default is the vendor's own recommendation.
- `/v1/models?prefix=alias&configuredOnly=true` semantics are unchanged; new row fields (`release_date`, `family`, `api_format`, `pricing.reasoning`, …) are additive and safely ignored.
- Effort-suffixed rows (`<model>-low`, `-xhigh`, ...) are aliases the gateway synthesizes for clients that cannot send reasoning_effort; no query parameter suppresses them. pi picks effort through thinking levels, so a variant whose base exists and advertises the tier adds nothing and is dropped. Variants without a base row, or for tiers the base does not advertise, are kept. See `docs/research/upstream-effort-variants.md`.
- Resilience contract: malformed catalog rows are dropped (not fatal), duplicate ids resolve first-wins (not fatal), and an empty catalog is legitimate. Fetches carry hard timeouts (30s catalog / 15s pricing) so an ambient signal cannot hang a refresh.
- Effort vocabularies are route-dependent; trust the catalog's tier lists where present. Command-code routes translate every advertised tier down to the native set (Kimi K3 natively takes only low|high|max, but cmd routes also accept medium/xhigh). Suffix-variant ids can 400 where base + reasoning_effort works, which the dedupe also removes.
- Reasoning models without advertised tiers get a default map where low/medium/high/xhigh pass through and `max`/`minimal` are unsupported (raw values 400 on non-native routes). Provider-native exceptions (DeepSeek V4, Codex GPT-5.6, Kimi K3) appear through their advertised tiers.

## Gateway behavior notes (verified against v3.8.51, 2026-09-22)

- Session affinity: the gateway resolves its affinity key from `x-codex-session-id`, `x-session-id`, or `x-omniroute-session` (`open-sse/services/...` `extractSessionAffinityKey`), then body metadata (`session_id`, `conversation_id`, `prompt_cache_key`), then a hash of the first input message. That last fallback is derived from the head of the transcript, so compaction breaks it. `X-Session-Id` also feeds `extractExternalSessionId`, which is why the gateway echoes a caller session as `X-OmniRoute-Session-Id: ext:<id>`. Live settings on this deployment: `disableSessionStickiness: false`, `promptCacheAffinityEnabled: true`. pi-ai emits no affinity header unless a model sets `compat.sendSessionAffinityHeaders` with `sessionAffinityFormat: "openrouter"`; see ADR 0003.
- Prompt compression is on by default: a plain request reports `x-omniroute-compression: stacked; source=default`. Every response echoes the resolved plan and its source (`request-header`, `routing-override`, `active-profile`, `auto-trigger`, `default`, `off`), so an override is verifiable from headers alone. The master switch is a hard gate: the header can disable compression but never enable it when the operator turned it off.
- The response cache is an exact-match SHA-256 signature over `(model, normalized messages, temperature, top_p, apiKeyId)` and additionally requires an explicit numeric `temperature: 0`. pi-ai sends `temperature` only when a model or caller sets it, so pi never reads from this cache by default and `X-OmniRoute-No-Cache` is a niche control.
- Usage field mismatch, not fixable client-side: OmniRoute emits cache-creation tokens as `usage.prompt_tokens_details.cache_creation_tokens` (both in the streaming and non-streaming OpenAI translators), while pi-ai reads `usage.prompt_tokens_details.cache_write_tokens`. Cache reads work (`prompt_tokens_details.cached_tokens` matches on both sides), so `cost.cacheRead` is accurate; `cost.cacheWrite` stays zero for routes that bill cache writes, under-reporting cost modestly. `input` stays correct because the gateway keeps cache-creation tokens out of `prompt_tokens` and pi-ai subtracts nothing for them. Recommended upstream fix: also emit `cache_write_tokens` alongside `cache_creation_tokens` in both translators.
- Strict tool schemas are accepted: probing `strict: true` tool definitions returned 200 with a correct tool call on five namespaces (`zai`, `kiro`/Claude, `cmd`/DeepSeek, OpenRouter, `kg`). The gateway passes `tool.strict` through its translators and its `capabilities.structured_output` flag comes from models.dev, i.e. it describes the model rather than the endpoint that will serve the id. Hence strict sampling stays behind `OMNIROUTE_STRICT_TOOLS` instead of being a default.
- Model-level enrichment has no source data: the catalog publishes no image limits, no prompt-cache lifetimes, and no per-token pricing tiers, and `/v1/models` sends neither `ETag` nor `Last-Modified`, so `ModelsStoreEntry.etag`/`lastModified` cannot be used. `pricing.cached`/`pricing.cache_creation` are cache-read and cache-write rates per million (`pricingSync`), which matches how the extension maps them onto `cost.cacheRead`/`cost.cacheWrite`.
