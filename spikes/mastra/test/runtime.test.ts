import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { TEST_SCOPE } from "../src/niaro-boundary.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const worker = fileURLToPath(new URL("../src/worker.ts", import.meta.url));
type Envelope = { result: any; dispatches: number; modelCalls: number };
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "niaro-mastra-runtime-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    call(input: object): Envelope {
      const output = execFileSync(
        process.execPath,
        ["--import", "tsx", worker, directory, JSON.stringify(input)],
        {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 30_000,
        },
      );
      return JSON.parse(output);
    },
    rejects(input: object, pattern: RegExp) {
      assert.throws(
        () => this.call(input),
        (error: unknown) => {
          assert.match(String((error as { stderr?: string }).stderr), pattern);
          return true;
        },
      );
    },
  };
}
function proposal(
  h: ReturnType<typeof fixture>,
  taskId = "TEST-main",
  operationId = "TEST-op",
) {
  const start = h.call({
    kind: "start",
    taskId,
    command: { kind: "create-person", operationId, name: "TEST Ada" },
  });
  assert.equal(start.result.finishReason, "suspended");
  assert.equal(start.dispatches, 0);
  const pending = h.call({ kind: "pending", taskId }).result;
  assert.equal(pending.runs.length, 1);
  return {
    taskId,
    runId: pending.runs[0].runId as string,
    toolCallId: pending.runs[0].toolCalls[0].toolCallId as string,
  };
}

test("native approval survives new processes and a side task; exact resume writes once", (t) => {
  const h = fixture(t),
    target = proposal(h);
  const duplicate = h.call({
    kind: "start",
    taskId: target.taskId,
    command: {
      kind: "create-person",
      operationId: "TEST-op",
      name: "TEST Ada",
    },
  });
  assert.equal(duplicate.result.runId, target.runId);
  assert.equal(duplicate.result.replayed, true);
  assert.equal(duplicate.modelCalls, 0);
  assert.equal(
    h.call({ kind: "pending", taskId: target.taskId }).result.total,
    1,
  );
  h.call({
    kind: "start",
    taskId: "TEST-detour",
    command: { kind: "remember", fact: "TEST detour fact" },
  });
  h.rejects(
    { kind: "answer", ...target, taskId: "TEST-detour" },
    /No pending approval belongs/,
  );
  const approved = h.call({ kind: "answer", ...target });
  assert.equal(JSON.parse(approved.result.text).status, "succeeded");
  assert.equal(approved.dispatches, 1);
  const inspect = h.call({
    kind: "inspect",
    taskId: target.taskId,
    operationId: "TEST-op",
  });
  assert.equal(inspect.result.receipt.status, "succeeded");
  assert.equal(inspect.result.verified.person.name, "TEST Ada");
  assert.equal(inspect.result.pending.total, 0);
  h.rejects({ kind: "answer", ...target }, /No pending approval belongs/);
  const replay = h.call({
    kind: "start",
    taskId: target.taskId,
    command: {
      kind: "create-person",
      operationId: "TEST-op",
      name: "TEST Ada",
    },
  });
  assert.equal(replay.result.replayed, true);
  assert.equal(replay.modelCalls, 0);
  assert.equal(replay.dispatches, 1);
});

test("lost write response remains unknown; restart/replay is passive and verification is read-only", (t) => {
  const h = fixture(t),
    target = proposal(h);
  const lost = h.call({ kind: "answer", ...target, loseResponse: true });
  const receipt = JSON.parse(lost.result.text);
  assert.equal(receipt.status, "unknown");
  assert.equal(receipt.failure.retry, "verify_first");
  assert.equal(lost.dispatches, 1);
  const replay = h.call({
    kind: "start",
    taskId: target.taskId,
    command: {
      kind: "create-person",
      operationId: "TEST-op",
      name: "TEST Ada",
    },
  });
  assert.equal(replay.modelCalls, 0);
  assert.equal(JSON.parse(replay.result.text).status, "unknown");
  assert.equal(replay.dispatches, 1);
  const verified = h.call({
    kind: "start",
    taskId: "TEST-verification",
    command: { kind: "verify-person", operationId: "TEST-op" },
  });
  assert.equal(JSON.parse(verified.result.text).found, true);
  assert.equal(verified.dispatches, 1);
  assert.equal(
    h.call({ kind: "inspect", operationId: "TEST-op" }).result.receipt.status,
    "unknown",
  );
});

