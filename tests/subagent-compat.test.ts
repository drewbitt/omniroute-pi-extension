import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

/**
 * External-seam regression for ordinary subagent / headless child sessions.
 *
 * Source-backed contract (read-only reference, not imported):
 * - pi-subagents built-ins use `extensions: true`
 * - agent-runner passes the parent's hidden modelRuntime into createAgentSession
 *   so parent-registered providers remain resolvable without a TUI
 * - createAgentSessionServices applies extension provider registrations then
 *   modelRuntime.refresh({ allowNetwork: false }) so models-store restore works
 *
 * This suite covers the ordinary worker path. Isolated agents or
 * `extensions: false` intentionally skip extension tools; those are not promised.
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
  "OMNIROUTE_MODEL_CACHE_PATH",
  "PI_OFFLINE",
  "PI_CODING_AGENT_DIR",
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
    delete process.env.OMNIROUTE_MODEL_CACHE_PATH;

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

    // Ordinary pi-subagents child path: share the parent's modelRuntime (no TUI hooks required).
    const { session: childSession } = await createAgentSessionFromServices({
      services: parentServices,
      sessionManager: SessionManager.inMemory(cwd),
      model: parentModel,
      noTools: "all",
    });
    disposers.push(() => childSession.dispose());

    assert.equal(childSession.modelRuntime, parentServices.modelRuntime, "child reuses parent modelRuntime");
    const childResolved = childSession.modelRuntime.getModel("omniroute", FIXTURE_MODEL_ID);
    assert.ok(childResolved, "child modelRuntime must still resolve OmniRoute after session construction");
    assert.equal(childResolved.id, FIXTURE_MODEL_ID);
    assert.ok(childSession.model, "child session should select the explicit OmniRoute model");
    assert.equal(childSession.model.provider, "omniroute");
    assert.equal(childSession.model.id, FIXTURE_MODEL_ID);

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
