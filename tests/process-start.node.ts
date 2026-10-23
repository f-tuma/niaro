import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROCESS_TEST_SCENARIOS } from "../apps/server-identity/service-processes";
import { IdentityError } from "../apps/server-identity/error";
import { processDigest } from "../apps/server-identity/process-validation";
import { assertProcessStartCardOrigin } from "../apps/server-identity/process-start-store";
import { serviceProcessRunIdentity } from "../apps/server-identity/service-process-journal";
import { processCompilerVersion } from "../apps/server-agent/process-contract";
import { FixtureEngine } from "../apps/fixture-server/engine";
import { CardDocumentSchema } from "../packages/protocol/card-document";
import { resolveCardSubmission } from "../apps/server-cards/respond";
import { CardResponseCommandSchema, CommandSchema } from "../packages/protocol";
import { ProcessStartInputSchema } from "../packages/protocol/process-start";
import { CatalogCommand } from "../packages/protocol/service-catalog";
import {
  PROCESS_INPUT_STRING_MAX_LENGTH,
  ProcessDefinitionSchema,
} from "../packages/protocol/service-processes";
import { startFixture } from "./helpers/process-start";
import {
  admin,
  scope,
  target,
  signal,
  code,
} from "./helpers/service-process-runtime";
import { processObject } from "./helpers/service-process";

async function isolated(
  run: (
    h: ReturnType<typeof startFixture>,
    path: string,
  ) => void | Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "niaro-start-"));
  const path = join(root, "identity.sqlite");
  const h = startFixture(path);
  try {
    await run(h, path);
  } finally {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  }
}
function rows(h: ReturnType<typeof startFixture>) {
  return [
    "agent_process_start_command",
    "agent_service_process_run",
    "agent_service_turn",
  ].map((table) =>
    Number(h.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n),
  );
}
function nextVersion(h: ReturnType<typeof startFixture>, processId: string) {
  const current = h.registry.get(admin, processId);
  const draft = h.registry.saveDraft(admin, {
    id: processId,
    serviceId: h.ids!.serviceId,
    revision: current.revision,
    definition: { ...current.draft, name: "TEST version two" },
  });
  const artifact = h.registry.freezeDraft(admin, processId, draft.revision);
  h.registry.recordTest(admin, processId, artifact.version, {
    testId: "TEST-version-two",
    digest: artifact.digest,
    runnerVersion: "TEST-offline/1",
    passed: true,
    scenarios: [...PROCESS_TEST_SCENARIOS],
    reportDigest: processDigest({ fixture: true, version: 2 }),
  });
  h.registry.activate(
    admin,
    processId,
    h.registry.get(admin, processId).revision,
    2,
  );
}

test("admission atomically stores the original command, v1 pin and exact native journal; replay precedes pointer/source gates", () =>
  isolated((h) => {
    const { processId, intent, command } = h.setup();
    const receipt = h.starts.admit(
      admin,
      scope,
      intent.intentId,
      command,
      () => {},
    );
    assert.equal(receipt.status, "admitted");
    assert.deepEqual(rows(h), [1, 1, 1]);
    assert.deepEqual(h.counts(), []);
    assert.deepEqual(h.models(), []);
    assert.equal(
      CommandSchema.safeParse(command).success,
      false,
      "public execution remains NIAR-92",
    );
    if (receipt.status !== "admitted") throw Error("TEST admission absent");
    assert.equal(
      receipt.parentRunId,
      serviceProcessRunIdentity(scope, target.organizationId, receipt.runId)
        .parentRunId,
    );
    const journal = h.catalog.turn(
      receipt.parentRunId,
      scope.workspaceId,
      scope.userId,
    ) as Record<string, unknown>;
    assert.equal(journal.startedAt, Date.parse(receipt.createdAt));
    assert.equal(journal.compilerVersion, "niaro-native-workflow/1");
    assert.equal(processCompilerVersion(h.basic()), "niaro-native-workflow/1");
    nextVersion(h, processId);
    const service = h.catalog.service(scope.workspaceId, h.ids!.serviceId);
    h.catalog.command(
      CatalogCommand.parse({
        ...target,
        type: "saveService",
        id: service.id,
        revision: service.revision,
        settings: {
          name: service.name,
          url: service.url,
          protocol: service.protocol,
          icon: service.icon,
          auth: service.auth,
          enabled: false,
        },
      }),
    );
    assert.throws(() => h.registry.resolveRun(admin, receipt.parentRunId));
    assert.deepEqual(
      h.starts.admit(admin, scope, intent.intentId, command, () => {
        throw Error("TEST replay must not validate stale form");
      }),
      receipt,
    );
    assert.deepEqual(
      h.starts.read(admin, scope, command.commandId, command.idempotencyKey),
      receipt,
    );
    assert.deepEqual(rows(h), [1, 1, 1]);
  }));

