import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, describe, it } from "node:test";
import { createOmniRouteProvider } from "../index.ts";
import { BASE_URL_ENV, fetchPricingTable } from "../src/gateway-catalog.ts";
import {
  applyPricingTable,
  parsePricingTable,
  resolvePricing,
  type PricingTable,
} from "../src/pricing-merge.ts";
import type { ApiKeyCredential, Provider } from "@earendil-works/pi-ai";

const servers: http.Server[] = [];
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
});

async function fixture(response: {
  payload?: unknown;
  pricing?: unknown;
  pricingStatus?: number;
}) {
  let requests = 0;
  let pricingRequests = 0;
  const server = http.createServer((request, reply) => {
    requests += 1;
    const url = new URL(request.url ?? "/", "http://local");
    const isPricing = url.pathname.endsWith("/api/pricing");
    if (isPricing) {
      pricingRequests += 1;
      reply.writeHead(response.pricingStatus ?? 200, {
        "content-type": "application/json",
      });
      reply.end(
        response.pricing === undefined
          ? "{}"
          : typeof response.pricing === "string"
            ? response.pricing
            : JSON.stringify(response.pricing),
      );
      return;
    }
    reply.writeHead(200, { "content-type": "application/json" });
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
    get pricingRequests() {
      return pricingRequests;
    },
  };
}

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

function credential(baseUrl: string, key = "secret"): ApiKeyCredential {
  return { type: "api_key", key, env: { [BASE_URL_ENV]: baseUrl } };
}

function refreshHarness(options: { credential?: ApiKeyCredential }) {
  const context = {
    credential: options.credential,
    stored: undefined,
    allowNetwork: true,
    signal: new AbortController().signal,
    async publish(publication: { persist?: unknown; update?: () => void }) {
      publication.update?.();
      return true;
    },
  } as unknown as Parameters<NonNullable<Provider["refreshModels"]>>[0];
  return { context };
}

describe("pricing merge", () => {
  it("parses a nested /api/pricing payload", () => {
    const table = parsePricingTable({
      cc: {
        "claude-sonnet-4-6": {
          input: 3,
          output: 15,
          cached: 0.3,
          cache_creation: 3.75,
        },
      },
      deepseek: {
        "deepseek-v4-flash": { input: 0.14, output: 0.28 },
      },
      broken: "not-a-table",
    });
    assert.deepEqual(table, {
      cc: {
        "claude-sonnet-4-6": {
          input: 3,
          output: 15,
          cached: 0.3,
          cache_creation: 3.75,
        },
      },
      deepseek: {
        "deepseek-v4-flash": { input: 0.14, output: 0.28 },
      },
    });
  });

  it("drops invalid entries and non-numeric fields", () => {
    const table = parsePricingTable({
      openai: {
        "gpt-4o": { input: 2.5, output: "ten" },
        empty: {},
        negative: { input: -1, output: 1 },
      },
    });
    assert.deepEqual(table, {
      openai: {
        "gpt-4o": { input: 2.5 },
        negative: { output: 1 },
      },
    });
  });

  it("resolves exact provider match first", () => {
    const table: PricingTable = {
      opencode: { "deepseek-v4-flash": { input: 0.14, output: 0.28 } },
    };
    const rowWithProvider = {
      id: "oc/deepseek-v4-flash",
      owned_by: "opencode",
    };
    assert.deepEqual(resolvePricing(rowWithProvider, table), {
      input: 0.14,
      output: 0.28,
      cached: undefined,
      cache_creation: undefined,
    });
  });

  it("resolves metered reseller aliases (opencode → opencode-go)", () => {
    const table: PricingTable = {
      "opencode-go": { "deepseek-v4-flash": { input: 0.14, output: 0.28 } },
    };
    const row = { id: "opencode/deepseek-v4-flash", owned_by: "opencode" };
    assert.deepEqual(resolvePricing(row, table), {
      input: 0.14,
      output: 0.28,
      cached: undefined,
      cache_creation: undefined,
    });
  });

  it("leaves flat-rate providers unpriced (coding plan, web session, Command Code)", () => {
    const table: PricingTable = {
      cc: { "claude-sonnet-4-6": { input: 3, output: 15 } },
      deepseek: { "deepseek-v4-flash": { input: 0.14, output: 0.28 } },
    };
    // Coding plan (subscription)
    assert.equal(
      resolvePricing({ id: "glm/glm-4.7", owned_by: "glm" }, table),
      undefined,
    );
    // Web-session provider (subscription / free tier)
    assert.equal(
      resolvePricing(
        { id: "deepseek-web/deepseek-v4-flash", owned_by: "deepseek-web" },
        table,
      ),
      undefined,
    );
    // Command Code: built-in provider and custom connection
    assert.equal(
      resolvePricing(
        { id: "cmd/claude-sonnet-4-6", owned_by: "command-code" },
        table,
      ),
      undefined,
    );
    assert.equal(
      resolvePricing(
        { id: "cc-provider/claude-sonnet-4-6", owned_by: "cc-provider" },
        table,
      ),
      undefined,
    );
    // Claude Code plan (upstream #10773): OAuth id and its `cc` alias
    assert.equal(
      resolvePricing(
        { id: "claude/claude-sonnet-4-6", owned_by: "claude" },
        table,
      ),
      undefined,
    );
    assert.equal(
      resolvePricing({ id: "cc/claude-sonnet-4-6", owned_by: "cc" }, table),
      undefined,
    );
    // Explicit catalog pricing on a flat-rate row is stripped: the flat-rate
    // classification wins over metered rates the catalog may attach.
    assert.equal(
      resolvePricing(
        {
          id: "cmd/claude-sonnet-4-6",
          owned_by: "command-code",
          pricing: { input: 3, output: 15 },
        },
        table,
      ),
      undefined,
    );
  });

  it("keeps explicit pricing untouched", () => {
    const table: PricingTable = {
      openrouter: { "deepseek-v4-flash": { input: 0.06426, output: 0.12852 } },
    };
    const row = {
      id: "openrouter/deepseek/deepseek-v4-flash",
      owned_by: "openrouter",
      pricing: { input: 9, output: 9 },
    };
    assert.deepEqual(resolvePricing(row, table), { input: 9, output: 9 });
  });

  it("leaves ambiguous basenames unpriced", () => {
    const table: PricingTable = {
      a: { "deepseek-v4-flash": { input: 1, output: 2 } },
      b: { "deepseek-v4-flash": { input: 3, output: 4 } },
    };
    const row = {
      id: "cmd/deepseek/deepseek-v4-flash",
      owned_by: "command-code",
    };
    // 'cc' namespace absent, basename ambiguous → stays unpriced
    assert.equal(resolvePricing(row, table), undefined);
  });

  it("uses basename when exactly one namespace prices it", () => {
    const table: PricingTable = {
      only: { "some-model": { input: 0.5, output: 1 } },
    };
    const row = { id: "unknown/prefix/some-model", owned_by: "unknown" };
    assert.deepEqual(resolvePricing(row, table), {
      input: 0.5,
      output: 1,
      cached: undefined,
      cache_creation: undefined,
    });
  });

  it("fetchPricingTable soft-fails on HTTP error", async () => {
    const server = await fixture({ pricingStatus: 401 });
    const result = await fetchPricingTable(
      { baseUrl: server.baseUrl },
      "secret",
      new AbortController().signal,
    );
    assert.equal(result, null);
  });

  it("fetchPricingTable soft-fails on invalid JSON", async () => {
    const server = await fixture({ pricing: "not json {" });
    const result = await fetchPricingTable(
      { baseUrl: server.baseUrl },
      "secret",
      new AbortController().signal,
    );
    assert.equal(result, null);
  });

  it("merges pricing into a full refresh via the provider", async () => {
    const server = await fixture({
      payload: {
        data: [
          row("cmd/claude-sonnet-4-6", { owned_by: "command-code" }),
          row("openrouter/deepseek/deepseek-v4-flash", {
            owned_by: "openrouter",
            pricing: { input: 0.06426, output: 0.12852, cached: 0.012852 },
          }),
          row("bare/model"),
        ],
      },
      pricing: {
        cc: { "claude-sonnet-4-6": { input: 3, output: 15, cached: 0.3 } },
        openrouter: { "deepseek-v4-flash": { input: 0.5, output: 1 } },
      },
    });
    const provider = createOmniRouteProvider();
    await provider.refreshModels!(
      refreshHarness({ credential: credential(server.baseUrl) }).context,
    );

    const models = provider.getModels();
    // Command Code is subscription: `cc` (Claude Code) rates must NOT leak in
    const cc = models.find((m) => m.id === "cmd/claude-sonnet-4-6");
    assert.deepEqual(cc?.cost, {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    // explicit catalog pricing wins over /api/pricing
    const or = models.find(
      (m) => m.id === "openrouter/deepseek/deepseek-v4-flash",
    );
    assert.deepEqual(or?.cost, {
      input: 0.06426,
      output: 0.12852,
      cacheRead: 0.012852,
      cacheWrite: 0,
    });
    // unpriced stays zero
    const bare = models.find((m) => m.id === "bare/model");
    assert.deepEqual(bare?.cost, {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("refresh succeeds when /api/pricing is unavailable", async () => {
    const server = await fixture({
      payload: {
        data: [row("cmd/claude-sonnet-4-6", { owned_by: "command-code" })],
      },
      pricingStatus: 401,
    });
    const provider = createOmniRouteProvider();
    await provider.refreshModels!(
      refreshHarness({ credential: credential(server.baseUrl) }).context,
    );
    const models = provider.getModels();
    assert.equal(models.length, 1);
    assert.deepEqual(models[0]?.cost, {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("applyPricingTable leaves rows without matching namespace untouched", () => {
    const rows = [{ id: "a/model", owned_by: "nope", pricing: undefined }];
    const out = applyPricingTable(rows, {
      nope: { "other-model": { input: 1 } },
    });
    assert.equal(out[0], rows[0]); // same reference → no mutation
  });
});
