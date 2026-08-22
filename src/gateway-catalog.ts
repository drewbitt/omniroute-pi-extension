import type { ApiKeyAuth, ApiKeyCredential } from "@earendil-works/pi-ai";

export const BASE_URL_ENV = "OMNIROUTE_BASE_URL";
export const API_KEY_ENV = "OMNIROUTE_API_KEY";
export const DEFAULT_BASE_URL = "http://127.0.0.1:20128/v1";
export const PUBLIC_API_KEY = "omniroute-public";

export type OmniRouteConfig = {
  baseUrl: string;
};

export type OmniRouteModel = {
  id: string;
  name?: string | null;
  root?: string | null;
  parent?: string | null;
  type?: string | null;
  owned_by?: string | null;
  capabilities?: {
    reasoning?: boolean;
    thinking?: boolean;
    vision?: boolean;
    attachment?: boolean;
    effort_tiers?: unknown;
  };
  input_modalities?: string[];
  output_modalities?: string[];
  context_length?: number;
  max_output_tokens?: number;
  max_input_tokens?: number;
  max_tokens?: number;
  pricing?: {
    input?: number;
    output?: number;
    cached?: number;
    cache_creation?: number;
  };
};

export function normalizeBaseUrl(value: string): string | undefined {
  const input = value.trim();
  if (!input) return undefined;
  try {
    const url = new URL(input);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password
    )
      return undefined;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.at(-1)?.toLowerCase() === "v1") parts.pop();
    url.pathname = `/${[...parts, "v1"].join("/")}`;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

export function credentialBaseUrl(
  credential?: ApiKeyCredential,
): string | undefined {
  const value = credential?.env?.[BASE_URL_ENV];
  return typeof value === "string" ? normalizeBaseUrl(value) : undefined;
}

export function createOmniRouteAuth(): ApiKeyAuth {
  return {
    name: "OmniRoute API key",
    async login(interaction) {
      const enteredUrl = await interaction.prompt({
        type: "text",
        message: "OmniRoute server URL",
        placeholder: process.env[BASE_URL_ENV] ?? DEFAULT_BASE_URL,
      });
      const baseUrl = normalizeBaseUrl(
        enteredUrl || process.env[BASE_URL_ENV] || DEFAULT_BASE_URL,
      );
      if (!baseUrl)
        throw new Error("OmniRoute server URL must be an HTTP(S) URL");
      const key = (
        await interaction.prompt({
          type: "secret",
          message: "OmniRoute API key (optional for public/local servers)",
        })
      ).trim();
      await fetchModelCatalog(
        { baseUrl },
        key || PUBLIC_API_KEY,
        interaction.signal,
      );
      return {
        type: "api_key",
        key: key || undefined,
        env: { [BASE_URL_ENV]: baseUrl },
      };
    },
    async check({ ctx, credential }) {
      const configured =
        credential?.env?.[BASE_URL_ENV] === undefined
          ? normalizeBaseUrl((await ctx.env(BASE_URL_ENV)) ?? "")
          : credentialBaseUrl(credential);
      return configured
        ? {
            type: "api_key",
            source: credential ? "stored credential" : BASE_URL_ENV,
          }
        : undefined;
    },
    async resolve({ ctx, credential }) {
      const baseUrl =
        credential?.env?.[BASE_URL_ENV] === undefined
          ? normalizeBaseUrl((await ctx.env(BASE_URL_ENV)) ?? "")
          : credentialBaseUrl(credential);
      if (!baseUrl) return undefined;
      const candidate = credential
        ? credential.key
        : await ctx.env(API_KEY_ENV);
      const apiKey = candidate?.trim() || PUBLIC_API_KEY;
      return {
        auth: { apiKey, baseUrl },
        env: { ...credential?.env, [BASE_URL_ENV]: baseUrl },
        source: credential ? "stored credential" : BASE_URL_ENV,
      };
    },
  };
}

export async function fetchModelCatalog(
  config: OmniRouteConfig,
  apiKey: string,
  signal: AbortSignal,
): Promise<readonly OmniRouteModel[]> {
  let url: URL;
  try {
    url = new URL(`${config.baseUrl}/models`);
  } catch {
    throw new Error("OmniRoute model discovery has an invalid base URL");
  }
  url.searchParams.set("prefix", "alias");
  url.searchParams.set("configuredOnly", "true");

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      // Hard cap so an ambient signal (startup refresh) cannot hang forever
      // on a stalled server; /omni sync already bounds the whole refresh.
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
  } catch (error) {
    if (isAbort(error)) throw abortError();
    throw new Error("OmniRoute model discovery failed", { cause: error });
  }
  if (!response.ok)
    throw new Error(
      `OmniRoute model discovery failed with HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
    );

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    if (isAbort(error)) throw abortError();
    throw new Error("OmniRoute model discovery returned invalid JSON", {
      cause: error,
    });
  }
  let rows: unknown[] | undefined;
  if (Array.isArray(payload)) {
    rows = payload;
  } else if (isRecord(payload) && Array.isArray(payload.data)) {
    rows = payload.data;
  }
  if (!rows) {
    throw new Error("OmniRoute model discovery returned an invalid catalog");
  }
  // Tolerate isolated malformed rows: drop them instead of rejecting a
  // catalog of thousands otherwise-fine models. An empty catalog is
  // legitimate (a gateway may have zero configured models).
  return rows.filter(isModelRow);
}

/** Management endpoint root: strip the trailing `/v1` (e.g. `.../v1` → `...`). */
export function managementBaseUrl(baseUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.at(-1)?.toLowerCase() === "v1") parts.pop();
  url.pathname = `/${parts.join("/")}`;
  return url.toString().replace(/\/$/, "");
}

/**
 * Best-effort fetch of the management pricing table (`GET /api/pricing`).
 * Returns `null` on any failure so catalog discovery never depends on it;
 * aborts propagate as AbortError.
 */
export async function fetchPricingTable(
  config: OmniRouteConfig,
  apiKey: string,
  signal: AbortSignal,
): Promise<unknown | null> {
  let url: URL;
  try {
    const root = managementBaseUrl(config.baseUrl);
    if (!root) return null;
    url = new URL(`${root}/api/pricing`);
  } catch {
    return null;
  }
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
  } catch (error) {
    if (isAbort(error)) throw abortError();
    return null;
  }
  if (!response.ok) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function optionalNumber(value: unknown): boolean {
  return (
    value === undefined || (typeof value === "number" && Number.isFinite(value))
  );
}

function optionalStrings(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}

function optionalPricing(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return (
    optionalNumber(value.input) &&
    optionalNumber(value.output) &&
    optionalNumber(value.cached) &&
    optionalNumber(value.cache_creation)
  );
}

function isModelRow(value: unknown): value is OmniRouteModel {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim())
    return false;
  return (
    optionalString(value.name) &&
    optionalString(value.root) &&
    optionalString(value.parent) &&
    optionalString(value.type) &&
    optionalString(value.owned_by) &&
    (value.capabilities === undefined || isRecord(value.capabilities)) &&
    optionalStrings(value.input_modalities) &&
    optionalStrings(value.output_modalities) &&
    optionalNumber(value.context_length) &&
    optionalNumber(value.max_output_tokens) &&
    optionalNumber(value.max_input_tokens) &&
    optionalNumber(value.max_tokens) &&
    optionalPricing(value.pricing)
  );
}

/** True for caller aborts and the fetch helpers' own hard timeouts. */
function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}
