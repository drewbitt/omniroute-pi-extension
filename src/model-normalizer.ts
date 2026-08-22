import type { Model } from "@earendil-works/pi-ai";
import type { OmniRouteModel } from "./gateway-catalog.ts";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
// Sanity ceiling for a model's output budget. The gateway's `max_output_tokens`
// is occasionally impossible — e.g. command-code deepseek-v4-pro is advertised
// as 1,048,600 against a 1,000,000 context window (a stale synced `limit_output`;
// upstream issue class #6524: `limit_output` ≈ `limit_context`). Pi surfaces
// `maxTokens` as the model's output ceiling (displayed in list-models, used as a
// thinking-budget cap, and forwarded as `max_tokens` in some paths), so an
// inflated value breaks the model upstream. 393,216 (384K) is the largest output
// any provider we route to accepts, so it is a valid global bound: genuine large
// outputs pass through untouched while impossible multi-million values are cut.
const MAX_OUTPUT_TOKENS_CEILING = 393_216;
const NON_CHAT_TYPES = new Set([
  "embedding",
  "image",
  "video",
  "audio",
  "rerank",
  "moderation",
  "music",
]);
const EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

type Effort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Fallback effort map for reasoning models that advertise NO effort tiers:
 * without a map, pi treats every level as supported and forwards the raw
 * level string. Live-measured against v3.8.50: low/medium/high/xhigh are the
 * canonical vocabulary and accepted everywhere (mappers down-shift xhigh for
 * models that lack it), while `max` 400s on every route without a native max
 * tier and `minimal` is not part of the canonical set — both are marked
 * unsupported so pi clamps to the nearest supported level instead.
 */
const DEFAULT_EFFORT_MAP = {
  off: null,
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: null,
} as const;

/**
 * Effort-suffixed catalog rows (`<model>-low`, `-xhigh`, …) are gateway-
 * synthesized aliases: at request time the suffix is stripped back to the
 * base model and re-emerges as reasoning_effort, which pi already expresses
 * through thinking levels. When the base row exists AND advertises that tier
 * the variant is pure duplication — measured 980 of 3922 live rows — and is
 * dropped. Orphan variants (base absent) and tiers the base does not
 * advertise are kept: they may be the only way to reach that effort.
 */
const EFFORT_SUFFIX = /^(.*?)-(none|minimal|low|medium|high|xhigh|max)$/;

function dropRedundantEffortVariants(
  rows: readonly OmniRouteModel[],
): readonly OmniRouteModel[] {
  const byId = new Map<string, OmniRouteModel>();
  for (const row of rows) if (!byId.has(row.id)) byId.set(row.id, row);
  return rows.filter((row) => {
    const match = EFFORT_SUFFIX.exec(row.id);
    if (!match) return true;
    const base = byId.get(match[1]);
    if (!base) return true;
    return !parseEfforts(base.capabilities?.effort_tiers).includes(
      match[2] as Effort,
    );
  });
}

