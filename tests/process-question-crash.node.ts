import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { LibSQLStore } from "@mastra/libsql";
import type { WorkflowRunState } from "@mastra/core/workflows";
import { nativeCatalogOwner } from "../apps/server-identity/mastra-runtime";
import {
  JournalSchema,
  type Journal,
} from "../apps/server-identity/service-process-journal";
import {
  ProcessAnswerBindingSchema,
  ProcessQuestionSchema,
  type ProcessQuestion,
} from "../packages/protocol/process-questions";
import {
  questionFixture,
  askQuestion,
} from "./helpers/process-questions-runtime";
import { admin, code, scope, signal } from "./helpers/service-process-runtime";
import type {
  QuestionCrashManifest,
  QuestionCrashMode,
} from "./helpers/process-question-crash-worker";

const worker = fileURLToPath(
  new URL("./helpers/process-question-crash-worker.ts", import.meta.url),
);
const sites: Record<QuestionCrashMode, string> = {
  issued: "issued-before-pending-save",
  suspended: "native-suspended-before-parent-waiting-save",
  repending: "native-B-suspended-before-parent-waiting-save",
  bound: "immutable-answer-bound-before-native-resume",
  published: "question-B-published-before-response",
  output: "child-output-saved-before-native-retirement",
  terminal: "native-terminal-before-parent-terminal-save",
};
type Fixture = ReturnType<typeof questionFixture>;

async function crash(t: TestContext, mode: QuestionCrashMode) {
  const directory = mkdtempSync(join(tmpdir(), "niaro-question-cut-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "identity.sqlite");
  const killed = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    output: string;
  }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", worker, directory, mode],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      reject(Error("TEST question crash worker timed out: " + output));
    }, 30000);
    child.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      resolve({ code, signal, output });
    });
  });
  assert.equal(killed.code, null, killed.output);
  assert.equal(killed.signal, "SIGKILL", killed.output);
  const cutPath = join(directory, "cut.json");
  assert(existsSync(cutPath), "Must reach the intended crash cut");
  const cut: QuestionCrashManifest = JSON.parse(readFileSync(cutPath, "utf8"));
  assert.equal(cut.mode, mode);
  assert.equal(cut.site, sites[mode]);
  assert.equal(cut.responseReturned, false);
  cut.question = ProcessQuestionSchema.parse(cut.question);
  cut.journal = JournalSchema.parse(cut.journal);
  if (cut.binding) cut.binding = ProcessAnswerBindingSchema.parse(cut.binding);
  if (cut.attemptedJournal)
    cut.attemptedJournal = JournalSchema.parse(cut.attemptedJournal);
  return { path, cut };
}

const nativeBinding = (q: ProcessQuestion) => ({
  runId: q.childRunId,
  threadId: q.childThreadId,
  resourceId: q.resourceId,
  toolCallId: q.toolCallId,
  question: q,
});
const retirementBinding = (q: ProcessQuestion) => ({
  runId: q.childRunId,
  threadId: q.childThreadId,
  resourceId: q.resourceId,
});
function publishedResult(journal: Journal) {
  return {
    runId: journal.runId,
    revision: journal.revision,
    processId: journal.processId,
    version: journal.version,
    status: journal.status,
    operations: journal.operations,
    ...(journal.output ? { output: journal.output } : {}),
    ...(journal.pending && "kind" in journal.pending
      ? { question: journal.pending }
      : {}),
    ...(journal.failure ? { failure: journal.failure } : {}),
  };
}
function sameCalls(
  h: Fixture,
  cut: QuestionCrashManifest,
  modelCalls = cut.modelCalls,
) {
  assert.equal(h.models().length, modelCalls);
  assert.deepEqual(h.counts(), []);
  const journal = h.journal(cut.admission.parentRunId);
  assert.equal(journal.startedAt, cut.journal.startedAt);
  assert.equal(journal.inputDigest, cut.journal.inputDigest);
  assert.deepEqual(journal.input, cut.journal.input);
  assert.deepEqual(journal.operations, []);
  assert.equal(new Set(journal.visited).size, journal.visited.length);
  for (const visited of cut.journal.visited)
    assert(journal.visited.includes(visited));
}
function start(h: Fixture, cut: QuestionCrashManifest) {
  return h.runtime.start(
    cut.admission.processId,
    cut.admission.runId,
    cut.admission.input,
    signal(),
  );
}
function forbidModel(h: Fixture) {
  h.onModel(() => {
    throw Error("TEST passive recovery must not dispatch a model");
  });
}
async function corruptSuspension(path: string, question: ProcessQuestion) {
  const store = new LibSQLStore({
    id: "TEST-question-crash-corruption",
    url: `file:${path}.mastra.sqlite`,
  });
  await store.init();
  try {
    const workflows = await store.getStore("workflows");
    assert(workflows);
    const row = await workflows.getWorkflowRunById({
      workflowName: "durable-agentic-execution",
      runId: question.childRunId,
    });
    assert(row);
    const snapshot: WorkflowRunState =
      typeof row.snapshot === "string"
        ? JSON.parse(row.snapshot)
        : structuredClone(row.snapshot);
    assert.equal(snapshot.status, "suspended");
    snapshot.suspendedPaths = { TEST_unrelated: [0] };
    await workflows.persistWorkflowSnapshot({
      workflowName: "durable-agentic-execution",
      runId: question.childRunId,
      resourceId: question.resourceId,
      snapshot,
    });
  } finally {
    await store.close();
  }
}