test("seen v1 cannot admit active v2; definite rejection survives rollback to v1 and does not consume intent", () =>
  isolated((h) => {
    const { processId, intent, command } = h.setup();
    nextVersion(h, processId);
    const rejected = h.starts.admit(
      admin,
      scope,
      intent.intentId,
      command,
      () => {},
    );
    assert.equal(rejected.status, "rejected");
    if (rejected.status === "rejected")
      assert.equal(rejected.reason, "process_active_version_changed");
    assert.deepEqual(rows(h), [1, 0, 0]);
    h.registry.activate(
      admin,
      processId,
      h.registry.get(admin, processId).revision,
      1,
    );
    assert.deepEqual(
      h.starts.admit(admin, scope, intent.intentId, command, () => {}),
      rejected,
    );
    const corrected = {
      ...command,
      commandId: "TEST-corrected",
      idempotencyKey: "TEST-corrected-key",
    };
    assert.equal(
      h.starts.admit(admin, scope, intent.intentId, corrected, () => {}).status,
      "admitted",
    );
    assert.deepEqual(rows(h), [2, 1, 1]);
  }));

test("deterministic gate refusals become durable receipts; transient errors reserve nothing", () =>
  isolated((h) => {
    const { intent, command } = h.setup();
    const cases = [
      ["process_qualification_stale", "process_qualification_stale"],
      ["process_test_conflict", "process_test_conflict"],
      ["process_execution_unavailable", "process_execution_unavailable"],
      ["catalog_model_unavailable", "process_sources_changed"],
      ["catalog_not_found", "process_sources_changed"],
    ] as const;
    for (const [index, [thrown, reason]] of cases.entries()) {
      const attempt = {
        ...command,
        commandId: `TEST-gate-${index}`,
        idempotencyKey: `TEST-gate-key-${index}`,
      };
      const refuse = () => {
        throw new IdentityError(409, thrown);
      };
      const receipt = h.starts.admit(
        admin,
        scope,
        intent.intentId,
        attempt,
        refuse,
      );
      assert.equal(receipt.status, "rejected", thrown);
      if (receipt.status === "rejected") assert.equal(receipt.reason, reason);
      // Exact replay returns the refusal before any gate runs again.
      assert.deepEqual(
        h.starts.admit(admin, scope, intent.intentId, attempt, () => {}),
        receipt,
      );
      assert.deepEqual(rows(h), [index + 1, 0, 0]);
    }
    const busy = {
      ...command,
      commandId: "TEST-gate-busy",
      idempotencyKey: "TEST-gate-busy-key",
    };
    assert.throws(
      () =>
        h.starts.admit(admin, scope, intent.intentId, busy, () => {
          throw new IdentityError(429, "catalog_busy");
        }),
      code("catalog_busy"),
    );
    // Missing durable proof (e.g. a partial restore) is not a deterministic
    // refusal: it reserves nothing, so the restored proof admits the same start.
    for (const missing of [
      "process_test_superseded",
      "process_test_not_found",
      "process_not_found",
    ])
      assert.throws(
        () =>
          h.starts.admit(admin, scope, intent.intentId, busy, () => {
            throw new IdentityError(409, missing);
          }),
        code(missing),
      );
    assert.deepEqual(rows(h), [cases.length, 0, 0]);
    assert.equal(
      h.starts.admit(admin, scope, intent.intentId, busy, () => {}).status,
      "admitted",
    );
  }));

test("command, key, intent and origin are immutable; one successful redemption cannot make a second run", () =>
  isolated((h) => {
    const { intent, command } = h.setup();
    const receipt = h.starts.admit(
      admin,
      scope,
      intent.intentId,
      command,
      () => {},
    );
    for (const changed of [
      { ...command, input: { name: "TEST changed" } },
      { ...command, conversationId: "TEST-other-conversation" },
      { ...command, commandId: "TEST-other-command" },
      { ...command, idempotencyKey: "TEST-other-key" },
    ])
      assert.throws(
        () => h.starts.admit(admin, scope, intent.intentId, changed, () => {}),
        code("idempotency_conflict"),
      );
    const duplicate = h.starts.admit(
      admin,
      scope,
      intent.intentId,
      {
        ...command,
        commandId: "TEST-second",
        idempotencyKey: "TEST-second-key",
      },
      () => {},
    );
    assert.equal(duplicate.status, "rejected");
    if (duplicate.status === "rejected")
      assert.equal(duplicate.reason, "process_start_conflict");
    assert.throws(
      () => h.db.exec("UPDATE agent_process_start_command SET data=data"),
      /immutable/,
    );
    assert.throws(
      () => h.db.exec("UPDATE agent_process_start_intent SET data=data"),
      /immutable/,
    );
    assert.deepEqual(
      h.starts.read(admin, scope, command.commandId, command.idempotencyKey),
      receipt,
    );
    assert.deepEqual(rows(h), [2, 1, 1]);
  }));

