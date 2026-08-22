import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, it } from "node:test";
import { fileURLToPath } from "node:url";
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

  const command = result.extensions[0]?.commands.get("omni");
  assert(command);
  const notifications: Array<{ message: string; level: string }> = [];
  const context = {
    modelRegistry: {
      getProviderAuth: async () => ({ auth: { apiKey: "redacted" } }),
      getProvider: () => ({ getModels: () => [{}, {}, {}] }),
      refresh: async () => ({
        aborted: false,
        errors: new Map([
          ["omniroute", new Error("model discovery failed with HTTP 503")],
        ]),
      }),
    },
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  } as unknown as Parameters<typeof command.handler>[1];

  await command.handler("sync", context);
  assert.deepEqual(notifications, [
    {
      message:
        "OmniRoute model sync failed: model discovery failed with HTTP 503. Using 3 existing models.",
      level: "error",
    },
  ]);
});
