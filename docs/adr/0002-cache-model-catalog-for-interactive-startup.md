# Delegate OmniRoute dynamic-catalog lifecycle to Pi

## Decision

The OmniRoute extension registers a complete provider through Pi's public `createProvider` and `pi.registerProvider(provider)` APIs. Pi owns dynamic catalog store restoration and writes, refresh scheduling, effective credential resolution, in-flight refresh de-duplication, offline/cache-only behavior, and fallback after a failed online refresh.

The extension contains only gateway-specific discovery and normalization. Its `fetchModels(context)` performs the mandatory concurrent primary and supplemental requests and returns a complete fresh `Model<"openai-responses">[]` only on dual success.

## Consequences

Remove extension-owned cache paths, file I/O, hash/path logic, four-hour freshness, `force` handling, legacy cache migration, base-URL store isolation, custom store parsing/sanitization, and custom offline/fallback lifecycle.

A Pi provider store is provider-scoped. Changing `OMNIROUTE_BASE_URL` does not cause the extension to delete or reinterpret the store; Pi's public lifecycle is the accepted behavior. Gateway request and model-normalization contracts remain unchanged and are documented in [`../features.md`](../features.md).
