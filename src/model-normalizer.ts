import type { Model } from "@earendil-works/pi-ai";
import type { OmniRouteModel } from "./gateway-catalog.ts";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const NON_CHAT_TYPES = new Set(["embedding", "image", "video", "audio"]);
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
  const models = new Map<string, OmniRouteModel>();
  for (const row of rows) {
    if (!isConversational(row)) continue;
    const current = models.get(row.id);
    models.set(row.id, current ? betterModel(current, row) : row);
  }
  return [...models.values()]
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
    name:
      displayName && displayName !== model.id
        ? displayName
        : model.root?.trim() || model.id,
    api: "openai-completions",
    provider: providerId,
    baseUrl,
    reasoning,
    ...(map ? { thinkingLevelMap: map } : {}),
    input: vision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: Math.min(maxTokens, contextWindow),
  };
}

function parseEfforts(value: unknown): Effort[] {
  if (!Array.isArray(value)) return [];
  const efforts: Effort[] = [];
  for (const item of value) {
    const raw =
      typeof item === "string"
        ? item
        : isRecord(item) && typeof item.effort === "string"
          ? item.effort
          : undefined;
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
    off: available.has("none") ? "none" : null,
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

function betterModel(
  left: OmniRouteModel,
  right: OmniRouteModel,
): OmniRouteModel {
  const leftVision = Boolean(
    left.input_modalities?.includes("image") ||
      left.capabilities?.vision ||
      left.capabilities?.attachment,
  );
  const rightVision = Boolean(
    right.input_modalities?.includes("image") ||
      right.capabilities?.vision ||
      right.capabilities?.attachment,
  );
  if (leftVision !== rightVision) return rightVision ? right : left;
  const leftContext =
    positive(left.context_length) ?? positive(left.max_input_tokens) ?? 0;
  const rightContext =
    positive(right.context_length) ?? positive(right.max_input_tokens) ?? 0;
  if (leftContext !== rightContext)
    return rightContext > leftContext ? right : left;
  const leftOutput =
    positive(left.max_output_tokens) ?? positive(left.max_tokens) ?? 0;
  const rightOutput =
    positive(right.max_output_tokens) ?? positive(right.max_tokens) ?? 0;
  return rightOutput > leftOutput ? right : left;
}

function positive(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
