# Persist OmniRoute model catalog through Pi's provider store

OmniRoute model discovery can be slow or unavailable, but Pi now owns remote-catalog refresh, four-hour freshness, provider-scoped persistence, and cached-model error UI through `registerProvider` + `refreshModels(context)`.

We decided that the OmniRoute extension must register once with that public contract and restore catalogs from `context.store`. On first upgrade, a valid legacy schemaVersion=2 OmniRoute cache is imported into the Pi store without copying secrets; the legacy file remains for downgrade only and is no longer the write path. Interactive, list-models, headless, and offline behavior all flow through Pi's `allowNetwork` / `force` / `signal` refresh context instead of extension-owned `session_start` refresh queues or argv/TTY branching.

This keeps model selection resilient while eliminating extension-owned abort noise, duplicate refresh work, and stale extension instances re-registering providers after disposal.
