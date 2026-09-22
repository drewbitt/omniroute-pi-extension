import assert from "node:assert/strict";
import http from "node:http";
import { after, before, it } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { createOmniRouteProvider } from "../index.ts";

/**
 * The optional gateway controls are read from the environment on every request,
 * so a running session picks them up without a `/omni sync`. These tests pin
 * three properties: nothing is sent by default, an opted-in value is sent, and
 * explicit caller headers still win.
 */

let server: http.Server;
let baseUrl: string;
const headers: Array<http.IncomingHttpHeaders> = [];

const OPT_IN_VARS = [
  "OMNIROUTE_NO_MEMORY",
  "OMNIROUTE_NO_CACHE",
  "OMNIROUTE_COMPRESSION",
] as const;

before(async () => {
  server = http.createServer((_request, reply) => {
    headers.push(_request.headers);
    reply.writeHead(200, { "content-type": "text/event-stream" });
    reply.write(
      `data: ${JSON.stringify({
        id: "one",
        choices: [
          { index: 0, delta: { content: "ok" }, finish_reason: "stop" },
        ],
      })}\n\n`,
    );
    reply.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

after(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
});

const model = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  provider: "omniroute",
  api: "openai-completions" as const,
  baseUrl: "",
  reasoning: false,
  input: ["text"] as Array<"text" | "image">,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_384,
};

async function request(
  extra: { headers?: Record<string, string> } = {},
): Promise<http.IncomingHttpHeaders> {
  const provider = createOmniRouteProvider();
  assert(provider.stream);
  const before = headers.length;
  await provider
    .stream(
      { ...model, baseUrl },
      normalizeContext({
        messages: [{ role: "user" as const, content: "hi", timestamp: 1 }],
      }),
      { apiKey: "route-key", maxRetries: 0, ...extra },
    )
    .result();
  const sent = headers[before];
  assert(sent, "the provider must have issued one request");
  return sent;
}

async function withEnv(
  values: Partial<Record<(typeof OPT_IN_VARS)[number], string>>,
  run: () => Promise<void>,
): Promise<void> {
  const saved = OPT_IN_VARS.map((name) => [name, process.env[name]] as const);
  for (const name of OPT_IN_VARS) delete process.env[name];
  for (const [name, value] of Object.entries(values)) {
    process.env[name as (typeof OPT_IN_VARS)[number]] = value;
  }
  try {
    await run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

it("sends no gateway control headers when nothing is opted in", async () => {
  await withEnv({}, async () => {
    const sent = await request();
    assert.equal(sent["x-omniroute-no-memory"], undefined);
    assert.equal(sent["x-omniroute-no-cache"], undefined);
    assert.equal(sent["x-omniroute-compression"], undefined);
  });
});

it("maps each opted-in variable onto its documented gateway header", async () => {
  await withEnv(
    {
      OMNIROUTE_NO_MEMORY: "1",
      OMNIROUTE_NO_CACHE: "true",
      OMNIROUTE_COMPRESSION: "engine:rtk",
    },
    async () => {
      const sent = await request();
      assert.equal(sent["x-omniroute-no-memory"], "true");
      assert.equal(sent["x-omniroute-no-cache"], "true");
      assert.equal(sent["x-omniroute-compression"], "engine:rtk");
    },
  );
});

it("ignores a compression plan that is not a header-safe token", async () => {
  await withEnv({ OMNIROUTE_COMPRESSION: "rtk\r\nX-Injected: 1" }, async () => {
    const sent = await request();
    assert.equal(sent["x-omniroute-compression"], undefined);
    assert.equal(sent["x-injected"], undefined);
  });
});

it("lets an explicit caller header override the environment", async () => {
  await withEnv({ OMNIROUTE_NO_MEMORY: "1" }, async () => {
    const sent = await request({
      headers: { "x-omniroute-no-memory": "false" },
    });
    assert.equal(sent["x-omniroute-no-memory"], "false");
  });
});
