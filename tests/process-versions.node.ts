import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROCESS_VERSION_PROFILE,
  ProcessFreezeCommandSchema,
  ProcessFreezeReadQuerySchema,
  ProcessFreezeReceiptSchema,
  ProcessVersionListQuerySchema,
} from "../packages/protocol/process-versions";
import { ProcessVersionsStore } from "../apps/server-identity/process-versions-store";
import {
  fixture,
  admin,
  target,
  code,
} from "./helpers/service-process-runtime";
import { processWorkflow } from "./helpers/service-process";

async function setup(
  run: (x: ReturnType<typeof build>) => Promise<void> | void,
) {
  const root = mkdtempSync(join(tmpdir(), "niaro-process-versions-"));
  const path = join(root, "identity.sqlite"),
    h = fixture(path);
  try {
    await run(build(h, path));
  } finally {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  }
}
function build(h: ReturnType<typeof fixture>, path: string) {
  const draft = h.registry.saveDraft(admin, {
    serviceId: h.ids.serviceId,
    revision: 0,
    definition: processWorkflow(h.ids.serviceId, h.ids.readId),
  });
  const store = new ProcessVersionsStore(
    h.db,
    "TEST-server",
    h.registry,
    () => 1000000,
  );
  const command = ProcessFreezeCommandSchema.parse({
    ...target,
    profile: PROCESS_VERSION_PROFILE,
    requestId: "TEST-freeze-original",
    processId: draft.id,
    revision: draft.revision,
  });
  const query = (extra: object = {}) =>
    ProcessVersionListQuerySchema.parse({
      ...target,
      profile: PROCESS_VERSION_PROFILE,
      processId: draft.id,
      ...extra,
    });
  const counts = () =>
    Object.fromEntries(
      [
        "agent_process_freeze_command",
        "agent_service_process_version",
        "agent_service_process_run",
        "agent_service_process_test",
        "agent_audit",
      ].map((table) => [
        table,
        h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n,
      ]),
    );
  return { h, path, draft, store, command, query, counts };
}

test("freeze and history schemas reject unknown authority, wrong profiles and unbounded cursors", () => {
  const command = {
    ...target,
    profile: PROCESS_VERSION_PROFILE,
    requestId: "TEST-command",
    processId: "TEST-process",
    revision: 0,
  };
  assert(ProcessFreezeCommandSchema.safeParse(command).success);
  for (const extra of [
    { userId: "TEST-user" },
    { profile: undefined },
    { revision: -1 },
    { type: "freezeDraft" },
    { artifactDigest: "a".repeat(64) },
  ])
    assert.equal(
      ProcessFreezeCommandSchema.safeParse({ ...command, ...extra }).success,
      false,
    );
  const read = {
    ...target,
    profile: PROCESS_VERSION_PROFILE,
    requestId: command.requestId,
  };
  assert(ProcessFreezeReadQuerySchema.safeParse(read).success);
  assert.equal(
    ProcessFreezeReadQuerySchema.safeParse({
      ...read,
      processId: command.processId,
    }).success,
    false,
  );
  const list = {
    ...target,
    profile: PROCESS_VERSION_PROFILE,
    processId: command.processId,
  };
  assert.deepEqual(ProcessVersionListQuerySchema.parse(list), {
    ...list,
    limit: 20,
  });
  for (const extra of [
    { profile: undefined },
    { before: "0" },
    { before: "1.5" },
    { before: "9007199254740992" },
    { limit: "0" },
    { limit: "21" },
    { limit: "NaN" },
    { version: "1" },
  ])
    assert.equal(
      ProcessVersionListQuerySchema.safeParse({ ...list, ...extra }).success,
      false,
    );
});

test("freeze stores one exact private receipt and replays before changed draft/source/CAS across reopen", () =>
  setup(async (x) => {
    const receipt = ProcessFreezeReceiptSchema.parse(
      x.store.freeze(admin, x.command),
    );
    assert.equal(receipt.resultingRevision, x.draft.revision + 1);
    assert.equal(receipt.version, 1);
    const edited = x.h.registry.saveDraft(admin, {
      id: x.draft.id,
      serviceId: x.h.ids.serviceId,
      revision: receipt.resultingRevision,
      definition: { ...x.draft.draft, name: "TEST edited after freeze" },
    });
    x.h.db
      .prepare("UPDATE agent_catalog SET revision=revision+1 WHERE id=?")
      .run(x.h.ids.readId);
    const before = x.counts();
    x.h.registry.testArtifact = () => {
      throw Error("TEST history resolved live sources");
    };
    x.h.registry.freezeDraft = () => {
      throw Error("TEST replay called freezer");
    };
    assert.deepEqual(x.store.freeze(admin, x.command), receipt);
    assert.deepEqual(x.store.read(admin, x.command.requestId), receipt);
    assert.equal(
      x.store.list(admin, x.query()).versions[0]!.digest,
      receipt.artifactDigest,
    );
    assert.deepEqual(x.h.registry.get(admin, x.draft.id), edited);
    assert.deepEqual(x.counts(), before);
    await x.h.close();
    const reopened = fixture(x.path, x.h.ids);
    try {
      reopened.registry.freezeDraft = () => {
        throw Error("TEST reopened replay called freezer");
      };
      const store = new ProcessVersionsStore(
        reopened.db,
        "TEST-server",
        reopened.registry,
      );
      assert.deepEqual(store.freeze(admin, x.command), receipt);
      assert.deepEqual(store.read(admin, x.command.requestId), receipt);
      assert.equal(
        store.list(admin, x.query()).versions[0]!.digest,
        receipt.artifactDigest,
      );
      assert.equal(
        reopened.db
          .prepare("SELECT COUNT(*) AS n FROM agent_process_freeze_command")
          .get()!.n,
        1,
      );
      assert.equal(
        reopened.db.prepare("SELECT COUNT(*) AS n FROM test_model").get()!.n,
        0,
      );
      assert.deepEqual(reopened.counts(), []);
    } finally {
      await reopened.close();
    }
  }));

