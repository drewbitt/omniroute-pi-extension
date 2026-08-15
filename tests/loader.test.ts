import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, it } from "node:test";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let tempDir: string;
let previousBaseUrl: string | undefined;

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "omniroute-loader-"));
  previousBaseUrl = process.env.OMNIROUTE_BASE_URL;
  delete process.env.OMNIROUTE_BASE_URL;
});

after(async () => {
  if (previousBaseUrl === undefined) delete process.env.OMNIROUTE_BASE_URL;
  else process.env.OMNIROUTE_BASE_URL = previousBaseUrl;
  await rm(tempDir, { recursive: true, force: true });
});

it("loads unconditionally and queues one current Pi native provider", async () => {
  const result = await discoverAndLoadExtensions(
    [join(root, "index.ts")],
    root,
    tempDir,
  );
  assert.deepEqual(result.errors, []);
  const registrations =
    result.runtime.pendingNativeProviderRegistrations.filter(
      (entry) => entry.provider.id === "omniroute",
    );
  assert.equal(registrations.length, 1);
  const provider = registrations[0]!.provider;
  assert.equal(provider.name, "OmniRoute");
  assert.equal(provider.auth.apiKey?.name, "OmniRoute API key");
  assert.equal(typeof provider.refreshModels, "function");
  assert.equal(provider.getModels().length, 0);
});