test("SIGKILL after question issue before pending save preserves the orphan issue and fails closed across two reopens", async (t) => {
  const { path, cut } = await crash(t, "issued");
  assert.equal(cut.modelCalls, 1);
  assert.equal(cut.journal.status, "running");
  assert(!cut.journal.pending);
  assert(!cut.journal.agents[cut.question.nodeId]!.pending);
  let expected;
  for (let reopen = 0; reopen < 2; reopen++) {
    const h = questionFixture(path, cut.ids);
    try {
      forbidModel(h);
      assert.deepEqual(
        h.questions.question(cut.question.questionId),
        cut.question,
      );
      assert.equal(
        await (
          await nativeCatalogOwner(h.controller)
        ).proveSuspended(nativeBinding(cut.question)),
        false,
      );
      const stopped = await start(h, cut);
      assert.equal(stopped.status, "failed", JSON.stringify(stopped));
      assert.equal(stopped.failure?.code, "process_checkpoint_interrupted");
      assert(!stopped.question);
      if (expected) assert.deepEqual(stopped, expected);
      expected = stopped;
      assert.equal(
        h.db
          .prepare("SELECT COUNT(*) AS n FROM agent_process_answer_command")
          .get()!.n,
        0,
      );
      assert.equal(
        h.db
          .prepare("SELECT COUNT(*) AS n FROM agent_process_answer_consumption")
          .get()!.n,
        0,
      );
      sameCalls(h, cut);
    } finally {
      await h.close();
    }
  }
});

test("SIGKILL after actual child suspend before parent waiting save recovers the exact question passively twice", async (t) => {
  const { path, cut } = await crash(t, "suspended");
  assert.equal(cut.modelCalls, 1);
  assert.equal(cut.journal.status, "running");
  assert.deepEqual(cut.journal.pending, cut.question);
  assert.equal(cut.attemptedJournal?.status, "waiting");
  let expected;
  for (let reopen = 0; reopen < 2; reopen++) {
    const h = questionFixture(path, cut.ids);
    try {
      forbidModel(h);
      const native = await nativeCatalogOwner(h.controller);
      assert.equal(
        await native.proveSuspended(nativeBinding(cut.question)),
        true,
      );
      const waiting = await start(h, cut);
      assert.equal(waiting.status, "waiting", JSON.stringify(waiting));
      assert.deepEqual(waiting.question, cut.question);
      if (expected) assert.deepEqual(waiting, expected);
      expected = waiting;
      assert.equal(
        h.db
          .prepare("SELECT COUNT(*) AS n FROM agent_process_answer_consumption")
          .get()!.n,
        0,
      );
      sameCalls(h, cut);
    } finally {
      await h.close();
    }
  }
});

test("SIGKILL after native B suspension before parent publication preserves consumed A and exact B across two reopens", async (t) => {
  const { path, cut } = await crash(t, "repending");
  assert(cut.binding);
  const binding = cut.binding;
  assert.equal(cut.modelCalls, 2);
  assert.equal(cut.journal.status, "running");
  assert.deepEqual(cut.journal.pending, cut.question);
  assert.equal(cut.question.questionRevision, 2);
  assert.notEqual(cut.question.questionId, binding.question.questionId);
  assert.equal(cut.attemptedJournal?.status, "waiting");
  let expected;
  for (let reopen = 0; reopen < 2; reopen++) {
    const h = questionFixture(path, cut.ids);
    try {
      forbidModel(h);
      const native = await nativeCatalogOwner(h.controller);
      assert.equal(
        await native.proveSuspended(nativeBinding(cut.question)),
        true,
      );
      assert.equal(
        await native.proveSuspended(nativeBinding(binding.question)),
        false,
      );
      assert.equal(
        h.questions.consumed(binding.bindingId, binding.question),
        true,
      );
      const waiting = await start(h, cut);
      assert.equal(waiting.status, "waiting", JSON.stringify(waiting));
      assert.deepEqual(waiting.question, cut.question);
      if (expected) assert.deepEqual(waiting, expected);
      expected = waiting;
      assert.deepEqual(
        await h.runtime.resume(
          cut.admission.runId,
          h.resume(binding),
          signal(),
        ),
        waiting,
      );
      assert.deepEqual(
        h.questions.history(admin, scope, cut.admission.parentRunId),
        [
          {
            commandId: binding.command.commandId,
            questionId: binding.question.questionId,
            answer: binding.command.answer,
          },
        ],
      );
      assert.equal(
        h.db
          .prepare("SELECT COUNT(*) AS n FROM agent_process_answer_consumption")
          .get()!.n,
        1,
      );
      sameCalls(h, cut);
    } finally {
      await h.close();
    }
  }
});