export function normalizeModels(
  providerId: string,
  baseUrl: string,
  rows: readonly OmniRouteModel[],
): readonly Model<"openai-completions">[] {
  const models: OmniRouteModel[] = [];
  const seen = new Set<string>();
  for (const row of dropRedundantEffortVariants(rows)) {
    if (!isConversational(row)) continue;
    // First-wins on duplicate ids: one misconfigured gateway alias must not
    // brick discovery for the entire catalog.
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    models.push(row);
  }
  return models
    .map((model) => toModel(providerId, baseUrl, model))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function buildDisplayName(model: OmniRouteModel): string {
  const id = model.id;
  const idPrefix = id.split("/")[0] ?? "";
  const idRest = id.startsWith(`${idPrefix}/`)
    ? id.slice(idPrefix.length + 1)
    : id;
  const vendor = model.owned_by?.trim() || idPrefix;

  let base = model.name?.trim() ?? "";
  if (!base || base === id || base === idRest) base = "";

  if (base) {
    // Drop a redundant "<prefix>/" that repeats the catalog prefix or the
    // owned_by vendor, e.g. "crof/DeepSeek V4 Pro" -> "DeepSeek V4 Pro".
    for (const prefix of [idPrefix, vendor]) {
      if (prefix && base.startsWith(`${prefix}/`)) {
        base = base.slice(prefix.length + 1);
        break;
      }
    }
    // Drop a "Vendor: " prefix, e.g. "DeepSeek: DeepSeek V4 Pro 0813".
    base = base.replace(/^[A-Za-z0-9_.@-]+:\s*/, "");
    // Drop leading lowercase namespace path segments, e.g.
    // "anthropic/claude-4-sonnet" -> "claude-4-sonnet".
    for (let i = 0; i < 2; i++) {
      const match = base.match(/^([a-z0-9_.@-]+)\/(.+)$/);
      if (!match) break;
      base = match[2];
    }
  }

  if (!base.trim()) base = idRest;
  return vendor ? `${vendor} · ${base}` : base;
}

function toModel(
  providerId: string,
  baseUrl: string,
  model: OmniRouteModel,
): Model<"openai-completions"> {
  const efforts = parseEfforts(model.capabilities?.effort_tiers);
  const reasoning =
    model.capabilities?.reasoning === true ||
    model.capabilities?.thinking === true ||
    efforts.some((effort) => effort !== "none");
  const map = reasoning
    ? (thinkingLevelMap(efforts) ?? DEFAULT_EFFORT_MAP)
    : undefined;
  const contextWindow =
    positive(model.context_length) ??
    positive(model.max_input_tokens) ??
    DEFAULT_CONTEXT_WINDOW;
  const maxTokens =
    positive(model.max_output_tokens) ??
    positive(model.max_tokens) ??
    DEFAULT_MAX_TOKENS;
  const vision =
    modalitiesInclude(model.input_modalities, "image") ||
    model.capabilities?.vision === true ||
    model.capabilities?.attachment === true;
  const displayName = buildDisplayName(model);

  return {
    id: model.id,
    name: displayName,
    api: "openai-completions",
    provider: providerId,
    baseUrl,
    reasoning,
    ...(map ? { thinkingLevelMap: map } : {}),
    input: vision ? ["text", "image"] : ["text"],
    cost: {
      input: price(model.pricing?.input),
      output: price(model.pricing?.output),
      cacheRead: price(model.pricing?.cached),
      cacheWrite: price(model.pricing?.cache_creation),
    },
    contextWindow,
    maxTokens: Math.min(maxTokens, contextWindow, MAX_OUTPUT_TOKENS_CEILING),
  };
}

function parseEfforts(value: unknown): Effort[] {
  if (!Array.isArray(value)) return [];
  const efforts: Effort[] = [];
  for (const item of value) {
    let raw: string | undefined;
    if (typeof item === "string") raw = item;
    else if (isRecord(item) && typeof item.effort === "string")
      raw = item.effort;
    const effort = raw?.trim().toLowerCase();
    if (effort && EFFORTS.has(effort) && !efforts.includes(effort as Effort))
      efforts.push(effort as Effort);
  }
  return efforts;
}

function thinkingLevelMap(efforts: readonly Effort[]) {
  const available = new Set(efforts);
  if (available.size === 0) return undefined;
  return {
    // "off" must OMIT reasoning_effort entirely (null), never send "none".
    // Measured against a live v3.8.50 gateway: some providers advertise
    // `none` in capabilities.effort_tiers yet reject it upstream
    // (`reasoning.effort does not support none`), and some provider schemas
    // reject it outright (`expected one of low|medium|high|xhigh|max`). Since
    // pi sends map.off on every no-effort request (title generation, quick
    // tasks), any non-null value re-creates those 400s. Omission is what the
    // gateways before #6241/#10957 expected and still works everywhere; the
    // cost is that #10957's vendor-default-effort injection can fire on such
    // requests — acceptable, because an injected default is the vendor's own
    // recommended effort for the model.
    off: null,
    minimal: available.has("minimal") ? "minimal" : null,
    low: available.has("low") ? "low" : null,
    medium: available.has("medium") ? "medium" : null,
    high: available.has("high") ? "high" : null,
    xhigh: available.has("xhigh") ? "xhigh" : null,
    max: available.has("max") ? "max" : null,
  } as const;
}

function isConversational(model: OmniRouteModel): boolean {
  const type = model.type?.trim().toLowerCase();
  if (type && NON_CHAT_TYPES.has(type)) return false;
  return (
    !model.output_modalities?.length ||
    modalitiesInclude(model.output_modalities, "text")
  );
}

/** Case-insensitive modality check: gateways have shipped "IMAGE"/"Text". */
function modalitiesInclude(
  values: readonly string[] | undefined,
  target: string,
): boolean {
  return (values ?? []).some((value) => value?.trim().toLowerCase() === target);
}

function price(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function positive(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
