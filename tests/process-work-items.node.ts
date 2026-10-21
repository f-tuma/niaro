import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { startFixture } from "./helpers/process-start";
import { admin, scope, signal, code } from "./helpers/service-process-runtime";
import { createProcessTaskProjection } from "../apps/server-identity/process-work-items";
import { createCatalogRuntime } from "../apps/server-identity/catalog-runtime";
import { JournalSchema } from "../apps/server-identity/service-process-journal";
import { ProcessDefinitionSchema } from "../packages/protocol/service-processes";
import { LoopsStore } from "../apps/server-identity/loops";
import { CONTACT_CONTEXT_TTL } from "../apps/server-identity/contact-context";
import { ServiceOAuthStore } from "../apps/server-identity/service-oauth";
import { createMemoryRuntime } from "../apps/server-identity/memory-runtime";
import { processAgent, callProcessTool } from "./helpers/service-process-agent";
import { createProcessCoordinator } from "../apps/server-identity/process-coordinator";
import { ProcessResolveStore } from "../apps/server-identity/process-resolve-store";
import { NativeCommandRequests } from "../apps/server-identity/native-command-requests";
import { IdentityError } from "../apps/server-identity/error";
import { FixtureEngine } from "../apps/fixture-server/engine";
import {
  fromSnapshot,
  selectTasks,
  selectWorkMessageAnchors,
} from "../packages/client-core/store";
import {
  snapshotWithoutProcessWork,
  eventsWithoutProcessWork,
  snapshotWithoutProcessApprovals,
  eventsWithoutProcessApprovals,
  ProcessApprovalSchema,
  ProcessWorkSchema,
} from "../packages/protocol/process-work";
import { snapshotWithoutCards } from "../packages/protocol/card-delivery";

type Harness = ReturnType<typeof startFixture>;
async function isolated(
  run: (h: Harness, reopen: () => Promise<Harness>) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "niaro-process-projection-"));
  let h = startFixture(join(root, "identity.sqlite"));
  try {
    await run(h, async () => {
      const ids = h.ids;
      await h.close();
      h = startFixture(join(root, "identity.sqlite"), ids);
      return h;
    });
  } finally {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  }
}
const projector = (h: Harness) =>
  createProcessTaskProjection(
    h.controller,
    h.registry,
    h.starts,
    h.context,
    scope,
    admin.organizationId,
    h.memory,
    () => h.memoryStore.version(h.memoryActor),
  );
const items = async (h: Harness) => {
  const p = projector(h);
  return p.project(
    (await p.roots()).filter((r) => r.kind === "service-process-1"),
  );
};
const catalog = (h: Harness) =>
  createCatalogRuntime(
    h.controller,
    h.controller.transport,
    h.context,
    scope,
    admin.organizationId,
    false,
    false,
    undefined,
    h.memory,
    undefined,
    projector(h),
  );
function admit(h: Harness, definition = h.basic()) {
  const { intent, command } = h.setup(definition);
  const receipt = h.starts.admit(
    admin,
    scope,
    intent.intentId,
    command,
    () => {},
  );
  assert.equal(receipt.status, "admitted");
  if (receipt.status !== "admitted") throw Error("TEST admission");
  return receipt;
}
const read = (h: Harness, id: string) =>
  JournalSchema.parse(h.catalog.turn(id, scope.workspaceId, scope.userId));

function personalOAuth(h: Harness, now: () => number) {
  const oauth = new ServiceOAuthStore(
    h.db,
    "TEST-only-secret",
    "https://agent.example.test",
  );
  Object.defineProperty(h.catalog, "oauth", { value: oauth });
  const target = h.catalog.oauthTarget(scope.workspaceId, h.ids.serviceId);
  oauth.save(
    target,
    0,
    { requiredFor: "all", signInHint: "service" },
    { clientId: "TEST-client", clientSecret: "TEST-client-secret" },
  );
  oauth.setDiscovery(target, 1, {
    issuer: "https://crm.example.test",
    authorizationEndpoint: "https://crm.example.test/authorize",
    tokenEndpoint: "https://crm.example.test/token",
    registrationEndpoint: null,
    scopes: ["api"],
    tokenEndpointAuthMethods: ["client_secret_post"],
    authorizationResponseIssParameterSupported: true,
  });
  const actor = { userId: scope.userId, sessionId: "TEST-session" };
  return {
    oauth,
    target,
    connect() {
      const started = oauth.start(target, actor, oauth.config(target).revision);
      const state = new URL(started.authorizationUrl).searchParams.get(
        "state",
      )!;
      const claim = oauth.claimFromState(actor, {
        state,
        code: "TEST-code",
        iss: "https://crm.example.test",
      });
      oauth.commitConnection(
        claim,
        {
          accessToken: "TEST-token",
          expiresAt: now() + 10 * 60 * 1000,
          identity: {
            userId: "TEST-crm-user",
            workspaceId: "TEST-crm-workspace",
            userWorkspaceId: "TEST-crm-membership",
          },
          scopes: ["api"],
        },
        actor,
        target,
      );
    },
  };
}

test("committed admission projects one original passive root across two reopens without native start or inference", () =>
  isolated(async (h, reopen) => {
    const receipt = admit(h);
    const projected = (await items(h))[0]!;
    assert.equal(projected.id, receipt.parentRunId);
    assert.equal(projected.native?.revision, 1);
    assert.equal(projected.native?.process?.startedAt, receipt.createdAt);
    assert.equal(projected.native?.process?.provenance.runId, receipt.runId);
    assert.equal(
      projected.native?.process?.provenance.commandId,
      receipt.commandId,
    );
    assert.equal(projected.native?.process?.provenance.actorId, scope.userId);
    assert.equal(projected.conversationId, receipt.origin.conversationId);
    assert.equal(projected.status, "running");
    assert.deepEqual(h.counts(), []);
    assert.deepEqual(h.models(), []);
    for (let i = 0; i < 2; i++) {
      h = await reopen();
      assert.deepEqual(await items(h), [projected]);
      assert.deepEqual(h.counts(), []);
      assert.deepEqual(h.models(), []);
    }
  }));

