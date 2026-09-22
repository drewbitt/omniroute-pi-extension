import assert from "node:assert/strict";
import { after, it } from "node:test";
import type { ProviderResponse } from "@earendil-works/pi-ai";
import { hasApi, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createOmniRouteProvider } from "../index.ts";
import { BASE_URL_ENV } from "../src/gateway-catalog.ts";

/**
 * Live gateway contract: the catalog's compatibility opt-ins must survive to a
 * real request, and an opted-in environment control must reach the wire.
 *
 * These assertions cannot be made against a fixture: they depend on the
 * gateway echoing the session id and compression plan it actually resolved.
 * Opt in with `OMNIROUTE_LIVE=1` plus the key, and add
 * `OMNIROUTE_LIVE_INFERENCE=1` to send the real request.
 */

const live = process.env.OMNIROUTE_LIVE === "1";
const inference = live && process.env.OMNIROUTE_LIVE_INFERENCE === "1";
const SESSION_ID = "01a0cab8-0356-75a5-8482-336771dceb7f";
const originalBaseUrl = process.env[BASE_URL_ENV];
let runtime: ModelRuntime | undefined;

after(() => {
  if (originalBaseUrl === undefined) delete process.env[BASE_URL_ENV];
  else process.env[BASE_URL_ENV] = originalBaseUrl;
});

async function connectedRuntime(): Promise<ModelRuntime> {
  const baseUrl = process.env.OMNIROUTE_LIVE_BASE_URL;
  const apiKey = process.env.OMNIROUTE_LIVE_API_KEY;
  assert(baseUrl, "OMNIROUTE_LIVE_BASE_URL is required");
  assert(apiKey, "OMNIROUTE_LIVE_API_KEY is required");
  process.env[BASE_URL_ENV] = baseUrl;

  const created = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
  });
  created.registerNativeProvider(createOmniRouteProvider());
  await created.setRuntimeApiKey("omniroute", apiKey);
  await created.refresh({
    providers: ["omniroute"],
    force: true,
    signal: AbortSignal.timeout(90_000),
  });
  runtime = created;
  return created;
}

it("ships session-affinity compatibility on every live catalog row", {
  skip: live ? false : "set OMNIROUTE_LIVE=1 to run",
  timeout: 120_000,
}, async () => {
  const connected = await connectedRuntime();
  const catalog = connected.getModels("omniroute");
  assert(catalog.length > 0, "live catalog is empty");
  const models = catalog.filter((model) => hasApi(model, "openai-completions"));
  assert.equal(
    models.length,
    catalog.length,
    "every row must use the chat-completions API",
  );
  // OmniRoute only reads `x-session-id`, which is pi-ai's `openrouter`
  // session-affinity shape. A row that loses these two fields silently
  // downgrades the gateway to hashing the first input message instead.
  const missing = models.filter(
    (model) =>
      model.compat?.sendSessionAffinityHeaders !== true ||
      model.compat?.sessionAffinityFormat !== "openrouter",
  );
  assert.deepEqual(
    missing.map((model) => model.id),
    [],
  );
});

it("carries the session id and an opted-in control to the gateway", {
  skip: inference
    ? false
    : "set OMNIROUTE_LIVE=1 and OMNIROUTE_LIVE_INFERENCE=1 to run",
  timeout: 180_000,
}, async () => {
  const connected = runtime ?? (await connectedRuntime());
  const models = connected.getModels("omniroute");
  // Prefer a free routing alias so the probe costs nothing, then any
  // zero-cost chat model, mirroring the other live tests.
  const model =
    models.find((m) => m.id.startsWith("auto/") && m.cost.input === 0) ??
    models.find((m) => m.cost.input === 0 && m.cost.output === 0) ??
    models[0];
  assert(model, "live catalog contains no model");

  const saved = process.env.OMNIROUTE_COMPRESSION;
  process.env.OMNIROUTE_COMPRESSION = "off";
  let response: ProviderResponse | undefined;
  try {
    const result = await connected.completeSimple(
      model,
      {
        messages: [
          {
            role: "user",
            content: "Reply with exactly OK.",
            timestamp: Date.now(),
          },
        ],
      },
      {
        sessionId: SESSION_ID,
        signal: AbortSignal.timeout(150_000),
        maxRetries: 0,
        onResponse: (seen) => {
          response = seen;
        },
      },
    );
    assert.equal(result.stopReason, "stop");
    assert(response, "the gateway must have returned a response");
    const headers = response.headers;
    // OmniRoute echoes the session id it resolved. The `ext:` prefix is its
    // marker for a caller-supplied session, so this fails if the header was
    // not sent or was normalized away.
    assert.equal(headers["x-omniroute-session-id"], `ext:${SESSION_ID}`);
    // The request-header override outranks every gateway-side plan.
    assert.match(
      headers["x-omniroute-compression"] ?? "",
      /^off; source=request-header$/,
    );
  } finally {
    if (saved === undefined) delete process.env.OMNIROUTE_COMPRESSION;
    else process.env.OMNIROUTE_COMPRESSION = saved;
  }
});
