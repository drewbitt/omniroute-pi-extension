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

- Thinking "off" always OMITS `reasoning_effort` (`thinkingLevelMap.off = null`). Although #6241 made `none` canonical and #10957 injects a vendor-default effort when no reasoning field is present, live measurement shows some providers reject explicit `none` despite advertising it as an effort tier, and some provider schemas reject it outright. Since pi sends map.off on every no-effort request (title generation, quick tasks), any non-null value re-creates those 400s; the injection risk from omission is acceptable (a vendor default is that model's recommended effort).
- `/v1/models?prefix=alias&configuredOnly=true` semantics are unchanged; new row fields (`release_date`, `family`, `api_format`, `pricing.reasoning`, …) are additive and safely ignored.
- Effort-suffixed rows (`<model>-low`, `-xhigh`, …) are gateway-synthesized aliases for catalog-only clients; no request-level control suppresses them (only `prefix` and `configuredOnly` exist). The normalizer drops a variant only when its base row exists AND advertises that tier — pi selects effort via thinking levels, so the variant is pure duplication. Orphans and non-advertised tiers are kept. See `docs/research/upstream-effort-variants.md`.
- Resilience contract: malformed catalog rows are dropped (not fatal), duplicate ids resolve first-wins (not fatal), and an empty catalog is legitimate. Fetches carry hard timeouts (30s catalog / 15s pricing) so an ambient signal cannot hang a refresh.
- Effort vocabulary is route-dependent and the catalog's tier lists are the contract to trust where present: command-code routes translate every advertised tier down to native vocabularies (e.g. Kimi K3 native accepts only low|high|max, but cmd routes accept medium/xhigh too). On at least one route family the synthesized suffix-variant ids (`<model>-xhigh`) 400 while base + reasoning_effort works — another reason the dedupe drops them.
- Reasoning models that advertise NO effort tiers get a conservative default map: low/medium/high/xhigh pass through (canonical; xhigh is down-shifted per provider), while `max` and `minimal` are marked unsupported because raw values 400 on non-native routes. Provider-native exceptions (DeepSeek V4, Codex GPT-5.6, Kimi K3) surface only through their advertised tiers.