for (const language of ["en", "cs"] as const)
  test(`${language} separator-only canonical receipt titles cannot abort a passive task window`, () =>
    isolated(async (h) => {
      const { intent, command } = h.setup();
      const admission = h.starts.admit(
        admin,
        scope,
        intent.intentId,
        { ...command, language },
        () => {},
      );
      assert.equal(admission.status, "admitted");
      if (admission.status !== "admitted") throw Error("TEST admission");
      const service = h.catalog.service(scope.workspaceId, h.ids.serviceId);
      const cases = [
        { title: "-", status: "succeeded", effect: "read" },
        { title: "_", status: "unknown", effect: "write" },
        { title: "list-mail-messages", status: "failed", effect: "write" },
        { title: "Send proposal to Anna", status: "succeeded", effect: "read" },
      ] as const;
      const receipts = cases.map((value, index) => {
        const actionId = value.effect === "read" ? h.ids.readId : h.ids.writeId;
        const action = service.actions.find(
          (action) => action.id === actionId,
        )!;
        const pending = h.catalog.prepare(
          {
            organizationId: admin.organizationId,
            workspaceId: scope.workspaceId,
            serviceId: service.id,
            serviceRevision: service.revision,
            actionId,
            revision: action.revision,
            requestId: `TEST-${language}-receipt-${index}`,
            input: { name: "TEST synthetic receipt" },
            approve: false,
          },
          admin,
          h.context.epoch(admin.organizationId),
        );
        const receipt = {
          ...pending,
          ...value,
          completedAt: Date.now(),
          ...(value.status === "succeeded"
            ? { result: { value: "TEST recorded result" } }
            : {}),
        };
        h.catalog.saveInvocation(receipt);
        return receipt;
      });
      const journal = read(h, admission.parentRunId);
      journal.operations = receipts.map((receipt) => receipt.id);
      journal.receipts = receipts.map((receipt, index) => ({
        callId: `TEST-call-${index}`,
        operationId: receipt.id,
      }));
      h.catalog.saveTurn(
        admission.parentRunId,
        scope.workspaceId,
        scope.userId,
        journal,
      );
      const saved = JSON.parse(JSON.stringify({ journal, receipts }));
      const runtime = catalog(h);
      const window = await runtime.taskWindow!();
      assert(window.validate());
      assert.equal(window.items.length, 1);
      const work = window.items[0]!;
      assert.equal(work.id, admission.parentRunId);
      assert.equal(work.status, "waiting_system");
      assert.equal(work.native!.process!.detailsAvailable, true);
      assert.deepEqual(
        work.native!.process!.receipts.map((receipt) => [
          receipt.title,
          receipt.status,
          receipt.effect,
        ]),
        cases.map((value) => [value.title, value.status, value.effect]),
      );
      assert.deepEqual(
        work
          .card!.nodes.filter((node) => node.type === "section")
          .map((node) => node.title),
        [
          language === "cs" ? "Akce" : "Action",
          language === "cs" ? "Akce" : "Action",
          "List mail messages",
          "Send proposal to Anna",
        ],
      );
      assert.equal(work.native!.action, undefined);
      assert.equal(work.native!.question, undefined);
      assert.deepEqual((await runtime.taskWindow!()).items, window.items);
      assert.deepEqual(read(h, admission.parentRunId), saved.journal);
      assert.deepEqual(
        receipts.map((receipt) =>
          h.catalog.invocation(receipt.id, scope.workspaceId, scope.userId),
        ),
        saved.receipts,
      );
      assert.deepEqual(h.counts(), []);
      assert.deepEqual(h.models(), []);
    }));

test("read and pending write keep separate canonical receipts; Tasks and Loops share the pinned original provenance", () =>
  isolated(async (h) => {
    const receipt = admit(h, h.readWrite());
    const waiting = await h.runtime.start(
      receipt.processId,
      receipt.runId,
      receipt.input,
      signal(),
    );
    assert.equal(waiting.status, "waiting");
    const work = (await items(h))[0]!;
    assert.equal(work.status, "waiting_approval");
    assert.deepEqual(
      work.native?.process?.receipts.map((r) => [r.effect, r.status]),
      [
        ["read", "succeeded"],
        ["write", "awaiting_approval"],
      ],
    );
    assert.equal(work.native?.action, undefined);
    assert.equal(work.native?.question, undefined);
    const approval = work.native!.process!.approval!;
    assert(approval);
    assert.equal(approval.nodeId, waiting.approval!.nodeId);
    assert.equal(approval.result.operationId, waiting.approval!.operationId);
    assert.equal(
      approval.result.inputJson,
      JSON.stringify(
        h.catalog.invocation(
          approval.result.operationId,
          scope.workspaceId,
          scope.userId,
        )!.input,
      ),
    );
    assert.equal(approval.result.status, "awaiting_approval");
    assert.equal(approval.serviceId, h.ids.serviceId);
    assert.equal(approval.actionId, h.ids.writeId);
    assert(!("card" in approval.result));
    assert(work.card?.nodes.some((n) => n.type === "disclosure"));
    const loops = new LoopsStore(h.db, h.catalog);
    const loop = loops.detail(admin.organizationId, receipt.parentRunId)!.run;
    assert.deepEqual(loop.process, work.native!.process!.provenance);
    const runtime = catalog(h);
    await assert.rejects(
      runtime.openTask!(work.id, work.revision, work.conversationId, "cs"),
      code("process_command_required"),
    );
    assert.deepEqual(h.counts(), [["GET", 1]]);
    assert.deepEqual(
      (await runtime.tasks!()).map((w) => w.id),
      [receipt.parentRunId],
    );
  }));
