import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandSchema, type WorkItem } from "../packages/protocol";
import {
  createTrustHarness,
  toolResults,
  type TrustHarness,
} from "./agent-trust/harness";

async function question(h: TrustHarness, id = "TEST-cancel-question") {
  h.onChat((body) =>
    toolResults(body).some(
      (result) => result.currentTurn && result.data?.contacts,
    )
      ? h.call("ask_user", { question: "Which day?" })
      : h.lookupScript(body),
  );
  const result = await h.send(
    "Prepare a meeting with Jane Test and ask which day.",
    { id },
  );
  const work = result.snapshot.workItems.find((item) => item.native?.question);
  assert(work?.native?.question);
  return work;
}
async function approval(h: TrustHarness, id = "TEST-cancel-approval") {
  h.onChat(h.writeScript);
  const result = await h.send("Create a meeting with Jane Test.", { id });
  const work = result.snapshot.workItems.find(
    (item) => item.native?.action?.status === "awaiting_approval",
  );
  assert(work);
  return work;
}
const cancel = (
  id: string,
  work: Pick<WorkItem, "id" | "revision" | "conversationId">,
  revision = work.revision,
) =>
  CommandSchema.parse({
    type: "work.cancel",
    commandId: id,
    idempotencyKey: id,
    conversationId: work.conversationId,
    workItemId: work.id,
    expectedWorkRevision: revision,
    language: "en",
  });
const directory = (
  type: "conversation.delete" | "conversation.archive",
  id: string,
  cancelOpenWork = false,
) =>
  CommandSchema.parse({
    type,
    commandId: id,
    idempotencyKey: id,
    conversationId: "conversation-1",
    ...(cancelOpenWork ? { cancelOpenWork: true } : {}),
  });
/** Rewrites every journal row of a native run (root and aliases). */
function edit(h: TrustHarness, runId: string, change: (data: any) => void) {
  for (const row of h.db
    .prepare(
      "SELECT id,data FROM agent_service_turn WHERE workspace_id=? AND user_id=?",
    )
    .all(h.scope.workspaceId, h.scope.userId)) {
    const data = JSON.parse(String(row.data));
    if (data.runId !== runId) continue;
    change(data);
    h.db
      .prepare("UPDATE agent_service_turn SET data=? WHERE id=?")
      .run(JSON.stringify(data), String(row.id));
  }
}
/** A run cut off mid-way (e.g. by a restart): no answer and nothing pending. */
function stopMidway(h: TrustHarness, runId: string, openedAt?: string) {
  edit(h, runId, (data) => {
    delete data.answer;
    delete data.pending;
    data.trace.status = "interrupted";
    if (openedAt) data.openedAt = openedAt;
  });
}
const project = async (h: TrustHarness) =>
  h.workflow.syncNativeWork(h.scope, await h.runtime().tasks!(), true);
const item = (h: TrustHarness, id: string) =>
  h.workflow.snapshot(h.scope).workItems.find((work) => work.id === id)!;
const effects = (h: TrustHarness) => ({
  requests: h.requests.length,
  serviceRequests: h.serviceRequests.length,
});

test("work.cancel ends a native question as cancelled with a short reason, idempotently", async () => {
  const h = createTrustHarness();
  try {
    const work = await question(h);
    const before = effects(h);
    const stale = await h.execute(
      cancel("TEST-stale", work, work.revision + 1),
    );
    assert.equal(stale.status, "conflict");
    assert.equal(stale.code, "revision_conflict");
    assert(h.commandState("TEST-cancel-question").pending);
    const done = await h.execute(cancel("TEST-cancel", work));
    assert.equal(done.status, "accepted", done.code);
    const cancelled = done.snapshot.workItems.find((w) => w.id === work.id)!;
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.native?.question, undefined);
    const state = h.commandState("TEST-cancel-question");
    assert.equal(state.pending, undefined);
    assert.equal(state.trace?.status, "cancelled");
    assert.match(state.answer!.reply, /cancelled/i);
    // The same press replays its receipt; a new press at the old revision is stale.
    assert.equal(
      (await h.execute(cancel("TEST-cancel", work))).status,
      "accepted",
    );
    assert.equal(
      (await h.execute(cancel("TEST-cancel-2", work))).code,
      "revision_conflict",
    );
    // Settled at the revision the person sees: a no-op.
    assert.equal(
      (await h.execute(cancel("TEST-cancel-3", cancelled))).status,
      "accepted",
    );
    assert.deepEqual(effects(h), before, "no model call or dispatch");
  } finally {
    await h.close();
  }
});

