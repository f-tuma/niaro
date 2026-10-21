import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  emptyDesignBrief,
  DesignUpdateSchema,
} from "../packages/protocol/process-design";
import {
  ProcessDesignStore,
  assertDesignContent,
} from "../apps/server-identity/process-design-store";
import { IdentityError } from "../apps/server-identity/error";
import { processDigest } from "../apps/server-identity/process-validation";
import { processDesignDiff } from "../apps/server-identity/process-design-diff";
import { ServiceCatalogStore } from "../apps/server-identity/service-catalog";
import { WorkspacePluginStore } from "../apps/server-identity/workspace-plugins";
import { ServiceProcessStore } from "../apps/server-identity/service-processes";
import { AuditStore } from "../apps/server-identity/audit";
import {
  designFixture,
  designTarget as target,
  designActor as actor,
} from "./helpers/process-design";

const code = (expected: string) => (error: unknown) =>
  error instanceof IdentityError && error.code === expected;
const brief = () => ({
  ...emptyDesignBrief(),
  purpose: "Find a TEST contact with configured capabilities",
});
const start = (h: ReturnType<typeof designFixture>, extra: object = {}) =>
  h.store.start(actor, {
    ...target,
    requestId: "TEST-start",
    serviceId: h.serviceId,
    ...extra,
  });
function propose(
  h: ReturnType<typeof designFixture>,
  id: string,
  extra: object = {},
) {
  const revision = h.store.get(actor, id).revision;
  return h.store.update(actor, {
    ...target,
    sessionId: id,
    requestId: "TEST-update-" + revision,
    revision,
    brief: brief(),
    candidate: h.workflow(),
    ...extra,
  });
}
function accept(
  h: ReturnType<typeof designFixture>,
  id: string,
  extra: object = {},
) {
  const review = h.store.get(actor, id);
  return h.store.accept(actor, {
    ...target,
    sessionId: id,
    requestId: "TEST-accept",
    revision: review.revision,
    reviewDigest: review.reviewDigest,
    ...extra,
  });
}
const count = (db: DatabaseSync, table: string) =>
  Number(db.prepare("SELECT COUNT(*) AS count FROM " + table).get()!.count);

