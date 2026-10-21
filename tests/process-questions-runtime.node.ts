import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { ProcessDefinitionSchema } from "../packages/protocol/service-processes";
import { IdentityError } from "../apps/server-identity/error";
import { ProcessAnswerBindingSchema } from "../packages/protocol/process-questions";
import { JournalSchema } from "../apps/server-identity/service-process-journal";
import { nativeCatalogOwner } from "../apps/server-identity/mastra-runtime";
import { processDigest } from "../apps/server-identity/process-validation";
import {
  questionFixture,
  askQuestion,
} from "./helpers/process-questions-runtime";
import { callProcessTool, processAgent } from "./helpers/service-process-agent";
import { scope, signal, code } from "./helpers/service-process-runtime";

async function isolated(
  run: (h: ReturnType<typeof questionFixture>, path: string) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), "niaro-process-question-"));
  const path = join(dir, "identity.sqlite");
  const h = questionFixture(path);
  try {
    await run(h, path);
  } finally {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function killAfterConsumption(path: string, cutPath: string) {
  const worker = fileURLToPath(
    new URL("./helpers/process-questions-runtime.ts", import.meta.url),
  );
  const killed = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    output: string;
  }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", worker, "--crash-consumption", path, cutPath],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (value) => (output += String(value)));
    child.stderr.on("data", (value) => (output += String(value)));
    child.once("error", reject);
    const timeout = setTimeout(() => child.kill("SIGTERM"), 30000);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, output });
    });
  });
  assert.equal(killed.signal, "SIGKILL", killed.output);
  return JSON.parse(readFileSync(cutPath, "utf8"));
}

test("opt-in question A consumes exact canonical text, suspends B and replays A passively across two reopens", () =>
  isolated(async (h, path) => {
    const { admission } = h.admit();
    let calls = 0;
    h.onModel(() =>
      ++calls === 1
        ? askQuestion()
        : calls === 2
          ? askQuestion("TEST question B?")
          : { content: '{"result":"TEST done"}' },
    );
    const a = await h.runtime.start(
      admission.processId,
      admission.runId,
      admission.input,
      signal(),
    );
    assert.equal(a.status, "waiting", JSON.stringify(a));
    assert(a.question);
    assert(!a.approval);
    const before = h.journal(admission.parentRunId);
    assert.equal(before.compilerVersion, "niaro-native-workflow/3");
    assert.equal(a.question.questionDigest, processDigest(a.question.question));
    assert(before.visited.includes("tool:" + a.question.toolCallId));
    const bound = h.bind(
      a.question,
      "TEST-answer-A",
      "  TEST exact answer A\n",
    );
    const b = await h.runtime.resume(
      admission.runId,
      h.resume(bound.binding),
      signal(),
    );
    assert.equal(b.status, "waiting", JSON.stringify(b));
    assert(b.question);
    assert.equal(b.question.questionRevision, 2);
    assert.notEqual(b.question.questionId, a.question.questionId);
    assert.equal(h.models().length, 2);
    assert(JSON.stringify(h.models()[1]).includes("TEST exact answer A"));
    assert.deepEqual(h.counts(), []);
    assert.equal(
      h.questions.consumed(bound.binding.bindingId, a.question),
      true,
    );
    assert.equal(
      h.journal(admission.parentRunId).agents[a.question.nodeId]!.answers!
        .length,
      1,
    );
    for (let i = 0; i < 2; i++) {
      if (i === 0) await h.close();
      const reopened = questionFixture(path, h.ids);
      try {
        const replay = await reopened.runtime.resume(
          admission.runId,
          reopened.resume(bound.binding),
          signal(),
        );
        assert.deepEqual(replay, b);
        assert.equal(reopened.models().length, 2);
        assert.deepEqual(reopened.counts(), []);
        assert.throws(
          () =>
            reopened.questions.bind(
              {
                organizationId: "TEST-org",
                workspaceId: scope.workspaceId,
                userId: scope.userId,
                role: "member",
              },
              scope,
              { ...bound.command, answer: "TEST changed" },
              () => {},
            ),
          code("idempotency_conflict"),
        );
      } finally {
        await reopened.close();
      }
    }
    const completed = questionFixture(path, h.ids);
    try {
      completed.onModel(() => ({
        content: '{"result":"TEST both answers done"}',
      }));
      const boundB = completed.bind(
        b.question,
        "TEST-answer-B",
        "TEST canonical answer B",
      );
      const done = await completed.runtime.resume(
        admission.runId,
        completed.resume(boundB.binding),
        signal(),
      );
      assert.equal(done.status, "succeeded", JSON.stringify(done));
      assert.deepEqual(done.output, { result: "TEST both answers done" });
      assert.equal(
        completed.journal(admission.parentRunId).agents[a.question.nodeId]!
          .answers!.length,
        2,
      );
      assert.equal(completed.models().length, 3);
      assert.deepEqual(completed.counts(), []);
      assert.deepEqual(
        await completed.runtime.resume(
          admission.runId,
          completed.resume(bound.binding),
          signal(),
        ),
        done,
      );
      assert.equal(completed.models().length, 3);
    } finally {
      await completed.close();
    }
  }));