test("historical receipt reads still require current auth, connection scope and private-read policy", () =>
  isolated((h) => {
    const { intent, command } = h.setup();
    h.starts.admit(admin, scope, intent.intentId, command, () => {});
    for (const foreign of [
      { ...scope, serverId: "TEST-other" },
      { ...scope, userId: "TEST-other" },
      { ...scope, workspaceId: "TEST-other" },
      { ...scope, connectionId: "TEST-other" },
    ])
      assert.throws(() =>
        h.starts.read(
          admin,
          foreign,
          command.commandId,
          command.idempotencyKey,
        ),
      );
    assert.throws(() =>
      h.starts.read(
        { ...admin, organizationId: "TEST-other" },
        scope,
        command.commandId,
        command.idempotencyKey,
      ),
    );
    h.denyRead();
    assert.throws(
      () =>
        h.starts.read(admin, scope, command.commandId, command.idempotencyKey),
      code("identity_forbidden"),
    );
    h.revoke();
    assert.throws(
      () => h.starts.admit(admin, scope, intent.intentId, command, () => {}),
      code("identity_forbidden"),
    );
    assert.deepEqual(rows(h), [1, 1, 1]);
  }));

test("canonical nested JSON retains whitespace, null, false, zero, optional absence and array order", () =>
  isolated((h) => {
    const definition = h.basic();
    const inputSchema = processObject(
      {
        name: { type: "string" },
        flag: { type: "boolean" },
        count: { type: "integer", minimum: 0 },
        empty: { type: "string" },
        detail: processObject({
          note: { type: "null" },
          items: { type: "array", items: { type: "integer" } },
        }),
        optional: { type: "string" },
      },
      ["name", "flag", "count", "empty", "detail"],
    );
    const { intent, command } = h.setup(
      ProcessDefinitionSchema.parse({ ...definition, inputSchema }),
    );
    const input = {
      name: "  TEST  ",
      flag: false,
      count: 0,
      empty: "",
      detail: { note: null, items: [3, 1, 2] },
    };
    const receipt = h.starts.admit(
      admin,
      scope,
      intent.intentId,
      { ...command, input },
      () => {},
    );
    assert.equal(receipt.status, "admitted");
    if (receipt.status !== "admitted") throw Error("TEST admission absent");
    assert.deepEqual(receipt.input, input);
    assert.equal(receipt.inputDigest, processDigest(input));
    assert.deepEqual(
      h.starts.admit(
        admin,
        scope,
        intent.intentId,
        {
          ...command,
          input: {
            detail: input.detail,
            empty: "",
            count: 0,
            flag: false,
            name: input.name,
          },
        },
        () => {},
      ),
      receipt,
    );
    assert.throws(
      () =>
        h.starts.admit(
          admin,
          scope,
          intent.intentId,
          {
            ...command,
            input: { ...input, detail: { ...input.detail, items: [1, 3, 2] } },
          },
          () => {},
        ),
      code("idempotency_conflict"),
    );
  }));

test("invalid frozen input has a durable rejection, while malformed or oversized envelopes reserve nothing", () =>
  isolated((h) => {
    const { intent, command } = h.setup();
    const rejected = h.starts.admit(
      admin,
      scope,
      intent.intentId,
      { ...command, input: { name: "TEST", extra: 1 } },
      () => {},
    );
    assert.equal(rejected.status, "rejected");
    if (rejected.status === "rejected")
      assert.equal(rejected.reason, "process_input_invalid");
    for (const input of [
      { name: undefined },
      { name: NaN },
      { name: Infinity },
      { name: () => "TEST" },
      { name: "x".repeat(PROCESS_INPUT_STRING_MAX_LENGTH + 1) },
      { name: new Date() },
    ])
      assert.throws(() =>
        h.starts.admit(
          admin,
          scope,
          intent.intentId,
          {
            ...command,
            commandId: "TEST-malformed",
            idempotencyKey: "TEST-malformed-key",
            input,
          },
          () => {},
        ),
      );
    assert.deepEqual(rows(h), [1, 0, 0]);
    assert.equal(
      h.starts.admit(
        admin,
        scope,
        intent.intentId,
        { ...command, commandId: "TEST-fix", idempotencyKey: "TEST-fix-key" },
        () => {},
      ).status,
      "admitted",
    );
  }));

