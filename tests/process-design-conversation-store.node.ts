import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyDesignBrief,
  DesignTurnModelSchema,
  DesignTurnStartSchema,
} from "../packages/protocol/process-design";
import { ProcessDesignConversationStore } from "../apps/server-identity/process-design-conversation-store";
import {
  designActor,
  designFixture,
  designTarget,
} from "./helpers/process-design";

function setup() {
  const h = designFixture();
  const sessionId = h.store.start(designActor, {
    ...designTarget,
    requestId: "TEST-design-start",
    serviceId: h.serviceId,
  }).sessionId;
  const journal = new ProcessDesignConversationStore(h.db, "TEST-server");
  journal.bind(designActor, {
    sessionId,
    creator: designActor,
    ...journal.ids(designActor, sessionId),
    modelId: h.modelId,
    modelRevision: 1,
    providerId: h.providerId,
    providerRevision: 1,
    caps: {
      maxModelCalls: 32,
      maxTokens: 1_000_000,
      maxCostMicros: 10_000_000,
    },
  });
  const turn = journal.start(
    designActor,
    {
      sessionId,
      requestId: "TEST-turn",
      text: "TEST original request",
      language: "cs",
      revision: 1,
    },
    "TEST-digest",
    64,
  );
  const invoke = () => {
    const receipt = h.store.update(designActor, {
      ...designTarget,
      sessionId,
      requestId: "TEST-native-call",
      revision: 1,
      brief: { ...emptyDesignBrief(), purpose: "TEST purpose" },
      candidate: h.workflow(),
    });
    turn.revision = receipt.revision;
    turn.toolReceipts.push({
      toolCallId: "TEST-call",
      name: "design_update_proposal",
      revision: receipt.revision,
    });
    return { designReceipt: turn.toolReceipts[0] };
  };
  return { ...h, journal, turn, invoke, sessionId };
}

test("proposal update and native receipt roll back together when receipt persistence fails", () => {
  const h = setup();
  try {
    h.db.exec(
      "CREATE TRIGGER TEST_fail_design_receipt BEFORE INSERT ON agent_process_design_tool BEGIN SELECT RAISE(ABORT,'TEST receipt failure'); END;",
    );
    assert.throws(
      () =>
        h.journal.tool(
          designActor,
          h.turn,
          "TEST-call",
          "TEST-call-digest",
          h.invoke,
        ),
      /TEST receipt failure/,
    );
    assert.equal(h.store.get(designActor, h.sessionId).revision, 1);
    assert.equal(h.store.get(designActor, h.sessionId).candidate, null);
    assert.equal(
      h.journal.read(designActor, h.sessionId, "TEST-turn")!.state.toolReceipts
        .length,
      0,
    );
    assert.equal(
      h.db.prepare("SELECT COUNT(*) AS n FROM agent_process_design_tool").get()!
        .n,
      0,
    );
    assert.equal(
      h.db
        .prepare("SELECT COUNT(*) AS n FROM agent_process_design_command")
        .get()!.n,
      1,
    );
    h.db.exec("DROP TRIGGER TEST_fail_design_receipt");
    const fresh = h.journal.read(designActor, h.sessionId, "TEST-turn")!.state;
    assert.deepEqual(
      h.journal.tool(
        designActor,
        fresh,
        "TEST-call",
        "TEST-call-digest",
        () => {
          const result = h.invoke();
          fresh.revision = 2;
          fresh.toolReceipts = [h.turn.toolReceipts[0]!];
          return result;
        },
      ),
      {
        designReceipt: {
          toolCallId: "TEST-call",
          name: "design_update_proposal",
          revision: 2,
        },
      },
    );
    assert.equal(h.store.get(designActor, h.sessionId).revision, 2);
  } finally {
    h.db.close();
  }
});

test("exact tool replay preserves one proposal edit; reused call identity with changed arguments conflicts", () => {
  const h = setup();
  try {
    const output = h.journal.tool(
      designActor,
      h.turn,
      "TEST-call",
      "TEST-call-digest",
      h.invoke,
    );
    let invoked = 0;
    assert.deepEqual(
      h.journal.tool(
        designActor,
        h.turn,
        "TEST-call",
        "TEST-call-digest",
        () => {
          invoked++;
        },
      ),
      output,
    );
    assert.throws(
      () =>
        h.journal.tool(
          designActor,
          h.turn,
          "TEST-call",
          "TEST-changed-digest",
          () => {
            invoked++;
          },
        ),
      /process_design_tool_conflict/,
    );
    assert.equal(invoked, 0);
    assert.equal(h.store.get(designActor, h.sessionId).revision, 2);
    assert.equal(
      h.db.prepare("SELECT COUNT(*) AS n FROM agent_process_design_tool").get()!
        .n,
      1,
    );
  } finally {
    h.db.close();
  }
});