test("native agent tool approval projects the original child call and receipt without replay", () =>
  isolated(async (h) => {
    const definition = processAgent(h);
    h.onModel(() => callProcessTool());
    const receipt = admit(h, definition);
    const waiting = await h.runtime.start(
      receipt.processId,
      receipt.runId,
      receipt.input,
      signal(),
    );
    assert(waiting.approval);
    const work = (await items(h))[0]!;
    assert.equal(work.native!.process!.approval?.nodeId, "agent");
    assert.equal(
      work.native!.process!.approval?.result.operationId,
      waiting.approval.operationId,
    );
    assert.equal(
      work.native!.process!.approval?.result.inputJson,
      '{"name":"TEST-input"}',
    );
    await items(h);
    assert.deepEqual(h.counts(), []);
    assert.equal(h.models().length, 1);
  }));
test("oversize parameters, altered pending identity and unsafe receipt labels fail closed without losing receipts", () =>
  isolated(async (h) => {
    const receipt = admit(h, h.readWrite());
    const waiting = await h.runtime.start(
      receipt.processId,
      receipt.runId,
      receipt.input,
      signal(),
    );
    assert(waiting.approval);
    const original = h.catalog.invocation(
      waiting.approval.operationId,
      scope.workspaceId,
      scope.userId,
    )!;
    for (const change of [
      { input: { name: "TEST".repeat(40000) }, expected: "parameters" },
      {
        input: null as unknown as typeof original.input,
        expected: "parameters",
      },
      {
        input: undefined as unknown as typeof original.input,
        expected: "parameters",
      },
      { title: "TEST\nchanged", expected: undefined },
      { serviceName: "TEST\u0000service", expected: undefined },
      { title: "TEST".repeat(40), expected: "parameters" },
      { title: "Bearer TEST-token", expected: "identity" },
    ] as const) {
      const { expected, ...value } = change;
      h.catalog.saveInvocation({ ...original, ...value });
      const work = (await items(h))[0]!;
      if (expected) assert.equal(work.native!.process!.approval, undefined);
      else assert(work.native!.process!.approval);
      assert.equal(work.native!.process!.approvalUnavailable, expected);
      assert.equal(
        work.native!.process!.receipts.at(-1)!.status,
        "awaiting_approval",
      );
      assert.equal(work.native!.revision, waiting.revision);
    }
    h.catalog.saveInvocation(original);
    const journal = read(h, receipt.parentRunId);
    assert(journal.pending && !("kind" in journal.pending));
    journal.pending.nodeId = "TEST-wrong-node";
    h.catalog.saveTurn(
      receipt.parentRunId,
      scope.workspaceId,
      scope.userId,
      journal,
    );
    assert.equal(
      (await items(h))[0]!.native!.process!.approvalUnavailable,
      "identity",
    );
    assert.deepEqual(h.counts(), [["GET", 1]]);
    assert.deepEqual(h.models(), []);
  }));
test("an earlier unknown write preserves the task and prevents the next approval from being bound", () =>
  isolated(async (h) => {
    const definition = h.readWrite();
    assert.equal(definition.kind, "workflow");
    if (definition.kind !== "workflow") throw Error("TEST workflow");
    const first = definition.steps[0]!;
    const second = definition.steps.find((node) => node.id === "write")!;
    assert.equal(first.type, "action");
    assert.equal(second.type, "action");
    if (first.type !== "action" || second.type !== "action")
      throw Error("TEST actions");
    second.input = first.input;
    first.actionId = h.ids.writeId;
    const admission = admit(h, definition);
    const a = await h.runtime.start(
      admission.processId,
      admission.runId,
      admission.input,
      signal(),
    );
    assert(a.approval);
    const b = await h.runtime.resume(
      admission.runId,
      { ...a.approval, approved: true },
      signal(),
    );
    assert(b.approval);
    assert((await items(h))[0]!.native!.process!.approval);
    const journal = read(h, admission.parentRunId);
    assert.deepEqual(journal.sources, []);
    const original = h.catalog.invocation(
      journal.operations[0]!,
      scope.workspaceId,
      scope.userId,
    )!;
    h.catalog.saveInvocation({ ...original, status: "unknown" });
    const work = (await items(h))[0]!;
    assert.equal(work.native!.process!.detailsAvailable, true);
    assert.equal(work.native!.process!.status, "unknown");
    assert.equal(work.status, "waiting_system");
    assert.equal(work.native!.process!.approval, undefined);
    assert.equal(work.native!.process!.approvalUnavailable, "identity");
    assert.deepEqual(
      work.native!.process!.receipts.map((receipt) => receipt.status),
      ["unknown", "awaiting_approval"],
    );
    assert.match(work.context, /Zápis již mohl proběhnout/);
    const coordinator = createProcessCoordinator(
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
        memoryObservation: () => h.memoryStore.version(h.memoryActor),
      },
    );
    await assert.rejects(
      coordinator.execute(
        {
          profile: "agent-process-execution/1",
          type: "service.resolve",
          commandId: "TEST-unknown-prior",
          idempotencyKey: "TEST-unknown-prior-key",
          conversationId: admission.origin.conversationId,
          workItemId: admission.parentRunId,
          expectedWorkRevision: b.revision,
          operationId: b.approval.operationId,
          approved: true,
          language: "en",
        },
        signal(),
        () => {},
      ),
      code("process_approval_conflict"),
    );
    assert.equal(
      h.db
        .prepare("SELECT count(*) AS count FROM agent_process_resolve_command")
        .get()!.count,
      0,
    );
    assert.deepEqual(h.counts(), [["POST", 1]]);
    assert.deepEqual(h.models(), []);
  }));
