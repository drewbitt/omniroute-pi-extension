import type { OmniRouteModel } from "./gateway-catalog.ts";

/**
 * Fill in pricing for catalog rows that /v1/models leaves unpriced, using the
 * gateway's `/api/pricing` table.
 *
 * Rows only carry per-model pricing when their provider id matches a pricing
 * namespace exactly. Some providers price under a different namespace (`oc`/
 * `opencode` rows use `opencode-go` rates), so those arrive with no pricing
 * and would otherwise show as zero cost in pi.
 *
 * Flat-rate providers (coding plans, web sessions, Command Code, Claude Code;
 * upstream flatRateProviders.ts, #5552/#9067) bill a subscription, not per
 * token. They are excluded before any lookup so resold list prices cannot be
 * attributed to them.
 *
 * Lookup order for unpriced rows:
 *   1. `owned_by` matches a namespace exactly.
 *   2. The provider id or id prefix maps through NAMESPACE_ALIASES.
 *   3. The model basename appears in exactly one namespace (ambiguous means
 *      unpriced: never borrow another reseller's rate).
 *
 * Best effort: any fetch/parse failure keeps the original rows untouched.
 */

type PricingEntry = {
  input?: number;
  output?: number;
  cached?: number;
  cache_creation?: number;
};

export type PricingTable = Record<string, Record<string, PricingEntry>>;

/** Catalog provider id or public id prefix → pricing namespace. */
const NAMESPACE_ALIASES: Record<string, string> = {
  oc: "opencode-go",
  opencode: "opencode-go",
  "opencode-zen": "opencode-go",
  kr: "kiro",
  cx: "codex",
  ds: "deepseek",
  ag: "antigravity",
};

/**
 * Flat-rate / subscription provider ids. Mirrors OmniRoute's own classification
 * (`src/lib/usage/flatRateProviders.ts`): coding plans are explicit ids, and
 * every web-session provider (`-web`) is backed by a consumer subscription or
 * free tier. Command Code is a subscription service that upstream tracks as a
 * quota plan (#9921) but has not yet added to its flat-rate set, so it is
 * included here directly. Upstream deliberately keeps `codex`/`cx`, `byteplus`,
 * `minimax-cn`, and `glm-thinking` metered; those stay priced.
 */
const FLAT_RATE_PROVIDERS: ReadonlySet<string> = new Set([
  // Coding plans (mirrors upstream FLAT_RATE_SUBSCRIPTION_PROVIDER_IDS)
  "minimax",
  "kimi-coding",
  "kimi-coding-apikey",
  "xiaomi-mimo",
  "bailian-coding-plan",
  "qwen-cloud-token-plan",
  "glm",
  "glm-cn",
  // Claude Code plan (upstream #10773): OAuth Claude Pro/Max subscription.
  "claude",
  "cc",
  // Command Code (subscription; #9921). `cmd` is its catalog alias and
  // `cc-provider` the custom-connection prefix used on this gateway.
  "command-code",
  "cmd",
  "cc-provider",
]);

/** Web-session providers bill a subscription/free tier, not per token. */
function isFlatRateProvider(id: string | undefined): boolean {
  if (!id) return false;
  const normalized = id.trim().toLowerCase();
  if (!normalized) return false;
  return FLAT_RATE_PROVIDERS.has(normalized) || normalized.endsWith("-web");
}

/** True when a pricing entry carries at least one usable rate. */
function hasUsableRates(entry: PricingEntry | undefined): boolean {
  if (!entry) return false;
  return (
    typeof entry.input === "number" ||
    typeof entry.output === "number" ||
    typeof entry.cached === "number" ||
    typeof entry.cache_creation === "number"
  );
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

/** Convert one pricing entry to the catalog row's `pricing` shape. */
function toRowPricing(
  entry: PricingEntry,
): NonNullable<OmniRouteModel["pricing"]> {
  return {
    input: entry.input,
    output: entry.output,
    cached: entry.cached,
    cache_creation: entry.cache_creation,
  };
}

/** Case-insensitive lookup of a model key inside one namespace. */
function findModel(
  namespace: Record<string, PricingEntry> | undefined,
  key: string,
): PricingEntry | undefined {
  if (!namespace) return undefined;
  const lower = normalizeKey(key);
  if (Object.hasOwn(namespace, lower)) return namespace[lower];
  for (const [candidate, entry] of Object.entries(namespace)) {
    if (normalizeKey(candidate) === lower) return entry;
  }
  return undefined;
}

/** Resolve a row id's basename (`cmd/deepseek/deepseek-v4-flash` → `deepseek-v4-flash`). */
function basename(id: string): string {
  const parts = id.split("/");
  return parts[parts.length - 1] ?? "";
}

/** First path segment of the row id (`cmd/deepseek/...` → `cmd`). */
function idPrefix(id: string): string {
  const parts = id.split("/");
  return parts[0] ?? "";
}

export function parsePricingTable(payload: unknown): PricingTable {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return {};
  }
  const table: PricingTable = {};
  for (const [namespace, models] of Object.entries(payload)) {
    if (typeof models !== "object" || models === null || Array.isArray(models))
      continue;
    const parsed: Record<string, PricingEntry> = {};
    for (const [model, raw] of Object.entries(models)) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw))
        continue;
      const entry: PricingEntry = {};
      for (const field of [
        "input",
        "output",
        "cached",
        "cache_creation",
      ] as const) {
        const value = (raw as Record<string, unknown>)[field];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
          entry[field] = value;
        }
      }
      if (hasUsableRates(entry)) parsed[normalizeKey(model)] = entry;
    }
    if (Object.keys(parsed).length > 0) table[normalizeKey(namespace)] = parsed;
  }
  return table;
}

