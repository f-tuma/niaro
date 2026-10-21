import assert from "node:assert/strict";
import { test, after } from "node:test";
import { coordinatorHttpFixture } from "./helpers/process-coordinator-http";
import { ProcessRuntimeResponseSchema } from "../packages/protocol/process-coordinator";
import { ProcessDefinitionSchema } from "../packages/protocol/service-processes";
import { processObject } from "./helpers/service-process";
const fixture = coordinatorHttpFixture();
after(async () => {
  await (await fixture).close();
});

test("real authenticated member starts the exact native process without a chat model; private reads and two reopens remain passive", async () => {
  const h = await fixture;
  const artifact = h.activate();
  const credential = await h.pair();
  const command = await h.prepare(credential, artifact);
  const start = await h.mobile(
    credential,
    "processes/commands" + h.suffix,
    command,
  );
  assert.equal(start.status, 202, JSON.stringify(start.data));
  const result = ProcessRuntimeResponseSchema.parse(start.data);
  assert.equal(result.process?.status, "succeeded");
  assert.deepEqual(h.dispatches, ["GET"]);
  const path =
    "processes/runs" + h.suffix + "&parentRunId=" + result.process!.parentRunId;
  assert.equal((await h.mobile(undefined, path)).status, 401);
  const other = await h.pair("owner");
  assert.equal((await h.mobile(other, path)).status, 404);
  for (let i = 0; i < 2; i++) {
    await h.restart();
    const read = await h.mobile(credential, path);
    assert.equal(read.status, 200);
    assert.deepEqual(read.data, result);
    const replay = await h.mobile(
      credential,
      "processes/commands" + h.suffix,
      command,
    );
    assert.equal(replay.status, 202);
    assert.deepEqual(replay.data, result);
  }
  assert.deepEqual(h.dispatches, ["GET"]);
  assert.equal(h.ordinaryRuntimeCalls(), 0);
  assert.equal(h.modelCount(), 0);
});
test("process command HTTP negotiates strict profiles and complete 64KiB inputs with bounded envelope overhead", async () => {
  const h = await fixture;
  await h.restart();
  const fields = Object.fromEntries(
    Array.from({ length: 17 }, (_, i) => [
      "field" + i,
      { type: "string" as const },
    ]),
  );
  const artifact = h.activate(
    ProcessDefinitionSchema.parse({
      ...h.workflow(),
      entry: "done",
      inputSchema: processObject(fields),
      outputSchema: processObject({}),
      steps: [{ id: "done", type: "return", output: {} }],
    }),
  );
  const credential = await h.pair();
  const input = Object.fromEntries(
    Object.keys(fields).map((k, i) => [k, i === 16 ? "" : "x".repeat(4000)]),
  );
  input.field16 += "x".repeat(65536 - Buffer.byteLength(JSON.stringify(input)));
  assert.equal(Buffer.byteLength(JSON.stringify(input)), 65536);
  const command = await h.prepare(credential, artifact, input);
  for (const path of [
    "processes/commands",
    "processes/commands?profile=unsupported",
  ])
    assert.equal((await h.mobile(credential, path, command)).status, 406);
  for (const path of [
    "processes/commands" + h.suffix + "&profile=duplicate",
    "processes/commands" + h.suffix + "&actor=spoof",
  ])
    assert.equal((await h.mobile(credential, path, command)).status, 400);
  assert.equal(
    (
      await h.mobile(credential, "processes/commands" + h.suffix, {
        ...command,
        role: "owner",
      })
    ).status,
    400,
  );
  const accepted = await h.mobile(
    credential,
    "processes/commands" + h.suffix,
    command,
  );
  assert.equal(accepted.status, 202, JSON.stringify(accepted.data));
  assert.equal(
    ProcessRuntimeResponseSchema.parse(accepted.data).process?.status,
    "succeeded",
  );
  assert.deepEqual(h.dispatches, ["GET"]);
  assert.equal(
    (
      await h.mobile(credential, "processes/commands" + h.suffix, {
        ...command,
        input: { ...input, field16: input.field16 + "x" },
      })
    ).status,
    400,
  );
  assert.equal(h.ordinaryRuntimeCalls(), 0);
});
test("disconnect at command body end prevents admission and all native dispatch", async () => {
  const h = await fixture;
  await h.restart();
  const credential = await h.pair();
  const command = await h.prepare(credential, h.activate());
  h.trackRequestPath("/v1/" + h.target.workspaceId + "/processes/commands");
  h.disconnectNextTurnAtBodyEnd();
  await assert.rejects(
    h.mobile(credential, "processes/commands" + h.suffix, command),
  );
  await h.identity["serial"](async () => {});
  assert.equal(
    h.identity["db"]
      .prepare(
        "SELECT count(*) AS n FROM agent_process_start_command WHERE json_extract(data,'$.command.commandId')=?",
      )
      .get(command.commandId)!.n,
    0,
  );
  assert.deepEqual(h.dispatches, ["GET"]);
  assert.equal(h.ordinaryRuntimeCalls(), 0);
});

