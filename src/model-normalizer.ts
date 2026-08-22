import type { Model } from "@earendil-works/pi-ai";
import type { OmniRouteModel } from "./gateway-catalog.ts";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
// The gateway sometimes advertises an impossible output budget (a stale sync
// can set max_output_tokens above the context window, upstream #6524). Pi
// forwards this value as the model's output cap, which 400s upstream. 384K is
// the largest output any routed provider accepts; larger values are clamped.

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

// For reasoning models that advertise no effort tiers: low through xhigh are
// accepted everywhere (xhigh gets down-shifted per provider), while raw `max`
// and `minimal` are not canonical and 400 on some routes. Marking them null
// makes pi clamp to a supported level instead of sending them.
const DEFAULT_EFFORT_MAP = {
  off: null,
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: null,
} as const;

// Effort-suffixed rows (`<model>-low`, `-xhigh`, ...) are aliases the gateway
// synthesizes for clients that cannot send reasoning_effort. pi picks effort
// via thinking levels, so when the base row exists and advertises the tier,
// the variant adds nothing and is dropped. Variants without a base row, or
// for tiers the base does not advertise, are kept.
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

// Rows whose id repeats their declared parent's basename under a different
// namespace are provider mirrors (`command-code/claude-opus-4-6` ->
// `cmd/claude-opus-4-6`). When the parent row survives, the mirror only adds
// a duplicate picker entry and is dropped.

function isExactProviderMirror(
  id: string,
  parent: string | null | undefined,
  eligible: ReadonlySet<string>,
): boolean {
  if (!parent || !eligible.has(parent)) return false;
  const separator = id.indexOf("/");
  const parentSeparator = parent.indexOf("/");
  if (separator <= 0 || parentSeparator <= 0) return false;
  if (id.slice(0, separator) === parent.slice(0, parentSeparator)) return false;
  return id.slice(separator + 1) === parent.slice(parentSeparator + 1);
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
    // First id wins; a duplicate must not fail the whole refresh.
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    models.push(row);
  }
  const eligible = new Set(models.map((model) => model.id));
  return models
    .filter((model) => !isExactProviderMirror(model.id, model.parent, eligible))
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
    // Never send "none": some providers reject it even when they advertise it,
    // and pi sends map.off on every no-effort request (title generation etc.).
    // Omitting the field entirely works everywhere. See CONTEXT.md.
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
