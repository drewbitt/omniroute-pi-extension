import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createProvider,
  envApiKeyAuth,
  openAIResponsesApi,
  type Model,
  type RefreshModelsContext,
} from "@earendil-works/pi-ai/compat";

const PROVIDER = "omniroute";
const PROVIDER_DISPLAY_NAME = "OmniRoute";
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 16384;
const DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
const NON_CHAT_TYPES = new Set(["embedding", "image", "video", "audio"]);
const REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);
const EXCLUDED_SYNTHETIC_ULTRA_MODEL_IDS = new Set([
  "codex/gpt-5.6-sol-ultra",
  "cx/gpt-5.6-sol-ultra",
  "codex/gpt-5.6-terra-ultra",
  "cx/gpt-5.6-terra-ultra",
]);

type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

type OmniRouteModel = {
  id: string;
  name?: string;
  root?: string;
  parent?: string | null;
  type?: string;
  capabilities?: { effort_tiers?: unknown };
  input_modalities?: string[];
  output_modalities?: string[];
  context_length?: number;
  max_output_tokens?: number;
  max_input_tokens?: number;
};

type SupplementalModel = {
  id?: string;
  root?: string;
  parent?: string | null;
  supportedReasoningEfforts?: unknown;
  supportsReasoningEffort?: unknown;
  supports_reasoning_effort?: unknown;
  configSchema?: { properties?: { reasoningEffort?: { enum?: unknown } } };
  configurationSchema?: { properties?: { reasoningEffort?: { enum?: unknown } } };
};

type CatalogRole = "primary" | "supplemental";
type SupplementalEffortIndex = { strict: Map<string, ReasoningEffort[]>; root: Map<string, ReasoningEffort[]> };

