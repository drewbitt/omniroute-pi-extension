import assert from "node:assert/strict";
import http from "node:http";
import { after, before, it } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { createOmniRouteProvider } from "../index.ts";
import { normalizeModels } from "../src/model-normalizer.ts";

let server: http.Server;
let baseUrl: string;
const requests: Array<Record<string, unknown>> = [];
const authHeaders: string[] = [];
// Per-request headers the provider actually sent, in order.
const requestHeaders: Array<Record<string, string | string[] | undefined>> = [];

// One pi session id, so both requests exercise the same affinity header.
const SESSION_ID = "01a0cab8-0356-75a5-8482-336771dceb7f";

function affinityHeaders(): Array<string | undefined> {
  return requestHeaders.map((headers) =>
    headers["x-session-id"] === undefined
      ? undefined
      : String(headers["x-session-id"]),
  );
}

function send(reply: http.ServerResponse, chunks: unknown[]) {
  reply.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks) reply.write(`data: ${JSON.stringify(chunk)}\n\n`);
  reply.end("data: [DONE]\n\n");
}

before(async () => {
  server = http.createServer(async (request, reply) => {
    assert.equal(request.url, "/v1/chat/completions");
    authHeaders.push(String(request.headers.authorization ?? ""));
    requestHeaders.push(request.headers);
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw));
    if (requests.length === 1) {
      send(reply, [
        {
          id: "one",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "Checking." },
              finish_reason: null,
            },
          ],
        },
        {
          id: "one",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "lookup", arguments: '{"value":' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: "one",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, function: { arguments: "42}" } }],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: "one",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        },
      ]);
      return;
    }
    send(reply, [
      {
        id: "two",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Result: 42" },
            finish_reason: null,
          },
        ],
      },
      {
        id: "two",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 },
      },
    ]);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
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

it("streams text and an exact tool round-trip with model and bearer auth preserved", {
  timeout: 5000,
}, async () => {
  const provider = createOmniRouteProvider();
  assert(provider.stream);
  // Derived through the normalizer so this stays an end-to-end check that
  // catalog metadata reaches the wire.
  const [model] = normalizeModels("omniroute", baseUrl, [
    {
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      owned_by: "combo",
      context_length: 128_000,
      max_output_tokens: 16_384,
    },
  ]);
  assert(model, "the catalog row must normalize to a model");
  const user = { role: "user" as const, content: "Use lookup", timestamp: 1 };
  const tools = [
    {
      name: "lookup",
      description: "Look up a value",
      parameters: {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      },
    },
  ];
  const first = await provider
    .stream(
      model,
      // pi folds the prompt and tool declarations into a leading system
      // message before a provider sees a transcript.
      normalizeContext({ messages: [user], tools }),
      { apiKey: "route-key", maxRetries: 0 },
    )
    .result();
  assert.equal(first.stopReason, "toolUse");
  assert.deepEqual(first.content, [
    { type: "text", text: "Checking." },
    {
      type: "toolCall",
      id: "call_1",
      name: "lookup",
      arguments: { value: 42 },
    },
  ]);

  const toolResult = {
    role: "toolResult" as const,
    toolCallId: "call_1",
    toolName: "lookup",
    content: [{ type: "text" as const, text: "42" }],
    details: {},
    isError: false,
    timestamp: 2,
  };
  const second = await provider
    .stream(
      model,
      normalizeContext({ messages: [user, first, toolResult], tools }),
      { apiKey: "route-key", maxRetries: 0, sessionId: SESSION_ID },
    )
    .result();
  assert.equal(second.stopReason, "stop");
  assert.deepEqual(second.content, [{ type: "text", text: "Result: 42" }]);
  assert.equal(requests[0]?.model, "gpt-5.6-sol");
  assert.equal(requests[1]?.model, "gpt-5.6-sol");
  assert.deepEqual(authHeaders, ["Bearer route-key", "Bearer route-key"]);
  const secondMessages = requests[1]?.messages as Array<
    Record<string, unknown>
  >;
  assert.equal(secondMessages.at(-1)?.role, "tool");
  assert.equal(secondMessages.at(-1)?.tool_call_id, "call_1");
  // Normalized models opt into the `openrouter` session-affinity shape, which
  // is exactly the header OmniRoute reads for sticky routing and prompt-cache
  // affinity. A run without a session id must stay header-free.
  assert.deepEqual(affinityHeaders(), [undefined, SESSION_ID]);
});
