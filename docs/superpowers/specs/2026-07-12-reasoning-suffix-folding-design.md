# Reasoning suffix folding design

## Goal

Keep OmniRoute's standard `/models?prefix=alias` response as the sole authority for model IDs and model metadata. Use `/api/v1/vscode/_/models` as supplemental reasoning-effort metadata only. Fold known reasoning variants into a verified real base model without inventing model IDs or conflating distinct effort levels.

## Effort model

The API suffix whitelist is `none`, `low`, `medium`, `high`, `xhigh`, and `max`. Pi exposes `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Represent Pi `off` as `null` so the wire effort is omitted, map Pi `minimal` to provider `low`, and preserve `max` as its own level above `xhigh`.

`ultra` and all other unknown suffixes are not interpreted. They remain ordinary model IDs.

## Verified folding

Primary discovery requests `/models?prefix=alias` so OmniRoute returns the short provider IDs used by the UI instead of the full canonical provider IDs. The catalog is dynamic and alias mode may return a reasoning suffix entry without an exact unsuffixed base.

A suffixed primary model folds only when its exact suffix-stripped base is present as an eligible text model in the same primary response. A same-ID image-output entry does not qualify as the base. Otherwise the suffix model remains independently routable, even if other metadata describes reasoning efforts. This preserves `/models` as the authority for routable IDs and prevents the extension from synthesizing or misusing a bare ID.

The selected base entry remains authoritative for display name, context limits, modalities, and other model metadata. Variant entries contribute only their reasoning effort.

## Supplemental metadata (mandatory atomic participant)

The VS Code endpoint is a **mandatory participant** of the same atomic current-gateway snapshot as primary discovery. Both endpoints start concurrently and cancel only via Pi's parent abort signal or sibling failure; the plugin does not impose its own elapsed-time discovery deadline.

**Matching order (exact as code):** for each primary model, first merge efforts from normalized strict keys built from supplemental `id`, `root`, and `parent`. Only when that primary model has no strict match, apply root fallback if that root (primary `root`, else `id`) appears exactly once among supplemental metadata rows that contribute efforts. Multi-row roots never fall back.

Supplemental metadata may only add recognized efforts for models already present in the primary catalog. It never creates a provider model, replaces a primary ID, or supplies primary model metadata. Primary remains the sole model authority.

**Success/failure semantics for both endpoints:**

- Dual success (including valid empty `{ data: [] }` from either) produces one fresh union and one atomic store write.
- Any network error, non-2xx, invalid JSON, invalid catalog/row shape, or parent abort fails that participant, cancels the sibling immediately, and writes/publishes nothing.
- There is no optional/non-fatal supplemental path and no stale/new merge.

## Tests

Regression coverage verifies independent `xhigh` and `max`, `none` to `off`, exact-base folding within the alias catalog, retention of suffix models with no real base, retention of unknown future suffixes, dual-participant atomic success/failure, and the supplemental endpoint's metadata-only role.
