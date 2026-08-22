import { createHash } from "node:crypto";
import type { Model, Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  API_KEY_ENV,
  BASE_URL_ENV,
  createOmniRouteAuth,
  credentialBaseUrl,
  DEFAULT_BASE_URL,
  fetchModelCatalog,
  fetchPricingTable,
  normalizeBaseUrl,
  PUBLIC_API_KEY,
} from "./src/gateway-catalog.ts";
import { normalizeModels } from "./src/model-normalizer.ts";
import { applyPricingTable, parsePricingTable } from "./src/pricing-merge.ts";

export const PROVIDER_ID = "omniroute";
const PROVIDER_NAME = "OmniRoute";
const PROVIDER_API = "openai-completions" as const;

function catalogScope(baseUrl: string, apiKey: string): string {
  return createHash("sha256")
    .update(baseUrl)
    .update("\0")
    .update(apiKey)
    .digest("base64url");
}

export function createOmniRouteProvider(): Provider<"openai-completions"> {
  let models: readonly Model<"openai-completions">[] = [];
  let activeScope: string | undefined;
  const streams = openAICompletionsApi();

  return {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    baseUrl: DEFAULT_BASE_URL,
    auth: { apiKey: createOmniRouteAuth() },
    getModels: () => models,
    async refreshModels(context) {
      const credential =
        context.credential?.type === "api_key" ? context.credential : undefined;
      const baseUrl =
        credential?.env?.[BASE_URL_ENV] === undefined
          ? normalizeBaseUrl(process.env[BASE_URL_ENV] ?? "")
          : credentialBaseUrl(credential);
      if (!baseUrl) {
        if (context.stored || models.length > 0) {
          await context.publish({
            persist: null,
            update: () => {
              models = [];
              activeScope = undefined;
            },
          });
        }
        return;
      }

      const explicitApiKey =
        credential?.key?.trim() ||
        (credential ? undefined : process.env[API_KEY_ENV]?.trim());
      const apiKey = explicitApiKey || PUBLIC_API_KEY;
      // The catalog holds only model metadata; the API key lives in auth.json.
      // Always persist so cache-only one-shot mode (subagents) can restore models offline.
      const requestedScope = catalogScope(baseUrl, apiKey);
      if (context.stored) {
        const compatible = context.stored.models.filter(
          (model): model is Model<"openai-completions"> =>
            model.provider === PROVIDER_ID &&
            model.api === PROVIDER_API &&
            model.baseUrl === baseUrl,
        );
        const storedMatches =
          compatible.length === context.stored.models.length;
        const restored = storedMatches ? compatible : [];
        if (
          !(await context.publish({
            ...(storedMatches ? {} : { persist: null }),
            update: () => {
              models = restored;
              activeScope = storedMatches ? requestedScope : undefined;
            },
          }))
        )
          return;
      } else if (activeScope !== requestedScope) {
        if (
          !(await context.publish({
            update: () => {
              models = [];
              activeScope = undefined;
            },
          }))
        )
          return;
      }

      if (!context.allowNetwork || context.signal.aborted) return;
      const catalog = await fetchModelCatalog(
        { baseUrl },
        apiKey,
        context.signal,
      );
      if (context.signal.aborted) return;
      // Best-effort pricing enrichment from the management table. Any
      // failure keeps the original catalog rows; discovery never depends on it.
      const pricingPayload = await fetchPricingTable(
        { baseUrl },
        apiKey,
        context.signal,
      );
      if (context.signal.aborted) return;
      const enriched = applyPricingTable(
        catalog,
        parsePricingTable(pricingPayload),
      );
      const refreshed = normalizeModels(PROVIDER_ID, baseUrl, enriched);
      // A rejected publication (superseded generation) ends the refresh:
      // unlike the restore-path publishes above there is no fallback state
      // to apply, but success must not be reported for a rejected publish.
      if (
        !(await context.publish({
          persist: { models: refreshed, checkedAt: Date.now() },
          update: () => {
            models = refreshed;
            activeScope = requestedScope;
          },
        }))
      )
        return;
    },
    stream: (model, context, options) =>
      streams.stream(model, context, options),
    streamSimple: (model, context, options) =>
      streams.streamSimple(model, context, options),
  };
}

async function showStatus(ctx: ExtensionCommandContext): Promise<void> {
  const auth = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
  const count =
    ctx.modelRegistry.getProvider(PROVIDER_ID)?.getModels().length ?? 0;
  if (!auth) {
    ctx.ui.notify(
      `OmniRoute is not configured. Run /login ${PROVIDER_ID}.`,
      "warning",
    );
    return;
  }
  ctx.ui.notify(
    [
      "OmniRoute",
      `Endpoint: ${auth.auth.baseUrl ?? "unknown"}`,
      `Auth: ${auth.source ?? "configured"}`,
      `Models: ${count}`,
    ].join("\n"),
    "info",
  );
}

async function syncModels(ctx: ExtensionCommandContext): Promise<void> {
  const auth = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
  if (!auth) {
    ctx.ui.notify(
      `OmniRoute is not configured. Run /login ${PROVIDER_ID}.`,
      "warning",
    );
    return;
  }
  const existingCount =
    ctx.modelRegistry.getProvider(PROVIDER_ID)?.getModels().length ?? 0;
  const signal = AbortSignal.timeout(15_000);
  const result = await ctx.modelRegistry.refresh({
    providers: [PROVIDER_ID],
    force: true,
    signal,
  });
  if (result.aborted) {
    ctx.ui.notify(
      `OmniRoute model sync timed out${existingCount ? `; using ${existingCount} existing models` : ""}.`,
      "warning",
    );
    return;
  }
  const error = result.errors.get(PROVIDER_ID);
  if (error) {
    const retained = existingCount
      ? ` Using ${existingCount} existing models.`
      : "";
    ctx.ui.notify(
      `OmniRoute model sync failed: ${error.message}.${retained}`,
      "error",
    );
    return;
  }
  const count =
    ctx.modelRegistry.getProvider(PROVIDER_ID)?.getModels().length ?? 0;
  ctx.ui.notify(
    `OmniRoute synced ${count} model${count === 1 ? "" : "s"}.`,
    "info",
  );
}

export default function omniRouteExtension(pi: ExtensionAPI): void {
  pi.registerProvider(createOmniRouteProvider());
  pi.registerCommand("omni", {
    description: "Show OmniRoute status or refresh its model catalog",
    getArgumentCompletions(prefix) {
      return ["status", "sync", "help"].flatMap((value) =>
        value.startsWith(prefix) ? [{ value, label: value }] : [],
      );
    },
    async handler(args, ctx) {
      const subcommand = args.trim().toLowerCase() || "status";
      try {
        if (subcommand === "status") return await showStatus(ctx);
        if (subcommand === "sync") return await syncModels(ctx);
        if (subcommand === "help") {
          ctx.ui.notify(
            [
              "/omni status  Show endpoint, auth source, and model count",
              "/omni sync    Refresh the live /v1/models catalog",
              `/login ${PROVIDER_ID}  Configure the server and API key`,
              `Environment fallback: ${BASE_URL_ENV} and OMNIROUTE_API_KEY`,
            ].join("\n"),
            "info",
          );
          return;
        }
        ctx.ui.notify("Usage: /omni [status|sync|help]", "warning");
      } catch (error) {
        ctx.ui.notify(
          `OmniRoute: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
}
