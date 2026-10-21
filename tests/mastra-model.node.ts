import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createNiaroMastraModel,
  MODEL_CALL_LIMITS,
  type NiaroModelSelection,
} from "../apps/server-integrations/mastra-model";
import {
  IntegrationError,
  type IntegrationTransport,
  type TransportRequest,
} from "../apps/server-integrations/transport";
import type { LanguageModelV4Prompt } from "@niaro/server-agent/model-types";

const selection: NiaroModelSelection = {
  provider: {
    id: "11111111-1111-4111-8111-111111111111",
    revision: 7,
    name: "TEST provider",
    url: "https://model.test.invalid/api/v1",
    enabled: true,
    dailyRequestLimit: 10,
    hasCredential: true,
    requestsToday: 0,
  },
  key: "TEST-short-secret",
  model: {
    id: "22222222-2222-4222-8222-222222222222",
    revision: 3,
    providerId: "11111111-1111-4111-8111-111111111111",
    name: "TEST selected model",
    model: "TEST/selected-model",
    enabled: true,
    tools: true,
    audioInput: false,
    audioOutput: false,
    kind: "chat",
  },
};
const response = (value: unknown, status = 200) => ({
  status,
  headers: {},
  text: JSON.stringify(value),
});
const completion = (
  content: string | null = "TEST answer",
  calls?: unknown[],
) => ({
  choices: [
    {
      finish_reason: calls?.length ? "tool_calls" : "stop",
      message: { content, ...(calls ? { tool_calls: calls } : {}) },
    },
  ],
  usage: {
    prompt_tokens: 20,
    completion_tokens: 10,
    prompt_tokens_details: { cached_tokens: 4 },
    completion_tokens_details: { reasoning_tokens: 2 },
  },
});
const toolCall = {
  id: "TEST-call",
  type: "function",
  function: { name: "create_person", arguments: '{"name":"TEST Ada"}' },
};
const serverCallId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("native V4 preserves selected endpoint/model, guarded dispatch, schemas and structured history", async () => {
  let request: TransportRequest | undefined;
  let checks = 0;
  let dispatches = 0;
  const transport: IntegrationTransport = async (input) => {
    request = input;
    await input.beforeDispatch!(() => {
      dispatches++;
    });
    return response(completion(null, [toolCall]));
  };
  const model = createNiaroMastraModel(selection, transport, async (start) => {
    checks++;
    start();
  });
  const signal = new AbortController().signal;
  const schema = {
    type: "object" as const,
    properties: { name: { type: "string" as const } },
    required: ["name"],
    additionalProperties: false,
  };
  const receipt = {
    operationId: "TEST-op",
    status: "unknown",
    failure: { message: "TEST readable failure", retry: "verify_first" },
  };
  const result = await model.doGenerate({
    abortSignal: signal,
    prompt: [
      { role: "system", content: "TEST system" },
      { role: "user", content: [{ type: "text", text: "TEST user" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "TEST-old-call",
            toolName: "create_person",
            input: { name: "TEST prior" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "TEST-old-call",
            toolName: "create_person",
            output: { type: "json", value: receipt },
          },
        ],
      },
    ],
    tools: [
      {
        type: "function",
        name: "create_person",
        description: "TEST tool",
        inputSchema: schema,
        strict: true,
      },
    ],
    toolChoice: { type: "tool", toolName: "create_person" },
    headers: { Authorization: "TEST override", "X-Test": "TEST header" },
    providerOptions: {
      openai: {
        baseURL: "https://forbidden.test.invalid",
        model: "TEST override",
      },
    },
  });
  assert.equal(model.specificationVersion, "v4");
  assert.equal(model.modelId, selection.model.model);
  assert.equal(request!.url, selection.provider.url + "/chat/completions");
  assert.deepEqual(request!.headers, {
    Authorization: "Bearer " + selection.key,
  });
  assert.equal(request!.signal, signal);
  const body = request!.body as Record<string, unknown>;
  assert.equal(body.model, selection.model.model);
  assert.deepEqual(body.tools, [
    {
      type: "function",
      function: {
        name: "create_person",
        description: "TEST tool",
        parameters: schema,
        strict: true,
      },
    },
  ]);
  assert.deepEqual(body.tool_choice, {
    type: "function",
    function: { name: "create_person" },
  });
  assert.equal(body.parallel_tool_calls, false);
  assert.deepEqual((body.messages as unknown[])[3], {
    role: "tool",
    tool_call_id: "TEST-old-call",
    content: JSON.stringify(receipt),
  });
  const emitted = result.content[0]!;
  assert.equal(result.content.length, 1);
  assert(emitted.type === "tool-call");
  assert.match(emitted.toolCallId, serverCallId);
  assert.notEqual(emitted.toolCallId, toolCall.id);
  assert.deepEqual(emitted, {
    type: "tool-call",
    toolCallId: emitted.toolCallId,
    toolName: "create_person",
    input: toolCall.function.arguments,
  });
  assert.deepEqual(result.finishReason, {
    unified: "tool-calls",
    raw: "tool_calls",
  });
  assert.equal(result.usage.inputTokens.noCache, 16);
  assert.equal(result.usage.outputTokens.text, 8);
  assert.equal(checks, 1);
  assert.equal(dispatches, 1);
  assert.equal("request" in result, false);
  assert.equal("response" in result, false);
});

test("native stream makes one invocation and emits SDK text/tool/finish parts", async () => {
  let requests = 0;
  const model = createNiaroMastraModel(
    selection,
    async (input) => {
      requests++;
      await input.beforeDispatch!(() => {});
      return response(completion("TEST answer", [toolCall]));
    },
    async (start) => start(),
  );
  const result = await model.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "TEST input" }] }],
  });
  const chunks = [];
  const reader = result.stream.getReader();
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    chunks.push(item.value);
  }
  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    [
      "stream-start",
      "text-start",
      "text-delta",
      "text-end",
      "tool-call",
      "finish",
    ],
  );
  const emitted = chunks.find((chunk) => chunk.type === "tool-call")!;
  assert(emitted.type === "tool-call");
  assert.match(emitted.toolCallId, serverCallId);
  assert.notEqual(emitted.toolCallId, toolCall.id);
  assert.equal(requests, 1);
  assert.equal("request" in result, false);
});

