import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import {
  createNativeAgentRuntime,
  type NativeAgentInput,
  type NativeAgentSession,
} from "@niaro/server-agent";
import type { LanguageModelV4StreamPart } from "@niaro/server-agent/model-types";
import {
  completionBody,
  completionFromStream,
  CompletionStream,
} from "../apps/server-integrations/chat-stream";
import {
  createNiaroMastraModel,
  type NiaroModelSelection,
} from "../apps/server-integrations/mastra-model";
import {
  canStream,
  createTransport,
  IntegrationError,
  streamingTransport,
  type IntegrationTransport,
  type TransportRequest,
} from "../apps/server-integrations/transport";

const selection: NiaroModelSelection = {
  provider: {
    id: "11111111-1111-4111-8111-111111111111",
    revision: 1,
    name: "TEST provider",
    url: "https://model.test.invalid/api/v1",
    enabled: true,
    dailyRequestLimit: 10,
    hasCredential: true,
    requestsToday: 0,
  },
  key: "TEST-stream-secret",
  model: {
    id: "22222222-2222-4222-8222-222222222222",
    revision: 1,
    providerId: "11111111-1111-4111-8111-111111111111",
    name: "TEST model",
    model: "TEST/model",
    enabled: true,
    tools: true,
    audioInput: false,
    audioOutput: false,
    kind: "chat",
  },
};
const usage = {
  prompt_tokens: 20,
  completion_tokens: 10,
  cost: 0.00003,
};
const chunk = (delta: Record<string, unknown>, finish?: string) =>
  JSON.stringify({
    id: "TEST-gen",
    model: "TEST/model",
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  });
/** Events of a streamed reply: its text in pieces, then usage and [DONE]. */
const textEvents = (...pieces: string[]) => [
  chunk({ role: "assistant", content: "" }),
  ...pieces.map((content) => chunk({ content })),
  chunk({}, "stop"),
  JSON.stringify({ id: "TEST-gen", choices: [], usage }),
  "[DONE]",
];
const toolEvents = [
  chunk({ content: "TEST checking. " }),
  chunk({
    tool_calls: [
      {
        index: 0,
        id: "TEST-call",
        type: "function",
        function: { name: "find_contact", arguments: '{"na' },
      },
    ],
  }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: 'me":"Ada"}' } }] }),
  chunk({}, "tool_calls"),
  JSON.stringify({ choices: [], usage }),
  "[DONE]",
];
const sse = (events: string[]) =>
  ": OPENROUTER PROCESSING\n\n" +
  events.map((data) => `data: ${data}\n\n`).join("");
/** A provider that streams: each event reaches `onEvent` before the call ends. */
const streamingProvider = (
  respond: (request: TransportRequest) => string[],
  seen: TransportRequest[] = [],
) =>
  streamingTransport(async (request) => {
    seen.push(request);
    await request.beforeDispatch?.(() => {});
    const events = respond(request);
    const body = request.body as { stream?: boolean };
    if (!body.stream)
      throw new Error("a streaming transport is asked to stream");
    for (const data of events) request.onEvent?.(data);
    return {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      text: sse(events),
    };
  });

test("a streamed completion is assembled into the body the same call returns without streaming", () => {
  const text = completionFromStream(sse(textEvents("TEST ", "answer")));
  assert.deepEqual(text, {
    id: "TEST-gen",
    model: "TEST/model",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: "TEST answer" },
      },
    ],
    usage,
  });
  const tools = completionFromStream(sse(toolEvents)) as {
    choices: { message: unknown; finish_reason: string }[];
  };
  assert.deepEqual(tools.choices[0], {
    index: 0,
    finish_reason: "tool_calls",
    message: {
      role: "assistant",
      content: "TEST checking. ",
      tool_calls: [
        {
          id: "TEST-call",
          type: "function",
          function: { name: "find_contact", arguments: '{"name":"Ada"}' },
        },
      ],
    },
  });
  // Text reports only reply growth, never tool arguments.
  const stream = new CompletionStream();
  assert.equal(stream.push(chunk({ content: "TEST" })), true);
  assert.equal(stream.push(toolEvents[1]!), false);
  assert.equal(stream.push("[DONE]"), false);
  assert.equal(stream.reply, "TEST");
  // An error inside the stream, or a malformed event, never passes as a reply.
  assert.deepEqual(
    completionFromStream(
      sse([chunk({ content: "TEST" }), '{"error":{"code":429}}']),
    ),
    { id: "TEST-gen", model: "TEST/model", error: { code: 429 } },
  );
  assert.ok(
    (completionFromStream(sse(["{not json"])) as { error?: unknown }).error,
  );
  assert.equal(completionFromStream(""), undefined);
  // The budget reads usage from either form.
  assert.deepEqual(
    (
      completionBody({
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
        text: sse(textEvents("TEST")),
      }) as { usage: unknown }
    ).usage,
    usage,
  );
  assert.deepEqual(
    completionBody({
      status: 200,
      headers: {},
      text: JSON.stringify({ usage }),
    }),
    { usage },
  );
});

