# OmniRoute Pi Extension

## Language

**OmniRoute Provider**: A complete Pi `Provider<"openai-completions">` backed by an OmniRoute gateway.
_Avoid_: legacy provider-config registration, custom API identifiers, Responses-only transport.

**Model Catalog**: The authenticated public `/v1/models` result normalized into complete Pi models.
_Avoid_: extension-owned cache files, management endpoints as mandatory dependencies.

**Pi Provider Lifecycle**: Pi owns credentials, generation-checked catalog publication, refresh scheduling, and public-catalog persistence. The extension validates public restores by endpoint and does not persist catalogs scoped by a secret key.
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
