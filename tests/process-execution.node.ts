import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProcessDefinitionSchema,
  ProcessDataSchema,
  processValueSchema,
} from "../packages/protocol/service-processes";
import {
  PROCESS_START_PROFILE,
  ProcessStartCommandSchema,
  ProcessStartInputSchema,
} from "../packages/protocol/process-start";
import {
  ProcessInputCardSchema,
  ProcessInputRequestSchema,
} from "../packages/protocol/process-execution";
import { prepareProcessInput } from "../apps/server-identity/process-input";
import { ServiceOAuthStore } from "../apps/server-identity/service-oauth";
import { AuthProviderStore } from "../apps/server-identity/auth-providers";
import { ServiceCatalogStore } from "../apps/server-identity/service-catalog";
import {
  MIN_INPUT_ALLOWANCE,
  tariffMicros,
} from "../apps/server-identity/inference-budget";
import { startFixture } from "./helpers/process-start";
import { admin, scope, target, code } from "./helpers/service-process-runtime";
import { processObject } from "./helpers/service-process";
import { meetingRecordFixture } from "../packages/test-fixtures/meeting";
import { MeetingRecordSchema } from "../packages/protocol/meeting-record";
import { assertMeetingProcessOrigin } from "../apps/server-identity/meeting-process-origin";
import { IdentityError } from "../apps/server-identity/error";

async function isolated(
  run: (h: ReturnType<typeof startFixture>, path: string) => void,
) {
  const root = mkdtempSync(join(tmpdir(), "niaro-execution-")),
    path = join(root, "identity.sqlite");
  const h = startFixture(path);
  try {
    run(h, path);
  } finally {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  }
}
const member = { ...admin, role: "member" as const };
function executionRows(h: ReturnType<typeof startFixture>) {
  return [
    "agent_service_process_run",
    "agent_process_start_command",
    "agent_service_turn",
    "agent_service_invocation",
    "agent_inference_run",
  ].map((table) =>
    Number(h.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n),
  );
}
function request(
  h: ReturnType<typeof startFixture>,
  id: string,
  requestId = "TEST-form",
) {
  const v = h.registry.version(admin, id, 1);
  return {
    processId: id,
    version: v.version,
    artifactDigest: v.digest,
    language: "cs" as const,
    origin: {
      type: "command" as const,
      conversationId: "conversation-1",
      requestId,
    },
  };
}
function change(
  h: ReturnType<typeof startFixture>,
  id: string,
  values: object,
  bump = true,
) {
  const row = h.db
    .prepare("SELECT data FROM agent_catalog WHERE id=?")
    .get(id)!;
  h.db
    .prepare("UPDATE agent_catalog SET data=?,revision=revision+? WHERE id=?")
    .run(
      JSON.stringify({ ...JSON.parse(String(row.data)), ...values }),
      bump ? 1 : 0,
      id,
    );
}
function assertPassive(h: ReturnType<typeof startFixture>, path: string) {
  assert.deepEqual(executionRows(h), [0, 0, 0, 0, 0]);
  assert.deepEqual(h.counts(), []);
  assert.deepEqual(h.models(), []);
  assert.equal(existsSync(path + ".mastra.sqlite"), false);
}

test("execution users see active v1 without draft/creator reports and all reads are passive", () =>
  isolated((h, path) => {
    const id = h.activate(h.basic());
    const current = h.registry.get(admin, id);
    h.registry.saveDraft(admin, {
      id,
      serviceId: h.ids!.serviceId,
      revision: current.revision,
      definition: {
        ...current.draft,
        name: "TEST-private-draft",
        description: "TEST-private-prompt",
      },
    });
    for (const role of ["owner", "admin", "member"] as const) {
      const inventory = h.registry.executionInventory(
        { ...admin, role },
        scope,
      );
      assert.equal(inventory.processes.length, 1);
      const entry = inventory.processes[0]!;
      assert.equal(entry.name, "TEST lookup");
      assert.equal(entry.version, 1);
      assert.equal(entry.availability, "ready");
      const serialized = JSON.stringify(inventory);
      for (const secret of [
        "TEST-private",
        "createdBy",
        "testStatus",
        "reportDigest",
        "sources",
        "steps",
        "instructions",
        "draft",
      ])
        assert.equal(serialized.includes(secret), false, secret);
      assert.equal(
        h.registry.executionInventory({ ...admin, role }, scope).fingerprint,
        inventory.fingerprint,
      );
    }
    assertPassive(h, path);
  }));

