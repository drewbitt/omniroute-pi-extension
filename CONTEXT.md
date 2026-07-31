# OmniRoute Pi Extension

This context describes the provider-integration language used by the OmniRoute Pi extension.

## Language

**OmniRoute Provider**:
A Pi model provider backed by an OmniRoute-compatible model gateway.
_Avoid_: generic proxy, upstream provider

**Model Catalog**:
The set of OmniRoute models exposed to Pi for selection.
_Avoid_: model cache, provider list

**Provider Model Store**:
Pi's provider-scoped persisted catalog (`context.store`) used as the authoritative Model Catalog snapshot across sessions. Ownership: Pi persists; the extension validates URL match, four-hour freshness (`checkedAt`), and refresh writes.
_Avoid_: extension-owned cache writes after migration

**URL-Switch Invalidation**:
Immediate `context.store.delete()` when a non-empty Provider Model Store does not match the current configured base URL (trailing slash ignored) or has missing/malformed stored `baseUrl`. Never project foreign catalog IDs.
_Avoid_: serving another gateway's model list

**Legacy Model Catalog Cache**:
The pre-migration per-URL local OmniRoute catalog file, imported once into the Provider Model Store when empty/matching and retained only for downgrade (not deleted on URL switch).
_Avoid_: prompt cache, response cache

**Discovery Refresh**:
Pi-invoked `refreshModels` work that may fetch the current Model Catalog from OmniRoute and write the Provider Model Store when the result is valid. Ordinary path respects four-hour freshness; `force` / `pi update --models` bypasses it.
_Avoid_: session_start refresh, extension refresh queue

**Interactive Session Startup**:
Startup of a Pi session. Pi decides offline/network and force refresh; the extension only implements `refreshModels`.
_Avoid_: print startup, RPC startup

**Subagent / Headless Model Availability**:
Guarantee that the OmniRoute Provider remains resolvable for ordinary child workers that share the parent's `modelRuntime`, and for standalone headless/SDK services that restore the Provider Model Store offline. Does not require TUI hooks. Does not cover intentional `extensions: false` / isolated agents that skip extension loading.
_Avoid_: main-TUI-only provider, interactive-only registration