test("restart hides staged assistant reply and permanently interrupts the old command", () => {
  const h = setup();
  try {
    h.turn.candidateReply = "TEST staged assistant reply";
    h.journal.write(designActor, h.turn);
    const reopened = new ProcessDesignConversationStore(h.db, "TEST-server");
    const orphan = reopened.read(designActor, h.sessionId, "TEST-turn")!.state;
    assert.equal(orphan.status, "interrupted");
    assert.equal(orphan.failure, "process_design_server_restarted");
    assert.equal(reopened.view(designActor, orphan).reply, null);
    assert.equal(
      reopened.view(designActor, orphan).userText,
      "TEST original request",
    );
    assert.throws(
      () =>
        reopened.tool(
          designActor,
          h.turn,
          "TEST-new-call",
          "TEST-digest",
          h.invoke,
        ),
      /process_design_turn_closed/,
    );
    assert.equal(h.store.get(designActor, h.sessionId).revision, 1);
    const twice = new ProcessDesignConversationStore(h.db, "TEST-server");
    assert.deepEqual(
      twice.view(
        designActor,
        twice.read(designActor, h.sessionId, "TEST-turn")!.state,
      ),
      reopened.view(designActor, orphan),
    );
    assert.equal(
      twice.read(
        { ...designActor, userId: "TEST-other-owner" },
        h.sessionId,
        "TEST-turn",
      ),
      null,
    );
  } finally {
    h.db.close();
  }
});

test("legacy turn rows project the original server model pin privately without copying binding secrets", () => {
  const h = setup();
  try {
    const pin = {
      id: h.modelId,
      revision: 1,
      providerId: h.providerId,
      providerRevision: 1,
    };
    const raw = String(
      h.db.prepare("SELECT data FROM agent_process_design_turn").get()!.data,
    );
    assert.equal(JSON.parse(raw).model, undefined);
    assert.deepEqual(h.journal.view(designActor, h.turn).model, pin);
    for (const actor of [
      { ...designActor, userId: "TEST-other-creator" },
      { ...designActor, role: "member" as const },
      { ...designActor, workspaceId: "TEST-other-workspace" },
    ])
      assert.throws(
        () => h.journal.view(actor, h.turn),
        /process_design_not_found/,
      );
    for (const status of ["completed", "failed", "interrupted"] as const) {
      h.turn.status = status;
      h.turn.reply = "TEST published only on completion";
      h.turn.candidateReply = "TEST hidden candidate";
      h.journal.write(designActor, h.turn);
      const reopened = new ProcessDesignConversationStore(h.db, "TEST-server");
      const recorded = reopened.read(
        designActor,
        h.sessionId,
        "TEST-turn",
      )!.state;
      const dto = reopened.view(designActor, recorded);
      assert.deepEqual(dto.model, pin);
      assert.equal(dto.reply, status === "completed" ? h.turn.reply : null);
      const publicText = JSON.stringify(dto);
      const binding = reopened.binding(designActor, h.sessionId)!;
      for (const privateValue of [
        binding.rootId,
        binding.threadId,
        binding.resourceId,
        binding.creator.userId,
        "TEST hidden candidate",
      ])
        assert(!publicText.includes(privateValue));
      const poisoned = { ...recorded, model: { id: "TEST-fabricated-model" } };
      assert.deepEqual(reopened.view(designActor, poisoned).model, pin);
    }
    assert(!DesignTurnModelSchema.safeParse({ ...pin, caps: {} }).success);
    assert(!DesignTurnModelSchema.safeParse({ ...pin, revision: -1 }).success);
    assert(
      !DesignTurnStartSchema.safeParse({
        ...designTarget,
        sessionId: h.sessionId,
        requestId: "TEST-forged-pin",
        revision: 1,
        modelId: h.modelId,
        text: "TEST request",
        model: pin,
      }).success,
    );
  } finally {
    h.db.close();
  }
});