test("work.cancel declines a native approval: the receipt is rejected and nothing is dispatched", async () => {
  const h = createTrustHarness();
  try {
    const work = await approval(h);
    const operationId = work.native!.action!.operationId;
    const before = effects(h);
    const done = await h.execute(cancel("TEST-decline", work));
    assert.equal(done.status, "accepted", done.code);
    assert.equal(
      done.snapshot.workItems.find((w) => w.id === work.id)?.status,
      "cancelled",
    );
    assert.equal(
      h.catalog.invocation(operationId, h.scope.workspaceId, h.scope.userId)
        ?.status,
      "rejected",
    );
    assert.deepEqual(effects(h), before);
    const approved = await h.execute(
      CommandSchema.parse({
        type: "service.resolve",
        commandId: "TEST-approve-after",
        idempotencyKey: "TEST-approve-after",
        conversationId: work.conversationId,
        workItemId: work.id,
        expectedWorkRevision: work.revision,
        operationId,
        approved: true,
        language: "en",
      }),
    );
    assert.notEqual(approved.status, "accepted");
    assert.deepEqual(effects(h), before);
  } finally {
    await h.close();
  }
});

test("a run stopped mid-way is closed after its retirement is proved", async () => {
  const h = createTrustHarness();
  try {
    h.onChat(h.lookupScript);
    await h.send("Find Jane Test.", { id: "TEST-stuck" });
    const runId = h.commandState("TEST-stuck").runId;
    stopMidway(h, runId);
    await project(h);
    const work = item(h, runId);
    assert.equal(work.status, "waiting_system");
    // Without the flag the chat names it; delete is refused.
    const refused = await h.execute(
      directory("conversation.delete", "TEST-d1"),
    );
    assert.equal(refused.code, "operation_in_progress");
    assert.deepEqual(refused.openWork, [
      { workItemId: runId, title: work.title, kind: "task" },
    ]);
    const before = effects(h);
    const done = await h.execute(cancel("TEST-close", work));
    assert.equal(done.status, "accepted", done.code);
    assert.equal(
      done.snapshot.workItems.find((w) => w.id === runId)?.status,
      "cancelled",
    );
    const state = h.commandState("TEST-stuck");
    assert.equal(state.trace?.status, "cancelled");
    assert.match(state.answer!.reply, /cancelled/i);
    assert.deepEqual(effects(h), before);
    assert.equal(
      (await h.execute(directory("conversation.delete", "TEST-d2"))).status,
      "accepted",
    );
  } finally {
    await h.close();
  }
});

test("an unconfirmed earlier write stays unconfirmed and no longer holds the chat", async () => {
  const h = createTrustHarness({ writeApproval: "never" });
  try {
    h.writeResponse = "lost";
    h.onChat(h.writeScript);
    await h.send("Create a meeting with Jane Test.", { id: "TEST-unknown" });
    const state = h.commandState("TEST-unknown");
    const write = state.operations
      .map(
        (id) => h.catalog.invocation(id, h.scope.workspaceId, h.scope.userId)!,
      )
      .find((receipt) => receipt.effect === "write")!;
    assert.equal(write.status, "unknown");
    stopMidway(h, state.runId);
    await project(h);
    const work = item(h, state.runId);
    assert.equal(work.status, "waiting_system");
    const done = await h.execute(cancel("TEST-close-unknown", work));
    assert.equal(done.status, "accepted", done.code);
    assert.deepEqual(
      h.catalog.invocation(write.id, h.scope.workspaceId, h.scope.userId),
      write,
    );
    const after = done.snapshot.workItems.find((w) => w.id === state.runId)!;
    assert.equal(after.native?.action?.status, "unknown");
    assert.equal(
      (await h.execute(directory("conversation.delete", "TEST-delete"))).status,
      "accepted",
    );
    // Still visible for Tasks.
    assert(item(h, state.runId));
  } finally {
    await h.close();
  }
});

