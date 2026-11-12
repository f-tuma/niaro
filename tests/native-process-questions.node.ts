import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  ProcessAnyResumeSchema,
  ProcessResumeSchema,
  processCompilerVersion,
  processWorkflowDefinition,
  type NativeWorkflowBoundary,
  type ProcessBoundaryResult,
} from "../apps/server-agent/process-workflow";
import { proveProcessRunCheckpoint } from "../apps/server-agent/process-checkpoint";
import {
  ProcessQuestionSchema,
  type ProcessQuestion,
} from "../packages/protocol/process-questions";
import { ProcessDefinitionSchema } from "../packages/protocol/service-processes";
import { processWorkflow } from "./helpers/service-process";
import { questionFixture } from "./helpers/process-questions-runtime";
import { nativeAgentOwner } from "../apps/server-identity/mastra-runtime";

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
      proveProcessRunCheckpoint({
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

/** Process runs execute on the Pi agent core (NIAR-303), over one file. */
async function workflowCore(file: string) {
  const { PiAgentCore } = await import("@niaro/server-agent/pi");
  const core = await PiAgentCore.open({
    file,
    host: {
      plan: async () => {
        throw new Error("TEST no model");
      },
    },
  });
  return {
    executeWorkflow: (input: Parameters<typeof core.executeProcess>[0]) =>
      core.executeProcess(input),
    proveWorkflowRetired: (input: Parameters<typeof core.executeProcess>[0]) =>
      core.proveProcessRetired(input),
    close: () => core.close(),
  };
}

test("real persisted native parent suspends, rejects wrong question tuples and resumes typed output", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "niaro-native-parent-question-"),
  );
  const file = join(directory, "native.sqlite");
  let runtime = await workflowCore(file);
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
    runtime = await workflowCore(file);
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
  const runtime = await workflowCore(join(directory, "native.sqlite"));
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
          const native = await nativeAgentOwner(h.controller);
          if (reopen === 0) {
            // The cut came before the answer reached the agent: the
            // question still waits inside its tool.
            assert.equal(
              await native.proveSuspended({
                runId: cut.question.childRunId,
                threadId: cut.question.childThreadId,
                resourceId: cut.question.resourceId,
                toolCallId: cut.question.toolCallId,
                question: cut.question,
              }),
              true,
            );
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
