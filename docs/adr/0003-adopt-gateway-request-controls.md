# Adopt gateway request controls as opt-in

## Decision

Pi's session id is sent to OmniRoute as `x-session-id` on every request, and the
gateway's request controls are exposed as opt-in environment switches.

Two catalog-driven compatibility fields are now emitted on every normalized
model:

```ts
compat: { sendSessionAffinityHeaders: true, sessionAffinityFormat: "openrouter" }
```

`openrouter` is the only pi-ai session-affinity shape that produces
`x-session-id`, which is the only header OmniRoute reads for affinity. These two
fields are always on, because they cannot break a request: pi-ai adds the header
only when a session id exists, and `getCompat()` merges them per field over its
detected defaults, so every other detected value is preserved.

Three environment switches map 1:1 onto documented OmniRoute request headers and
default to absent:

| Variable | Header | Effect |
| --- | --- | --- |
| `OMNIROUTE_NO_MEMORY` | `x-omniroute-no-memory: true` | Skip the gateway's memory + skills injection for the request |
| `OMNIROUTE_NO_CACHE` | `X-OmniRoute-No-Cache: true` | Bypass the gateway response cache |
| `OMNIROUTE_COMPRESSION` | `x-omniroute-compression: <plan>` | Override the prompt-compression plan (`off`, `default`, `engine:<id>`, or a combo id) |

They are read per request from the ambient environment, so a running session
picks them up without `/omni sync`, and no value is ever written to the model
store. A fourth switch, `OMNIROUTE_STRICT_TOOLS`, opts into OpenAI strict-schema
sampling for rows advertising `capabilities.structured_output`; unlike the
others it is evaluated while the catalog is normalized, so it needs a re-sync.

## Rationale

OmniRoute derives its session-affinity key from `x-codex-session-id`,
`x-session-id`, or `x-omniroute-session`, then from body metadata, and finally
from a hash of the first input message. That last fallback is the reason this
matters: it is derived from the head of the transcript, so it changes whenever
the head changes — compaction replaces the opening turns with a summary. With
`disableSessionStickiness: false` and `promptCacheAffinityEnabled: true` on the
gateway, a stable caller-supplied key keeps a conversation pinned to the same
connection and therefore to the same upstream prompt cache. Without it, affinity
is lost exactly when a long session starts to need it.

The request controls exist because the gateway changes the bytes on the wire
regardless of pi:

- Prompt compression runs by default. The live gateway reports
  `x-omniroute-compression: stacked; source=default`, and the pipeline can
  summarize history at higher modes. Pi manages its own context, compaction, and
  cache prefix deliberately, so the operator needs a way to override or disable
  it. The gateway echoes the resolved plan and its source, which makes the
  setting verifiable from a response.
- Memory and skills injection costs tokens on every call and duplicates what pi
  already provides from its own skills and memories.
- The gateway's cache is an exact-match SHA-256 signature that additionally
  requires an explicit numeric `temperature: 0`. Pi sends `temperature` only
  when a model or the user sets it, so cache reads are already off for pi by
  default and the cache bypass switch is a niche control rather than a default.

Strict sampling stays opt-in because pi treats it as an endpoint opt-in, and one
gateway model id can be routed to many different upstreams. A small live sample
accepted `strict` tool schemas on five namespaces, which is enough to offer the
switch but not enough to make it the default under this extension's fail-closed
rule.

## Consequences

- Affinity, sticky routing, and prompt-cache affinity survive compaction without
  any user configuration.
- `x-omniroute-session-id` in a response echoes `ext:<pi session id>`, so the
  end-to-end path is observable and covered by `tests/live-gateway.test.ts`.
- The gateway's `capabilities.structured_output` claim is a models.dev
  model capability, not an endpoint guarantee. `OMNIROUTE_STRICT_TOOLS` is
  therefore documented as a deliberate, reversible experiment rather than a
  default.
- `OMNIROUTE_STRICT_TOOLS` requires `/omni sync` after a change; the header
  switches do not. That asymmetry is intentional and documented.
- Environment switches are provider configuration in the same sense as
  `OMNIROUTE_BASE_URL` and `OMNIROUTE_API_KEY`, so no plaintext extension config
  file and no `models.json` mutation is introduced.
- Deferred: replacing the hand-rolled provider with pi-ai's `createProvider`,
  moving the stream import off the `/compat` entrypoint, and consuming
  `inputLimits`, `promptCache`, and `cost.tiers`. The gateway publishes no data
  for the model-level ones, and `ModelsStoreEntry.etag`/`lastModified` are
  unusable because `/v1/models` sends neither header.
