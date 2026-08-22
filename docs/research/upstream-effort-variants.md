# OmniRoute /v1/models effort-suffixed variants — scout brief

Repo: `/tmp/omniroute-upstream` @ HEAD `6cd4d38e2` (bare clone; all reads via `git show HEAD:<path>`). READ-ONLY — nothing modified.

## Why the catalog exposes effort-suffixed variants (rationale)

Catalog-only clients (OpenCode, plain OpenAI-SDK pickers, Claude Code gateway discovery) can only choose a model by its `id` — they have no UI to send `reasoning_effort`. The gateway already *accepted* suffixed ids at request time; the catalog appenders just enumerate them so the tiers become selectable. Three independent families:

1. **Claude effort variants** — `open-sse/utils/claudeEffortVariants.ts` (whole file). Synthesizes `claude/<model>-{low,medium,high[,xhigh]}` for every thinking-capable Claude-family base (`isKnownClaudeEffortBaseModel` = `getModelSpec(bare).supportsThinking === true && /claude/i`). Levels from `supportsXHighEffort` single source of truth; `none` omitted (= base id); `max`/`ultra` are codex-only. Skips combos (`owned_by === "combo"`), `no-think/` ids, and ids already ending in `-(xhigh|high|medium|low)` (case-insensitive). Variant `name` gets a `" (XHigh)"`-style label.
2. **Synced-model effort variants (#7694)** — `open-sse/utils/syncedEffortVariants.ts` (whole file). For API-synced models whose discovery captured upstream `reasoning.supported_efforts` into `SyncedAvailableModel.supportedThinkingEfforts` (surfaced as `capabilities.effort_tiers`, see `src/app/api/v1/models/syncedCapabilities.ts:23-45`), synthesizes `<provider>/<model>-<tier>` per declared tier. Skips: `owned_by === "combo"`; providers in `SYNCED_EFFORT_SKIP_PROVIDERS = {"codex"}` or with prefix `kimi` (both own a conflicting native `-{effort}` mechanism — `splitCodexReasoningSuffix` / `getKimiCodeStaticThinkingPolicy`); and any base id already ending in a canonical effort token (`endsWithKnownEffortToken` over `CANONICAL_EFFORT_VALUES = ["none","low","medium","high","xhigh"]`, `src/shared/reasoning/effortStandardization.ts:18`). Does **not** modify `name`.
3. **no-think/ gateway variants** (sibling convention, not effort) — `open-sse/utils/noThinkingAlias.ts`: `no-think/<provider>/<model>` forces reasoning off via model selection (Claude Code attaches thinking blocks with no off switch). Gated to Claude models that support thinking AND honor `disabled`; `ModelSpec.noThinkingAlias` override; never combined with effort suffixes. `#6879` made it set `reasoning_effort:"none"` on the OpenAI path.

Issue refs: **#7694** (sync upstream `supported_efforts` + suffix resolution, CHANGELOG.md:1074), **#9006** (Claude suffix strip works on *any* provider serving a real Claude model, not just direct Anthropic lane; also fixed no-think provider-qualification, CHANGELOG.md:230-241), **#9418** (opt-in `hideAutoCombos` / `hideNoThinkVariants` catalog filters, CHANGELOG.md:71), **#8983** (opencode-plugin: stop warning when an auto combo replaces its expected /v1/models twin — PR #9042, CHANGELOG.md:605).

## Request-time suffix-resolution semantics

- **Synced variants** — `splitSyncedEffortSuffix(modelId, knownEfforts)` (`open-sse/services/model.ts:532-547`): pure string split; caller must supply the *candidate base's own* `supportedThinkingEfforts`, so a tier is only stripped when it is an exact declared tier of that base — never blind. Wired in `src/sse/services/model.ts`:
  - `resolveSyncedModelIdAndEffort` (lines 155-190): only when the raw id has **no direct synced match**; skips providers whose id starts with `codex` or `kimi` (`SYNCED_EFFORT_SKIP_PROVIDER_PREFIXES`, lines 121-127).
  - `resolveRegistryModelIdAndEffort` (lines 130-152): static registry fallback; also short-circuited when the raw id is a direct custom/synced model (`#9485 review` — a literal `deepseek-v4-flash-low` is never rewritten).
  - `lookupModelMeta` (lines 300-368): resolved effort → `metadata.resolvedThinkingEffort`; availability check also accepts `getRegisteredProviderEffortBaseModelId` (`open-sse/utils/registeredEffortVariants.ts` — requires BOTH the variant and the base to exist in the provider registry, suffixes `none|low|medium|high|max|xhigh`).
  - The resolved effort becomes `reasoning_effort` only at the OpenAI-format dispatch chokepoint (`open-sse/handlers/chatCore.ts:2651-2660` → `applyDefaultReasoningEffort`, `open-sse/services/defaultReasoningEffort.ts`), only when the request carries **no** reasoning field of any shape; priority: suffix effort > static `ModelSpec.defaultReasoningEffort` > vendor `defaultThinkingEffort`.
  - Registered-tier providers (command-code, crofai, opencode-go Muse Spark, DeepSeek V4 — changelog fragments `command-code-reasoning-efforts.md`, `crofai-reasoning-efforts.md`, `opencode-go-muse-spark-efforts.md`) resolve through the same registry path; `getRegisteredProviderEffortBaseModelId` also feeds provider inference reconciliation (`open-sse/services/model.ts:358`).
- **Claude variants** — `applyClaudeEffortVariant` (`open-sse/handlers/chatCore/claudeEffortVariant.ts:33-62`) + `splitClaudeEffortSuffix` (`open-sse/config/providerModels.ts:259-275`, tokens `xhigh|max|high|medium|low`, longest-first). Strips when provider is `claude`/claude-code-compatible **or** the base is a known Claude effort base (#9006). Explicit client effort wins; native Claude passthrough (`sourceFormat === claude`) untouched.
- **Codex** — own `splitCodexReasoningSuffix` (`open-sse/executors/codex/reasoningSuffix.ts`): `none|low|medium|high|xhigh` + gpt-5.6 `-max`/`-ultra`/`(...)` aliases. Excluded from the generic mechanism.
- **Kimi-coding** — `getKimiCodeStaticThinkingPolicy` (`open-sse/config/providers/registry/kimi/coding/runtime.ts:26-34`): k3 tiers `low|high|max`, default `max`, threaded as execution metadata (`executionCredentials.ts:70`). Excluded from the generic mechanism (kimi prefix skip).

**Advertise-only vs honored:** every advertised family is also honored at request time (claude/synced/registry/codex/kimi each have a resolver). The inverse is NOT true — codex/kimi suffixes are routable but never enumerated by the generic catalog appenders (skip lists).

## Row-level markers distinguishing variants

There is **no boolean/`parent` marker** on effort-variant rows. `appendSyncedEffortVariants` and `appendClaudeEffortVariants` spread the base entry and override only `id` and `root` — and `root` is `<baseRoot>-<tier>` (the *unprefixed tier id* used by provider-scoped routes), **not** a back-pointer to the base id. `parent` is inherited from the base (`null`, or the alias id in canonical prefix mode — see catalog.ts:1145-1192 where base synced rows get `root: sm.id, parent: null|aliasId`). Observable signals per family:

| family | id shape | name/display marker | root |
| --- | --- | --- | --- |
| Claude effort | `claude/<m>-{low,medium,high,xhigh}` | `name` + `" (XHigh)"` etc. | `<bare>-<level>` |
| Synced effort | `<provider>/<m>-<tier>` | **none** | `<baseRoot>-<tier>` |
| no-think | `no-think/<provider>/<m>` | `name` + `" (no thinking)"` | `no-think/<bare>` |
| CC discovery alias | `claude/<original-id>`, `claude/combo/<name>` | `display_name` + `" (OmniRoute)"` | bare model name / full combo name (back-pointer) |
| Gateway mirror | `<gateway-alias>/<original-id>` | `display_name` + `" (via <provider>)"`, `owned_by` = gateway | full original id (true back-pointer); internal Symbol marker (not JSON-serializable) |

## Other duplicate id sources & gating

- **`auto/*` combos**: advertised at catalog top (catalog.ts:779-838); hidden only by opt-in `settings.hideAutoCombos` **or** `autoRoutingEnabled === false` (#9418, default off — `src/lib/db/settings.ts:248`). `owned_by:"combo"`, `root = id`, `parent: null`. Still routable when hidden.
- **no-think variants**: hidden by opt-in `settings.hideNoThinkVariants` (#9418, default off, settings.ts:251).
- **CC discovery aliases**: 3-level gate (env `EXPOSE_CC_DISCOVERY_ALIASES` > DB override > **default OFF**; global > provider > model — `src/lib/db/ccDiscoveryAliases.ts:150-162`). Skips claude/anthropic-prefixed ids, no-think ids, effort-suffixed ids, and built-in `auto*` combos.
- **Functional gateway mirrors**: 3-level gate, env > DB > **default OFF** (`src/lib/db/functionalGatewayMirrors.ts:105-123`). Only emitted when the canonical owner has no eligible connection AND a passthrough gateway with a credential covers the model.
- **canonical/alias twins + oc/opencode**: under `MODELS_CATALOG_PREFIX_MODE` the same synced model can be listed as `aliasId` and `<canonicalProvider>/<id>` (parent-linked); `opencode` alias maps to `opencode-zen` for user prefixes while `oc` resolves to the no-auth `opencode` provider (alias-chain stop rule, `open-sse/services/model.ts:185-207`), and `opencode-go` is a separate paid tier. `dedupeExactCatalogIds` (catalogResponse.ts, #4424 follow-up) drops exact-duplicate ids as the final guard.

## Verdict: is client-side collapsing safe?

**Mostly yes, with one narrow edge.** The variants exist purely so catalog-only clients can pick a tier; the base row remains fully routable and rich clients can always send `reasoning_effort` on the base. Hiding `<base>-<tier>` rows loses no capability that the base + an explicit effort can't reach. But a client must match exactly:

**Required matching rule** — collapse row `R` only when ALL hold:

1. `R.id` ends with `-${tier}` where `tier` ∈ `base.capabilities.effort_tiers` (string-exact, case-sensitive), and the remainder after removing `-${tier}` **exactly equals** an existing row id (`base.id`).
2. `base.owned_by` is not `combo`, does not equal/start with `codex` or `kimi` (their suffixed ids are native models/aliases, not generic variants), and `base.id` itself does not end in `-none|-low|-medium|-high|-xhigh` (those bases never get variants).
3. For the Claude family, tier ∈ {low, medium, high, xhigh} only — `max`/`ultra` suffixed ids are codex-native, and `none` never appears as a variant.

**Edge case (residual risk):** a *distinct real* model can be literally named `<base>-<tier>`. The generator's `existingIds` guard then skips the variant and the row is the real model — indistinguishable from a variant by any field (root collides too, since a real model's `root` is its own bare id). Request time also favors the real model (direct match short-circuits suffix stripping, `#9485`). Collapsing it hides a genuinely routable model whose semantics differ from `base + effort`. Probability is low (requires a provider to ship an id ending in a canonical effort token whose prefix is also a model), but a cautious client should keep such rows, or only collapse when the tier split is unambiguous *and* the row carries a variant name label (`(XHigh)` / `(no thinking)` — synced variants unfortunately carry none).

**Also safe to know:** hidden ≠ unroutable for `auto/*` and `no-think/*` (#9418: "the ids are still routable when sent explicitly, just not advertised"), and CC-alias/gateway-mirror rows are the *only* visible route for some models in discovery-restricted clients — never collapse those by id-shape heuristics.

## Start Here

`src/app/api/v1/models/catalogResponse.ts` — the post-filter chain shows every append/dedupe step in order; each appender file is self-documenting.
