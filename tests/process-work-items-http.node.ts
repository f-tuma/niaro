import assert from "node:assert/strict";
import { test, after } from "node:test";
import { coordinatorHttpFixture } from "./helpers/process-coordinator-http";
import { ProcessRuntimeResponseSchema } from "../packages/protocol/process-coordinator";
import {
  PROCESS_WORK_PROFILE,
  PROCESS_QUESTION_WORK_PROFILE,
  PROCESS_APPROVAL_WORK_PROFILE,
} from "../packages/protocol/process-work";
import { SnapshotSchema, EventsResponseSchema } from "../packages/protocol";
import { ProcessDefinitionSchema } from "../packages/protocol/service-processes";
import { CONTACT_CONTEXT_TTL } from "../apps/server-identity/contact-context";
import { CARD_PROFILE } from "../packages/protocol/card-document";
const fixture = coordinatorHttpFixture({ allowOrdinaryRuntime: true });
after(async () => {
  await (await fixture).close();
});
const delivery = `?cards=${encodeURIComponent(CARD_PROFILE)}&tasks=${encodeURIComponent(PROCESS_WORK_PROFILE)}`;
test("actual authenticated Tasks snapshot negotiates passive process cards, canonical identity and two reopened reads without service replay", async () => {
  const h = await fixture;
  const credential = await h.pair();
  const command = await h.prepare(credential, h.activate());
  const response = await h.mobile(
    credential,
    "processes/commands" + h.suffix,
    command,
  );
  assert.equal(response.status, 202);
  const process = ProcessRuntimeResponseSchema.parse(response.data);
  const id = process.process!.parentRunId;
  const first = await h.mobile(credential, "snapshot" + delivery);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const snapshot = SnapshotSchema.parse(first.data);
  const work = snapshot.workItems.find((w) => w.id === id)!;
  assert(work.card);
  assert.equal(work.status, "succeeded");
  assert.equal(work.native!.process!.provenance.commandId, command.commandId);
  assert.deepEqual(
    work.native!.process!.receipts.map((r) => [r.effect, r.status]),
    [["read", "succeeded"]],
  );
  const legacy = SnapshotSchema.parse(
    (
      await h.mobile(
        credential,
        "snapshot?cards=" + encodeURIComponent(CARD_PROFILE),
      )
    ).data,
  );
  assert.equal(
    legacy.workItems.find((w) => w.id === id)!.native!.process,
    undefined,
  );
  const old = await h.pair("owner");
  assert(
    !SnapshotSchema.parse(
      (await h.mobile(old, "snapshot" + delivery)).data,
    ).workItems.some((w) => w.id === id),
  );
  for (let i = 0; i < 2; i++) {
    await h.restart();
    const next = await h.mobile(credential, "snapshot" + delivery);
    assert.equal(next.status, 200);
    assert.deepEqual(SnapshotSchema.parse(next.data), snapshot);
  }
  assert.deepEqual(h.dispatches, ["GET"]);
  assert.equal(h.modelCount(), 0);
});
test("HTTP refuses a stale persisted process snapshot when every projection freshness validation fails", async () => {
  const h = await fixture;
  await h.restart();
  const credential = await h.pair();
  const command = await h.prepare(credential, h.activate());
  assert.equal(
    (await h.mobile(credential, "processes/commands" + h.suffix, command))
      .status,
    202,
  );
  assert.equal((await h.mobile(credential, "snapshot" + delivery)).status, 200);
  const original = h.identity.mobileAccess.bind(h.identity);
  let attempts = 0;
  h.identity.mobileAccess = async (...args) => {
    const access = await original(...args);
    access.integrations!.taskWindow = async () => {
      attempts++;
      return { items: [], validate: () => false };
    };
    return access;
  };
  const response = await h.mobile(credential, "snapshot" + delivery);
  assert.equal(response.status, 503);
  assert.deepEqual(response.data, { error: "task_projection_changed" });
  assert.equal(attempts, 3);
  const events = await h.mobile(credential, "events" + delivery + "&after=0");
  assert.equal(events.status, 503);
  assert.equal(h.modelCount(), 0);
  assert.deepEqual(h.dispatches, ["GET", "GET"]);
});
test("actual HTTP work/3 reviews original pending parameters, keeps strict older profiles passive and refuses unavailable new decisions before binding", async () => {
  const h = await fixture;
  await h.restart();
  const baseline = h.dispatches.length;
  const credential = await h.pair();
  const base = h.workflow();
  assert(base.kind === "workflow");
  const read = base.steps.find((step) => step.type === "action")!;
  assert(read.type === "action");
  const artifact = h.activate(
    ProcessDefinitionSchema.parse({
      ...base,
      steps: [
        { ...read, next: "write" },
        { ...read, id: "write", actionId: h.writeId, next: "done" },
        ...base.steps.filter((step) => step.type === "return"),
      ],
    }),
  );
  const command = await h.prepare(credential, artifact);
  const started = await h.mobile(
    credential,
    "processes/commands" + h.suffix,
    command,
  );
  assert.equal(started.status, 202, JSON.stringify(started.data));
  const state = ProcessRuntimeResponseSchema.parse(started.data).process!;
  assert(state.approval);
  const query = (profile: string) => `?tasks=${encodeURIComponent(profile)}`;
  const projected = async (profile: string, cards = false) => {
    const response = await h.mobile(
      credential,
      "snapshot" +
        query(profile) +
        (cards ? `&cards=${encodeURIComponent(CARD_PROFILE)}` : ""),
    );
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return SnapshotSchema.parse(response.data).workItems.find(
      (work) => work.id === state.parentRunId,
    )!;
  };
  const catalog = h.identity["catalog"].store;
  const original = catalog.invocation(
    state.approval.operationId,
    credential.scope.workspaceId,
    credential.scope.userId,
  )!;
  const work = await projected(PROCESS_APPROVAL_WORK_PROFILE);
  assert.equal(work.card, undefined);
  const approval = work.native!.process!.approval!;
  assert.equal(approval.nodeId, state.approval.nodeId);
  assert.equal(approval.result.operationId, state.approval.operationId);
  assert.equal(approval.result.inputJson, JSON.stringify(original.input));
  assert.equal(approval.serviceRevision, original.serviceRevision);
  assert.equal(approval.actionRevision, original.actionRevision);
  assert.equal(work.native!.revision, state.revision);
  assert(!("card" in approval.result));
  for (const profile of [PROCESS_WORK_PROFILE, PROCESS_QUESTION_WORK_PROFILE]) {
    const old = (await projected(profile, true)).native!.process!;
    assert(!("approval" in old));
    assert(!("approvalUnavailable" in old));
    const events = await h.mobile(
      credential,
      "events" + query(profile) + "&after=0",
    );
    assert.equal(events.status, 200);
    for (const event of EventsResponseSchema.parse(events.data).events)
      if (
        event.type === "work_item.upserted" &&
        event.entity.id === state.parentRunId
      ) {
        assert(!("approval" in event.entity.native!.process!));
        assert(!("approvalUnavailable" in event.entity.native!.process!));
      }
  }
  await h.restart();
  assert.deepEqual(
    (await projected(PROCESS_APPROVAL_WORK_PROFILE)).native!.process!.approval,
    approval,
  );
  const current = h.identity["catalog"].store;
  const decision = {
    profile: "agent-process-execution/1",
    type: "service.resolve",
    commandId: "TEST-HTTP-review",
    idempotencyKey: "TEST-HTTP-review-key",
    conversationId: command.conversationId,
    workItemId: state.parentRunId,
    expectedWorkRevision: state.revision,
    operationId: state.approval.operationId,
    approved: true,
    language: "en",
  };
  const noBinding = () =>
    assert.equal(
      h.identity["db"]
        .prepare(
          "SELECT count(*) AS n FROM agent_process_resolve_command WHERE operation_id=?",
        )
        .get(state.approval!.operationId)!.n,
      0,
    );
  current.saveInvocation({
    ...original,
    input: { name: "TEST".repeat(40000) },
  });
  const large = (await projected(PROCESS_APPROVAL_WORK_PROFILE)).native!
    .process!;
  assert.equal(large.approval, undefined);
  assert.equal(large.approvalUnavailable, "parameters");
  assert.equal(
    (await h.mobile(credential, "processes/commands" + h.suffix, decision))
      .status,
    409,
  );
  noBinding();
  current.saveInvocation(original);
  const readReceipt = current.invocation(
    work.native!.process!.receipts[0]!.operationId,
    credential.scope.workspaceId,
    credential.scope.userId,
  )!;
  current.saveInvocation({
    ...readReceipt,
    completedAt: Date.now() - CONTACT_CONTEXT_TTL - 1,
  });
  const expired = (await projected(PROCESS_APPROVAL_WORK_PROFILE)).native!
    .process!;
  assert.equal(expired.approval, undefined);
  assert.equal(expired.approvalUnavailable, "context");
  assert.equal(
    (
      await h.mobile(credential, "processes/commands" + h.suffix, {
        ...decision,
        commandId: "TEST-HTTP-expired",
        idempotencyKey: "TEST-HTTP-expired-key",
      })
    ).status,
    409,
  );
  noBinding();
  assert.deepEqual(h.dispatches.slice(baseline), ["GET"]);
  assert.equal(h.modelCount(), 0);
});