test("older strict process profiles remove canonical approval fields from snapshots and events", () =>
  isolated(async (h) => {
    const receipt = admit(h, h.readWrite());
    await h.runtime.start(
      receipt.processId,
      receipt.runId,
      receipt.input,
      signal(),
    );
    const work = (await items(h))[0]!;
    const engine = new FixtureEngine(
      scope.workspaceId,
      undefined,
      undefined,
      undefined,
      scope,
    );
    engine.syncNativeWork([work], true, true);
    const snapshot = snapshotWithoutProcessApprovals(engine.snapshot());
    const process = snapshot.workItems[0]!.native!.process!;
    assert(!("approval" in process));
    assert(!("approvalUnavailable" in process));
    const {
      approval: _approval,
      approvalUnavailable: _unavailable,
      ...oldShape
    } = ProcessWorkSchema.shape;
    const oldSchema = z.strictObject(oldShape);
    assert(oldSchema.safeParse(process).success);
    const event = eventsWithoutProcessApprovals(engine.events(0)!.events)[0]!;
    assert.equal(event.type, "work_item.upserted");
    if (event.type === "work_item.upserted")
      assert(oldSchema.safeParse(event.entity.native!.process).success);
    const review = work.native!.process!.approval!;
    assert(
      !ProcessApprovalSchema.safeParse({
        ...review,
        result: { ...review.result, inputJson: "TEST incomplete" },
      }).success,
    );
    assert(
      !ProcessApprovalSchema.safeParse({
        ...review,
        result: { ...review.result, card: work.card },
      }).success,
    );
    assert(
      !ProcessWorkSchema.safeParse({
        ...work.native!.process,
        approvalUnavailable: "parameters",
      }).success,
    );
  }));
test("receipt-only source dependencies and contact sources gate review and invalidate publication", () =>
  isolated(async (h) => {
    const receipt = admit(h, h.readWrite());
    const waiting = await h.runtime.start(
      receipt.processId,
      receipt.runId,
      receipt.input,
      signal(),
    );
    assert(waiting.approval);
    const journal = read(h, receipt.parentRunId);
    const source = journal.sources[0]!;
    journal.sources = [];
    h.catalog.saveTurn(
      receipt.parentRunId,
      scope.workspaceId,
      scope.userId,
      journal,
    );
    const pending = h.catalog.invocation(
      waiting.approval.operationId,
      scope.workspaceId,
      scope.userId,
    )!;
    const originalSource = h.catalog.invocation(
      source,
      scope.workspaceId,
      scope.userId,
    )!;
    for (const kind of ["dependencies", "contactSource"] as const) {
      h.catalog.saveInvocation({
        ...pending,
        dependencies: kind === "dependencies" ? [source] : [],
        contactSource: kind === "contactSource" ? source : undefined,
      });
      h.catalog.saveInvocation(originalSource);
      const runtime = catalog(h);
      const window = await runtime.taskWindow!();
      assert(window.items[0]!.native!.process!.approval);
      h.catalog.saveInvocation({
        ...originalSource,
        completedAt: Date.now() - CONTACT_CONTEXT_TTL - 1,
      });
      assert.equal(window.validate(), false);
      const unavailable = (await items(h))[0]!.native!.process!;
      assert.equal(unavailable.detailsAvailable, false);
      assert.equal(unavailable.approvalUnavailable, "context");
      assert.equal(unavailable.approval, undefined);
    }
    assert.deepEqual(h.counts(), [["GET", 1]]);
  }));
test("new decisions validate queue-using Memory and its current generation before durable binding", () =>
  isolated(async (h) => {
    const receipt = admit(h, h.readWrite());
    const waiting = await h.runtime.start(
      receipt.processId,
      receipt.runId,
      receipt.input,
      signal(),
    );
    assert(waiting.approval);
    const journal = read(h, receipt.parentRunId);
    journal.agents = {
      TEST: {
        runId: "TEST-child",
        threadId: "TEST-thread",
        inputDigest: "TEST-input",
        decisions: [],
        memoryVersion: 0,
      },
    } as typeof journal.agents;
    h.catalog.saveTurn(
      receipt.parentRunId,
      scope.workspaceId,
      scope.userId,
      JournalSchema.parse(journal),
    );
    const resolves = new ProcessResolveStore(h.db, h.starts);
    let generation = 0;
    const coordinator = createProcessCoordinator(
      h.controller,
      h.registry,
      h.starts,
      resolves,
      h.context,
      scope,
      admin.organizationId,
      new NativeCommandRequests(),
      {
        memory: {
          context: h.memory.context,
          validate: async () => {
            await h.context.serial(async () => {
              generation++;
            });
          },
        },
        memoryObservation: () => generation,
      },
    );
    const command = {
      profile: "agent-process-execution/1",
      type: "service.resolve",
      commandId: "TEST-memory-review",
      idempotencyKey: "TEST-memory-review-key",
      conversationId: receipt.origin.conversationId,
      workItemId: receipt.parentRunId,
      expectedWorkRevision: waiting.revision,
      operationId: waiting.approval.operationId,
      approved: true,
      language: "en",
    };
    await assert.rejects(
      coordinator.execute(command, signal(), () => {}),
      code("process_approval_conflict"),
    );
    assert.equal(
      h.db
        .prepare("SELECT count(*) AS count FROM agent_process_resolve_command")
        .get()!.count,
      0,
    );
    assert.deepEqual(h.counts(), [["GET", 1]]);
    const denying = createProcessCoordinator(
      h.controller,
      h.registry,
      h.starts,
      resolves,
      h.context,
      scope,
      admin.organizationId,
      new NativeCommandRequests(),
      {
        memory: {
          context: h.memory.context,
          validate: async () => {
            await h.context.serial(async () => {
              throw new IdentityError(409, "memory_context_changed");
            });
          },
        },
      },
    );
    await assert.rejects(
      denying.execute(
        {
          ...command,
          commandId: "TEST-denied-review",
          idempotencyKey: "TEST-denied-review-key",
        },
        signal(),
        () => {},
      ),
      code("memory_context_changed"),
    );
    assert.equal(
      h.db
        .prepare("SELECT count(*) AS count FROM agent_process_resolve_command")
        .get()!.count,
      0,
    );
  }));
