import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  createModels,
  InMemoryModelsStore,
  type Provider,
  type ProviderModelsStore,
  type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";

type CatalogKind = "primary" | "supplemental";

type CatalogOptions = {
  body?: string;
  status?: number;
  statusText?: string;
  hold?: boolean;
  delayMs?: number;
};

interface FixtureServer {
  readonly baseUrl: string;
  readonly primaryRequests: number;
  readonly supplementalRequests: number;
  readonly primaryAborts: number;
  readonly supplementalAborts: number;
  readonly primarySearch: string;
  release(kind: CatalogKind): void;
  set(kind: CatalogKind, options: CatalogOptions): void;
  waitFor(predicate: () => boolean, message: string): Promise<void>;
  close(): Promise<void>;
}

function data(models: unknown[]) {
  return JSON.stringify({ data: models });
}

function primaryRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    root: id.split("/").slice(-1)[0],
    input_modalities: ["text"],
    output_modalities: ["text"],
    context_length: 8192,
    max_output_tokens: 1024,
    ...overrides,
  };
}

function supplementalRow(id: string, efforts: string[], overrides: Record<string, unknown> = {}) {
  return { id, root: id.split("/").slice(-1)[0], supportedReasoningEfforts: efforts, ...overrides };
}

async function createFixtureServer(options: {
  primary?: CatalogOptions;
  supplemental?: CatalogOptions;
} = {}): Promise<FixtureServer> {
  const config: Record<CatalogKind, Required<CatalogOptions>> = {
    primary: {
      body: options.primary?.body ?? data([]),
      status: options.primary?.status ?? 200,
      statusText: options.primary?.statusText ?? "OK",
      hold: options.primary?.hold ?? false,
      delayMs: options.primary?.delayMs ?? 0,
    },
    supplemental: {
      body: options.supplemental?.body ?? data([]),
      status: options.supplemental?.status ?? 200,
      statusText: options.supplemental?.statusText ?? "OK",
      hold: options.supplemental?.hold ?? false,
      delayMs: options.supplemental?.delayMs ?? 0,
    },
  };
  const requests: Record<CatalogKind, number> = { primary: 0, supplemental: 0 };
  const aborts: Record<CatalogKind, number> = { primary: 0, supplemental: 0 };
  let primarySearch = "";
  const held: Record<CatalogKind, Array<() => void>> = { primary: [], supplemental: [] };
  const waiters: Array<() => void> = [];
  const notify = () => waiters.splice(0).forEach((wake) => wake());

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const kind: CatalogKind | undefined = url.pathname.includes("/vscode/_/models")
      ? "supplemental"
      : url.pathname.endsWith("/models")
        ? "primary"
        : undefined;
    if (!kind) {
      response.writeHead(404).end();
      return;
    }

    requests[kind] += 1;
    if (kind === "primary") primarySearch = url.search;
    notify();
    let settled = false;
    const markAborted = () => {
      if (settled || response.writableEnded) return;
      settled = true;
      aborts[kind] += 1;
      notify();
      response.destroy();
    };
    const send = () => {
      if (settled || response.writableEnded) return;
      settled = true;
      response.writeHead(config[kind].status, config[kind].statusText, { "content-type": "application/json" });
      response.end(config[kind].body);
      notify();
    };
    request.once("aborted", markAborted);
    response.once("close", () => {
      if (!response.writableEnded) markAborted();
    });
    if (config[kind].hold) {
      held[kind].push(send);
    } else if (config[kind].delayMs > 0) {
      setTimeout(send, config[kind].delayMs);
    } else {
      send();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    get primaryRequests() {
      return requests.primary;
    },
    get supplementalRequests() {
      return requests.supplemental;
    },
    get primaryAborts() {
      return aborts.primary;
    },
    get supplementalAborts() {
      return aborts.supplemental;
    },
    get primarySearch() {
      return primarySearch;
    },
    release(kind) {
      config[kind].hold = false;
      held[kind].splice(0).forEach((send) => send());
    },
    set(kind, next) {
      config[kind] = { ...config[kind], ...next };
    },
    waitFor(predicate, message) {
      if (predicate()) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), 1000);
        const check = () => {
          if (!predicate()) {
            waiters.push(check);
            return;
          }
          clearTimeout(timer);
          resolve();
        };
        waiters.push(check);
      });
    },
    close() {
      held.primary.splice(0);
      held.supplemental.splice(0);
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
        server.closeAllConnections();
      });
    },
  };
}