test("owner/admin execution never bypasses explicit user/action and service-access denial", () =>
  isolated((h, path) => {
    h.activate(h.basic());
    change(h, h.ids!.readId, {
      policy: {
        roles: ["owner", "admin", "member"],
        users: [{ userId: scope.userId, access: "deny" }],
      },
    });
    for (const role of ["owner", "admin", "member"] as const)
      assert.deepEqual(
        h.registry.executionInventory({ ...admin, role }, scope).processes,
        [],
      );
    change(h, h.ids!.readId, {
      policy: { roles: ["owner", "admin", "member"], users: [] },
    });
    change(h, h.ids!.serviceId, { access: { roles: [], workspaceRoles: [] } });
    for (const role of ["owner", "admin", "member"] as const)
      assert.deepEqual(
        h.registry.executionInventory({ ...admin, role }, scope).processes,
        [],
      );
    assertPassive(h, path);
  }));

test("workspace role permission is current, and private dependency metadata is omitted", () =>
  isolated((h, path) => {
    const id = h.activate(h.basic());
    h.db
      .prepare("INSERT INTO agent_workspace_role VALUES (?,?,1,?)")
      .run("TEST-reader", target.workspaceId, "TEST reader");
    h.db
      .prepare("INSERT INTO agent_workspace_role_member VALUES (?,?)")
      .run("TEST-reader", "TEST-member");
    change(
      h,
      h.ids!.serviceId,
      { access: { roles: [], workspaceRoles: ["TEST-reader"] } },
      false,
    );
    change(
      h,
      h.ids!.readId,
      { policy: { roles: [], users: [], workspaceRoles: ["TEST-reader"] } },
      false,
    );
    assert.equal(
      h.registry.executionInventory(member, scope).processes[0]?.availability,
      "ready",
    );
    h.db.prepare("DELETE FROM agent_workspace_role_member").run();
    assert.deepEqual(
      h.registry.executionInventory(member, scope).processes,
      [],
    );
    assert.throws(
      () => h.registry.executionArtifact(member, id, request(h, id)),
      code("process_not_found"),
    );
    assertPassive(h, path);
  }));

test("paused service/action expose only safe blocked reason; deleted/revoked action reveals no process", () =>
  isolated((h, path) => {
    const id = h.activate(h.basic());
    change(h, h.ids!.serviceId, { enabled: false });
    const blocked = h.registry.executionInventory(member, scope).processes[0]!;
    assert.equal(blocked.availability, "blocked");
    if (blocked.availability !== "blocked") throw Error("TEST blocked");
    assert.equal(blocked.reason, "service_unavailable");
    assert.equal("inputSchema" in blocked, false);
    assert.throws(
      () =>
        prepareProcessInput(h.registry, h.starts, admin, scope, request(h, id)),
      code("process_execution_unavailable"),
    );
    change(h, h.ids!.serviceId, { enabled: true });
    change(h, h.ids!.readId, { enabled: false });
    assert.equal(
      h.registry.executionInventory(member, scope).processes[0]?.availability,
      "blocked",
    );
    h.db.prepare("DELETE FROM agent_catalog WHERE id=?").run(h.ids!.readId);
    assert.deepEqual(
      h.registry.executionInventory(member, scope).processes,
      [],
    );
    assertPassive(h, path);
  }));

test("cross-user scope and foreign workspace/org are never accepted from request metadata", () =>
  isolated((h, path) => {
    h.activate(h.basic());
    assert.throws(
      () =>
        h.registry.executionInventory(member, {
          ...scope,
          userId: "TEST-other",
        }),
      code("identity_forbidden"),
    );
    assert.throws(
      () =>
        h.registry.executionInventory(
          { ...member, organizationId: "TEST-other-org" },
          scope,
        ),
      code("process_not_found"),
    );
    assert.throws(
      () =>
        h.registry.executionInventory(
          { ...member, workspaceId: "TEST-other-workspace" },
          scope,
        ),
      code("process_not_found"),
    );
    assert.equal(
      ProcessInputRequestSchema.safeParse({
        ...request(h, h.registry.list(admin).processes[0]!.id),
        userId: "TEST-other",
      }).success,
      false,
    );
    assertPassive(h, path);
  }));

test("source revisions never advertise ready", () =>
  isolated((h, path) => {
    const id = h.activate(h.basic());
    // Management lists flag only a process a new test would unblock.
    assert.equal(h.registry.list(admin).processes[0]!.retestNeeded, undefined);
    change(h, h.ids!.readId, { name: "TEST changed metadata" });
    const entry = h.registry.executionInventory(member, scope).processes[0]!;
    assert.equal(entry.availability, "blocked");
    if (entry.availability === "blocked")
      assert.equal(entry.reason, "source_changed");
    assert.equal(h.registry.list(admin).processes[0]!.retestNeeded, true);
    assert.equal(h.registry.listOwned(admin).processes[0]!.retestNeeded, true);
    const before = request(h, id);
    assert.throws(
      () => prepareProcessInput(h.registry, h.starts, admin, scope, before),
      code("process_execution_unavailable"),
    );
    assertPassive(h, path);
  }));

