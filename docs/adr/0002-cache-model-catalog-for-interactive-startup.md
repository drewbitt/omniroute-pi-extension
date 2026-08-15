# Delegate catalog persistence to Pi with endpoint isolation

## Decision

The extension implements a complete native provider and uses Pi's `RefreshModelsContext.publish()` for all in-memory and persisted catalog updates. It does not own a cache file or mutate `models.json`.

Before network discovery, a stored snapshot is restored only when every accepted model belongs to the `omniroute` provider, uses `openai-completions`, and has the same normalized `baseUrl` as the effective credential. A changed endpoint restores no old models. Successful discovery persists the complete normalized snapshot; failure leaves a matching restored snapshot active.

## Rationale

Pi 0.84.2 provides credential-scoped refresh context, cancellation, generation-checked publication, and a provider model store. Reimplementing those mechanisms would add races and secret-handling risks. Provider stores are keyed by provider ID rather than endpoint, so the extension must perform the small gateway-specific endpoint check.

## Consequences

Offline startup works from a last-known-good snapshot for the same endpoint. Switching endpoints while offline intentionally produces an empty catalog until the new endpoint is reached. Legacy `omni-prompt-tools` cleanup remains an explicit documented user action rather than an automatic host-config rewrite.
