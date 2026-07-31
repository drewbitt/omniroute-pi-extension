# Persist OmniRoute model catalog through Pi's provider store

OmniRoute model discovery can be slow or unavailable, but Pi now owns remote-catalog refresh, four-hour freshness, provider-scoped persistence, and cached-model error UI through `registerProvider` + `refreshModels(context)`.

We decided that the OmniRoute extension must register once with that public contract and restore catalogs from `context.store`. On first upgrade, a valid legacy schemaVersion=2 OmniRoute cache is imported into the Pi store without copying secrets; the legacy file remains for downgrade only and is no longer the write path. Interactive, list-models, headless, and offline behavior all flow through Pi's `allowNetwork` / `force` / `signal` refresh context instead of extension-owned `session_start` refresh queues or argv/TTY branching.

Because the Pi store is provider-scoped (one `omniroute` entry), not URL-scoped, a change of `OMNIROUTE_BASE_URL` must not project catalog IDs learned from another gateway. Before reuse, the extension compares each stored model's `baseUrl` (trailing slash normalized) to the current configured base URL; on mismatch or missing/malformed `baseUrl` it calls `context.store.delete()` immediately and continues as empty. Matching current-URL legacy import and online discovery may repopulate afterward.

This keeps model selection resilient while eliminating extension-owned abort noise, duplicate refresh work, and stale extension instances re-registering providers after disposal.