test("literal enums, nested objects/arrays and empty/optional/null remain typed form metadata", () =>
  isolated((h, path) => {
    const schema = processObject(
      {
        name: { type: "string" },
        optional: { type: "string" },
        nullish: { type: "null" },
        enabled: { type: "boolean", enum: [false] },
        choice: { type: "string", enum: ["", "hello world", "🟢"] },
        nested: processObject({
          items: {
            type: "array",
            maxItems: 100,
            items: processObject({
              text: { type: "string" },
              count: { type: "integer", minimum: 0, maximum: 9 },
            }),
          },
        }),
        empty: processObject(),
        matrix: {
          type: "array",
          items: { type: "array", items: { type: "null" } },
        },
      },
      ["name", "nullish", "enabled", "choice", "nested", "empty", "matrix"],
    );
    const id = h.activate(
      ProcessDefinitionSchema.parse({ ...h.basic(), inputSchema: schema }),
    );
    const card = prepareProcessInput(
      h.registry,
      h.starts,
      admin,
      scope,
      request(h, id),
    );
    assert.deepEqual(card.form.inputSchema, schema);
    assert.deepEqual(card.intent.fields, {});
    const input = {
      name: " ",
      nullish: null,
      enabled: false,
      choice: "hello world",
      nested: { items: [{ text: "", count: 0 }] },
      empty: {},
      matrix: [[null], []],
    };
    assert.deepEqual(
      ProcessStartInputSchema.parse(
        processValueSchema(card.form.inputSchema).parse(input),
      ),
      input,
    );
    assert.equal("optional" in input, false);
    assert.equal(
      ProcessInputCardSchema.safeParse({ ...card, formDigest: "f".repeat(64) })
        .success,
      false,
    );
    assert.equal(
      ProcessInputCardSchema.safeParse({
        ...card,
        form: { ...card.form, version: 2 },
      }).success,
      false,
    );
    assert.equal(
      ProcessInputCardSchema.safeParse({
        ...card,
        intent: { ...card.intent, inputSchema: processObject() },
      }).success,
      false,
    );
    assertPassive(h, path);
  }));

test("preparation is immutable/idempotent metadata only; language/origin/connection substitutions fail closed", () =>
  isolated((h, path) => {
    const id = h.activate(h.basic()),
      input = request(h, id);
    const card = prepareProcessInput(h.registry, h.starts, admin, scope, input);
    assert.deepEqual(
      prepareProcessInput(h.registry, h.starts, admin, scope, input),
      card,
    );
    assert.equal(
      Number(
        h.db.prepare("SELECT count(*) n FROM agent_process_start_intent").get()!
          .n,
      ),
      1,
    );
    assert.throws(
      () =>
        prepareProcessInput(h.registry, h.starts, admin, scope, {
          ...input,
          language: "en",
        }),
      code("process_start_conflict"),
    );
    assert.throws(
      () =>
        prepareProcessInput(h.registry, h.starts, admin, scope, {
          ...input,
          artifactDigest: "f".repeat(64),
        }),
      code("process_active_version_changed"),
    );
    assert.throws(() =>
      prepareProcessInput(h.registry, h.starts, admin, scope, {
        ...input,
        origin: { type: "card", cardId: "a" },
      }),
    );
    const alternate = prepareProcessInput(
      h.registry,
      h.starts,
      admin,
      { ...scope, connectionId: "TEST-other-connection" },
      input,
    );
    assert.notEqual(alternate.intent.intentId, card.intent.intentId);
    assert.notEqual(alternate.formDigest, card.formDigest);
    assertPassive(h, path);
  }));

test("meeting-origin preparation binds the complete scoped record and explicit compatible source map", () =>
  isolated((h, path) => {
    const id = h.activate(h.basic());
    const record = MeetingRecordSchema.parse({
      ...meetingRecordFixture,
      scope,
      meeting: { ...meetingRecordFixture.meeting, scope },
    });
    const input = {
      ...request(h, id, "TEST-meeting-input"),
      origin: {
        type: "meeting" as const,
        conversationId: "conversation-1",
        requestId: "TEST-meeting-input",
        meetingId: record.meeting.id,
        recordDigest: record.recordDigest!,
        sourceBindings: { name: "summary" as const },
      },
    };
    const card = prepareProcessInput(
      h.registry,
      h.starts,
      admin,
      scope,
      input,
      (currentScope, meetingId) => {
        assert.deepEqual(currentScope, scope);
        assert.equal(meetingId, record.meeting.id);
        return record;
      },
    );
    assert.deepEqual(card.form.origin, input.origin);
    assert.deepEqual(card.intent.origin, input.origin);
    assert.throws(
      () =>
        prepareProcessInput(
          h.registry,
          h.starts,
          admin,
          scope,
          {
            ...input,
            origin: { ...input.origin, recordDigest: "f".repeat(64) },
          },
          () => record,
        ),
      code("process_origin_changed"),
    );
    assertPassive(h, path);
  }));

