# Delegate public catalog persistence to Pi

## Decision

The extension implements a complete native provider and uses Pi's `RefreshModelsContext.publish()` for all in-memory and persisted catalog updates. It does not own a cache file or mutate `models.json`.

Before network discovery, a stored snapshot is restored only for the public placeholder credential and only when every model belongs to the `omniroute` provider, uses `openai-completions`, and has the same normalized `baseUrl`. Successful public discovery persists the complete normalized snapshot. Catalogs fetched with a secret key are kept in memory but not persisted because Pi's provider store has no credential-qualified namespace.

## Rationale

Pi 0.84 provides credential-aware refresh context, cancellation, generation-checked publication, and a provider model store. Reimplementing those mechanisms would add races and secret-handling risks. Provider stores are keyed by provider ID rather than endpoint or credential, so the extension validates public snapshots and declines to persist restricted catalogs.

## Consequences

Offline startup works from a last-known-good public snapshot for the same endpoint. Secret-key catalogs require a live refresh, preventing one key from seeing a catalog cached by another key at the same endpoint. Switching endpoints or removing configuration clears stale models. Legacy `omni-prompt-tools` cleanup remains an explicit documented user action rather than an automatic host-config rewrite.