test("SIGKILL after immutable answer binding resumes canonical A once; exact A replay cannot consume waiting B", async (t) => {
  const { path, cut } = await crash(t, "bound");
  assert(cut.binding);
  const binding = cut.binding;
  assert.equal(cut.modelCalls, 1);
  assert.equal(cut.journal.status, "waiting");
  let b;
  for (let reopen = 0; reopen < 2; reopen++) {
    const h = questionFixture(path, cut.ids);
    try {
      assert.deepEqual(h.questions.answer(binding.bindingId), binding);
      if (reopen === 0) {
        forbidModel(h);
        assert.equal(
          h.questions.consumed(binding.bindingId, binding.question),
          false,
        );
        assert.equal(
          await (
            await nativeCatalogOwner(h.controller)
          ).proveSuspended(nativeBinding(binding.question)),
          true,
        );
        assert.deepEqual((await start(h, cut)).question, binding.question);
        sameCalls(h, cut);
        assert.deepEqual(
          h.questions.bind(admin, scope, binding.command, () => {
            throw Error("TEST immutable binding replay must not bind again");
          }),
          { binding, replay: true },
        );
        h.onModel(() => askQuestion("TEST question B?"));
        b = await h.runtime.resume(
          cut.admission.runId,
          h.resume(binding),
          signal(),
        );
        assert.equal(b.status, "waiting", JSON.stringify(b));
        assert(b.question);
        assert.equal(b.question.questionRevision, 2);
        assert.notEqual(b.question.questionId, binding.question.questionId);
        const answers = (h.models()[1]!.messages ?? [])
          .filter((message) => message.role === "tool")
          .map((message) => JSON.parse(message.content ?? "{}"));
        assert.deepEqual(answers, [
          { answered: true, answer: binding.command.answer },
        ]);
      } else {
        forbidModel(h);
        assert.deepEqual(
          await h.runtime.resume(
            cut.admission.runId,
            h.resume(binding),
            signal(),
          ),
          b,
        );
      }
      assert.equal(
        h.questions.consumed(binding.bindingId, binding.question),
        true,
      );
      assert.equal(
        h.journal(cut.admission.parentRunId).agents[binding.question.nodeId]!
          .answers!.length,
        1,
      );
      assert.equal(
        h.db
          .prepare("SELECT COUNT(*) AS n FROM agent_process_answer_command")
          .get()!.n,
        1,
      );
      assert.equal(
        h.db
          .prepare("SELECT COUNT(*) AS n FROM agent_process_answer_consumption")
          .get()!.n,
        1,
      );
      sameCalls(h, cut, 2);
    } finally {
      await h.close();
    }
  }
});

test("SIGKILL after B publication before response returns exact B for lost-response A retry across two reopens", async (t) => {
  const { path, cut } = await crash(t, "published");
  assert(cut.binding);
  const binding = cut.binding;
  assert.equal(cut.modelCalls, 2);
  assert.equal(cut.journal.status, "waiting");
  assert.equal(cut.question.questionRevision, 2);
  assert.notEqual(cut.question.questionId, binding.question.questionId);
  assert.deepEqual(cut.journal, cut.attemptedJournal);
  for (let reopen = 0; reopen < 2; reopen++) {
    const h = questionFixture(path, cut.ids);
    try {
      forbidModel(h);
      const native = await nativeCatalogOwner(h.controller);
      assert.equal(
        await native.proveSuspended(nativeBinding(cut.question)),
        true,
      );
      assert.equal(
        await native.proveSuspended(nativeBinding(binding.question)),
        false,
      );
      assert.deepEqual(
        h.questions.bind(admin, scope, binding.command, () => {
          throw Error("TEST A replay must not inspect/bind pending B");
        }),
        { binding, replay: true },
      );
      assert.deepEqual(
        await h.runtime.resume(
          cut.admission.runId,
          h.resume(binding),
          signal(),
        ),
        publishedResult(cut.journal),
      );
      assert.equal(
        h.questions.consumed(binding.bindingId, binding.question),
        true,
      );
      assert.equal(
        h.questions.consumed(binding.bindingId, cut.question),
        false,
      );
      assert.equal(
        h.db
          .prepare(
            "SELECT COUNT(*) AS n FROM agent_process_answer_command WHERE question_id=?",
          )
          .get(cut.question.questionId)!.n,
        0,
      );
      assert.equal(
        h.db
          .prepare("SELECT COUNT(*) AS n FROM agent_process_answer_consumption")
          .get()!.n,
        1,
      );
      assert.deepEqual(h.journal(cut.admission.parentRunId), cut.journal);
      sameCalls(h, cut);
    } finally {
      await h.close();
    }
  }
});