test("meeting source is revalidated at first admission and exact retry stays idempotent", () =>
  isolated((h) => {
    const definition = ProcessDefinitionSchema.parse({
      ...h.basic(),
      inputSchema: processObject(
        {
          name: { type: "string" },
          transcript: { type: "string", maxLength: 60_000 },
        },
        ["name"],
      ),
    });
    const id = h.activate(definition);
    const transcript = "Celý souvislý přepis schůzky. ".repeat(300);
    const record = MeetingRecordSchema.parse({
      ...meetingRecordFixture,
      transcript,
      scope,
      meeting: { ...meetingRecordFixture.meeting, scope },
    });
    let current = record;
    let missing = false;
    let reads = 0;
    const readRecord = (currentScope: typeof scope, meetingId: string) => {
      reads++;
      assert.deepEqual(currentScope, scope);
      assert.equal(meetingId, record.meeting.id);
      if (missing) throw new IdentityError(404, "meeting_not_found");
      return current;
    };
    const prepare = (requestId: string) => {
      const input = {
        ...request(h, id, requestId),
        origin: {
          type: "meeting" as const,
          conversationId: "conversation-1",
          requestId,
          meetingId: record.meeting.id,
          recordDigest: record.recordDigest!,
          sourceBindings: { transcript: "transcript" as const },
        },
      };
      return prepareProcessInput(
        h.registry,
        h.starts,
        admin,
        scope,
        input,
        readRecord,
      );
    };
    const first = prepare("TEST-meeting-admit-1");
    const command = ProcessStartCommandSchema.parse({
      profile: PROCESS_START_PROFILE,
      type: "process.start",
      commandId: "TEST-meeting-start-1",
      idempotencyKey: "TEST-meeting-start-key-1",
      intentId: first.intent.intentId,
      conversationId: "conversation-1",
      language: "cs",
      input: { name: record.analysis!.summary, transcript: record.transcript },
    });
    const admitted = h.starts.admit(
      admin,
      scope,
      first.intent.intentId,
      command,
      (intent, original) => {
        assert.equal(original.type, "process.start");
        assertMeetingProcessOrigin(
          readRecord,
          scope,
          intent.origin as Extract<typeof intent.origin, { type: "meeting" }>,
          first.form.inputSchema,
        );
      },
    );
    assert.equal(admitted.status, "admitted");
    if (admitted.status === "admitted")
      assert.equal(admitted.input.transcript, transcript);
    assert.throws(
      () =>
        assertMeetingProcessOrigin(
          () => {
            throw new IdentityError(404, "meeting_not_found");
          },
          scope,
          first.intent.origin as Extract<
            typeof first.intent.origin,
            { type: "meeting" }
          >,
          first.form.inputSchema,
        ),
      code("process_origin_changed"),
    );
    const readsAfterAdmission = reads;

    current = { ...record, recordDigest: "f".repeat(64) };
    const replay = h.starts.admit(
      admin,
      scope,
      first.intent.intentId,
      command,
      () => {
        throw Error("TEST exact retry must return its original admission");
      },
    );
    assert.deepEqual(replay, admitted);
    assert.equal(reads, readsAfterAdmission);

    current = record;
    const stale = prepare("TEST-meeting-admit-2");
    current = { ...record, recordDigest: "e".repeat(64) };
    const staleCommand = ProcessStartCommandSchema.parse({
      ...command,
      commandId: "TEST-meeting-start-2",
      idempotencyKey: "TEST-meeting-start-key-2",
      intentId: stale.intent.intentId,
    });
    const rejected = h.starts.admit(
      admin,
      scope,
      stale.intent.intentId,
      staleCommand,
      (intent) =>
        assertMeetingProcessOrigin(
          readRecord,
          scope,
          intent.origin as Extract<typeof intent.origin, { type: "meeting" }>,
          stale.form.inputSchema,
        ),
    );
    assert.equal(rejected.status, "rejected");
    if (rejected.status === "rejected")
      assert.equal(rejected.reason, "process_origin_changed");

    current = record;
    const deleted = prepare("TEST-meeting-admit-3");
    const deletedCommand = ProcessStartCommandSchema.parse({
      ...command,
      commandId: "TEST-meeting-start-3",
      idempotencyKey: "TEST-meeting-start-key-3",
      intentId: deleted.intent.intentId,
    });
    missing = true;
    const missingReceipt = h.starts.admit(
      admin,
      scope,
      deleted.intent.intentId,
      deletedCommand,
      (intent) =>
        assertMeetingProcessOrigin(
          readRecord,
          scope,
          intent.origin as Extract<typeof intent.origin, { type: "meeting" }>,
          deleted.form.inputSchema,
        ),
    );
    assert.equal(missingReceipt.status, "rejected");
    if (missingReceipt.status === "rejected")
      assert.equal(missingReceipt.reason, "process_origin_changed");
  }));

