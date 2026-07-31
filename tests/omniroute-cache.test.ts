import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

import extension from "../index.ts";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, "fixtures", "omniroute-models.json");
const projectRoot = resolve(__dirname, "..");

interface RegisteredProvider {
  name: string;
  config: {
    name?: string;
    baseUrl?: string;
    apiKey?: string;
    api?: string;
    models?: Array<Record<string, unknown>>;
    refreshModels?: (context: RefreshContext) => Promise<ProviderModelConfig[]>;
  };
}

interface RefreshContext {
  credential?: { type?: string; key?: string };
  store: {
    read(): Promise<{ models?: readonly unknown[]; checkedAt?: number } | undefined>;
    write(entry: { models: readonly unknown[]; checkedAt?: number }): Promise<void>;
  };
  allowNetwork: boolean;
  force?: boolean;
  signal?: AbortSignal;
}

interface ExtensionHarness {
  api: ExtensionAPI;
  registeredProviders: RegisteredProvider[];
  readonly registerProviderCalls: number;
  sessionStartHandlers: unknown[];
  sessionShutdownHandlers: unknown[];
}

interface FixtureServer {
  baseUrl: string;
  readonly requests: number;
  readonly responses: number;
  readonly supplementalRequests: number;
  readonly supplementalResponses: number;
  readonly lastModelRequestUrl: string | undefined;
  waitForRequests(target: number, message: string, timeoutMs?: number): Promise<void>;
  waitForResponses(target: number, message: string, timeoutMs?: number): Promise<void>;
  waitForSupplementalRequests(target: number, message: string, timeoutMs?: number): Promise<void>;
  releaseModelResponses(): void;
  setPrimaryStatus(status: number, body?: string, statusText?: string): void;
  setPrimaryHold(hold: boolean): void;
  setSupplementalHold(hold: boolean): void;
  setSupplementalDelayMs(ms: number): void;
  close(): Promise<void>;
}

function createHarness(): ExtensionHarness {
  const registeredProviders: RegisteredProvider[] = [];
  let registerProviderCalls = 0;
  const sessionStartHandlers: unknown[] = [];
  const sessionShutdownHandlers: unknown[] = [];

  const api = {
    on(event: string, handler: unknown) {
      if (event === "session_start") sessionStartHandlers.push(handler);
      if (event === "session_shutdown") sessionShutdownHandlers.push(handler);
    },
    registerProvider(name: string, config: RegisteredProvider["config"]) {
      registerProviderCalls += 1;
      registeredProviders.push({ name, config });
    },
  } as unknown as ExtensionAPI;

  return {
    api,
    registeredProviders,
    get registerProviderCalls() {
      return registerProviderCalls;
    },
    sessionStartHandlers,
    sessionShutdownHandlers,
  };
}

function createMemoryStore(initial?: { models?: readonly unknown[]; checkedAt?: number }) {
  let entry = initial ? structuredClone(initial) : undefined;
  const writes: Array<{ models: readonly unknown[]; checkedAt?: number }> = [];
  return {
    writes,
    store: {
      async read() {
        return entry ? structuredClone(entry) : undefined;
      },
      async write(next: { models: readonly unknown[]; checkedAt?: number }) {
        entry = structuredClone(next);
        writes.push(structuredClone(next));
      },
    },
  };
}

function createWaiterQueue() {
  const waiters: Array<() => void> = [];
  return {
    notify() {
      for (const wake of waiters.splice(0)) wake();
    },
    wait(predicate: () => boolean, message: string, timeoutMs = 2000) {
      if (predicate()) return Promise.resolve();
      return new Promise<void>((resolvePromise, reject) => {
        const started = Date.now();
        const check = () => {
          if (predicate()) {
            resolvePromise();
            return;
          }
          if (Date.now() - started > timeoutMs) {
            reject(new Error(message));
            return;
          }
          waiters.push(check);
        };
        waiters.push(check);
      });
    },
  };
}

function buildAliasOnlyFixture(fixture: string) {
  const parsed = JSON.parse(fixture) as { data?: Array<Record<string, unknown>> };
  const data = Array.isArray(parsed.data) ? parsed.data : [];
  return JSON.stringify({ data });
}

