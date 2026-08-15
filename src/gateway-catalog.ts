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
        credentialBaseUrl(credential) ??
        normalizeBaseUrl((await ctx.env(BASE_URL_ENV)) ?? "");
      return configured
        ? {
            type: "api_key",
            source: credential ? "stored credential" : BASE_URL_ENV,
          }
        : undefined;
    },
    async resolve({ ctx, credential }) {
      const baseUrl =
        credentialBaseUrl(credential) ??
        normalizeBaseUrl((await ctx.env(BASE_URL_ENV)) ?? "");
      if (!baseUrl) return undefined;
      const apiKey =
        credential?.key ?? (await ctx.env(API_KEY_ENV)) ?? PUBLIC_API_KEY;
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
      signal,
    });
  } catch (error) {
    if (
      signal.aborted ||
      (error instanceof Error && error.name === "AbortError")
    )
      throw abortError();
    throw new Error("OmniRoute model discovery failed");
  }
  if (!response.ok)
    throw new Error(
      `OmniRoute model discovery failed with HTTP ${response.status}`,
    );

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("OmniRoute model discovery returned invalid JSON");
  }
  const rows = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.data)
      ? payload.data
      : undefined;
  if (!rows || !rows.every(isModelRow)) {
    throw new Error("OmniRoute model discovery returned an invalid catalog");
  }
  return rows;
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
    optionalNumber(value.max_tokens)
  );
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}