test("previously prepared intent cannot bypass current policy or active version on preparation replay", () =>
  isolated((h, path) => {
    const id = h.activate(h.basic()),
      input = request(h, id);
    prepareProcessInput(h.registry, h.starts, admin, scope, input);
    change(h, h.ids!.readId, { enabled: false });
    assert.throws(
      () => prepareProcessInput(h.registry, h.starts, admin, scope, input),
      code("process_execution_unavailable"),
    );
    change(h, h.ids!.readId, { enabled: true }, false);
    h.db
      .prepare(
        "UPDATE agent_service_process SET active_version=NULL WHERE id=?",
      )
      .run(id);
    assert.throws(
      () => prepareProcessInput(h.registry, h.starts, admin, scope, input),
      code("process_not_found"),
    );
    assert.equal(
      Number(
        h.db.prepare("SELECT count(*) n FROM agent_process_start_intent").get()!
          .n,
      ),
      1,
    );
    assertPassive(h, path);
  }));

test("pagination binds visible active artifacts/current authority and never reveals hidden cursors", () =>
  isolated((h, path) => {
    for (let i = 0; i < 101; i++)
      h.activate({ ...h.basic(), name: `TEST ${i}` });
    const first = h.registry.executionInventory(member, scope);
    assert.equal(first.processes.length, 100);
    assert(first.nextAfter);
    const second = h.registry.executionInventory(member, scope, {
      after: first.nextAfter,
      fingerprint: first.fingerprint,
    });
    assert.equal(second.processes.length, 1);
    assert.equal(second.nextAfter, null);
    assert.equal(second.fingerprint, first.fingerprint);
    assert.equal(
      new Set([...first.processes, ...second.processes].map((e) => e.processId))
        .size,
      101,
    );
    assert.throws(
      () =>
        h.registry.executionInventory(member, scope, {
          after: "TEST-hidden",
          fingerprint: first.fingerprint,
        }),
      code("process_inventory_changed"),
    );
    assert.throws(() =>
      h.registry.executionInventory(member, scope, { after: first.nextAfter }),
    );
    change(h, h.ids!.serviceId, { enabled: false });
    assert.throws(
      () =>
        h.registry.executionInventory(member, scope, {
          after: first.nextAfter,
          fingerprint: first.fingerprint,
        }),
      code("process_inventory_changed"),
    );
    assertPassive(h, path);
  }));

test("model/provider/budget metadata is passive, including members without management model inventory", () =>
  isolated((h, path) => {
    const modelId = h.model();
    const definition = ProcessDefinitionSchema.parse({
      schemaVersion: 1,
      kind: "agent",
      name: "TEST agent",
      description: "TEST purpose",
      trigger: "manual",
      inputSchema: processObject({ name: { type: "string" } }),
      outputSchema: processObject({ result: { type: "string" } }),
      limits: { ...h.basic().limits, maxModelCalls: 4 },
      modelId,
      instructions: "TEST-private-instructions",
      capabilities: [{ serviceId: h.ids!.serviceId, actionId: h.ids!.readId }],
      memory: "none",
    });
    h.activate(definition);
    for (const method of [
      "inventory",
      "provider",
      "model",
      "credential",
      "unseal",
    ] as const)
      h.catalog[method] = (() => {
        throw Error(`TEST forbidden ${method}`);
      }) as never;
    const entry = h.registry.executionInventory(member, scope).processes[0]!;
    assert.equal(entry.availability, "ready");
    assert.equal(
      JSON.stringify(entry).includes("TEST-private-instructions"),
      false,
    );
    change(h, modelId, { enabled: false });
    const blocked = h.registry.executionInventory(member, scope).processes[0]!;
    if (blocked.availability !== "blocked") throw Error("TEST blocked model");
    assert.equal(blocked.reason, "model_unavailable");
    assertPassive(h, path);
  }));