test("input budget uses exact UTF-8 JSON bytes, including escaped values and keys", () => {
  const base: Record<string, string> = Object.fromEntries(
    Array.from({ length: 16 }, (_, i) => ["f" + i, "ž".repeat(2000)]),
  );
  const remaining =
    65536 - Buffer.byteLength(JSON.stringify({ ...base, tail: "" }));
  assert(remaining > 0 && remaining < 4000);
  const exact = { ...base, tail: "x".repeat(remaining) };
  assert.equal(Buffer.byteLength(JSON.stringify(exact)), 65536);
  assert.equal(ProcessStartInputSchema.safeParse(exact).success, true);
  assert.equal(
    ProcessStartInputSchema.safeParse({ ...exact, tail: exact.tail + "x" })
      .success,
    false,
  );
  assert.equal(
    ProcessStartInputSchema.safeParse(JSON.parse('{"__proto__":1}')).success,
    false,
  );
});

test("typed card submission uses frozen field paths and actual visible origin, not button prose", () =>
  isolated((h) => {
    const processId = h.activate(h.basic());
    // A form stored with an answer before model-composed cards were retired.
    const card = CardDocumentSchema.parse({
      id: "TEST-card",
      revision: 1,
      title: "TEST inputs",
      nodes: [
        {
          id: "person",
          type: "input",
          label: "TEST person",
          kind: "text",
          required: true,
        },
        { id: "go", type: "button", actionId: "start" },
      ],
      root: ["person", "go"],
      actions: [
        {
          id: "start",
          kind: "submit",
          label: "TEST arbitrary label",
          variant: "primary",
          fields: ["person"],
        },
      ],
    });
    const engine = new FixtureEngine(
      "TEST",
      undefined,
      undefined,
      undefined,
      scope,
    );
    engine.execute(
      {
        type: "message.send",
        commandId: "TEST-menu",
        idempotencyKey: "TEST-menu-key",
        conversationId: "conversation-1",
        language: "cs",
        text: "TEST open process",
      },
      {
        decision: {
          kind: "reply",
          contactId: null,
          title: null,
          localStart: null,
          durationMinutes: null,
          reply: "TEST form",
        },
        expectedCursor: engine.snapshot().cursor,
        timeZone: "UTC",
      },
    );
    engine.data.snapshot.conversations[0]!.messages.at(-1)!.result = {
      type: "card.document",
      version: 1,
      document: card,
    };
    const snapshot = engine.snapshot(),
      message = snapshot.conversations[0]!.messages.at(-1)!;
    const response = CardResponseCommandSchema.parse({
      type: "card.respond",
      commandId: "TEST-submit",
      idempotencyKey: "TEST-submit-key",
      conversationId: "conversation-1",
      messageId: message.id,
      cardId: card.id,
      expectedCardRevision: 1,
      actionId: "start",
      values: { person: "  TEST typed input  " },
      language: "cs",
    });
    const artifact = h.registry.version(admin, processId, 1);
    const intent = h.starts.issue(
      admin,
      scope,
      {
        processId,
        version: 1,
        artifactDigest: artifact.digest,
        formDigest: processDigest(card),
        origin: {
          type: "card",
          conversationId: response.conversationId,
          messageId: response.messageId,
          cardId: card.id,
          cardRevision: 1,
          actionId: "start",
        },
        fields: { person: ["name"] },
      },
      (value) => assertProcessStartCardOrigin(snapshot, scope, value, response),
    );
    const typed = resolveCardSubmission(snapshot, response);
    assert(typed.ok);
    assert.deepEqual(typed.values, response.values);
    const receipt = h.starts.admit(
      admin,
      scope,
      intent.intentId,
      response,
      (value, original) =>
        assertProcessStartCardOrigin(snapshot, scope, value, original),
    );
    assert.equal(receipt.status, "admitted");
    if (receipt.status === "admitted")
      assert.deepEqual(receipt.input, { name: "  TEST typed input  " });
    assert.deepEqual(h.counts(), []);
    assert.deepEqual(h.models(), []);
    engine.execute({
      type: "message.send",
      commandId: "TEST-next",
      idempotencyKey: "TEST-next-key",
      conversationId: "conversation-1",
      language: "cs",
      text: "TEST superseding message",
    });
    assert.deepEqual(
      h.starts.admit(
        admin,
        scope,
        intent.intentId,
        response,
        (value, original) =>
          assertProcessStartCardOrigin(
            engine.snapshot(),
            scope,
            value,
            original,
          ),
      ),
      receipt,
    );
  }));

