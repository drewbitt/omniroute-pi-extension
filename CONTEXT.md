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
Pi's provider-scoped persisted catalog (`context.store`) used as the authoritative Model Catalog snapshot across sessions.
_Avoid_: extension-owned cache writes after migration

**Legacy Model Catalog Cache**:
The pre-migration local OmniRoute catalog file, imported once into the Provider Model Store and retained only for downgrade.
_Avoid_: prompt cache, response cache

**Discovery Refresh**:
Pi-invoked `refreshModels` work that may fetch the current Model Catalog from OmniRoute and write the Provider Model Store when the result is valid.
_Avoid_: session_start refresh, extension refresh queue

**Interactive Session Startup**:
Startup of a Pi session. Pi decides offline/network and force refresh; the extension only implements `refreshModels`.
_Avoid_: print startup, RPC startup