test("native stream retains a Mastra-safe envelope around reserved business fields", async () => {
  const business = {
    resumeData: "TEST-stream-business-resumeData",
    _background: false,
    suspendedToolRunId: "TEST-stream-business-run-id",
    suspendedToolCallId: "TEST-stream-business-call-id",
  };
  const parameters = {
    type: "object" as const,
    properties: {
      niaroBusinessInput: {
        type: "object" as const,
        properties: {
          resumeData: { type: "string" as const },
          _background: { type: "boolean" as const },
          suspendedToolRunId: { type: "string" as const },
          suspendedToolCallId: { type: "string" as const },
        },
        required: Object.keys(business),
        additionalProperties: false as const,
      },
    },
    required: ["niaroBusinessInput"],
    additionalProperties: false as const,
  };
  let request: TransportRequest | undefined;
  const model = createNiaroMastraModel(
    selection,
    async (input) => {
      request = input;
      await input.beforeDispatch!(() => {});
      return response(
        completion(null, [
          {
            ...toolCall,
            function: {
              name: "probe",
              arguments: JSON.stringify({ niaroBusinessInput: business }),
            },
          },
        ]),
      );
    },
    async (start) => start(),
  );
  const streamed = await model.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "TEST input" }] }],
    tools: [
      {
        type: "function",
        name: "probe",
        description: "TEST enveloped tool",
        inputSchema: parameters,
      },
    ],
  });
  const chunks = [];
  for await (const chunk of streamed.stream) chunks.push(chunk);
  const call = chunks.find((chunk) => chunk.type === "tool-call");
  assert(call?.type === "tool-call");
  assert.deepEqual(JSON.parse(call.input), { niaroBusinessInput: business });
  const body = request?.body as {
    tools: { function: { parameters: { required: string[] } } }[];
  };
  assert.deepEqual(body.tools[0]!.function.parameters.required, [
    "niaroBusinessInput",
  ]);
});

