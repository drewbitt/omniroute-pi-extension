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

**Catalog Pricing**: `/v1/models` per-million-token prices map to Pi cost fields, enriched from the management `GET /api/pricing` table (exact provider id, then prefix→namespace aliases for metered resellers like `opencode`→`opencode-go`, then unambiguous basename). Flat-rate / subscription / web-session providers (Command Code, `*-web`, coding plans) are left at zero to match OmniRoute's flat-rate treatment. The management call is best-effort and never blocks discovery. Missing or ambiguous prices remain zero because Pi requires numbers.
_Avoid_: treating missing zeroes as proof that a model or combo is free, or depending on the management endpoint for catalog discovery.

## Structure

- `index.ts` constructs the provider and registers `/omni` status/sync commands.
- `src/gateway-catalog.ts` owns URL normalization, native auth, and authenticated catalog retrieval.
- `src/model-normalizer.ts` conservatively converts gateway rows to Pi Chat Completions models.
