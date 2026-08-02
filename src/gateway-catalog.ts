import type { RefreshModelsContext } from "@earendil-works/pi-ai/compat";

type CatalogRole = "primary" | "supplemental";

export type OmniRouteConfig = {
  baseUrl: string;
};

export type OmniRouteModel = {
  id: string; name?: string | null; root?: string | null; parent?: string | null; type?: string | null;
  capabilities?: { effort_tiers?: unknown }; input_modalities?: string[]; output_modalities?: string[];
  context_length?: number; max_output_tokens?: number; max_input_tokens?: number;
};

export type SupplementalModel = {
  id?: string | null; root?: string | null; parent?: string | null;
  supportedReasoningEfforts?: unknown; supportsReasoningEffort?: unknown; supports_reasoning_effort?: unknown;
  configSchema?: { properties?: { reasoningEffort?: { enum?: unknown } } };
  configurationSchema?: { properties?: { reasoningEffort?: { enum?: unknown } } };
};

export type CatalogSnapshot = { primary: readonly OmniRouteModel[]; supplemental: readonly SupplementalModel[] };

export function readConfig(env: Record<string, string | undefined> = process.env): OmniRouteConfig | undefined {
  const baseUrl = env.OMNIROUTE_BASE_URL?.trim().replace(/\/+$/, "");
  if (!baseUrl) return undefined;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  return { baseUrl };
}

export async function fetchCatalogs(
  config: OmniRouteConfig,
  context: Pick<RefreshModelsContext, "credential" | "signal">,
): Promise<CatalogSnapshot> {
  throwIfAborted(context.signal);
  const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
  if (!apiKey) throw new Error("Model discovery failed");

  const headers = { Authorization: `Bearer ${apiKey}` };
  const primary = linkedRequestSignal(context.signal);
  const supplemental = linkedRequestSignal(context.signal);
  const cancel = (request: ReturnType<typeof linkedRequestSignal>) => {
    if (!request.signal.aborted) request.controller.abort();
  };
  const primaryResult = fetchCatalog(`${config.baseUrl}/models?prefix=alias`, "primary", context.signal, primary, headers).catch((error) => {
    cancel(supplemental);
    throw error;
  });
  const supplementalResult = fetchCatalog(supplementalUrl(config.baseUrl), "supplemental", context.signal, supplemental, headers).catch((error) => {
    cancel(primary);
    throw error;
  });
  const results = await Promise.allSettled([primaryResult, supplementalResult]);
  throwIfAborted(context.signal);
  if (results[0].status === "fulfilled" && results[1].status === "fulfilled") {
    return { primary: results[0].value as OmniRouteModel[], supplemental: results[1].value as SupplementalModel[] };
  }
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
  const failure = failures.find((error) => !isAbortError(error));
  if (failure instanceof Error) throw failure;
  if (failure !== undefined) throw new Error("Model discovery failed");
  throw abortError();
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
  return isOptionalString(value.name) && isOptionalString(value.root) && isOptionalString(value.parent) &&
    isOptionalString(value.type) && (value.capabilities === undefined || isRecord(value.capabilities)) &&
    isOptionalStrings(value.input_modalities) && isOptionalStrings(value.output_modalities) &&
    isOptionalNumber(value.context_length) && isOptionalNumber(value.max_output_tokens) && isOptionalNumber(value.max_input_tokens);
}

function isSupplementalRow(value: unknown): value is SupplementalModel {
  if (!isRecord(value)) return false;
  return isOptionalString(value.id) && isOptionalString(value.root) && isOptionalString(value.parent) &&
    (value.configSchema === undefined || isRecord(value.configSchema)) &&
    (value.configurationSchema === undefined || isRecord(value.configurationSchema));
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

function linkedRequestSignal(parent: AbortSignal | undefined) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener("abort", abort, { once: true });
  return {
    controller,
    signal: controller.signal,
    dispose() {
      parent?.removeEventListener("abort", abort);
    },
  };
}

async function fetchCatalog(
  url: string,
  role: CatalogRole,
  parent: AbortSignal | undefined,
  request: ReturnType<typeof linkedRequestSignal>,
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
    if (!response.ok) throw new Error(`Model discovery failed with HTTP ${response.status}`);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (parent?.aborted || request.signal.aborted || isAbortError(error)) throw abortError();
      throw new Error(`Model discovery failed with HTTP ${response.status}: invalid response body`);
    }
    throwIfAborted(parent);
    if (request.signal.aborted) throw abortError();
    if (!isRecord(payload) || !Array.isArray(payload.data)) {
      throw new Error(`Model discovery failed with HTTP ${response.status}: invalid response body`);
    }
    const valid = role === "primary" ? isPrimaryRow : isSupplementalRow;
    if (!payload.data.every(valid)) throw new Error(`Model discovery failed with HTTP ${response.status}: invalid response body`);
    return payload.data;
  } finally {
    request.dispose();
  }
}
