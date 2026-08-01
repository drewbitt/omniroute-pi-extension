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
    effort_tiers?: unknown;
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
    delete(): Promise<void>;
  };
  allowNetwork: boolean;
  force?: boolean;
  signal?: AbortSignal;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
const REASONING_EFFORT_SET = new Set<string>(REASONING_EFFORTS);
// Explicit complete alias IDs only — no owned_by/root/prefix heuristics.
const EXCLUDED_SYNTHETIC_ULTRA_MODEL_IDS = new Set([
  "codex/gpt-5.6-sol-ultra",
  "cx/gpt-5.6-sol-ultra",
  "codex/gpt-5.6-terra-ultra",
  "cx/gpt-5.6-terra-ultra",
]);

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

function normalizeThinkingLevels(efforts: ReasoningEffort[]) {
  const has = new Set(efforts);
  return {
    off: null,
    minimal: has.has("low") ? "low" : null,
    low: has.has("low") ? "low" : null,
    medium: has.has("medium") ? "medium" : null,
    high: has.has("high") ? "high" : null,
    xhigh: has.has("xhigh") ? "xhigh" : null,
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

function getPrimaryEffortTiers(model: OmnirouteModel): ReasoningEffort[] {
  return parseReasoningEfforts(model.capabilities?.effort_tiers);
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

function isExcludedSyntheticUltraModelId(id: string) {
  const normalized = normalizeModelToken(id);
  return normalized !== undefined && EXCLUDED_SYNTHETIC_ULTRA_MODEL_IDS.has(normalized);
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

function hasRecognizedAdjustableStrength(efforts: ReasoningEffort[]): boolean {
  // `none` is a recognized effort for parsing/folding and maps to Pi off/omission,
  // but by itself it is not an adjustable strength and must not enable reasoning maps.
  return efforts.some((effort) => effort !== "none");
}

/**
 * Restored ProviderModel snapshots may claim reasoning=true with an absent map or an
 * all-null/invalid map. Publish reasoning only when the map has at least one valid
 * non-null adjustable strength for low/medium/high/xhigh/max. Never invent efforts.
 */
function hasAdjustableThinkingStrength(map: Record<ThinkingLevel, string | null>): boolean {
  return ([map.low, map.medium, map.high, map.xhigh, map.max] as Array<string | null>).some(
    (value) => typeof value === "string" && value.length > 0,
  );
}

function sanitizeRestoredReasoning(model: ProviderModel): ProviderModel {
  const map = model.thinkingLevelMap;
  if (!model.reasoning) {
    if (!map) return model;
    const { thinkingLevelMap: _drop, ...rest } = model;
    return rest;
  }

  // reasoning=true requires a strict complete map with at least one non-null adjustable strength.
  // Incomplete/extra/all-null/invalid maps fail closed: reasoning=false and omit map.
  if (!map || !isValidThinkingLevelMap(map) || !hasAdjustableThinkingStrength(map)) {
    const { thinkingLevelMap: _drop, ...rest } = model;
    return { ...rest, reasoning: false };
  }

  return {
    ...model,
    thinkingLevelMap: sanitizeThinkingLevelMap(map),
  };
}

function toProviderModel(model: OmnirouteModel, efforts: ReasoningEffort[]): ProviderModel {
  // Adjustable reasoning is true only when the fresh merged set contains at least one
  // recognized adjustable strength (low/medium/high/xhigh/max). `none` alone is not enough.
  // Never synthesize tiers from store/legacy cache or from bare reasoning/thinking flags.
  // Fail closed: reasoning:false and omit thinkingLevelMap (never publish all-null maps).
  const reasoning = hasRecognizedAdjustableStrength(efforts);
  const thinkingLevelMap = reasoning ? normalizeThinkingLevels(efforts) : undefined;

  return {
    id: model.id,
    name: model.root ?? model.name ?? model.id,
    reasoning,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
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
  // Filter non-chat rows individually, then dedupe among remaining conversational rows.
  // A valid text/chat row must survive when a separate non-chat row reuses the same id.
  const deduped = new Map<string, OmnirouteModel>();
  for (const model of rawModels.filter(
    (candidate) =>
      candidate?.id && isConversationalTextModel(candidate) && !isExcludedSyntheticUltraModelId(candidate.id),
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
      mergeReasoningEfforts(getPrimaryEffortTiers(model), variantEffortsByBase.get(id) ?? []),
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

/**
 * Per-key wire values that normalizeThinkingLevels can emit for this plugin's Pi map.
 * off is always null (Pi off / omit). minimal and low share provider effort "low".
 * medium/high/xhigh/max map to their own wire efforts or null. Do not accept cross-level
 * recognized values (e.g. high:"low") or unknown strings; never synthesize or normalize them.
 */
const ALLOWED_THINKING_LEVEL_VALUES = {
  off: new Set<string | null>([null]),
  minimal: new Set<string | null>([null, "low"]),
  low: new Set<string | null>([null, "low"]),
  medium: new Set<string | null>([null, "medium"]),
  high: new Set<string | null>([null, "high"]),
  xhigh: new Set<string | null>([null, "xhigh"]),
  max: new Set<string | null>([null, "max"]),
} as const satisfies Record<ThinkingLevel, ReadonlySet<string | null>>;

/**
 * Candidate maps may be incomplete/extra during restore acceptance.
 * Values must still be string|null so we can fail closed later without inventing keys.
 * Exact per-level wire constraints are enforced by isValidThinkingLevelMap.
 */
function isThinkingLevelMapCandidate(value: unknown): value is Record<string, string | null> {
  if (!isRecord(value)) return false;
  for (const entry of Object.values(value)) {
    if (entry !== null && typeof entry !== "string") return false;
  }
  return true;
}

/**
 * Strict restored/published map shape: exactly the full ThinkingLevel key set, no extras,
 * and each key's value must be one of the exact wire efforts normalizeThinkingLevels emits
 * for that key (or null). Do not synthesize missing keys or rewrite invalid values.
 */
function isValidThinkingLevelMap(value: unknown): value is Record<ThinkingLevel, string | null> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== THINKING_LEVELS.length) return false;
  for (const level of THINKING_LEVELS) {
    if (!Object.prototype.hasOwnProperty.call(value, level)) return false;
    const entry = value[level];
    if (entry !== null && typeof entry !== "string") return false;
    if (!ALLOWED_THINKING_LEVEL_VALUES[level].has(entry)) return false;
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
  // Accept candidate maps (including incomplete/extra); sanitizeRestoredReasoning fails closed.
  if (value.thinkingLevelMap !== undefined && !isThinkingLevelMapCandidate(value.thinkingLevelMap)) return false;
  return true;
}

function sanitizeThinkingLevelMap(map: Record<ThinkingLevel, string | null> | undefined) {
  // Never synthesize missing keys. Only pass through strict complete maps.
  if (!map || !isValidThinkingLevelMap(map)) return undefined;
  return {
    off: map.off,
    minimal: map.minimal,
    low: map.low,
    medium: map.medium,
    high: map.high,
    xhigh: map.xhigh,
    max: map.max,
  };
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
    if (isExcludedSyntheticUltraModelId(candidate.id)) continue;
    result.push(sanitizeRestoredReasoning(candidate));
  }
  return result;
}

function identifierSegments(value: string): string[] {
  return value
    .trim()
    .toLowerCase()
    .split(/[/:]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Conservative cleanup for schema-2 normalized legacy entries that lack raw type/modality.
 * Only drop strong unambiguous identifiers (embedding/image/video/audio path segments or
 * embedding model names). Do not treat generic provider words as non-chat signals.
 */
function isObviousNonChatNormalizedModel(model: ProviderModel): boolean {
  for (const value of [model.id, model.name]) {
    if (typeof value !== "string" || !value.trim()) continue;
    const segments = identifierSegments(value);
    if (segments.length === 0) continue;
    const first = segments[0]!;
    const last = segments[segments.length - 1]!;
    if (NON_CHAT_TYPES.has(first) || NON_CHAT_TYPES.has(last)) return true;
    // text-embedding-3-large, embedding-ada-002, foo-embedding-bar
    if (/(^|[-_.])embedding([-_.]|$)/.test(last)) return true;
  }
  return false;
}

function parseLegacyFetchedAt(value: string): number | undefined {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function readLegacyCachedModels(baseUrl: string): { models: ProviderModel[]; checkedAt?: number } {
  try {
    const raw = readFileSync(getLegacyCachePath(baseUrl), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return { models: [] };
    if (parsed.schemaVersion !== CACHE_SCHEMA_VERSION) return { models: [] };
    if (parsed.provider !== PROVIDER) return { models: [] };
    if (typeof parsed.baseUrl !== "string" || parsed.baseUrl.replace(/\/+$/, "") !== baseUrl) return { models: [] };
    if (typeof parsed.fetchedAt !== "string") return { models: [] };
    if (!Array.isArray(parsed.models)) return { models: [] };

    const models: ProviderModel[] = [];
    for (const entry of parsed.models) {
      if (!isProviderModel(entry)) continue;
      if (isExcludedSyntheticUltraModelId(entry.id)) continue;
      if (isObviousNonChatNormalizedModel(entry)) continue;
      models.push(sanitizeRestoredReasoning(entry));
    }
    // Preserve legacy freshness; never invent Date.now() for imported catalogs.
    return { models, checkedAt: parseLegacyFetchedAt(parsed.fetchedAt) };
  } catch {
    return { models: [] };
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

function primaryDiscoveryError(status: number) {
  // Never include statusText, configured URL, API key, or response body (may echo secrets).
  return new Error(`Model discovery failed with HTTP ${status}`);
}

function primaryDiscoveryInvalidBodyError(status: number) {
  // Fixed category only — never exception.message, body text, statusText, URL, headers, or credentials.
  return new Error(`Model discovery failed with HTTP ${status}: invalid response body`);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function toAbortError(): Error {
  const abortError = new Error("The operation was aborted");
  abortError.name = "AbortError";
  return abortError;
}

function throwNormalizedAbort(parent: AbortSignal | undefined, signal: AbortSignal): never {
  // Parent abort and independent request timeout must surface as AbortError only.
  // Never leak internal abort reasons such as Error("timeout").
  throwIfAborted(parent);
  if (signal.aborted) throw toAbortError();
  throw toAbortError();
}

function assertCatalogDataArray(payload: unknown, status: number): unknown[] {
  // Successful empty catalogs use `{ data: [] }`. Missing or non-array `data` is invalid shape.
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw primaryDiscoveryInvalidBodyError(status);
  }
  return payload.data;
}

type CatalogEndpointRole = "primary" | "supplemental";

function isOptionalStringField(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function isOptionalStringArrayField(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

function isOptionalFiniteNumberField(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

/**
 * Generic field shape check: undefined is allowed; when present, value must pass the predicate.
 * Keeps role validators small and free of repeated optional-branch noise.
 */
function fieldWhenPresent(value: unknown, isValid: (present: unknown) => boolean): boolean {
  return value === undefined || isValid(value);
}

function isPrimaryCatalogRow(value: unknown): value is OmnirouteModel {
  if (!isRecord(value)) return false;
  // Primary rows accepted by normalization require a non-empty string id.
  if (typeof value.id !== "string" || value.id.length === 0) return false;
  if (!isOptionalStringField(value.name)) return false;
  if (!isOptionalStringField(value.root)) return false;
  if (!isOptionalStringField(value.parent)) return false;
  if (!isOptionalStringField(value.owned_by)) return false;
  if (!isOptionalStringField(value.type)) return false;
  if (!isOptionalStringField(value.family)) return false;
  // capabilities, when present, must be a record; effort_tiers may be any unknown parsed later.
  if (!fieldWhenPresent(value.capabilities, isRecord)) return false;
  if (!isOptionalStringArrayField(value.input_modalities)) return false;
  if (!isOptionalStringArrayField(value.output_modalities)) return false;
  if (!isOptionalFiniteNumberField(value.context_length)) return false;
  if (!isOptionalFiniteNumberField(value.max_output_tokens)) return false;
  if (!isOptionalFiniteNumberField(value.max_input_tokens)) return false;
  return true;
}

function isSupplementalCatalogRow(value: unknown): value is ReasoningMetadataModel {
  if (!isRecord(value)) return false;
  // Identity fields used by strict/root matching must be string|null|undefined.
  if (!isOptionalStringField(value.id)) return false;
  if (!isOptionalStringField(value.root)) return false;
  if (!isOptionalStringField(value.parent)) return false;
  if (!isOptionalStringField(value.owned_by)) return false;
  // Effort arrays remain unknown and are parsed later. Config schemas, when present, must be
  // records so nested property access never throws on arrays/primitives.
  if (!fieldWhenPresent(value.configSchema, isRecord)) return false;
  if (!fieldWhenPresent(value.configurationSchema, isRecord)) return false;
  return true;
}

function assertCatalogRows(data: unknown[], role: CatalogEndpointRole, status: number): void {
  const isValidRow = role === "primary" ? isPrimaryCatalogRow : isSupplementalCatalogRow;
  for (const row of data) {
    if (!isValidRow(row)) {
      throw primaryDiscoveryInvalidBodyError(status);
    }
  }
}

/**
 * Fetch one discovery participant JSON body with parent+timeout composition.
 * Returns role-validated `data` array (may be empty). Never leaks URL/key/body/statusText.
 */
async function fetchCatalogDataArray(
  url: string,
  headers: Record<string, string>,
  parent: AbortSignal | undefined,
  request: { signal: AbortSignal; dispose: () => void },
  role: CatalogEndpointRole,
): Promise<unknown[]> {
  const { signal, dispose } = request;
  try {
    let response: Response;
    try {
      response = await fetch(url, { headers, signal });
    } catch (error) {
      // Timeout/parent abort before headers: Node may surface abort reason as raw Error("timeout").
      if (isAbortError(error)) throw error;
      if (signal.aborted || parent?.aborted) throwNormalizedAbort(parent, signal);
      // Network/transport failures must stay sanitized (no undici URL/cause text).
      throw new Error("Model discovery failed");
    }
    throwIfAborted(parent);
    if (signal.aborted) throw toAbortError();
    if (!response.ok) {
      throw primaryDiscoveryError(response.status);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      // Abort during body read must remain AbortError (parent or timeout), not a discovery message.
      if (isAbortError(error)) throw error;
      if (signal.aborted || parent?.aborted) throwNormalizedAbort(parent, signal);
      throw primaryDiscoveryInvalidBodyError(response.status);
    }
    throwIfAborted(parent);
    if (signal.aborted) throw toAbortError();
    const data = assertCatalogDataArray(payload, response.status);
    // Row validation is endpoint-role-aware and fails the participant atomically before
    // downstream normalize/index logic can throw TypeError or leak raw exceptions.
    assertCatalogRows(data, role, response.status);
    return data;
  } finally {
    dispose();
  }
}

async function discoverAndNormalize(
  baseUrl: string,
  apiKey: string,
  parent: AbortSignal | undefined,
): Promise<ProviderModel[]> {
  const timeoutMs = getDiscoveryTimeoutMs();
  const headers = { Authorization: `${AUTH_HEADER_PREFIX}${apiKey}` };

  // Both participants of the current-gateway snapshot start concurrently with independent
  // timeouts composed with Pi's parent abort signal. Either failure cancels the sibling
  // immediately; only dual success publishes an atomic fresh snapshot.
  const primaryRequest = createTimeoutSignal(parent, timeoutMs);
  const supplementalRequest = createTimeoutSignal(parent, timeoutMs);

  const cancelSibling = (target: { controller: AbortController; signal: AbortSignal }) => {
    if (!target.signal.aborted) target.controller.abort();
  };

  // Attach failure→sibling-cancel handlers immediately so a late sibling rejection cannot race
  // into an unhandledRejection after the first failure is observed.
  const primaryPromise = fetchCatalogDataArray(
    `${baseUrl}/models?prefix=alias`,
    headers,
    parent,
    primaryRequest,
    "primary",
  ).then(
    (value) => value,
    (error: unknown) => {
      cancelSibling(supplementalRequest);
      throw error;
    },
  );

  const supplementalPromise = fetchCatalogDataArray(
    deriveSupplementalReasoningMetadataUrl(baseUrl),
    headers,
    parent,
    supplementalRequest,
    "supplemental",
  ).then(
    (value) => value,
    (error: unknown) => {
      cancelSibling(primaryRequest);
      throw error;
    },
  );

  const [primarySettled, supplementalSettled] = await Promise.allSettled([
    primaryPromise,
    supplementalPromise,
  ]);

  // Parent abort stays strict AbortError and never becomes a discovery HTTP message.
  throwIfAborted(parent);

  if (primarySettled.status === "fulfilled" && supplementalSettled.status === "fulfilled") {
    // Both participants succeeded (including valid empty `{ data: [] }`). Fresh union only.
    const effortIndex = buildSupplementalEffortIndex(
      supplementalSettled.value as ReasoningMetadataModel[],
    );
    return normalizeModels(primarySettled.value as OmnirouteModel[], effortIndex);
  }

  const reasons = [primarySettled, supplementalSettled]
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);

  // Prefer a real sanitized discovery failure over AbortError produced by sibling cancel.
  // Child/parent-independent timeout remains sanitized AbortError with no timeout reason leak.
  const discoveryError = reasons.find((reason) => !isAbortError(reason));
  if (discoveryError instanceof Error) throw discoveryError;
  if (discoveryError !== undefined) throw new Error("Model discovery failed");
  throw toAbortError();
}

function isFresh(checkedAt: number | undefined, force: boolean | undefined) {
  if (force) return false;
  if (checkedAt === undefined) return false;
  return Date.now() - checkedAt < CATALOG_REFRESH_INTERVAL_MS;
}

function normalizeBaseUrlForCompare(value: string) {
  return value.trim().replace(/\/+$/, "");
}

/**
 * True when a non-empty stored catalog is safe to project for the current base URL.
 * Missing/malformed baseUrl or any entry that does not match the current URL is foreign.
 */
function storedCatalogMatchesBaseUrl(models: readonly unknown[] | undefined, baseUrl: string): boolean {
  if (!Array.isArray(models) || models.length === 0) return true;
  const expected = normalizeBaseUrlForCompare(baseUrl);
  for (const entry of models) {
    if (!isRecord(entry)) return false;
    if (typeof entry.baseUrl !== "string") return false;
    const stored = normalizeBaseUrlForCompare(entry.baseUrl);
    if (!stored || stored !== expected) return false;
  }
  return true;
}

async function refreshModels(baseUrl: string, context: RefreshModelsContext): Promise<ProviderModelConfig[]> {
  throwIfAborted(context.signal);

  let stored = await context.store.read();

  // Strict URL isolation: never project IDs learned from another base URL.
  if (stored?.models && Array.isArray(stored.models) && stored.models.length > 0) {
    if (!storedCatalogMatchesBaseUrl(stored.models, baseUrl)) {
      throwIfAborted(context.signal);
      await context.store.delete();
      stored = undefined;
    }
  }

  let models = providerModelsFromStore(stored?.models);
  let checkedAt = stored?.checkedAt;
  // Stage legacy import in memory only. Persist only when returning without online discovery
  // (fresh cache, offline, or missing API key). A failed attempted online refresh must leave
  // the store untouched (zero writes), while successful dual discovery writes only the fresh snapshot.
  let stagedLegacyImport = false;

  // One-time legacy catalog import into Pi's provider-scoped store (file kept for downgrade).
  if (models.length === 0) {
    const legacy = readLegacyCachedModels(baseUrl);
    if (legacy.models.length > 0) {
      models = legacy.models;
      // Prefer authentic legacy timestamp so stale catalogs revalidate immediately online.
      checkedAt = legacy.checkedAt;
      stagedLegacyImport = true;
    }
  }

  throwIfAborted(context.signal);

  const persistStagedLegacyImport = async () => {
    if (!stagedLegacyImport) return;
    throwIfAborted(context.signal);
    await context.store.write({
      models: models.map((model) => storeModelFromConfig(toProviderModelConfig(model), baseUrl)),
      ...(checkedAt !== undefined ? { checkedAt } : {}),
    });
  };

  if (models.length > 0 && isFresh(checkedAt, context.force)) {
    await persistStagedLegacyImport();
    return models.map(toProviderModelConfig);
  }

  if (!context.allowNetwork) {
    await persistStagedLegacyImport();
    return models.map(toProviderModelConfig);
  }

  const apiKey = resolveApiKey(context);
  if (!apiKey) {
    await persistStagedLegacyImport();
    return models.map(toProviderModelConfig);
  }

  throwIfAborted(context.signal);

  const discovered = await discoverAndNormalize(baseUrl, apiKey, context.signal);
  throwIfAborted(context.signal);

  // Successful dual discovery is an atomic current-gateway snapshot, including empty.
  // Never fall back to stale stored/legacy models after a successful empty normalize.
  // Online success writes only this fresh snapshot once (staged legacy is discarded).
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
