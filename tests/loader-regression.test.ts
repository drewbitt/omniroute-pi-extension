import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const extensionPath = join(projectRoot, "index.ts");

const BASE_URL = "https://omniroute.test";
const ENV_KEYS = ["OMNIROUTE_BASE_URL", "OMNIROUTE_API_KEY", "OMNIROUTE_MODEL_CACHE_PATH", "PI_OFFLINE"] as const;

describe("Pi extension loader regression", () => {
  let tempDir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "omniroute-loader-test-"));
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

    process.env.OMNIROUTE_BASE_URL = BASE_URL;
    process.env.OMNIROUTE_API_KEY = "loader-test-key";
    process.env.PI_OFFLINE = "1";
    delete process.env.OMNIROUTE_MODEL_CACHE_PATH;
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("loads through discoverAndLoadExtensions and queues a single omniroute provider with refreshModels", async () => {
    const result = await discoverAndLoadExtensions([extensionPath], projectRoot, tempDir);
    assert.equal(result.errors.length, 0, `Pi loader should load index.ts without errors: ${JSON.stringify(result.errors)}`);

    const pending = result.runtime.pendingProviderRegistrations;
    const omniroute = pending.filter((entry) => entry.name === "omniroute");
    assert.equal(omniroute.length, 1, "exactly one omniroute provider registration");
    assert.equal(omniroute[0]?.config.api, "openai-responses");
    assert.equal(omniroute[0]?.config.apiKey, "$OMNIROUTE_API_KEY");
    assert.equal(omniroute[0]?.config.baseUrl, BASE_URL);
    assert.equal(typeof omniroute[0]?.config.refreshModels, "function");
    assert.equal(
      omniroute[0]?.config.streamSimple,
      undefined,
      "OmniRoute should delegate Responses streaming and reasoning rendering to Pi",
    );
  });

  it("skips registration when OMNIROUTE_BASE_URL is missing", async () => {
    delete process.env.OMNIROUTE_BASE_URL;
    const result = await discoverAndLoadExtensions([extensionPath], projectRoot, tempDir);
    assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
    const pending = result.runtime.pendingProviderRegistrations;
    assert.equal(
      pending.filter((entry) => entry.name === "omniroute").length,
      0,
      "no provider without base URL",
    );
  });
});