test("real member approvals bind native A and B across reopen; ordinary resolve cannot approve process receipts", async () => {
  const h = await fixture;
  await h.restart();
  const base = h.workflow();
  assert(base.kind === "workflow");
  const read = base.steps.find((s) => s.type === "action")!;
  assert(read.type === "action");
  const artifact = h.activate(
    ProcessDefinitionSchema.parse({
      ...base,
      steps: [
        { ...read, next: "writeA" },
        { ...read, id: "writeA", actionId: h.writeId, next: "writeB" },
        { ...read, id: "writeB", actionId: h.writeId, next: "done" },
        ...base.steps.filter((s) => s.type === "return"),
      ],
    }),
  );
  const credential = await h.pair();
  const command = await h.prepare(credential, artifact);
  const start = await h.mobile(
    credential,
    "processes/commands" + h.suffix,
    command,
  );
  assert.equal(start.status, 202, JSON.stringify(start.data));
  const a = ProcessRuntimeResponseSchema.parse(start.data);
  assert(a.process?.approval);
  const decide = (r: typeof a, id: string) => ({
    profile: "agent-process-execution/1",
    type: "service.resolve",
    commandId: id,
    idempotencyKey: id + "-key",
    conversationId: command.conversationId,
    workItemId: r.process!.parentRunId,
    expectedWorkRevision: r.process!.revision,
    operationId: r.process!.approval!.operationId,
    approved: true,
    language: "en",
  });
  const commandA = decide(a, "TEST-mobile-A");
  // Real ordinary command schema admits legacy operation-only approval; runtime must refuse it.
  const savedMobile = h.identity.mobileAccess;
  const identityPrototype = Object.getPrototypeOf(
    h.identity,
  ) as typeof h.identity;
  h.identity.mobileAccess = identityPrototype.mobileAccess.bind(h.identity);
  try {
    const legacy = await h.mobile(credential, "commands", {
      type: "service.resolve",
      commandId: "TEST-legacy-approve",
      idempotencyKey: "TEST-legacy-key",
      conversationId: command.conversationId,
      operationId: commandA.operationId,
      approved: true,
      language: "en",
    });
    assert.equal(legacy.status, 422, JSON.stringify(legacy.data));
    assert.equal(h.record(legacy.data).code, "unknown_context");
  } finally {
    h.identity.mobileAccess = savedMobile;
  }
  const next = await h.mobile(
    credential,
    "processes/commands" + h.suffix,
    commandA,
  );
  assert.equal(next.status, 202, JSON.stringify(next.data));
  const b = ProcessRuntimeResponseSchema.parse(next.data);
  assert(b.process?.approval);
  assert.notEqual(
    a.process.approval.operationId,
    b.process.approval.operationId,
  );
  await h.restart();
  const replay = await h.mobile(
    credential,
    "processes/commands" + h.suffix,
    commandA,
  );
  assert.equal(replay.status, 202);
  assert.deepEqual(replay.data, b);
  const stopped = await h.mobile(
    credential,
    "processes/commands/interrupt" + h.suffix,
    { profile: "agent-process-execution/1", command: commandA },
  );
  assert.equal(stopped.status, 200, JSON.stringify(stopped.data));
  const done = await h.mobile(
    credential,
    "processes/commands" + h.suffix,
    decide(b, "TEST-mobile-B"),
  );
  assert.equal(done.status, 202, JSON.stringify(done.data));
  assert.equal(
    ProcessRuntimeResponseSchema.parse(done.data).process?.status,
    "succeeded",
  );
  assert.deepEqual(h.dispatches, ["GET", "GET", "POST", "POST"]);
});

test("device revocation at the final dispatch guard prevents a business call", async () => {
  const h = await fixture;
  await h.restart();
  const credential = await h.pair();
  const command = await h.prepare(credential, h.activate());
  h.beforeDispatch(() =>
    h.identity.revokeMobile("Bearer " + credential.accessToken),
  );
  try {
    const result = await h.mobile(
      credential,
      "processes/commands" + h.suffix,
      command,
    );
    assert.equal(result.status, 401, JSON.stringify(result.data));
    assert.deepEqual(h.dispatches, ["GET", "GET", "POST", "POST"]);
  } finally {
    h.beforeDispatch(undefined);
  }
});

test("server shutdown waits for a process transport tail before closing identity and native storage", async () => {
  const h = await fixture;
  await h.restart();
  const credential = await h.pair();
  const command = await h.prepare(credential, h.activate());
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => {
    enter = r;
  });
  const tail = new Promise<void>((r) => {
    release = r;
  });
  h.afterDispatch(async () => {
    enter();
    await tail;
  });
  const delivery = h.mobile(
    credential,
    "processes/commands" + h.suffix,
    command,
  );
  const settledDelivery = delivery.then(
    (r) => r,
    () => undefined,
  );
  await entered;
  let closed = false;
  const restarting = h.restart().then(() => {
    closed = true;
  });
  await new Promise((r) => setTimeout(r, 50));
  try {
    assert.equal(closed, false);
  } finally {
    release();
  }
  await Promise.all([restarting, settledDelivery]);
  h.afterDispatch(undefined);
  assert.equal(closed, true);
  assert.deepEqual(h.dispatches, ["GET", "GET", "POST", "POST", "GET"]);
  const admission = h.identity["processStarts"]!.read(
    {
      organizationId: h.target.organizationId,
      workspaceId: h.target.workspaceId,
      userId: credential.scope.userId,
      role: "member",
    },
    credential.scope,
    command.commandId,
    command.idempotencyKey,
  );
  assert.equal(admission.status, "admitted");
});
