# OmniRoute Pi Extension

## Language

**OmniRoute Provider**: A complete Pi `Provider<"openai-completions">` backed by an OmniRoute gateway.
_Avoid_: legacy provider-config registration, custom API identifiers, Responses-only transport.

**Model Catalog**: The authenticated public `/v1/models` result normalized into complete Pi models.
_Avoid_: extension-owned cache files, management endpoints as mandatory dependencies.

**Pi Provider Lifecycle**: Pi owns credentials, generation-checked catalog publication, persistence, refresh scheduling, and last-known-good restore. The extension filters restore by normalized endpoint.
_Avoid_: direct `models.json` mutation, plaintext extension config, automatic legacy migration.

**Exact Routing ID**: Every Pi model ID is the exact OmniRoute catalog ID.
_Avoid_: `combo/` prefixing, OpenCode provider prefixes, suffix folding, synthesized IDs.

**Unknown Pricing**: Pi's required numeric costs are zero because resolved-route pricing is not available.
_Avoid_: describing zero as free.

## Structure

- `index.ts` constructs the provider and registers `/omni` status/sync commands.
- `src/gateway-catalog.ts` owns URL normalization, native auth, and authenticated catalog retrieval.
- `src/model-normalizer.ts` conservatively converts gateway rows to Pi Chat Completions models.
