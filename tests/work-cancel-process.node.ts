import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startFixture } from "./helpers/process-start";
import {
  questionFixture,
  askQuestion,
} from "./helpers/process-questions-runtime";
import { scope, signal, admin, code } from "./helpers/service-process-runtime";
import { createProcessCoordinator } from "../apps/server-identity/process-coordinator";
import { ProcessResolveStore } from "../apps/server-identity/process-resolve-store";
import { NativeCommandRequests } from "../apps/server-identity/native-command-requests";
import { PROCESS_EXECUTION_PROFILE } from "../packages/protocol/process-execution";
import { PROCESS_QUESTION_EXECUTION_PROFILE } from "../packages/protocol/process-questions";

const origin = () => {};

test("cancelling a run waiting for approval declines it without dispatch, idempotently", async () => {
  const root = mkdtempSync(join(tmpdir(), "TEST-process-cancel-"));
  const h = startFixture(join(root, "identity.sqlite"));
  const tracker = new NativeCommandRequests();
  const c = createProcessCoordinator(
    h.controller,
    h.registry,
    h.starts,
    new ProcessResolveStore(h.db, h.starts),
    h.context,
    scope,
    admin.organizationId,
    tracker,
    { memory: h.memory },
  );
  try {
    const { command } = h.setup(h.readWrite());
    const waiting = await c.execute(command, signal(), origin);
    const state = waiting.process!;
    assert.equal(state.status, "waiting");
    const operationId = state.approval!.operationId;
    const counts = h.counts();
    // Stale revision: refused, nothing changes.
    await assert.rejects(
      c.cancelRun(state.parentRunId, state.revision + 1),
      code("process_cancel_conflict"),
    );
    // A request in flight for the run: refused.
    const inFlight = {
      scope,
      profile: "process" as const,
      command: { commandId: "TEST-held", idempotencyKey: "TEST-held" },
      controller: new AbortController(),
      promise: Promise.resolve(),
      unsettled: false,
      parentRunId: state.parentRunId,
    };
    tracker.register(inFlight);
    await assert.rejects(
      c.cancelRun(state.parentRunId, state.revision),
      code("process_command_in_progress"),
    );
    tracker.release(inFlight);
    const cancelled = await c.cancelRun(state.parentRunId, state.revision);
    assert.equal(cancelled.process?.status, "cancelled");
    assert.equal(cancelled.process?.failure?.code, "process_cancelled");
    assert.equal(cancelled.process?.revision, state.revision + 1);
    assert.equal(
      h.controller.store.invocation(
        operationId,
        scope.workspaceId,
        scope.userId,
      )?.status,
      "rejected",
    );
    // Already settled: the same cancellation reads it again.
    assert.equal(
      (await c.cancelRun(state.parentRunId, state.revision + 1)).process
        ?.status,
      "cancelled",
    );
    // The old approval can no longer dispatch.
    await assert.rejects(
      c.execute(
        {
          profile: PROCESS_EXECUTION_PROFILE,
          type: "service.resolve",
          commandId: "TEST-late-approve",
          idempotencyKey: "TEST-late-approve-key",
          conversationId: waiting.admission.origin.conversationId,
          workItemId: state.parentRunId,
          expectedWorkRevision: state.revision,
          operationId,
          approved: true,
          language: "en",
        },
        signal(),
        origin,
      ),
    );
    assert.deepEqual(h.counts(), counts, "no write was dispatched");
    // Another person has no such run.
    const foreign = createProcessCoordinator(
      h.controller,
      h.registry,
      h.starts,
      new ProcessResolveStore(h.db, h.starts),
      h.context,
      { ...scope, userId: "TEST-other" },
      admin.organizationId,
      tracker,
      { memory: h.memory },
    );
    await assert.rejects(foreign.cancelRun(state.parentRunId, state.revision));
  } finally {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancelling a run waiting for an answer closes its question", async () => {
  const root = mkdtempSync(join(tmpdir(), "TEST-process-cancel-question-"));
  const h = questionFixture(join(root, "identity.sqlite"));
  try {
    const { command } = h.admit();
    h.onModel(() => askQuestion());
    const c = createProcessCoordinator(
      h.controller,
      h.registry,
      h.starts,
      new ProcessResolveStore(h.db, h.starts),
      h.context,
      scope,
      admin.organizationId,
      new NativeCommandRequests(),
      {
        memory: h.memory,
        questions: h.questions,
        executionProfile: PROCESS_QUESTION_EXECUTION_PROFILE,
      },
    );
    const asked = await c.execute(command, signal(), origin);
    const state = asked.process!;
    assert(state.question);
    const models = h.models().length;
    const cancelled = await c.cancelRun(state.parentRunId, state.revision);
    assert.equal(cancelled.process?.status, "cancelled");
    assert.equal(cancelled.process?.question, undefined);
    assert.equal(h.models().length, models, "no model call");
  } finally {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  }
});