test("answering a question never approves a subsequent write; question to output remains receipt-free", async () => {
  for (const write of [true, false])
    await isolated(async (h) => {
      const { admission } = h.admit();
      let calls = 0;
      h.onModel(() =>
        ++calls === 1
          ? askQuestion()
          : write && calls === 2
            ? callProcessTool()
            : { content: '{"result":"TEST done"}' },
      );
      const a = await h.runtime.start(
        admission.processId,
        admission.runId,
        admission.input,
        signal(),
      );
      assert(a.question);
      const { binding } = h.bind(a.question);
      const next = await h.runtime.resume(
        admission.runId,
        h.resume(binding),
        signal(),
      );
      assert.equal(
        next.status,
        write ? "waiting" : "succeeded",
        JSON.stringify(next),
      );
      assert.equal(Boolean(next.approval), write);
      assert(!next.question);
      assert.deepEqual(h.counts(), []);
      assert.equal(h.models().length, 2);
      assert.deepEqual(
        await h.runtime.resume(admission.runId, h.resume(binding), signal()),
        next,
      );
      assert.equal(h.models().length, 2);
      assert.deepEqual(h.counts(), []);
    });
});

test("legacy omitted opt-in keeps compiler 2, exact tool list and no question history fields", () =>
  isolated(async (h) => {
    const { admission } = h.admit(processAgent(h));
    await h.runtime.start(
      admission.processId,
      admission.runId,
      admission.input,
      signal(),
    );
    const journal = h.journal(admission.parentRunId);
    assert.equal(journal.compilerVersion, "niaro-native-workflow/2");
    assert(!JSON.stringify(h.models()[0]).includes('"name":"ask_user"'));
    const child = Object.values(journal.agents)[0]!;
    assert(!("answers" in child));
    assert(!("questionRevision" in child));
  }));

test("wrong question tuple, missing binding, malformed payload, denied actor and aborted request cannot consume", async () => {
  for (const kind of [
    "tuple",
    "missing",
    "malformed",
    "denied",
    "abort",
  ] as const)
    await isolated(async (h) => {
      const { admission } = h.admit();
      h.onModel(() => askQuestion());
      const a = await h.runtime.start(
        admission.processId,
        admission.runId,
        admission.input,
        signal(),
      );
      assert(a.question);
      const { binding } = h.bind(a.question);
      const resume = h.resume(binding);
      const cancellation = new AbortController();
      if (kind === "tuple") resume.questionRevision++;
      if (kind === "missing") resume.answerId = "TEST-missing";
      if (kind === "denied") h.switchActor();
      if (kind === "abort") cancellation.abort();
      const rejected = await Promise.resolve()
        .then(() =>
          h.runtime.resume(
            admission.runId,
            kind === "malformed"
              ? ({
                  ...resume,
                  answer: "TEST forged answer",
                  approved: true,
                } as typeof resume)
              : resume,
            cancellation.signal,
          ),
        )
        .then(
          (result) => ({ result }),
          (error) => ({ error }),
        );
      if ("result" in rejected)
        assert.equal(
          rejected.result.status,
          "failed",
          kind + ": " + JSON.stringify(rejected.result),
        );
      else assert(rejected.error instanceof Error);
      assert.equal(h.questions.consumed(binding.bindingId, a.question), false);
      assert.equal(h.models().length, 1);
      assert.deepEqual(h.counts(), []);
    });
});

test("budget and original duration are rechecked before answering a saved question", async () => {
  for (const expiry of [false, true])
    await isolated(async (h) => {
      const definition = h.definition();
      definition.limits.maxModelCalls = expiry ? 12 : 1;
      const { admission } = h.admit(definition);
      h.onModel(() => askQuestion());
      const a = await h.runtime.start(
        admission.processId,
        admission.runId,
        admission.input,
        signal(),
      );
      assert(a.question);
      const { binding } = h.bind(a.question);
      if (expiry) {
        const j = h.journal(admission.parentRunId);
        j.startedAt = Date.now() - definition.limits.maxDurationMs - 1;
        h.catalog.saveTurn(
          admission.parentRunId,
          scope.workspaceId,
          scope.userId,
          j,
        );
      }
      const stopped = await h.runtime
        .resume(admission.runId, h.resume(binding), signal())
        .catch(() => h.journal(admission.parentRunId));
      assert.equal(stopped.status, "failed", JSON.stringify(stopped));
      assert.equal(
        stopped.failure?.code,
        expiry ? "process_duration_exceeded" : "catalog_budget_exhausted",
      );
      assert.equal(h.questions.consumed(binding.bindingId, a.question), false);
      assert.equal(h.models().length, 1);
      assert.deepEqual(h.counts(), []);
    });
});