test("OAuth metadata readiness never opens client/token and rejects expired/revoked accounts", () =>
  isolated((h, path) => {
    const oauth = new ServiceOAuthStore(
      h.db,
      "TEST-only-secret",
      "https://server.example.test",
    );
    const target = {
      workspaceId: scope.workspaceId,
      serviceId: h.ids!.serviceId,
      serviceUrl: "https://crm.example.test/v1",
      serviceRevision: 3,
    };
    oauth["unseal"] = () => {
      throw Error("TEST never unseal");
    };
    oauth.useProviders(() => {
      throw Error("TEST never resolve provider client");
    });
    assert.equal(oauth.executionReady(target, scope.userId, "read"), "shared");
    h.db.prepare("INSERT INTO agent_service_oauth_config VALUES (?,?,?,?)").run(
      target.workspaceId,
      target.serviceId,
      JSON.stringify({
        revision: 1,
        serviceUrl: target.serviceUrl,
        settings: {
          requiredFor: "all",
          source: "provider",
          authProviderId: "TEST-provider",
        },
        metadata: null,
      }),
      "TEST-ciphertext",
    );
    let enabled = true;
    oauth.useProviderMetadata(() => enabled);
    const data = {
      revision: 1,
      configRevision: 1,
      identity: { subject: "TEST-private-subject" },
      expiresAt: Date.now() + 3600000,
    };
    h.db
      .prepare("INSERT INTO agent_service_oauth_connection VALUES (?,?,?,?,?)")
      .run(
        target.workspaceId,
        target.serviceId,
        scope.userId,
        JSON.stringify(data),
        "TEST-token-ciphertext",
      );
    assert.equal(
      oauth.executionReady(target, scope.userId, "write"),
      "personal",
    );
    assert.equal(
      oauth.executionReady(target, "TEST-other-user", "write"),
      false,
    );
    enabled = false;
    assert.equal(oauth.executionReady(target, scope.userId, "write"), false);
    enabled = true;
    h.db
      .prepare("UPDATE agent_service_oauth_connection SET data=?")
      .run(JSON.stringify({ ...data, expiresAt: Date.now() - 1 }));
    assert.equal(oauth.executionReady(target, scope.userId, "write"), false);
    assertPassive(h, path);
  }));

test("qualification/test lineage failure cannot be prepared and creates no execution", () =>
  isolated((h, path) => {
    const id = h.activate(h.basic());
    h.db
      .prepare(
        "UPDATE agent_service_process_test SET evidence=? WHERE process_id=?",
      )
      .run(
        JSON.stringify({
          testId: `TEST-${id}`,
          digest: request(h, id).artifactDigest,
          runnerVersion: "TEST-offline/1",
          passed: false,
          scenarios: [
            "success",
            "rejection",
            "missing_input",
            "failure",
            "unknown",
            "restart",
          ],
          reportDigest: "f".repeat(64),
        }),
        id,
      );
    const entry = h.registry.executionInventory(member, scope).processes[0]!;
    assert.equal(entry.availability, "blocked");
    if (entry.availability === "blocked")
      assert.equal(entry.reason, "qualification_required");
    assert.throws(
      () =>
        prepareProcessInput(h.registry, h.starts, admin, scope, request(h, id)),
      code("process_execution_unavailable"),
    );
    assertPassive(h, path);
  }));

test("changed budget prices/provider and saved-memory setting expose safe unavailability", () =>
  isolated((h, path) => {
    const modelId = h.model();
    const definition = ProcessDefinitionSchema.parse({
      schemaVersion: 1,
      kind: "agent",
      name: "TEST agent",
      description: "TEST purpose",
      trigger: "manual",
      inputSchema: processObject(),
      outputSchema: processObject({ result: { type: "string" } }),
      limits: { ...h.basic().limits, maxModelCalls: 4 },
      modelId,
      instructions: "TEST private",
      capabilities: [],
      memory: "saved",
    });
    const id = h.activate(definition);
    const policy = h.catalog.inferenceBudget.policy(
      target.organizationId,
      target.workspaceId,
    );
    h.catalog.inferenceBudget.savePolicy(
      target.organizationId,
      target.workspaceId,
      policy.revision,
      { ...policy.settings, prices: [] },
    );
    let entry = h.registry.executionInventory(member, scope).processes[0]!;
    if (entry.availability !== "blocked") throw Error("TEST blocked budget");
    assert.equal(entry.reason, "budget_unavailable");
    const current = h.catalog.inferenceBudget.policy(
      target.organizationId,
      target.workspaceId,
    );
    h.catalog.inferenceBudget.savePolicy(
      target.organizationId,
      target.workspaceId,
      current.revision,
      policy.settings,
    );
    const provider = h.catalog.processModelMetadata(
      target.organizationId,
      modelId,
    ).provider;
    change(h, provider.id, { enabled: false });
    entry = h.registry.executionInventory(member, scope).processes[0]!;
    if (entry.availability !== "blocked") throw Error("TEST blocked provider");
    assert.equal(entry.reason, "model_unavailable");
    change(h, provider.id, { enabled: true }, false);
    h.db
      .prepare(
        "UPDATE agent_workspace_plugins SET settings=? WHERE workspace_id=?",
      )
      .run(
        JSON.stringify({ enabled: [], timeZone: "UTC" }),
        target.workspaceId,
      );
    entry = h.registry.executionInventory(member, scope).processes[0]!;
    assert.equal(entry.availability, "blocked");
    assert.throws(
      () =>
        prepareProcessInput(h.registry, h.starts, admin, scope, request(h, id)),
      code("process_execution_unavailable"),
    );
    assertPassive(h, path);
  }));

