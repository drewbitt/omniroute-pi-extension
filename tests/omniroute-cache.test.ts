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
    delete(): Promise<void>;
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
  readonly primaryAborts: number;
  readonly supplementalAborts: number;
  readonly lastModelRequestUrl: string | undefined;
  waitForRequests(target: number, message: string, timeoutMs?: number): Promise<void>;
  waitForResponses(target: number, message: string, timeoutMs?: number): Promise<void>;
  waitForSupplementalRequests(target: number, message: string, timeoutMs?: number): Promise<void>;
  waitForSupplementalResponses(target: number, message: string, timeoutMs?: number): Promise<void>;
  waitForPrimaryAborts(target: number, message: string, timeoutMs?: number): Promise<void>;
  waitForSupplementalAborts(target: number, message: string, timeoutMs?: number): Promise<void>;
  releaseModelResponses(): void;
  setPrimaryStatus(status: number, body?: string, statusText?: string): void;
  setPrimaryHold(hold: boolean): void;
  setSupplementalStatus(status: number, body?: string, statusText?: string): void;
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
  let deletes = 0;
  return {
    writes,
    get deletes() {
      return deletes;
    },
    store: {
      async read() {
        return entry ? structuredClone(entry) : undefined;
      },
      async write(next: { models: readonly unknown[]; checkedAt?: number }) {
        entry = structuredClone(next);
        writes.push(structuredClone(next));
      },
      async delete() {
        entry = undefined;
        deletes += 1;
      },
    },
  };
}