test("freeze privacy, exact command conflicts, CAS and unchanged-draft semantics preserve legacy controls", () =>
  setup((x) => {
    const receipt = x.store.freeze(admin, x.command);
    assert.throws(
      () =>
        x.store.freeze(admin, {
          ...x.command,
          revision: receipt.resultingRevision,
        }),
      code("process_freeze_conflict"),
    );
    assert.throws(
      () =>
        x.store.freeze(admin, { ...x.command, requestId: "TEST-new-stale" }),
      code("process_conflict"),
    );
    assert.throws(
      () => x.store.freeze({ ...admin, role: "member" }, x.command),
      code("identity_forbidden"),
    );
    assert.throws(
      () =>
        x.store.freeze(admin, { ...x.command, workspaceId: "TEST-foreign" }),
      code("identity_forbidden"),
    );
    assert.throws(
      () =>
        x.store.read({ ...admin, userId: "TEST-other" }, x.command.requestId),
      code("process_freeze_not_found"),
    );
    assert.throws(
      () =>
        new ProcessVersionsStore(
          x.h.db,
          "TEST-other-server",
          x.h.registry,
        ).read(admin, x.command.requestId),
      code("process_freeze_not_found"),
    );
    const before = x.counts();
    const noOp = x.store.freeze(admin, {
      ...x.command,
      requestId: "TEST-no-op",
      revision: receipt.resultingRevision,
    });
    assert.equal(noOp.version, receipt.version);
    assert.equal(noOp.resultingRevision, receipt.resultingRevision);
    assert.equal(noOp.artifactDigest, receipt.artifactDigest);
    assert.deepEqual(x.counts(), {
      ...before,
      agent_process_freeze_command:
        Number(before.agent_process_freeze_command) + 1,
    });
  }));

test("freeze, registry revision, audit and receipt commit atomically on both audit and receipt failures", () =>
  setup((x) => {
    for (const [table, message] of [
      ["agent_audit", "TEST-audit-failed"],
      ["agent_process_freeze_command", "TEST-receipt-failed"],
    ] as const) {
      const before = x.counts();
      x.h.db.exec(
        `CREATE TRIGGER test_freeze_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'${message}'); END;`,
      );
      try {
        assert.throws(
          () => x.store.freeze(admin, x.command),
          new RegExp(message),
        );
      } finally {
        x.h.db.exec("DROP TRIGGER test_freeze_failure");
      }
      assert.deepEqual(x.h.registry.get(admin, x.draft.id), x.draft);
      assert.deepEqual(x.counts(), before);
      assert.throws(
        () => x.store.read(admin, x.command.requestId),
        code("process_freeze_not_found"),
      );
    }
    assert.equal(x.store.freeze(admin, x.command).version, 1);
  }));

test("immutable history uses bounded descending numeric keysets without loading every historic version", () =>
  setup((x) => {
    let current = x.draft;
    for (let i = 1; i <= 25; i++) {
      x.store.freeze(admin, {
        ...x.command,
        revision: current.revision,
        requestId: "TEST-freeze-page-" + i,
      });
      current = x.h.registry.get(admin, current.id);
      if (i < 25)
        current = x.h.registry.saveDraft(admin, {
          id: current.id,
          serviceId: current.serviceId,
          revision: current.revision,
          definition: { ...current.draft, name: "TEST version " + (i + 1) },
        });
    }
    const first = x.store.list(admin, x.query());
    assert.deepEqual(
      first.versions.map((v) => v.version),
      Array.from({ length: 20 }, (_, i) => 25 - i),
    );
    assert.equal(first.nextBefore, 6);
    const last = x.store.list(admin, x.query({ before: first.nextBefore }));
    assert.deepEqual(
      last.versions.map((v) => v.version),
      [5, 4, 3, 2, 1],
    );
    assert.equal(last.nextBefore, null);
    assert.equal(
      x.store.list(admin, x.query({ before: 1 })).versions.length,
      0,
    );
    x.h.db
      .prepare(
        `INSERT INTO agent_service_process_version SELECT process_id,?,definition,sources,digest,created_at,created_by FROM agent_service_process_version WHERE process_id=? AND version=25`,
      )
      .run(Number.MAX_SAFE_INTEGER - 1, current.id);
    const before = x.counts();
    assert.deepEqual(
      x.store.list(admin, x.query({ limit: 2 })).versions.map((v) => v.version),
      [Number.MAX_SAFE_INTEGER - 1, 25],
    );
    assert.deepEqual(x.counts(), before);
    assert.throws(
      () => x.store.list({ ...admin, role: "member" }, x.query()),
      code("identity_forbidden"),
    );
    assert.throws(
      () => x.store.list(admin, x.query({ processId: "TEST-missing" })),
      code("process_not_found"),
    );
  }));
