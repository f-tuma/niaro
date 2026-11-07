import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
} from "../apps/server-agent/model-types";
import type {
  NativeAgentInput,
  NativeAgentSession,
} from "../apps/server-agent/native-contract";

// NIAR-304 step A: the native agent contract on Pi (design D12).

type Pi = typeof import("@niaro/server-agent/pi");
let PiAgentCore: Pi["PiAgentCore"];
before(async () => {
  ({ PiAgentCore } = await import("@niaro/server-agent/pi"));
});

const selected = {
  provider: { id: "TEST-provider", revision: 1 },
  model: { id: "TEST-model-id", model: "TEST-model" },
} as unknown as NonNullable<
  Awaited<ReturnType<NativeAgentSession["prepareModel"]>>
>["selected"];
const noHost = {
  plan: async () => {
    throw new Error("TEST no route model");
  },
};
const definitions: NativeAgentInput["definitions"] = [
  {
    name: "write_note",
    description: "Write a note (needs approval)",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    validate: (input) =>
      input &&
      typeof input === "object" &&
      typeof (input as { text?: unknown }).text === "string"
        ? { valid: true }
        : {
            valid: false,
            fields: [{ path: "/text", issue: "Required field is missing." }],
          },
  },
  {
    name: "ask_user",
    description: "Ask the person",
    parameters: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
    },
    validate: () => ({ valid: true }),
  },
];

type Script = (options: LanguageModelV4CallOptions) => {
  text?: string;
  call?: { name: string; args: unknown };
};
const prompts: LanguageModelV4CallOptions["prompt"][] = [];
function model(script: Script): NativeAgentInput["createModel"] {
  return (_selected, guard) =>
    ({
      specificationVersion: "v4",
      provider: "test",
      modelId: "test",
      supportedUrls: {},
      doGenerate: async () => {
        throw new Error("TEST stream only");
      },
      doStream: async (options: LanguageModelV4CallOptions) => {
        await guard(() => undefined);
        prompts.push(options.prompt);
        const reply = script(options);
        const parts: LanguageModelV4StreamPart[] = [];
        if (reply.text)
          parts.push(
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: reply.text },
            { type: "text-end", id: "t" },
          );
        if (reply.call)
          parts.push({
            type: "tool-call",
            toolCallId: `TEST-call-${prompts.length}`,
            toolName: reply.call.name,
            input: JSON.stringify(reply.call.args),
          });
        parts.push({
          type: "finish",
          finishReason: {
            unified: reply.call ? "tool-calls" : "stop",
            raw: undefined,
          },
          usage: {
            inputTokens: {
              total: 1,
              noCache: 1,
              cacheRead: 0,
              cacheWrite: 0,
            },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        } as LanguageModelV4StreamPart);
        return {
          stream: new ReadableStream({
            start(controller) {
              for (const part of parts) controller.enqueue(part);
              controller.close();
            },
          }),
        };
      },
    }) as unknown as LanguageModelV4;
}

type Invocation = { name: string; args: unknown; toolCallId: string };
function session(options: {
  invocations: Invocation[];
  approved?: boolean;
  privateContext?: boolean;
}): NativeAgentSession {
  const state: NativeAgentSession["state"] = {};
  return {
    state,
    activeTools: () => ["write_note", "ask_user"],
    prepareModel: async () => ({
      selected,
      instructions: "TEST instructions",
      context: "TEST per-step context",
      privateContext: options.privateContext ?? false,
    }),
    allowance: async (_provider, _revision, start) => start(),
    invoke: async (name, args, meta) => {
      options.invocations.push({ name, args, toolCallId: meta.toolCallId });
      if (name === "ask_user") {
        state.pending = {
          kind: "question",
          toolCallId: meta.toolCallId,
          question: "Which day?",
        };
        return { asked: true };
      }
      if (!options.approved) {
        state.pending = {
          kind: "approval",
          toolCallId: meta.toolCallId,
          operationId: "TEST-operation",
        };
        return { status: "awaiting_approval", operationId: "TEST-operation" };
      }
      return { status: "succeeded", operationId: "TEST-operation" };
    },
    finalize: async (reply) => ({ reply }) as never,
    save: async () => undefined,
  };
}
const answerAfterResult: Script = (options) => {
  const last = options.prompt.findLast((message) => message.role !== "system");
  return last?.role === "tool"
    ? { text: "TEST done" }
    : { call: { name: "write_note", args: { text: "TEST note" } } };
};
const input = (
  overrides: Partial<NativeAgentInput> & Pick<NativeAgentInput, "session">,
): NativeAgentInput => ({
  runId: "TEST-run-1",
  threadId: "TEST-thread",
  resourceId: "TEST-resource",
  text: "Write a note",
  signal: new AbortController().signal,
  definitions,
  createModel: model(answerAfterResult),
  ...overrides,
});
const binding = {
  runId: "TEST-run-1",
  threadId: "TEST-thread",
  resourceId: "TEST-resource",
};

