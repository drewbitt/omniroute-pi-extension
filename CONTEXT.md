# OmniRoute Pi Extension

## Language

**OmniRoute Provider**: A complete public Pi `Provider<"openai-responses">` backed by an OmniRoute-compatible gateway.
_Avoid_: legacy provider config registration, generic proxy

**Model Catalog**: The fresh set of full Pi `Model` values returned by the gateway adapter.
_Avoid_: extension cache, custom store projection

**Pi Provider Lifecycle**: `createProvider` and Pi `Models` own persisted-store restore/write, credential resolution, in-flight refresh de-duplication, refresh policy, offline initialization, and fallback after a failed online refresh.
_Avoid_: extension-owned freshness, migration, URL isolation, fallback

**Atomic Discovery**: Concurrent required primary alias and grouped VS Code supplemental catalog requests. Both must succeed before one fresh catalog can publish.
_Avoid_: optional supplemental metadata, partial snapshot

**Reasoning Effort Union**: Primary tiers plus verified exact-base suffixes plus strict supplemental identity; unique-root fallback only after strict matching misses. `ultra` is ignored; none-only fails closed.
_Avoid_: provider/root/DeepSeek heuristics, inferred tiers

**Subagent / Headless Availability**: Standard Pi provider resolution for ordinary shared-modelRuntime workers and standalone services restoring Pi's provider store.
_Avoid_: TUI/session-hook-only provider

## Structure

- `index.ts` visibly reads validated configuration, constructs the complete public provider, fetches a catalog snapshot, normalizes models, and registers it.
- `src/gateway-catalog.ts` owns gateway configuration and atomic catalog retrieval; `src/model-normalizer.ts` maps the resulting `CatalogSnapshot` to full Pi models.