test("incomplete proposals survive database reopen independently of the executable registry", () => {
  const dir = mkdtempSync(join(tmpdir(), "niaro-design-store-")),
    path = join(dir, "identity.sqlite");
  const h = designFixture(path);
  try {
    const initial = start(h),
      id = initial.sessionId;
    const b = {
      ...brief(),
      questions: [{ id: "output", text: "Which result should be returned?" }],
    };
    propose(h, id, { brief: b, candidate: null });
    assert.equal(count(h.db, "agent_service_process"), 0);
    const before = h.store.get(actor, id);
    assert(before.blockers.includes("candidate_missing"));
    assert(before.blockers.includes("questions_unresolved"));
    h.db.close();
    const db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys=ON");
    try {
      const catalog = new ServiceCatalogStore(
          db,
          "TEST-only-encryption-secret",
          [],
        ),
        plugins = new WorkspacePluginStore(db, {
          enabled: ["memory"],
          timeZone: "UTC",
        });
      const audit = new AuditStore(db),
        registry = new ServiceProcessStore(db, catalog, plugins, (r) => {
          audit.append(r);
        });
      const reopened = new ProcessDesignStore(db, registry, catalog, plugins);
      assert.deepEqual(reopened.get(actor, id), before);
      assert.deepEqual(
        reopened.start(actor, {
          ...target,
          requestId: "TEST-start",
          serviceId: h.serviceId,
        }),
        initial,
      );
      assert.equal(count(db, "agent_process_design"), 1);
      assert.equal(count(db, "agent_service_invocation"), 0);
      assert.equal(count(db, "agent_service_process_version"), 0);
    } finally {
      db.close();
    }
  } finally {
    if (h.db.isOpen) h.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("proposal commands have exact canonical replay, conflicting identities and revision CAS", () => {
  const h = designFixture();
  try {
    const initial = start(h),
      id = initial.sessionId;
    const input = {
      ...target,
      sessionId: id,
      requestId: "TEST-update",
      revision: 1,
      brief: brief(),
      candidate: h.workflow(),
    };
    const saved = h.store.update(actor, input);
    assert.deepEqual(
      h.store.update(actor, {
        candidate: input.candidate,
        brief: input.brief,
        revision: 1,
        requestId: "TEST-update",
        sessionId: id,
        ...target,
      }),
      saved,
    );
    assert.throws(
      () =>
        h.store.update(actor, {
          ...input,
          brief: { ...brief(), purpose: "Different" },
        }),
      code("process_design_command_conflict"),
    );
    assert.throws(
      () => h.store.update(actor, { ...input, requestId: "TEST-stale" }),
      code("process_design_conflict"),
    );
    assert.throws(
      () =>
        h.store.acknowledge(actor, {
          ...target,
          sessionId: id,
          requestId: "TEST-update",
          revision: 2,
          assumptions: [],
        }),
      code("process_design_command_conflict"),
    );
    assert.equal(h.store.get(actor, id).revision, 2);
    assert.equal(count(h.db, "agent_process_design_command"), 2);
  } finally {
    h.db.close();
  }
});

test("creator private scope and fresh management authority protect reads and mutation replay", () => {
  const h = designFixture();
  try {
    const initial = start(h),
      id = initial.sessionId;
    for (const other of [
      { ...actor, userId: "TEST-another-admin", role: "admin" as const },
      {
        ...actor,
        organizationId: "TEST-other-org",
        workspaceId: "22222222-2222-4222-8222-222222222222",
      },
    ]) {
      assert.throws(
        () => h.store.get(other, id),
        code("process_design_not_found"),
      );
      assert.throws(
        () =>
          h.store.update(other, {
            ...target,
            sessionId: id,
            requestId: "TEST-update",
            revision: 1,
            brief: brief(),
            candidate: null,
          }),
        code("process_design_not_found"),
      );
    }
    const member = { ...actor, role: "member" as const };
    assert.throws(() => h.store.get(member, id), code("identity_forbidden"));
    assert.throws(
      () =>
        h.store.start(member, {
          ...target,
          requestId: "TEST-start",
          serviceId: h.serviceId,
        }),
      code("identity_forbidden"),
    );
    assert.throws(
      () =>
        h.store.start(actor, {
          ...target,
          workspaceId: "22222222-2222-4222-8222-222222222222",
          requestId: "TEST-wrong",
          serviceId: h.serviceId,
        }),
      code("process_design_not_found"),
    );
  } finally {
    h.db.close();
  }
});

test("semantic invalid candidates remain inspectable, questions and malformed updates cannot create drafts", () => {
  const h = designFixture();
  try {
    const id = start(h).sessionId;
    const candidate = h.workflow();
    if (candidate.kind !== "workflow") throw Error("fixture");
    candidate.steps[0] = {
      ...candidate.steps[0]!,
      next: "missing",
    } as (typeof candidate.steps)[number];
    propose(h, id, { candidate });
    const review = h.store.get(actor, id);
    assert(!review.validation.valid);
    assert(review.validation.issues.some((i) => i.code === "graph_invalid"));
    assert.throws(() => accept(h, id), code("process_design_not_ready"));
    assert.throws(() =>
      h.store.update(actor, {
        ...target,
        sessionId: id,
        requestId: "TEST-malformed",
        revision: 2,
        brief: brief(),
        candidate: { kind: "agent" },
      }),
    );
    propose(h, id, {
      brief: {
        ...brief(),
        questions: [{ id: "rule", text: "TEST unresolved rule" }],
      },
    });
    assert.throws(() => accept(h, id), code("process_design_not_ready"));
    assert.equal(count(h.db, "agent_service_process"), 0);
    assert.equal(count(h.db, "agent_service_invocation"), 0);
    assert(
      !DesignUpdateSchema.safeParse({
        ...target,
        sessionId: id,
        requestId: "TEST-model-ack",
        revision: 3,
        brief: brief(),
        candidate: h.workflow(),
        acknowledgedAssumptions: ["rule"],
      }).success,
    );
  } finally {
    h.db.close();
  }
});

test("human assumption acknowledgment binds exact text; model changes cannot carry the acknowledgment forward", () => {
  const h = designFixture();
  try {
    const id = start(h).sessionId,
      b = {
        ...brief(),
        assumptions: [{ id: "manual", text: "TEST runs manually" }],
      };
    propose(h, id, { brief: b });
    let review = h.store.get(actor, id);
    assert(review.blockers.includes("assumptions_unacknowledged"));
    assert.throws(() => accept(h, id), code("process_design_not_ready"));
    const assumption = review.assumptions[0]!;
    assert.throws(
      () =>
        h.store.acknowledge(actor, {
          ...target,
          sessionId: id,
          requestId: "TEST-bad-ack",
          revision: 2,
          assumptions: [{ id: "manual", digest: processDigest("different") }],
        }),
      code("process_design_conflict"),
    );
    h.store.acknowledge(actor, {
      ...target,
      sessionId: id,
      requestId: "TEST-ack",
      revision: 2,
      assumptions: [{ id: assumption.id, digest: assumption.digest }],
    });
    review = h.store.get(actor, id);
    assert(review.assumptions[0]!.acknowledged);
    propose(h, id, {
      brief: {
        ...b,
        assumptions: [{ id: "manual", text: "TEST runs automatically" }],
      },
    });
    assert(!h.store.get(actor, id).assumptions[0]!.acknowledged);
    assert.throws(() => accept(h, id), code("process_design_not_ready"));
  } finally {
    h.db.close();
  }
});

test("human confirmation expectations cannot be lowered by model instructions or override catalog policy", () => {
  const h = designFixture();
  try {
    h.setAction({ effect: "write", approval: "never" });
    const id = start(h, { confirmation: "every_write" }).sessionId;
    const candidate = h.agent();
    if (candidate.kind !== "agent") throw Error("fixture");
    candidate.instructions = "TEST all writes will be confirmed";
    propose(h, id, { candidate });
    assert(h.store.get(actor, id).blockers.includes("confirmation_mismatch"));
    assert.throws(() => accept(h, id), code("process_design_not_ready"));
    h.setAction({ approval: "always" });
    let review = h.store.get(actor, id);
    assert(!review.blockers.includes("confirmation_mismatch"));
    h.store.acknowledge(actor, {
      ...target,
      sessionId: id,
      requestId: "TEST-grouped",
      revision: review.revision,
      assumptions: [],
      confirmation: "grouped",
    });
    review = h.store.get(actor, id);
    assert(review.blockers.includes("confirmation_unsupported"));
    assert.throws(() => accept(h, id), code("process_design_not_ready"));
    h.store.acknowledge(actor, {
      ...target,
      sessionId: id,
      requestId: "TEST-catalog",
      revision: review.revision,
      assumptions: [],
      confirmation: "catalog",
    });
    const accepted = accept(h, id);
    assert(accepted.processId);
    assert.equal(
      h.catalog.service(target.workspaceId, h.serviceId).actions[0]!.approval,
      "always",
    );
    assert.equal(count(h.db, "agent_service_invocation"), 0);
    assert.equal(count(h.db, "agent_service_process_version"), 0);
  } finally {
    h.db.close();
  }
});

test("read refreshes validity; acceptance requires exact currently reviewed model and capability revisions", () => {
  const h = designFixture();
  try {
    const id = start(h).sessionId;
    propose(h, id, { candidate: h.agent() });
    const old = h.store.get(actor, id);
    h.command({
      type: "saveModel",
      id: h.modelId,
      revision: 1,
      settings: {
        providerId: h.providerId,
        name: "TEST renamed model",
        model: "TEST-tools",
        tools: true,
        enabled: true,
      },
    });
    assert(h.store.get(actor, id).validation.valid);
    assert.throws(
      () => accept(h, id, { reviewDigest: old.reviewDigest }),
      code("process_design_review_changed"),
    );
    h.setAction({ enabled: false });
    let current = h.store.get(actor, id);
    assert(!current.validation.valid);
    assert(current.blockers.includes("capability_unavailable"));
    assert.throws(() => accept(h, id), code("process_design_not_ready"));
    h.setAction({ enabled: true, policy: { roles: ["member"], users: [] } });
    current = h.store.get(actor, id);
    assert(current.blockers.includes("capability_unavailable"));
    assert(
      current.validation.issues.some((i) => i.code === "capability_denied"),
    );
    assert.equal(count(h.db, "agent_service_process"), 0);
  } finally {
    h.db.close();
  }
});

test("unsupported credential-bearing action schema blocks even an otherwise valid agent proposal", () => {
  const h = designFixture();
  try {
    h.setAction({
      inputSchema: {
        type: "object",
        properties: { password: { type: "string" } },
        required: ["password"],
        additionalProperties: false,
      },
    });
    const id = start(h).sessionId;
    propose(h, id, { candidate: h.agent() });
    const review = h.store.get(actor, id);
    assert(review.validation.valid);
    assert(review.blockers.includes("capability_schema_unavailable"));
    assert.throws(() => accept(h, id), code("process_design_not_ready"));
  } finally {
    h.db.close();
  }
});

test("draft/version comparison baseline is fixed and registry edits require a new review session", () => {
  const h = designFixture();
  try {
    const original = h.registry.saveDraft(actor, {
      serviceId: h.serviceId,
      revision: 0,
      definition: h.workflow(),
    });
    const version = h.registry.freezeDraft(
      actor,
      original.id,
      original.revision,
    );
    let current = h.registry.get(actor, original.id);
    const edited = { ...current.draft, name: "TEST edited draft" };
    current = h.registry.saveDraft(actor, {
      id: current.id,
      serviceId: h.serviceId,
      revision: current.revision,
      definition: edited,
    });
    const id = start(h, {
      processId: current.id,
      baselineVersion: version.version,
    }).sessionId;
    let review = h.store.get(actor, id);
    assert.equal(review.baseline!.definition.name, "TEST lookup");
    assert.equal(review.candidate!.name, "TEST edited draft");
    assert(
      review.changes.some(
        (c) => c.path === "/name" && c.after === "TEST edited draft",
      ),
    );
    h.registry.saveDraft(actor, {
      id: current.id,
      serviceId: h.serviceId,
      revision: current.revision,
      definition: { ...current.draft, name: "TEST concurrent admin" },
    });
    review = h.store.get(actor, id);
    assert(review.blockers.includes("registry_changed"));
    assert.equal(review.baseline!.registryRevision, current.revision);
    assert.equal(review.candidate!.name, "TEST edited draft");
    assert.throws(() => accept(h, id), code("process_design_not_ready"));
    assert.equal(
      h.registry.get(actor, current.id).draft.name,
      "TEST concurrent admin",
    );
  } finally {
    h.db.close();
  }
});

test("freezing the process during a design conversation does not end it; accept saves onto the current revision", () => {
  const h = designFixture();
  try {
    const original = h.registry.saveDraft(actor, {
      serviceId: h.serviceId,
      revision: 0,
      definition: h.workflow(),
    });
    const id = start(h, { processId: original.id }).sessionId;
    propose(h, id, {
      candidate: { ...h.workflow(), name: "TEST designed rename" },
    });
    // Another tab freezes the unchanged draft: revision moves, draft does not.
    h.registry.freezeDraft(actor, original.id, original.revision);
    const frozen = h.registry.get(actor, original.id);
    assert.notEqual(frozen.revision, original.revision);
    const review = h.store.get(actor, id);
    assert(!review.blockers.includes("registry_changed"));
    const result = accept(h, id);
    assert.equal(result.processId, original.id);
    const saved = h.registry.get(actor, original.id);
    assert.equal(saved.draft.name, "TEST designed rename");
    assert.equal(saved.revision, frozen.revision + 1);
  } finally {
    h.db.close();
  }
});

test("explicit acceptance, audit and immutable receipt commit atomically and never activate or dispatch", () => {
  const h = designFixture();
  try {
    const id = start(h).sessionId;
    propose(h, id);
    const revision = h.store.get(actor, id).revision;
    h.failAudit();
    assert.throws(() => accept(h, id), /TEST audit rollback/);
    assert.equal(count(h.db, "agent_service_process"), 0);
    assert.equal(count(h.db, "agent_audit"), 0);
    assert.equal(h.store.get(actor, id).revision, revision);
    assert.equal(count(h.db, "agent_process_design_command"), 2);
    h.restoreAudit();
    const review = h.store.get(actor, id),
      request = {
        ...target,
        sessionId: id,
        requestId: "TEST-accept",
        revision: review.revision,
        reviewDigest: review.reviewDigest,
      };
    const result = h.store.accept(actor, request);
    assert.deepEqual(h.store.accept(actor, request), result);
    assert.equal(count(h.db, "agent_service_process"), 1);
    assert.equal(count(h.db, "agent_audit"), 1);
    assert.equal(count(h.db, "agent_service_process_version"), 0);
    assert.equal(count(h.db, "agent_service_invocation"), 0);
    assert.equal(h.registry.get(actor, result.processId!).activeVersion, null);
    assert.throws(() => propose(h, id), code("process_design_conflict"));
    assert.throws(
      () =>
        h.store.accept(actor, {
          ...request,
          requestId: "TEST-second-save",
          revision: result.revision,
        }),
      code("process_design_conflict"),
    );
  } finally {
    h.db.close();
  }
});

test("server custom limits and credential ingestion boundaries are explicit before persistence", () => {
  const h = designFixture(":memory:", { maxSteps: 1 });
  try {
    const id = start(h).sessionId;
    propose(h, id);
    const review = h.store.get(actor, id);
    assert(review.validation.issues.some((i) => i.path === "/limits/maxSteps"));
    assert.throws(() => accept(h, id), code("process_design_not_ready"));
    for (const purpose of [
      "Bearer TESTsecretpayloadvalue",
      "sk-proj-TESTabcdefghijklmnop",
      "https://test:secret@services.example.test",
      "-----BEGIN PRIVATE KEY----- TEST",
    ]) {
      assert.throws(
        () => propose(h, id, { brief: { ...brief(), purpose } }),
        code("process_design_sensitive_content"),
      );
    }
    assert.throws(
      () => assertDesignContent({ password: "TEST plain credential" }),
      code("process_design_sensitive_content"),
    );
    assert.throws(
      () => assertDesignContent({ nested: "x".repeat(65537) }),
      code("process_design_content_limit"),
    );
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    assert.throws(
      () => assertDesignContent(cycle),
      code("process_design_content_limit"),
    );
    assert.equal(h.store.get(actor, id).revision, 2);
    assert.equal(count(h.db, "agent_process_design_command"), 2);
    assert(
      !JSON.stringify(review).includes("TEST-configured-key-never-project"),
    );
    assert(!JSON.stringify(review).includes("TEST-provider-key-never-project"));
  } finally {
    h.db.close();
  }
});

test("semantic step diff uses stable IDs and catches bindings while harmless ordering has no changes", () => {
  assert.deepEqual(processDesignDiff(null, null), {
    changes: [],
    changesTruncated: false,
  });
  const h = designFixture();
  try {
    const before = h.workflow();
    if (before.kind !== "workflow") throw Error("fixture");
    const reordered = { ...before, steps: [...before.steps].reverse() };
    assert.deepEqual(processDesignDiff(before, reordered), {
      changes: [],
      changesTruncated: false,
    });
    const after = structuredClone(before),
      step = after.steps.find((s) => s.type === "action")!;
    if (step.type !== "action") throw Error("fixture");
    step.input.name = { source: "literal", value: "TEST new input" };
    const diff = processDesignDiff(before, after);
    assert(
      diff.changes.some(
        (c) =>
          c.path === "/steps/lookup/input/name/source" &&
          c.before === "input" &&
          c.after === "literal",
      ),
    );
    assert(
      diff.changes.some(
        (c) =>
          c.path === "/steps/lookup/input/name/value" && c.kind === "added",
      ),
    );
    const added = processDesignDiff(null, before);
    assert(
      added.changes.some(
        (c) => c.path === "/steps/lookup/actionId" && c.kind === "added",
      ),
    );
    const nullable = structuredClone(before),
      literal = nullable.steps.find((s) => s.type === "action")!;
    if (literal.type !== "action") throw Error("fixture");
    literal.input.name = { source: "literal", value: null };
    const nonnull = structuredClone(nullable),
      changed = nonnull.steps.find((s) => s.type === "action")!;
    if (changed.type !== "action") throw Error("fixture");
    changed.input.name = { source: "literal", value: "TEST value" };
    assert(
      processDesignDiff(nullable, nonnull).changes.some(
        (c) =>
          c.path === "/steps/lookup/input/name/value" &&
          c.kind === "changed" &&
          c.before === "null",
      ),
    );
  } finally {
    h.db.close();
  }
});

test("diff previews report truncation even when the change count stays below its cap", () => {
  const h = designFixture();
  try {
    const before = h.agent();
    const after = {
      ...before,
      instructions: "TEST changed instructions ".repeat(100),
    };
    const diff = processDesignDiff(before, after);
    assert.equal(diff.changes.length, 1);
    assert.equal(diff.changesTruncated, true);
    assert.equal(diff.changes[0]?.after?.endsWith("…"), true);
  } finally {
    h.db.close();
  }
});

test("existing active version survives draft acceptance and audit rollback without changing immutable artifacts", () => {
  const h = designFixture();
  try {
    const created = h.registry.saveDraft(actor, {
      serviceId: h.serviceId,
      revision: 0,
      definition: h.workflow(),
    });
    const frozen = h.registry.freezeDraft(actor, created.id, created.revision);
    h.registry.recordTest(actor, created.id, frozen.version, {
      testId: "TEST-offline-acceptance",
      digest: frozen.digest,
      runnerVersion: "TEST-synthetic/1",
      passed: true,
      scenarios: [
        "success",
        "rejection",
        "missing_input",
        "failure",
        "unknown",
        "restart",
      ],
      reportDigest: processDigest("TEST-report"),
    });
    let record = h.registry.get(actor, created.id);
    h.registry.activate(actor, created.id, record.revision, frozen.version);
    record = h.registry.get(actor, created.id);
    const id = start(h, { processId: record.id }).sessionId;
    propose(h, id, {
      candidate: { ...record.draft, name: "TEST new designer draft" },
    });
    const before = h.store.get(actor, id),
      auditCount = count(h.db, "agent_audit");
    h.failAudit();
    assert.throws(() => accept(h, id), /TEST audit rollback/);
    assert.deepEqual(h.registry.get(actor, created.id), record);
    assert.deepEqual(h.store.get(actor, id), before);
    assert.equal(count(h.db, "agent_audit"), auditCount);
    h.restoreAudit();
    const receipt = accept(h, id);
    const saved = h.registry.get(actor, receipt.processId!);
    assert.equal(saved.activeVersion, frozen.version);
    assert.equal(saved.draft.name, "TEST new designer draft");
    assert.deepEqual(
      h.registry.version(actor, created.id, frozen.version).definition,
      frozen.definition,
    );
    assert.equal(count(h.db, "agent_service_process_version"), 1);
    assert.equal(count(h.db, "agent_service_invocation"), 0);
  } finally {
    h.db.close();
  }
});

test("accepted metadata receipt replays after restart and capability revocation without a second save or audit", () => {
  const dir = mkdtempSync(join(tmpdir(), "niaro-design-receipt-")),
    path = join(dir, "identity.sqlite"),
    h = designFixture(path);
  try {
    const id = start(h).sessionId;
    propose(h, id);
    const review = h.store.get(actor, id),
      input = {
        ...target,
        sessionId: id,
        requestId: "TEST-accept",
        revision: review.revision,
        reviewDigest: review.reviewDigest,
      };
    const accepted = h.store.accept(actor, input);
    h.setAction({ enabled: false });
    const auditCount = count(h.db, "agent_audit");
    h.db.close();
    const db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys=ON");
    try {
      const catalog = new ServiceCatalogStore(
          db,
          "TEST-only-encryption-secret",
          [],
        ),
        plugins = new WorkspacePluginStore(db, {
          enabled: ["memory"],
          timeZone: "UTC",
        }),
        audit = new AuditStore(db),
        registry = new ServiceProcessStore(db, catalog, plugins, (r) => {
          audit.append(r);
        }),
        store = new ProcessDesignStore(db, registry, catalog, plugins);
      assert.deepEqual(store.accept(actor, input), accepted);
      assert.equal(count(db, "agent_audit"), auditCount);
      assert.equal(count(db, "agent_service_process"), 1);
      assert.equal(count(db, "agent_service_invocation"), 0);
      assert(!store.get(actor, id).validation.valid);
      assert.throws(
        () => store.accept({ ...actor, role: "member" }, input),
        code("identity_forbidden"),
      );
      assert.throws(
        () =>
          store.accept(
            { ...actor, userId: "TEST-other-admin", role: "admin" },
            input,
          ),
        code("process_design_not_found"),
      );
    } finally {
      db.close();
    }
  } finally {
    if (h.db.isOpen) h.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("safe frozen comparison cannot ingest a credential-bearing current draft", () => {
  const h = designFixture();
  try {
    const created = h.registry.saveDraft(actor, {
        serviceId: h.serviceId,
        revision: 0,
        definition: h.agent(),
      }),
      frozen = h.registry.freezeDraft(actor, created.id, created.revision),
      current = h.registry.get(actor, created.id);
    const draft = {
      ...current.draft,
      instructions: "Bearer TESTlegacycredentialvalue",
    };
    h.registry.saveDraft(actor, {
      id: current.id,
      serviceId: h.serviceId,
      revision: current.revision,
      definition: draft,
    });
    assert.throws(
      () =>
        start(h, { processId: current.id, baselineVersion: frozen.version }),
      code("process_design_sensitive_content"),
    );
    assert.equal(count(h.db, "agent_process_design"), 0);
    assert.equal(count(h.db, "agent_process_design_command"), 0);
  } finally {
    h.db.close();
  }
});

test("proposal updates cannot supply human confirmation, actor or baseline authority", () => {
  const h = designFixture();
  try {
    const id = start(h).sessionId,
      input = {
        ...target,
        sessionId: id,
        requestId: "TEST-model-injection",
        revision: 1,
        brief: brief(),
        candidate: h.agent(),
      };
    for (const extra of [
      { confirmation: "catalog" },
      { userId: actor.userId },
      { baseline: null },
      { acceptedProcessId: "TEST-fake-acceptance" },
    ])
      assert.throws(() => h.store.update(actor, { ...input, ...extra }));
    assert.equal(h.store.get(actor, id).revision, 1);
    assert.equal(count(h.db, "agent_process_design_command"), 1);
  } finally {
    h.db.close();
  }
});

test("dependency revision diff is distinct from definition diff and never invents unavailable source history", () => {
  const h = designFixture();
  try {
    const created = h.registry.saveDraft(actor, {
        serviceId: h.serviceId,
        revision: 0,
        definition: h.agent(),
      }),
      id = start(h, { processId: created.id }).sessionId;
    const before = h.store.get(actor, id);
    assert.equal(before.dependencyComparison, "recorded");
    assert.deepEqual(before.dependencyChanges, []);
    assert.deepEqual(before.changes, []);
    h.command({
      type: "saveModel",
      id: h.modelId,
      revision: 1,
      settings: {
        providerId: h.providerId,
        name: "TEST model revision2",
        model: "TEST-tools",
        tools: true,
        enabled: true,
      },
    });
    const changed = h.store.get(actor, id);
    assert.deepEqual(changed.changes, []);
    assert(
      changed.dependencyChanges.some(
        (c) =>
          c.kind === "model" &&
          c.id === h.modelId &&
          c.beforeRevision === 1 &&
          c.afterRevision === 2,
      ),
    );
    assert.throws(
      () => accept(h, id, { reviewDigest: before.reviewDigest }),
      code("process_design_review_changed"),
    );
    h.setAction({ enabled: false });
    const invalid = h.store.get(actor, id);
    assert.equal(invalid.dependencyComparison, "unavailable");
    assert.deepEqual(invalid.dependencyChanges, []);
    assert.equal(invalid.validation.sources, null);
    assert.equal(
      invalid.baselineSources!.resources.find((r) => r.kind === "model")!
        .revision,
      1,
    );
  } finally {
    h.db.close();
  }
});

test("a service used by saved processes cannot be removed; an unused one can", () => {
  const remove = (h: ReturnType<typeof designFixture>) =>
    h.command({
      type: "removeService",
      id: h.serviceId,
      revision: h.catalog.service(target.workspaceId, h.serviceId).revision,
    });
  // Owned by the service.
  let h = designFixture();
  try {
    h.registry.saveDraft(actor, {
      serviceId: h.serviceId,
      revision: 0,
      definition: h.workflow(),
    });
    assert.throws(() => remove(h), code("catalog_service_in_use"));
    assert(h.catalog.service(target.workspaceId, h.serviceId));
  } finally {
    h.db.close();
  }
  // A workspace process that calls one of its actions.
  h = designFixture();
  try {
    h.registry.saveWorkspaceDraft(actor, {
      revision: 0,
      definition: h.agent(),
    });
    assert.throws(() => remove(h), code("catalog_service_in_use"));
  } finally {
    h.db.close();
  }
  h = designFixture();
  try {
    assert.equal(remove(h), h.serviceId);
  } finally {
    h.db.close();
  }
});
