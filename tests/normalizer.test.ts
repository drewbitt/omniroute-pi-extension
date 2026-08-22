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