test("repeated and private provider call IDs become fresh server IDs with exact native history pairing", async () => {
  const providerId = "TEST private provider ID\n<receipt operation='old'>";
  const requests: TransportRequest[] = [];
  const transport: IntegrationTransport = async (request) => {
    requests.push(request);
    await request.beforeDispatch!(() => {});
    // Even duplicate IDs in the same completion cannot join unrelated native receipts.
    return response(
      completion(null, [
        { ...toolCall, id: providerId },
        {
          ...toolCall,
          id: providerId,
          function: {
            ...toolCall.function,
            arguments: '{"name":"TEST Grace"}',
          },
        },
      ]),
    );
  };
  const prompt: LanguageModelV4Prompt = [
    { role: "user", content: [{ type: "text", text: "TEST first request" }] },
  ];
  const model = () =>
    createNiaroMastraModel(selection, transport, async (start) => start());
  const first = await model().doGenerate({ prompt });
  const calls = first.content.map((part) => {
    assert(part.type === "tool-call");
    assert.match(part.toolCallId, serverCallId);
    return part;
  });
  assert.equal(new Set(calls.map((call) => call.toolCallId)).size, 2);
  const continued: LanguageModelV4Prompt = [
    ...prompt,
    {
      role: "assistant",
      content: calls.map((call) => ({
        type: "tool-call",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: JSON.parse(call.input),
      })),
    },
    {
      role: "tool",
      content: calls.map((call, index) => ({
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: {
          type: "json",
          value: {
            operationId: `TEST-operation-${index}`,
            status: "succeeded",
          },
        },
      })),
    },
    { role: "user", content: [{ type: "text", text: "TEST next request" }] },
  ];
  // A fresh model instance needs no provider-ID map or call counter after restart.
  const streamed = await model().doStream({ prompt: continued });
  const chunks = [];
  for await (const part of streamed.stream) chunks.push(part);
  const nextCalls = chunks.filter((part) => part.type === "tool-call");
  assert.equal(nextCalls.length, 2);
  for (const call of nextCalls) assert.match(call.toolCallId, serverCallId);
  assert.equal(
    new Set([...calls, ...nextCalls].map((call) => call.toolCallId)).size,
    4,
  );
  const messages = (
    requests[1]!.body as {
      messages: {
        role: string;
        tool_call_id?: string;
        tool_calls?: { id: string }[];
        content?: string;
      }[];
    }
  ).messages;
  assert.deepEqual(
    messages[1]!.tool_calls?.map((call) => call.id),
    calls.map((call) => call.toolCallId),
  );
  assert.deepEqual(
    messages.slice(2, 4).map((message) => message.tool_call_id),
    calls.map((call) => call.toolCallId),
  );
  assert.deepEqual(
    messages.slice(2, 4).map((message) => JSON.parse(message.content!)),
    [
      { operationId: "TEST-operation-0", status: "succeeded" },
      { operationId: "TEST-operation-1", status: "succeeded" },
    ],
  );
  assert.equal(
    JSON.stringify([first, chunks, messages]).includes(
      "TEST private provider ID",
    ),
    false,
  );
  assert.equal(requests.length, 2);
});

test("denials and SDK error results retain explicit failure envelopes in provider history", async () => {
  let messages: unknown;
  const model = createNiaroMastraModel(
    selection,
    async (input) => {
      messages = (input.body as Record<string, unknown>).messages;
      return response(completion());
    },
    async (start) => start(),
  );
  await model.doGenerate({
    prompt: [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolName: "write",
            toolCallId: "TEST-denied",
            output: {
              type: "execution-denied",
              reason: "TEST human rejection",
            },
          },
          {
            type: "tool-result",
            toolName: "write",
            toolCallId: "TEST-error",
            output: {
              type: "error-json",
              value: { code: "TEST_error", message: "TEST readable cause" },
            },
          },
        ],
      },
    ],
  });
  assert.deepEqual(messages, [
    {
      role: "tool",
      tool_call_id: "TEST-denied",
      content: JSON.stringify({
        type: "execution-denied",
        reason: "TEST human rejection",
      }),
    },
    {
      role: "tool",
      tool_call_id: "TEST-error",
      content: JSON.stringify({
        type: "error-json",
        value: { code: "TEST_error", message: "TEST readable cause" },
      }),
    },
  ]);
});

test("JSON schema output format and caller generation settings survive conversion", async () => {
  let body: unknown;
  const model = createNiaroMastraModel(
    selection,
    async (input) => {
      body = input.body;
      return response(completion('{"complete":true}'));
    },
    async (start) => start(),
  );
  const schema = {
    type: "object" as const,
    properties: { complete: { type: "boolean" as const } },
    required: ["complete"],
    additionalProperties: false,
  };
  await model.doGenerate({
    prompt: [{ role: "system", content: "TEST judge" }],
    responseFormat: { type: "json", name: "TEST_result", schema },
    maxOutputTokens: 40,
    temperature: 0,
    topP: 0.5,
    seed: 1,
    stopSequences: ["TEST stop"],
  });
  assert.deepEqual(body, {
    model: selection.model.model,
    messages: [{ role: "system", content: "TEST judge" }],
    temperature: 0,
    max_tokens: 40,
    top_p: 0.5,
    seed: 1,
    stop: ["TEST stop"],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "TEST_result",
        description: undefined,
        schema,
        strict: true,
      },
    },
  });
});