function getBaseUrl() {
  const value = process.env.OMNIROUTE_BASE_URL?.trim().replace(/\/+$/, "");
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

function getDiscoveryTimeoutMs() {
  const value = Number(process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown) {
  return value === undefined || value === null || typeof value === "string";
}

function isOptionalStrings(value: unknown) {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

function isOptionalNumber(value: unknown) {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isPrimaryRow(value: unknown): value is OmniRouteModel {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) return false;
  return (
    isOptionalString(value.name) &&
    isOptionalString(value.root) &&
    isOptionalString(value.parent) &&
    isOptionalString(value.type) &&
    (value.capabilities === undefined || isRecord(value.capabilities)) &&
    isOptionalStrings(value.input_modalities) &&
    isOptionalStrings(value.output_modalities) &&
    isOptionalNumber(value.context_length) &&
    isOptionalNumber(value.max_output_tokens) &&
    isOptionalNumber(value.max_input_tokens)
  );
}

function isSupplementalRow(value: unknown): value is SupplementalModel {
  if (!isRecord(value)) return false;
  return (
    isOptionalString(value.id) &&
    isOptionalString(value.root) &&
    isOptionalString(value.parent) &&
    (value.configSchema === undefined || isRecord(value.configSchema)) &&
    (value.configurationSchema === undefined || isRecord(value.configurationSchema))
  );
}

function abortError() {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function invalidBody(status: number) {
  return new Error(`Model discovery failed with HTTP ${status}: invalid response body`);
}

function httpError(status: number) {
  return new Error(`Model discovery failed with HTTP ${status}`);
}

function timeoutSignal(parent: AbortSignal | undefined) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), getDiscoveryTimeoutMs());
  return {
    controller,
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
}

async function fetchCatalog(
  url: string,
  role: CatalogRole,
  parent: AbortSignal | undefined,
  request: ReturnType<typeof timeoutSignal>,
  headers: Record<string, string>,
): Promise<unknown[]> {
  try {
    let response: Response;
    try {
      response = await fetch(url, { signal: request.signal, headers });
    } catch (error) {
      if (parent?.aborted || request.signal.aborted || isAbortError(error)) throw abortError();
      throw new Error("Model discovery failed");
    }
    throwIfAborted(parent);
    if (request.signal.aborted) throw abortError();
    if (!response.ok) throw httpError(response.status);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (parent?.aborted || request.signal.aborted || isAbortError(error)) throw abortError();
      throw invalidBody(response.status);
    }
    throwIfAborted(parent);
    if (request.signal.aborted) throw abortError();
    if (!isRecord(payload) || !Array.isArray(payload.data)) throw invalidBody(response.status);
    const valid = role === "primary" ? isPrimaryRow : isSupplementalRow;
    if (!payload.data.every(valid)) throw invalidBody(response.status);
    return payload.data;
  } finally {
    request.dispose();
  }
}

function normalized(value?: string | null) {
  return value?.trim().toLowerCase() || undefined;
}

function mergeEfforts(left: ReasoningEffort[], right: ReasoningEffort[]) {
  return [...new Set([...left, ...right])];
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
  return parseEfforts(
    model.supportedReasoningEfforts ??
      model.supportsReasoningEffort ??
      model.supports_reasoning_effort ??
      model.configSchema?.properties?.reasoningEffort?.enum ??
      model.configurationSchema?.properties?.reasoningEffort?.enum,
  );
}

function keys(model: Pick<SupplementalModel, "id" | "root" | "parent">) {
  return new Set([normalized(model.id), normalized(model.root), normalized(model.parent)].filter(Boolean) as string[]);
}

function buildSupplementalEffortIndex(models: SupplementalModel[]): SupplementalEffortIndex {
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
  return !(
    (type && NON_CHAT_TYPES.has(type)) ||
    (model.output_modalities && model.output_modalities.length > 0 && !model.output_modalities.includes("text"))
  );
}

function betterModel(left: OmniRouteModel, right: OmniRouteModel) {
  const leftImage = left.input_modalities?.includes("image") ?? false;
  const rightImage = right.input_modalities?.includes("image") ?? false;
  if (!leftImage && rightImage) return right;
  const leftContext = left.context_length ?? left.max_input_tokens ?? 0;
  const rightContext = right.context_length ?? right.max_input_tokens ?? 0;
  if (leftImage === rightImage && rightContext > leftContext) return right;
  if (leftImage === rightImage && rightContext === leftContext && (right.max_output_tokens ?? 0) > (left.max_output_tokens ?? 0)) {
    return right;
  }
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

function toModel(baseUrl: string, model: OmniRouteModel, efforts: ReasoningEffort[]): Model<"openai-responses"> {
  const map = thinkingLevelMap(efforts);
  return {
    id: model.id,
    name: model.root ?? model.name ?? model.id,
    provider: PROVIDER,
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

function normalizeModels(baseUrl: string, primary: OmniRouteModel[], supplemental: SupplementalModel[]) {
  const deduped = new Map<string, OmniRouteModel>();
  for (const model of primary) {
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
  const index = buildSupplementalEffortIndex(supplemental);
  return [...deduped.entries()]
    .filter(([id]) => !folded.has(id))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, model]) =>
      toModel(
        baseUrl,
        model,
        mergeEfforts(
          mergeEfforts(parseEfforts(model.capabilities?.effort_tiers), variants.get(id) ?? []),
          supplementalFor(model, index),
        ),
      ),
    );
}

function supplementalUrl(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    if (parts[parts.length - 1] === "v1") parts.pop();
    if (parts[parts.length - 1] === "api") parts.pop();
    url.pathname = `/${[...parts, "api", "v1", "vscode", "_", "models"].join("/")}`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return `${baseUrl.replace(/(?:\/api)?\/v1$/, "")}/api/v1/vscode/_/models`;
  }
}

async function fetchModels(baseUrl: string, context: RefreshModelsContext): Promise<readonly Model<"openai-responses">[]> {
  throwIfAborted(context.signal);
  const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
  if (!apiKey) throw new Error("Model discovery failed");
  const headers = { Authorization: `Bearer ${apiKey}` };
  const primary = timeoutSignal(context.signal);
  const supplemental = timeoutSignal(context.signal);
  const cancel = (request: ReturnType<typeof timeoutSignal>) => {
    if (!request.signal.aborted) request.controller.abort();
  };
  const primaryResult = fetchCatalog(`${baseUrl}/models?prefix=alias`, "primary", context.signal, primary, headers).catch((error) => {
    cancel(supplemental);
    throw error;
  });
  const supplementalResult = fetchCatalog(supplementalUrl(baseUrl), "supplemental", context.signal, supplemental, headers).catch((error) => {
    cancel(primary);
    throw error;
  });
  const results = await Promise.allSettled([primaryResult, supplementalResult]);
  throwIfAborted(context.signal);
  if (results[0].status === "fulfilled" && results[1].status === "fulfilled") {
    return normalizeModels(baseUrl, results[0].value as OmniRouteModel[], results[1].value as SupplementalModel[]);
  }
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  const failure = failures.find((error) => !isAbortError(error));
  if (failure instanceof Error) throw failure;
  if (failure !== undefined) throw new Error("Model discovery failed");
  throw abortError();
}

export default function (pi: ExtensionAPI) {
  const baseUrl = getBaseUrl();
  if (!baseUrl) return;
  pi.registerProvider(
    createProvider({
      id: PROVIDER,
      name: PROVIDER_DISPLAY_NAME,
      baseUrl,
      auth: { apiKey: envApiKeyAuth("OmniRoute API key", ["OMNIROUTE_API_KEY"]) },
      models: [],
      api: openAIResponsesApi(),
      fetchModels: (context) => fetchModels(baseUrl, context),
    }),
  );
}
