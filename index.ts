import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const PROVIDER = "omniroute";
const PROVIDER_DISPLAY_NAME = "OmniRoute";
const API_KEY_REFERENCE = "$OMNIROUTE_API_KEY";
const AUTH_HEADER_PREFIX = "Bearer ";
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 16384;
const DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
const CACHE_SCHEMA_VERSION = 2;
const CACHE_PATH_ENV = "OMNIROUTE_MODEL_CACHE_PATH";
/** Matches Pi remote-catalog freshness (4 hours). */
const CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
const NON_CHAT_TYPES = new Set(["embedding", "image", "video", "audio"]);

interface OmnirouteModel {
  id: string;
  name?: string;
  root?: string;
  parent?: string | null;
  owned_by?: string;
  type?: string;
  family?: string | null;
  capabilities?: {
    reasoning?: boolean;
    thinking?: boolean;
    vision?: boolean;
  };
  input_modalities?: string[];
  output_modalities?: string[];
  context_length?: number;
  max_output_tokens?: number;
  max_input_tokens?: number;
}

interface ReasoningConfigSchema {
  properties?: {
    reasoningEffort?: {
      enum?: unknown;
    };
  };
}

interface ReasoningMetadataModel {
  id?: string;
  root?: string;
  owned_by?: string;
  parent?: string | null;
  supportedReasoningEfforts?: unknown;
  supportsReasoningEffort?: unknown;
  supports_reasoning_effort?: unknown;
  configSchema?: ReasoningConfigSchema;
  configurationSchema?: ReasoningConfigSchema;
}

interface DataPayload<T> {
  data?: T[];
}

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";
type ProviderInput = "text" | "image";

