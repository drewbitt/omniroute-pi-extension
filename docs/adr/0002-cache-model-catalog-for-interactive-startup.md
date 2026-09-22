# Delegate public catalog persistence to Pi

## Decision

The extension implements a complete native provider and uses Pi's `RefreshModelsContext.publish()` for all in-memory and persisted catalog updates. It does not own a cache file or mutate `models.json`.

Before network discovery, a stored snapshot is restored only for the public placeholder credential and only when every model belongs to the `omniroute` provider, uses `openai-completions`, and has the same normalized `baseUrl`. Successful public discovery persists the complete normalized snapshot. Catalogs fetched with a secret key are kept in memory but not persisted because Pi's provider store has no credential-qualified namespace.

## Rationale

Pi 0.84 provides credential-aware refresh context, cancellation, generation-checked publication, and a provider model store. Reimplementing those mechanisms would add races and secret-handling risks. Provider stores are keyed by provider ID rather than endpoint or credential, so the extension validates public snapshots and declines to persist restricted catalogs.

## Consequences

Offline startup works from a last-known-good public snapshot for the same endpoint. Secret-key catalogs require a live refresh, preventing one key from seeing a catalog cached by another key at the same endpoint. Switching endpoints or removing configuration clears stale models. Legacy `omni-prompt-tools` cleanup remains an explicit documented user action rather than an automatic host-config rewrite.

## Amendment (2026-09-22)

The persistence half of this decision was revised after the ADR was written (commit
`fix: always persist and restore endpoint-scoped catalogs`). The implemented and
tested contract is:

- Every successfully discovered catalog is persisted as a snapshot, including one
  fetched with a secret key. The snapshot holds only model metadata and the
  credential lives in `auth.json`, never in the catalog, so there is nothing
  secret to withhold. Persisting is what lets a cache-only start (subagents)
  restore models offline.
- Restore is endpoint-scoped: every stored row must match the provider, the API,
  and the normalized endpoint. A snapshot that names any other endpoint is
  deleted rather than partially restored and the in-memory catalog stays empty,
  so an endpoint change cannot surface another endpoint's models even offline.
- The credential scope (endpoint + key digest) is never persisted. It is
  in-memory only and exists to detect that the endpoint or key moved, so models
  describing the previous configuration are dropped before any network access.

The Consequences section above therefore describes the pre-revision behavior and
is superseded by this section.

### Re-evaluated against pi-ai 0.87 `createProvider`

`createProvider({ fetchModels })` was evaluated as a replacement for the
hand-rolled `refreshModels` and rejected. Its restore path filters stored models
by provider id only — no endpoint check — and it always publishes
`persist: { models, checkedAt }` after a fetch, with no way to delete a snapshot
or to clear in-memory models when the credential scope changes. It can express
neither endpoint-scoped restore nor deletion of a mismatched snapshot, and the
provider tests pin both. The hand-rolled provider remains the correct shape.

