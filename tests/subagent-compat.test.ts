import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  createAgentSession,
  createAgentSessionServices,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

/**
 * External-seam regression for ordinary subagent / headless child sessions.
 *
 * Source-backed contract (read-only reference, not imported):
 * - pi-subagents built-ins use `extensions: true`
 * - agent-runner constructs an independent child DefaultResourceLoader, then
 *   calls public createAgentSession({ modelRuntime: parentModelRuntime,
 *   resourceLoader: childLoader, model, sessionManager, ... }) so parent-
 *   registered providers remain resolvable without a TUI
 * - createAgentSessionServices applies extension provider registrations then
 *   modelRuntime.refresh({ allowNetwork: false }) so models-store restore works
 *
 * This suite covers the ordinary worker path. Isolated agents or
 * `extensions: false` / user-disabled / excluded configurations intentionally
 * skip extension tools; those are not promised.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const extensionPath = join(projectRoot, "index.ts");

const FIXTURE_BASE_URL = "http://127.0.0.1:9/v1";
const FIXTURE_MODEL_ID = "fixture-omniroute-chat";
const FIXTURE_API_KEY = "fake-offline-key-not-live";
const ENV_KEYS = [
  "OMNIROUTE_BASE_URL",
  "OMNIROUTE_API_KEY",
  "PI_OFFLINE",
] as const;

function storedFixtureModel(baseUrl: string, id = FIXTURE_MODEL_ID) {
  return {
    id,
    name: "Fixture OmniRoute Chat",
    provider: "omniroute",
    api: "openai-responses",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  };
}

async function writeAgentDirFixtures(agentDir: string, baseUrl: string) {
  await writeFile(
    join(agentDir, "models-store.json"),
    JSON.stringify(
      {
        omniroute: {
          checkedAt: Date.now(),
          models: [storedFixtureModel(baseUrl)],
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(agentDir, "auth.json"),
    JSON.stringify(
      {
        omniroute: { type: "api_key", key: FIXTURE_API_KEY },
      },
      null,
      2,
    ),
  );
  // Empty models.json so ModelRuntime uses the default agentDir layout.
  await writeFile(join(agentDir, "models.json"), "{}\n");
}

describe("OmniRoute subagent / headless model availability", () => {
  let agentDir: string;
  let cwd: string;
  let savedEnv: Record<string, string | undefined>;
  const disposers: Array<() => void> = [];

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), "omniroute-subagent-agent-"));
    cwd = await mkdtemp(join(tmpdir(), "omniroute-subagent-cwd-"));
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

    process.env.OMNIROUTE_BASE_URL = FIXTURE_BASE_URL;
    process.env.OMNIROUTE_API_KEY = FIXTURE_API_KEY;
    process.env.PI_OFFLINE = "1";
    process.env.PI_CODING_AGENT_DIR = agentDir;

    await writeAgentDirFixtures(agentDir, FIXTURE_BASE_URL);
  });

  afterEach(async () => {
    while (disposers.length > 0) {
      const dispose = disposers.pop();
      try {
        dispose?.();
      } catch {
        // best-effort cleanup
      }
    }
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(agentDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });

  it("resolves OmniRoute via createAgentSessionServices, parent modelRuntime child session, and standalone store restore", async () => {
    // Parent path: public services builder loads this extension and restores models-store offline.
    const parentServices = await createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: {
        additionalExtensionPaths: [extensionPath],
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
      },
    });

    assert.equal(
      parentServices.diagnostics.filter((d) => d.type === "error").length,
      0,
      `parent services should not report errors: ${JSON.stringify(parentServices.diagnostics)}`,
    );

    const parentModel = parentServices.modelRuntime.getModel("omniroute", FIXTURE_MODEL_ID);
    assert.ok(parentModel, "parent modelRuntime must resolve the fixture OmniRoute model");
    assert.equal(parentModel.provider, "omniroute");
    assert.equal(parentModel.id, FIXTURE_MODEL_ID);
    assert.equal(parentModel.baseUrl, FIXTURE_BASE_URL);
    assert.equal(parentModel.api, "openai-responses");

    // Ordinary pi-subagents child path (agent-runner.ts): independent child
    // DefaultResourceLoader + public createAgentSession with parent modelRuntime.
    // Fails if createAgentSession ignores/replaces the passed parent runtime or
    // if OmniRoute is only reachable via the parent's services object graph.
    const childSettingsManager = SettingsManager.create(cwd, agentDir);
    const childLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: childSettingsManager,
      // Explicit path mirrors ordinary additional-extension / package discovery;
      // default discovery also finds this package via package.json "pi.extensions".
      additionalExtensionPaths: [extensionPath],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await childLoader.reload();

    assert.notEqual(
      childLoader,
      parentServices.resourceLoader,
      "child DefaultResourceLoader must be independently constructed",
    );

    const childSessionManager = SessionManager.inMemory(cwd);
    const { session: childSession, extensionsResult: childExtensionsResult } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime: parentServices.modelRuntime,
      resourceLoader: childLoader,
      sessionManager: childSessionManager,
      settingsManager: childSettingsManager,
      model: parentModel,
      noTools: "all",
    });
    disposers.push(() => childSession.dispose());

    assert.notEqual(
      childSession.resourceLoader,
      parentServices.resourceLoader,
      "child session must keep the independently constructed resourceLoader",
    );
    assert.equal(
      childSession.resourceLoader,
      childLoader,
      "child session should use the passed child resourceLoader instance",
    );
    assert.equal(
      childSession.modelRuntime,
      parentServices.modelRuntime,
      "child must share only the parent modelRuntime as intended (not a fresh runtime)",
    );
    assert.equal(
      childSession.sessionManager,
      childSessionManager,
      "child session must use the distinct in-memory SessionManager",
    );

    assert.equal(
      childExtensionsResult.errors.length,
      0,
      `child createAgentSession should not report extension load errors: ${JSON.stringify(childExtensionsResult.errors)}`,
    );
    assert.ok(
      childExtensionsResult.extensions.some((ext) => ext.path === extensionPath || ext.resolvedPath === extensionPath),
      "child loader must surface the OmniRoute extension path",
    );

    // Explicit parent-resolved model is selected without tools/provider calls or TUI hooks.
    assert.ok(childSession.model, "child session should select the explicit OmniRoute model");
    assert.equal(childSession.model.provider, "omniroute");
    assert.equal(childSession.model.id, FIXTURE_MODEL_ID);
    assert.equal(childSession.model.api, "openai-responses");
    assert.equal(childSession.model.baseUrl, FIXTURE_BASE_URL);

    // Child extension bind re-registers OmniRoute onto the shared parent runtime (not a
    // parent-services-only graph). registerProvider kicks off a fire-and-forget offline
    // refresh, so wait for that settle before catalog lookups — same parent runtime.
    assert.ok(
      childSession.modelRuntime.getRegisteredProviderIds?.().includes("omniroute") ||
        childSession.modelRuntime.getProvider("omniroute"),
      "OmniRoute provider must remain registered on the shared parent modelRuntime",
    );
    assert.equal(
      childSession.modelRuntime.hasConfiguredAuth("omniroute"),
      true,
      "shared parent runtime must retain configured OmniRoute auth after child construction",
    );
    await childSession.modelRuntime.refresh({ allowNetwork: false });
    assert.equal(
      childSession.modelRuntime,
      parentServices.modelRuntime,
      "refresh must not replace the parent modelRuntime identity",
    );

    const childResolved = childSession.modelRuntime.getModel("omniroute", FIXTURE_MODEL_ID);
    assert.ok(
      childResolved,
      "shared parent modelRuntime must resolve OmniRoute after child createAgentSession + offline refresh",
    );
    assert.equal(childResolved.id, FIXTURE_MODEL_ID);
    assert.equal(childResolved.provider, "omniroute");
    assert.equal(childResolved.baseUrl, FIXTURE_BASE_URL);
    // Selected model object remains usable even across the re-registration refresh window.
    assert.equal(childSession.model.id, FIXTURE_MODEL_ID);
    assert.equal(childSession.model.provider, "omniroute");

    // Standalone headless/SDK path: new services with the same agentDir restore from models-store
    // (not only by sharing the parent object graph).
    const standaloneServices = await createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: {
        additionalExtensionPaths: [extensionPath],
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
      },
    });
    assert.notEqual(
      standaloneServices.modelRuntime,
      parentServices.modelRuntime,
      "standalone services must construct a distinct modelRuntime",
    );
    const standaloneModel = standaloneServices.modelRuntime.getModel("omniroute", FIXTURE_MODEL_ID);
    assert.ok(
      standaloneModel,
      "standalone headless services must restore OmniRoute from the provider models-store",
    );
    assert.equal(standaloneModel.id, FIXTURE_MODEL_ID);
    assert.equal(standaloneModel.provider, "omniroute");
    assert.equal(standaloneModel.baseUrl, FIXTURE_BASE_URL);
  });
});