test("a turn answers through the bound session's model, and history shows only the member view", async () => {
  const core = await PiAgentCore.open({ host: noHost });
  try {
    const runtime = core.agentRuntime();
    const invocations: Invocation[] = [];
    const events: string[] = [];
    const result = await runtime.execute(
      input({
        session: session({ invocations, approved: true }),
        onEvent: (event) => {
          events.push(event.type);
        },
      }),
    );
    assert.equal(result.suspended, false);
    assert.equal(result.answer?.reply, "TEST done");
    assert.deepEqual(
      invocations.map((call) => call.name),
      ["write_note"],
    );
    assert.deepEqual(events, [
      "model-start",
      "model-end",
      "tool-start",
      "tool-end",
      "model-start",
      "model-end",
    ]);
    // Instructions first, the per-step context last.
    const last = prompts.at(-1)!;
    assert.equal(last[0]!.role, "system");
    assert.equal(last[0]!.content, "TEST instructions");
    assert.equal(last.at(-1)!.content, "TEST per-step context");
    assert(runtime.isSettled("TEST-run-1"));
    assert(await runtime.proveRetired(binding));
    const { messages } = await runtime.inspect(binding);
    assert.deepEqual(
      messages.map((message) => message.role),
      ["user", "assistant", "assistant"],
    );
    const call = messages[1]!.content.parts[0]!;
    assert(call.type === "tool-invocation");
    // Arguments stay opaque in history.
    assert.deepEqual(call.toolInvocation.args, {});
  } finally {
    await core.close();
  }
});

