import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OmniRouteModel } from "../src/gateway-catalog.ts";
import { normalizeModels } from "../src/model-normalizer.ts";

function row(id: string, parent?: string): OmniRouteModel {
  return {
    id,
    name: id,
    object: "model",
    created: 0,
    owned_by: "omniroute",
    parent,
  } as OmniRouteModel;
}

describe("exact provider mirrors", () => {
  it("drops a row whose basename matches a surviving parent under another namespace", () => {
    const out = normalizeModels("omniroute", "http://x/v1", [
      row("cmd/claude-opus-4-6"),
      row("command-code/claude-opus-4-6", "cmd/claude-opus-4-6"),
    ]);
    assert.deepEqual(
      out.map((model) => model.id),
      ["cmd/claude-opus-4-6"],
    );
  });

  it("keeps the mirror when the parent row is absent", () => {
    const out = normalizeModels("omniroute", "http://x/v1", [
      row("combo/claude-opus-4-6", "cmd/claude-opus-4-6"),
    ]);
    assert.deepEqual(
      out.map((model) => model.id),
      ["combo/claude-opus-4-6"],
    );
  });

  it("keeps rows in the same namespace as their parent", () => {
    const out = normalizeModels("omniroute", "http://x/v1", [
      row("cmd/claude-family"),
      row("cmd/claude-opus-4-6", "cmd/claude-family"),
    ]);
    assert.equal(out.length, 2);
  });

  it("keeps rows whose parent has a different basename", () => {
    const out = normalizeModels("omniroute", "http://x/v1", [
      row("cmd/claude-opus-4-6"),
      row("alias/opus", "cmd/claude-opus-4-6"),
    ]);
    assert.equal(out.length, 2);
  });
});

describe("OpenAI-compatibility overrides", () => {
  const rows = (extra: Partial<OmniRouteModel>) =>
    normalizeModels("omniroute", "http://x/v1", [
      { ...row("zai/glm-5.3-flash"), ...extra },
    ]);

  it("always opts into the session-affinity header OmniRoute reads", () => {
    // pi-ai only emits `x-session-id` for the `openrouter` shape, and
    // OmniRoute reads exactly that header. Without it the gateway falls back
    // to hashing the first input message, which a compaction rewrites.
    assert.deepEqual(rows({})[0]?.compat, {
      sendSessionAffinityHeaders: true,
      sessionAffinityFormat: "openrouter",
    });
  });

  it("leaves strict sampling off unless the caller opts in", () => {
    const out = normalizeModels(
      "omniroute",
      "http://x/v1",
      [
        {
          ...row("zai/glm-5.3-flash"),
          capabilities: { structured_output: true },
        },
      ],
      {},
    );
    assert.equal(out[0]?.compat?.supportsStrictMode, undefined);
  });

  it("enables strict sampling only for rows that advertise it", () => {
    const [advertised] = normalizeModels(
      "omniroute",
      "http://x/v1",
      [
        {
          ...row("zai/glm-5.3-flash"),
          capabilities: { structured_output: true },
        },
      ],
      { strictTools: true },
    );
    assert.equal(advertised?.compat?.supportsStrictMode, true);

    const [silent] = normalizeModels(
      "omniroute",
      "http://x/v1",
      [
        {
          ...row("zai/glm-5.3-flash"),
          capabilities: { reasoning: true },
        },
      ],
      { strictTools: true },
    );
    assert.equal(silent?.compat?.supportsStrictMode, undefined);
  });
});