test("prepared schemas support more than twelve values and exact 65536 UTF-8 JSON bytes", () =>
  isolated((h, path) => {
    const properties = Object.fromEntries(
      Array.from({ length: 17 }, (_, i) => [
        i ? `field${i}` : "name",
        { type: "string" as const },
      ]),
    );
    const schema = processObject(properties);
    const id = h.activate(
      ProcessDefinitionSchema.parse({ ...h.basic(), inputSchema: schema }),
    );
    const card = prepareProcessInput(
      h.registry,
      h.starts,
      admin,
      scope,
      request(h, id),
    );
    const input: Record<string, string> = Object.fromEntries(
      Object.keys(properties).map((key) => [key, ""]),
    );
    let remaining = 65536 - Buffer.byteLength(JSON.stringify(input));
    for (const key of Object.keys(input)) {
      const count = Math.min(4000, remaining);
      input[key] = "a".repeat(count);
      remaining -= count;
    }
    assert.equal(remaining, 0);
    assert.equal(Buffer.byteLength(JSON.stringify(input)), 65536);
    assert.deepEqual(
      ProcessStartInputSchema.parse(
        processValueSchema(card.form.inputSchema).parse(input),
      ),
      input,
    );
    input.field16 += "a";
    assert.equal(Buffer.byteLength(JSON.stringify(input)), 65537);
    assert.equal(ProcessStartInputSchema.safeParse(input).success, false);
    assertPassive(h, path);
  }));

test("process input can carry a full configured transcript without truncating past 4K", () => {
  const schema = ProcessDataSchema.parse({
    type: "object",
    properties: {
      transcript: { type: "string", maxLength: 60_000 },
    },
    required: ["transcript"],
    additionalProperties: false,
  });
  const transcript = "Příprava schůzky a následných úkolů. ".repeat(250);
  assert.ok(transcript.length > 4_000);
  const parsedSchema = processValueSchema(schema);
  const input = parsedSchema.parse({ transcript });
  assert.equal((input as { transcript: string }).transcript, transcript);
  assert.deepEqual(ProcessStartInputSchema.parse(input), input);
  assert.equal(
    ProcessStartInputSchema.safeParse({ transcript: "x".repeat(60_001) })
      .success,
    false,
  );
  assert.equal(
    ProcessStartInputSchema.safeParse({ transcript: "🧠".repeat(16_400) })
      .success,
    false,
  );
});

test("first-call token/cost caps and provider daily quota are checked without a reservation", () =>
  isolated((h, path) => {
    const modelId = h.model(),
      selected = h.catalog.processModelMetadata(target.organizationId, modelId);
    const definition = ProcessDefinitionSchema.parse({
      schemaVersion: 1,
      kind: "agent",
      name: "TEST agent",
      description: "",
      trigger: "manual",
      inputSchema: processObject(),
      outputSchema: processObject(),
      limits: { ...h.basic().limits, maxModelCalls: 2 },
      modelId,
      instructions: "TEST private",
      capabilities: [],
      memory: "none",
    });
    const id = h.activate(definition);
    const budget = h.catalog.inferenceBudget,
      policy = budget.policy(target.organizationId, target.workspaceId);
    // Readiness asks whether the smallest call (the floor input plus the
    // full output) fits; each real call reserves its own request size.
    const price = policy.settings.prices[0]!,
      input = Math.min(price.maxInputTokens, MIN_INPUT_ALLOWANCE),
      tokens = input + price.maxOutputTokens,
      cost = tariffMicros(input, price.maxOutputTokens, price);
    assert.equal(
      budget.canStartModel(
        target.organizationId,
        target.workspaceId,
        selected,
        { maxTokens: tokens, maxCostMicros: cost, maxModelCalls: 1 },
      ),
      true,
    );
    assert.equal(
      budget.canStartModel(
        target.organizationId,
        target.workspaceId,
        selected,
        { maxTokens: tokens - 1, maxCostMicros: cost, maxModelCalls: 1 },
      ),
      false,
    );
    assert.equal(
      budget.canStartModel(
        target.organizationId,
        target.workspaceId,
        selected,
        { maxTokens: tokens, maxCostMicros: cost - 1, maxModelCalls: 1 },
      ),
      false,
    );
    budget.savePolicy(
      target.organizationId,
      target.workspaceId,
      policy.revision,
      { ...policy.settings, maxTokens: 1 },
    );
    let entry = h.registry.executionInventory(member, scope).processes[0]!;
    if (entry.availability !== "blocked") throw Error("TEST blocked budget");
    assert.equal(entry.reason, "budget_unavailable");
    assert.throws(
      () =>
        prepareProcessInput(h.registry, h.starts, admin, scope, request(h, id)),
      code("process_execution_unavailable"),
    );
    const current = budget.policy(target.organizationId, target.workspaceId);
    budget.savePolicy(
      target.organizationId,
      target.workspaceId,
      current.revision,
      policy.settings,
    );
    const row = h.db
      .prepare("SELECT data FROM agent_catalog WHERE id=?")
      .get(selected.provider.id)!;
    const limit = JSON.parse(String(row.data)).dailyRequestLimit;
    h.db
      .prepare("INSERT INTO agent_provider_usage VALUES (?,?,?)")
      .run(selected.provider.id, new Date().toISOString().slice(0, 10), limit);
    entry = h.registry.executionInventory(member, scope).processes[0]!;
    if (entry.availability !== "blocked")
      throw Error("TEST blocked daily quota");
    assert.equal(entry.reason, "budget_unavailable");
    assert.throws(
      () =>
        prepareProcessInput(h.registry, h.starts, admin, scope, request(h, id)),
      code("process_execution_unavailable"),
    );
    assertPassive(h, path);
  }));