for (const denial of [
  "private",
  "source",
  "oauth",
  "policy",
  "parameters",
] as const)
  test(`${denial} change rejects a new approval before recording its durable decision`, () =>
    isolated(async (h) => {
      const personal =
        denial === "oauth" ? personalOAuth(h, Date.now) : undefined;
      personal?.connect();
      const receipt = admit(h, h.readWrite());
      const waiting = await h.runtime.start(
        receipt.processId,
        receipt.runId,
        receipt.input,
        signal(),
      );
      assert(waiting.approval);
      assert((await items(h))[0]!.native!.process!.approval);
      if (denial === "private") h.denyRead();
      if (denial === "source") {
        const source = read(h, receipt.parentRunId).sources[0]!;
        const original = h.catalog.invocation(
          source,
          scope.workspaceId,
          scope.userId,
        )!;
        h.catalog.saveInvocation({
          ...original,
          completedAt: Date.now() - CONTACT_CONTEXT_TTL - 1,
        });
      }
      if (denial === "oauth") personal!.connect();
      if (denial === "policy") h.context.change(admin.organizationId);
      if (denial === "parameters") {
        const original = h.catalog.invocation(
          waiting.approval.operationId,
          scope.workspaceId,
          scope.userId,
        )!;
        h.catalog.saveInvocation({
          ...original,
          input: { name: "TEST".repeat(40000) },
        });
      }
      const resolves = new ProcessResolveStore(h.db, h.starts);
      const coordinator = createProcessCoordinator(
        h.controller,
        h.registry,
        h.starts,
        resolves,
        h.context,
        scope,
        admin.organizationId,
        new NativeCommandRequests(),
        {
          memory: h.memory,
          memoryObservation: () => h.memoryStore.version(h.memoryActor),
        },
      );
      await assert.rejects(
        coordinator.execute(
          {
            profile: "agent-process-execution/1",
            type: "service.resolve",
            commandId: `TEST-${denial}-denial`,
            idempotencyKey: `TEST-${denial}-denial-key`,
            conversationId: receipt.origin.conversationId,
            workItemId: receipt.parentRunId,
            expectedWorkRevision: waiting.revision,
            operationId: waiting.approval.operationId,
            approved: true,
            language: "en",
          },
          signal(),
          () => {},
        ),
        (error: unknown) => error instanceof IdentityError,
      );
      assert.equal(
        h.db
          .prepare(
            "SELECT count(*) AS count FROM agent_process_resolve_command",
          )
          .get()!.count,
        0,
      );
      assert.deepEqual(h.counts(), [["GET", 1]]);
      assert.deepEqual(h.models(), []);
    }));
test("a succeeded write survives failed output validation and is never reclassified as a failed effect", () =>
  isolated(async (h) => {
    const receipt = admit(h, h.readWrite());
    const waiting = await h.runtime.start(
      receipt.processId,
      receipt.runId,
      receipt.input,
      signal(),
    );
    assert(waiting.approval);
    h.setMode("bad_output");
    const failed = await h.runtime.resume(
      receipt.runId,
      { ...waiting.approval, approved: true },
      signal(),
    );
    assert.equal(failed.status, "failed");
    const work = (await items(h))[0]!;
    assert.equal(work.status, "failed");
    assert.deepEqual(
      work.native!.process!.receipts.map((r) => [r.effect, r.status]),
      [
        ["read", "succeeded"],
        ["write", "succeeded"],
      ],
    );
    assert.match(work.context, /Dřívější zápis se podařil/);
    assert.match(work.context, /Kód chyby/);
    assert(
      !work.card!.nodes.some(
        (n) => n.type === "disclosure" && n.label === "Výstup procesu",
      ),
    );
    assert.deepEqual(h.counts(), [
      ["GET", 1],
      ["POST", 1],
    ]);
    await items(h);
    await items(h);
    assert.deepEqual(h.counts(), [
      ["GET", 1],
      ["POST", 1],
    ]);
  }));
test("unknown writes remain visible with completed receipts and safe guidance across two reopens; rejected approvals stay cancelled", () =>
  isolated(async (h, reopen) => {
    const receipt = admit(h, h.readWrite());
    const waiting = await h.runtime.start(
      receipt.processId,
      receipt.runId,
      receipt.input,
      signal(),
    );
    assert(waiting.approval);
    h.setMode("unknown");
    assert.equal(
      (
        await h.runtime.resume(
          receipt.runId,
          { ...waiting.approval, approved: true },
          signal(),
        )
      ).status,
      "unknown",
    );
    const work = (await items(h))[0]!;
    assert.equal(work.status, "waiting_system");
    assert.equal(work.native!.process!.status, "unknown");
    assert.match(work.context, /Zápis již mohl proběhnout/);
    assert.deepEqual(
      work.native!.process!.receipts.map((r) => r.status),
      ["succeeded", "unknown"],
    );
    for (let i = 0; i < 2; i++) {
      h = await reopen();
      assert.deepEqual(await items(h), [work]);
      assert.deepEqual(h.counts(), [
        ["GET", 1],
        ["POST", 1],
      ]);
    }
  }));