interface ProviderModel {
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<ThinkingLevel, string | null>;
  input: ProviderInput[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

interface ModelCache {
  schemaVersion: number;
  provider: string;
  baseUrl: string;
  fetchedAt: string;
  models: ProviderModel[];
}

interface RefreshModelsContext {
  credential?: { type?: string; key?: string };
  store: {
    read(): Promise<{ models?: readonly unknown[]; checkedAt?: number } | undefined>;
    write(entry: { models: readonly unknown[]; checkedAt?: number }): Promise<void>;
  };
  allowNetwork: boolean;
  force?: boolean;
  signal?: AbortSignal;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);
const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
const REASONING_EFFORT_SET = new Set<string>(REASONING_EFFORTS);
const SYNTHETIC_CODEX_ULTRA_ROOTS = new Set(["gpt-5.6-sol-ultra", "gpt-5.6-terra-ultra"]);
const CODEX_MODEL_PREFIXES = new Set(["cx", "codex"]);
const DEEPSEEK_THINKING_FAMILY = "deepseek-thinking";

function isConversationalTextModel(model: OmnirouteModel): boolean {
  const type = typeof model.type === "string" ? model.type.trim().toLowerCase() : "";
  if (type && NON_CHAT_TYPES.has(type)) return false;
  if (model.output_modalities && model.output_modalities.length > 0 && !model.output_modalities.includes("text")) {
    return false;
  }
  return true;
}

function betterModel(a: OmnirouteModel, b: OmnirouteModel): OmnirouteModel {
  const aImage = a.input_modalities?.includes("image") ?? false;
  const bImage = b.input_modalities?.includes("image") ?? false;
  if (!aImage && bImage) return b;

  if (aImage === bImage) {
    const aContext = a.context_length ?? a.max_input_tokens ?? 0;
    const bContext = b.context_length ?? b.max_input_tokens ?? 0;
    if (bContext > aContext) return b;

    const aTokens = a.max_output_tokens ?? 0;
    const bTokens = b.max_output_tokens ?? 0;
    if (bTokens > aTokens) return b;
  }

  return a;
}

function normalizeThinkingLevels(efforts: ReasoningEffort[], options?: { xhighValue?: string }) {
  const has = new Set(efforts);
  return {
    off: null,
    minimal: has.has("low") ? "low" : null,
    low: has.has("low") ? "low" : null,
    medium: has.has("medium") ? "medium" : null,
    high: has.has("high") ? "high" : null,
    xhigh: has.has("xhigh") ? (options?.xhighValue ?? "xhigh") : null,
    max: has.has("max") ? "max" : null,
  } satisfies Record<ThinkingLevel, string | null>;
}

function mergeReasoningEfforts(baseEfforts: ReasoningEffort[], extraEfforts: ReasoningEffort[]) {
  return [...new Set([...baseEfforts, ...extraEfforts])];
}

function parseReasoningVariant(id: string): { base: string; effort?: ReasoningEffort } {
  const dash = id.lastIndexOf("-");
  if (dash < 0) return { base: id };

  const suffix = id.slice(dash + 1).toLowerCase();
  if (!REASONING_EFFORT_SET.has(suffix)) return { base: id };

  return { base: id.slice(0, dash), effort: suffix as ReasoningEffort };
}

function parseReasoningEfforts(values: unknown): ReasoningEffort[] {
  if (!Array.isArray(values)) return [];
  const efforts: ReasoningEffort[] = [];
  for (const value of values) {
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (REASONING_EFFORT_SET.has(normalized)) efforts.push(normalized as ReasoningEffort);
      continue;
    }
    if (value && typeof value === "object" && "effort" in value) {
      const effort = (value as { effort?: unknown }).effort;
      if (typeof effort === "string") {
        const normalized = effort.trim().toLowerCase();
        if (REASONING_EFFORT_SET.has(normalized)) efforts.push(normalized as ReasoningEffort);
      }
    }
  }
  return efforts;
}

function getEffortsFromReasoningMetadata(model: ReasoningMetadataModel): ReasoningEffort[] {
  const fromSupported = parseReasoningEfforts(
    model.supportedReasoningEfforts ?? model.supportsReasoningEffort ?? model.supports_reasoning_effort,
  );
  if (fromSupported.length > 0) return fromSupported;

  const schema = model.configSchema ?? model.configurationSchema;
  return parseReasoningEfforts(schema?.properties?.reasoningEffort?.enum);
}

function normalizeModelToken(value?: string | null) {
  return value?.trim().toLowerCase() || undefined;
}

function addModelKey(keys: Set<string>, value?: string | null) {
  const normalized = normalizeModelToken(value);
  if (normalized) keys.add(normalized);
}

function strictModelKeys(model: { id?: string; root?: string; parent?: string | null; owned_by?: string }) {
  const keys = new Set<string>();
  addModelKey(keys, model.id);
  addModelKey(keys, model.root);
  addModelKey(keys, model.parent);
  return keys;
}

function rootModelKey(model: { id?: string; root?: string }) {
  return normalizeModelToken(model.root) ?? normalizeModelToken(model.id);
}

function isSyntheticCodexUltraAlias(model: { id: string; root?: string; owned_by?: string }) {
  const owner = normalizeModelToken(model.owned_by);
  const prefix = normalizeModelToken(model.id.split("/", 1)[0]);
  const isCodexModel = owner ? owner === "codex" : CODEX_MODEL_PREFIXES.has(prefix ?? "");

  return isCodexModel && SYNTHETIC_CODEX_ULTRA_ROOTS.has(rootModelKey(model) ?? "");
}

function mergeEffortIntoIndex(index: Map<string, ReasoningEffort[]>, key: string | undefined, efforts: ReasoningEffort[]) {
  if (!key) return;
  index.set(key, mergeReasoningEfforts(index.get(key) ?? [], efforts));
}

function buildSupplementalEffortIndex(metadataModels: ReasoningMetadataModel[]) {
  const strict = new Map<string, ReasoningEffort[]>();
  const rootCandidates = new Map<string, { count: number; efforts: ReasoningEffort[] }>();

  for (const model of metadataModels) {
    const efforts = getEffortsFromReasoningMetadata(model);
    if (efforts.length === 0) continue;

    for (const key of strictModelKeys(model)) {
      mergeEffortIntoIndex(strict, key, efforts);
    }

    const rootKey = rootModelKey(model);
    if (rootKey) {
      const current = rootCandidates.get(rootKey) ?? { count: 0, efforts: [] };
      rootCandidates.set(rootKey, {
        count: current.count + 1,
        efforts: mergeReasoningEfforts(current.efforts, efforts),
      });
    }
  }

  const root = new Map<string, ReasoningEffort[]>();
  for (const [key, candidate] of rootCandidates) {
    if (candidate.count === 1) root.set(key, candidate.efforts);
  }

  return { strict, root };
}

type SupplementalEffortIndex = ReturnType<typeof buildSupplementalEffortIndex>;

function getSupplementalEffortsForModel(model: OmnirouteModel, effortIndex: SupplementalEffortIndex) {
  let efforts: ReasoningEffort[] = [];
  for (const key of strictModelKeys(model)) {
    efforts = mergeReasoningEfforts(efforts, effortIndex.strict.get(key) ?? []);
  }
  if (efforts.length > 0) return efforts;

  return effortIndex.root.get(rootModelKey(model) ?? "") ?? [];
}

function toProviderModel(model: OmnirouteModel, efforts: ReasoningEffort[]): ProviderModel {
  const reasoning = Boolean(model.capabilities?.reasoning || model.capabilities?.thinking || efforts.length > 0);
  const isDeepseekFamily = model.family === DEEPSEEK_THINKING_FAMILY;
  const thinkingLevelMap = normalizeThinkingLevels(efforts, { xhighValue: isDeepseekFamily ? "max" : undefined });

  return {
    id: model.id,
    name: model.root ?? model.name ?? model.id,
    reasoning,
    ...(reasoning ? { thinkingLevelMap } : {}),
    input: (model.input_modalities?.includes("image") ? ["text", "image"] : ["text"]) as ProviderInput[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.context_length ?? model.max_input_tokens ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.max_output_tokens ?? DEFAULT_MAX_TOKENS,
  };
}

function resolveVerifiedVariantBase(
  id: string,
  catalogIds: Set<string>,
): { baseId: string; effort: ReasoningEffort } | undefined {
  const parsed = parseReasoningVariant(id);
  if (!parsed.effort || !catalogIds.has(parsed.base)) return undefined;

  return { baseId: parsed.base, effort: parsed.effort };
}

function normalizeModels(rawModels: OmnirouteModel[], effortIndex: SupplementalEffortIndex): ProviderModel[] {
  // If any catalog entry for an id is a known non-chat type, drop the whole id.
  // This covers OmniRoute catalogs that emit both typed non-chat rows and untyped duplicates.
  const nonChatIds = new Set<string>();
  for (const model of rawModels) {
    if (!model?.id) continue;
    const type = typeof model.type === "string" ? model.type.trim().toLowerCase() : "";
    if (type && NON_CHAT_TYPES.has(type)) nonChatIds.add(model.id);
    if (model.output_modalities && model.output_modalities.length > 0 && !model.output_modalities.includes("text")) {
      nonChatIds.add(model.id);
    }
  }

  const deduped = new Map<string, OmnirouteModel>();
  for (const model of rawModels.filter(
    (candidate) =>
      candidate?.id &&
      !nonChatIds.has(candidate.id) &&
      isConversationalTextModel(candidate) &&
      !isSyntheticCodexUltraAlias(candidate),
  )) {
    const current = deduped.get(model.id);
    deduped.set(model.id, current ? betterModel(current, model) : model);
  }

  const models = [...deduped.entries()].sort(([a], [b]) => a.localeCompare(b));
  const catalogIds = new Set(deduped.keys());
  const foldedVariantIds = new Set<string>();
  const variantEffortsByBase = new Map<string, ReasoningEffort[]>();

  for (const [id] of models) {
    const variant = resolveVerifiedVariantBase(id, catalogIds);
    if (!variant) continue;

    foldedVariantIds.add(id);
    const current = variantEffortsByBase.get(variant.baseId) ?? [];
    variantEffortsByBase.set(variant.baseId, mergeReasoningEfforts(current, [variant.effort]));
  }

  const normalized: ProviderModel[] = [];
  for (const [id, model] of models) {
    if (foldedVariantIds.has(id)) continue;

    const efforts = mergeReasoningEfforts(
      variantEffortsByBase.get(id) ?? [],
      getSupplementalEffortsForModel(model, effortIndex),
    );
    normalized.push(toProviderModel(model, efforts));
  }

  return normalized;
}

function deriveSupplementalReasoningMetadataUrl(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");

  try {
    const url = new URL(trimmed);
    const pathParts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    if (pathParts[pathParts.length - 1] === "v1") pathParts.pop();
    if (pathParts[pathParts.length - 1] === "api") pathParts.pop();

    url.pathname = `/${[...pathParts, "api", "v1", "vscode", "_", "models"].join("/")}`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return `${trimmed.replace(/(?:\/api)?\/v1$/, "")}/api/v1/vscode/_/models`;
  }
}

function cleanConfigValue(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function expandTilde(value: string) {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function getAgentDir() {
  const configured = cleanConfigValue(process.env.PI_CODING_AGENT_DIR);
  return configured ? expandTilde(configured) : join(homedir(), ".pi", "agent");
}

function getDiscoveryTimeoutMs() {
  const configured = Number(process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS;
}

function getEnvApiKey() {
  return cleanConfigValue(process.env.OMNIROUTE_API_KEY);
}

function getBaseUrl() {
  return cleanConfigValue(process.env.OMNIROUTE_BASE_URL)?.replace(/\/+$/, "");
}

function getLegacyCachePath(baseUrl: string) {
  const configuredPath = cleanConfigValue(process.env[CACHE_PATH_ENV]);
  if (configuredPath) return configuredPath;

  const cacheKey = createHash("sha256").update(baseUrl).digest("hex").slice(0, 16);
  return join(getAgentDir(), "omniroute", `models-${cacheKey}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isCost(value: unknown): value is ProviderModel["cost"] {
  if (!isRecord(value)) return false;
  return ["input", "output", "cacheRead", "cacheWrite"].every(
    (key) => typeof value[key] === "number" && Number.isFinite(value[key]),
  );
}

function isInputList(value: unknown): value is ProviderInput[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => item === "text" || item === "image");
}

function isValidThinkingLevelMap(value: unknown): value is Record<ThinkingLevel, string | null> {
  if (!isRecord(value)) return false;

  for (const [key, entry] of Object.entries(value)) {
    if (!THINKING_LEVEL_SET.has(key)) return false;
    if (entry !== null && typeof entry !== "string") return false;
  }

  return true;
}

function isProviderModel(value: unknown): value is ProviderModel {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || value.id.length === 0) return false;
  if (typeof value.name !== "string" || value.name.length === 0) return false;
  if (typeof value.reasoning !== "boolean") return false;
  if (!isInputList(value.input)) return false;
  if (!isCost(value.cost)) return false;
  if (!isPositiveNumber(value.contextWindow)) return false;
  if (!isPositiveNumber(value.maxTokens)) return false;
  if (value.thinkingLevelMap !== undefined && !isValidThinkingLevelMap(value.thinkingLevelMap)) return false;
  return true;
}

function sanitizeThinkingLevelMap(map: Record<ThinkingLevel, string | null> | undefined) {
  if (!map) return undefined;
  const sanitized = { ...map } as Record<ThinkingLevel, string | null>;
  for (const level of THINKING_LEVELS) {
    if (!(level in sanitized)) sanitized[level] = null;
  }
  return sanitized;
}

function toProviderModelConfig(model: ProviderModel): ProviderModelConfig {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: sanitizeThinkingLevelMap(model.thinkingLevelMap) } : {}),
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

function storeModelFromConfig(model: ProviderModelConfig, baseUrl: string) {
  return {
    ...model,
    provider: PROVIDER,
    api: "openai-responses" as const,
    baseUrl,
  };
}

function providerModelsFromStore(models: readonly unknown[] | undefined): ProviderModel[] {
  if (!Array.isArray(models)) return [];
  const result: ProviderModel[] = [];
  for (const entry of models) {
    if (!isRecord(entry)) continue;
    const candidate = {
      id: entry.id,
      name: entry.name,
      reasoning: entry.reasoning,
      thinkingLevelMap: entry.thinkingLevelMap,
      input: entry.input,
      cost: entry.cost,
      contextWindow: entry.contextWindow,
      maxTokens: entry.maxTokens,
    };
    if (!isProviderModel(candidate)) continue;
    if (isSyntheticCodexUltraAlias({ id: candidate.id, root: candidate.name })) continue;
    result.push({
      ...candidate,
      thinkingLevelMap: candidate.thinkingLevelMap
        ? sanitizeThinkingLevelMap(candidate.thinkingLevelMap)
        : undefined,
    });
  }
  return result;
}

function readLegacyCachedModels(baseUrl: string): ProviderModel[] {
  try {
    const raw = readFileSync(getLegacyCachePath(baseUrl), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return [];
    if (parsed.schemaVersion !== CACHE_SCHEMA_VERSION) return [];
    if (parsed.provider !== PROVIDER) return [];
    if (typeof parsed.baseUrl !== "string" || parsed.baseUrl.replace(/\/+$/, "") !== baseUrl) return [];
    if (typeof parsed.fetchedAt !== "string") return [];
    if (!Array.isArray(parsed.models)) return [];

    const models: ProviderModel[] = [];
    for (const entry of parsed.models) {
      if (!isProviderModel(entry)) continue;
      if (isSyntheticCodexUltraAlias({ id: entry.id, root: entry.name })) continue;
      models.push({
        ...entry,
        thinkingLevelMap: entry.thinkingLevelMap ? sanitizeThinkingLevelMap(entry.thinkingLevelMap) : undefined,
      });
    }
    return models;
  } catch {
    return [];
  }
}

function resolveApiKey(context: RefreshModelsContext): string | undefined {
  if (context.credential?.type === "api_key" && typeof context.credential.key === "string") {
    return cleanConfigValue(context.credential.key);
  }
  return getEnvApiKey();
}

function createTimeoutSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  const dispose = () => {
    clearTimeout(timer);
    if (parent) parent.removeEventListener("abort", onParentAbort);
  };
  return { signal: controller.signal, controller, dispose };
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    throw error;
  }
}

function primaryDiscoveryError(status: number, statusText: string) {
  // Never include configured URL, API key, or response body (may echo secrets).
  return new Error(`Model discovery failed: ${status} ${statusText}`.trim());
}

async function fetchJsonWithTimeout<T>(
  url: string,
  headers: Record<string, string>,
  parent: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  const { signal, dispose } = createTimeoutSignal(parent, timeoutMs);
  try {
    const response = await fetch(url, { headers, signal });
    throwIfAborted(parent);
    if (!response.ok) {
      throw primaryDiscoveryError(response.status, response.statusText);
    }
    return (await response.json()) as T;
  } finally {
    dispose();
  }
}

async function fetchSupplementalEffortIndex(
  baseUrl: string,
  headers: Record<string, string>,
  parent: AbortSignal | undefined,
  timeoutMs: number,
  controller: AbortController,
): Promise<SupplementalEffortIndex> {
  const onParentAbort = () => {
    if (!controller.signal.aborted) controller.abort(parent?.reason);
  };
  if (parent) {
    if (parent.aborted) controller.abort(parent.reason);
    else parent.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort(new Error("timeout"));
  }, timeoutMs);
  try {
    const response = await fetch(deriveSupplementalReasoningMetadataUrl(baseUrl), {
      headers,
      signal: controller.signal,
    });
    if (!response.ok) return buildSupplementalEffortIndex([]);
    const payload = (await response.json()) as DataPayload<ReasoningMetadataModel>;
    return buildSupplementalEffortIndex(Array.isArray(payload.data) ? payload.data : []);
  } catch {
    return buildSupplementalEffortIndex([]);
  } finally {
    clearTimeout(timer);
    if (parent) parent.removeEventListener("abort", onParentAbort);
  }
}

async function discoverAndNormalize(
  baseUrl: string,
  apiKey: string,
  parent: AbortSignal | undefined,
): Promise<ProviderModel[]> {
  const timeoutMs = getDiscoveryTimeoutMs();
  const headers = { Authorization: `${AUTH_HEADER_PREFIX}${apiKey}` };
  const supplementalController = new AbortController();

  // Start both requests before awaiting either, so supplemental can race independently.
  const primaryPromise = fetchJsonWithTimeout<DataPayload<OmnirouteModel>>(
    `${baseUrl}/models?prefix=alias`,
    headers,
    parent,
    timeoutMs,
  );

  let supplementalSettled = false;
  let supplementalIndex = buildSupplementalEffortIndex([]);
  const supplementalPromise = fetchSupplementalEffortIndex(
    baseUrl,
    headers,
    parent,
    timeoutMs,
    supplementalController,
  ).then(
    (index) => {
      supplementalSettled = true;
      supplementalIndex = index;
      return index;
    },
    () => {
      supplementalSettled = true;
      supplementalIndex = buildSupplementalEffortIndex([]);
      return supplementalIndex;
    },
  );

  // Keep the race alive without making primary wait on it.
  void supplementalPromise.catch(() => undefined);

  let payload: DataPayload<OmnirouteModel>;
  try {
    payload = await primaryPromise;
  } catch (error) {
    if (!supplementalController.signal.aborted) supplementalController.abort();
    throwIfAborted(parent);
    throw error;
  }

  throwIfAborted(parent);

  if (!supplementalSettled) {
    if (!supplementalController.signal.aborted) supplementalController.abort();
  }

  // One short yield so an already-completed supplemental then() can mark settled.
  if (!supplementalSettled) {
    await Promise.race([supplementalPromise, Promise.resolve()]);
  }

  const effortIndex = supplementalSettled ? supplementalIndex : buildSupplementalEffortIndex([]);
  const rawModels = Array.isArray(payload.data) ? payload.data : [];
  return normalizeModels(rawModels, effortIndex);
}

function isFresh(checkedAt: number | undefined, force: boolean | undefined) {
  if (force) return false;
  if (checkedAt === undefined) return false;
  return Date.now() - checkedAt < CATALOG_REFRESH_INTERVAL_MS;
}

async function refreshModels(baseUrl: string, context: RefreshModelsContext): Promise<ProviderModelConfig[]> {
  throwIfAborted(context.signal);

  let stored = await context.store.read();
  let models = providerModelsFromStore(stored?.models);
  let checkedAt = stored?.checkedAt;

  // One-time legacy catalog import into Pi's provider-scoped store (file kept for downgrade).
  if (models.length === 0) {
    const legacy = readLegacyCachedModels(baseUrl);
    if (legacy.length > 0) {
      models = legacy;
      checkedAt = Date.now();
      throwIfAborted(context.signal);
      await context.store.write({
        models: models.map((model) => storeModelFromConfig(toProviderModelConfig(model), baseUrl)),
        checkedAt,
      });
      stored = { models, checkedAt };
    }
  }

  throwIfAborted(context.signal);

  if (models.length > 0 && isFresh(checkedAt, context.force)) {
    return models.map(toProviderModelConfig);
  }

  if (!context.allowNetwork) {
    return models.map(toProviderModelConfig);
  }

  const apiKey = resolveApiKey(context);
  if (!apiKey) {
    return models.map(toProviderModelConfig);
  }

  throwIfAborted(context.signal);

  const discovered = await discoverAndNormalize(baseUrl, apiKey, context.signal);
  throwIfAborted(context.signal);

  if (discovered.length === 0) {
    return models.map(toProviderModelConfig);
  }

  const nextCheckedAt = Date.now();
  await context.store.write({
    models: discovered.map((model) => storeModelFromConfig(toProviderModelConfig(model), baseUrl)),
    checkedAt: nextCheckedAt,
  });
  return discovered.map(toProviderModelConfig);
}

export default function (pi: ExtensionAPI) {
  const baseUrl = getBaseUrl();
  if (!baseUrl) return;

  pi.registerProvider(PROVIDER, {
    name: PROVIDER_DISPLAY_NAME,
    baseUrl,
    apiKey: API_KEY_REFERENCE,
    api: "openai-responses",
    models: [],
    async refreshModels(context) {
      return refreshModels(baseUrl, context as RefreshModelsContext);
    },
  });
}