test("catalog OAuth readiness checks the current linked account without decrypting any secret", () =>
  isolated((h, path) => {
    const oauth = new ServiceOAuthStore(
      h.db,
      "TEST-secret",
      "https://server.example.test",
    );
    const providers = new AuthProviderStore(
      h.db,
      "TEST-secret",
      "https://server.example.test",
    );
    new ServiceCatalogStore(h.db, "TEST-secret", [], oauth, providers);
    h.db.exec(
      'CREATE TABLE account(id TEXT PRIMARY KEY,"providerId" TEXT,"userId" TEXT,"accountId" TEXT)',
    );
    const providerId = "ap_11111111111111111111111111111111",
      provider = {
        id: providerId,
        organizationId: target.organizationId,
        revision: 1,
        kind: "microsoft",
        name: "TEST Microsoft",
        enabled: true,
        clientId: "TEST-client",
        hasClientSecret: true,
        tenantId: "11111111-1111-4111-8111-111111111111",
        hostedDomain: null,
        callbackURL: `https://server.example.test/admin/auth/callback/${providerId}`,
      };
    h.db
      .prepare(
        "INSERT INTO agent_auth_provider(id,organization_id,revision,data,secret) VALUES (?,?,?,?,?)",
      )
      .run(
        providerId,
        target.organizationId,
        1,
        JSON.stringify(provider),
        "TEST-ciphertext",
      );
    const oauthTarget = {
      workspaceId: scope.workspaceId,
      serviceId: h.ids!.serviceId,
      serviceUrl: "https://crm.example.test/v1",
      serviceRevision: 3,
    };
    h.db.prepare("INSERT INTO agent_service_oauth_config VALUES (?,?,?,?)").run(
      oauthTarget.workspaceId,
      oauthTarget.serviceId,
      JSON.stringify({
        revision: 1,
        serviceUrl: oauthTarget.serviceUrl,
        settings: {
          requiredFor: "all",
          source: "provider",
          authProviderId: providerId,
        },
        metadata: null,
      }),
      "TEST-client-ciphertext",
    );
    h.db
      .prepare("INSERT INTO agent_service_oauth_connection VALUES (?,?,?,?,?)")
      .run(
        oauthTarget.workspaceId,
        oauthTarget.serviceId,
        scope.userId,
        JSON.stringify({
          revision: 1,
          configRevision: 1,
          identity: { subject: "TEST-subject" },
          expiresAt: Date.now() + 3600000,
        }),
        "TEST-token-ciphertext",
      );
    oauth["unseal"] = () => {
      throw Error("TEST token unseal forbidden");
    };
    providers["unseal"] = () => {
      throw Error("TEST provider unseal forbidden");
    };
    assert.equal(
      oauth.executionReady(oauthTarget, scope.userId, "write"),
      false,
    );
    h.db
      .prepare("INSERT INTO account VALUES (?,?,?,?)")
      .run("TEST-account", providerId, scope.userId, "TEST-subject");
    assert.equal(
      oauth.executionReady(oauthTarget, scope.userId, "write"),
      "personal",
    );
    h.db.prepare("DELETE FROM account WHERE id=?").run("TEST-account");
    assert.equal(
      oauth.executionReady(oauthTarget, scope.userId, "write"),
      false,
    );
    assertPassive(h, path);
  }));