/** Resolve pricing for one catalog row against the merged table. */
/**
 * Precomputed basename → entry index for the unambiguous-basename fallback.
 * `count` is the number of pricing namespaces containing that basename; only
 * `count === 1` entries are usable (a resold model must never inherit a rate
 * from a different reseller).
 */
export type PricingBasenameIndex = Map<
  string,
  { count: number; entry: PricingEntry }
>;

export function buildPricingBasenameIndex(
  table: PricingTable,
): PricingBasenameIndex {
  const index: PricingBasenameIndex = new Map();
  for (const namespace of Object.values(table)) {
    for (const [key, entry] of Object.entries(namespace)) {
      const hit = index.get(key);
      if (hit) hit.count += 1;
      else index.set(key, { count: 1, entry });
    }
  }
  return index;
}

export function resolvePricing(
  row: OmniRouteModel,
  table: PricingTable,
  basenameIndex?: PricingBasenameIndex,
): OmniRouteModel["pricing"] {
  const ownedBy = row.owned_by?.trim().toLowerCase() ?? "";
  const prefix = idPrefix(row.id).toLowerCase();

  // Flat-rate providers are never per-token: short-circuit every resolution
  // tier (exact, alias, and basename fallback) so a resold list price can't
  // leak onto them. This also strips explicit catalog pricing on such rows:
  // if /v1/models attaches metered rates to a subscription row, the flat-rate
  // classification wins.
  if (isFlatRateProvider(ownedBy) || isFlatRateProvider(prefix)) {
    return hasUsableRates(row.pricing) ? undefined : row.pricing;
  }

  if (row.pricing && hasUsableRates(row.pricing)) return row.pricing;

  const candidates: string[] = [];
  if (ownedBy) candidates.push(ownedBy);
  if (prefix) candidates.push(prefix);
  for (const candidate of candidates) {
    const exact = table[candidate];
    if (exact) {
      const entry =
        findModel(exact, basename(row.id)) ?? findModel(exact, row.id);
      if (entry) return toRowPricing(entry);
    }
    const aliased = NAMESPACE_ALIASES[candidate];
    if (aliased) {
      const namespace = table[aliased];
      if (namespace) {
        const entry =
          findModel(namespace, basename(row.id)) ??
          findModel(namespace, row.id);
        if (entry) return toRowPricing(entry);
      }
    }
  }

  // Unambiguous basename fallback: only used when exactly one namespace prices it.
  // With a prebuilt index this is O(1) per row instead of a scan of every
  // namespace (measured 2.5s per refresh at 278 namespaces x ~11k entries);
  // without one, fall back to the scan so direct callers stay correct.
  const base = basename(row.id);
  if (base) {
    if (basenameIndex) {
      const hit = basenameIndex.get(normalizeKey(base));
      if (hit && hit.count === 1) return toRowPricing(hit.entry);
    } else {
      let found: PricingEntry | undefined;
      let matches = 0;
      for (const namespace of Object.values(table)) {
        const entry = findModel(namespace, base);
        if (entry) {
          matches += 1;
          found = entry;
        }
      }
      if (matches === 1 && found) return toRowPricing(found);
    }
  }

  return row.pricing;
}

/** Apply the pricing table to a catalog, leaving rows with explicit pricing untouched. */
export function applyPricingTable(
  rows: readonly OmniRouteModel[],
  table: PricingTable,
): OmniRouteModel[] {
  if (Object.keys(table).length === 0) return [...rows];
  const basenameIndex = buildPricingBasenameIndex(table);
  return rows.map((row) => {
    const resolved = resolvePricing(row, table, basenameIndex);
    return resolved === row.pricing ? row : { ...row, pricing: resolved };
  });
}