function captureProvider(baseUrl: string): Provider<"openai-responses"> {
  process.env.OMNIROUTE_BASE_URL = baseUrl;
  let registered: Provider<"openai-responses"> | undefined;
  extension({
    registerProvider(provider: Provider<"openai-responses">) {
      registered = provider;
    },
  } as unknown as ExtensionAPI);
  assert.ok(registered, "extension must use complete registerProvider(provider) registration");
  return registered;
}

function scopedStore(store: InMemoryModelsStore): ProviderModelsStore {
  return {
    read: () => store.read("omniroute"),
    write: (entry) => store.write("omniroute", entry),
    delete: () => store.delete("omniroute"),
  };
}

function refreshContext(
  store: InMemoryModelsStore,
  options: Partial<RefreshModelsContext> = {},
): RefreshModelsContext {
  return {
    credential: { type: "api_key", key: "loopback-test-key" },
    store: scopedStore(store),
    allowNetwork: true,
    ...options,
  };
}

function getModel(provider: Provider<"openai-responses">, id: string) {
  const model = provider.getModels().find((candidate) => candidate.id === id);
  assert.ok(model, `expected ${id} in provider catalog`);
  return model;
}

function assertSanitized(error: unknown, secret: string) {
  assert.ok(error instanceof Error);
  assert.doesNotMatch(error.message, new RegExp(secret));
  assert.doesNotMatch(error.message, /Authorization|Bearer|127\.0\.0\.1|SyntaxError/i);
}

const ENV_KEYS = ["OMNIROUTE_BASE_URL", "OMNIROUTE_API_KEY", "OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS"] as const;