function storedProviderModel(id: string, baseUrl: string, name = id) {
  return {
    id,
    name,
    provider: "omniroute",
    api: "openai-responses",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
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
    supplementalStatus?: number;
    supplementalStatusText?: string;
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
  let primaryAborts = 0;
  let supplementalAborts = 0;
  let lastModelRequestUrl: string | undefined;
  let holdPrimary = options.holdPrimary ?? false;
  let holdSupplemental = options.holdSupplemental ?? false;
  let primaryStatus = options.primaryStatus ?? 200;
  let primaryStatusText = options.primaryStatusText;
  let primaryBody = options.primaryBody ?? aliasBody;
  let supplementalStatus = options.supplementalStatus ?? 200;
  let supplementalStatusText = options.supplementalStatusText;
  let supplementalDelayMs = options.supplementalDelayMs ?? 0;
  let supplementalBody =
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
  type HeldResponse = {
    send: () => void;
    cleanup: () => void;
  };
  const pendingPrimary: HeldResponse[] = [];
  const pendingSupplemental: HeldResponse[] = [];

  const trackHeld = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    kind: "primary" | "supplemental",
    sendBody: () => void,
  ): HeldResponse => {
    let settled = false;
    const markAbort = () => {
      if (settled) return;
      settled = true;
      if (kind === "primary") primaryAborts += 1;
      else supplementalAborts += 1;
      queue.notify();
      if (!res.writableEnded) res.destroy();
    };
    const onRequestClose = () => {
      // Request/connection closed before a response body was completed.
      if (!res.writableEnded) markAbort();
    };
    req.on("aborted", onRequestClose);
    req.on("close", onRequestClose);
    res.on("close", onRequestClose);
    const send = () => {
      if (settled || res.writableEnded) return;
      settled = true;
      req.off("aborted", onRequestClose);
      req.off("close", onRequestClose);
      res.off("close", onRequestClose);
      sendBody();
    };
    const cleanup = () => {
      markAbort();
    };
    return { send, cleanup };
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    lastModelRequestUrl = req.url;

    if (path.includes("/vscode/_/models")) {
      supplementalRequests += 1;
      queue.notify();
      const sendBody = () => {
        if (res.writableEnded) return;
        supplementalResponses += 1;
        queue.notify();
        if (supplementalStatusText !== undefined) {
          res.writeHead(supplementalStatus, supplementalStatusText, {
            "content-type": "application/json",
          });
        } else {
          res.writeHead(supplementalStatus, { "content-type": "application/json" });
        }
        res.end(supplementalBody);
      };
      if (holdSupplemental) {
        pendingSupplemental.push(trackHeld(req, res, "supplemental", sendBody));
        return;
      }
      if (supplementalDelayMs > 0) {
        const held = trackHeld(req, res, "supplemental", sendBody);
        setTimeout(() => held.send(), supplementalDelayMs);
        return;
      }
      sendBody();
      return;
    }

    if (path.endsWith("/models") || path.includes("/models")) {
      requests += 1;
      queue.notify();
      const sendBody = () => {
        if (res.writableEnded) return;
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
        pendingPrimary.push(trackHeld(req, res, "primary", sendBody));
        return;
      }
      sendBody();
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
    get primaryAborts() {
      return primaryAborts;
    },
    get supplementalAborts() {
      return supplementalAborts;
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
    waitForSupplementalResponses(target, message, timeoutMs) {
      return queue.wait(() => supplementalResponses >= target, message, timeoutMs);
    },
    waitForPrimaryAborts(target, message, timeoutMs) {
      return queue.wait(() => primaryAborts >= target, message, timeoutMs);
    },
    waitForSupplementalAborts(target, message, timeoutMs) {
      return queue.wait(() => supplementalAborts >= target, message, timeoutMs);
    },
    releaseModelResponses() {
      holdPrimary = false;
      for (const held of pendingPrimary.splice(0)) held.send();
    },
    setPrimaryStatus(status, body, statusText) {
      primaryStatus = status;
      if (body !== undefined) primaryBody = body;
      if (statusText !== undefined) primaryStatusText = statusText;
    },
    setPrimaryHold(hold) {
      holdPrimary = hold;
      if (!hold) {
        for (const held of pendingPrimary.splice(0)) held.send();
      }
    },
    setSupplementalStatus(status, body, statusText) {
      supplementalStatus = status;
      if (body !== undefined) supplementalBody = body;
      if (statusText !== undefined) supplementalStatusText = statusText;
    },
    setSupplementalHold(hold) {
      holdSupplemental = hold;
      if (!hold) {
        for (const held of pendingSupplemental.splice(0)) held.send();
      }
    },
    setSupplementalDelayMs(ms) {
      supplementalDelayMs = ms;
    },
    close() {
      for (const held of pendingPrimary.splice(0)) held.cleanup();
      for (const held of pendingSupplemental.splice(0)) held.cleanup();
      return new Promise<void>((resolveClose, reject) => {
        // server.close() alone waits for keep-alive sockets; shut them down so teardown is immediate.
        server.close((error) => {
          if (error) reject(error);
          else resolveClose();
        });
        server.closeIdleConnections();
        server.closeAllConnections();
      });
    },
  };
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

async function readFixtureModels() {
  const raw = JSON.parse(await readFile(fixturePath, "utf8")) as { data: Array<Record<string, unknown>> };
  return raw.data;
}

function createValidCacheJson(
  baseUrl: string,
  modelId = "cached-test-model",
  options?: { models?: Array<Record<string, unknown>>; fetchedAt?: string },
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


function fullThinkingMap(overrides: Partial<Record<string, string | null>> = {}) {
  return {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: null,
    xhigh: null,
    max: null,
    ...overrides,
  };
}

function assertSanitizedDiscoveryError(
  error: unknown,
  options: {
    expectAbort?: boolean;
    expectMessage?: string | RegExp;
    secretKey?: string;
    secretHost?: string;
    baseUrl?: string;
  } = {},
) {
  assert.ok(error instanceof Error);
  if (options.expectAbort) {
    assert.equal(error.name, "AbortError");
  } else {
    assert.notEqual(error.name, "AbortError");
  }
  if (typeof options.expectMessage === "string") {
    assert.equal(error.message, options.expectMessage);
  } else if (options.expectMessage instanceof RegExp) {
    assert.match(error.message, options.expectMessage);
  }
  if (options.secretKey) {
    assert.doesNotMatch(error.message, new RegExp(options.secretKey));
  }
  if (options.secretHost) {
    assert.doesNotMatch(error.message, new RegExp(options.secretHost));
  }
  if (options.baseUrl) {
    assert.doesNotMatch(
      error.message,
      new RegExp(options.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
  assert.doesNotMatch(error.message, /Authorization|Bearer |OMNIROUTE_API_KEY/i);
}

async function assertAtomicFailureNoWrite(
  registration: RegisteredProvider,
  memory: ReturnType<typeof createMemoryStore>,
  options: {
    secretKey?: string;
    expectAbort?: boolean;
    expectMessage?: string | RegExp;
    secretHost?: string;
    baseUrl?: string;
  } = {},
) {
  await assert.rejects(
    registration.config.refreshModels!({
      store: memory.store,
      allowNetwork: true,
      force: true,
      credential: { type: "api_key", key: options.secretKey ?? "test-key" },
    }),
    (error: unknown) => {
      assertSanitizedDiscoveryError(error, options);
      return true;
    },
  );
  assert.equal(memory.writes.length, 0, "failed dual discovery must not write a new snapshot");
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
      models: [storedProviderModel("fresh-model", server.baseUrl, "Fresh")],
    });

    const models = await registration.config.refreshModels!({
      store: memory.store,
      allowNetwork: true,
      credential: { type: "api_key", key: "test-key" },
    });

    assert.deepEqual(modelIds(models), ["fresh-model"]);
    assert.equal(server.requests, 0);
    assert.equal(memory.writes.length, 0);
    assert.equal(memory.deletes, 0);
  });

  it("deletes a fresh store from another base URL offline and returns empty without write or network", async () => {
    const urlA = "http://127.0.0.1:9/v1";
    const urlB = "http://127.0.0.1:10/v1";
    const harness = await boot(urlB);
    const registration = provider(harness);
    const memory = createMemoryStore({
      checkedAt: Date.now(),
      models: [storedProviderModel("url-a-model", urlA)],
    });

    const models = await registration.config.refreshModels!({
      store: memory.store,
      allowNetwork: false,
    });

    assert.deepEqual(modelIds(models), []);
    assert.equal(memory.deletes, 1);
    assert.equal(memory.writes.length, 0);
    assert.equal(await memory.store.read(), undefined);
  });

  it("deletes a mismatched store before online discovery and writes only the current-URL catalog", async () => {
    const urlA = "http://127.0.0.1:9/v1";
    const server = await createFixtureServer();
    servers.push(server);
    process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS = "2000";
    const harness = await boot(server.baseUrl);
    const registration = provider(harness);
    const memory = createMemoryStore({
      checkedAt: Date.now(),
      models: [storedProviderModel("url-a-model", urlA)],
    });

    const models = await registration.config.refreshModels!({
      store: memory.store,
      allowNetwork: true,
      credential: { type: "api_key", key: "test-key" },
    });

    assert.ok(models.length > 0);
    assert.ok(!modelIds(models).includes("url-a-model"));
    assert.equal(memory.deletes, 1);
    assert.equal(server.requests, 1);
    assert.equal(memory.writes.length, 1);
    const written = memory.writes[0]?.models ?? [];
    assert.ok(written.length > 0);
    for (const entry of written) {
      assert.equal((entry as { baseUrl?: string }).baseUrl, server.baseUrl);
    }
  });

  it("treats trailing-slash base URL differences as the same cache and does not delete", async () => {
    const baseUrl = "http://127.0.0.1:9/v1";
    const harness = await boot(baseUrl);
    const registration = provider(harness);
    const memory = createMemoryStore({
      checkedAt: Date.now(),
      models: [storedProviderModel("slash-model", `${baseUrl}/`)],
    });

    const models = await registration.config.refreshModels!({
      store: memory.store,
      allowNetwork: false,
    });

    assert.deepEqual(modelIds(models), ["slash-model"]);
    assert.equal(memory.deletes, 0);
    assert.equal(memory.writes.length, 0);
  });

  it("deletes stored catalogs with missing or malformed baseUrl and returns empty offline", async () => {
    const baseUrl = "http://127.0.0.1:9/v1";
    const harness = await boot(baseUrl);
    const registration = provider(harness);

    for (const models of [
      [{ ...storedProviderModel("missing-base", baseUrl), baseUrl: undefined }],
      [{ ...storedProviderModel("empty-base", baseUrl), baseUrl: "" }],
      [{ ...storedProviderModel("bad-base", baseUrl), baseUrl: 42 }],
    ]) {
      const memory = createMemoryStore({
        checkedAt: Date.now(),
        models: models as unknown as readonly unknown[],
      });

      const result = await registration.config.refreshModels!({
        store: memory.store,
        allowNetwork: false,
      });

      assert.deepEqual(modelIds(result), []);
      assert.equal(memory.deletes, 1);
      assert.equal(memory.writes.length, 0);
      assert.equal(await memory.store.read(), undefined);
    }
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

  it("waits for a delayed supplemental response and merges its efforts after primary success", async () => {
    const server = await createFixtureServer({
      supplementalDelayMs: 180,
      supplementalBody: JSON.stringify({
        data: [
          {
            id: "fixture/union-base",
            root: "union-base",
            supportedReasoningEfforts: ["medium"],
          },
        ],
      }),
      primaryBody: JSON.stringify({
        data: [
          {
            id: "fixture/union-base",
            name: "Union Base",
            root: "union-base",
            capabilities: { reasoning: true, effort_tiers: ["low"] },
            input_modalities: ["text"],
            output_modalities: ["text"],
            context_length: 8000,
            max_output_tokens: 1000,
          },
        ],
      }),
    });
    servers.push(server);
    process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS = "2000";
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

    assert.ok(elapsed >= 150, `must wait for delayed supplemental (${elapsed}ms)`);
    assert.equal(server.requests, 1);
    assert.equal(server.supplementalResponses, 1);
    const base = models.find((model) => model.id === "fixture/union-base");
    assert.ok(base);
    assert.equal(base.thinkingLevelMap?.low, "low");
    assert.equal(base.thinkingLevelMap?.medium, "medium");
  });

  it("unions primary effort_tiers, verified suffix variants, and supplemental efforts without loss", async () => {
    const server = await createFixtureServer({
      supplementalBody: JSON.stringify({
        data: [
          {
            id: "fixture/union-base",
            root: "union-base",
            supportedReasoningEfforts: ["high", "max", "ultra"],
          },
        ],
      }),
      primaryBody: JSON.stringify({
        data: [
          {
            id: "fixture/union-base",
            name: "Union Base",
            root: "union-base",
            capabilities: { reasoning: true, effort_tiers: ["none", "low"] },
            input_modalities: ["text"],
            output_modalities: ["text"],
            context_length: 16000,
            max_output_tokens: 2000,
          },
          {
            id: "fixture/union-base-xhigh",
            name: "Union Base xhigh",
            root: "union-base",
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
    process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS = "2000";
    const harness = await boot(server.baseUrl);
    const registration = provider(harness);
    const memory = createMemoryStore();

    const models = await registration.config.refreshModels!({
      store: memory.store,
      allowNetwork: true,
      force: true,
      credential: { type: "api_key", key: "test-key" },
    });

    assert.deepEqual(modelIds(models), ["fixture/union-base"]);
    const base = models[0]!;
    assert.equal(base.reasoning, true);
    assert.equal(base.thinkingLevelMap?.off, null);
    assert.equal(base.thinkingLevelMap?.minimal, "low");
    assert.equal(base.thinkingLevelMap?.low, "low");
    assert.equal(base.thinkingLevelMap?.high, "high");
    assert.equal(base.thinkingLevelMap?.xhigh, "xhigh");
    assert.equal(base.thinkingLevelMap?.max, "max");
    assert.equal(
      (base.thinkingLevelMap as Record<string, unknown> | undefined)?.ultra,
      undefined,
      "ultra is not a Pi thinking level",
    );
    // none remains in the union for folding/off mapping and must not erase real strengths
    assert.ok(
      base.thinkingLevelMap?.low === "low",
      "none+low keeps adjustable reasoning with low mapped",
    );
  });

  it("does not invent max when supplemental advertises only ultra", async () => {
    const server = await createFixtureServer({
      supplementalBody: JSON.stringify({
        data: [
          {
            id: "fixture/ultra-only",
            root: "ultra-only",
            supportedReasoningEfforts: ["ultra"],
          },
        ],
      }),
      primaryBody: JSON.stringify({
        data: [
          {
            id: "fixture/ultra-only",
            name: "Ultra Only",
            root: "ultra-only",
            capabilities: { reasoning: true, effort_tiers: ["low"] },
            input_modalities: ["text"],
            output_modalities: ["text"],
            context_length: 8000,
            max_output_tokens: 1000,
          },
        ],
      }),
    });
    servers.push(server);
    process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS = "2000";
    const harness = await boot(server.baseUrl);
    const registration = provider(harness);
    const memory = createMemoryStore();

    const models = await registration.config.refreshModels!({
      store: memory.store,
      allowNetwork: true,
      force: true,
      credential: { type: "api_key", key: "test-key" },
    });
    const base = models.find((model) => model.id === "fixture/ultra-only");
    assert.ok(base);
    assert.equal(base.thinkingLevelMap?.low, "low");
    assert.equal(base.thinkingLevelMap?.max, null);
    assert.equal((base.thinkingLevelMap as Record<string, unknown> | undefined)?.ultra, undefined);
  });

  it("atomic dual-participant: supplemental HTTP failure while primary held cancels primary and writes nothing", async () => {
    const secretKey = "supp-http-fail-secret-key";
    const secretHost = "supp-http-fail-host.example.invalid";
    const server = await createFixtureServer({
      holdPrimary: true,
      supplementalStatus: 503,
      supplementalStatusText: `Unauthorized for ${secretKey} via http://${secretHost}/api/v1/vscode/_/models`,
      supplementalBody: JSON.stringify({
        error: `supplemental body must stay hidden ${secretKey} ${secretHost}`,
      }),
      primaryBody: JSON.stringify({
        data: [
          {
            id: "fixture/should-not-publish",
            name: "Should Not Publish",
            root: "should-not-publish",
            capabilities: { reasoning: true, effort_tiers: ["medium"] },
            input_modalities: ["text"],
            output_modalities: ["text"],
            context_length: 8000,
            max_output_tokens: 1000,
          },
        ],
      }),
    });
    servers.push(server);
    process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS = "2000";
    const harness = await boot(server.baseUrl, secretKey);
    const registration = provider(harness);
    const memory = createMemoryStore({
      checkedAt: Date.now() - 5 * 60 * 60 * 1000,
      models: [storedProviderModel("stale-before-fail", server.baseUrl)],
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await assertAtomicFailureNoWrite(registration, memory, {
        secretKey,
        secretHost,
        baseUrl: server.baseUrl,
        expectMessage: /Model discovery failed with HTTP 503/,
      });
      await server.waitForPrimaryAborts(1, "primary sibling abort observed", 500);
      assert.equal(server.primaryAborts, 1, "held primary must observe abort/close");
      assert.equal(server.responses, 0, "primary must not complete a response");
      assert.equal(server.supplementalResponses, 1);
      assert.equal(unhandled.length, 0, "sibling cancel must not leave unhandled rejections");
    } finally {
      process.off("unhandledRejection", onUnhandled);
      server.setPrimaryHold(false);
    }
  });

  it("atomic dual-participant: primary failure while supplemental held cancels supplemental and writes nothing", async () => {
    const secretKey = "primary-http-fail-secret-key";
    const secretHost = "primary-http-fail-host.example.invalid";
    const server = await createFixtureServer({
      holdSupplemental: true,
      primaryStatus: 401,
      primaryBody: JSON.stringify({
        error: `denied for ${secretKey} at ${secretHost}`,
      }),
      supplementalBody: JSON.stringify({
        data: [
          {
            id: "fixture/should-not-merge",
            root: "should-not-merge",
            supportedReasoningEfforts: ["high"],
          },
        ],
      }),
    });
    servers.push(server);
    process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS = "2000";
    const harness = await boot(server.baseUrl, secretKey);
    const registration = provider(harness);
    const memory = createMemoryStore({
      checkedAt: Date.now() - 5 * 60 * 60 * 1000,
      models: [storedProviderModel("stale-before-primary-fail", server.baseUrl)],
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await assertAtomicFailureNoWrite(registration, memory, {
        secretKey,
        secretHost,
        baseUrl: server.baseUrl,
        expectMessage: /Model discovery failed with HTTP 401/,
      });
      await server.waitForSupplementalAborts(1, "supplemental sibling abort observed", 500);
      assert.equal(server.supplementalAborts, 1, "held supplemental must observe abort/close");
      assert.equal(server.supplementalResponses, 0, "supplemental must not complete a response");
      assert.equal(server.responses, 1);
      assert.equal(unhandled.length, 0, "sibling cancel must not leave unhandled rejections");
    } finally {
      process.off("unhandledRejection", onUnhandled);
      server.setSupplementalHold(false);
    }
  });

  it("atomic dual-participant: supplemental timeout rejects sanitized AbortError and writes nothing", async () => {
    const server = await createFixtureServer({
      holdSupplemental: true,
      primaryBody: JSON.stringify({
        data: [
          {
            id: "fixture/primary-ready",
            name: "Primary Ready",
            root: "primary-ready",
            capabilities: { reasoning: true, effort_tiers: ["medium", "high"] },
            input_modalities: ["text"],
            output_modalities: ["text"],
            context_length: 8000,
            max_output_tokens: 1000,
          },
        ],
      }),
    });
    servers.push(server);
    process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS = "80";
    const harness = await boot(server.baseUrl);
    const registration = provider(harness);
    const memory = createMemoryStore({
      checkedAt: Date.now() - 5 * 60 * 60 * 1000,
      models: [storedProviderModel("stale-before-timeout", server.baseUrl)],
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await assert.rejects(
        registration.config.refreshModels!({
          store: memory.store,
          allowNetwork: true,
          force: true,
          credential: { type: "api_key", key: "test-key" },
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.name, "AbortError");
          assert.doesNotMatch(error.message, /timeout/i);
          assert.doesNotMatch(error.message, /Model discovery failed/i);
          assert.doesNotMatch(
            error.message,
            new RegExp(server.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
          );
          return true;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(unhandled.length, 0, "timeout path must not leave unhandled rejections");
      assert.equal(server.requests, 1);
      assert.equal(server.supplementalRequests, 1);
      assert.equal(server.supplementalResponses, 0);
      assert.equal(server.supplementalResponses, 0, "timed-out supplemental must not complete a response");
      assert.equal(memory.writes.length, 0, "supplemental timeout must not write a new snapshot");
    } finally {
      process.off("unhandledRejection", onUnhandled);
      server.setSupplementalHold(false);
    }
  });

  it("atomic dual-participant: supplemental timeout aborts held primary and writes nothing", async () => {
    const server = await createFixtureServer({
      holdPrimary: true,
      holdSupplemental: true,
      primaryBody: JSON.stringify({
        data: [
          {
            id: "fixture/timeout-held-primary",
            name: "Timeout Held Primary",
            root: "timeout-held-primary",
            capabilities: { reasoning: true, effort_tiers: ["medium"] },
            input_modalities: ["text"],
            output_modalities: ["text"],
            context_length: 8000,
            max_output_tokens: 1000,
          },
        ],
      }),
    });
    servers.push(server);
    process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS = "60";
    const harness = await boot(server.baseUrl);
    const registration = provider(harness);
    const memory = createMemoryStore({
      checkedAt: Date.now() - 5 * 60 * 60 * 1000,
      models: [storedProviderModel("stale-before-held-timeout", server.baseUrl)],
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await assertAtomicFailureNoWrite(registration, memory, {
        expectAbort: true,
        baseUrl: server.baseUrl,
      });
      await Promise.all([
        server.waitForPrimaryAborts(1, "held primary aborted on timeout path", 500),
        server.waitForSupplementalAborts(1, "held supplemental aborted on timeout path", 500),
      ]);
      assert.equal(server.responses, 0, "primary must not complete a response");
      assert.equal(server.supplementalResponses, 0, "supplemental must not complete a response");
      assert.equal(unhandled.length, 0, "timeout sibling cancel must not leave unhandled rejections");
    } finally {
      process.off("unhandledRejection", onUnhandled);
      server.setPrimaryHold(false);
      server.setSupplementalHold(false);
    }
  });

  it("atomic dual-participant: supplemental invalid JSON and missing/non-array data write nothing", async () => {
    const secretKey = "supp-invalid-body-secret";
    const endpointMarker = "supp-invalid-body-endpoint.example.invalid";
    const cases = [
      {
        label: "invalid JSON",
        body: `{not-json leaked key=${secretKey} endpoint=http://${endpointMarker}/api/v1/vscode/_/models`,
        expectMessage: "Model discovery failed with HTTP 200: invalid response body",
      },
      {
        label: "missing data",
        body: JSON.stringify({ models: [] }),
        expectMessage: "Model discovery failed with HTTP 200: invalid response body",
      },
      {
        label: "non-array data",
        body: JSON.stringify({ data: { id: "not-an-array" } }),
        expectMessage: "Model discovery failed with HTTP 200: invalid response body",
      },
    ];

    for (const testCase of cases) {
      const server = await createFixtureServer({
        supplementalBody: testCase.body,
        primaryBody: JSON.stringify({
          data: [
            {
              id: "fixture/should-not-publish-invalid-supp",
              name: "Should Not Publish",
              root: "should-not-publish-invalid-supp",
              capabilities: { reasoning: true, effort_tiers: ["low"] },
              input_modalities: ["text"],
              output_modalities: ["text"],
              context_length: 8000,
              max_output_tokens: 1000,
            },
          ],
        }),
      });
      servers.push(server);
      process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS = "2000";
      const harness = await boot(server.baseUrl, secretKey);
      const registration = provider(harness);
      const memory = createMemoryStore({
        checkedAt: Date.now() - 5 * 60 * 60 * 1000,
        models: [storedProviderModel(`stale-${testCase.label}`, server.baseUrl)],
      });

      await assert.rejects(
        registration.config.refreshModels!({
          store: memory.store,
          allowNetwork: true,
          force: true,
          credential: { type: "api_key", key: secretKey },
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error, testCase.label);
          assert.equal(error.message, testCase.expectMessage, testCase.label);
          assert.doesNotMatch(error.message, new RegExp(secretKey));
          assert.doesNotMatch(error.message, new RegExp(endpointMarker));
          assert.doesNotMatch(error.message, /not-json|Authorization|Bearer |leaked key|SyntaxError|Unexpected/i);
          assert.doesNotMatch(
            error.message,
            new RegExp(server.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
          );
          return true;
        },
      );
      assert.equal(memory.writes.length, 0, `${testCase.label}: no write`);
    }
  });

  it("atomic dual-participant: primary row-level invalid shapes fail sanitized invalid body and write nothing", async () => {
    const secretKey = "primary-row-invalid-secret";
    const endpointMarker = "primary-row-invalid-endpoint.example.invalid";
    const cases = [
      {
        label: "primary data contains null",
        data: [null],
      },
      {
        label: "primary non-string id",
        data: [
          {
            id: 42,
            name: "Numeric Id",
            root: "numeric-id",
            input_modalities: ["text"],
            output_modalities: ["text"],
            context_length: 8000,
            max_output_tokens: 1000,
          },
        ],
      },
      {
        label: "primary empty id",
        data: [
          {
            id: "",
            name: "Empty Id",
            root: "empty-id",
            input_modalities: ["text"],
            output_modalities: ["text"],
            context_length: 8000,
            max_output_tokens: 1000,
          },
        ],
      },
      {
        label: "primary invalid identity type",
        data: [
          {
            id: "fixture/bad-name-type",
            name: 123,
            root: "bad-name-type",
            input_modalities: ["text"],
            output_modalities: ["text"],
            context_length: 8000,
            max_output_tokens: 1000,
          },
        ],
      },
      {
        label: "primary invalid modalities type",
        data: [
          {
            id: "fixture/bad-modalities",
            name: "Bad Modalities",
            root: "bad-modalities",
            input_modalities: "text",
            output_modalities: ["text"],
            context_length: 8000,
            max_output_tokens: 1000,
          },
        ],
      },
      {
        label: "primary invalid capabilities type",
        data: [
          {
            id: "fixture/bad-capabilities",
            name: "Bad Capabilities",
            root: "bad-capabilities",
            capabilities: ["not-a-record"],
            input_modalities: ["text"],
            output_modalities: ["text"],
            context_length: 8000,
            max_output_tokens: 1000,
          },
        ],
      },
      {
        label: "primary invalid numeric limit type",
        data: [
          {
            id: "fixture/bad-context-length",
            name: "Bad Context Length",
            root: "bad-context-length",
            input_modalities: ["text"],
            output_modalities: ["text"],
            context_length: "8000",
            max_output_tokens: 1000,
          },
        ],
      },
    ];

    for (const testCase of cases) {
      const server = await createFixtureServer({
        holdSupplemental: true,
        primaryBody: JSON.stringify({ data: testCase.data }),
        supplementalBody: JSON.stringify({
          data: [
            {
              id: "fixture/should-not-merge-after-primary-row-invalid",
              root: "should-not-merge-after-primary-row-invalid",
              supportedReasoningEfforts: ["high"],
            },
          ],
        }),
      });
      servers.push(server);
      process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS = "2000";
      const harness = await boot(server.baseUrl, secretKey);
      const registration = provider(harness);
      const memory = createMemoryStore({
        checkedAt: Date.now() - 5 * 60 * 60 * 1000,
        models: [storedProviderModel(`stale-primary-row-${testCase.label}`, server.baseUrl)],
      });

      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);
      try {
        await assertAtomicFailureNoWrite(registration, memory, {
          secretKey,
          secretHost: endpointMarker,
          baseUrl: server.baseUrl,
          expectMessage: "Model discovery failed with HTTP 200: invalid response body",
        });
        await server.waitForSupplementalAborts(1, `${testCase.label}: supplemental sibling abort observed`, 500);
        assert.equal(server.supplementalAborts, 1, `${testCase.label}: held supplemental must observe abort/close`);
        assert.equal(server.supplementalResponses, 0, `${testCase.label}: supplemental must not complete a response`);
        assert.equal(server.responses, 1, `${testCase.label}: primary response completed`);
        assert.equal(unhandled.length, 0, `${testCase.label}: sibling cancel must not leave unhandled rejections`);
        assert.doesNotMatch(
          String(unhandled[0] ?? ""),
          /TypeError|Cannot read|undefined is not/i,
        );
      } finally {
        process.off("unhandledRejection", onUnhandled);
        server.setSupplementalHold(false);
      }
    }
  });

  it("atomic dual-participant: supplemental row-level invalid shapes fail sanitized invalid body and write nothing", async () => {
    const secretKey = "supp-row-invalid-secret";
    const endpointMarker = "supp-row-invalid-endpoint.example.invalid";
    const cases = [
      {
        label: "supplemental data contains null",
        data: [null],
      },
      {
        label: "supplemental non-string id",
        data: [
          {
            id: 99,
            root: "numeric-supp-id",
            supportedReasoningEfforts: ["medium"],
          },
        ],
      },
      {
        label: "supplemental invalid root type",
        data: [
          {
            id: "fixture/bad-supp-root",
            root: { nested: true },
            supportedReasoningEfforts: ["medium"],
          },
        ],
      },
      {
        label: "supplemental invalid parent type",
        data: [
          {
            id: "fixture/bad-supp-parent",
            root: "bad-supp-parent",
            parent: 7,
            supportedReasoningEfforts: ["medium"],
          },
        ],
      },
      {
        label: "supplemental nested config shape must not throw",
        data: [
          {
            id: "fixture/nested-config-array",
            root: "nested-config-array",
            // Unsupported nested config shapes must fail closed at validation
            // without TypeError leakage when later parsers would otherwise throw.
            configSchema: [],
            configurationSchema: "not-a-record",
            supportedReasoningEfforts: ["medium"],
          },
        ],
      },
    ];

    for (const testCase of cases) {
      const server = await createFixtureServer({
        holdPrimary: true,
        supplementalBody: JSON.stringify({ data: testCase.data }),
        primaryBody: JSON.stringify({
          data: [
            {
              id: "fixture/should-not-publish-after-supp-row-invalid",
              name: "Should Not Publish",
              root: "should-not-publish-after-supp-row-invalid",
              capabilities: { reasoning: true, effort_tiers: ["low"] },
              input_modalities: ["text"],
              output_modalities: ["text"],
              context_length: 8000,
              max_output_tokens: 1000,
            },
          ],
        }),
      });
      servers.push(server);
      process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS = "2000";
      const harness = await boot(server.baseUrl, secretKey);
      const registration = provider(harness);
      const memory = createMemoryStore({
        checkedAt: Date.now() - 5 * 60 * 60 * 1000,
        models: [storedProviderModel(`stale-supp-row-${testCase.label}`, server.baseUrl)],
      });

      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);
      try {
        await assertAtomicFailureNoWrite(registration, memory, {
          secretKey,
          secretHost: endpointMarker,
          baseUrl: server.baseUrl,
          expectMessage: "Model discovery failed with HTTP 200: invalid response body",
        });
        await server.waitForPrimaryAborts(1, `${testCase.label}: primary sibling abort observed`, 500);
        assert.equal(server.primaryAborts, 1, `${testCase.label}: held primary must observe abort/close`);
        assert.equal(server.responses, 0, `${testCase.label}: primary must not complete a response`);
        assert.equal(server.supplementalResponses, 1, `${testCase.label}: supplemental response completed`);
        assert.equal(unhandled.length, 0, `${testCase.label}: sibling cancel must not leave unhandled rejections`);
      } finally {
        process.off("unhandledRejection", onUnhandled);
        server.setPrimaryHold(false);
      }
    }
  });

  it("atomic dual-participant: valid supplemental empty array succeeds and writes atomic snapshot", async () => {
    const server = await createFixtureServer({
      supplementalBody: JSON.stringify({ data: [] }),
      primaryBody: JSON.stringify({
        data: [
          {
            id: "fixture/empty-supp-ok",
            name: "Empty Supplemental OK",
            root: "empty-supp-ok",
            capabilities: { reasoning: true, effort_tiers: ["medium"] },
            input_modalities: ["text"],
            output_modalities: ["text"],
            context_length: 8800,
            max_output_tokens: 1200,
          },
        ],
      }),
    });
    servers.push(server);
    process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS = "2000";
    const harness = await boot(server.baseUrl);
    const registration = provider(harness);
    const memory = createMemoryStore();

    const models = await registration.config.refreshModels!({
      store: memory.store,
      allowNetwork: true,
      force: true,
      credential: { type: "api_key", key: "test-key" },
    });

    assert.deepEqual(modelIds(models), ["fixture/empty-supp-ok"]);
    const model = models[0]!;
    assert.equal(model.reasoning, true);
    assert.equal(model.thinkingLevelMap?.medium, "medium");
    assert.equal(server.requests, 1);
    assert.equal(server.supplementalResponses, 1);
    assert.equal(memory.writes.length, 1);
  });

  it("atomic dual-participant: simultaneous success remains merged into one snapshot", async () => {
    const server = await createFixtureServer({
      supplementalBody: JSON.stringify({
        data: [
          {
            id: "fixture/simultaneous-base",
            root: "simultaneous-base",
            supportedReasoningEfforts: ["high", "max"],
          },
        ],
      }),
      primaryBody: JSON.stringify({
        data: [
          {
            id: "fixture/simultaneous-base",
            name: "Simultaneous Base",
            root: "simultaneous-base",
            capabilities: { reasoning: true, effort_tiers: ["low", "medium"] },
            input_modalities: ["text"],
            output_modalities: ["text"],
            context_length: 12000,
            max_output_tokens: 2000,
          },
        ],
      }),
    });
    servers.push(server);
    process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS = "2000";
    const harness = await boot(server.baseUrl);
    const registration = provider(harness);
    const memory = createMemoryStore();

    const models = await registration.config.refreshModels!({
      store: memory.store,
      allowNetwork: true,
      force: true,
      credential: { type: "api_key", key: "test-key" },
    });

    assert.deepEqual(modelIds(models), ["fixture/simultaneous-base"]);
    const base = models[0]!;
    assert.equal(base.reasoning, true);
    assert.equal(base.thinkingLevelMap?.low, "low");
    assert.equal(base.thinkingLevelMap?.medium, "medium");
    assert.equal(base.thinkingLevelMap?.high, "high");
    assert.equal(base.thinkingLevelMap?.max, "max");
    assert.equal(server.requests, 1);
    assert.equal(server.supplementalRequests, 1);
    assert.equal(server.supplementalResponses, 1);
    assert.equal(memory.writes.length, 1);
  });

  it("does not rewrite DeepSeek xhigh to max", async () => {
    const server = await createFixtureServer({
      supplementalBody: JSON.stringify({ data: [] }),
      primaryBody: JSON.stringify({
        data: [
          {
            id: "deepseek/r1",
            name: "DeepSeek R1",
            root: "r1",
            family: "deepseek-thinking",
            capabilities: { reasoning: true, effort_tiers: ["high", "xhigh"] },
            input_modalities: ["text"],
            output_modalities: ["text"],
            context_length: 64000,
            max_output_tokens: 8000,
          },
        ],
      }),
    });
    servers.push(server);
    process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS = "2000";
    const harness = await boot(server.baseUrl);
    const registration = provider(harness);
    const memory = createMemoryStore();

    const models = await registration.config.refreshModels!({
      store: memory.store,
      allowNetwork: true,
      force: true,
      credential: { type: "api_key", key: "test-key" },
    });
    const model = models.find((entry) => entry.id === "deepseek/r1");
    assert.ok(model);
    assert.equal(model.thinkingLevelMap?.xhigh, "xhigh");
    assert.equal(model.thinkingLevelMap?.max, null);
  });

  it("fail-closed: empty store + primary reasoning=true with no fresh efforts => reasoning false and no map", async () => {
    const server = await createFixtureServer({
      supplementalBody: JSON.stringify({ data: [] }),
      primaryBody: JSON.stringify({
        data: [
          {
            id: "fixture/no-effort",
            name: "No Effort",
            root: "no-effort",
            capabilities: { reasoning: true, thinking: true },
            input_modalities: ["text"],
            output_modalities: ["text"],
            context_length: 9000,
            max_output_tokens: 1100,
          },
        ],
      }),
    });
    servers.push(server);
    process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS = "2000";
    const harness = await boot(server.baseUrl);
    const registration = provider(harness);
    const memory = createMemoryStore();

    const models = await registration.config.refreshModels!({
      store: memory.store,
      allowNetwork: true,
      force: true,
      credential: { type: "api_key", key: "test-key" },
    });

    assert.deepEqual(modelIds(models), ["fixture/no-effort"]);
    const model = models[0]!;
    assert.equal(model.reasoning, false);
    assert.equal(model.thinkingLevelMap, undefined);
    assert.equal(model.contextWindow, 9000);
    assert.equal(model.maxTokens, 1100);
    assert.equal(memory.writes.length, 1);
    const written = memory.writes[0]!.models[0] as {
      reasoning?: boolean;
      thinkingLevelMap?: unknown;
      contextWindow?: number;
      maxTokens?: number;
    };
    assert.equal(written.reasoning, false);
    assert.equal(written.thinkingLevelMap, undefined);
    assert.equal(written.contextWindow, 9000);
    assert.equal(written.maxTokens, 1100);
  });

  it("fail-closed: fresh sources yield only none => retained, reasoning false, no map, atomic write", async () => {
    const cases = [
      {
        label: "primary effort_tiers only none",
        primaryData: [
          {
            id: "fixture/none-only-primary",
            name: "None Only Primary",
            root: "none-only-primary",
            capabilities: { reasoning: true, effort_tiers: ["none"] },
            input_modalities: ["text"],
            output_modalities: ["text"],
            context_length: 9100,
            max_output_tokens: 1200,
          },
        ],
        supplemental: { data: [] },
        expectedId: "fixture/none-only-primary",
        expectedContext: 9100,
        expectedMaxTokens: 1200,
      },
      {
        label: "supplemental only none",
        primaryData: [
          {
            id: "fixture/none-only-supp",
            name: "None Only Supplemental",
            root: "none-only-supp",
            capabilities: { reasoning: true },
            input_modalities: ["text"],
            output_modalities: ["text"],
            context_length: 9200,
            max_output_tokens: 1300,
          },
        ],
        supplemental: {
          data: [
            {
              id: "fixture/none-only-supp",
              root: "none-only-supp",
              supportedReasoningEfforts: ["none"],
            },
          ],
        },
        expectedId: "fixture/none-only-supp",
        expectedContext: 9200,
        expectedMaxTokens: 1300,
      },
      {
        label: "verified -none suffix only",
        primaryData: [
          {
            id: "fixture/none-fold",
            name: "None Fold Base",
            root: "none-fold",
            capabilities: { reasoning: true },
            input_modalities: ["text"],
            output_modalities: ["text"],
            context_length: 9300,
            max_output_tokens: 1400,
          },
          {
            id: "fixture/none-fold-none",
            name: "None Fold Variant",
            root: "none-fold",
            capabilities: { reasoning: true },
            input_modalities: ["text"],
            output_modalities: ["text"],
            context_length: 9300,
            max_output_tokens: 1400,
          },
        ],
        supplemental: { data: [] },
        expectedId: "fixture/none-fold",
        expectedContext: 9300,
        expectedMaxTokens: 1400,
        foldedAway: "fixture/none-fold-none",
      },
    ];

    for (const testCase of cases) {
      const server = await createFixtureServer({
        supplementalBody: JSON.stringify(testCase.supplemental),
        primaryBody: JSON.stringify({ data: testCase.primaryData }),
      });
      servers.push(server);
      process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS = "2000";
      const harness = await boot(server.baseUrl);
      const registration = provider(harness);
      const memory = createMemoryStore();

      const models = await registration.config.refreshModels!({
        store: memory.store,
        allowNetwork: true,
        force: true,
        credential: { type: "api_key", key: "test-key" },
      });

      assert.ok(
        models.some((entry) => entry.id === testCase.expectedId),
        `${testCase.label}: model retained`,
      );
      if (testCase.foldedAway) {
        assert.ok(
          !models.some((entry) => entry.id === testCase.foldedAway),
          `${testCase.label}: -none suffix still folds into base`,
        );
      }
      const model = models.find((entry) => entry.id === testCase.expectedId)!;
      assert.equal(model.reasoning, false, testCase.label);
      assert.equal(model.thinkingLevelMap, undefined, testCase.label);
      assert.equal(model.contextWindow, testCase.expectedContext, testCase.label);
      assert.equal(model.maxTokens, testCase.expectedMaxTokens, testCase.label);
      assert.equal(memory.writes.length, 1, testCase.label);
      const writtenModels = memory.writes[0]!.models as Array<{
        id: string;
        reasoning?: boolean;
        thinkingLevelMap?: unknown;
        contextWindow?: number;
        maxTokens?: number;
      }>;
      const written = writtenModels.find((model) => model.id === testCase.expectedId);
      assert.ok(written, testCase.label);
      assert.equal(written.reasoning, false, testCase.label);
      assert.equal(written.thinkingLevelMap, undefined, testCase.label);
      assert.equal(written.contextWindow, testCase.expectedContext, testCase.label);
      assert.equal(written.maxTokens, testCase.expectedMaxTokens, testCase.label);
    }
  });

  it("atomic snapshot: successful empty primary clears stale store models and writes empty snapshot", async () => {
    const server = await createFixtureServer({
      supplementalBody: JSON.stringify({ data: [] }),
      primaryBody: JSON.stringify({ data: [] }),
    });
    servers.push(server);
    process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS = "2000";
    const harness = await boot(server.baseUrl);
    const registration = provider(harness);
    const memory = createMemoryStore({
      checkedAt: Date.now() - 5 * 60 * 60 * 1000,
      models: [
        {
          ...storedProviderModel("stale/keep-me", server.baseUrl, "Stale Keep Me"),
          reasoning: true,
          thinkingLevelMap: {
            off: null,
            minimal: "low",
            low: "low",
            medium: "medium",
            high: "high",
            xhigh: "xhigh",
            max: "max",
          },
        },
      ],
    });

    const models = await registration.config.refreshModels!({
      store: memory.store,
      allowNetwork: true,
      force: true,
      credential: { type: "api_key", key: "test-key" },
    });

    assert.deepEqual(models, []);
    assert.ok(!modelIds(models).includes("stale/keep-me"));
    assert.ok(memory.writes.length >= 1);
    const written = memory.writes[memory.writes.length - 1]!;
    assert.deepEqual(written.models, []);
    assert.equal(typeof written.checkedAt, "number");
    assert.ok((written.checkedAt ?? 0) > Date.now() - 10_000);

    const reread = await memory.store.read();
    assert.deepEqual(reread?.models, []);
    assert.equal(reread?.checkedAt, written.checkedAt);
  });

  it("atomic snapshot: stale rich same-ID store is not merged into fresh no-effort gateway data", async () => {
    const server = await createFixtureServer({
      supplementalBody: JSON.stringify({ data: [] }),
      primaryBody: JSON.stringify({
        data: [
          {
            id: "fixture/same-id",
            name: "Fresh Same Id",
            root: "same-id",
            capabilities: { reasoning: true },
            input_modalities: ["text"],
            output_modalities: ["text"],
            context_length: 12345,
            max_output_tokens: 678,
          },
        ],
      }),
    });
    servers.push(server);
    process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS = "2000";
    const harness = await boot(server.baseUrl);
    const registration = provider(harness);
    const memory = createMemoryStore({
      checkedAt: Date.now() - 5 * 60 * 60 * 1000,
      models: [
        {
          ...storedProviderModel("fixture/same-id", server.baseUrl, "Stale Same Id"),
          reasoning: true,
          contextWindow: 99999,
          maxTokens: 9999,
          thinkingLevelMap: {
            off: null,
            minimal: "low",
            low: "low",
            medium: "medium",
            high: "high",
            xhigh: "xhigh",
            max: "max",
          },
        },
      ],
    });

    const models = await registration.config.refreshModels!({
      store: memory.store,
      allowNetwork: true,
      force: true,
      credential: { type: "api_key", key: "test-key" },
    });

    assert.deepEqual(modelIds(models), ["fixture/same-id"]);
    const model = models[0]!;
    assert.equal(model.reasoning, false);
    assert.equal(model.thinkingLevelMap, undefined);
    assert.equal(model.contextWindow, 12345);
    assert.equal(model.maxTokens, 678);
    assert.equal(model.name, "same-id");
    assert.ok(memory.writes.length >= 1);
    const written = memory.writes[memory.writes.length - 1]!.models[0] as {
      reasoning?: boolean;
      thinkingLevelMap?: unknown;
      contextWindow?: number;
      maxTokens?: number;
      name?: string;
    };
    assert.equal(written.reasoning, false);
    assert.equal(written.thinkingLevelMap, undefined);
    assert.equal(written.contextWindow, 12345);
    assert.equal(written.maxTokens, 678);
    assert.equal(written.name, "same-id");
  });

  it("adjustable reasoning is true with map when any fresh source contributes recognized efforts", async () => {
    const cases = [
      {
        label: "primary effort_tiers",
        primary: {
          id: "fixture/from-primary",
          name: "From Primary",
          root: "from-primary",
          capabilities: { reasoning: true, effort_tiers: ["medium"] },
          input_modalities: ["text"],
          output_modalities: ["text"],
          context_length: 8000,
          max_output_tokens: 1000,
        },
        supplemental: { data: [] },
        expectedId: "fixture/from-primary",
        expectedKey: "medium" as const,
      },
      {
        label: "verified primary suffix variant",
        primaryData: [
          {
            id: "fixture/from-suffix",
            name: "From Suffix",
            root: "from-suffix",
            capabilities: { reasoning: true },
            input_modalities: ["text"],
            output_modalities: ["text"],
            context_length: 8000,
            max_output_tokens: 1000,
          },
          {
            id: "fixture/from-suffix-high",
            name: "From Suffix High",
            root: "from-suffix",
            capabilities: { reasoning: true },
            input_modalities: ["text"],
            output_modalities: ["text"],
            context_length: 8000,
            max_output_tokens: 1000,
          },
        ],
        supplemental: { data: [] },
        expectedId: "fixture/from-suffix",
        expectedKey: "high" as const,
      },
      {
        label: "supplemental metadata",
        primary: {
          id: "fixture/from-supp",
          name: "From Supplemental",
          root: "from-supp",
          capabilities: { reasoning: true },
          input_modalities: ["text"],
          output_modalities: ["text"],
          context_length: 8000,
          max_output_tokens: 1000,
        },
        supplemental: {
          data: [
            {
              id: "fixture/from-supp",
              root: "from-supp",
              supportedReasoningEfforts: ["low"],
            },
          ],
        },
        expectedId: "fixture/from-supp",
        expectedKey: "low" as const,
      },
    ];

    for (const testCase of cases) {
      const primaryData = "primaryData" in testCase && testCase.primaryData ? testCase.primaryData : [testCase.primary];
      const server = await createFixtureServer({
        supplementalBody: JSON.stringify(testCase.supplemental),
        primaryBody: JSON.stringify({ data: primaryData }),
      });
      servers.push(server);
      process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS = "2000";
      const harness = await boot(server.baseUrl);
      const registration = provider(harness);
      const memory = createMemoryStore();

      const models = await registration.config.refreshModels!({
        store: memory.store,
        allowNetwork: true,
        force: true,
        credential: { type: "api_key", key: "test-key" },
      });

      const model = models.find((entry) => entry.id === testCase.expectedId);
      assert.ok(model, testCase.label);
      assert.equal(model.reasoning, true, testCase.label);
      assert.ok(model.thinkingLevelMap, testCase.label);
      assert.equal(model.thinkingLevelMap?.[testCase.expectedKey], testCase.expectedKey, testCase.label);
    }
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
      assert.equal(error.name, "AbortError");
      assert.doesNotMatch(error.message, /^timeout$/i);
      return true;
    });
    assert.equal(memory.writes.length, 0);
    server.releaseModelResponses();
  });

  it("independent timeout before response headers yields AbortError without leaking timeout reason", async () => {
    const server = await createFixtureServer({ holdPrimary: true });
    servers.push(server);
    process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS = "40";
    const harness = await boot(server.baseUrl);
    const registration = provider(harness);
    const memory = createMemoryStore();

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await assert.rejects(
        registration.config.refreshModels!({
          store: memory.store,
          allowNetwork: true,
          force: true,
          credential: { type: "api_key", key: "test-key" },
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.name, "AbortError");
          assert.doesNotMatch(error.message, /timeout/i);
          assert.doesNotMatch(error.message, /Model discovery failed/i);
          return true;
        },
      );
      // Allow any delayed rejection to surface if present.
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(unhandled.length, 0, "timeout path must not leave unhandled rejections");
      assert.equal(memory.writes.length, 0);
      assert.equal(server.responses, 0, "headers must still be withheld");
    } finally {
      process.off("unhandledRejection", onUnhandled);
      server.releaseModelResponses();
    }
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

  it("sanitizes HTTP 200 malformed JSON that echoes credential and endpoint markers", async () => {
    const secretKey = "malformed-json-secret-key-9f3a";
    const endpointMarker = "malformed-json-endpoint-marker.example.invalid";
    const malformedBody =
      `{not-json leaked key=${secretKey} endpoint=http://${endpointMarker}/v1/models?prefix=alias Authorization=Bearer ${secretKey}`;
    const server = await createFixtureServer({
      primaryStatus: 200,
      primaryBody: malformedBody,
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
          assert.equal(error.message, "Model discovery failed with HTTP 200: invalid response body");
          assert.doesNotMatch(error.message, new RegExp(secretKey));
          assert.doesNotMatch(error.message, new RegExp(endpointMarker));
          assert.doesNotMatch(error.message, /not-json|Authorization|Bearer |leaked key|SyntaxError|Unexpected/i);
          assert.doesNotMatch(
            error.message,
            new RegExp(server.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
          );
          return true;
        },
      );
    });

    assert.equal(warns.length, 0, "discovery failures must not console.warn");
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

  it("empty store + valid legacy: failed online dual discovery rejects with zero store writes and keeps the legacy file", async () => {
    const secretKey = "legacy-fail-online-secret-key";
    const secretHost = "legacy-fail-online-host.example.invalid";
    const server = await createFixtureServer({
      supplementalStatus: 503,
      supplementalBody: JSON.stringify({
        error: `supplemental body must stay hidden ${secretKey} ${secretHost}`,
      }),
      primaryBody: JSON.stringify({
        data: [
          {
            id: "fixture/should-not-publish",
            name: "Should Not Publish",
            root: "should-not-publish",
            capabilities: { reasoning: true, effort_tiers: ["medium"] },
            input_modalities: ["text"],
            output_modalities: ["text"],
            context_length: 8000,
            max_output_tokens: 1000,
          },
        ],
      }),
    });
    servers.push(server);
    const cachePath = join(tempDir, "legacy-empty-store-fail-online.json");
    await writeFile(
      cachePath,
      createValidCacheJson(server.baseUrl, "legacy-only-model", {
        fetchedAt: "2020-01-01T00:00:00.000Z",
        models: [normalizedCacheModel("legacy-only-model", "Legacy Only")],
      }),
    );
    process.env.OMNIROUTE_BASE_URL = server.baseUrl;
    process.env.OMNIROUTE_API_KEY = secretKey;
    process.env.OMNIROUTE_MODEL_CACHE_PATH = cachePath;
    process.env.PI_CODING_AGENT_DIR = tempDir;
    process.env.OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS = "2000";

    const harness = createHarness();
    await extension(harness.api);
    const registration = provider(harness);
    const memory = createMemoryStore();

    await assert.rejects(
      registration.config.refreshModels!({
        store: memory.store,
        allowNetwork: true,
        force: false,
        credential: { type: "api_key", key: secretKey },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.notEqual(error.name, "AbortError");
        assert.match(error.message, /Model discovery failed with HTTP 503/);
        assert.doesNotMatch(error.message, new RegExp(secretKey));
        assert.doesNotMatch(error.message, new RegExp(secretHost));
        assert.doesNotMatch(
          error.message,
          new RegExp(server.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        );
        return true;
      },
    );

    assert.equal(memory.writes.length, 0, "failed online refresh must not import legacy into the store");
    assert.equal(memory.deletes, 0);
    assert.equal(await memory.store.read(), undefined, "store must remain empty; no partial snapshot");
    const remaining = await readFile(cachePath, "utf8");
    assert.match(remaining, /legacy-only-model/);
    assert.doesNotMatch(remaining, new RegExp(secretKey));
  });

  it("excludes exact synthetic ultra alias IDs while retaining same-root different-provider IDs", async () => {
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
            id: "cx/gpt-5.6-sol-ultra",
            root: "gpt-5.6-sol-ultra",
            owned_by: "codex",
            input_modalities: ["text"],
            output_modalities: ["text"],
          },
          {
            id: "codex/gpt-5.6-terra-ultra",
            root: "gpt-5.6-terra-ultra",
            owned_by: "codex",
            input_modalities: ["text"],
            output_modalities: ["text"],
          },
          {
            id: "cx/gpt-5.6-terra-ultra",
            root: "gpt-5.6-terra-ultra",
            owned_by: "codex",
            input_modalities: ["text"],
            output_modalities: ["text"],
          },
          {
            // Same root as an excluded alias, different provider prefix — must remain.
            id: "openai/gpt-5.6-sol-ultra",
            root: "gpt-5.6-sol-ultra",
            owned_by: "openai",
            capabilities: { reasoning: true, effort_tiers: ["low", "high"] },
            input_modalities: ["text"],
            output_modalities: ["text"],
            context_length: 16000,
            max_output_tokens: 2000,
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
    assert.deepEqual(ids, ["openai/gpt-5.6-sol-ultra", "vendor/model"]);
    for (const excluded of [
      "codex/gpt-5.6-sol-ultra",
      "cx/gpt-5.6-sol-ultra",
      "codex/gpt-5.6-terra-ultra",
      "cx/gpt-5.6-terra-ultra",
    ]) {
      assert.ok(!ids.includes(excluded), excluded);
    }
    const retained = models.find((model) => model.id === "openai/gpt-5.6-sol-ultra");
    assert.ok(retained);
    assert.equal(retained.reasoning, true);
    assert.equal(retained.thinkingLevelMap?.low, "low");
    assert.equal(retained.thinkingLevelMap?.high, "high");
    const folded = models.find((model) => model.id === "vendor/model");
    assert.ok(folded);
    assert.equal(folded.reasoning, true);
    assert.equal(folded.thinkingLevelMap?.high, "high");
    assert.equal(folded.thinkingLevelMap?.max, "max");
  });

  it("store restore requires strict complete thinkingLevelMap and fails closed on incomplete/extra maps", async () => {
    const baseUrl = "http://127.0.0.1:9/v1";
    const harness = await boot(baseUrl);
    const registration = provider(harness);
    const allNullMap = fullThinkingMap();
    const validMap = fullThinkingMap({ minimal: "low", low: "low", high: "high" });
    const incompleteMap = {
      off: null,
      minimal: "low",
      low: "low",
      medium: null,
      high: null,
      // missing xhigh/max intentionally
    };
    const extraMap = {
      ...validMap,
      ultra: "max",
    };
    const garbageMap = fullThinkingMap({ low: "low", high: "garbage" });
    const wrongLevelMap = fullThinkingMap({ low: "low", high: "low" });
    const memory = createMemoryStore({
      checkedAt: Date.now(),
      models: [
        {
          ...storedProviderModel("store/all-null", baseUrl, "All Null"),
          reasoning: true,
          thinkingLevelMap: allNullMap,
        },
        {
          ...storedProviderModel("store/missing-map", baseUrl, "Missing Map"),
          reasoning: true,
        },
        {
          ...storedProviderModel("store/incomplete-map", baseUrl, "Incomplete Map"),
          reasoning: true,
          thinkingLevelMap: incompleteMap,
        },
        {
          ...storedProviderModel("store/extra-map", baseUrl, "Extra Map"),
          reasoning: true,
          thinkingLevelMap: extraMap,
        },
        {
          ...storedProviderModel("store/garbage-map", baseUrl, "Garbage Map"),
          reasoning: true,
          thinkingLevelMap: garbageMap,
        },
        {
          ...storedProviderModel("store/wrong-level-map", baseUrl, "Wrong Level Map"),
          reasoning: true,
          thinkingLevelMap: wrongLevelMap,
        },
        {
          ...storedProviderModel("store/valid-map", baseUrl, "Valid Map"),
          reasoning: true,
          thinkingLevelMap: validMap,
        },
      ],
    });

    const models = await registration.config.refreshModels!({
      store: memory.store,
      allowNetwork: false,
    });

    const byId = new Map(models.map((model) => [model.id, model]));
    for (const id of [
      "store/all-null",
      "store/missing-map",
      "store/incomplete-map",
      "store/extra-map",
      "store/garbage-map",
      "store/wrong-level-map",
    ]) {
      assert.equal(byId.get(id)?.reasoning, false, id);
      assert.equal(byId.get(id)?.thinkingLevelMap, undefined, id);
    }
    assert.equal(byId.get("store/valid-map")?.reasoning, true);
    assert.equal(byId.get("store/valid-map")?.thinkingLevelMap?.low, "low");
    assert.equal(byId.get("store/valid-map")?.thinkingLevelMap?.high, "high");
    assert.equal(
      (byId.get("store/valid-map")?.thinkingLevelMap as Record<string, unknown> | undefined)?.ultra,
      undefined,
    );
    assert.equal(memory.writes.length, 0, "offline store projection must not rewrite store");
  });

  it("legacy restore requires strict complete thinkingLevelMap and fails closed on incomplete/extra maps", async () => {
    const baseUrl = "http://127.0.0.1:9/v1";
    const cachePath = join(tempDir, "legacy-reasoning-sanitize-cache.json");
    const allNullMap = fullThinkingMap();
    const validMap = fullThinkingMap({ minimal: "low", low: "low", medium: "medium" });
    const incompleteMap = {
      off: null,
      minimal: "low",
      low: "low",
      medium: null,
      high: null,
    };
    const extraMap = {
      ...validMap,
      ultra: "max",
    };
    const garbageMap = fullThinkingMap({ low: "low", high: "garbage" });
    const wrongLevelMap = fullThinkingMap({ low: "low", high: "low" });
    await writeFile(
      cachePath,
      createValidCacheJson(baseUrl, "legacy/keep", {
        models: [
          {
            ...normalizedCacheModel("legacy/all-null", "All Null"),
            reasoning: true,
            thinkingLevelMap: allNullMap,
          },
          {
            ...normalizedCacheModel("legacy/missing-map", "Missing Map"),
            reasoning: true,
          },
          {
            ...normalizedCacheModel("legacy/incomplete-map", "Incomplete Map"),
            reasoning: true,
            thinkingLevelMap: incompleteMap,
          },
          {
            ...normalizedCacheModel("legacy/extra-map", "Extra Map"),
            reasoning: true,
            thinkingLevelMap: extraMap,
          },
          {
            ...normalizedCacheModel("legacy/garbage-map", "Garbage Map"),
            reasoning: true,
            thinkingLevelMap: garbageMap,
          },
          {
            ...normalizedCacheModel("legacy/wrong-level-map", "Wrong Level Map"),
            reasoning: true,
            thinkingLevelMap: wrongLevelMap,
          },
          {
            ...normalizedCacheModel("legacy/valid-map", "Valid Map"),
            reasoning: true,
            thinkingLevelMap: validMap,
          },
        ],
      }),
    );

    process.env.OMNIROUTE_BASE_URL = baseUrl;
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

    const byId = new Map(models.map((model) => [model.id, model]));
    for (const id of [
      "legacy/all-null",
      "legacy/missing-map",
      "legacy/incomplete-map",
      "legacy/extra-map",
      "legacy/garbage-map",
      "legacy/wrong-level-map",
    ]) {
      assert.equal(byId.get(id)?.reasoning, false, id);
      assert.equal(byId.get(id)?.thinkingLevelMap, undefined, id);
    }
    assert.equal(byId.get("legacy/valid-map")?.reasoning, true);
    assert.equal(byId.get("legacy/valid-map")?.thinkingLevelMap?.medium, "medium");

    assert.equal(memory.writes.length, 1, "offline legacy import must persist once");
    const writtenById = new Map(
      (memory.writes[0]!.models as Array<Record<string, unknown>>).map((model) => [String(model.id), model]),
    );
    for (const id of [
      "legacy/all-null",
      "legacy/missing-map",
      "legacy/incomplete-map",
      "legacy/extra-map",
      "legacy/garbage-map",
      "legacy/wrong-level-map",
    ]) {
      assert.equal(writtenById.get(id)?.reasoning, false, id);
      assert.equal(writtenById.get(id)?.thinkingLevelMap, undefined, id);
    }
    assert.equal(writtenById.get("legacy/valid-map")?.reasoning, true);
    assert.equal(
      (writtenById.get("legacy/valid-map")?.thinkingLevelMap as { medium?: string } | undefined)?.medium,
      "medium",
    );
  });

  it("excludes exact synthetic ultra alias IDs from store and legacy restore without interpreting ultra", async () => {
    const baseUrl = "http://127.0.0.1:9/v1";
    const cachePath = join(tempDir, "legacy-ultra-cache.json");
    const excludedIds = [
      "codex/gpt-5.6-sol-ultra",
      "cx/gpt-5.6-sol-ultra",
      "codex/gpt-5.6-terra-ultra",
      "cx/gpt-5.6-terra-ultra",
    ];
    await writeFile(
      cachePath,
      createValidCacheJson(baseUrl, "keep-model", {
        models: [
          normalizedCacheModel("keep-model", "keep-model"),
          normalizedCacheModel("openai/gpt-5.6-sol-ultra", "gpt-5.6-sol-ultra"),
          ...excludedIds.map((id) => ({
            ...normalizedCacheModel(id, id.split("/", 1)[1] ?? id),
            reasoning: true,
            thinkingLevelMap: fullThinkingMap({ max: "max" }),
          })),
        ],
      }),
    );

    process.env.OMNIROUTE_BASE_URL = baseUrl;
    process.env.OMNIROUTE_API_KEY = "test-key";
    process.env.OMNIROUTE_MODEL_CACHE_PATH = cachePath;

    const harness = createHarness();
    await extension(harness.api);
    const registration = provider(harness);

    const legacyMemory = createMemoryStore();
    const legacyModels = await registration.config.refreshModels!({
      store: legacyMemory.store,
      allowNetwork: false,
    });
    assert.deepEqual(modelIds(legacyModels), ["keep-model", "openai/gpt-5.6-sol-ultra"]);

    const storeMemory = createMemoryStore({
      checkedAt: Date.now(),
      models: [
        storedProviderModel("keep-store-model", baseUrl, "keep-store-model"),
        storedProviderModel("openai/gpt-5.6-sol-ultra", baseUrl, "gpt-5.6-sol-ultra"),
        ...excludedIds.map((id) => ({
          ...storedProviderModel(id, baseUrl, id.split("/", 1)[1] ?? id),
          reasoning: true,
          thinkingLevelMap: fullThinkingMap({ max: "max" }),
        })),
      ],
    });
    const storeModels = await registration.config.refreshModels!({
      store: storeMemory.store,
      allowNetwork: false,
    });
    assert.deepEqual(modelIds(storeModels), ["keep-store-model", "openai/gpt-5.6-sol-ultra"]);
    for (const excluded of excludedIds) {
      assert.ok(!modelIds(legacyModels).includes(excluded), excluded);
      assert.ok(!modelIds(storeModels).includes(excluded), excluded);
    }
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
