import type { Model } from "@earendil-works/pi-ai";
import type { OmniRouteModel } from "./gateway-catalog.ts";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
// Defensive ceiling. OmniRoute's gateway occasionally advertises an absurd
// `max_output_tokens` (e.g. 1,048,600 for a model whose upstream rejects
// anything over 393,216). Pi forwards the model's `maxTokens` verbatim as the
// upstream `max_tokens` param, so a bogus value causes a non-retryable 400 on
// every request. Clamp to the largest single output a provider we route to
// accepts (DeepSeek's 393,216) so genuine large outputs (384K) pass through
// untouched while absurd multi-million values are cut back.
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

export function normalizeModels(
  providerId: string,
  baseUrl: string,
  rows: readonly OmniRouteModel[],
): readonly Model<"openai-completions">[] {
  const models: OmniRouteModel[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isConversational(row)) continue;
    if (seen.has(row.id)) {
      throw new Error(
        `OmniRoute catalog contains duplicate model ID: ${row.id}`,
      );
    }
    seen.add(row.id);
    models.push(row);
  }
  return models
    .map((model) => toModel(providerId, baseUrl, model))
    .sort((left, right) => left.id.localeCompare(right.id));
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
  const map = reasoning ? thinkingLevelMap(efforts) : undefined;
  const contextWindow =
    positive(model.context_length) ??
    positive(model.max_input_tokens) ??
    DEFAULT_CONTEXT_WINDOW;
  const maxTokens =
    positive(model.max_output_tokens) ??
    positive(model.max_tokens) ??
    DEFAULT_MAX_TOKENS;
  const vision =
    model.input_modalities?.includes("image") ||
    model.capabilities?.vision === true ||
    model.capabilities?.attachment === true;
  const displayName = model.name?.trim();

  return {
    id: model.id,
    name: displayName || model.id,
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
    !model.output_modalities?.length || model.output_modalities.includes("text")
  );
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