test("another person cannot cancel the work, and a chat still answering is refused without a receipt", async () => {
  const h = createTrustHarness();
  try {
    const work = await question(h);
    const foreign = await h.executeAs(
      { ...h.scope, userId: "TEST-bob" },
      cancel("TEST-bob", work),
    );
    assert.equal(foreign.status, "rejected");
    assert.equal(foreign.code, "unknown_context");
    assert(h.commandState("TEST-cancel-question").pending);

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = h.requests.length;
    h.onChat(async () => {
      await held;
      return { content: "TEST late answer" };
    });
    const inFlight = h.execute(
      CommandSchema.parse({
        type: "message.send",
        commandId: "TEST-in-flight",
        idempotencyKey: "TEST-in-flight",
        conversationId: work.conversationId,
        text: "Something else entirely.",
        language: "en",
        timeZone: "UTC",
        session: "new",
      }),
    );
    for (let i = 0; i < 200 && h.requests.length === calls; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const busy = await h.execute(cancel("TEST-busy", work));
    assert.equal(busy.status, "conflict");
    assert.equal(busy.code, "operation_in_progress");
    assert.equal(
      h.workflow.replay(h.scope, cancel("TEST-busy", work)),
      undefined,
    );
    const deleting = await h.execute(
      directory("conversation.delete", "TEST-busy-delete", true),
    );
    assert.equal(deleting.status, "conflict");
    assert.equal(deleting.code, "operation_in_progress");
    release();
    await inFlight;
  } finally {
    await h.close();
  }
});

test("delete and archive with cancelOpenWork cancel the chat's open work first", async () => {
  for (const type of ["conversation.delete", "conversation.archive"] as const) {
    const h = createTrustHarness();
    try {
      const work = await question(h);
      const refused = await h.execute(directory(type, "TEST-plain"));
      assert.equal(refused.status, "rejected");
      assert.equal(refused.code, "operation_in_progress");
      assert.deepEqual(refused.openWork, [
        { workItemId: work.id, title: work.title, kind: "question" },
      ]);
      const before = effects(h);
      const done = await h.execute(directory(type, "TEST-flag", true));
      assert.equal(done.status, "accepted", done.code);
      assert.equal(h.commandState("TEST-cancel-question").pending, undefined);
      assert.equal(item(h, work.id)?.status, "cancelled");
      assert.equal(
        (await h.execute(directory(type, "TEST-flag", true))).status,
        "accepted",
      );
      assert.deepEqual(effects(h), before);
    } finally {
      await h.close();
    }
  }
});

test("expired questions and stale stopped runs do not hold a chat", async () => {
  const old = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  {
    const h = createTrustHarness();
    try {
      const work = await question(h);
      edit(h, work.id, (data) => {
        data.openedAt = old;
      });
      await project(h);
      assert.equal(item(h, work.id).status, "expired");
      assert.equal(
        (await h.execute(directory("conversation.delete", "TEST-expired")))
          .status,
        "accepted",
      );
    } finally {
      await h.close();
    }
  }
  {
    const h = createTrustHarness();
    try {
      h.onChat(h.lookupScript);
      await h.send("Find Jane Test.", { id: "TEST-stale" });
      const runId = h.commandState("TEST-stale").runId;
      stopMidway(h, runId, old);
      await project(h);
      assert.equal(item(h, runId).status, "waiting_system");
      const done = await h.execute(
        directory("conversation.archive", "TEST-stale-archive"),
      );
      assert.equal(done.status, "accepted", done.code);
      assert.equal(h.commandState("TEST-stale").trace?.status, "cancelled");
    } finally {
      await h.close();
    }
  }
});
