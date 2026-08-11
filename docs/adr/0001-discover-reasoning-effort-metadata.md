# Use primary and supplemental model metadata for reasoning effort

The primary OmniRoute `/models?prefix=alias&configuredOnly=true` endpoint remains the source of truth for the Model Catalog. Alias prefix mode keeps the short public provider IDs shown in the UI, while `configuredOnly=true` excludes rows without an eligible configured connection. The response determines which models exist and provides the base metadata that Pi needs to register the `omniroute` provider, including primary `capabilities.effort_tiers` when present.

The OpenAI-compatible `/v1/models` shape does not fully standardize Pi thinking-level / reasoning-effort metadata. Discovery therefore unions three generic sources, without provider/family special cases:

1. primary `capabilities.effort_tiers`;
2. verified primary suffix variants from the explicit whitelist `-none`, `-low`, `-medium`, `-high`, `-xhigh`, and `-max` when the exact base ID is present in the same primary response;
3. matched supplemental metadata for models already present in the primary catalog.

Pi `off` is represented as `null` so no provider effort is sent, Pi `minimal` maps to provider effort `low`, and `max` remains distinct from `xhigh`. Provider effort `none` means no reasoning effort and maps to that Pi off/omission path; it is still parsed and folded so `*-none` can fold into an exact base and so union with real strengths remains harmless, but `none` alone is not an adjustable strength. `ultra` is not a Pi reasoning level and must never be mapped to `max`; if a gateway advertises only `ultra`, the extension does not invent `max`.

Every successful `fetchModels` result is an atomic snapshot of current OmniRoute gateway data only. The extension never carries forward or merges older per-model reasoning metadata into a fresh result. When both discovery participants succeed and the normalized Pi catalog is empty, that remains a valid fresh result (`[]`). Either participant's HTTP/JSON/shape failure or parent abort rejects before any fresh result is returned. Pi's public `createProvider` lifecycle owns persistence, publication, and restoration of the previous snapshot after failure.

Adjustable reasoning is true only when the fresh merged set contains at least one recognized adjustable strength (`low`/`medium`/`high`/`xhigh`/`max`). If primary says reasoning/thinking is true but all three fresh sources yield no such strength—including when they yield only `none`—fail closed: publish `reasoning: false` and omit `thinkingLevelMap` while keeping the model with fresh base metadata. Explicit non-reasoning is likewise `false` with no map. Never publish all-null thinking maps.

Generated `thinkingLevelMap` values are not free-form: `off` is `null`; `minimal` and `low` are `null | "low"`; `medium` is `null | "medium"`; `high` is `null | "high"`; `xhigh` is `null | "xhigh"`; and `max` is `null | "max"`. `reasoning: true` requires at least one non-null adjustable strength. The extension emits complete maps from fresh gateway data and does not parse or repair persisted maps; Pi restores only snapshots previously returned by this provider.

The currently available supplemental endpoint is the VS Code-compatible `/api/v1/vscode/_/models` route derived from the configured base URL. We use it because it can expose reasoning-effort fields; we are not depending on VS Code itself. A successful response can add recognized efforts for models that already came from the primary catalog, but it never adds/removes models or replaces primary base metadata.

**Supplemental matching priority** matches code: for each primary model, first merge efforts from normalized strict keys built from supplemental `id`, `root`, and `parent`. Only when a primary model has no strict match, apply root fallback if that root (primary `root`, else `id`) appears exactly once among supplemental metadata rows that contribute efforts. Multi-row roots never fall back.

A suffix variant is folded only when its exact suffix-stripped base is present as an eligible text model in the same primary catalog response. A response may omit that base or use the same ID for an image-output model; in either case the text suffix model remains independently routable rather than making the extension invent or misuse a base ID. Unknown future suffixes also remain untouched.

Primary `/models?prefix=alias&configuredOnly=true` and supplemental grouped VS Code metadata are both required participants in one atomic current-gateway snapshot. Both requests start concurrently and share only Pi's parent abort signal as the external cancellation/deadline source; the plugin does not impose its own elapsed-time discovery deadline. **All failure classes cancel the sibling immediately and write/publish nothing.** Distinguish failure classes:
- Network errors, non-2xx HTTP, invalid JSON, invalid catalog envelope (`data` missing or not an array), or invalid endpoint-role row shapes => sanitized fixed-category `Error` (no statusText, URL, credentials, exception message, or body leak). Any invalid row fails that participant atomically and cancels the sibling.
- Parent abort => sanitized `AbortError`.
Successful JSON `{ data: [] }` from either is valid, not failure. Implementation must avoid unhandled-rejection races when cancelling siblings. Only dual success produces a fresh union and atomic store write; there is no stale/new merge and no optional/non-fatal supplemental path.