async function createFixtureServer(
  options: {
    holdPrimary?: boolean;
    holdSupplemental?: boolean;
    primaryStatus?: number;
    primaryStatusText?: string;
    primaryBody?: string;
    supplementalDelayMs?: number;
    supplementalBody?: string;
  } = {},
): Promise<FixtureServer> {
  const fixture = await readFile(fixturePath, "utf8");
  const aliasBody = buildAliasOnlyFixture(fixture);
  let requests = 0;
  let responses = 0;
  let supplementalRequests = 0;
  let supplementalResponses = 0;
  let lastModelRequestUrl: string | undefined;
  let holdPrimary = options.holdPrimary ?? false;
  let holdSupplemental = options.holdSupplemental ?? false;
  let primaryStatus = options.primaryStatus ?? 200;
  let primaryStatusText = options.primaryStatusText;
  let primaryBody = options.primaryBody ?? aliasBody;
  let supplementalDelayMs = options.supplementalDelayMs ?? 0;
  const supplementalBody =
    options.supplementalBody ??
    JSON.stringify({
      data: [
        {
          id: "codex/gpt-5.5",
          root: "gpt-5.5",
          owned_by: "codex",
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
        },
      ],
    });
  const queue = createWaiterQueue();
  const pendingPrimary: Array<() => void> = [];
  const pendingSupplemental: Array<() => void> = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    lastModelRequestUrl = req.url;

    if (path.endsWith("/models") || path.includes("/models?")) {
      // primary alias catalog
      if (url.searchParams.get("prefix") === "alias" || path.endsWith("/models")) {
        // distinguish supplemental path
      }
    }

    if (path.includes("/vscode/_/models")) {
      supplementalRequests += 1;
      queue.notify();
      const send = () => {
        supplementalResponses += 1;
        queue.notify();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(supplementalBody);
      };
      if (holdSupplemental) {
        pendingSupplemental.push(send);
        return;
      }
      if (supplementalDelayMs > 0) {
        setTimeout(send, supplementalDelayMs);
        return;
      }
      send();
      return;
    }

    if (path.endsWith("/models") || path.includes("/models")) {
      requests += 1;
      queue.notify();
      const send = () => {
        responses += 1;
        queue.notify();
        if (primaryStatusText !== undefined) {
          res.writeHead(primaryStatus, primaryStatusText, { "content-type": "application/json" });
        } else {
          res.writeHead(primaryStatus, { "content-type": "application/json" });
        }
        res.end(primaryBody);
      };
      if (holdPrimary) {
        pendingPrimary.push(send);
        return;
      }
      send();
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind fixture server");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  return {
    baseUrl,
    get requests() {
      return requests;
    },
    get responses() {
      return responses;
    },
    get supplementalRequests() {
      return supplementalRequests;
    },
    get supplementalResponses() {
      return supplementalResponses;
    },
    get lastModelRequestUrl() {
      return lastModelRequestUrl;
    },
    waitForRequests(target, message, timeoutMs) {
      return queue.wait(() => requests >= target, message, timeoutMs);
    },
    waitForResponses(target, message, timeoutMs) {
      return queue.wait(() => responses >= target, message, timeoutMs);
    },
    waitForSupplementalRequests(target, message, timeoutMs) {
      return queue.wait(() => supplementalRequests >= target, message, timeoutMs);
    },
    releaseModelResponses() {
      holdPrimary = false;
      for (const send of pendingPrimary.splice(0)) send();
    },
    setPrimaryStatus(status, body, statusText) {
      primaryStatus = status;
      if (body !== undefined) primaryBody = body;
      if (statusText !== undefined) primaryStatusText = statusText;
    },
    setPrimaryHold(hold) {
      holdPrimary = hold;
      if (!hold) {
        for (const send of pendingPrimary.splice(0)) send();
      }
    },
    setSupplementalHold(hold) {
      holdSupplemental = hold;
      if (!hold) {
        for (const send of pendingSupplemental.splice(0)) send();
      }
    },
    setSupplementalDelayMs(ms) {
      supplementalDelayMs = ms;
    },
    close() {
      return new Promise((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      });
    },
  };
}