test("native runner consumes the exact admitted seed and subsequent passive read accepts legitimate journal progress", () =>
  isolated(async (h) => {
    const { processId, intent, command } = h.setup();
    const receipt = h.starts.admit(
      admin,
      scope,
      intent.intentId,
      command,
      () => {},
    );
    if (receipt.status !== "admitted") throw Error("TEST admission absent");
    const outcome = await h.runtime.start(
      processId,
      receipt.runId,
      receipt.input,
      signal(),
    );
    assert.equal(outcome.status, "succeeded");
    assert.deepEqual(h.counts(), [["GET", 1]]);
    assert.deepEqual(
      h.starts.read(admin, scope, command.commandId, command.idempotencyKey),
      receipt,
    );
    assert.deepEqual(
      h.starts.admit(admin, scope, intent.intentId, command, () => {}),
      receipt,
    );
    assert.deepEqual(h.counts(), [["GET", 1]]);
    assert.deepEqual(rows(h), [1, 1, 1]);
  }));

test("nested mapped fields create own containers for inherited object names without mutating prototypes", () =>
  isolated((h) => {
    const inputSchema = processObject({
      name: { type: "string" },
      toString: processObject({ probe: { type: "string" } }),
    });
    const definition = ProcessDefinitionSchema.parse({
      ...h.basic(),
      inputSchema,
    });
    const processId = h.activate(definition);
    const artifact = h.registry.version(admin, processId, 1);
    const intent = h.starts.issue(
      admin,
      scope,
      {
        processId,
        version: 1,
        artifactDigest: artifact.digest,
        formDigest: processDigest("TEST own-field-form"),
        origin: {
          type: "card",
          conversationId: "conversation-1",
          messageId: "TEST-message",
          cardId: "TEST-own-card",
          cardRevision: 1,
          actionId: "start",
        },
        fields: { name: ["name"], detail: ["toString", "probe"] },
      },
      () => {},
    );
    const before = Object.getOwnPropertyDescriptors(Object.prototype.toString);
    const receipt = h.starts.admit(
      admin,
      scope,
      intent.intentId,
      CardResponseCommandSchema.parse({
        type: "card.respond",
        commandId: "TEST-own-fields",
        idempotencyKey: "TEST-own-fields-key",
        language: "cs",
        conversationId: "conversation-1",
        messageId: "TEST-message",
        cardId: "TEST-own-card",
        expectedCardRevision: 1,
        actionId: "start",
        values: { name: "TEST", detail: "TEST probe" },
      }),
      () => {},
    );
    assert.equal(receipt.status, "admitted");
    if (receipt.status === "admitted")
      assert.deepEqual(receipt.input, {
        name: "TEST",
        toString: { probe: "TEST probe" },
      });
    assert.deepEqual(
      Object.getOwnPropertyDescriptors(Object.prototype.toString),
      before,
    );
  }));

for (const table of [
  "agent_service_process_run",
  "agent_service_turn",
  "agent_process_start_command",
]) {
  test(`unexpected write error at ${table} rolls back admission, pin and seed`, () =>
    isolated((h) => {
      const { intent, command } = h.setup();
      h.db
        .exec(`CREATE TEMP TRIGGER test_start_write_failure AFTER INSERT ON ${table}
        BEGIN SELECT RAISE(ABORT,'TEST write failed'); END;`);
      assert.throws(
        () => h.starts.admit(admin, scope, intent.intentId, command, () => {}),
        /TEST write failed/,
      );
      assert.deepEqual(rows(h), [0, 0, 0]);
      assert.deepEqual(h.counts(), []);
      assert.deepEqual(h.models(), []);
    }));
}

test("missing admitted journal is a proof gap and passive replay never recreates it", () =>
  isolated((h) => {
    const { intent, command } = h.setup();
    const receipt = h.starts.admit(
      admin,
      scope,
      intent.intentId,
      command,
      () => {},
    );
    if (receipt.status !== "admitted") throw Error("TEST admission absent");
    h.db
      .prepare("DELETE FROM agent_service_turn WHERE id=?")
      .run(receipt.parentRunId);
    assert.throws(
      () =>
        h.starts.read(admin, scope, command.commandId, command.idempotencyKey),
      code("process_start_conflict"),
    );
    assert.throws(
      () => h.starts.admit(admin, scope, intent.intentId, command, () => {}),
      code("process_start_conflict"),
    );
    assert.deepEqual(rows(h), [1, 1, 0]);
  }));