async function parts(stream: ReadableStream<LanguageModelV4StreamPart>) {
  const result: LanguageModelV4StreamPart[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return result;
    result.push(value);
  }
}

test("a model streams its reply to an observer and resolves with the validated whole", async () => {
  const seen: TransportRequest[] = [];
  const texts: string[] = [];
  const model = createNiaroMastraModel(
    selection,
    streamingProvider(() => textEvents("TEST ", "streamed ", "answer"), seen),
    async (start) => start(),
    undefined,
    { onText: (text) => texts.push(text) },
  );
  const result = await model.doStream({ prompt: [] });
  assert.deepEqual(texts, ["TEST ", "TEST streamed ", "TEST streamed answer"]);
  const body = seen[0]!.body as Record<string, unknown>;
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  const streamed = await parts(result.stream);
  assert.deepEqual(
    streamed
      .filter((part) => part.type === "text-delta")
      .map((part) => (part as { delta: string }).delta),
    ["TEST streamed answer"],
  );
  const finish = streamed.at(-1) as Extract<
    LanguageModelV4StreamPart,
    { type: "finish" }
  >;
  assert.equal(finish.finishReason.unified, "stop");
  assert.equal(finish.usage.inputTokens.total, 20);
  assert.equal(finish.usage.outputTokens.total, 10);

  // Tool calls are assembled and validated; their arguments never reach the observer.
  texts.length = 0;
  const tools = createNiaroMastraModel(
    selection,
    streamingProvider(() => toolEvents),
    async (start) => start(),
    undefined,
    { onText: (text) => texts.push(text) },
  );
  const call = (
    await parts((await tools.doStream({ prompt: [] })).stream)
  ).find((part) => part.type === "tool-call") as Extract<
    LanguageModelV4StreamPart,
    { type: "tool-call" }
  >;
  assert.equal(call.toolName, "find_contact");
  assert.equal(call.input, '{"name":"Ada"}');
  assert.deepEqual(texts, ["TEST checking. "]);

  // doGenerate never streams.
  seen.length = 0;
  const generated = createNiaroMastraModel(
    selection,
    streamingTransport(async (request) => {
      seen.push(request);
      await request.beforeDispatch?.(() => {});
      return {
        status: 200,
        headers: {},
        text: JSON.stringify({
          choices: [{ message: { content: "TEST whole" } }],
          usage,
        }),
      };
    }),
    async (start) => start(),
    undefined,
    { onText: () => assert.fail("not streamed") },
  );
  await generated.doGenerate({ prompt: [] });
  assert.equal((seen[0]!.body as { stream?: boolean }).stream, undefined);
  assert.equal(seen[0]!.onEvent, undefined);
});

test("a transport that cannot stream, or a provider that ignores the request, keeps one whole reply", async () => {
  const seen: TransportRequest[] = [];
  const json = {
    status: 200,
    headers: {},
    text: JSON.stringify({
      choices: [{ message: { content: "TEST whole" } }],
      usage,
    }),
  };
  const plain: IntegrationTransport = async (request) => {
    seen.push(request);
    await request.beforeDispatch?.(() => {});
    return json;
  };
  assert.equal(canStream(plain), false);
  const observer = { onText: () => assert.fail("not streamed") };
  const model = createNiaroMastraModel(
    selection,
    plain,
    async (start) => start(),
    undefined,
    observer,
  );
  const streamed = await parts((await model.doStream({ prompt: [] })).stream);
  assert.equal((seen[0]!.body as { stream?: boolean }).stream, undefined);
  assert.equal(seen[0]!.onEvent, undefined);
  assert(streamed.some((part) => part.type === "text-delta"));

  const ignoring = streamingTransport(async (request) => {
    await request.beforeDispatch?.(() => {});
    assert.equal((request.body as { stream?: boolean }).stream, true);
    return json;
  });
  const fallback = createNiaroMastraModel(
    selection,
    ignoring,
    async (start) => start(),
    undefined,
    observer,
  );
  assert.equal(
    (
      (await parts((await fallback.doStream({ prompt: [] })).stream)).find(
        (part) => part.type === "text-delta",
      ) as { delta: string }
    ).delta,
    "TEST whole",
  );

  // A provider error inside the stream fails the call like an error status.
  const failing = createNiaroMastraModel(
    selection,
    streamingProvider(() => [
      chunk({ content: "TEST partial" }),
      JSON.stringify({ error: { code: 502, message: "TEST-stream-secret" } }),
    ]),
    async (start) => start(),
    undefined,
    { onText: () => {} },
  );
  await assert.rejects(
    async () => failing.doStream({ prompt: [] }),
    (error: unknown) =>
      error instanceof IntegrationError &&
      error.code === "integration_provider_failed" &&
      !JSON.stringify(error).includes("TEST-stream-secret"),
  );
});