describe("OmniRoute Pi-native dynamic provider", () => {
  let savedEnv: Record<string, string | undefined>;
  const servers: FixtureServer[] = [];

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.OMNIROUTE_API_KEY = "loopback-test-key";
    delete process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS;
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)));
  });

  it("registers one complete public Provider with Pi auth, lazy Responses API, and no initial catalog", async () => {
    const server = await createFixtureServer();
    servers.push(server);
    const provider = captureProvider(`${server.baseUrl}///`);

    assert.equal(provider.id, "omniroute");
    assert.equal(provider.name, "OmniRoute");
    assert.equal(provider.baseUrl, server.baseUrl);
    assert.equal(provider.auth.apiKey?.name, "OmniRoute API key");
    assert.equal(typeof provider.auth.apiKey?.resolve, "function");
    assert.equal(typeof provider.stream, "function");
    assert.equal(typeof provider.streamSimple, "function");
    assert.equal(typeof provider.refreshModels, "function");
    assert.deepEqual(provider.getModels(), []);
  });

  it("lets Pi resolve env credentials and own store restore, write, and offline fallback", async () => {
    const server = await createFixtureServer({
      primary: { body: data([primaryRow("vendor/store-model", { capabilities: { effort_tiers: ["medium"] } })]) },
      supplemental: { body: data([]) },
    });
    servers.push(server);
    const store = new InMemoryModelsStore();
    const first = captureProvider(server.baseUrl);
    const models = createModels({ modelsStore: store });
    models.setProvider(first);

    const online = await models.refresh({ allowNetwork: true });
    assert.equal(online.errors.size, 0);
    assert.equal(models.getModel("omniroute", "vendor/store-model")?.thinkingLevelMap?.medium, "medium");
    assert.deepEqual((await store.read("omniroute"))?.models.map((model) => model.id), ["vendor/store-model"]);

    const restored = captureProvider(server.baseUrl);
    const offline = createModels({ modelsStore: store });
    offline.setProvider(restored);
    const result = await offline.refresh({ allowNetwork: false });
    assert.equal(result.errors.size, 0);
    assert.equal(offline.getModel("omniroute", "vendor/store-model")?.baseUrl, server.baseUrl);
    assert.equal(server.primaryRequests, 1, "offline restore must not rediscover");
  });

  it("uses createProvider's public in-flight refresh deduplication", async () => {
    const server = await createFixtureServer({
      primary: { hold: true, body: data([primaryRow("vendor/dedup")]) },
      supplemental: { hold: true, body: data([]) },
    });
    servers.push(server);
    const provider = captureProvider(server.baseUrl);
    const store = new InMemoryModelsStore();
    const context = refreshContext(store);
    const first = provider.refreshModels!(context);
    const second = provider.refreshModels!(context);
    await server.waitFor(() => server.primaryRequests === 1 && server.supplementalRequests === 1, "one refresh should start both requests");
    server.release("primary");
    server.release("supplemental");
    await Promise.all([first, second]);
    assert.equal(server.primaryRequests, 1);
    assert.equal(server.supplementalRequests, 1);
  });

  it("requests configured alias routes and prefers a distinct friendly name", async () => {
    const server = await createFixtureServer({
      primary: {
        body: data([
          primaryRow("cx/gpt-5.6-luna", { name: "  GPT-5.6 Luna  ", root: "gpt-5.6-luna" }),
          primaryRow("cx/root-fallback", { name: "  cx/root-fallback  ", root: "root-fallback" }),
          primaryRow("cx/blank-name", { name: "   ", root: "blank-name" }),
          primaryRow("cx/id-fallback", { name: null, root: null }),
        ]),
      },
      supplemental: { body: data([]) },
    });
    servers.push(server);
    const provider = captureProvider(server.baseUrl);
    await provider.refreshModels!(refreshContext(new InMemoryModelsStore()));

    assert.equal(server.primarySearch, "?prefix=alias&configuredOnly=true");
    assert.equal(getModel(provider, "cx/gpt-5.6-luna").name, "GPT-5.6 Luna");
    assert.equal(getModel(provider, "cx/root-fallback").name, "root-fallback");
    assert.equal(getModel(provider, "cx/blank-name").name, "blank-name");
    assert.equal(getModel(provider, "cx/id-fallback").name, "cx/id-fallback");
  });


  it("namespaces persisted combos while preserving auto and provider route IDs", async () => {
    const server = await createFixtureServer({
      primary: {
        body: data([
          primaryRow("gpt-5.6-sol", { owned_by: "combo" }),
          primaryRow("auto/best-coding", { owned_by: "combo" }),
          primaryRow("cx/gpt-5.6-sol", { owned_by: "codex" }),
        ]),
      },
      supplemental: { body: data([]) },
    });
    servers.push(server);
    const provider = captureProvider(server.baseUrl);
    await provider.refreshModels!(refreshContext(new InMemoryModelsStore()));

    assert.deepEqual(provider.getModels().map((model) => model.id), [
      "auto/best-coding",
      "combo/gpt-5.6-sol",
      "cx/gpt-5.6-sol",
    ]);
  });

  it("atomically merges primary tiers, exact-base suffixes, and strict supplemental matches", async () => {
    const server = await createFixtureServer({
      primary: {
        body: data([
          primaryRow("vendor/union", { capabilities: { effort_tiers: ["none", "low"] }, context_length: 16384 }),
          primaryRow("vendor/union-xhigh"),
        ]),
      },
      supplemental: { body: data([supplementalRow("vendor/union", ["high", "max", "ultra"])]) },
    });
    servers.push(server);
    const provider = captureProvider(server.baseUrl);
    await provider.refreshModels!(refreshContext(new InMemoryModelsStore()));

    assert.deepEqual(provider.getModels().map((model) => model.id), ["vendor/union"]);
    const model = getModel(provider, "vendor/union");
    assert.equal(model.api, "openai-responses");
    assert.equal(model.provider, "omniroute");
    assert.equal(model.baseUrl, server.baseUrl);
    assert.equal(model.contextWindow, 16384);
    assert.equal(model.maxTokens, 1024);
    assert.equal(model.thinkingLevelMap?.low, "low");
    assert.equal(model.thinkingLevelMap?.high, "high");
    assert.equal(model.thinkingLevelMap?.xhigh, "xhigh");
    assert.equal(model.thinkingLevelMap?.max, "max");
    assert.equal((model.thinkingLevelMap as Record<string, unknown>).ultra, undefined);
  });

  it("publishes GLM-5.2 reasoning from a metadata-driven loopback fixture, not a live gateway claim", async () => {
    const glmPrimary = primaryRow("ollamacloud/glm-5.2", {
      root: "glm-5.2",
      context_length: 976000,
      max_output_tokens: 131072,
      capabilities: { reasoning: true, thinking: true },
    });
    const exactSupplemental = {
      id: "ollama-cloud/glm-5.2",
      root: "glm-5.2",
      parent: "ollamacloud/glm-5.2",
      supportedReasoningEfforts: ["low", "medium", "high"],
    };
    const supported = await createFixtureServer({
      primary: { body: data([glmPrimary]) },
      supplemental: { body: data([exactSupplemental]) },
    });
    servers.push(supported);
    const provider = captureProvider(supported.baseUrl);
    await provider.refreshModels!(refreshContext(new InMemoryModelsStore()));

    const glm = getModel(provider, "ollamacloud/glm-5.2");
    assert.equal(glm.reasoning, true);
    assert.deepEqual(glm.thinkingLevelMap, {
      off: null,
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
    });
    assert.equal(glm.contextWindow, 976000);
    assert.equal(glm.maxTokens, 131072);

    const unsupported = await createFixtureServer({
      primary: { body: data([glmPrimary]) },
      supplemental: { body: data([{ ...exactSupplemental, supportedReasoningEfforts: ["none", "unknown"] }]) },
    });
    servers.push(unsupported);
    const negativeProvider = captureProvider(unsupported.baseUrl);
    await negativeProvider.refreshModels!(refreshContext(new InMemoryModelsStore()));
    const unsupportedGlm = getModel(negativeProvider, "ollamacloud/glm-5.2");
    assert.equal(unsupportedGlm.reasoning, false);
    assert.equal(unsupportedGlm.thinkingLevelMap, undefined);
  });

  it("uses supplemental root matching only when the contributing root is unique and fails closed for none-only data", async () => {
    const server = await createFixtureServer({
      primary: {
        body: data([
          primaryRow("vendor/root-fallback", { root: "unique-root" }),
          primaryRow("vendor/none", { capabilities: { effort_tiers: ["none"] } }),
        ]),
      },
      supplemental: {
        body: data([
          { id: "different-id", root: "unique-root", supportedReasoningEfforts: ["high"] },
          supplementalRow("vendor/none", ["ultra"]),
        ]),
      },
    });
    servers.push(server);
    const provider = captureProvider(server.baseUrl);
    await provider.refreshModels!(refreshContext(new InMemoryModelsStore()));

    assert.equal(getModel(provider, "vendor/root-fallback").thinkingLevelMap?.high, "high");
    const none = getModel(provider, "vendor/none");
    assert.equal(none.reasoning, false);
    assert.equal(none.thinkingLevelMap, undefined);
  });

  it("folds GPT-5.6 alias efforts while omitting exact canonical mirrors and image-only bare IDs", async () => {
    const families = ["luna", "sol", "terra"];
    const efforts = ["low", "medium", "high", "xhigh", "max"];
    const primary = families.flatMap((family) => {
      const model = `gpt-5.6-${family}`;
      return [
        primaryRow(`cx/${model}`),
        primaryRow(`codex/${model}`, { type: "image", output_modalities: ["image"] }),
        ...efforts.flatMap((effort) => [
          primaryRow(`cx/${model}-${effort}`),
          primaryRow(`codex/${model}-${effort}`, { parent: `cx/${model}-${effort}` }),
        ]),
      ];
    });
    const server = await createFixtureServer({
      primary: { body: data(primary) },
      supplemental: { body: data([]) },
    });
    servers.push(server);
    const provider = captureProvider(server.baseUrl);
    await provider.refreshModels!(refreshContext(new InMemoryModelsStore()));

    assert.deepEqual(provider.getModels().map((model) => model.id), families.map((family) => `cx/gpt-5.6-${family}`));
    for (const family of families) {
      const base = getModel(provider, `cx/gpt-5.6-${family}`);
      assert.deepEqual(base.thinkingLevelMap, {
        off: null,
        minimal: "low",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      });
      assert.equal(provider.getModels().some((model) => model.id.startsWith(`codex/gpt-5.6-${family}`)), false);
    }
  });

  it("suppresses exact provider-mirror chains independently of catalog order", async () => {
    const rows = [
      primaryRow("provider-a/model-high", { parent: "provider-b/model-high" }),
      primaryRow("provider-b/model-high", { parent: "provider-c/model-high" }),
      primaryRow("provider-c/model-high"),
    ];
    for (const primary of [rows, [...rows].reverse()]) {
      const server = await createFixtureServer({
        primary: { body: data(primary) },
        supplemental: { body: data([]) },
      });
      servers.push(server);
      const provider = captureProvider(server.baseUrl);
      await provider.refreshModels!(refreshContext(new InMemoryModelsStore()));

      assert.deepEqual(provider.getModels().map((model) => model.id), ["provider-c/model-high"]);
    }
  });

  it("preserves non-family suffix routes unless an exact conversational alias parent exists", async () => {
    const server = await createFixtureServer({
      primary: {
        body: data([
          primaryRow("alias/reasoner-high", { type: "image", output_modalities: ["image"] }),
          primaryRow("canonical/reasoner-high", { parent: "alias/reasoner-high" }),
          primaryRow("canonical/other-high", { parent: "alias/other-high" }),
          primaryRow("canonical/mismatch-high", { parent: "alias/mismatch-medium" }),
        ]),
      },
      supplemental: { body: data([]) },
    });
    servers.push(server);
    const provider = captureProvider(server.baseUrl);
    await provider.refreshModels!(refreshContext(new InMemoryModelsStore()));

    assert.deepEqual(provider.getModels().map((model) => model.id), [
      "canonical/mismatch-high",
      "canonical/other-high",
      "canonical/reasoner-high",
    ]);
  });

  it("filters non-chat rows, deduplicates surviving IDs, applies token defaults, and excludes only the four exact ultra aliases", async () => {
    const server = await createFixtureServer({
      primary: {
        body: data([
          primaryRow("vendor/chat", { context_length: undefined, max_output_tokens: undefined }),
          primaryRow("vendor/chat", { type: "image", output_modalities: ["image"] }),
          primaryRow("vendor/embedding", { type: "embedding" }),
          primaryRow("codex/gpt-5.6-sol-ultra"),
          primaryRow("cx/gpt-5.6-sol-ultra"),
          primaryRow("codex/gpt-5.6-terra-ultra"),
          primaryRow("cx/gpt-5.6-terra-ultra"),
          primaryRow("openai/gpt-5.6-sol-ultra", { capabilities: { effort_tiers: ["high"] } }),
        ]),
      },
      supplemental: { body: data([]) },
    });
    servers.push(server);
    const provider = captureProvider(server.baseUrl);
    await provider.refreshModels!(refreshContext(new InMemoryModelsStore()));

    assert.deepEqual(provider.getModels().map((model) => model.id), ["openai/gpt-5.6-sol-ultra", "vendor/chat"]);
    const chat = getModel(provider, "vendor/chat");
    assert.equal(chat.contextWindow, 128000);
    assert.equal(chat.maxTokens, 16384);
    assert.equal(getModel(provider, "openai/gpt-5.6-sol-ultra").thinkingLevelMap?.high, "high");
  });

  it("folds provider-independent GPT-5.6 effort rows into a compatible base when the catalog omits it", async () => {
    const families = ["luna", "sol", "terra"];
    const efforts = ["low", "medium", "high", "xhigh", "max"];
    const server = await createFixtureServer({
      primary: {
        body: data(families.flatMap((family) =>
          efforts.map((effort) => primaryRow(`dva/gpt-5-6-${family}-${effort}`))
        )),
      },
      supplemental: { body: data([]) },
    });
    servers.push(server);
    const provider = captureProvider(server.baseUrl);
    await provider.refreshModels!(refreshContext(new InMemoryModelsStore()));

    assert.deepEqual(provider.getModels().map((model) => model.id), families.map((family) => `dva/gpt-5-6-${family}`));
    for (const family of families) {
      assert.deepEqual(getModel(provider, `dva/gpt-5-6-${family}`).thinkingLevelMap, {
        off: null,
        minimal: "low",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      });
    }
  });

  it("does not synthesize missing bases outside the GPT-5.6 model family", async () => {
    const server = await createFixtureServer({
      primary: {
        body: data([
          primaryRow("vendor/gpt-5.5-mini-high"),
          primaryRow("vendor/reasoner-high"),
          primaryRow("vendor/gpt-5.6-preview-ultra"),
        ]),
      },
      supplemental: { body: data([]) },
    });
    servers.push(server);
    const provider = captureProvider(server.baseUrl);
    await provider.refreshModels!(refreshContext(new InMemoryModelsStore()));

    assert.deepEqual(provider.getModels().map((model) => model.id), [
      "vendor/gpt-5.5-mini-high",
      "vendor/gpt-5.6-preview-ultra",
      "vendor/reasoner-high",
    ]);
  });

  it("does not treat model-family mini or ordinary ultra suffixes as reasoning efforts", async () => {
    const server = await createFixtureServer({
      primary: {
        body: data([
          primaryRow("vendor/gpt-5.5"),
          primaryRow("vendor/gpt-5.5-mini"),
          primaryRow("vendor/reasoner"),
          primaryRow("vendor/reasoner-ultra"),
        ]),
      },
      supplemental: { body: data([]) },
    });
    servers.push(server);
    const provider = captureProvider(server.baseUrl);
    await provider.refreshModels!(refreshContext(new InMemoryModelsStore()));

    assert.deepEqual(provider.getModels().map((model) => model.id), [
      "vendor/gpt-5.5",
      "vendor/gpt-5.5-mini",
      "vendor/reasoner",
      "vendor/reasoner-ultra",
    ]);
    assert.equal(getModel(provider, "vendor/gpt-5.5").thinkingLevelMap, undefined);
    assert.equal(getModel(provider, "vendor/reasoner").thinkingLevelMap, undefined);
  });

  it("folds an exact -max variant, keeps unrelated ultra IDs, and lets Pi restore only normalized models", async () => {
    const server = await createFixtureServer({
      primary: {
        body: data([
          primaryRow("vendor/reasoner"),
          primaryRow("vendor/reasoner-max"),
          primaryRow("codex/another-ultra"),
          primaryRow("cx/gpt-5.6-terra-ultra"),
        ]),
      },
      supplemental: { body: data([]) },
    });
    servers.push(server);
    const store = new InMemoryModelsStore();
    const online = createModels({ modelsStore: store });
    online.setProvider(captureProvider(server.baseUrl));
    assert.equal((await online.refresh({ allowNetwork: true })).errors.size, 0);
    assert.deepEqual(online.getModels("omniroute").map((model) => model.id), ["codex/another-ultra", "vendor/reasoner"]);
    assert.equal(online.getModel("omniroute", "vendor/reasoner")?.thinkingLevelMap?.max, "max");

    const offline = createModels({ modelsStore: store });
    offline.setProvider(captureProvider(server.baseUrl));
    assert.equal((await offline.refresh({ allowNetwork: false })).errors.size, 0);
    assert.deepEqual(offline.getModels("omniroute").map((model) => model.id), ["codex/another-ultra", "vendor/reasoner"]);
    assert.equal(offline.getModel("omniroute", "cx/gpt-5.6-terra-ultra"), undefined);
  });

  it("publishes a valid empty dual-success snapshot instead of retaining restored models", async () => {
    const server = await createFixtureServer({ primary: { body: data([]) }, supplemental: { body: data([]) } });
    servers.push(server);
    const store = new InMemoryModelsStore();
    await store.write("omniroute", {
      models: [
        {
          id: "stale",
          name: "Stale",
          provider: "omniroute",
          api: "openai-responses",
          baseUrl: server.baseUrl,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1000,
          maxTokens: 100,
        },
      ],
    });
    const provider = captureProvider(server.baseUrl);
    await provider.refreshModels!(refreshContext(store));
    assert.deepEqual(provider.getModels(), []);
    assert.deepEqual((await store.read("omniroute"))?.models, []);
  });

  it("cancels a held sibling and preserves Pi's restored snapshot after sanitized HTTP failure", async () => {
    const secret = "supplemental-secret";
    const server = await createFixtureServer({
      primary: { hold: true, body: data([primaryRow("never-publish")]) },
      supplemental: { status: 503, statusText: `denied ${secret}`, body: JSON.stringify({ error: secret }) },
    });
    servers.push(server);
    const store = new InMemoryModelsStore();
    const provider = captureProvider(server.baseUrl);

    await assert.rejects(provider.refreshModels!(refreshContext(store)), (error) => {
      assertSanitized(error, secret);
      assert.match((error as Error).message, /HTTP 503/);
      return true;
    });
    await server.waitFor(() => server.primaryAborts === 1, "supplemental failure must cancel primary");
    assert.equal((await store.read("omniroute")), undefined);
  });

  it("rejects JSON, envelope, and row-shape failures without leaking input or publishing a partial snapshot", async () => {
    const secret = "invalid-json-secret";
    const cases: Array<{ primary: CatalogOptions; supplemental: CatalogOptions }> = [
      { primary: { body: `{not-json ${secret}` }, supplemental: { body: data([]) } },
      { primary: { body: JSON.stringify({ models: [] }) }, supplemental: { body: data([]) } },
      { primary: { body: data([{ id: 42 }]) }, supplemental: { body: data([]) } },
      { primary: { body: data([primaryRow("valid")]) }, supplemental: { body: data([{ root: 42 }]) } },
    ];
    for (const options of cases) {
      const server = await createFixtureServer(options);
      servers.push(server);
      const store = new InMemoryModelsStore();
      const provider = captureProvider(server.baseUrl);
      await assert.rejects(provider.refreshModels!(refreshContext(store)), (error) => {
        assertSanitized(error, secret);
        assert.equal((error as Error).message, "Model discovery failed with HTTP 200: invalid response body");
        return true;
      });
      assert.equal((await store.read("omniroute")), undefined);
    }
  });

  it("does not impose a plugin-owned discovery timeout; only Pi's parent signal is the deadline", async () => {
    // Legacy env must have no runtime effect after timeout removal.
    process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS = "25";
    const server = await createFixtureServer({
      primary: { delayMs: 80, body: data([primaryRow("slow-but-ok")]) },
      supplemental: { delayMs: 80, body: data([]) },
    });
    servers.push(server);
    const store = new InMemoryModelsStore();
    const provider = captureProvider(server.baseUrl);
    await provider.refreshModels!(refreshContext(store));
    assert.deepEqual(provider.getModels().map((model) => model.id), ["slow-but-ok"]);
    assert.deepEqual((await store.read("omniroute"))?.models.map((model) => model.id), ["slow-but-ok"]);
  });

  it("honors parent abort strictly without a store write", async () => {
    const server = await createFixtureServer({
      primary: { hold: true, body: data([primaryRow("aborted")]) },
      supplemental: { hold: true, body: data([]) },
    });
    servers.push(server);
    const controller = new AbortController();
    const store = new InMemoryModelsStore();
    const provider = captureProvider(server.baseUrl);
    const pending = provider.refreshModels!(refreshContext(store, { signal: controller.signal }));
    await server.waitFor(() => server.primaryRequests === 1 && server.supplementalRequests === 1, "both requests must begin");
    controller.abort();
    await assert.rejects(pending, (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "AbortError");
      return true;
    });
    assert.equal((await store.read("omniroute")), undefined);
  });
});
