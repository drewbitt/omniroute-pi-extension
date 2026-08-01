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
const ENV_KEYS = ["OMNIROUTE_BASE_URL", "OMNIROUTE_API_KEY", "PI_OFFLINE"] as const;

describe("Pi extension loader regression", () => {
  let tempDir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "omniroute-loader-test-"));
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

    process.env.OMNIROUTE_BASE_URL = BASE_URL;
    process.env.OMNIROUTE_API_KEY = "loader-test-key";
    process.env.PI_OFFLINE = "1";
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("loads through discoverAndLoadExtensions and queues one complete Pi-native OmniRoute Provider", async () => {
    const result = await discoverAndLoadExtensions([extensionPath], projectRoot, tempDir);
    assert.equal(result.errors.length, 0, `Pi loader should load index.ts without errors: ${JSON.stringify(result.errors)}`);

    const pending = result.runtime.pendingNativeProviderRegistrations;
    const omniroute = pending.filter((entry) => entry.provider.id === "omniroute");
    assert.equal(omniroute.length, 1, "exactly one complete OmniRoute provider registration");
    const provider = omniroute[0]?.provider;
    assert.equal(provider?.name, "OmniRoute");
    assert.equal(provider?.baseUrl, BASE_URL);
    assert.equal(provider?.auth.apiKey?.name, "OmniRoute API key");
    assert.equal(typeof provider?.getModels, "function");
    assert.equal(typeof provider?.refreshModels, "function");
    assert.equal(typeof provider?.stream, "function");
    assert.equal(typeof provider?.streamSimple, "function");
  });

  it("skips registration when OMNIROUTE_BASE_URL is missing or not an HTTP(S) URL", async () => {
    for (const baseUrl of [undefined, "not a URL", "ftp://omniroute.test/v1"]) {
      if (baseUrl === undefined) delete process.env.OMNIROUTE_BASE_URL;
      else process.env.OMNIROUTE_BASE_URL = baseUrl;
      const result = await discoverAndLoadExtensions([extensionPath], projectRoot, tempDir);
      assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
      assert.equal(
        result.runtime.pendingNativeProviderRegistrations.filter((entry) => entry.provider.id === "omniroute").length,
        0,
        `no provider for ${baseUrl ?? "missing"} base URL`,
      );
    }
  });
});