test("declined process stays in Done and chat alongside its earlier successful read", () =>
  isolated(async (h) => {
    const receipt = admit(h, h.readWrite());
    const waiting = await h.runtime.start(
      receipt.processId,
      receipt.runId,
      receipt.input,
      signal(),
    );
    assert(waiting.approval);
    await h.runtime.resume(
      receipt.runId,
      { ...waiting.approval, approved: false },
      signal(),
    );
    const work = (await items(h))[0]!;
    assert.equal(work.status, "cancelled");
    assert.deepEqual(
      work.native!.process!.receipts.map((r) => r.status),
      ["succeeded", "rejected"],
    );
    const engine = new FixtureEngine(
      scope.workspaceId,
      undefined,
      undefined,
      undefined,
      scope,
    );
    engine.syncNativeWork([work], true, true);
    const snapshot = engine.snapshot();
    const state = fromSnapshot("TEST", scope, snapshot);
    assert.deepEqual(
      selectTasks(state, "allTasks").map((w) => w.id),
      [work.id],
    );
    assert.deepEqual(
      selectTasks(state, "completed").map((w) => w.id),
      [work.id],
    );
    const anchors = selectWorkMessageAnchors(state, work.conversationId, [
      {
        id: "TEST-anchor",
        role: "assistant",
        text: "TEST original request",
        workItemId: work.id,
      },
    ]);
    assert.equal(anchors.get(work.id), "TEST-anchor");
    assert.deepEqual(snapshot.workItems[0]!.card, work.card);
    assert.equal(snapshotWithoutCards(snapshot).workItems[0]!.card, undefined);
    const legacy = snapshotWithoutProcessWork(snapshot).workItems[0]!;
    assert.equal(legacy.native?.process, undefined);
    assert.equal(legacy.card, undefined);
    assert.equal(legacy.context, work.context);
    const event = engine.events(0)!.events[0]!;
    assert.equal(
      eventsWithoutProcessWork([event])[0]!.type,
      "work_item.upserted",
    );
    assert.deepEqual(h.counts(), [["GET", 1]]);
  }));
test("current private read denial removes a process from public projection; auth denial remains an error", () =>
  isolated(async (h) => {
    const receipt = admit(h);
    await h.runtime.start(
      receipt.processId,
      receipt.runId,
      receipt.input,
      signal(),
    );
    assert.equal((await items(h)).length, 1);
    h.denyRead();
    assert.deepEqual(await items(h), []);
    h.switchActor();
    await assert.rejects(projector(h).roots(), code("identity_forbidden"));
    assert.deepEqual(h.counts(), [["GET", 1]]);
  }));
test("startup interruption and canonical unknown receipts override a still-running journal in the passive projection", () =>
  isolated(async (h, reopen) => {
    const receipt = admit(h, h.readWrite());
    await h.runtime.start(
      receipt.processId,
      receipt.runId,
      receipt.input,
      signal(),
    );
    const journal = read(h, receipt.parentRunId);
    assert(journal.pending && !("kind" in journal.pending));
    const write = journal.pending.operationId;
    h.catalog.saveInvocation({
      ...h.catalog.invocation(write, scope.workspaceId, scope.userId)!,
      status: "running",
    });
    journal.status = "running";
    journal.trace.status = "running";
    h.catalog.saveTurn(
      receipt.parentRunId,
      scope.workspaceId,
      scope.userId,
      journal,
    );
    h = await reopen();
    new LoopsStore(h.db, h.catalog);
    const work = (await items(h))[0]!;
    assert.equal(work.status, "waiting_system");
    assert.equal(work.native!.process!.journalStatus, "running");
    assert.equal(work.native!.process!.status, "unknown");
    assert.match(work.context, /Zápis již mohl proběhnout/);
    assert.deepEqual(
      work.native!.process!.receipts.map((r) => r.status),
      ["succeeded", "unknown"],
    );
    assert.deepEqual(h.counts(), [["GET", 1]]);
    const original = h.catalog.invocation(
      write,
      scope.workspaceId,
      scope.userId,
    )!;
    h.catalog.saveInvocation({ ...original, status: "succeeded" });
    const interrupted = (await items(h))[0]!;
    assert.equal(interrupted.native!.process!.status, "interrupted");
    assert.match(interrupted.context, /Dokončení není potvrzené/);
    assert.deepEqual(h.counts(), [["GET", 1]]);
  }));
test("receipt-only changes advance outer event revision, unchanged sync is silent, and old events cannot restore prior state", () =>
  isolated(async (h) => {
    const receipt = admit(h, h.readWrite());
    await h.runtime.start(
      receipt.processId,
      receipt.runId,
      receipt.input,
      signal(),
    );
    const engine = new FixtureEngine(
      scope.workspaceId,
      undefined,
      undefined,
      undefined,
      scope,
    );
    const original = (await items(h))[0]!;
    engine.syncNativeWork([original], true, true);
    const first = engine.snapshot();
    const old = engine.events(0)!.events[0]!;
    const write = original.native!.process!.receipts.find(
      (r) => r.effect === "write",
    )!;
    h.catalog.saveInvocation({
      ...h.catalog.invocation(
        write.operationId,
        scope.workspaceId,
        scope.userId,
      )!,
      status: "unknown",
    });
    const advanced = (await items(h))[0]!;
    assert.equal(advanced.native!.revision, original.native!.revision);
    engine.syncNativeWork([advanced], true, true);
    assert.equal(
      engine.snapshot().workItems[0]!.revision,
      first.workItems[0]!.revision + 1,
    );
    const cursor = engine.snapshot().cursor;
    engine.syncNativeWork(await items(h), true, true);
    assert.equal(engine.snapshot().cursor, cursor);
    const { applyEvent } = await import("../packages/client-core/store");
    const current = fromSnapshot("TEST", scope, engine.snapshot());
    assert.deepEqual(applyEvent(current, "TEST", old), current);
  }));