test("native human rejection persists without a provider write", (t) => {
  const h = fixture(t),
    target = proposal(h);
  const rejected = h.call({ kind: "answer", ...target, approved: false });
  assert.equal(JSON.parse(rejected.result.text).status, "rejected");
  assert.equal(rejected.dispatches, 0);
  assert.equal(
    h.call({ kind: "inspect", operationId: "TEST-op" }).result.receipt.status,
    "rejected",
  );
});

test("current actor and scope override a stored native approval", (t) => {
  const h = fixture(t),
    target = proposal(h);
  h.rejects(
    {
      kind: "answer",
      ...target,
      scope: { ...TEST_SCOPE, userId: "TEST-foreign" },
    },
    /identity_forbidden/,
  );
  h.call({ kind: "revoke" });
  h.rejects({ kind: "answer", ...target }, /identity_forbidden/);
});

test("native conversation memory survives restart and stays separated by task", (t) => {
  const h = fixture(t);
  h.call({
    kind: "start",
    taskId: "TEST-main",
    command: { kind: "remember", fact: "TEST original fact" },
  });
  h.call({
    kind: "start",
    taskId: "TEST-detour",
    command: { kind: "remember", fact: "TEST detour fact" },
  });
  assert.equal(
    h.call({ kind: "start", taskId: "TEST-main", command: { kind: "recall" } })
      .result.text,
    "TEST original fact",
  );
  assert.equal(
    h.call({
      kind: "start",
      taskId: "TEST-detour",
      command: { kind: "recall" },
    }).result.text,
    "TEST detour fact",
  );
  assert.equal(
    h.call({ kind: "start", taskId: "TEST-new", command: { kind: "recall" } })
      .result.text,
    "Žádný zapamatovaný fakt.",
  );
});

test("native workflow checkpoint restores prepared output without reexecuting the completed step", (t) => {
  const h = fixture(t);
  const suspended = h.call({
    kind: "workflow-start",
    taskId: "TEST-main",
    operationId: "TEST-op",
  });
  assert.equal(suspended.result.output.status, "suspended");
  const resumed = h.call({
    kind: "workflow-resume",
    taskId: "TEST-main",
    runId: suspended.result.runId,
    approved: false,
  });
  assert.equal(resumed.result.status, "success");
  assert.deepEqual(resumed.result.result, {
    taskId: "TEST-main",
    operationId: "TEST-op",
    decision: "rejected",
  });
  assert.equal(
    readFileSync(join(h.directory, "prepared.log"), "utf8"),
    "TEST-main\n",
  );
  assert.equal(resumed.dispatches, 0);
});

test("native objective persists, completes from a verified result, and pauses at its run budget", (t) => {
  const h = fixture(t);
  h.call({
    kind: "set-objective",
    taskId: "TEST-goal",
    objective: "Create and verify TEST Ada.",
  });
  const target = proposal(h, "TEST-goal");
  h.call({ kind: "answer", ...target });
  const done = h.call({
    kind: "inspect",
    taskId: "TEST-goal",
    operationId: "TEST-op",
  }).result.objective;
  assert.equal(done.status, "done");
  h.call({
    kind: "set-objective",
    taskId: "TEST-budget",
    objective: "Unfinished synthetic task.",
  });
  h.call({
    kind: "start",
    taskId: "TEST-budget",
    command: { kind: "remember", fact: "TEST not a completed operation" },
  });
  const exhausted = h.call({ kind: "inspect", taskId: "TEST-budget" }).result
    .objective;
  assert.equal(exhausted.status, "paused");
  assert.equal(exhausted.runsUsed, 2);
  assert.equal(
    h.call({ kind: "inspect", taskId: "TEST-goal" }).result.objective.status,
    "done",
  );
});

test("native goal never reports a lost-response write as completed", (t) => {
  const h = fixture(t);
  h.call({
    kind: "set-objective",
    taskId: "TEST-goal",
    objective: "Create TEST Ada.",
  });
  const target = proposal(h, "TEST-goal");
  h.call({ kind: "answer", ...target, loseResponse: true });
  const result = h.call({
    kind: "inspect",
    taskId: "TEST-goal",
    operationId: "TEST-op",
  });
  assert.equal(result.result.receipt.status, "unknown");
  assert.equal(result.result.objective.status, "paused");
  assert.equal(result.result.objective.runsUsed, 2);
  assert.equal(result.dispatches, 1);
});