async function readFixtureModels() {
  const raw = JSON.parse(await readFile(fixturePath, "utf8")) as { data: Array<Record<string, unknown>> };
  return raw.data;
}

function normalizedCacheModel(modelId: string, name = "Cached Test Model") {
  return {
    id: modelId,
    name,
    reasoning: false,
    input: ["text"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  };
}

function createValidCacheJson(
  baseUrl: string,
  modelId = "cached-test-model",
  options?: { models?: Array<ReturnType<typeof normalizedCacheModel>>; fetchedAt?: string },
) {
  return `${JSON.stringify(
    {
      schemaVersion: 2,
      provider: "omniroute",
      baseUrl,
      fetchedAt: options?.fetchedAt ?? "2026-06-20T00:00:00.000Z",
      models: options?.models ?? [normalizedCacheModel(modelId)],
    },
    null,
    2,
  )}\n`;
}

async function writeValidCache(cachePath: string, baseUrl: string, modelId = "cached-test-model") {
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, createValidCacheJson(baseUrl, modelId));
}

async function settleAsyncWork() {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

async function captureConsoleWarns<T>(fn: () => Promise<T>) {
  const warns: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  };
  try {
    const result = await fn();
    return { result, warns };
  } finally {
    console.warn = original;
  }
}

function modelIds(models: Array<Record<string, unknown>> | ProviderModelConfig[] | undefined) {
  return (models ?? []).map((model) => String((model as { id: string }).id)).sort();
}

const ENV_KEYS = [
  "OMNIROUTE_BASE_URL",
  "OMNIROUTE_API_KEY",
  "OMNIROUTE_MODEL_CACHE_PATH",
  "OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS",
  "PI_CODING_AGENT_DIR",
  "PI_OFFLINE",
] as const;