test("mapped workflow agent questions retain the admitted parent input digest and separate child binding", () =>
  isolated(async (h) => {
    const base = h.definition();
    assert(base.kind === "agent");
    const {
      kind: _kind,
      modelId,
      instructions,
      capabilities,
      memory,
      humanInput,
      ...common
    } = base;
    const definition = ProcessDefinitionSchema.parse({
      ...common,
      kind: "workflow",
      entry: "mapped",
      steps: [
        {
          id: "mapped",
          type: "agent",
          modelId,
          instructions,
          capabilities,
          memory,
          humanInput,
          inputSchema: base.inputSchema,
          outputSchema: base.outputSchema,
          input: { name: { source: "literal", value: "TEST mapped child" } },
          next: "done",
        },
        {
          id: "done",
          type: "return",
          output: {
            result: { source: "step", stepId: "mapped", path: ["result"] },
          },
        },
      ],
    });
    const { admission } = h.admit(definition);
    let calls = 0;
    h.onModel(() =>
      ++calls === 1
        ? askQuestion("TEST mapped question?")
        : { content: '{"result":"TEST mapped done"}' },
    );
    const waiting = await h.runtime.start(
      admission.processId,
      admission.runId,
      admission.input,
      signal(),
    );
    assert(waiting.question);
    const child = h.journal(admission.parentRunId).agents.mapped!;
    assert.equal(waiting.question.inputDigest, admission.inputDigest);
    assert.equal(
      child.inputDigest,
      processDigest({ name: "TEST mapped child" }),
    );
    assert.notEqual(child.inputDigest, waiting.question.inputDigest);
    const { binding } = h.bind(waiting.question);
    const done = await h.runtime.resume(
      admission.runId,
      h.resume(binding),
      signal(),
    );
    assert.equal(done.status, "succeeded", JSON.stringify(done));
    assert.deepEqual(done.output, { result: "TEST mapped done" });
    assert.equal(h.models().length, 2);
    assert.deepEqual(h.counts(), []);
  }));

test("consumption save failure rolls back durable consumption and in-memory answer history", () =>
  isolated(async (h) => {
    const { admission } = h.admit();
    h.onModel(() => askQuestion());
    const waiting = await h.runtime.start(
      admission.processId,
      admission.runId,
      admission.input,
      signal(),
    );
    assert(waiting.question);
    const { binding } = h.bind(waiting.question);
    const save = h.catalog.saveTurn.bind(h.catalog);
    h.catalog.saveTurn = (id, workspace, user, value) => {
      const journal = JournalSchema.parse(value);
      if (journal.agents[waiting.question!.nodeId]?.answers?.length)
        throw new IdentityError(409, "TEST-question-save-failed");
      return save(id, workspace, user, value);
    };
    const stopped = await h.runtime.resume(
      admission.runId,
      h.resume(binding),
      signal(),
    );
    assert.equal(stopped.status, "failed", JSON.stringify(stopped));
    assert.equal(stopped.failure?.code, "TEST-question-save-failed");
    assert.equal(
      h.questions.consumed(binding.bindingId, waiting.question),
      false,
    );
    assert(
      !h.journal(admission.parentRunId).agents[waiting.question.nodeId]!
        .answers,
    );
    assert.equal(h.models().length, 1);
    assert.deepEqual(h.counts(), []);
  }));

