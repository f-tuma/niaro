import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { test } from "node:test";
import { DurableStepIds } from "@mastra/core/agent/durable";
import { LibSQLStore } from "@mastra/libsql";
import {
  createNativeAgentRuntime,
  type NativeAgentEvent,
  type NativeAgentInput,
  type NativeAgentSession,
} from "../apps/server-agent/runtime";
import {
  ProcessAnyResumeSchema,
  ProcessResumeSchema,
  processCompilerVersion,
  processWorkflowDefinition,
  type NativeWorkflowBoundary,
  type ProcessBoundaryResult,
} from "../apps/server-agent/process-workflow";
import { proveProcessWorkflowCheckpoint } from "../apps/server-agent/process-checkpoint";
import {
  inspectNativeAgentCheckpoint,
  proveNativeAgentQuestionCheckpoint,
  proveNativeAgentQuestionRecovery,
} from "../apps/server-agent/recovery";
import {
  ProcessQuestionSchema,
  type ProcessQuestion,
} from "../packages/protocol/process-questions";
import { ProcessDefinitionSchema } from "../packages/protocol/service-processes";
import { createNiaroMastraModel } from "../apps/server-integrations/mastra-model";
import { nativeToolValidator } from "../apps/server-identity/mastra-domain";
import { createTrustHarness } from "./agent-trust/harness";
import { processWorkflow } from "./helpers/service-process";
import { questionFixture } from "./helpers/process-questions-runtime";
import { nativeCatalogOwner } from "../apps/server-identity/mastra-runtime";

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const signal = () => new AbortController().signal;
const proof = (overrides: Partial<ProcessQuestion> = {}) =>
  ProcessQuestionSchema.parse({
    kind: "question",
    questionId: "TEST-question",
    questionRevision: 1,
    parentRunId: "TEST-parent",
    nodeId: "agent",
    childRunId: "TEST-child",
    childThreadId: "TEST-thread",
    resourceId: "1".repeat(64),
    toolCallId: "TEST-call",
    question: "Which name?",
    questionDigest: digest("Which name?"),
    artifactDigest: "2".repeat(64),
    compilerVersion: "niaro-native-workflow/3",
    inputDigest: "3".repeat(64),
    issuedWorkRevision: 1,
    ...overrides,
  });
const action = processWorkflow("TEST-service", "TEST-action");
assert(action.kind === "workflow");
const { entry: _entry, steps: _steps, ...base } = action;
const agent = ProcessDefinitionSchema.parse({
  ...base,
  kind: "agent",
  modelId: "TEST-model",
  instructions: "TEST typed output",
  memory: "none",
  humanInput: "text",
  capabilities: [],
  limits: { ...base.limits, maxModelCalls: 4 },
});

function parentBoundary(question: ProcessQuestion) {
  let receipt: ProcessBoundaryResult = { status: "waiting", question };
  const resumes: unknown[] = [];
  let calls = 0;
  const boundary: NativeWorkflowBoundary = {
    authorize: async () => {},
    enter: async () => {},
    leave: async () => {},
    action: async () => {
      throw new Error("TEST action must not execute");
    },
    agent: async (_node, input, resume) => {
      calls++;
      assert.deepEqual(input, { name: "TEST input" });
      resumes.push(resume);
      if (!resume) return receipt;
      assert("kind" in resume);
      assert.equal(resume.answerId, "TEST-answer");
      receipt = {
        status: "complete",
        output: { result: "TEST canonical answer" },
      };
      return receipt;
    },
    reconcile: (checkpoint, workflowId) =>
      proveProcessWorkflowCheckpoint({
        checkpoint,
        workflowId,
        definition: agent,
        compilerVersion: "niaro-native-workflow/3",
        proveNode: async () => receipt,
      }),
  };
  return { boundary, resumes, calls: () => calls };
}

test("compiler 3 opts in explicitly, preserves synthetic humanInput and legacy strict resume", () => {
  assert.equal(processCompilerVersion(agent), "niaro-native-workflow/3");
  assert.equal(processWorkflowDefinition(agent).steps[0]!.type, "agent");
  const root = processWorkflowDefinition(agent).steps[0]!;
  assert(root.type === "agent");
  assert.equal(root.humanInput, "text");
  const legacy = { ...agent };
  assert(legacy.kind === "agent");
  delete legacy.humanInput;
  assert.equal(processCompilerVersion(legacy), "niaro-native-workflow/2");
  assert.equal(processCompilerVersion(action), "niaro-native-workflow/1");
  const resume = {
    kind: "question",
    nodeId: "agent",
    questionId: "TEST-question",
    questionRevision: 1,
    answerId: "TEST-answer",
  };
  assert(ProcessAnyResumeSchema.safeParse(resume).success);
  assert.equal(ProcessResumeSchema.safeParse(resume).success, false);
  assert.equal(
    ProcessAnyResumeSchema.safeParse({ ...resume, answer: "forged" }).success,
    false,
  );
});