test("stale task window rejects new roots, receipt-only advancement and expiry before publication", () =>
  isolated(async (h) => {
    const receipt = admit(h);
    await h.runtime.start(
      receipt.processId,
      receipt.runId,
      receipt.input,
      signal(),
    );
    const runtime = catalog(h);
    const window = await runtime.taskWindow!();
    assert(window.validate());
    const operation = window.items[0]!.native!.process!.receipts[0]!;
    const canonical = h.catalog.invocation(
      operation.operationId,
      scope.workspaceId,
      scope.userId,
    )!;
    h.catalog.saveInvocation({ ...canonical, result: { value: "TEST newer" } });
    assert.equal(window.validate(), false);
    const next = await runtime.taskWindow!();
    assert(next.validate());
    const originalNow = Date.now;
    const now = originalNow();
    try {
      Date.now = () => now + CONTACT_CONTEXT_TTL + 1;
      assert.equal(next.validate(), false);
      const expired = (await items(h))[0]!;
      assert.equal(expired.native!.process!.detailsAvailable, false);
      assert(!JSON.stringify(expired.card).includes("TEST newer"));
    } finally {
      Date.now = originalNow;
    }
    const stable = await runtime.taskWindow!();
    const definition = ProcessDefinitionSchema.parse({
      ...h.basic(),
      name: "TEST new process",
    });
    const id = h.activate(definition);
    const intent = h.issue(id, "TEST-new-root");
    const command = h.starts.forParent(
      admin,
      scope,
      receipt.parentRunId,
    ).command;
    h.starts.admit(
      admin,
      scope,
      intent.intentId,
      {
        ...command,
        intentId: intent.intentId,
        commandId: "TEST-new-root",
        idempotencyKey: "TEST-new-root-key",
      },
      () => {},
    );
    assert.equal(stable.validate(), false);
  }));
test("publication rejects OAuth expiry and connection replacement without a policy epoch change or repeated effects", () =>
  isolated(async (h) => {
    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => now;
    try {
      const { oauth, target, connect } = personalOAuth(h, () => now);
      connect();
      const receipt = admit(h);
      await h.runtime.start(
        receipt.processId,
        receipt.runId,
        receipt.input,
        signal(),
      );
      const runtime = catalog(h);
      const epoch = h.context.epoch(admin.organizationId);
      const window = await runtime.taskWindow!();
      assert.equal(window.items[0]!.native!.process!.detailsAvailable, true);
      assert(JSON.stringify(window.items[0]!.card).includes("TEST-result"));
      assert(window.validate());
      now += 9 * 60 * 1000 + 31_000;
      assert.equal(
        oauth.status(target, scope.userId).connection.status,
        "expired",
      );
      assert.equal(h.context.epoch(admin.organizationId), epoch);
      assert.equal(window.validate(), false);
      const expired = await runtime.taskWindow!();
      assert(expired.validate());
      assert.equal(expired.items[0]!.native!.process!.detailsAvailable, false);
      assert.equal(
        expired.items[0]!.native!.process!.receipts[0]!.status,
        "succeeded",
      );
      assert(!JSON.stringify(expired.items[0]!.card).includes("TEST-result"));

      now -= 9 * 60 * 1000 + 31_000;
      const beforeReconnect = await runtime.taskWindow!();
      assert(beforeReconnect.validate());
      connect();
      assert.equal(h.context.epoch(admin.organizationId), epoch);
      assert.equal(beforeReconnect.validate(), false);
      const replaced = await runtime.taskWindow!();
      assert(replaced.validate());
      assert.equal(replaced.items[0]!.native!.process!.detailsAvailable, false);
      assert.equal(
        replaced.items[0]!.native!.process!.receipts[0]!.status,
        "succeeded",
      );
      assert(!JSON.stringify(replaced.items[0]!.card).includes("TEST-result"));
      assert.deepEqual(h.counts(), [["GET", 1]]);
      assert.deepEqual(h.models(), []);
    } finally {
      Date.now = originalNow;
    }
  }));
