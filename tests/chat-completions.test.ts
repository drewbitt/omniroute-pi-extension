import assert from "node:assert/strict";
import http from "node:http";
import { after, before, it } from "node:test";
import { createOmniRouteProvider } from "../index.ts";

let server: http.Server;
let baseUrl: string;
const requests: Array<Record<string, unknown>> = [];
const authHeaders: string[] = [];

function send(reply: http.ServerResponse, chunks: unknown[]) {
  reply.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks) reply.write(`data: ${JSON.stringify(chunk)}\n\n`);
  reply.end("data: [DONE]\n\n");
}

before(async () => {
  server = http.createServer(async (request, reply) => {
    assert.equal(request.url, "/v1/chat/completions");
    authHeaders.push(String(request.headers.authorization ?? ""));
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw));
    if (requests.length === 1) {
      send(reply, [
        { id: "one", choices: [{ index: 0, delta: { role: "assistant", content: "Checking." }, finish_reason: null }] },
        { id: "one", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: '{"value":' } }] }, finish_reason: null }] },
        { id: "one", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "42}" } }] }, finish_reason: null }] },
        { id: "one", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } },
      ]);
      return;
    }
    send(reply, [
      { id: "two", choices: [{ index: 0, delta: { role: "assistant", content: "Result: 42" }, finish_reason: null }] },
      { id: "two", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 } },
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

it("streams text and an exact tool round-trip with model and bearer auth preserved", { timeout: 5000 }, async () => {
  const provider = createOmniRouteProvider();
  assert(provider.stream);
  const model = {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    provider: "omniroute",
    api: "openai-completions" as const,
    baseUrl,
    reasoning: false,
    input: ["text"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
  const user = { role: "user" as const, content: "Use lookup", timestamp: 1 };
  const tools = [{
    name: "lookup",
    description: "Look up a value",
    parameters: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
  }];
  const first = await provider.stream(model, { messages: [user], tools }, { apiKey: "route-key", maxRetries: 0 }).result();
  assert.equal(first.stopReason, "toolUse");
  assert.deepEqual(first.content, [
    { type: "text", text: "Checking." },
    { type: "toolCall", id: "call_1", name: "lookup", arguments: { value: 42 } },
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
  const second = await provider.stream(model, { messages: [user, first, toolResult], tools }, { apiKey: "route-key", maxRetries: 0 }).result();
  assert.equal(second.stopReason, "stop");
  assert.deepEqual(second.content, [{ type: "text", text: "Result: 42" }]);
  assert.equal(requests[0]?.model, "gpt-5.6-sol");
  assert.equal(requests[1]?.model, "gpt-5.6-sol");
  assert.deepEqual(authHeaders, ["Bearer route-key", "Bearer route-key"]);
  const secondMessages = requests[1]?.messages as Array<Record<string, unknown>>;
  assert.equal(secondMessages.at(-1)?.role, "tool");
  assert.equal(secondMessages.at(-1)?.tool_call_id, "call_1");
});