test("an approval suspends the request, survives a restart and finishes under the resuming session", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-native-"));
  const file = join(root, "identity.sqlite.pi.sqlite");
  try {
    let core = await PiAgentCore.open({ host: noHost, file });
    const invocations: Invocation[] = [];
    const first = session({ invocations });
    const suspended = await core
      .agentRuntime()
      .execute(input({ session: first }));
    assert.equal(suspended.suspended, true);
    const toolCallId = first.state.pending!.toolCallId;
    assert(core.agentRuntime().isSettled("TEST-run-1"));
    assert(
      await core.agentRuntime().proveSuspended({ ...binding, toolCallId }),
    );
    assert.equal(await core.agentRuntime().proveRetired(binding), false);
    await core.close();

    core = await PiAgentCore.open({ host: noHost, file });
    const runtime = core.agentRuntime();
    assert(await runtime.proveSuspended({ ...binding, toolCallId }));
    // No request resumed it, so nothing ran again.
    assert.equal(invocations.length, 1);
    const resumed = await runtime.execute(
      input({
        text: undefined,
        resume: { toolCallId, data: { resolved: true } },
        session: session({ invocations, approved: true }),
      }),
    );
    assert.equal(resumed.suspended, false);
    assert.equal(resumed.answer?.reply, "TEST done");
    // The resumed call asked the domain again under the new session, with
    // the same call id: the receipt answers it.
    assert.deepEqual(
      invocations.map((call) => call.toolCallId),
      [toolCallId, toolCallId],
    );
    assert(await runtime.proveRetired(binding));
    assert.equal(
      await runtime.proveSuspended({ ...binding, toolCallId }),
      false,
    );
    await core.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a question resumes with the answer, and a new turn during a pending approval forks the thread", async () => {
  const core = await PiAgentCore.open({ host: noHost });
  try {
    const runtime = core.agentRuntime();
    const invocations: Invocation[] = [];
    // Turn 1 waits for approval.
    const first = session({ invocations });
    assert.equal(
      (await runtime.execute(input({ session: first }))).suspended,
      true,
    );
    const approvalCall = first.state.pending!.toolCallId;
    // Turn 2 on the same thread asks a question; the thread forks.
    const second = session({ invocations });
    const asking: Script = (options) =>
      options.prompt.some((message) => message.role === "tool")
        ? { text: "TEST tomorrow it is" }
        : { call: { name: "ask_user", args: { question: "Which day?" } } };
    const asked = await runtime.execute(
      input({
        runId: "TEST-run-2",
        text: "Plan something",
        session: second,
        createModel: model(asking),
      }),
    );
    assert.equal(asked.suspended, true);
    const questionCall = second.state.pending!.toolCallId;
    const answered = await runtime.execute(
      input({
        runId: "TEST-run-2",
        text: undefined,
        resume: { toolCallId: questionCall, data: { answer: "Tomorrow" } },
        session: session({ invocations }),
        createModel: model(asking),
      }),
    );
    assert.equal(answered.answer?.reply, "TEST tomorrow it is");
    // The approval of turn 1 is still waiting and resumable.
    assert(
      await runtime.proveSuspended({ ...binding, toolCallId: approvalCall }),
    );
    const approved = await runtime.execute(
      input({
        text: undefined,
        resume: { toolCallId: approvalCall, data: { resolved: true } },
        session: session({ invocations, approved: true }),
      }),
    );
    assert.equal(approved.answer?.reply, "TEST done");
  } finally {
    await core.close();
  }
});

test("a failed model call fails the run at once, and history shows no failed attempt", async () => {
  const core = await PiAgentCore.open({ host: noHost });
  try {
    const runtime = core.agentRuntime();
    let calls = 0;
    const failing: NativeAgentInput["createModel"] = () =>
      ({
        specificationVersion: "v4",
        provider: "test",
        modelId: "test",
        supportedUrls: {},
        doGenerate: async () => {
          throw new Error("TEST");
        },
        doStream: async () => {
          calls++;
          throw Object.assign(new Error("integration_provider_failed"), {
            code: "integration_provider_failed",
          });
        },
      }) as unknown as LanguageModelV4;
    await assert.rejects(
      runtime.execute(
        input({
          session: session({ invocations: [] }),
          createModel: failing,
        }),
      ),
      /integration_provider_failed/,
    );
    // The domain owns fallback; Pi never retries a chat request by itself.
    assert.equal(calls, 1);
    assert(await runtime.proveRetired(binding));
    const { messages } = await runtime.inspect(binding);
    assert.deepEqual(
      messages.map((message) => message.role),
      ["user"],
    );
  } finally {
    await core.close();
  }
});

test("an invalid call reaches the model as field evidence and never the domain", async () => {
  const core = await PiAgentCore.open({ host: noHost });
  try {
    const runtime = core.agentRuntime();
    const invocations: Invocation[] = [];
    const script: Script = (options) =>
      options.prompt.some((message) => message.role === "tool")
        ? { text: "TEST asked for the text" }
        : { call: { name: "write_note", args: { body: "no text" } } };
    const result = await runtime.execute(
      input({
        session: session({ invocations, approved: true }),
        createModel: model(script),
      }),
    );
    assert.equal(result.answer?.reply, "TEST asked for the text");
    assert.equal(invocations.length, 0);
    const tool = prompts
      .at(-1)!
      .flatMap((message) =>
        message.role === "tool" ? message.content : [],
      )[0]!;
    assert(tool.type === "tool-result" && tool.output.type === "json");
    assert.deepEqual(
      (tool.output.value as { failure: { fields: unknown } }).failure.fields,
      [{ path: "/text", issue: "Required field is missing." }],
    );
  } finally {
    await core.close();
  }
});
