import type { Model } from "@earendil-works/pi-ai/compat";
import type { CatalogSnapshot, OmniRouteModel, SupplementalModel } from "./gateway-catalog.ts";

const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 16384;
const NON_CHAT_TYPES = new Set(["embedding", "image", "video", "audio"]);
const REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);
const EXCLUDED_SYNTHETIC_ULTRA_MODEL_IDS = new Set([
  "codex/gpt-5.6-sol-ultra", "cx/gpt-5.6-sol-ultra",
  "codex/gpt-5.6-terra-ultra", "cx/gpt-5.6-terra-ultra",
]);

type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";
type SupplementalEffortIndex = { strict: Map<string, ReasoningEffort[]>; root: Map<string, ReasoningEffort[]> };

export function normalizeModels(providerId: string, baseUrl: string, snapshot: CatalogSnapshot): readonly Model<"openai-responses">[] {
  const deduped = new Map<string, OmniRouteModel>();
  for (const model of snapshot.primary) {
    if (!isConversational(model) || EXCLUDED_SYNTHETIC_ULTRA_MODEL_IDS.has(normalized(model.id) ?? "")) continue;
    deduped.set(model.id, deduped.has(model.id) ? betterModel(deduped.get(model.id)!, model) : model);
  }
  const variants = new Map<string, ReasoningEffort[]>();
  const folded = new Set<string>();
  for (const id of deduped.keys()) {
    const variant = parseVariant(id);
    if (variant && deduped.has(variant.base)) {
      folded.add(id);
      variants.set(variant.base, mergeEfforts(variants.get(variant.base) ?? [], [variant.effort]));
    }
  }
  const supplemental = buildSupplementalEffortIndex(snapshot.supplemental);
  return [...deduped.entries()]
    .filter(([id]) => !folded.has(id))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, model]) => toModel(
      providerId, baseUrl, model,
      mergeEfforts(mergeEfforts(parseEfforts(model.capabilities?.effort_tiers), variants.get(id) ?? []), supplementalFor(model, supplemental)),
    ));
}

function normalized(value?: string | null) {
  return value?.trim().toLowerCase() || undefined;
}

function mergeEfforts(left: ReasoningEffort[], right: ReasoningEffort[]) {
  return [...new Set([...left, ...right])];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEfforts(value: unknown): ReasoningEffort[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const effort = typeof item === "string" ? item : isRecord(item) ? item.effort : undefined;
    const normalizedEffort = typeof effort === "string" ? effort.trim().toLowerCase() : undefined;
    return normalizedEffort && REASONING_EFFORTS.has(normalizedEffort)
      ? [normalizedEffort as ReasoningEffort]
      : [];
  });
}

function supplementalEfforts(model: SupplementalModel) {
  return parseEfforts(model.supportedReasoningEfforts ?? model.supportsReasoningEffort ??
    model.supports_reasoning_effort ?? model.configSchema?.properties?.reasoningEffort?.enum ??
    model.configurationSchema?.properties?.reasoningEffort?.enum);
}

function keys(model: Pick<SupplementalModel, "id" | "root" | "parent">) {
  return new Set([normalized(model.id), normalized(model.root), normalized(model.parent)].filter(Boolean) as string[]);
}

function buildSupplementalEffortIndex(models: readonly SupplementalModel[]): SupplementalEffortIndex {
  const strict = new Map<string, ReasoningEffort[]>();
  const candidates = new Map<string, { count: number; efforts: ReasoningEffort[] }>();
  for (const model of models) {
    const efforts = supplementalEfforts(model);
    if (efforts.length === 0) continue;
    for (const key of keys(model)) strict.set(key, mergeEfforts(strict.get(key) ?? [], efforts));
    const root = normalized(model.root) ?? normalized(model.id);
    if (root) {
      const previous = candidates.get(root) ?? { count: 0, efforts: [] };
      candidates.set(root, { count: previous.count + 1, efforts: mergeEfforts(previous.efforts, efforts) });
    }
  }
  const root = new Map<string, ReasoningEffort[]>();
  for (const [key, candidate] of candidates) if (candidate.count === 1) root.set(key, candidate.efforts);
  return { strict, root };
}

function supplementalFor(model: OmniRouteModel, index: SupplementalEffortIndex) {
  let efforts: ReasoningEffort[] = [];
  for (const key of keys(model)) efforts = mergeEfforts(efforts, index.strict.get(key) ?? []);
  return efforts.length > 0 ? efforts : (index.root.get(normalized(model.root) ?? normalized(model.id) ?? "") ?? []);
}

function isConversational(model: OmniRouteModel) {
  const type = model.type?.trim().toLowerCase();
  return !((type && NON_CHAT_TYPES.has(type)) ||
    (model.output_modalities && model.output_modalities.length > 0 && !model.output_modalities.includes("text")));
}

function betterModel(left: OmniRouteModel, right: OmniRouteModel) {
  const leftImage = left.input_modalities?.includes("image") ?? false;
  const rightImage = right.input_modalities?.includes("image") ?? false;
  if (!leftImage && rightImage) return right;
  const leftContext = left.context_length ?? left.max_input_tokens ?? 0;
  const rightContext = right.context_length ?? right.max_input_tokens ?? 0;
  if (leftImage === rightImage && rightContext > leftContext) return right;
  if (leftImage === rightImage && rightContext === leftContext && (right.max_output_tokens ?? 0) > (left.max_output_tokens ?? 0)) return right;
  return left;
}

function parseVariant(id: string) {
  const position = id.lastIndexOf("-");
  const effort = position < 0 ? undefined : id.slice(position + 1).toLowerCase();
  return effort && REASONING_EFFORTS.has(effort)
    ? { base: id.slice(0, position), effort: effort as ReasoningEffort }
    : undefined;
}

function thinkingLevelMap(efforts: ReasoningEffort[]) {
  const available = new Set(efforts);
  if (![...available].some((effort) => effort !== "none")) return undefined;
  return {
    off: null,
    minimal: available.has("low") ? "low" : null,
    low: available.has("low") ? "low" : null,
    medium: available.has("medium") ? "medium" : null,
    high: available.has("high") ? "high" : null,
    xhigh: available.has("xhigh") ? "xhigh" : null,
    max: available.has("max") ? "max" : null,
  };
}

function toModel(providerId: string, baseUrl: string, model: OmniRouteModel, efforts: ReasoningEffort[]): Model<"openai-responses"> {
  const map = thinkingLevelMap(efforts);
  return {
    id: model.id,
    name: model.root ?? model.name ?? model.id,
    provider: providerId,
    api: "openai-responses",
    baseUrl,
    reasoning: map !== undefined,
    ...(map ? { thinkingLevelMap: map } : {}),
    input: model.input_modalities?.includes("image") ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.context_length ?? model.max_input_tokens ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.max_output_tokens ?? DEFAULT_MAX_TOKENS,
  };
}
