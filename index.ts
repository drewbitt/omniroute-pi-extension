import { createHash } from "node:crypto";
import type {
  Api,
  ApiKeyCredential,
  Model,
  Provider,
  RefreshModelsContext,
  StreamOptions,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  API_KEY_ENV,
  BASE_URL_ENV,
  createOmniRouteAuth,
  DEFAULT_BASE_URL,
  fetchModelCatalog,
  fetchPricingTable,
  PUBLIC_API_KEY,
  resolveConfiguredBaseUrl,
} from "./src/gateway-catalog.ts";
import {
  type NormalizeOptions,
  normalizeModels,
} from "./src/model-normalizer.ts";
import { applyPricingTable, parsePricingTable } from "./src/pricing-merge.ts";

export const PROVIDER_ID = "omniroute";
const PROVIDER_NAME = "OmniRoute";
const PROVIDER_API = "openai-completions" as const;

/**
 * Optional per-request gateway controls, read from the environment at call
 * time. Ambient environment values are already trusted provider configuration
 * here (see `OMNIROUTE_BASE_URL`/`OMNIROUTE_API_KEY`), so these stay out of
 * any stored or persisted state.
 *
 * Each one maps 1:1 onto a documented OmniRoute request header and defaults
 * to absent, so an unconfigured user sends exactly the bytes they send today.
 * `x-omniroute-no-memory` drops the gateway's memory + skills injection (it
 * costs tokens per call and duplicates what pi already provides), and
 * `x-omniroute-compression` overrides the prompt-compression plan. The gateway
 * echoes the applied plan back as `X-OmniRoute-Compression`.
 */
const NO_MEMORY_ENV = "OMNIROUTE_NO_MEMORY";
const NO_CACHE_ENV = "OMNIROUTE_NO_CACHE";
const COMPRESSION_ENV = "OMNIROUTE_COMPRESSION";
const STRICT_TOOLS_ENV = "OMNIROUTE_STRICT_TOOLS";

// Header-safe plan value: `off`, `default`, `engine:<id>`, or a combo id/name.
const COMPRESSION_PLAN = /^[A-Za-z0-9._:-]+$/;

function enabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function gatewayRequestHeaders(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  const plan = env[COMPRESSION_ENV]?.trim();
  const entries: Array<readonly [string, string]> = [];
  if (enabled(env[NO_MEMORY_ENV]))
    entries.push(["x-omniroute-no-memory", "true"]);
  if (enabled(env[NO_CACHE_ENV]))
    entries.push(["X-OmniRoute-No-Cache", "true"]);
  if (plan && COMPRESSION_PLAN.test(plan))
    entries.push(["x-omniroute-compression", plan]);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeOptions(
  env: NodeJS.ProcessEnv = process.env,
): NormalizeOptions {
  return { strictTools: enabled(env[STRICT_TOOLS_ENV]) };
}

// Explicit caller headers win, matching pi-ai's own "options headers last"
// merge. Returns the original object when nothing is configured, so the
// default path allocates nothing.
function withGatewayHeaders(
  options: StreamOptions | undefined,
): StreamOptions | undefined {
  const extra = gatewayRequestHeaders();
  if (!extra) return options;
  return { ...options, headers: { ...extra, ...options?.headers } };
}

function catalogScope(baseUrl: string, apiKey: string): string {
  return createHash("sha256")
    .update(baseUrl)
    .update("\0")
    .update(apiKey)
    .digest("base64url");
}

type CatalogState = {
  models: readonly Model<"openai-completions">[];
  scope: string | undefined;
};

const EMPTY_CATALOG: CatalogState = { models: [], scope: undefined };

type ApplyCatalog = (state: CatalogState) => void;

/**
 * Stored key, then the ambient runtime override, then the placeholder.
 */
function resolveApiKey(credential?: ApiKeyCredential): string {
  const explicit =
    credential?.key?.trim() ||
    (credential ? undefined : process.env[API_KEY_ENV]?.trim());
  return explicit || PUBLIC_API_KEY;
}

/**
 * Stored rows that describe this exact endpoint. Returns undefined when any
 * row belongs elsewhere, so a foreign or mixed snapshot is discarded as a
 * whole instead of partially restored: an endpoint change must never surface
 * another endpoint's models, including offline.
 */
function storedCatalogFor(
  stored: readonly Model<Api>[],
  baseUrl: string,
): readonly Model<"openai-completions">[] | undefined {
  const compatible = stored.filter(
    (model): model is Model<"openai-completions"> =>
      model.provider === PROVIDER_ID &&
      model.api === PROVIDER_API &&
      model.baseUrl === baseUrl,
  );
  return compatible.length === stored.length ? compatible : undefined;
}

// Publication helpers. Pi runs `update` synchronously only after the selected
// persistence mutation, so each helper names exactly one decision: keep storage,
// delete it, or write a snapshot.
function publishKeep(
  context: RefreshModelsContext,
  apply: ApplyCatalog,
  state: CatalogState,
): Promise<boolean> {
  return context.publish({ update: () => apply(state) });
}

function publishDelete(
  context: RefreshModelsContext,
  apply: ApplyCatalog,
  state: CatalogState,
): Promise<boolean> {
  return context.publish({ persist: null, update: () => apply(state) });
}

function publishSnapshot(
  context: RefreshModelsContext,
  apply: ApplyCatalog,
  state: CatalogState,
): Promise<boolean> {
  return context.publish({
    persist: { models: state.models, checkedAt: Date.now() },
    update: () => apply(state),
  });
}

/**
 * Fetch and normalize the live catalog. Pricing enrichment is best-effort and
 * never blocks discovery. A cancellation that lands between the awaits returns
 * undefined so the refresh publishes nothing; an abort during a fetch still
 * rejects, which is how Pi learns the refresh was cancelled.
 */
async function discoverCatalog(
  baseUrl: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<readonly Model<"openai-completions">[] | undefined> {
  const catalog = await fetchModelCatalog({ baseUrl }, apiKey, signal);
  if (signal.aborted) return undefined;
  const pricingPayload = await fetchPricingTable({ baseUrl }, apiKey, signal);
  if (signal.aborted) return undefined;
  const enriched = applyPricingTable(
    catalog,
    parsePricingTable(pricingPayload),
  );
  return normalizeModels(PROVIDER_ID, baseUrl, enriched, normalizeOptions());
}

export function createOmniRouteProvider(): Provider<"openai-completions"> {
  let models: readonly Model<"openai-completions">[] = [];
  let activeScope: string | undefined;
  const streams = openAICompletionsApi();
  // The catalog state is only ever written through here, so every publication
  // below applies one atomic change instead of two independent assignments.
  const setCatalog: ApplyCatalog = (next) => {
    models = next.models;
    activeScope = next.scope;
  };

  return {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    baseUrl: DEFAULT_BASE_URL,
    auth: { apiKey: createOmniRouteAuth() },
    getModels: () => models,
    async refreshModels(context) {
      const credential =
        context.credential?.type === "api_key" ? context.credential : undefined;
      const baseUrl = await resolveConfiguredBaseUrl(
        credential,
        (name) => process.env[name],
      );
      if (!baseUrl) {
        // No configured endpoint: drop the catalog and its snapshot, so a
        // removed or invalid server URL cannot leave stale models behind.
        if (context.stored || models.length > 0)
          await publishDelete(context, setCatalog, EMPTY_CATALOG);
        return;
      }

      const apiKey = resolveApiKey(credential);
      // The catalog holds only model metadata; the API key lives in auth.json.
      // Always persist so cache-only one-shot mode (subagents) can restore models offline.
      const requestedScope = catalogScope(baseUrl, apiKey);
      if (context.stored) {
        // Endpoint-scoped restore; a mismatched snapshot is deleted, not merged.
        const restored = storedCatalogFor(context.stored.models, baseUrl);
        const published = restored
          ? await publishKeep(context, setCatalog, {
              models: restored,
              scope: requestedScope,
            })
          : await publishDelete(context, setCatalog, EMPTY_CATALOG);
        if (!published) return;
      } else if (activeScope !== requestedScope) {
        // No snapshot to restore and the credential scope moved: drop models
        // that describe a different endpoint or key before any network access,
        // so a cache-only start cannot advertise them.
        if (!(await publishKeep(context, setCatalog, EMPTY_CATALOG))) return;
      }

      if (!context.allowNetwork || context.signal.aborted) return;
      const refreshed = await discoverCatalog(baseUrl, apiKey, context.signal);
      // Nothing to publish when the cancellation landed after a fetch resolved.
      // A rejected publication (superseded generation) also ends the refresh:
      // unlike the restore path above there is no fallback state to apply.
      if (!refreshed) return;
      await publishSnapshot(context, setCatalog, {
        models: refreshed,
        scope: requestedScope,
      });
    },
    stream: (model, context, options) =>
      streams.stream(model, context, withGatewayHeaders(options)),
    streamSimple: (model, context, options) =>
      streams.streamSimple(model, context, withGatewayHeaders(options)),
  };
}

// Footer chip, shown only while the active model comes from OmniRoute.
// Anything else keeps the footer clear.
type StatusContext = Pick<ExtensionCommandContext, "modelRegistry" | "ui">;

function setStatus(ctx: StatusContext, providerId: string | undefined): void {
  const count =
    ctx.modelRegistry.getProvider(PROVIDER_ID)?.getModels().length ?? 0;
  if (providerId !== PROVIDER_ID || !count) {
    ctx.ui.setStatus(PROVIDER_ID, undefined);
    return;
  }
  ctx.ui.setStatus(PROVIDER_ID, `${PROVIDER_NAME}: ${count.toLocaleString()}`);
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
  const existing = ctx.modelRegistry.getProvider(PROVIDER_ID)?.getModels();
  const existingCount = existing?.length ?? 0;
  const beforeIds = new Set(existing?.map((model) => model.id) ?? []);
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
  const after = ctx.modelRegistry.getProvider(PROVIDER_ID)?.getModels() ?? [];
  const added = after.filter((model) => !beforeIds.has(model.id)).length;
  const afterIds = new Set(after.map((model) => model.id));
  const removed = [...beforeIds].filter((id) => !afterIds.has(id)).length;
  const parts: string[] = [];
  if (added) parts.push(`+${added} new`);
  if (removed) parts.push(`-${removed} removed`);
  const delta = parts.length ? ` (${parts.join(", ")})` : "";
  ctx.ui.notify(
    `OmniRoute synced ${after.length.toLocaleString()} model${
      after.length === 1 ? "" : "s"
    }${delta}.`,
    "info",
  );
  setStatus(ctx, ctx.model?.provider);
}

export default function omniRouteExtension(pi: ExtensionAPI): void {
  pi.registerProvider(createOmniRouteProvider());
  pi.on("session_start", async (_event, ctx) => {
    const auth = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
    if (!auth) {
      const count =
        ctx.modelRegistry.getProvider(PROVIDER_ID)?.getModels().length ?? 0;
      if (!count) {
        ctx.ui.notify(
          `OmniRoute detected but not configured. Run /login ${PROVIDER_ID} or /omni help.`,
          "info",
        );
      }
      return;
    }
    setStatus(ctx, ctx.model?.provider);
  });
  pi.on("model_select", (event, ctx) => {
    setStatus(ctx, event.model.provider);
  });
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
