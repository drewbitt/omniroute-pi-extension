import assert from "node:assert/strict";
import { after, it } from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createOmniRouteProvider } from "../index.ts";
import { BASE_URL_ENV } from "../src/gateway-catalog.ts";

const live = process.env.OMNIROUTE_LIVE === "1";
const inference = live && process.env.OMNIROUTE_LIVE_INFERENCE === "1";
const originalBaseUrl = process.env[BASE_URL_ENV];
let runtime: ModelRuntime | undefined;

after(() => {
  if (originalBaseUrl === undefined) delete process.env[BASE_URL_ENV];
  else process.env[BASE_URL_ENV] = originalBaseUrl;
});

it("refreshes the installed-shape provider through Pi ModelRuntime", {
  skip: live ? false : "set OMNIROUTE_LIVE=1 to run",
  timeout: 120_000,
}, async () => {
  const baseUrl = process.env.OMNIROUTE_LIVE_BASE_URL;
  const apiKey = process.env.OMNIROUTE_LIVE_API_KEY;
  assert(baseUrl, "OMNIROUTE_LIVE_BASE_URL is required");
  assert(apiKey, "OMNIROUTE_LIVE_API_KEY is required");
  process.env[BASE_URL_ENV] = baseUrl;

  runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
  });
  runtime.registerNativeProvider(createOmniRouteProvider());
  await runtime.setRuntimeApiKey("omniroute", apiKey);
  const result = await runtime.refresh({
    providers: ["omniroute"],
    force: true,
    signal: AbortSignal.timeout(90_000),
  });

  assert.equal(result.aborted, false);
  assert.equal(result.errors.size, 0);
  const models = runtime.getModels("omniroute");
  assert(models.length > 0);
  assert.equal(new Set(models.map((model) => model.id)).size, models.length);
  assert(models.every((model) => model.provider === "omniroute"));
  assert(models.every((model) => model.api === "openai-completions"));
});

it("completes a bounded live request through Pi ModelRuntime", {
  skip: inference
    ? false
    : "set OMNIROUTE_LIVE=1 and OMNIROUTE_LIVE_INFERENCE=1 to run",
  timeout: 150_000,
}, async () => {
  assert(runtime, "live catalog test must run first");
  // Model IDs churn (providers retire models constantly), so only an
  // explicit OMNIROUTE_LIVE_MODEL pins one. Otherwise resolve from the
  // catalog just fetched, preferring gateway-managed routing aliases
  // (`auto/*` always route to whatever is currently healthy) and falling
  // back to any unpriced (flat-rate / subscription) chat model so the
  // probe stays free.
  const models = runtime.getModels("omniroute");
  const pinned = process.env.OMNIROUTE_LIVE_MODEL;
  // Free-designated auto aliases first, then any zero-cost model, then
  // any auto alias, so the probe stays free even as specific models retire.
  const model = pinned
    ? models.find((candidate) => candidate.id === pinned)
    : (models.find(
        (candidate) =>
          candidate.id.startsWith("auto/") && candidate.cost.input === 0,
      ) ??
      models.find(
        (candidate) =>
          candidate.cost.input === 0 && candidate.cost.output === 0,
      ) ??
      models.find((candidate) => candidate.id.startsWith("auto/")) ??
      models[0]);
  assert(model, "live catalog contains no usable model");

  const response = await runtime.completeSimple(
    model,
    {
      messages: [
        {
          role: "user",
          content: "Reply with exactly OMNIROUTE_PI_OK.",
          timestamp: Date.now(),
        },
      ],
    },
    {
      signal: AbortSignal.timeout(120_000),
      maxRetries: 0,
      onPayload(payload) {
        return payload && typeof payload === "object"
          ? { ...payload, max_completion_tokens: 512 }
          : undefined;
      },
    },
  );

  assert.equal(response.stopReason, "stop");
  assert(
    response.content.some(
      (block) =>
        block.type === "text" && block.text.includes("OMNIROUTE_PI_OK"),
    ),
  );
});