test("actual SIGKILL after committed answer before native ACK proves exact running A and resumes once, then retries A while B waits across reopens", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "niaro-question-ack-crash-"));
  const path = join(dir, "identity.sqlite");
  const cutPath = join(dir, "cut.json");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cut = await killAfterConsumption(path, cutPath);
  const binding = ProcessAnswerBindingSchema.parse(cut.binding);
  const journal = JournalSchema.parse(cut.journal);
  assert.equal(journal.status, "running");
  assert(!journal.pending);
  assert(!journal.agents[binding.question.nodeId]!.pending);
  assert.equal(journal.agents[binding.question.nodeId]!.answers!.length, 1);
  let expected: Awaited<
    ReturnType<ReturnType<typeof questionFixture>["runtime"]["start"]>
  >;
  for (let i = 0; i < 2; i++) {
    const h = questionFixture(path, cut.ids);
    try {
      assert(h.questions.consumed(binding.bindingId, binding.question));
      if (i === 0) {
        const native = await nativeCatalogOwner(h.controller);
        assert(
          await native.proveQuestionRecovery({
            runId: binding.question.childRunId,
            threadId: binding.question.childThreadId,
            resourceId: binding.question.resourceId,
            toolCallId: binding.question.toolCallId,
            question: binding.question,
            resumeData: {
              answerId: binding.bindingId,
              answer: binding.command.answer,
              questionId: binding.question.questionId,
              questionRevision: binding.question.questionRevision,
            },
          }),
        );
        h.onModel(() => askQuestion("TEST question B?"));
        expected = await h.runtime.start(
          binding.admission.processId,
          binding.admission.runId,
          binding.admission.input,
          signal(),
        );
        assert.equal(expected.status, "waiting", JSON.stringify(expected));
        assert(expected.question);
        assert.equal(expected.question.questionRevision, 2);
        assert.equal(h.models().length, 2);
      } else {
        assert.deepEqual(
          await h.runtime.resume(
            binding.admission.runId,
            h.resume(binding),
            signal(),
          ),
          expected!,
        );
        assert.equal(h.models().length, 2);
      }
      assert.deepEqual(h.counts(), []);
      assert.equal(
        h.journal(binding.admission.parentRunId).startedAt,
        journal.startedAt,
      );
      assert.deepEqual(
        h.journal(binding.admission.parentRunId).input,
        journal.input,
      );
      assert.equal(
        h.journal(binding.admission.parentRunId).agents[
          binding.question.nodeId
        ]!.answers!.length,
        1,
      );
    } finally {
      await h.close();
    }
  }
});

test("question tools spend the shared logical step allowance", () =>
  isolated(async (h) => {
    const definition = h.definition();
    definition.limits.maxSteps = 2;
    const { admission } = h.admit(definition);
    h.onModel(() => askQuestion());
    const stopped = await h.runtime.start(
      admission.processId,
      admission.runId,
      admission.input,
      signal(),
    );
    assert.equal(stopped.status, "failed", JSON.stringify(stopped));
    assert.equal(stopped.failure?.code, "process_step_limit");
    assert.equal(
      h.db.prepare("SELECT COUNT(*) count FROM agent_process_question").get()!
        .count,
      0,
    );
    assert.equal(h.models().length, 1);
    assert.deepEqual(h.counts(), []);
  }));

test("saved memory changes after a question block canonical consumption before native hydration", () =>
  isolated(async (h) => {
    const note = await h.memoryStore.remember(h.memoryActor, {
      requestId: "TEST-question-memory",
      content: "TEST private preference",
      kind: "preference",
      source: { type: "user_note" },
      explicitIntent: true,
      settings: h.memorySettings,
    });
    const definition = h.definition();
    assert(definition.kind === "agent");
    definition.memory = "saved";
    const { admission } = h.admit(definition);
    h.onModel(() => askQuestion());
    const waiting = await h.runtime.start(
      admission.processId,
      admission.runId,
      admission.input,
      signal(),
    );
    assert(waiting.question);
    const { binding } = h.bind(waiting.question);
    await h.memoryStore.forget(h.memoryActor, {
      requestId: "TEST-question-forget",
      id: note.id,
      revision: note.revision,
    });
    await assert.rejects(
      h.runtime.resume(admission.runId, h.resume(binding), signal()),
      code("memory_context_changed"),
    );
    assert.equal(
      h.questions.consumed(binding.bindingId, waiting.question),
      false,
    );
    assert.equal(h.models().length, 1);
    assert.deepEqual(h.counts(), []);
  }));

test("a committed answer and journal history cannot recover when the exact native child checkpoint is missing", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "niaro-question-missing-native-"));
  const path = join(dir, "identity.sqlite");
  const cutPath = join(dir, "cut.json");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cut = await killAfterConsumption(path, cutPath);
  const binding = ProcessAnswerBindingSchema.parse(cut.binding);
  const nativeDB = new DatabaseSync(path + ".mastra.sqlite");
  try {
    nativeDB
      .prepare(
        "DELETE FROM mastra_workflow_snapshot WHERE run_id=? AND workflow_name IN ('durable-agentic-loop','durable-agentic-execution')",
      )
      .run(binding.question.childRunId);
  } finally {
    nativeDB.close();
  }
  const h = questionFixture(path, cut.ids);
  try {
    assert(h.questions.consumed(binding.bindingId, binding.question));
    const stopped = await h.runtime.start(
      binding.admission.processId,
      binding.admission.runId,
      binding.admission.input,
      signal(),
    );
    assert.equal(stopped.status, "failed", JSON.stringify(stopped));
    assert.equal(stopped.failure?.code, "process_checkpoint_interrupted");
    assert.equal(h.models().length, 1);
    assert.deepEqual(h.counts(), []);
  } finally {
    await h.close();
  }
});