for (const mode of ["output", "terminal"] as const) {
  test(`SIGKILL at ${mode} cut requires exact child retirement before publishing terminal output`, async (t) => {
    const { path, cut } = await crash(t, mode);
    assert(cut.binding);
    assert.equal(cut.modelCalls, 2);
    assert.equal(cut.journal.status, "running");
    assert(!cut.journal.output);
    assert.deepEqual(cut.journal.agents[cut.question.nodeId]!.output, {
      result: "TEST crash-cut done",
    });
    let expected;
    for (let reopen = 0; reopen < 2; reopen++) {
      const h = questionFixture(path, cut.ids);
      try {
        forbidModel(h);
        const native = await nativeCatalogOwner(h.controller);
        assert.equal(
          await native.proveRetired(retirementBinding(cut.question)),
          mode === "terminal",
        );
        const recovered = await start(h, cut);
        assert.equal(
          recovered.status,
          mode === "terminal" ? "succeeded" : "failed",
          JSON.stringify(recovered),
        );
        if (mode === "terminal") {
          assert.deepEqual(recovered.output, { result: "TEST crash-cut done" });
          assert.deepEqual(
            await h.runtime.resume(
              cut.admission.runId,
              h.resume(cut.binding),
              signal(),
            ),
            recovered,
          );
        } else {
          assert.equal(
            recovered.failure?.code,
            "process_checkpoint_interrupted",
          );
          assert(!recovered.output);
        }
        if (expected) assert.deepEqual(recovered, expected);
        expected = recovered;
        assert.equal(
          h.questions.consumed(cut.binding.bindingId, cut.binding.question),
          true,
        );
        assert.equal(
          h.journal(cut.admission.parentRunId).agents[cut.question.nodeId]!
            .answers!.length,
          1,
        );
        sameCalls(h, cut);
      } finally {
        await h.close();
      }
    }
  });
}

for (const mode of ["bound", "published"] as const) {
  test(`SIGKILL at ${mode} cut still checks current actor and corrupted native question controls before consume or replay`, async (t) => {
    const { path, cut } = await crash(t, mode);
    assert(cut.binding);
    const binding = cut.binding;
    const denied = questionFixture(path, cut.ids);
    try {
      forbidModel(denied);
      denied.switchActor();
      await assert.rejects(
        denied.runtime.resume(
          cut.admission.runId,
          denied.resume(binding),
          signal(),
        ),
        code("identity_forbidden"),
      );
      assert.equal(
        denied.questions.consumed(binding.bindingId, binding.question),
        mode === "published",
      );
      assert.deepEqual(denied.journal(cut.admission.parentRunId), cut.journal);
      sameCalls(denied, cut);
    } finally {
      await denied.close();
    }
    await corruptSuspension(path, cut.question);
    for (let reopen = 0; reopen < 2; reopen++) {
      const h = questionFixture(path, cut.ids);
      try {
        forbidModel(h);
        assert.equal(
          await (
            await nativeCatalogOwner(h.controller)
          ).proveSuspended(nativeBinding(cut.question)),
          false,
        );
        const result = await h.runtime
          .resume(cut.admission.runId, h.resume(binding), signal())
          .then(
            (result) => ({ result }),
            (error: unknown) => ({ error }),
          );
        if ("error" in result)
          assert(
            code(
              mode === "bound" && reopen === 1
                ? "process_question_conflict"
                : "process_checkpoint_interrupted",
            )(result.error),
            String(result.error),
          );
        else {
          assert.equal(result.result.status, "failed", JSON.stringify(result));
          assert.equal(
            result.result.failure?.code,
            "process_checkpoint_interrupted",
          );
        }
        assert.equal(
          h.questions.consumed(binding.bindingId, binding.question),
          mode === "published",
        );
        assert.equal(
          h.db
            .prepare(
              "SELECT COUNT(*) AS n FROM agent_process_answer_consumption",
            )
            .get()!.n,
          mode === "published" ? 1 : 0,
        );
        sameCalls(h, cut);
      } finally {
        await h.close();
      }
    }
  });
}