test("real persisted native parent suspends, rejects wrong question tuples and resumes typed output", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "niaro-native-parent-question-"),
  );
  const url = pathToFileURL(join(directory, "native.sqlite")).href;
  let runtime = createNativeAgentRuntime(url);
  const question = proof();
  const h = parentBoundary(question);
  const input = {
    runId: question.parentRunId,
    resourceId: question.resourceId,
    artifactDigest: question.artifactDigest,
    compilerVersion: question.compilerVersion,
    definition: agent,
    input: { name: "TEST input" },
    signal: signal(),
    boundary: h.boundary,
  };
  try {
    assert.deepEqual(await runtime.executeWorkflow(input), {
      status: "waiting",
      question,
    });
    assert.equal(h.calls(), 1);
    await runtime.close();
    runtime = createNativeAgentRuntime(url);
    assert.deepEqual(
      await runtime.executeWorkflow({ ...input, recordedProgress: true }),
      { status: "waiting", question },
    );
    for (const wrong of [
      { questionId: "TEST-wrong" },
      { questionRevision: 2 },
      { nodeId: "done" },
    ]) {
      await assert.rejects(
        runtime.executeWorkflow({
          ...input,
          resume: {
            kind: "question",
            nodeId: "agent",
            questionId: question.questionId,
            questionRevision: 1,
            answerId: "TEST-answer",
            ...wrong,
          },
        }),
        /process_approval_conflict|process_question_conflict/,
      );
    }
    assert.equal(h.calls(), 1);
    assert.deepEqual(
      await runtime.executeWorkflow({
        ...input,
        resume: {
          kind: "question",
          nodeId: "agent",
          questionId: question.questionId,
          questionRevision: 1,
          answerId: "TEST-answer",
        },
      }),
      { status: "succeeded", output: { result: "TEST canonical answer" } },
    );
    assert.equal(h.calls(), 2);
    assert.equal(await runtime.proveWorkflowRetired(input), true);
    assert.deepEqual(await runtime.executeWorkflow(input), {
      status: "succeeded",
      output: { result: "TEST canonical answer" },
    });
    assert.equal(h.calls(), 2);
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("compiler 3 action boundaries keep approval resumes and reject question promotion", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "niaro-native-question-action-"),
  );
  const runtime = createNativeAgentRuntime(
    pathToFileURL(join(directory, "native.sqlite")).href,
  );
  const workflow = processWorkflowDefinition(agent);
  const opted = workflow.steps[0]!;
  assert(opted.type === "agent");
  const definition = ProcessDefinitionSchema.parse({
    ...workflow,
    entry: "lookup",
    steps: [{ ...action.steps[0]!, next: opted.id }, opted, workflow.steps[1]!],
  });
  let actionCalls = 0;
  let promote = false;
  const boundary: NativeWorkflowBoundary = {
    authorize: async () => {},
    enter: async () => {},
    leave: async () => {},
    action: async (_node, _bound, resume) => {
      actionCalls++;
      if (promote)
        return {
          status: "waiting",
          question: proof({ nodeId: "lookup" }),
        } as never;
      if (!resume)
        return {
          status: "waiting",
          approval: { nodeId: "lookup", operationId: "TEST-operation" },
        };
      assert.equal(resume.approved, true);
      return { status: "complete", output: { value: "TEST action" } };
    },
    agent: async () => ({
      status: "complete",
      output: { result: "TEST result" },
    }),
  };
  const input = {
    runId: "TEST-parent",
    resourceId: "1".repeat(64),
    artifactDigest: "2".repeat(64),
    compilerVersion: "niaro-native-workflow/3",
    definition,
    input: { name: "TEST input" },
    signal: signal(),
    boundary,
  };
  try {
    assert.deepEqual(await runtime.executeWorkflow(input), {
      status: "waiting",
      approval: { nodeId: "lookup", operationId: "TEST-operation" },
    });
    await assert.rejects(
      runtime.executeWorkflow({
        ...input,
        resume: {
          kind: "question",
          nodeId: "lookup",
          questionId: "TEST-question",
          questionRevision: 1,
          answerId: "TEST-answer",
        },
      }),
      /process_approval_conflict|process_question_conflict/,
    );
    assert.equal(actionCalls, 1);
    assert.deepEqual(
      await runtime.executeWorkflow({
        ...input,
        resume: {
          nodeId: "lookup",
          operationId: "TEST-operation",
          approved: true,
        },
      }),
      { status: "succeeded", output: { result: "TEST result" } },
    );
    assert.equal(actionCalls, 2);
    promote = true;
    assert.deepEqual(
      await runtime.executeWorkflow({ ...input, runId: "TEST-promote-parent" }),
      { status: "failed", code: "process_question_conflict" },
    );
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

const questionSchema = {
  type: "object",
  properties: { question: { type: "string" } },
  required: ["question"],
  additionalProperties: false,
};
function childFixture(withPrecedingTool = false, questionsInTurn = 1) {
  const h = createTrustHarness();
  const url = pathToFileURL(join(h.root, "questions.sqlite")).href;
  let runtime = createNativeAgentRuntime(url);
  const question = proof();
  const events: Parameters<NonNullable<NativeAgentInput["onEvent"]>>[0][] = [];
  const requests: unknown[] = [];
  let consumerCalls = 0;
  let rejectConsumer = false;
  const selected = h.catalog.resolveModel(
    h.target.organizationId,
    h.target.workspaceId,
  )!;
  const session: NativeAgentSession = {
    state: {},
    activeTools: () =>
      withPrecedingTool ? ["TEST_probe", "ask_user"] : ["ask_user"],
    prepareModel: async () => ({
      selected,
      instructions: "TEST question",
      privateContext: false,
    }),
    allowance: async (_provider, _revision, start) => start(),
    invoke: async (name, args, metadata) => {
      assert.equal(metadata.runId, question.childRunId);
      if (name === "TEST_probe") return { observed: true };
      if (questionsInTurn > 1) {
        question.questionRevision = consumerCalls + 1;
        question.questionId = "TEST-question-" + question.questionRevision;
        question.question = (args as { question: string }).question;
        question.questionDigest = digest(question.question);
      }
      question.toolCallId = metadata.toolCallId;
      session.state.pending = {
        kind: "question",
        toolCallId: metadata.toolCallId,
        question: question.question,
        questionProof: structuredClone(question),
      };
      return { asked: true };
    },
    consumeQuestionAnswer: async (metadata, data) => {
      consumerCalls++;
      assert.equal(metadata.toolCallId, question.toolCallId);
      assert.deepEqual(data, {
        answer: "TEST supplied answer",
        answerId:
          "TEST-answer" +
          (questionsInTurn > 1 ? "-" + question.questionRevision : ""),
        questionId: question.questionId,
        questionRevision: question.questionRevision,
      });
      if (rejectConsumer) throw new Error("TEST consume rejected");
      delete session.state.pending;
      return (
        "TEST canonical answer" +
        (questionsInTurn > 1 ? "-" + question.questionRevision : "")
      );
    },
    finalize: async (reply) => {
      session.state.answer = { reply };
      return { reply };
    },
    save: async () => {},
  };
  const input = (): NativeAgentInput => ({
    runId: question.childRunId,
    threadId: question.childThreadId,
    resourceId: question.resourceId,
    memoryMode: "none",
    text: "TEST question input",
    signal: signal(),
    session,
    definitions: [
      ...(withPrecedingTool
        ? [
            {
              name: "TEST_probe",
              description: "TEST preceding tool",
              parameters: {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
              validate: nativeToolValidator({
                type: "object",
                properties: {},
                additionalProperties: false,
              }),
            },
          ]
        : []),
      {
        name: "ask_user",
        description: "TEST ask",
        parameters: questionSchema,
        validate: nativeToolValidator(questionSchema),
      },
    ],
    createModel: (selection, guard) =>
      createNiaroMastraModel(
        selection,
        async (request) => {
          await request.beforeDispatch?.(() => {});
          const body = request.body as { messages: { role: string }[] };
          requests.push(structuredClone(body));
          return {
            status: 200,
            headers: {},
            text: JSON.stringify({
              choices: [
                {
                  message: body.messages.some((entry) => entry.role === "tool")
                    ? { content: "TEST completed" }
                    : {
                        content: null,
                        tool_calls: [
                          ...(withPrecedingTool
                            ? [
                                {
                                  id: "TEST-provider-probe",
                                  type: "function",
                                  function: {
                                    name: "TEST_probe",
                                    arguments: "{}",
                                  },
                                },
                              ]
                            : []),
                          ...Array.from(
                            { length: questionsInTurn },
                            (_, index) => ({
                              id:
                                "TEST-provider-call" +
                                (questionsInTurn > 1 ? "-" + index : ""),
                              type: "function",
                              function: {
                                name: "ask_user",
                                arguments: JSON.stringify({
                                  question:
                                    questionsInTurn > 1
                                      ? "TEST question " + index + "?"
                                      : question.question,
                                }),
                              },
                            }),
                          ),
                        ],
                      },
                },
              ],
            }),
          };
        },
        guard,
      ),
    onEvent: (event) => {
      events.push(event);
    },
  });
  const binding = () => ({
    runId: question.childRunId,
    threadId: question.childThreadId,
    resourceId: question.resourceId,
    toolCallId: question.toolCallId,
    question: structuredClone(question),
  });
  const resume = (): NativeAgentInput => ({
    ...input(),
    resume: {
      toolCallId: question.toolCallId,
      data: {
        answer: "TEST supplied answer",
        answerId:
          "TEST-answer" +
          (questionsInTurn > 1 ? "-" + question.questionRevision : ""),
        questionId: question.questionId,
        questionRevision: question.questionRevision,
      },
    },
  });
  return {
    h,
    url,
    question,
    session,
    input,
    binding,
    resume,
    events,
    requests,
    runtime: () => runtime,
    consumerCalls: () => consumerCalls,
    rejectConsumer: () => {
      rejectConsumer = true;
    },
    restart: async () => {
      await runtime.close();
      runtime = createNativeAgentRuntime(url);
    },
    close: async () => {
      await runtime.close();
      await h.close();
    },
  };
}

test("real native ask_user checkpoint proves full private question and resumes after restart", async () => {
  const h = childFixture();
  try {
    assert.equal((await h.runtime().execute(h.input())).suspended, true);
    assert.equal(await h.runtime().proveSuspended(h.binding()), true);
    const store = new LibSQLStore({ id: "TEST-inspect", url: h.url });
    await store.init();
    try {
      const binding = {
        ...h.binding(),
        agentId:
          "niaro-native-" +
          createHash("sha256").update(h.question.childRunId).digest("hex"),
      };
      const checkpoint = await inspectNativeAgentCheckpoint(store, binding);
      assert(checkpoint);
      assert.equal(checkpoint.questionProofsValid, true);
      assert.deepEqual(checkpoint.questionSuspensions, [
        {
          kind: "question",
          toolName: "ask_user",
          toolCallId: h.question.toolCallId,
          questionProof: h.question,
        },
      ]);
      assert.equal(
        proveNativeAgentQuestionCheckpoint(checkpoint, binding, h.question),
        true,
      );
    } finally {
      await store.close();
    }
    for (const replacement of [
      { question: "Forged text", questionDigest: digest("Forged text") },
      { questionId: "TEST-wrong" },
      { questionRevision: 2 },
      { parentRunId: "TEST-other-parent" },
      { childRunId: "TEST-other-child" },
      { childThreadId: "TEST-other-thread" },
      { artifactDigest: "4".repeat(64) },
      { inputDigest: "5".repeat(64) },
      { issuedWorkRevision: 2 },
    ])
      assert.equal(
        await h.runtime().proveSuspended({
          ...h.binding(),
          question: { ...h.question, ...replacement },
        }),
        false,
      );
    await h.restart();
    const before = h.requests.length;
    const invalid = h.resume();
    invalid.resume!.data = {
      ...(invalid.resume!.data as object),
      questionRevision: 2,
    };
    await assert.rejects(
      h.runtime().execute(invalid),
      /niaro_native_question_proof_invalid/,
    );
    assert.equal(h.requests.length, before);
    assert.equal(h.consumerCalls(), 0);
    // The domain may have consumed durably before a previous native ACK was saved.
    // Exact checkpoint proof must remain sufficient after transient pending clears.
    delete h.session.state.pending;
    assert.equal((await h.runtime().execute(h.resume())).suspended, false);
    assert.equal(h.consumerCalls(), 1);
    assert.equal(
      h.events.filter(
        (event) =>
          event.type === "tool-end" &&
          event.output &&
          (event.output as { answered?: boolean }).answered,
      ).length,
      1,
    );
    assert(
      JSON.stringify(h.requests.slice(before)).includes(
        "TEST canonical answer",
      ),
    );
    assert.equal(
      JSON.stringify(h.requests.slice(before)).includes("TEST supplied answer"),
      false,
    );
  } finally {
    await h.close();
  }
});

test("rejected proof-bearing answer consumer publishes no completed boundary or next model", async () => {
  const h = childFixture();
  try {
    await h.runtime().execute(h.input());
    h.events.length = 0;
    const count = h.requests.length;
    h.rejectConsumer();
    await assert.rejects(
      h.runtime().execute(h.resume()),
      /TEST consume rejected/,
    );
    assert.equal(h.consumerCalls(), 1);
    assert.equal(h.requests.length, count);
    assert.equal(
      h.events.filter((event) => event.type === "tool-end").length,
      0,
    );
    assert.equal(h.session.state.answer, undefined);
  } finally {
    await h.close();
  }
});

test("persisted malformed, mismatched and duplicate question payloads cannot satisfy exact proof", async () => {
  const h = childFixture();
  const store = new LibSQLStore({ id: "TEST-mutation", url: h.url });
  try {
    await h.runtime().execute(h.input());
    await store.init();
    const workflows = await store.getStore("workflows");
    assert(workflows);
    const row = await workflows.getWorkflowRunById({
      workflowName: DurableStepIds.AGENTIC_LOOP,
      runId: h.question.childRunId,
    });
    assert(row);
    const original =
      typeof row.snapshot === "string"
        ? JSON.parse(row.snapshot)
        : structuredClone(row.snapshot);
    const suspendedKey = Object.keys(original.context).find(
      (key) => original.context[key]?.status === "suspended",
    )!;
    assert(suspendedKey);
    const changes = [
      (payload: any) => {
        payload.kind = "approval";
      },
      (payload: any) => {
        payload.toolName = "action_TEST";
      },
      (payload: any) => {
        payload.toolCallId = "TEST-other-call";
      },
      (payload: any) => {
        payload.toolCallSuspended.questionProof.questionRevision = 2;
      },
      (payload: any) => {
        payload.toolCallSuspended.questionProof.extra = true;
      },
      (payload: any) => {
        payload.extra = true;
      },
    ];
    for (const change of changes) {
      const snapshot = structuredClone(original);
      change(snapshot.context[suspendedKey].suspendPayload);
      await workflows.persistWorkflowSnapshot({
        workflowName: row.workflowName,
        runId: row.runId,
        resourceId: row.resourceId!,
        snapshot,
      });
      assert.equal(await h.runtime().proveSuspended(h.binding()), false);
    }
    const nestedDuplicate = structuredClone(original);
    const iterations =
      nestedDuplicate.context[suspendedKey].suspendPayload.__workflow_meta
        .foreachOutput;
    iterations.push(structuredClone(iterations[0]));
    await workflows.persistWorkflowSnapshot({
      workflowName: row.workflowName,
      runId: row.runId,
      resourceId: row.resourceId!,
      snapshot: nestedDuplicate,
    });
    assert.equal(await h.runtime().proveSuspended(h.binding()), false);
    const originalTextChanged = structuredClone(original);
    originalTextChanged.context[
      suspendedKey
    ].suspendPayload.__workflow_meta.foreachOutput[0].payload.args.question =
      "Forged original question";
    await workflows.persistWorkflowSnapshot({
      workflowName: row.workflowName,
      runId: row.runId,
      resourceId: row.resourceId!,
      snapshot: originalTextChanged,
    });
    assert.equal(await h.runtime().proveSuspended(h.binding()), false);
    const duplicate = structuredClone(original);
    duplicate.context.TEST_duplicate = structuredClone(
      duplicate.context[suspendedKey],
    );
    await workflows.persistWorkflowSnapshot({
      workflowName: row.workflowName,
      runId: row.runId,
      resourceId: row.resourceId!,
      snapshot: duplicate,
    });
    assert.equal(await h.runtime().proveSuspended(h.binding()), false);
    await workflows.persistWorkflowSnapshot({
      workflowName: row.workflowName,
      runId: row.runId,
      resourceId: row.resourceId!,
      snapshot: original,
    });
    assert.equal(await h.runtime().proveSuspended(h.binding()), true);
  } finally {
    await store.close();
    await h.close();
  }
});

test("running pre-ACK recovery requires both exact persisted rows, private question and canonical answer tuple", async () => {
  const h = childFixture();
  const directory = mkdtempSync(
    join(tmpdir(), "niaro-native-question-recovery-"),
  );
  const copy = new LibSQLStore({
    id: "TEST-recovery-copy",
    url: pathToFileURL(join(directory, "native.sqlite")).href,
  });
  try {
    await h.runtime().execute(h.input());
    await copy.init();
    const copiedWorkflows = await copy.getStore("workflows");
    assert(copiedWorkflows);
    const consume = h.session.consumeQuestionAnswer!;
    let proved = false;
    h.session.consumeQuestionAnswer = async (metadata, data) => {
      const live = new LibSQLStore({ id: "TEST-live-recovery", url: h.url });
      await live.init();
      try {
        const workflows = await live.getStore("workflows");
        assert(workflows);
        const rows = await Promise.all(
          [DurableStepIds.AGENTIC_LOOP, DurableStepIds.AGENTIC_EXECUTION].map(
            (workflowName) =>
              workflows.getWorkflowRunById({
                workflowName,
                runId: h.question.childRunId,
              }),
          ),
        );
        const saved = rows.map((row) => {
          assert(row);
          return {
            ...row,
            snapshot:
              typeof row.snapshot === "string"
                ? JSON.parse(row.snapshot)
                : structuredClone(row.snapshot),
          };
        });
        for (const row of saved)
          await copiedWorkflows.persistWorkflowSnapshot({
            workflowName: row.workflowName,
            runId: row.runId,
            resourceId: row.resourceId!,
            snapshot: row.snapshot,
          });
        const binding = {
          ...h.binding(),
          agentId:
            "niaro-native-" +
            createHash("sha256").update(h.question.childRunId).digest("hex"),
        };
        assert.equal(
          await proveNativeAgentQuestionRecovery(
            copy,
            binding,
            h.question,
            data,
          ),
          true,
        );
        proved = true;
        const row = saved[1]!;
        const original = row.snapshot;
        const mutate = async (change: (snapshot: any) => void) => {
          const snapshot = structuredClone(original);
          change(snapshot);
          await copiedWorkflows.persistWorkflowSnapshot({
            workflowName: row.workflowName,
            runId: row.runId,
            resourceId: row.resourceId!,
            snapshot,
          });
          assert.equal(
            await proveNativeAgentQuestionRecovery(
              copy,
              binding,
              h.question,
              data,
            ),
            false,
          );
        };
        await mutate((snapshot) => {
          snapshot.context[DurableStepIds.TOOL_CALL].resumePayload.answerId =
            "TEST-other-answer";
        });
        await mutate((snapshot) => {
          snapshot.context[DurableStepIds.TOOL_CALL].resumePayload.answer =
            "TEST forged answer";
        });
        await mutate((snapshot) => {
          snapshot.context[DurableStepIds.TOOL_CALL].payload[0].toolCallId =
            "TEST-other-call";
        });
        await mutate((snapshot) => {
          snapshot.context[DurableStepIds.TOOL_CALL].payload[0].args.question =
            "TEST forged question";
        });
        await mutate((snapshot) => {
          snapshot.activeStepsPath = {};
        });
        const changeMemory = (
          snapshot: any,
          change: (tools: any, messages: any[], message: any) => void,
        ) => {
          const messages =
            snapshot.context[DurableStepIds.LLM_EXECUTION].output
              .messageListState.messages;
          const message = messages.find(
            (message: any) =>
              message.content?.metadata?.suspendedTools?.[binding.toolCallId],
          );
          assert(message);
          change(message.content.metadata.suspendedTools, messages, message);
        };
        await mutate((snapshot) =>
          changeMemory(snapshot, (tools) => {
            tools[binding.toolCallId].suspendPayload.kind = "approval";
          }),
        );
        await mutate((snapshot) =>
          changeMemory(snapshot, (tools) => {
            tools[binding.toolCallId].suspendPayload.questionProof.inputDigest =
              "6".repeat(64);
          }),
        );
        await mutate((snapshot) =>
          changeMemory(snapshot, (tools, messages, message) => {
            messages.push(structuredClone(message));
          }),
        );
        await copiedWorkflows.persistWorkflowSnapshot({
          workflowName: row.workflowName,
          runId: row.runId,
          resourceId: row.resourceId!,
          snapshot: original,
        });
        assert.equal(
          await proveNativeAgentQuestionRecovery(copy, binding, h.question, {
            ...(data as object),
            answerId: "TEST-other-answer",
          }),
          false,
        );
        assert.equal(
          await proveNativeAgentQuestionRecovery(
            copy,
            binding,
            h.question,
            data,
          ),
          true,
        );
      } finally {
        await live.close();
      }
      return consume(metadata, data);
    };
    assert.equal((await h.runtime().execute(h.resume())).suspended, false);
    assert(proved);
    assert.equal(h.consumerCalls(), 1);
  } finally {
    await copy.close();
    await h.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("exact native question proof rejects corrupted suspension control paths", async () => {
  const h = childFixture();
  const store = new LibSQLStore({ id: "TEST-suspension-controls", url: h.url });
  try {
    await h.runtime().execute(h.input());
    await store.init();
    const workflows = await store.getStore("workflows");
    assert(workflows);
    const rows = await Promise.all(
      [DurableStepIds.AGENTIC_LOOP, DurableStepIds.AGENTIC_EXECUTION].map(
        (workflowName) =>
          workflows.getWorkflowRunById({
            workflowName,
            runId: h.question.childRunId,
          }),
      ),
    );
    const saved = rows.map((row) => {
      assert(row);
      return {
        ...row,
        snapshot:
          typeof row.snapshot === "string"
            ? JSON.parse(row.snapshot)
            : structuredClone(row.snapshot),
      };
    });
    const changes: [string, number, (snapshot: any) => void][] = [
      [
        "unrelated loop suspension path",
        0,
        (snapshot) => {
          snapshot.suspendedPaths = { TEST_unrelated: [0] };
        },
      ],
      [
        "contradictory active loop execution",
        0,
        (snapshot) => {
          snapshot.activeStepsPath = {
            [DurableStepIds.AGENTIC_EXECUTION]: [1],
          };
          snapshot.suspendedPaths = {};
        },
      ],
      [
        "extra unrelated loop suspension",
        0,
        (snapshot) => {
          snapshot.context.TEST_unrelated = {
            status: "suspended",
            suspendPayload: { kind: "approval", toolCallId: "TEST-other-call" },
          };
        },
      ],
      [
        "missing loop original-call evidence",
        0,
        (snapshot) => {
          delete snapshot.context[DurableStepIds.AGENTIC_EXECUTION]
            .suspendPayload.__workflow_meta.foreachOutput;
        },
      ],
      [
        "missing loop native metadata",
        0,
        (snapshot) => {
          delete snapshot.context[DurableStepIds.AGENTIC_EXECUTION]
            .suspendPayload.__workflow_meta;
        },
      ],
      [
        "wrong loop tool path",
        0,
        (snapshot) => {
          snapshot.context[
            DurableStepIds.AGENTIC_EXECUTION
          ].suspendPayload.__workflow_meta.path = ["TEST-other-tool"];
        },
      ],
      [
        "wrong loop call resume label",
        0,
        (snapshot) => {
          snapshot.resumeLabels = {};
        },
      ],
      [
        "unrelated execution suspension path",
        1,
        (snapshot) => {
          snapshot.suspendedPaths = { TEST_unrelated: [0] };
        },
      ],
      [
        "contradictory active execution tool",
        1,
        (snapshot) => {
          snapshot.activeStepsPath = { [DurableStepIds.TOOL_CALL]: [3] };
          snapshot.suspendedPaths = {};
        },
      ],
      [
        "extra unrelated execution suspension",
        1,
        (snapshot) => {
          snapshot.context.TEST_unrelated = {
            status: "suspended",
            suspendPayload: { toolCallId: "TEST-other-call" },
          };
        },
      ],
      [
        "missing execution original-call evidence",
        1,
        (snapshot) => {
          delete snapshot.context[DurableStepIds.TOOL_CALL].suspendPayload
            .__workflow_meta.foreachOutput;
        },
      ],
      [
        "wrong original execution call text",
        1,
        (snapshot) => {
          snapshot.context[DurableStepIds.TOOL_CALL].payload[0].args.question =
            "TEST-forged-question";
        },
      ],
      [
        "wrong foreach selected index",
        1,
        (snapshot) => {
          snapshot.context[
            DurableStepIds.TOOL_CALL
          ].suspendPayload.__workflow_meta.foreachIndex = 1;
        },
      ],
      [
        "extra suspended generic foreach call",
        1,
        (snapshot) => {
          snapshot.context[
            DurableStepIds.TOOL_CALL
          ].suspendPayload.__workflow_meta.foreachOutput.push({
            status: "suspended",
            suspendPayload: {
              type: "suspension",
              toolCallId: "TEST-other-call",
            },
          });
        },
      ],
      ...[0, 1].flatMap((rowIndex) =>
        [
          "running",
          "waiting",
          "pending",
          "paused",
          "TEST_unknown",
          undefined,
          "success",
        ].map((status): [string, number, (snapshot: any) => void] => [
          `unrelated ${String(status)} foreach sibling in row ${rowIndex}`,
          rowIndex,
          (snapshot) => {
            const key =
              rowIndex === 0
                ? DurableStepIds.AGENTIC_EXECUTION
                : DurableStepIds.TOOL_CALL;
            snapshot.context[
              key
            ].suspendPayload.__workflow_meta.foreachOutput.push({
              status,
              payload: {
                toolCallId: "TEST-other-call",
                toolName: "TEST_other",
                args: {},
              },
            });
          },
        ]),
      ),
      [
        "missing outer workflow marker",
        0,
        (snapshot) => {
          delete snapshot.context.input.__workflowKind;
        },
      ],
      [
        "wrong nested workflow marker",
        1,
        (snapshot) => {
          snapshot.context.input.__workflowKind = "TEST-other-kind";
        },
      ],
    ];
    for (const [label, index, change] of changes) {
      const row = saved[index]!;
      const snapshot = structuredClone(row.snapshot);
      change(snapshot);
      await workflows.persistWorkflowSnapshot({
        workflowName: row.workflowName,
        runId: row.runId,
        resourceId: row.resourceId!,
        snapshot,
      });
      if (label === "missing outer workflow marker")
        await assert.rejects(
          h.runtime().proveSuspended(h.binding()),
          /niaro_native_recovery_checkpoint_invalid/,
          label,
        );
      else
        assert.equal(
          await h.runtime().proveSuspended(h.binding()),
          false,
          label,
        );
      assert.equal(h.runtime().isSettled(h.question.childRunId), false, label);
      const count = h.requests.length;
      await assert.rejects(
        h.runtime().execute(h.resume()),
        /niaro_native_question_proof_invalid|niaro_native_recovery_checkpoint_invalid/,
        label,
      );
      assert.equal(h.consumerCalls(), 0, label);
      assert.equal(h.requests.length, count, label);
      await workflows.persistWorkflowSnapshot({
        workflowName: row.workflowName,
        runId: row.runId,
        resourceId: row.resourceId!,
        snapshot: row.snapshot,
      });
      assert.equal(
        await h.runtime().proveSuspended(h.binding()),
        true,
        label + " restored",
      );
    }
    const execution = saved[1]!;
    await workflows.deleteWorkflowRunById({
      workflowName: execution.workflowName,
      runId: execution.runId,
    });
    assert.equal(
      await h.runtime().proveSuspended(h.binding()),
      false,
      "missing native execution row",
    );
    await assert.rejects(
      h.runtime().execute(h.resume()),
      /niaro_native_question_proof_invalid/,
    );
    assert.equal(h.consumerCalls(), 0);
    await workflows.persistWorkflowSnapshot({
      workflowName: execution.workflowName,
      runId: execution.runId,
      resourceId: execution.resourceId!,
      snapshot: execution.snapshot,
    });
    assert.equal(await h.runtime().proveSuspended(h.binding()), true);
  } finally {
    await store.close();
    await h.close();
  }
});

test("real question suspension preserves settled foreach siblings and a nonzero call index", async () => {
  const h = childFixture(true);
  const store = new LibSQLStore({ id: "TEST-settled-sibling", url: h.url });
  try {
    assert.equal((await h.runtime().execute(h.input())).suspended, true);
    assert.equal(await h.runtime().proveSuspended(h.binding()), true);
    await store.init();
    const workflows = await store.getStore("workflows");
    assert(workflows);
    const rows = await Promise.all(
      [DurableStepIds.AGENTIC_LOOP, DurableStepIds.AGENTIC_EXECUTION].map(
        (workflowName) =>
          workflows.getWorkflowRunById({
            workflowName,
            runId: h.question.childRunId,
          }),
      ),
    );
    const saved = rows.map((row) => {
      assert(row);
      return {
        ...row,
        snapshot:
          typeof row.snapshot === "string"
            ? JSON.parse(row.snapshot)
            : structuredClone(row.snapshot),
      };
    });
    for (const [index, row] of saved.entries()) {
      const key =
        index === 0
          ? DurableStepIds.AGENTIC_EXECUTION
          : DurableStepIds.TOOL_CALL;
      const meta = row.snapshot.context[key].suspendPayload.__workflow_meta;
      assert.equal(meta.foreachIndex, 1);
      assert.equal(meta.foreachOutput[0].status, "success");
      assert.equal(meta.foreachOutput[1].status, "suspended");
      const snapshot = structuredClone(row.snapshot);
      snapshot.context[key].suspendPayload.__workflow_meta.foreachOutput =
        Object.fromEntries(Object.entries(meta.foreachOutput));
      await workflows.persistWorkflowSnapshot({
        workflowName: row.workflowName,
        runId: row.runId,
        resourceId: row.resourceId!,
        snapshot,
      });
    }
    assert.equal(await h.runtime().proveSuspended(h.binding()), true);
    for (const row of saved)
      await workflows.persistWorkflowSnapshot({
        workflowName: row.workflowName,
        runId: row.runId,
        resourceId: row.resourceId!,
        snapshot: row.snapshot,
      });
    for (const status of [
      "running",
      "waiting",
      "pending",
      "paused",
      "TEST_unknown",
      undefined,
    ]) {
      const row = saved[1]!;
      const snapshot = structuredClone(row.snapshot);
      snapshot.context[
        DurableStepIds.TOOL_CALL
      ].suspendPayload.__workflow_meta.foreachOutput[0].status = status;
      await workflows.persistWorkflowSnapshot({
        workflowName: row.workflowName,
        runId: row.runId,
        resourceId: row.resourceId!,
        snapshot,
      });
      assert.equal(
        await h.runtime().proveSuspended(h.binding()),
        false,
        String(status),
      );
      assert.equal(h.runtime().isSettled(h.question.childRunId), false);
      await assert.rejects(
        h.runtime().execute(h.resume()),
        /niaro_native_question_proof_invalid/,
      );
      assert.equal(h.consumerCalls(), 0);
      await workflows.persistWorkflowSnapshot({
        workflowName: row.workflowName,
        runId: row.runId,
        resourceId: row.resourceId!,
        snapshot: row.snapshot,
      });
    }
    const row = saved[1]!;
    const snapshot = structuredClone(row.snapshot);
    snapshot.context[
      DurableStepIds.TOOL_CALL
    ].suspendPayload.__workflow_meta.foreachOutput[0].payload.toolCallId =
      "TEST-other-call";
    await workflows.persistWorkflowSnapshot({
      workflowName: row.workflowName,
      runId: row.runId,
      resourceId: row.resourceId!,
      snapshot,
    });
    assert.equal(await h.runtime().proveSuspended(h.binding()), false);
    await workflows.persistWorkflowSnapshot({
      workflowName: row.workflowName,
      runId: row.runId,
      resourceId: row.resourceId!,
      snapshot: row.snapshot,
    });
    await h.restart();
    assert.equal(await h.runtime().proveSuspended(h.binding()), true);
    assert.equal((await h.runtime().execute(h.resume())).suspended, false);
    assert.equal(h.consumerCalls(), 1);
    assert.equal(
      h.events.filter(
        (event) =>
          event.type === "tool-end" &&
          event.output &&
          (event.output as { observed?: boolean }).observed,
      ).length,
      1,
    );
  } finally {
    await store.close();
    await h.close();
  }
});

test("four questions from one real native model turn preserve each durable suspension", async () => {
  const h = childFixture(false, 4);
  const store = new LibSQLStore({ id: "TEST-four-questions", url: h.url });
  try {
    assert.equal((await h.runtime().execute(h.input())).suspended, true);
    await store.init();
    const workflows = await store.getStore("workflows");
    assert(workflows);
    const asked: ProcessQuestion[] = [];
    for (let index = 0; index < 4; index++) {
      assert.equal(h.question.questionRevision, index + 1);
      assert.equal(await h.runtime().proveSuspended(h.binding()), true);
      asked.push(structuredClone(h.question));
      if (index === 1) {
        for (const [workflowName, key] of [
          [DurableStepIds.AGENTIC_LOOP, DurableStepIds.AGENTIC_EXECUTION],
          [DurableStepIds.AGENTIC_EXECUTION, DurableStepIds.TOOL_CALL],
        ] as const) {
          const row: any = await workflows.getWorkflowRunById({
            workflowName,
            runId: h.question.childRunId,
          });
          assert(row);
          const original: any =
            typeof row.snapshot === "string"
              ? JSON.parse(row.snapshot)
              : structuredClone(row.snapshot);
          const output: any =
            original.context[key].suspendPayload.__workflow_meta.foreachOutput;
          assert.equal(output[0].status, "success");
          assert(Array.isArray(output[0].payload));
          assert.equal(output[1].status, "suspended");
          for (const corrupt of [
            (entry: any) => {
              entry.payload[0].toolCallId = "TEST-other-call";
            },
            (entry: any) => {
              entry.output.toolCallId = "TEST-other-call";
            },
            (entry: any) => {
              entry.output.args = {};
            },
            (entry: any) => {
              delete entry.output;
            },
            (entry: any) => {
              entry.status = "running";
            },
          ]) {
            const snapshot = structuredClone(original);
            corrupt(
              snapshot.context[key].suspendPayload.__workflow_meta
                .foreachOutput[0],
            );
            await workflows.persistWorkflowSnapshot({
              workflowName,
              runId: row.runId,
              resourceId: row.resourceId!,
              snapshot,
            });
            assert.equal(await h.runtime().proveSuspended(h.binding()), false);
            assert.equal(h.runtime().isSettled(h.question.childRunId), false);
            await assert.rejects(
              h.runtime().execute(h.resume()),
              /niaro_native_question_proof_invalid/,
            );
            assert.equal(h.consumerCalls(), index);
            assert.equal(h.requests.length, 1);
          }
          await workflows.persistWorkflowSnapshot({
            workflowName,
            runId: row.runId,
            resourceId: row.resourceId!,
            snapshot: original,
          });
        }
      }
      await h.restart();
      assert.equal(await h.runtime().proveSuspended(h.binding()), true);
      for (const prior of asked.slice(0, -1)) {
        const old = h.resume();
        old.resume = {
          toolCallId: prior.toolCallId,
          data: {
            answer: "TEST supplied answer",
            answerId: "TEST-answer-" + prior.questionRevision,
            questionId: prior.questionId,
            questionRevision: prior.questionRevision,
          },
        };
        await assert.rejects(
          h.runtime().execute(old),
          /niaro_native_question_proof_invalid/,
        );
        assert.equal(h.consumerCalls(), index);
        assert.equal(h.requests.length, 1);
      }
      const result = await h.runtime().execute(h.resume());
      assert.equal(result.suspended, index < 3);
      assert.equal(h.consumerCalls(), index + 1);
      assert.equal(h.requests.length, index < 3 ? 1 : 2);
    }
    assert.equal(new Set(asked.map((question) => question.toolCallId)).size, 4);
    const completed = h.events.filter(
      (event): event is Extract<NativeAgentEvent, { type: "tool-end" }> =>
        event.type === "tool-end" &&
        !!event.output &&
        (event.output as { answered?: boolean }).answered === true,
    );
    assert.deepEqual(
      completed.map((event) => event.toolCallId),
      asked.map((question) => question.toolCallId),
    );
    assert.deepEqual(
      completed.map((event) => (event.output as { answer: string }).answer),
      asked.map(
        (question) => "TEST canonical answer-" + question.questionRevision,
      ),
    );
  } finally {
    await store.close();
    await h.close();
  }
});

for (const cutRevision of [1, 2])
  test(`SIGKILL after batch question ${cutRevision} consumption recovers exact cursor across two reopens`, async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "niaro-batch-question-crash-"),
    );
    const path = join(directory, "identity.sqlite");
    const cutPath = join(directory, "cut.json");
    const workerPath = join(directory, "worker.mts");
    const fixturePath = fileURLToPath(
      new URL("./helpers/process-questions-runtime.ts", import.meta.url),
    );
    writeFileSync(
      workerPath,
      `
      import { writeFileSync } from "node:fs";
      import { questionFixture } from ${JSON.stringify(fixturePath)};
      const bindings = [];
      const questions = [];
      const h = questionFixture(${JSON.stringify(path)}, undefined, store => ({
        issue: q => store.issue(q), question: id => store.question(id),
        answer: id => store.answer(id), consumed: (id, q) => store.consumed(id, q),
        consume: (id, q, commit) => {
          const answer = store.consume(id, q, commit);
          if (q.questionRevision === ${cutRevision}) {
            writeFileSync(${JSON.stringify(cutPath)}, JSON.stringify({ ids: h.ids, admission, bindings, questions, question: q }));
            process.kill(process.pid, "SIGKILL");
          }
          return answer;
        },
      }));
      const { admission } = h.admit();
      h.onModel(() => ({ content: null, tool_calls: Array.from({ length: 4 }, (_, i) => ({
        id: "TEST-batch-provider-" + i, type: "function",
        function: { name: "ask_user", arguments: JSON.stringify({ question: "TEST batch question " + i + "?" }) },
      })) }));
      const signal = () => new AbortController().signal;
      let waiting = await h.runtime.start(admission.processId, admission.runId, admission.input, signal());
      for (let i = 0; i < ${cutRevision}; i++) {
        if (!waiting.question) throw Error("TEST expected question before SIGKILL");
        questions.push(waiting.question);
        const bound = h.bind(waiting.question, "TEST-batch-answer-" + waiting.question.questionRevision, " TEST canonical answer " + waiting.question.questionRevision + " ");
        bindings.push(bound.binding);
        waiting = await h.runtime.resume(admission.runId, h.resume(bound.binding), signal());
      }
      throw Error("TEST expected SIGKILL before native ACK");
    `,
    );
    try {
      const killed = await new Promise<{
        signal: NodeJS.Signals | null;
        output: string;
      }>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", workerPath], {
          cwd: process.cwd(),
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (chunk) => {
          output += String(chunk);
        });
        child.stderr.on("data", (chunk) => {
          output += String(chunk);
        });
        child.once("error", reject);
        const timeout = setTimeout(() => child.kill("SIGTERM"), 30000);
        child.once("exit", (_code, exitSignal) => {
          clearTimeout(timeout);
          resolve({ signal: exitSignal, output });
        });
      });
      assert.equal(killed.signal, "SIGKILL", killed.output);
      const cut = JSON.parse(readFileSync(cutPath, "utf8"));
      const binding = cut.bindings.at(-1);
      const proofs = [...cut.questions] as ProcessQuestion[];
      const bindings = [...cut.bindings];
      let waiting:
        | Awaited<
            ReturnType<ReturnType<typeof questionFixture>["runtime"]["resume"]>
          >
        | undefined;
      for (let reopen = 0; reopen < 2; reopen++) {
        const h = questionFixture(path, cut.ids);
        try {
          h.onModel(() => ({ content: '{"result":"TEST completed batch"}' }));
          assert.equal(h.models().length, 1);
          assert.equal(
            h.journal(cut.admission.parentRunId).agents.agent!.answers!.length,
            cutRevision,
          );
          const native = await nativeCatalogOwner(h.controller);
          if (reopen === 0) {
            const frame = {
              runId: cut.question.childRunId,
              threadId: cut.question.childThreadId,
              resourceId: cut.question.resourceId,
              toolCallId: cut.question.toolCallId,
              question: cut.question,
              resumeData: {
                answer: binding.command.answer,
                answerId: binding.bindingId,
                questionId: cut.question.questionId,
                questionRevision: cut.question.questionRevision,
              },
            };
            assert.equal(await native.proveQuestionRecovery(frame), true);
            const store = new LibSQLStore({
              id: "TEST-batch-crash-mutations",
              url: h.catalog.nativeStorageUrl,
            });
            await store.init();
            try {
              const workflows = await store.getStore("workflows");
              assert(workflows);
              const row: any = await workflows.getWorkflowRunById({
                workflowName: DurableStepIds.AGENTIC_EXECUTION,
                runId: cut.question.childRunId,
              });
              assert(row);
              const original: any =
                typeof row.snapshot === "string"
                  ? JSON.parse(row.snapshot)
                  : structuredClone(row.snapshot);
              const changes = [
                (tool: any) => {
                  delete tool.suspendPayload;
                },
                (tool: any) => {
                  tool.suspendPayload.__workflow_meta.foreachIndex =
                    cutRevision === 1 ? 1 : 0;
                },
                (tool: any) => {
                  tool.suspendPayload.__workflow_meta.resumeLabels = {};
                },
                (tool: any) => {
                  tool.suspendPayload.toolCallId = "TEST-other-call";
                },
                (tool: any) => {
                  tool.suspendPayload.toolCallSuspended.questionProof
                    .questionRevision++;
                },
                (tool: any) => {
                  tool.suspendPayload.__workflow_meta.foreachOutput.push(
                    structuredClone(
                      tool.suspendPayload.__workflow_meta.foreachOutput[
                        cutRevision - 1
                      ],
                    ),
                  );
                },
                (tool: any) => {
                  delete tool.suspendPayload.__workflow_meta.foreachOutput[
                    cutRevision - 1
                  ].suspendOutput;
                },
                ...(cutRevision > 1
                  ? [
                      (tool: any) => {
                        tool.suspendPayload.__workflow_meta.foreachOutput[0].status =
                          "running";
                      },
                      (tool: any) => {
                        tool.suspendPayload.__workflow_meta.foreachOutput[0].output.toolCallId =
                          "TEST-other-call";
                      },
                    ]
                  : []),
              ];
              for (const change of changes) {
                const snapshot = structuredClone(original);
                change(snapshot.context[DurableStepIds.TOOL_CALL]);
                await workflows.persistWorkflowSnapshot({
                  workflowName: row.workflowName,
                  runId: row.runId,
                  resourceId: row.resourceId!,
                  snapshot,
                });
                assert.equal(await native.proveQuestionRecovery(frame), false);
                assert.equal(h.models().length, 1);
              }
              await workflows.persistWorkflowSnapshot({
                workflowName: row.workflowName,
                runId: row.runId,
                resourceId: row.resourceId!,
                snapshot: original,
              });
              assert.equal(await native.proveQuestionRecovery(frame), true);
            } finally {
              await store.close();
            }
          }
          const recovered = await h.runtime.resume(
            cut.admission.runId,
            h.resume(binding),
            signal(),
          );
          assert.equal(recovered.status, "waiting", JSON.stringify(recovered));
          assert(recovered.question);
          assert.equal(recovered.question.questionRevision, cutRevision + 1);
          assert.equal(h.models().length, 1);
          if (waiting) assert.deepEqual(recovered, waiting);
          waiting = recovered;
          assert.equal(
            await native.proveSuspended({
              runId: recovered.question.childRunId,
              threadId: recovered.question.childThreadId,
              resourceId: recovered.question.resourceId,
              toolCallId: recovered.question.toolCallId,
              question: recovered.question,
            }),
            true,
          );
          for (const prior of bindings) {
            assert.deepEqual(
              await h.runtime.resume(
                cut.admission.runId,
                h.resume(prior),
                signal(),
              ),
              waiting,
            );
            assert.equal(h.models().length, 1);
          }
          if (reopen === 1) {
            while (waiting.question) {
              const question = waiting.question;
              proofs.push(question);
              const bound = h.bind(
                question,
                "TEST-batch-answer-" + question.questionRevision,
                " TEST canonical answer " + question.questionRevision + " ",
              );
              bindings.push(bound.binding);
              waiting = await h.runtime.resume(
                cut.admission.runId,
                h.resume(bound.binding),
                signal(),
              );
              assert.equal(h.models().length, waiting.question ? 1 : 2);
            }
            assert.equal(waiting.status, "succeeded", JSON.stringify(waiting));
            assert.equal(
              h.journal(cut.admission.parentRunId).agents.agent!.answers!
                .length,
              4,
            );
            assert.equal(
              new Set(proofs.map((question) => question.toolCallId)).size,
              4,
            );
            for (const prior of bindings) {
              assert.equal(
                h.questions.consumed(prior.bindingId, prior.question),
                true,
              );
              assert.deepEqual(
                await h.runtime.resume(
                  cut.admission.runId,
                  h.resume(prior),
                  signal(),
                ),
                waiting,
              );
              assert.equal(h.models().length, 2);
            }
            assert.deepEqual(h.counts(), []);
          }
        } finally {
          await h.close();
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