describe("OmniRoute native refreshModels provider", () => {
  let tempDir: string;
  let savedEnv: Record<string, string | undefined>;
  let servers: FixtureServer[] = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "omniroute-native-refresh-"));
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
    servers = [];
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await Promise.all(servers.map((server) => server.close().catch(() => undefined)));
    await rm(tempDir, { recursive: true, force: true });
  });

  async function boot(baseUrl: string, apiKey = "test-key") {
    process.env.OMNIROUTE_BASE_URL = baseUrl;
    process.env.OMNIROUTE_API_KEY = apiKey;
    process.env.PI_CODING_AGENT_DIR = tempDir;
    process.env.OMNIROUTE_MODEL_CACHE_PATH = join(tempDir, "legacy-cache.json");
    const harness = createHarness();
    await extension(harness.api);
    return harness;
  }

  function provider(harness: ExtensionHarness) {
    assert.equal(harness.registerProviderCalls, 1, "provider must be registered exactly once");
    assert.equal(harness.sessionStartHandlers.length, 0, "must not use session_start refresh");
    assert.equal(harness.sessionShutdownHandlers.length, 0, "must not use session_shutdown refresh");
    const registration = harness.registeredProviders[0];
    assert.ok(registration);
    assert.equal(registration.name, "omniroute");
    assert.equal(registration.config.api, "openai-responses");
    assert.equal(registration.config.apiKey, "$OMNIROUTE_API_KEY");
    assert.equal(typeof registration.config.refreshModels, "function");
    return registration;
  }

  it("registers once with public refreshModels and no session lifecycle handlers", async () => {
    const harness = await boot("http://127.0.0.1:9/v1");
    const registration = provider(harness);
    assert.deepEqual(registration.config.models ?? [], []);
  });

  it("imports a valid legacy catalog into the Pi store on first refresh without deleting the file", async () => {
    const baseUrl = "http://127.0.0.1:9/v1";
    const cachePath = join(tempDir, "legacy-cache.json");
    await writeValidCache(cachePath, baseUrl, "legacy-model");
    process.env.OMNIROUTE_BASE_URL = baseUrl;
    process.env.OMNIROUTE_API_KEY = "test-key";
    process.env.OMNIROUTE_MODEL_CACHE_PATH = cachePath;
    process.env.PI_CODING_AGENT_DIR = tempDir;

    const harness = createHarness();
    await extension(harness.api);
    const registration = provider(harness);
    const memory = createMemoryStore();
    const models = await registration.config.refreshModels!({
      store: memory.store,
      allowNetwork: false,
    });

    assert.deepEqual(modelIds(models), ["legacy-model"]);
    assert.equal(memory.writes.length, 1);
    assert.ok(memory.writes[0]?.checkedAt);
    const remaining = await readFile(cachePath, "utf8");
    assert.match(remaining, /legacy-model/);
    assert.doesNotMatch(remaining, /test-key/);
  });

  it("returns a fresh stored catalog without network when within the four-hour window", async () => {
    const server = await createFixtureServer();
    servers.push(server);
    const harness = await boot(server.baseUrl);
    const registration = provider(harness);
    const memory = createMemoryStore({
      checkedAt: Date.now(),
      models: [
        {
          id: "fresh-model",
          name: "Fresh",
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

    const models = await registration.config.refreshModels!({
      store: memory.store,
      allowNetwork: true,
      credential: { type: "api_key", key: "test-key" },
    });

    assert.deepEqual(modelIds(models), ["fresh-model"]);
    assert.equal(server.requests, 0);
    assert.equal(memory.writes.length, 0);
  });

  it("force refresh bypasses freshness and rewrites the store from the primary catalog", async () => {
    const server = await createFixtureServer();
    servers.push(server);
    process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS = "2000";
    const harness = await boot(server.baseUrl);
    const registration = provider(harness);
    const memory = createMemoryStore({
      checkedAt: Date.now(),
      models: [
        {
          id: "stale-model",
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

    const models = await registration.config.refreshModels!({
      store: memory.store,
      allowNetwork: true,
      force: true,
      credential: { type: "api_key", key: "test-key" },
    });

    assert.ok(models.length > 10);
    assert.ok(!modelIds(models).includes("stale-model"));
    assert.equal(server.requests, 1);
    assert.equal(memory.writes.length, 1);
  });

  it("does not wait for an unfinished supplemental request after primary success", async () => {
    const server = await createFixtureServer({ holdSupplemental: true, supplementalDelayMs: 0 });
    servers.push(server);
    process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS = "3000";
    const harness = await boot(server.baseUrl);
    const registration = provider(harness);
    const memory = createMemoryStore();

    const started = Date.now();
    const models = await registration.config.refreshModels!({
      store: memory.store,
      allowNetwork: true,
      force: true,
      credential: { type: "api_key", key: "test-key" },
    });
    const elapsed = Date.now() - started;

    assert.ok(models.length > 0);
    assert.ok(elapsed < 1500, `primary must not wait for held supplemental (${elapsed}ms)`);
    assert.equal(server.requests, 1);
    // Supplemental may or may not have been accepted yet depending on scheduling, but must not complete before release.
    assert.equal(server.supplementalResponses, 0);
    // release so server can close cleanly
    server.setSupplementalHold(false);
  });

  it("uses already-settled supplemental metadata when available", async () => {
    const server = await createFixtureServer({
      supplementalBody: JSON.stringify({
        data: [
          {
            id: "fixture/reasoning-base",
            root: "reasoning-base",
            supportedReasoningEfforts: ["low", "medium", "high", "max"],
          },
        ],
      }),
    });
    servers.push(server);
    // inject a known model into primary body for deterministic effort merge
    const primary = {
      data: [
        {
          id: "fixture/reasoning-base",
          name: "Reasoning Base",
          root: "reasoning-base",
          capabilities: { reasoning: true },
          input_modalities: ["text"],
          output_modalities: ["text"],
          context_length: 8000,
          max_output_tokens: 1000,
        },
        {
          id: "fixture/reasoning-base-high",
          name: "Reasoning Base High",
          root: "reasoning-base",
          capabilities: { reasoning: true },
          input_modalities: ["text"],
          output_modalities: ["text"],
          context_length: 8000,
          max_output_tokens: 1000,
        },
      ],
    };
    server.setPrimaryStatus(200, JSON.stringify(primary));
    process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS = "2000";
    const harness = await boot(server.baseUrl);
    const registration = provider(harness);
    const memory = createMemoryStore();

    // ensure supplemental can complete first by awaiting a tiny delay path: primary held briefly
    server.setPrimaryHold(true);
    const refreshPromise = registration.config.refreshModels!({
      store: memory.store,
      allowNetwork: true,
      force: true,
      credential: { type: "api_key", key: "test-key" },
    });
    await server.waitForSupplementalRequests(1, "expected supplemental request");
    await server.waitForResponses(0, "primary still held");
    // wait for supplemental response completion
    await new Promise((r) => setTimeout(r, 50));
    server.setPrimaryHold(false);
    const models = await refreshPromise;
    const base = models.find((model) => model.id === "fixture/reasoning-base");
    assert.ok(base);
    assert.equal(base.reasoning, true);
    assert.ok(base.thinkingLevelMap);
    assert.equal(base.thinkingLevelMap?.high, "high");
    assert.ok(!models.some((model) => model.id === "fixture/reasoning-base-high"), "variant should fold into base");
  });

  it("parent abort before store write yields AbortError and no store write", async () => {
    const server = await createFixtureServer({ holdPrimary: true });
    servers.push(server);
    process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS = "5000";
    const harness = await boot(server.baseUrl);
    const registration = provider(harness);
    const memory = createMemoryStore();
    const controller = new AbortController();

    const promise = registration.config.refreshModels!({
      store: memory.store,
      allowNetwork: true,
      force: true,
      credential: { type: "api_key", key: "test-key" },
      signal: controller.signal,
    });

    await server.waitForRequests(1, "expected primary request");
    controller.abort();
    await assert.rejects(promise, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.name, /AbortError|Error/);
      return true;
    });
    assert.equal(memory.writes.length, 0);
    server.releaseModelResponses();
  });

  it("primary failures are sanitized and do not console.warn discovery errors", async () => {
    const secretKey = "super-secret-key-value";
    const secretHost = "secret-host.example.invalid";
    const server = await createFixtureServer({
      primaryStatus: 401,
      primaryBody: JSON.stringify({ error: `denied for ${secretKey} at ${secretHost}` }),
    });
    servers.push(server);
    process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS = "2000";
    const harness = await boot(server.baseUrl, secretKey);
    const registration = provider(harness);
    const memory = createMemoryStore();

    const { warns } = await captureConsoleWarns(async () => {
      await assert.rejects(
        registration.config.refreshModels!({
          store: memory.store,
          allowNetwork: true,
          force: true,
          credential: { type: "api_key", key: secretKey },
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /Model discovery failed with HTTP 401/);
          assert.doesNotMatch(error.message, new RegExp(secretKey));
          assert.doesNotMatch(error.message, new RegExp(secretHost));
          assert.doesNotMatch(error.message, /OMNIROUTE_API_KEY|Authorization|Bearer /i);
          return true;
        },
      );
    });

    assert.equal(warns.length, 0, "discovery failures must not console.warn");
    assert.equal(memory.writes.length, 0);
  });

  it("omits adversarial HTTP statusText from primary discovery errors", async () => {
    const secretKey = "status-text-secret-key";
    const secretHost = "status-text-host.example.invalid";
    const adversarialStatusText = `Unauthorized for ${secretKey} via http://${secretHost}/v1 key=${secretKey}`;
    const server = await createFixtureServer({
      primaryStatus: 503,
      primaryStatusText: adversarialStatusText,
      primaryBody: JSON.stringify({ error: `body must stay hidden ${secretKey}` }),
    });
    servers.push(server);
    process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS = "2000";
    const harness = await boot(server.baseUrl, secretKey);
    const registration = provider(harness);
    const memory = createMemoryStore();

    await assert.rejects(
      registration.config.refreshModels!({
        store: memory.store,
        allowNetwork: true,
        force: true,
        credential: { type: "api_key", key: secretKey },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "Model discovery failed with HTTP 503");
        assert.doesNotMatch(error.message, new RegExp(secretKey));
        assert.doesNotMatch(error.message, new RegExp(secretHost));
        assert.doesNotMatch(error.message, /Unauthorized|body must stay hidden|Bearer /i);
        assert.doesNotMatch(error.message, new RegExp(server.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        return true;
      },
    );
    assert.equal(memory.writes.length, 0);
  });

  it("keeps a valid chat row when a non-chat duplicate shares the same id", async () => {
    const server = await createFixtureServer({
      primaryBody: JSON.stringify({
        data: [
          {
            id: "codex/gpt-5.5",
            name: "GPT 5.5",
            type: "chat",
            input_modalities: ["text"],
            output_modalities: ["text"],
            context_length: 8192,
            max_output_tokens: 1024,
          },
          {
            id: "codex/gpt-5.5",
            name: "GPT 5.5 Image",
            type: "image",
            input_modalities: ["text"],
            output_modalities: ["image"],
            context_length: 8192,
            max_output_tokens: 1024,
          },
        ],
      }),
      supplementalBody: JSON.stringify({ data: [] }),
    });
    servers.push(server);
    process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS = "5000";
    const harness = await boot(server.baseUrl);
    const registration = provider(harness);
    const memory = createMemoryStore();
    const models = await registration.config.refreshModels!({
      store: memory.store,
      allowNetwork: true,
      force: true,
      credential: { type: "api_key", key: "test-key" },
    });
    assert.deepEqual(modelIds(models), ["codex/gpt-5.5"]);
  });

  it("filters non-conversational models from the mixed OmniRoute catalog", async () => {
    const server = await createFixtureServer();
    servers.push(server);
    process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS = "5000";
    const harness = await boot(server.baseUrl);
    const registration = provider(harness);
    const memory = createMemoryStore();
    const models = await registration.config.refreshModels!({
      store: memory.store,
      allowNetwork: true,
      force: true,
      credential: { type: "api_key", key: "test-key" },
    });
    const ids = new Set(modelIds(models));
    assert.ok(!ids.has("github/text-embedding-3-large"));
    // Valid chat row must survive when a typed image row reuses the same id.
    assert.ok(ids.has("codex/gpt-5.5"), "chat duplicate of image id must remain");
    // Typed non-chat rows are excluded row-by-row; untyped peers without modalities may remain.
    const fixture = await readFixtureModels();
    for (const model of fixture) {
      if (model.type === "embedding" || model.type === "image" || model.type === "video" || model.type === "audio") {
        // Only assert that the typed non-chat *row* cannot be the sole surviving reason to keep id
        // when no conversational peer exists. Presence is allowed only via a separate chat row.
        const hasChatPeer = fixture.some(
          (peer) =>
            peer.id === model.id &&
            peer !== model &&
            (peer.type === undefined || peer.type === "chat") &&
            (!Array.isArray(peer.output_modalities) || peer.output_modalities.includes("text")),
        );
        if (!hasChatPeer) {
          assert.ok(!ids.has(String(model.id)), `should exclude non-chat-only id ${model.id}`);
        }
      }
      if (
        Array.isArray(model.output_modalities) &&
        !model.output_modalities.includes("text") &&
        model.type !== "image" // image handled via peer logic above
      ) {
        const hasTextPeer = fixture.some(
          (peer) =>
            peer.id === model.id &&
            Array.isArray(peer.output_modalities) &&
            peer.output_modalities.includes("text"),
        );
        if (!hasTextPeer) {
          assert.ok(!ids.has(String(model.id)), `should exclude non-text output ${model.id}`);
        }
      }
    }
    assert.ok(ids.size > 50, "still keeps conversational text models");
  });

  it("legacy import drops obvious non-chat normalized ids without inventing a fresh timestamp", async () => {
    const server = await createFixtureServer({
      primaryBody: JSON.stringify({
        data: [
          {
            id: "network-chat",
            type: "chat",
            output_modalities: ["text"],
            input_modalities: ["text"],
            context_length: 8192,
            max_output_tokens: 1024,
          },
        ],
      }),
      supplementalBody: JSON.stringify({ data: [] }),
    });
    servers.push(server);
    const cachePath = join(tempDir, "legacy-mixed-cache.json");
    const fetchedAt = new Date().toISOString();
    await writeFile(
      cachePath,
      createValidCacheJson(server.baseUrl, "legacy-chat", {
        fetchedAt,
        models: [
          normalizedCacheModel("legacy-chat", "legacy-chat"),
          normalizedCacheModel("embedding/obvious", "embedding/obvious"),
          {
            ...normalizedCacheModel("image/obvious", "image/obvious"),
            input: ["text", "image"],
          },
          normalizedCacheModel("video/obvious", "video/obvious"),
          normalizedCacheModel("audio/obvious", "audio/obvious"),
          // Must not be dropped by generic keyword false positives.
          normalizedCacheModel("provider-image-studio/chat-helper", "Vision Chat Helper"),
        ],
      }),
    );
    process.env.OMNIROUTE_BASE_URL = server.baseUrl;
    process.env.OMNIROUTE_API_KEY = "test-key";
    process.env.OMNIROUTE_MODEL_CACHE_PATH = cachePath;
    process.env.PI_CODING_AGENT_DIR = tempDir;

    const harness = createHarness();
    await extension(harness.api);
    const registration = provider(harness);
    const memory = createMemoryStore();
    const models = await registration.config.refreshModels!({
      store: memory.store,
      allowNetwork: true,
      force: false,
      credential: { type: "api_key", key: "test-key" },
    });

    assert.deepEqual(modelIds(models).sort(), ["legacy-chat", "provider-image-studio/chat-helper"].sort());
    assert.equal(server.requests, 0, "fresh-enough legacy fetchedAt must not force network");
    assert.equal(memory.writes.length, 1);
    const written = memory.writes[0]!;
    assert.deepEqual(
      (written.models as Array<{ id: string }>).map((model) => model.id).sort(),
      ["legacy-chat", "provider-image-studio/chat-helper"].sort(),
    );
    const expectedCheckedAt = Date.parse(fetchedAt);
    assert.equal(written.checkedAt, expectedCheckedAt);
    assert.ok(Date.now() - (written.checkedAt ?? 0) < 5_000);
  });

  it("stale legacy fetchedAt remains offline-cleaned but allows ordinary revalidation", async () => {
    const server = await createFixtureServer({
      primaryBody: JSON.stringify({
        data: [
          {
            id: "network-chat",
            type: "chat",
            output_modalities: ["text"],
            input_modalities: ["text"],
            context_length: 8192,
            max_output_tokens: 1024,
          },
        ],
      }),
      supplementalBody: JSON.stringify({ data: [] }),
    });
    servers.push(server);
    const cachePath = join(tempDir, "legacy-stale-cache.json");
    await writeFile(
      cachePath,
      createValidCacheJson(server.baseUrl, "legacy-chat", {
        fetchedAt: "2020-01-01T00:00:00.000Z",
        models: [
          normalizedCacheModel("legacy-chat", "legacy-chat"),
          normalizedCacheModel("embedding/obvious", "embedding/obvious"),
        ],
      }),
    );
    process.env.OMNIROUTE_BASE_URL = server.baseUrl;
    process.env.OMNIROUTE_API_KEY = "test-key";
    process.env.OMNIROUTE_MODEL_CACHE_PATH = cachePath;

    const harness = createHarness();
    await extension(harness.api);
    const registration = provider(harness);
    const memory = createMemoryStore();
    const models = await registration.config.refreshModels!({
      store: memory.store,
      allowNetwork: true,
      force: false,
      credential: { type: "api_key", key: "test-key" },
    });

    assert.deepEqual(modelIds(models), ["network-chat"]);
    assert.equal(server.requests, 1);
    assert.ok(memory.writes.length >= 1);
  });

  it("folds verified reasoning variants and hides synthetic Codex ultra aliases", async () => {
    const server = await createFixtureServer({
      primaryBody: JSON.stringify({
        data: [
          {
            id: "codex/gpt-5.6-sol-ultra",
            root: "gpt-5.6-sol-ultra",
            owned_by: "codex",
            input_modalities: ["text"],
            output_modalities: ["text"],
          },
          {
            id: "vendor/model",
            root: "model",
            capabilities: { reasoning: true },
            input_modalities: ["text"],
            output_modalities: ["text"],
            context_length: 16000,
            max_output_tokens: 2000,
          },
          {
            id: "vendor/model-high",
            root: "model",
            capabilities: { reasoning: true },
            input_modalities: ["text"],
            output_modalities: ["text"],
            context_length: 16000,
            max_output_tokens: 2000,
          },
          {
            id: "vendor/model-max",
            root: "model",
            capabilities: { reasoning: true },
            input_modalities: ["text"],
            output_modalities: ["text"],
            context_length: 16000,
            max_output_tokens: 2000,
          },
        ],
      }),
    });
    servers.push(server);
    const harness = await boot(server.baseUrl);
    const registration = provider(harness);
    const memory = createMemoryStore();
    const models = await registration.config.refreshModels!({
      store: memory.store,
      allowNetwork: true,
      force: true,
      credential: { type: "api_key", key: "test-key" },
    });
    const ids = modelIds(models);
    assert.deepEqual(ids, ["vendor/model"]);
    const model = models[0]!;
    assert.equal(model.reasoning, true);
    assert.equal(model.thinkingLevelMap?.high, "high");
    assert.equal(model.thinkingLevelMap?.max, "max");
  });

  it("does not leak secrets into the legacy cache file path contents after import", async () => {
    const baseUrl = "http://127.0.0.1:9/v1";
    const cachePath = join(tempDir, "legacy-cache.json");
    const secret = "leaky-secret-key";
    await writeValidCache(cachePath, baseUrl);
    process.env.OMNIROUTE_BASE_URL = baseUrl;
    process.env.OMNIROUTE_API_KEY = secret;
    process.env.OMNIROUTE_MODEL_CACHE_PATH = cachePath;
    const harness = createHarness();
    await extension(harness.api);
    const registration = provider(harness);
    const memory = createMemoryStore();
    await registration.config.refreshModels!({ store: memory.store, allowNetwork: false });
    const raw = await readFile(cachePath, "utf8");
    assert.doesNotMatch(raw, new RegExp(secret));
    assert.doesNotMatch(JSON.stringify(memory.writes), new RegExp(secret));
  });

  it("normalizes trailing slashes in OMNIROUTE_BASE_URL for registration", async () => {
    const harness = await boot("http://127.0.0.1:9/v1///");
    const registration = provider(harness);
    assert.equal(registration.config.baseUrl, "http://127.0.0.1:9/v1");
  });

  it("default legacy cache path is under PI_CODING_AGENT_DIR when OMNIROUTE_MODEL_CACHE_PATH is unset", async () => {
    const baseUrl = "http://127.0.0.1:9/v1";
    const agentDir = join(tempDir, "agent-dir");
    const cacheKey = createHash("sha256").update(baseUrl).digest("hex").slice(0, 16);
    const cachePath = join(agentDir, "omniroute", `models-${cacheKey}.json`);
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, createValidCacheJson(baseUrl, "default-path-model"));

    process.env.OMNIROUTE_BASE_URL = baseUrl;
    process.env.OMNIROUTE_API_KEY = "test-key";
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.OMNIROUTE_MODEL_CACHE_PATH;

    const harness = createHarness();
    await extension(harness.api);
    const registration = provider(harness);
    const memory = createMemoryStore();
    const models = await registration.config.refreshModels!({
      store: memory.store,
      allowNetwork: false,
    });
    assert.deepEqual(modelIds(models), ["default-path-model"]);
  });

  it("allowNetwork false returns stored/imported models without discovery", async () => {
    const server = await createFixtureServer();
    servers.push(server);
    const cachePath = join(tempDir, "legacy-cache.json");
    await writeValidCache(cachePath, server.baseUrl, "offline-model");
    process.env.OMNIROUTE_BASE_URL = server.baseUrl;
    process.env.OMNIROUTE_API_KEY = "test-key";
    process.env.OMNIROUTE_MODEL_CACHE_PATH = cachePath;
    const harness = createHarness();
    await extension(harness.api);
    const registration = provider(harness);
    const memory = createMemoryStore();
    const models = await registration.config.refreshModels!({
      store: memory.store,
      allowNetwork: false,
    });
    assert.deepEqual(modelIds(models), ["offline-model"]);
    assert.equal(server.requests, 0);
  });
});
