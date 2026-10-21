import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CommandSchema,
  WorkItemSchema,
  type WorkItem,
} from "../packages/protocol";
import { nativeCatalogOwner } from "../apps/server-identity/mastra-runtime";
import {
  createTrustHarness,
  toolResults,
  type TrustHarness,
} from "./agent-trust/harness";

async function question(h: TrustHarness, id = "TEST-mcp-question") {
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
const binding = (work: WorkItem) => ({
  workItemId: work.id,
  expectedWorkRevision: work.native!.revision,
  conversationId: work.conversationId,
});
const unchanged = (h: TrustHarness) => ({
  requests: h.requests.length,
  network: h.network.length,
  serviceRequests: h.serviceRequests.length,
});

test("canonical cancellation closes the exact native question and persists across restart without inference", async () => {
  const h = createTrustHarness();
  try {
    const work = await question(h);
    const before = unchanged(h);
    const cancelled = await h.runtime().cancelTask!(binding(work));
    assert.equal(cancelled.workItemId, work.id);
    const state = h.commandState("TEST-mcp-question");
    assert.equal(state.pending, undefined);
    assert.equal(state.trace?.status, "cancelled");
    assert.equal(state.taskCancellation?.toolCallId.length! > 0, true);
    assert.deepEqual(unchanged(h), before);
    const read = await h.runtime().readTask!("TEST-mcp-question");
    assert.equal(read?.status, "cancelled");
    assert.equal(read?.native?.question, undefined);
    assert.equal(read?.cancellationSettled, true);
    const {
      cancellationSettled: _proof,
      cancellationPending: _pending,
      ...publicWork
    } = read!;
    WorkItemSchema.parse(publicWork);
    const revision = state.workRevision;
    await h.restart();
    assert.deepEqual(await h.runtime().cancelTask!(binding(work)), cancelled);
    assert.equal(h.commandState("TEST-mcp-question").workRevision, revision);
    const answered = await h.execute(
      CommandSchema.parse({
        type: "message.send",
        commandId: "TEST-after-cancel",
        idempotencyKey: "TEST-after-cancel",
        conversationId: work.conversationId,
        text: "Tomorrow.",
        language: "en",
        context: {
          runtime: "mastra",
          workItemId: work.id,
          inputRequestId: work.native!.question!.id,
          expectedInputRevision: 1,
        },
      }),
    );
    assert.equal(answered.status, "conflict");
    assert.deepEqual(unchanged(h), before);
  } finally {
    await h.close();
  }
});

test("canonical cancellation rejects an awaiting approval and stale approval cannot dispatch", async () => {
  const h = createTrustHarness();
  try {
    h.onChat(h.writeScript);
    const result = await h.send("Create a meeting with Jane Test.", {
      id: "TEST-mcp-approval",
    });
    const work = result.snapshot.workItems.find(
      (item) => item.native?.action?.status === "awaiting_approval",
    )!;
    assert(work);
    const operationId = work.native!.action!.operationId;
    const before = unchanged(h);
    const answer = await h.runtime().cancelTask!(binding(work));
    assert.equal(answer.result?.status, "rejected");
    assert.equal(
      h.catalog.invocation(operationId, h.scope.workspaceId, h.scope.userId)
        ?.status,
      "rejected",
    );
    const read = await h.runtime().readTask!("TEST-mcp-approval");
    assert.equal(read?.status, "cancelled");
    assert.equal(read?.native?.action?.status, "rejected");
    await h.restart();
    h.workflow.syncNativeWork(h.scope, await h.runtime().tasks!());
    const approved = await h.execute(
      CommandSchema.parse({
        type: "service.resolve",
        commandId: "TEST-approval-after-cancel",
        idempotencyKey: "TEST-approval-after-cancel",
        conversationId: work.conversationId,
        workItemId: work.id,
        expectedWorkRevision: work.revision,
        operationId,
        approved: true,
        language: "en",
      }),
    );
    assert.equal(approved.status, "conflict");
    assert.deepEqual(unchanged(h), before);
  } finally {
    await h.close();
  }
});

test("wrong task pins and revoked source, policy or memory refuse cancellation without mutating pending state", async () => {
  for (const change of [
    "revision",
    "conversation",
    "actor",
    "epoch",
    "source",
    "memory",
  ] as const) {
    const h = createTrustHarness();
    try {
      const work = await question(h);
      const state = h.commandState("TEST-mcp-question");
      const before = unchanged(h);
      const pin = binding(work);
      if (change === "revision") pin.expectedWorkRevision++;
      if (change === "conversation")
        pin.conversationId = "TEST-other-conversation";
      if (change === "actor")
        h.context.actor = async () => ({
          userId: "TEST-other-user",
          role: "member",
        });
      if (change === "epoch") h.context.change(h.target.organizationId);
      if (change === "source") {
        const receipt = h.catalog.invocation(
          state.sources[0]!,
          h.scope.workspaceId,
          h.scope.userId,
        )!;
        h.catalog.saveInvocation({
          ...receipt,
          completedAt: Date.now() - 31 * 60 * 1000,
        });
      }
      if (change === "memory")
        h.memoryStore.setOptOut(h.memoryActor, {
          requestId: "TEST-memory-revoke",
          optOut: true,
        });
      await assert.rejects(h.runtime().cancelTask!(pin));
      assert.deepEqual(
        h.commandState("TEST-mcp-question").pending,
        state.pending,
      );
      assert.equal(
        h.commandState("TEST-mcp-question").taskCancellation,
        undefined,
      );
      assert.deepEqual(unchanged(h), before);
    } finally {
      await h.close();
    }
  }
});

test("missing suspension proof or unsettled native owner never claims cancellation", async () => {
  for (const gap of ["checkpoint", "settlement"] as const) {
    const h = createTrustHarness();
    try {
      const work = await question(h);
      const before = unchanged(h);
      const owner = await nativeCatalogOwner(h.controller);
      if (gap === "checkpoint") owner.proveSuspended = async () => false;
      else owner.isSettled = () => false;
      await assert.rejects(
        h.runtime().cancelTask!(binding(work)),
        /native_run_not_settled/,
      );
      if (gap === "checkpoint")
        assert.equal(
          (await h.runtime().readTask!("TEST-mcp-question"))?.status,
          "waiting_system",
        );
      assert(h.commandState("TEST-mcp-question").pending);
      assert.equal(
        h.commandState("TEST-mcp-question").taskCancellation,
        undefined,
      );
      assert.deepEqual(unchanged(h), before);
    } finally {
      await h.close();
    }
  }
});

test("passive plain reads do not publish completion without native retirement proof", async () => {
  const h = createTrustHarness();
  try {
    h.onChat(() => ({ content: "TEST completed answer" }));
    await h.send("Answer this request.", { id: "TEST-read-unsettled" });
    const owner = await nativeCatalogOwner(h.controller);
    owner.proveRetired = async () => false;
    const before = unchanged(h);
    const read = await h.runtime().readTask!("TEST-read-unsettled");
    assert.equal(read?.status, "waiting_system");
    assert.equal(read?.result, undefined);
    assert(!JSON.stringify(read).includes("TEST completed answer"));
    assert.deepEqual(unchanged(h), before);
  } finally {
    await h.close();
  }
});

test("approval rejection and journal cancellation roll back together if the journal write fails", async () => {
  const h = createTrustHarness();
  try {
    h.onChat(h.writeScript);
    const result = await h.send("Create a meeting with Jane Test.", {
      id: "TEST-mcp-rollback",
    });
    const work = result.snapshot.workItems.find(
      (item) => item.native?.action?.status === "awaiting_approval",
    )!;
    const operationId = work.native!.action!.operationId;
    const save = h.catalog.saveTurn;
    h.catalog.saveTurn = () => {
      throw new Error("TEST journal write failed");
    };
    try {
      await assert.rejects(
        h.runtime().cancelTask!(binding(work)),
        /TEST journal write failed/,
      );
    } finally {
      h.catalog.saveTurn = save;
    }
    assert.equal(
      h.catalog.invocation(operationId, h.scope.workspaceId, h.scope.userId)
        ?.status,
      "awaiting_approval",
    );
    assert(h.commandState("TEST-mcp-rollback").pending);
    assert.equal(
      h.commandState("TEST-mcp-rollback").taskCancellation,
      undefined,
    );
  } finally {
    await h.close();
  }
});

test("cancellation preserves confirmed and unknown write receipts while stopping a suspended question", async () => {
  for (const outcome of ["success", "lost"] as const) {
    const h = createTrustHarness({ writeApproval: "never" });
    try {
      h.writeResponse = outcome;
      h.onChat((body) =>
        toolResults(body).some(
          (result) =>
            result.currentTurn &&
            (result.data?.created || result.status === "unknown"),
        )
          ? h.call("ask_user", { question: "What should happen next?" })
          : h.writeScript(body),
      );
      const result = await h.send("Create a meeting and ask what to do next.", {
        id: "TEST-mcp-effect",
      });
      const work = result.snapshot.workItems.find(
        (item) => item.native?.question,
      )!;
      assert(work);
      const state = h.commandState("TEST-mcp-effect");
      const operation = state.operations
        .map(
          (id) =>
            h.catalog.invocation(id, h.scope.workspaceId, h.scope.userId)!,
        )
        .find((receipt) => receipt.effect === "write")!;
      assert(operation);
      const before = unchanged(h);
      await h.runtime().cancelTask!(binding(work));
      assert.deepEqual(
        h.catalog.invocation(operation.id, h.scope.workspaceId, h.scope.userId),
        operation,
      );
      const read = await h.runtime().readTask!("TEST-mcp-effect");
      assert.equal(read?.native?.question, undefined);
      assert.equal(
        read?.native?.action?.status,
        outcome === "success" ? "succeeded" : "unknown",
      );
      assert.equal(
        read?.status,
        outcome === "success" ? "cancelled" : "waiting_system",
      );
      assert.deepEqual(unchanged(h), before);
    } finally {
      await h.close();
    }
  }
});

test("passive exact task reads include plain answers, recheck terminal memory and omit them from Tasks", async () => {
  const h = createTrustHarness();
  try {
    const note = await h.memoryStore.remember(h.memoryActor, {
      requestId: "TEST-read-note",
      content: "TEST forgotten preference",
      kind: "preference",
      source: { type: "user_note" },
      explicitIntent: true,
      settings: h.memorySettings,
    });
    h.onChat(() => ({ content: "TEST forgotten preference" }));
    await h.send("Tell me my preference.", { id: "TEST-mcp-plain" });
    const before = unchanged(h);
    const read = await h.runtime().readTask!("TEST-mcp-plain");
    assert.equal(read?.result, "TEST forgotten preference");
    assert.equal(read?.status, "succeeded");
    assert.equal(
      (await h.runtime().tasks!()).some((item) => item.id === read?.id),
      false,
    );
    assert.equal(await h.runtime().readTask!("TEST-unrelated-command"), null);
    await h.memoryStore.forget(h.memoryActor, {
      requestId: "TEST-read-forget",
      id: note.id,
      revision: note.revision,
    });
    const revoked = await h.runtime().readTask!("TEST-mcp-plain");
    assert.equal(revoked?.status, "superseded");
    assert.equal(revoked?.result, undefined);
    assert(!JSON.stringify(revoked).includes("TEST forgotten preference"));
    assert.deepEqual(unchanged(h), before);
  } finally {
    await h.close();
  }
});

test("passive terminal reads recheck source expiry and policy without returning cached results", async () => {
  for (const change of ["source", "epoch"] as const) {
    const h = createTrustHarness();
    try {
      h.onChat(h.lookupScript);
      await h.send("Find Jane Test.", { id: "TEST-mcp-terminal-read" });
      const state = h.commandState("TEST-mcp-terminal-read");
      const before = unchanged(h);
      if (change === "epoch") h.context.change(h.target.organizationId);
      else {
        const receipt = h.catalog.invocation(
          state.sources[0]!,
          h.scope.workspaceId,
          h.scope.userId,
        )!;
        h.catalog.saveInvocation({
          ...receipt,
          completedAt: Date.now() - 31 * 60 * 1000,
        });
      }
      const read = await h.runtime().readTask!("TEST-mcp-terminal-read");
      assert.equal(read?.status, "superseded");
      assert.equal(read?.result, undefined);
      assert.equal(read?.native?.action, undefined);
      assert.deepEqual(unchanged(h), before);
    } finally {
      await h.close();
    }
  }
});
