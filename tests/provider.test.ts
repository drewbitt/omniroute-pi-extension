import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, describe, it } from "node:test";
import { createModels, InMemoryModelsStore } from "@earendil-works/pi-ai";
import type {
  ApiKeyCredential,
  ModelsStoreEntry,
  Provider,
  RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { createOmniRouteProvider } from "../index.ts";
import {
  BASE_URL_ENV,
  createOmniRouteAuth,
  normalizeBaseUrl,
  PUBLIC_API_KEY,
} from "../src/gateway-catalog.ts";

const servers: http.Server[] = [];
const originalBaseUrl = process.env.OMNIROUTE_BASE_URL;
const originalApiKey = process.env.OMNIROUTE_API_KEY;
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
  if (originalBaseUrl === undefined) delete process.env.OMNIROUTE_BASE_URL;
  else process.env.OMNIROUTE_BASE_URL = originalBaseUrl;
  if (originalApiKey === undefined) delete process.env.OMNIROUTE_API_KEY;
  else process.env.OMNIROUTE_API_KEY = originalApiKey;
});

function row(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    input_modalities: ["text"],
    output_modalities: ["text"],
    context_length: 32_000,
    max_output_tokens: 4_000,
    ...extra,
  };
}

async function fixture(response: {
  status?: number;
  payload?: unknown;
  hold?: boolean;
  stallBody?: boolean;
}) {
  let requests = 0;
  let auth = "";
  let search = "";
  const server = http.createServer((request, reply) => {
    requests += 1;
    auth = String(request.headers.authorization ?? "");
    search = new URL(request.url ?? "/", "http://local").search;
    if (response.hold) return;
    reply.writeHead(response.status ?? 200, {
      "content-type": "application/json",
    });
    if (response.stallBody) {
      reply.write('{"data":[');
      return;
    }
    reply.end(
      typeof response.payload === "string"
        ? response.payload
        : JSON.stringify(response.payload ?? { data: [] }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    get requests() {
      return requests;
    },
    get auth() {
      return auth;
    },
    get search() {
      return search;
    },
  };
}

function credential(baseUrl: string, key = "secret"): ApiKeyCredential {
  return { type: "api_key", key, env: { [BASE_URL_ENV]: baseUrl } };
}

function refreshHarness(options: {
  credential?: ApiKeyCredential;
  stored?: ModelsStoreEntry;
  allowNetwork?: boolean;
  signal?: AbortSignal;
}) {
  let stored = options.stored;
  const context: RefreshModelsContext = {
    credential: options.credential,
    stored,
    allowNetwork: options.allowNetwork ?? true,
    signal: options.signal ?? new AbortController().signal,
    async publish(publication) {
      if (publication.persist !== undefined)
        stored = publication.persist ?? undefined;
      publication.update?.();
      return true;
    },
  };
  return {
    context,
    get stored() {
      return stored;
    },
  };
}

function ids(provider: Provider) {
  return provider.getModels().map((model) => model.id);
}

describe("OmniRoute provider", () => {
  it("normalizes root and /v1 URLs", () => {
    assert.equal(
      normalizeBaseUrl("http://localhost:20128"),
      "http://localhost:20128/v1",
    );
    assert.equal(
      normalizeBaseUrl("https://example.test/prefix/v1///"),
      "https://example.test/prefix/v1",
    );
    assert.equal(normalizeBaseUrl("ftp://example.test"), undefined);
    assert.equal(
      normalizeBaseUrl("https://user:secret@example.test"),
      undefined,
    );
  });

  it("resolves environment auth and supports native login with an optional key", async () => {
    const server = await fixture({ payload: { data: [] } });
    const auth = createOmniRouteAuth();
    const resolved = await auth.resolve!({
      ctx: {
        env: async (name) =>
          name === BASE_URL_ENV
            ? server.baseUrl
            : name === "OMNIROUTE_API_KEY"
              ? "env-key"
              : undefined,
        fileExists: async () => false,
      },
      signal: new AbortController().signal,
    });
    assert.equal(resolved?.auth.baseUrl, server.baseUrl);
    assert.equal(resolved?.auth.apiKey, "env-key");

    const answers = [server.baseUrl.replace(/\/v1$/, ""), ""];
    const loggedIn = await auth.login!({
      signal: new AbortController().signal,
      prompt: async () => answers.shift() ?? "",
      notify() {},
    });
    assert.equal(loggedIn.env?.[BASE_URL_ENV], server.baseUrl);
    assert.equal(loggedIn.key, undefined);
    assert.equal(server.auth, "Bearer omniroute-public");

    const storedWithoutKey = await auth.resolve!({
      ctx: {
        env: async (name) =>
          name === "OMNIROUTE_API_KEY" ? "ambient-secret" : undefined,
        fileExists: async () => false,
      },
      credential: {
        type: "api_key",
        env: { [BASE_URL_ENV]: server.baseUrl },
      },
      signal: new AbortController().signal,
    });
    assert.equal(storedWithoutKey?.auth.apiKey, PUBLIC_API_KEY);

    const blankEnvironmentKey = await auth.resolve!({
      ctx: {
        env: async (name) =>
          name === BASE_URL_ENV
            ? server.baseUrl
            : name === "OMNIROUTE_API_KEY"
              ? "   "
              : undefined,
        fileExists: async () => false,
      },
      signal: new AbortController().signal,
    });
    assert.equal(blankEnvironmentKey?.auth.apiKey, PUBLIC_API_KEY);
  });

  it("uses Pi credential resolution and restores a public catalog offline", async () => {
    const server = await fixture({ payload: { data: [row("pi-runtime")] } });
    process.env.OMNIROUTE_BASE_URL = server.baseUrl;
    process.env.OMNIROUTE_API_KEY = PUBLIC_API_KEY;
    const store = new InMemoryModelsStore();
    const authContext = {
      env: async (name: string) =>
        name === BASE_URL_ENV
          ? server.baseUrl
          : name === "OMNIROUTE_API_KEY"
            ? PUBLIC_API_KEY
            : undefined,
      fileExists: async () => false,
    };
    const online = createModels({ modelsStore: store, authContext });
    online.setProvider(createOmniRouteProvider());
    const onlineResult = await online.refresh({ allowNetwork: true });
    assert.equal(onlineResult.errors.size, 0);
    assert.equal(
      online.getModel("omniroute", "pi-runtime")?.baseUrl,
      server.baseUrl,
    );
    assert.equal(server.auth, `Bearer ${PUBLIC_API_KEY}`);

    const offline = createModels({ modelsStore: store, authContext });
    offline.setProvider(createOmniRouteProvider());
    const offlineResult = await offline.refresh({ allowNetwork: false });
    assert.equal(offlineResult.errors.size, 0);
    assert.equal(offline.getModel("omniroute", "pi-runtime")?.id, "pi-runtime");
    assert.equal(server.requests, 1);
  });

  it("preserves routing IDs and maps explicit catalog metadata", async () => {
    const server = await fixture({
      payload: {
        data: [
          row("gpt-5.6-sol", { owned_by: "combo" }),
          row("auto/coding", { owned_by: "combo" }),
          row("cx/gpt-5.6-sol", {
            capabilities: { reasoning: true, effort_tiers: ["low", "high"] },
          }),
          row("vision/model", {
            name: "Vision Model",
            root: "canonical/model",
            input_modalities: ["text", "image"],
            pricing: {
              input: 1.25,
              output: 5,
              cached: 0.5,
              cache_creation: 2,
            },
          }),
          row("image-only", { type: "image", output_modalities: ["image"] }),
        ],
      },
    });
    const provider = createOmniRouteProvider();
    const harness = refreshHarness({ credential: credential(server.baseUrl) });
    await provider.refreshModels!(harness.context);

    assert.deepEqual(ids(provider), [
      "auto/coding",
      "cx/gpt-5.6-sol",
      "gpt-5.6-sol",
      "vision/model",
    ]);
    assert.equal(
      provider.getModels().find((model) => model.id === "cx/gpt-5.6-sol")
        ?.thinkingLevelMap?.high,
      "high",
    );
    const vision = provider
      .getModels()
      .find((model) => model.id === "vision/model");
    assert.deepEqual(vision?.input, ["text", "image"]);
    assert.equal(vision?.name, "Vision Model");
    assert.deepEqual(vision?.cost, {
      input: 1.25,
      output: 5,
      cacheRead: 0.5,
      cacheWrite: 2,
    });
    assert.equal(server.auth, "Bearer secret");
    assert.equal(server.search, "?prefix=alias&configuredOnly=true");
    assert.equal(harness.stored, undefined);
  });

  it("filters non-chat rows and handles edge metadata", async () => {
    const server = await fixture({
      payload: {
        data: [
          row("none-only", {
            capabilities: { effort_tiers: ["none"] },
          }),
          row("non-text-output", {
            output_modalities: ["image"],
          }),
          row("capped-output", {
            context_length: 2_000,
            max_output_tokens: 8_000,
          }),
        ],
      },
    });
    const provider = createOmniRouteProvider();
    await provider.refreshModels!(
      refreshHarness({ credential: credential(server.baseUrl) }).context,
    );

    assert.deepEqual(ids(provider), ["capped-output", "none-only"]);
    assert.equal(
      provider.getModels().find((model) => model.id === "none-only")?.reasoning,
      false,
    );
    assert.equal(
      provider.getModels().find((model) => model.id === "capped-output")
        ?.maxTokens,
      2_000,
    );
  });

  it("accepts a bare-array catalog, conservative defaults, and an empty catalog", async () => {
    const server = await fixture({
      payload: [
        row("bare", {
          context_length: undefined,
          max_output_tokens: undefined,
        }),
      ],
    });
    const provider = createOmniRouteProvider();
    const first = refreshHarness({
      credential: credential(server.baseUrl, PUBLIC_API_KEY),
    });
    await provider.refreshModels!(first.context);
    assert.equal(provider.getModels()[0]?.contextWindow, 128_000);
    assert.equal(provider.getModels()[0]?.maxTokens, 16_384);

    const emptyServer = await fixture({ payload: { data: [] } });
    const empty = refreshHarness({
      credential: credential(emptyServer.baseUrl, PUBLIC_API_KEY),
      stored: first.stored,
    });
    await provider.refreshModels!(empty.context);
    assert.deepEqual(provider.getModels(), []);
  });

  it("restores only public, valid snapshots for the same endpoint", async () => {
    const server = await fixture({ payload: { data: [row("stored")] } });
    const online = createOmniRouteProvider();
    const first = refreshHarness({
      credential: credential(server.baseUrl, PUBLIC_API_KEY),
    });
    await online.refreshModels!(first.context);
    assert(first.stored);

    const restored = createOmniRouteProvider();
    await restored.refreshModels!(
      refreshHarness({
        credential: credential(server.baseUrl, PUBLIC_API_KEY),
        stored: first.stored,
        allowNetwork: false,
      }).context,
    );
    assert.deepEqual(ids(restored), ["stored"]);

    const restrictedHarness = refreshHarness({
      credential: credential(server.baseUrl, "different-secret"),
      stored: first.stored,
      allowNetwork: false,
    });
    const restricted = createOmniRouteProvider();
    await restricted.refreshModels!(restrictedHarness.context);
    assert.deepEqual(ids(restricted), []);
    assert.equal(restrictedHarness.stored, undefined);

    const switched = createOmniRouteProvider();
    await switched.refreshModels!(
      refreshHarness({
        credential: credential("https://other.test/v1", PUBLIC_API_KEY),
        stored: first.stored,
        allowNetwork: false,
      }).context,
    );
    assert.deepEqual(ids(switched), []);

    const mixed: ModelsStoreEntry = {
      models: [
        ...first.stored.models,
        { ...first.stored.models[0]!, baseUrl: "https://other.test/v1" },
      ],
      checkedAt: first.stored.checkedAt,
    };
    const corrupted = createOmniRouteProvider();
    await corrupted.refreshModels!(
      refreshHarness({
        credential: credential(server.baseUrl, PUBLIC_API_KEY),
        stored: mixed,
        allowNetwork: false,
      }).context,
    );
    assert.deepEqual(ids(corrupted), []);
  });

  it("retains restored models on HTTP failure and rejects malformed catalogs", async () => {
    const good = await fixture({ payload: { data: [row("last-known-good")] } });
    const initial = createOmniRouteProvider();
    const first = refreshHarness({
      credential: credential(good.baseUrl, PUBLIC_API_KEY),
    });
    await initial.refreshModels!(first.context);

    const failingServer = await fixture({ status: 503 });
    const storedForFailingEndpoint: ModelsStoreEntry = {
      models: first.stored!.models.map((model) => ({
        ...model,
        baseUrl: failingServer.baseUrl,
      })),
      checkedAt: first.stored!.checkedAt,
    };
    const failing = createOmniRouteProvider();
    await assert.rejects(
      failing.refreshModels!(
        refreshHarness({
          credential: credential(failingServer.baseUrl, PUBLIC_API_KEY),
          stored: storedForFailingEndpoint,
        }).context,
      ),
      /HTTP 503/,
    );
    assert.deepEqual(ids(failing), ["last-known-good"]);

    const malformed = await fixture({ payload: { models: [] } });
    await assert.rejects(
      createOmniRouteProvider().refreshModels!(
        refreshHarness({ credential: credential(malformed.baseUrl) }).context,
      ),
      /invalid catalog/,
    );

    const invalidJson = await fixture({ payload: "{" });
    await assert.rejects(
      createOmniRouteProvider().refreshModels!(
        refreshHarness({ credential: credential(invalidJson.baseUrl) }).context,
      ),
      /invalid JSON/,
    );

    const duplicate = await fixture({
      payload: { data: [row("duplicate"), row("duplicate")] },
    });
    const storedForDuplicate: ModelsStoreEntry = {
      models: first.stored!.models.map((model) => ({
        ...model,
        baseUrl: duplicate.baseUrl,
      })),
      checkedAt: first.stored!.checkedAt,
    };
    const duplicateProvider = createOmniRouteProvider();
    await assert.rejects(
      duplicateProvider.refreshModels!(
        refreshHarness({
          credential: credential(duplicate.baseUrl, PUBLIC_API_KEY),
          stored: storedForDuplicate,
        }).context,
      ),
      /duplicate model ID/,
    );
    assert.deepEqual(ids(duplicateProvider), ["last-known-good"]);
  });

  it("propagates cancellation without publishing", async () => {
    const server = await fixture({ hold: true });
    const controller = new AbortController();
    const provider = createOmniRouteProvider();
    const harness = refreshHarness({
      credential: credential(server.baseUrl),
      signal: controller.signal,
    });
    const pending = provider.refreshModels!(harness.context);
    while (server.requests === 0)
      await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort();
    await assert.rejects(
      pending,
      (error) => error instanceof Error && error.name === "AbortError",
    );
    assert.equal(harness.stored, undefined);
  });

  it("propagates cancellation while reading the response body", async () => {
    const server = await fixture({ stallBody: true });
    const controller = new AbortController();
    const provider = createOmniRouteProvider();
    const pending = provider.refreshModels!(
      refreshHarness({
        credential: credential(server.baseUrl),
        signal: controller.signal,
      }).context,
    );
    while (server.requests === 0)
      await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort();
    await assert.rejects(
      pending,
      (error) => error instanceof Error && error.name === "AbortError",
    );
  });

  it("clears stale models and storage when configuration is removed", async () => {
    const server = await fixture({ payload: { data: [row("stale")] } });
    const provider = createOmniRouteProvider();
    const populated = refreshHarness({
      credential: credential(server.baseUrl, PUBLIC_API_KEY),
    });
    await provider.refreshModels!(populated.context);
    assert(populated.stored);

    delete process.env.OMNIROUTE_BASE_URL;
    const unconfigured = refreshHarness({
      stored: populated.stored,
      allowNetwork: false,
    });
    await provider.refreshModels!(unconfigured.context);
    assert.deepEqual(ids(provider), []);
    assert.equal(unconfigured.stored, undefined);
  });
});