test("the transport reports each server-sent event while the response is still open", async () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = createServer(async (req, res) => {
    if (req.url === "/json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    // One event split inside a multi-byte character, then a pause.
    const first = Buffer.from('data: {"text":"Příliš"}\n\n');
    res.write(first.subarray(0, 14));
    res.write(first.subarray(14));
    await released;
    res.end('data: {"text":"žluťoučký"}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const transport = createTransport([origin]);
    assert.equal(canStream(transport), true);
    const events: string[] = [];
    const response = await transport({
      url: `${origin}/stream`,
      onEvent: (data) => {
        events.push(data);
        if (events.length === 1) release();
      },
    });
    assert.deepEqual(events, [
      '{"text":"Příliš"}',
      '{"text":"žluťoučký"}',
      "[DONE]",
    ]);
    assert.match(response.text, /žluťoučký/);
    const ignored: string[] = [];
    const json = await transport({
      url: `${origin}/json`,
      onEvent: (data) => ignored.push(data),
    });
    assert.equal(json.text, '{"ok":true}');
    assert.deepEqual(ignored, []);
  } finally {
    server.close();
  }
});

/** A native run whose provider streams: a step that calls a tool, then an
 * answer the checker sends back once, then the accepted answer. */
test("the draft follows only the step that can become the answer and ends with the settled answer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "niaro-answer-draft-"));
  const runtime = createNativeAgentRuntime(
    pathToFileURL(join(directory, "native.sqlite")).href,
  );
  const drafts: (string | null)[] = [];
  let calls = 0;
  let finalizations = 0;
  const program = 'root = Stack([Text("TEST shown")])';
  const session: NativeAgentSession = {
    state: {},
    activeTools: () => ["find_contact"],
    prepareModel: async () => ({
      selected: selection,
      instructions: "TEST draft probe",
      privateContext: false,
    }),
    allowance: async (_provider, _revision, start) => start(),
    invoke: async () => ({ observed: true }),
    finalize: async (reply) => {
      if (++finalizations === 1) return { repair: "TEST try again" };
      const answer = {
        reply: "TEST accepted",
        ui: {
          type: "openui.program" as const,
          version: 1 as const,
          library: "niaro-ui@1" as const,
          program,
        },
      };
      assert.match(reply, /TEST second/);
      session.state.answer = answer;
      return answer;
    },
    save: async () => {},
  };
  const provider = streamingProvider(() => {
    calls++;
    if (calls === 1) return toolEvents;
    if (calls === 2) return textEvents("TEST first ", "answer");
    return textEvents("TEST second ", "answer");
  });
  const input: NativeAgentInput = {
    runId: "TEST-draft-run",
    threadId: "TEST-draft-thread",
    resourceId: "TEST-draft-resource",
    memoryMode: "none",
    text: "TEST find Ada",
    signal: new AbortController().signal,
    definitions: [
      {
        name: "find_contact",
        description: "TEST lookup",
        parameters: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
        validate: () => ({ valid: true }),
      },
    ],
    session,
    createModel: (selected, guard, observer) =>
      createNiaroMastraModel(selected, provider, guard, undefined, observer),
    onDraft: (draft) => {
      drafts.push(draft);
    },
  };
  try {
    const result = await runtime.execute(input);
    assert.equal(result.answer?.reply, "TEST accepted");
    assert.equal(calls, 3);
    assert.deepEqual(drafts, [
      // The tool step's preamble shows, then goes with its tool call.
      "TEST checking. ",
      null,
      "TEST first ",
      "TEST first answer",
      // The checker sent it back: it is gone before the model writes again.
      null,
      "TEST second ",
      "TEST second answer",
      // The accepted answer stays shown, with its admitted program.
      "TEST accepted\n\n```openui-lang\n" + program + "\n```",
    ]);
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a run without a draft observer never asks the provider to stream", async () => {
  const directory = mkdtempSync(join(tmpdir(), "niaro-answer-nodraft-"));
  const runtime = createNativeAgentRuntime(
    pathToFileURL(join(directory, "native.sqlite")).href,
  );
  const bodies: Record<string, unknown>[] = [];
  const provider = streamingTransport(async (request) => {
    bodies.push(request.body as Record<string, unknown>);
    await request.beforeDispatch?.(() => {});
    return {
      status: 200,
      headers: {},
      text: JSON.stringify({ choices: [{ message: { content: "TEST" } }] }),
    };
  });
  const session: NativeAgentSession = {
    state: {},
    activeTools: () => [],
    prepareModel: async () => ({
      selected: selection,
      instructions: "TEST",
      privateContext: false,
    }),
    allowance: async (_provider, _revision, start) => start(),
    invoke: async () => ({}),
    finalize: async (reply) => {
      const answer = { reply };
      session.state.answer = answer;
      return answer;
    },
    save: async () => {},
  };
  try {
    await runtime.execute({
      runId: "TEST-nodraft-run",
      threadId: "TEST-nodraft-thread",
      resourceId: "TEST-nodraft-resource",
      memoryMode: "none",
      text: "TEST",
      signal: new AbortController().signal,
      definitions: [],
      session,
      createModel: (selected, guard, observer) =>
        createNiaroMastraModel(selected, provider, guard, undefined, observer),
    });
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0]!.stream, undefined);
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
