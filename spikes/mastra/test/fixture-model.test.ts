import assert from "node:assert/strict";
import test from "node:test";
import { convertReadableStreamToArray } from "ai/test";
import { createFixtureModel } from "../src/fixture-model.ts";

type Options = Parameters<
  ReturnType<typeof createFixtureModel>["doGenerate"]
>[0];
type Prompt = Options["prompt"];
type Result = Awaited<
  ReturnType<ReturnType<typeof createFixtureModel>["doGenerate"]>
>;

function user(command: unknown): Prompt[number] {
  return {
    role: "user",
    content: [{ type: "text", text: JSON.stringify(command) }],
  };
}

function toolCall(result: Result) {
  const call = result.content.find((part) => part.type === "tool-call");
  assert.ok(call);
  return call;
}

function toolResult(
  call: ReturnType<typeof toolCall>,
  value: { personId: string },
): Prompt[number] {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: "json", value },
      },
    ],
  };
}

test("a fresh model continues the current action from its persisted tool result", async () => {
  const prompt: Prompt = [
    user({ kind: "create-person", operationId: "operation-a", name: "Alice" }),
  ];
  const first = await createFixtureModel().doGenerate({ prompt });
  const call = toolCall(first);
  assert.equal(call.toolName, "createPerson");
  assert.deepEqual(JSON.parse(call.input), {
    operationId: "operation-a",
    name: "Alice",
  });
  prompt.push({
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: JSON.parse(call.input),
      },
    ],
  });
  prompt.push(toolResult(call, { personId: "person-a" }));
  const resumed = await createFixtureModel().doGenerate({ prompt });
  assert.deepEqual(resumed.content, [
    { type: "text", text: '{"personId":"person-a"}' },
  ]);
  assert.equal(resumed.finishReason.unified, "stop");
});

test("old results and unrelated current results cannot complete a new operation", async () => {
  const oldCommand = user({
    kind: "create-person",
    operationId: "old-operation",
    name: "Old",
  });
  const oldCall = toolCall(
    await createFixtureModel().doGenerate({ prompt: [oldCommand] }),
  );
  const newCommand = user({
    kind: "create-person",
    operationId: "new-operation",
    name: "New",
  });
  const prompt: Prompt = [
    oldCommand,
    toolResult(oldCall, { personId: "old-person" }),
    newCommand,
    toolResult(oldCall, { personId: "late-old-person" }),
  ];
  const call = toolCall(await createFixtureModel().doGenerate({ prompt }));
  assert.deepEqual(JSON.parse(call.input), {
    operationId: "new-operation",
    name: "New",
  });
  assert.notEqual(call.toolCallId, oldCall.toolCallId);
});

test("native goal state and judge reminders do not hide the user action", async () => {
  const prompt: Prompt = [
    user({
      kind: "create-person",
      operationId: "operation-goal",
      name: "Alice",
    }),
    {
      role: "user",
      content: [
        {
          type: "text",
          text: '<current-objective status="active">Create Alice</current-objective>',
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: '<system-reminder type="goal-judge">Continue the goal.</system-reminder>',
        },
      ],
    },
  ];
  const call = toolCall(await createFixtureModel().doGenerate({ prompt }));
  assert.deepEqual(JSON.parse(call.input), {
    operationId: "operation-goal",
    name: "Alice",
  });
});

test("recall uses the last remember user message, without assistant or system quotes", async () => {
  const prompt: Prompt = [
    user({ kind: "remember", fact: "old fact" }),
    user({ kind: "remember", fact: "persisted fact" }),
    {
      role: "assistant",
      content: [
        { type: "text", text: '{"kind":"remember","fact":"assistant quote"}' },
      ],
    },
    { role: "system", content: '{"kind":"remember","fact":"system quote"}' },
    user({ kind: "recall" }),
  ];
  const result = await createFixtureModel().doGenerate({ prompt });
  assert.deepEqual(result.content, [{ type: "text", text: "persisted fact" }]);
});

test("a side quest does not repeat the preceding create-person command", async () => {
  const command = user({
    kind: "create-person",
    operationId: "operation-a",
    name: "Alice",
  });
  const sideQuest: Prompt[number] = {
    role: "user",
    content: [{ type: "text", text: "What else can you do?" }],
  };
  const result = await createFixtureModel().doGenerate({
    prompt: [command, sideQuest],
  });
  assert.equal(result.finishReason.unified, "stop");
  assert.ok(result.content.every((part) => part.type !== "tool-call"));
});

test("generate and stream share the same stateless verify-person behavior", async () => {
  const prompt: Prompt = [
    user({ kind: "verify-person", operationId: "operation-a" }),
  ];
  const generated = await createFixtureModel().doGenerate({ prompt });
  const streamed = await createFixtureModel().doStream({ prompt });
  const parts = await convertReadableStreamToArray(streamed.stream);
  assert.deepEqual(
    parts.filter((part) => part.type === "tool-call"),
    generated.content,
  );
  assert.equal(toolCall(generated).toolName, "verifyPerson");
  assert.deepEqual(JSON.parse(toolCall(generated).input), {
    operationId: "operation-a",
  });
});
