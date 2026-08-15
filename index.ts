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
  fetchModelCatalog,
  normalizeBaseUrl,
  PUBLIC_API_KEY,
} from "./src/gateway-catalog.ts";
import { normalizeModels } from "./src/model-normalizer.ts";

export const PROVIDER_ID = "omniroute";
const PROVIDER_NAME = "OmniRoute";
const PROVIDER_API = "openai-completions" as const;
const FALLBACK_BASE_URL = "http://127.0.0.1:20128/v1";

export function createOmniRouteProvider(): Provider<"openai-completions"> {
  let models: readonly Model<"openai-completions">[] = [];
  const streams = openAICompletionsApi();

  return {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    baseUrl: FALLBACK_BASE_URL,
    auth: { apiKey: createOmniRouteAuth() },
    getModels: () => models,
    async refreshModels(context) {
      const credential =
        context.credential?.type === "api_key"
          ? context.credential
          : undefined;
      const baseUrl =
        credentialBaseUrl(credential) ??
        normalizeBaseUrl(process.env[BASE_URL_ENV] ?? "");
      if (!baseUrl) {
        if (context.stored || models.length > 0) {
          await context.publish({
            persist: null,
            update: () => {
              models = [];
            },
          });
        }
        return;
      }

      const apiKey =
        credential?.key?.trim() ||
        (credential ? undefined : process.env[API_KEY_ENV]?.trim());
      const canRestore = !apiKey || apiKey === PUBLIC_API_KEY;
      if (context.stored) {
        const compatible = context.stored.models.filter(
          (model): model is Model<"openai-completions"> =>
            model.provider === PROVIDER_ID &&
            model.api === PROVIDER_API &&
            model.baseUrl === baseUrl,
        );
        const storedMatches =
          canRestore && compatible.length === context.stored.models.length;
        const restored = storedMatches ? compatible : [];
        if (
          !(await context.publish({
            ...(storedMatches ? {} : { persist: null }),
            update: () => {
              models = restored;
            },
          }))
        )
          return;
      } else if (
        !canRestore ||
        models.some((model) => model.baseUrl !== baseUrl)
      ) {
        if (
          !(await context.publish({
            ...(canRestore ? {} : { persist: null }),
            update: () => {
              models = [];
            },
          }))
        )
          return;
      }

      if (!context.allowNetwork || context.signal.aborted || !apiKey) return;
      const catalog = await fetchModelCatalog(
        { baseUrl },
        apiKey,
        context.signal,
      );
      if (context.signal.aborted) return;
      const refreshed = normalizeModels(PROVIDER_ID, baseUrl, catalog);
      await context.publish({
        persist: canRestore
          ? { models: refreshed, checkedAt: Date.now() }
          : null,
        update: () => {
          models = refreshed;
        },
      });
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
  const signal = AbortSignal.timeout(60_000);
  const result = await ctx.modelRegistry.refresh({
    providers: [PROVIDER_ID],
    force: true,
    signal,
  });
  if (result.aborted) {
    ctx.ui.notify("OmniRoute model sync timed out.", "warning");
    return;
  }
  const error = result.errors.get(PROVIDER_ID);
  if (error) throw error;
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
      return ["status", "sync", "help"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
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