test("saved-memory source receipt and OAuth changes invalidate a window even when the process has no direct operations", () =>
  isolated(async (h) => {
    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => now;
    try {
      const { oauth, target, connect } = personalOAuth(h, () => now);
      connect();
      const internal = h.activate(h.basic());
      await h.runtime.start(
        internal,
        "TEST-memory-source",
        { name: "TEST input" },
        signal(),
      );
      const row = h.db
        .prepare(
          "SELECT data FROM agent_service_turn WHERE json_extract(data,'$.kind')='service-process-1'",
        )
        .get()!;
      const source = JournalSchema.parse(JSON.parse(String(row.data)))
        .operations[0]!;
      await h.memoryStore.remember(h.memoryActor, {
        requestId: "TEST-memory",
        content: "TEST input verified fact",
        kind: "fact",
        scope: "private",
        source: {
          type: "verified_operation",
          operationId: source,
          serviceId: h.ids.serviceId,
          verifiedAt: new Date(now).toISOString(),
        },
        explicitIntent: true,
        settings: h.memorySettings,
      });
      const receipt = admit(h, processAgent(h, "saved"));
      await h.runtime.start(
        receipt.processId,
        receipt.runId,
        receipt.input,
        signal(),
      );
      const memory = createMemoryRuntime(
        h.memoryStore,
        h.memoryActor,
        h.memorySettings,
        {
          read: (fn) => h.context.serial(async () => fn()),
          mutate: async () => {
            throw Error("TEST projection cannot mutate memory");
          },
          check: () => {},
          sourceAccess: (source, actor) => {
            if (source.type !== "verified_operation") return true;
            try {
              return (
                h.catalog.contactSource(
                  source.operationId,
                  actor.organizationId,
                  actor.workspaceId,
                  { userId: actor.userId, role: "member" },
                  CONTACT_CONTEXT_TTL,
                ).serviceId === source.serviceId
              );
            } catch {
              return false;
            }
          },
        },
      );
      const projection = createProcessTaskProjection(
        h.controller,
        h.registry,
        h.starts,
        h.context,
        scope,
        admin.organizationId,
        memory,
        () => h.memoryStore.version(h.memoryActor),
      );
      const runtime = createCatalogRuntime(
        h.controller,
        h.controller.transport,
        h.context,
        scope,
        admin.organizationId,
        false,
        false,
        undefined,
        memory,
        undefined,
        projection,
      );
      const journal = read(h, receipt.parentRunId);
      assert.deepEqual(journal.operations, []);
      assert.deepEqual(journal.sources, []);
      assert.equal(
        Object.values(journal.agents)[0]!.memoryMetadata!.sources!.length,
        1,
      );
      const window = await runtime.taskWindow!();
      assert.equal(window.items.length, 1);
      assert(window.validate());
      assert.equal(window.items[0]!.native!.process!.detailsAvailable, true);
      assert(
        JSON.stringify(window.items[0]!.card).includes("TEST-model-result"),
      );
      const epoch = h.context.epoch(admin.organizationId);
      now += 9 * 60 * 1000 + 31_000;
      assert.equal(
        oauth.status(target, scope.userId).connection.status,
        "expired",
      );
      assert.equal(h.context.epoch(admin.organizationId), epoch);
      assert.equal(window.validate(), false);
      const fresh = await runtime.taskWindow!();
      assert(fresh.validate());
      assert.equal(fresh.items[0]!.native!.process!.detailsAvailable, false);
      assert(
        !JSON.stringify(fresh.items[0]!.card).includes("TEST-model-result"),
      );
      now -= 9 * 60 * 1000 + 31_000;
      const beforeReconnect = await runtime.taskWindow!();
      connect();
      assert.equal(beforeReconnect.validate(), false);
      assert.equal(
        (await runtime.taskWindow!()).items[0]!.native!.process!
          .detailsAvailable,
        false,
      );

      const beforeReceipt = await runtime.taskWindow!();
      const canonical = h.catalog.invocation(
        source,
        scope.workspaceId,
        scope.userId,
      )!;
      h.catalog.saveInvocation({
        ...canonical,
        result: { value: "TEST changed memory source" },
      });
      assert.equal(beforeReceipt.validate(), false);
      const beforeExpiry = await runtime.taskWindow!();
      now += CONTACT_CONTEXT_TTL + 1;
      assert.equal(beforeExpiry.validate(), false);
      assert.deepEqual(h.counts(), [["GET", 1]]);
      assert.equal(h.models().length, 1);
    } finally {
      Date.now = originalNow;
    }
  }));
test("one bounded mixed selector prioritizes waiting processes, filters aliases/non-task chat and excludes internal/foreign admission scopes", () =>
  isolated(async (h) => {
    const receipt = admit(h, h.readWrite());
    await h.runtime.start(
      receipt.processId,
      receipt.runId,
      receipt.input,
      signal(),
    );
    await h.runtime.start(
      receipt.processId,
      "TEST-internal-run",
      receipt.input,
      signal(),
    );
    for (let i = 0; i < 420; i++) {
      const id = createHash("sha256").update(`TEST-root-${i}`).digest("hex");
      h.catalog.saveTurn(id, scope.workspaceId, scope.userId, {
        kind: "mastra-1",
        runId: id,
        conversationId: "conversation-1",
        taskTracked: true,
        operations: [],
        revision: 1,
      });
      h.catalog.saveTurn(`TEST-alias-${i}`, scope.workspaceId, scope.userId, {
        kind: "mastra-1",
        runId: id,
        taskTracked: true,
        pending: {},
      });
      h.catalog.saveTurn(
        createHash("sha256").update(`TEST-not-task-${i}`).digest("hex"),
        scope.workspaceId,
        scope.userId,
        {
          kind: "mastra-1",
          runId: createHash("sha256")
            .update(`TEST-not-task-${i}`)
            .digest("hex"),
          conversationId: "conversation-1",
          taskTracked: false,
          operations: [],
        },
      );
    }
    const roots = h.catalog.taskRoots(scope, admin.organizationId);
    assert.equal(roots.length, 400);
    assert.equal(roots[0]!.id, receipt.parentRunId);
    assert.equal(new Set(roots.map((r) => r.id)).size, 400);
    assert.equal(roots.filter((r) => r.kind === "service-process-1").length, 1);
    assert(!roots.some((r) => r.id.startsWith("TEST-")));
    assert.equal(
      h.catalog
        .taskRoots(
          { ...scope, connectionId: "TEST-foreign" },
          admin.organizationId,
        )
        .filter((r) => r.kind === "service-process-1").length,
      0,
    );
    const loops = new LoopsStore(h.db, h.catalog);
    assert.equal(loops.detail(admin.organizationId, "TEST-alias-419"), null);
    assert(
      loops
        .page({ organizationId: admin.organizationId })
        .entries.every((r) => !r.id.startsWith("TEST-")),
    );
  }));