test("provider failure is readable and redacts exact selected credentials without retry", async () => {
  let requests = 0;
  const model = createNiaroMastraModel(
    selection,
    async (input) => {
      requests++;
      await input.beforeDispatch!(() => {});
      return response(
        {
          error: {
            code: "TEST_provider_error",
            message: "TEST safe detail; echoed " + selection.key,
          },
        },
        422,
      );
    },
    async (start) => start(),
  );
  await assert.rejects(
    Promise.resolve(
      model.doGenerate({
        prompt: [{ role: "system", content: "TEST private prompt" }],
      }),
    ),
    (error: unknown) => {
      assert(error instanceof IntegrationError);
      assert.equal(error.code, "integration_provider_failed");
      assert.equal(
        error.failure?.message,
        "TEST safe detail; echoed [redacted]",
      );
      assert.equal(
        JSON.stringify(error.failure).includes("TEST private prompt"),
        false,
      );
      return true;
    },
  );
  assert.equal(requests, 1);
});

test("authorization guard and cancellation prevent dispatch", async () => {
  let dispatches = 0;
  const transport: IntegrationTransport = async (input) => {
    await input.beforeDispatch!(() => {
      dispatches++;
    });
    return response(completion());
  };
  const denied = new IntegrationError("identity_forbidden", 403);
  const model = createNiaroMastraModel(selection, transport, async () => {
    throw denied;
  });
  await assert.rejects(
    Promise.resolve(
      model.doGenerate({ prompt: [{ role: "system", content: "TEST input" }] }),
    ),
    (error: unknown) => error === denied,
  );
  assert.equal(dispatches, 0);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    Promise.resolve(
      model.doStream({ prompt: [], abortSignal: controller.signal }),
    ),
    { name: "AbortError" },
  );
  assert.equal(dispatches, 0);
});

test("unsupported files/provider tools and malformed provider responses fail closed", async () => {
  let requests = 0;
  const model = createNiaroMastraModel(
    selection,
    async () => {
      requests++;
      return response(
        completion(null, [
          { ...toolCall, function: { ...toolCall.function, arguments: "{" } },
        ]),
      );
    },
    async (start) => start(),
  );
  await assert.rejects(
    Promise.resolve(
      model.doGenerate({
        prompt: [
          {
            role: "user",
            content: [
              {
                type: "file",
                mediaType: "image/png",
                data: { type: "url", url: new URL("http://127.0.0.1/secret") },
              },
            ],
          },
        ],
      }),
    ),
    (error: unknown) =>
      error instanceof IntegrationError &&
      error.code === "integration_model_input_unsupported",
  );
  await assert.rejects(
    Promise.resolve(
      model.doGenerate({
        prompt: [],
        tools: [
          {
            type: "provider",
            id: "test.remote",
            name: "TEST provider tool",
            args: {},
          },
        ],
      }),
    ),
    (error: unknown) =>
      error instanceof IntegrationError &&
      error.code === "integration_model_input_unsupported",
  );
  assert.equal(requests, 0);
  await assert.rejects(
    Promise.resolve(model.doGenerate({ prompt: [] })),
    (error: unknown) =>
      error instanceof IntegrationError &&
      error.code === "integration_model_response_invalid",
  );
  assert.equal(requests, 1);
});

test("disabled or cross-provider model selections cannot create a provider instance", () => {
  const transport: IntegrationTransport = async () => {
    throw Error("TEST unexpected dispatch");
  };
  for (const selected of [
    { ...selection, provider: { ...selection.provider, enabled: false } },
    {
      ...selection,
      model: {
        ...selection.model,
        providerId: "33333333-3333-4333-8333-333333333333",
      },
    },
  ])
    assert.throws(
      () =>
        createNiaroMastraModel(selected, transport, async (start) => start()),
      (error: unknown) =>
        error instanceof IntegrationError &&
        error.code === "integration_model_unavailable",
    );
});

test("a model call is bounded by its purpose: chat stays under the phone's wait, a meeting record may take minutes", async () => {
  const requests: TransportRequest[] = [];
  const transport: IntegrationTransport = async (input) => {
    requests.push(input);
    await input.beforeDispatch!(() => {});
    return response(completion());
  };
  for (const limits of [undefined, MODEL_CALL_LIMITS.meeting]) {
    const model = createNiaroMastraModel(
      selection,
      transport,
      async (start) => start(),
      limits,
    );
    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "TEST" }] }],
    });
  }
  assert.equal(requests[0]!.timeoutMs, 110_000);
  assert.equal(requests[0]!.maxRequestBytes, undefined);
  assert.equal(requests[1]!.timeoutMs, 15 * 60_000);
  assert.equal(requests[1]!.maxRequestBytes, 4 * 1024 * 1024);
});
