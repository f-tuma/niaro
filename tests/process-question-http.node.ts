import assert from "node:assert/strict";
import { test } from "node:test";
import { coordinatorHttpFixture } from "./helpers/process-coordinator-http";
import { ProcessDefinitionSchema } from "../packages/protocol/service-processes";
import { ProcessRuntimeResponseSchema } from "../packages/protocol/process-coordinator";
import {
  PROCESS_QUESTION_EXECUTION_PROFILE,
  ProcessAnswerCommandSchema,
} from "../packages/protocol/process-questions";
import {
  PROCESS_WORK_PROFILE,
  PROCESS_QUESTION_WORK_PROFILE,
} from "../packages/protocol/process-work";
import { SnapshotSchema } from "../packages/protocol";
import { CARD_PROFILE } from "../packages/protocol/card-document";
import { processObject } from "./helpers/service-process";
import { askQuestion } from "./helpers/process-questions-runtime";

test("authenticated V2 answers and passive question Tasks survive reopen; old delivery has no actionable new tuple", async () => {
  const h = await coordinatorHttpFixture({ allowOrdinaryRuntime: true });
  let modelCalls = 0;
  const install = () => {
    const transport = h.identity["catalog"].transport;
    Object.defineProperty(h.identity["catalog"], "transport", {
      value: async (request: Parameters<typeof transport>[0]) => {
        if (new URL(request.url).origin !== "https://models.example.test")
          return transport(request);
        assert(request.beforeDispatch);
        await request.beforeDispatch(() => {
          modelCalls++;
        });
        return {
          status: 200,
          headers: {},
          text: JSON.stringify({
            choices: [
              {
                message:
                  modelCalls === 1
                    ? askQuestion()
                    : modelCalls === 2
                      ? askQuestion("TEST question B?")
                      : { content: '{"result":"TEST done"}' },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.00002 },
          }),
        };
      },
    });
  };
  const suffix =
    "?profile=" + encodeURIComponent(PROCESS_QUESTION_EXECUTION_PROFILE);
  const snapshot = (tasks: string) =>
    "snapshot?cards=" +
    encodeURIComponent(CARD_PROFILE) +
    "&tasks=" +
    encodeURIComponent(tasks);
  try {
    install();
    const base = h.workflow();
    const budget = h.identity["catalog"].store.inferenceBudget;
    const policy = budget.policy(h.target.organizationId, h.target.workspaceId);
    budget.savePolicy(
      h.target.organizationId,
      h.target.workspaceId,
      policy.revision,
      {
        ...policy.settings,
        prices: policy.settings.prices.map((price) => ({
          ...price,
          maxInputTokens: 50000,
          maxOutputTokens: 10000,
        })),
      },
    );
    const artifact = h.activate(
      ProcessDefinitionSchema.parse({
        schemaVersion: 1,
        kind: "agent",
        name: "TEST question agent",
        description: "Offline HTTP question fixture",
        trigger: "manual",
        inputSchema: base.inputSchema,
        outputSchema: processObject({ result: { type: "string" } }),
        limits: { ...base.limits, maxModelCalls: 4 },
        modelId: h.modelId,
        instructions: "TEST typed output",
        memory: "none",
        humanInput: "text",
        capabilities: [],
      }),
    );
    const credential = await h.pair("owner");
    const inventory = await h.mobile(credential, "processes" + h.suffix);
    assert.equal(inventory.status, 200, JSON.stringify(inventory.data));
    assert(
      !JSON.stringify(inventory.data).includes('"availability":"blocked"'),
      JSON.stringify(inventory.data),
    );
    const start = await h.prepare(credential, artifact);
    assert.equal(
      (await h.mobile(credential, "processes/commands" + h.suffix, start))
        .status,
      406,
    );
    assert.equal(modelCalls, 0);
    const initial = await h.mobile(
      credential,
      "processes/commands" + suffix,
      start,
    );
    assert.equal(initial.status, 202, JSON.stringify(initial.data));
    const a = ProcessRuntimeResponseSchema.parse(initial.data);
    const q = a.process?.question;
    assert(q, JSON.stringify(initial.data));
    const command = ProcessAnswerCommandSchema.parse({
      profile: PROCESS_QUESTION_EXECUTION_PROFILE,
      type: "process.answer",
      commandId: "TEST-http-answer-A",
      idempotencyKey: "TEST-http-answer-A-key",
      conversationId: start.conversationId,
      workItemId: a.process!.parentRunId,
      expectedWorkRevision: a.process!.revision,
      nodeId: q.nodeId,
      childRunId: q.childRunId,
      toolCallId: q.toolCallId,
      questionId: q.questionId,
      questionRevision: q.questionRevision,
      answer: "  TEST exact answer\n",
      language: "cs",
    });
    const read = async (tasks: string) => {
      const result = await h.mobile(credential, snapshot(tasks));
      assert.equal(result.status, 200, JSON.stringify(result.data));
      return SnapshotSchema.parse(result.data).workItems.find(
        (w) => w.id === a.process!.parentRunId,
      )!;
    };
    const work = await read(PROCESS_QUESTION_WORK_PROFILE);
    assert.equal(work.status, "waiting_input");
    assert.deepEqual(work.native?.process?.question, q);
    assert.equal(work.native?.process?.answerHistory, undefined);
    assert(!JSON.stringify(work).includes('"resourceId"'));
    assert(!JSON.stringify(work).includes('"questionProof"'));
    assert(JSON.stringify(work.card).includes(q.question));
    const old = await read(PROCESS_WORK_PROFILE);
    assert.equal(old.status, "waiting_system");
    assert(!old.native?.process?.question);
    assert.equal(modelCalls, 1);
    assert.deepEqual(h.dispatches, []);
    assert.equal(
      (await h.mobile(undefined, "processes/commands" + suffix, command))
        .status,
      401,
    );
    const other = await h.pair("member");
    assert.notEqual(other.scope.userId, credential.scope.userId);
    assert.equal(
      (await h.mobile(other, "processes/commands" + suffix, command)).status,
      404,
    );
    assert.equal(
      (await h.mobile(credential, "processes/commands" + h.suffix, command))
        .status,
      406,
    );
    // A fresh HTTP owner also verifies that the still-unconsumed question survives restart.
    // Keep each batch within the production POST rate limit.
    await h.restart();
    install();
    for (const change of [
      { questionRevision: 2 },
      { expectedWorkRevision: command.expectedWorkRevision + 1 },
      { answer: " " },
      { approved: true },
    ]) {
      const rejected = await h.mobile(
        credential,
        "processes/commands" + suffix,
        { ...command, ...change },
      );
      assert(
        [400, 409].includes(rejected.status),
        JSON.stringify({ change, ...rejected }),
      );
    }
    assert.equal(modelCalls, 1);
    const reply = await h.mobile(
      credential,
      "processes/commands" + suffix,
      command,
    );
    assert.equal(reply.status, 202, JSON.stringify(reply.data));
    const b = ProcessRuntimeResponseSchema.parse(reply.data);
    assert(b.process?.question);
    assert.equal(b.process.question.questionRevision, 2);
    const answeredWork = await read(PROCESS_QUESTION_WORK_PROFILE);
    assert.deepEqual(answeredWork.native?.process?.answerHistory, [
      {
        commandId: command.commandId,
        questionId: q.questionId,
        answer: command.answer,
      },
    ]);
    const acceptedSnapshot = await h.mobile(
      credential,
      snapshot(PROCESS_QUESTION_WORK_PROFILE),
    );
    const acceptedMessages = SnapshotSchema.parse(
      acceptedSnapshot.data,
    ).conversations.find((c) => c.id === command.conversationId)!.messages;
    assert.equal(
      acceptedMessages.filter(
        (m) => m.id === `message-process-answer-${q.questionId}`,
      ).length,
      1,
    );
    assert.equal(
      acceptedMessages.find(
        (m) => m.id === `message-process-answer-${q.questionId}`,
      )!.text,
      command.answer,
    );
    const oldAnsweredWork = await read(PROCESS_WORK_PROFILE);
    assert(!oldAnsweredWork.native?.process?.answerHistory);
    for (let i = 0; i < 2; i++) {
      await h.restart();
      install();
      const saved = await h.mobile(
        credential,
        "processes/runs" + suffix + "&parentRunId=" + a.process!.parentRunId,
      );
      assert.equal(saved.status, 200);
      const savedState = ProcessRuntimeResponseSchema.parse(saved.data);
      assert.equal(savedState.commandId, start.commandId);
      assert.deepEqual(savedState.admission, b.admission);
      assert.deepEqual(savedState.process, b.process);
      assert.deepEqual(
        (await h.mobile(credential, "processes/commands" + suffix, command))
          .data,
        b,
      );
      assert.equal(
        (await read(PROCESS_QUESTION_WORK_PROFILE)).native?.process?.question
          ?.questionId,
        b.process.question.questionId,
      );
      assert.equal(modelCalls, 2);
      assert.deepEqual(h.dispatches, []);
    }
    assert.equal(
      (
        await h.mobile(credential, "processes/commands/interrupt" + suffix, {
          profile: "agent-process-execution/1",
          command,
        })
      ).status,
      400,
    );
    assert.equal(modelCalls, 2);
  } finally {
    await h.close();
  }
});
