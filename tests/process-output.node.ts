import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessDefinitionSchema } from "../packages/protocol/service-processes";
import {
  PROCESS_OUTPUT_PROFILE,
  PROCESS_OUTPUT_REDACTION_VERSION,
  PROCESS_OUTPUT_MAX_PAGE_BYTES,
  ProcessOutputReferenceSchema,
  ProcessOutputPageSchema,
  type ProcessOutputPath,
} from "../packages/protocol/process-output";
import { processDigest } from "../apps/server-identity/process-validation";
import {
  sanitizeProcessOutput,
  pageProcessOutput,
  prepareProcessOutput,
  readProcessOutput,
} from "../apps/server-identity/process-output";
import { createProcessReadWindow } from "../apps/server-identity/process-read-window";
import { createCatalogRuntime } from "../apps/server-identity/catalog-runtime";
import { CONTACT_CONTEXT_TTL } from "../apps/server-identity/contact-context";
import { createProcessTaskProjection } from "../apps/server-identity/process-work-items";
import { JournalSchema } from "../apps/server-identity/service-process-journal";
import { startFixture } from "./helpers/process-start";
import { scope, admin, signal, code } from "./helpers/service-process-runtime";
import { processAgent } from "./helpers/service-process-agent";
import { processObject } from "./helpers/service-process";
import type { AgentMemory } from "../apps/server-identity/agent-memory";
import { translate } from "../packages/i18n";

const reference = ProcessOutputReferenceSchema.parse({
  profile: PROCESS_OUTPUT_PROFILE,
  scope,
  parentRunId: "TEST-parent",
  nativeRevision: 1,
  provenance: {
    runId: "TEST-run",
    processId: "TEST-process",
    version: 1,
    artifactDigest: "a".repeat(64),
    actorId: scope.userId,
    conversationId: "conversation-1",
    commandId: "TEST-command",
    admissionId: "TEST-admission",
  },
  origin: {
    type: "command",
    conversationId: "conversation-1",
    requestId: "TEST-menu",
  },
  outputDigest: "b".repeat(64),
  redactionVersion: PROCESS_OUTPUT_REDACTION_VERSION,
});

test("safe tree redacts sensitive keys and descendants before sorting or digest, including collisions and expanding markers", () => {
  const raw = {
    api_key_TEST_PLAINTEXT_SECRET: { innocuous: "TEST hidden" },
    password: false,
    nested: { clientSecret: 0, safe: "Bearer x ".repeat(444) },
    empty: "",
    n: null,
    f: false,
    z: 0,
    a: [],
    o: {},
  };
  const first = sanitizeProcessOutput(raw);
  const second = sanitizeProcessOutput({
    ...raw,
    api_key_TEST_PLAINTEXT_SECRET: { innocuous: "different secret" },
    password: "another secret",
  });
  assert.equal(first.redacted, true);
  assert.equal(processDigest(first.tree), processDigest(second.tree));
  assert.doesNotMatch(
    JSON.stringify(first.tree),
    /PLAINTEXT_SECRET|TEST hidden|different secret|another secret|Bearer x/,
  );
  assert(first.tree.kind === "object");
  assert.equal(
    first.tree.children.filter((c) => c.label === "[redacted field]").length,
    2,
  );
  const scalars = first.tree.children.map((c) => c.node);
  assert(scalars.some((n) => n.kind === "string" && n.value === ""));
  assert(scalars.some((n) => n.kind === "boolean" && n.value === false));
  assert(scalars.some((n) => n.kind === "number" && n.value === 0));
  assert(scalars.some((n) => n.kind === "null"));
});

test("actual UTF8 and escaped page caps dynamically stop wide full 4000-character leaves with exact progress", () => {
  const value = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [
      "field" + i.toString().padStart(2, "0"),
      "\u0000".repeat(4000),
    ]),
  );
  const { tree } = sanitizeProcessOutput(value);
  let cursor: string | null = null,
    offset = 0,
    pages = 0;
  do {
    const page = pageProcessOutput(tree, { reference, path: [], cursor });
    assert.equal(page.offset, offset);
    assert.equal(page.total, 40);
    assert(page.children.length > 0 && page.children.length < 16);
    assert(
      Buffer.byteLength(JSON.stringify(page)) <= PROCESS_OUTPUT_MAX_PAGE_BYTES,
    );
    for (const child of page.children) {
      assert(child.node.kind === "string");
      assert.equal(child.node.value, "\u0000".repeat(4000));
    }
    offset += page.children.length;
    cursor = page.nextCursor;
    pages++;
  } while (cursor);
  assert.equal(offset, 40);
  assert(pages > 1);
  const leaf = pageProcessOutput(tree, {
    reference,
    path: [{ kind: "property", index: 39 }],
    cursor: null,
  });
  assert.equal(leaf.nextCursor, null);
  assert.equal(leaf.children.length, 0);
  assert(leaf.node.kind === "string");
  assert.equal(leaf.node.value.length, 4000);
});

test("pagination reaches 5000 leaves and 64-character keys without start-envelope limits or false complete containers", () => {
  const raw = {
    ["K".repeat(64)]: Array.from({ length: 50 }, () =>
      Array.from({ length: 100 }, () => "🧪".repeat(50)),
    ),
  };
  const { tree } = sanitizeProcessOutput(raw);
  let leaves = 0;
  const walk = (path: ProcessOutputPath) => {
    let cursor: string | null = null;
    do {
      const page = pageProcessOutput(tree, { reference, path, cursor });
      if (page.node.kind !== "object" && page.node.kind !== "array") {
        leaves++;
        return;
      }
      for (const child of page.children) {
        if (child.node.kind === "object" || child.node.kind === "array")
          walk([
            ...path,
            {
              kind: page.node.kind === "object" ? "property" : "item",
              index: child.index,
            },
          ]);
        else {
          assert(child.node.kind === "string");
          assert.equal(child.node.value, "🧪".repeat(50));
          leaves++;
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
  };
  walk([]);
  assert.equal(leaves, 5000);
  assert(Buffer.byteLength(JSON.stringify(raw)) > 65536);
  const empty = pageProcessOutput(sanitizeProcessOutput({}).tree, {
    reference,
    path: [],
    cursor: null,
  });
  assert.deepEqual(empty.node, { kind: "object", childCount: 0 });
  assert.equal(empty.total, 0);
  assert.equal(empty.nextCursor, null);
});

test("cursors bind path and full reference and malformed partial pages cannot claim completion", () => {
  const { tree } = sanitizeProcessOutput({
    list: Array.from({ length: 100 }, () => 0),
  });
  const first = pageProcessOutput(tree, {
    reference,
    path: [{ kind: "property", index: 0 }],
    cursor: null,
  });
  assert(first.nextCursor);
  assert.throws(
    () =>
      pageProcessOutput(tree, {
        reference,
        path: [],
        cursor: first.nextCursor,
      }),
    code("process_output_cursor_invalid"),
  );
  assert.throws(
    () =>
      pageProcessOutput(tree, {
        reference: { ...reference, nativeRevision: 2 },
        path: first.path,
        cursor: first.nextCursor,
      }),
    code("process_output_cursor_invalid"),
  );
  assert.equal(
    ProcessOutputPageSchema.safeParse({
      ...first,
      children: [],
      nextCursor: null,
    }).success,
    false,
  );
  assert.throws(
    () =>
      pageProcessOutput(tree, {
        reference,
        path: [{ kind: "item", index: 0 }],
        cursor: null,
      }),
    code("process_output_path_invalid"),
  );
});

test("reader limits reject hostile/plain-invalid trees before getter execution and explicit byte/node overflow", () => {
  let calls = 0;
  assert.throws(
    () =>
      sanitizeProcessOutput(
        Object.defineProperty({}, "secret", {
          enumerable: true,
          get() {
            calls++;
            return "TEST";
          },
        }),
      ),
    code("process_output_limit"),
  );
  assert.equal(calls, 0);
  assert.throws(
    () => sanitizeProcessOutput({ data: "x".repeat(8 * 1024 * 1024) }),
    code("process_output_limit"),
  );
  assert.throws(
    () => sanitizeProcessOutput(Array.from({ length: 131073 }, () => null)),
    code("process_output_limit"),
  );
});

type Harness = ReturnType<typeof startFixture>;
async function isolated(
  run: (h: Harness, reopen: () => Promise<Harness>) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "niaro-process-output-"));
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
const windows = (h: Harness, memory: AgentMemory = h.memory) =>
  createProcessReadWindow(
    h.controller,
    h.registry,
    h.starts,
    h.context,
    scope,
    admin.organizationId,
    memory,
    () => h.memoryStore.version(h.memoryActor),
  );
async function completed(h: Harness, language: "en" | "cs" = "en") {
  const output = {
    result: "TEST original output",
    long: "\u0000".repeat(4000),
    false: false,
    zero: 0,
    null: null,
    empty: "",
    items: [],
    object: {},
    password: "TEST hidden credential",
    extra: "TEST ninth field",
  };
  const definition = ProcessDefinitionSchema.parse({
    ...processAgent(h, "saved"),
    outputSchema: processObject({
      result: { type: "string" },
      long: { type: "string" },
      false: { type: "boolean" },
      zero: { type: "number" },
      null: { type: "null" },
      empty: { type: "string" },
      items: { type: "array", items: { type: "string" } },
      object: processObject(),
      password: { type: "string" },
      extra: { type: "string" },
    }),
  });
  const { intent, command } = h.setup(definition);
  const admission = h.starts.admit(
    admin,
    scope,
    intent.intentId,
    { ...command, language },
    () => {},
  );
  assert(admission.status === "admitted");
  h.onModel(() => ({ content: JSON.stringify(output) }));
  await h.runtime.start(
    admission.processId,
    admission.runId,
    admission.input,
    signal(),
  );
  return admission;
}

for (const language of ["en", "cs"] as const)
  test(`${language} genuine native output uses same Tasks authority and two passive reopens preserve exact journal and receipts`, () =>
    isolated(async (h, reopen) => {
      const admission = await completed(h, language);
      const window = await windows(h).read(admission.parentRunId);
      assert(window);
      const prepared = prepareProcessOutput(window.value, scope);
      assert(prepared?.available);
      assert.equal(
        prepared.reference.nativeRevision,
        window.value.journal.revision,
      );
      assert.equal(prepared.summary.fieldCount, 10);
      assert.equal(prepared.summary.shownFields, 8);
      assert(prepared.summary.clipped && prepared.summary.redacted);
      const request = { reference: prepared.reference, path: [], cursor: null };
      const first = await readProcessOutput(window, request, scope);
      const projection = createProcessTaskProjection(
        h.controller,
        h.registry,
        h.starts,
        h.context,
        scope,
        admin.organizationId,
        h.memory,
        () => h.memoryStore.version(h.memoryActor),
      );
      const work = (await projection.project(await projection.roots()))[0]!;
      assert.deepEqual(work.native?.process?.output, prepared.reference);
      assert.doesNotMatch(JSON.stringify(work), /TEST hidden credential/);
      assert(
        JSON.stringify(work.card).includes(
          translate(language)("processOutputPreview")
            .replace("{shown}", "8")
            .replace("{total}", "10"),
        ),
      );
      const journal = structuredClone(window.value.journal),
        counts = h.counts(),
        models = h.models();
      for (let i = 0; i < 2; i++) {
        h = await reopen();
        assert.deepEqual(
          await readProcessOutput(
            await windows(h).read(admission.parentRunId),
            request,
            scope,
          ),
          first,
        );
        assert.deepEqual(
          JournalSchema.parse(
            h.catalog.turn(
              admission.parentRunId,
              scope.workspaceId,
              scope.userId,
            ),
          ),
          journal,
        );
        assert.deepEqual(h.models(), models);
        assert.deepEqual(h.counts(), counts);
      }
    }));

test("queue-using Memory validates outside serial and policy changes invalidate final publication", () =>
  isolated(async (h) => {
    const admission = await completed(h);
    let validates = 0;
    const memory: AgentMemory = {
      ...h.memory,
      validate: async (version, metadata) => {
        validates++;
        // A queue checkpoint must finish before Memory takes its own read gate.
        await h.context.serial(async () => {});
        await h.memory.validate(version, metadata);
      },
    };
    const window = await windows(h, memory).read(admission.parentRunId);
    assert(window);
    assert.equal(validates, 1);
    const prepared = prepareProcessOutput(window.value, scope);
    assert(prepared?.available);
    h.context.change(admin.organizationId);
    await assert.rejects(
      readProcessOutput(
        window,
        { reference: prepared.reference, path: [], cursor: null },
        scope,
      ),
      code("process_output_changed"),
    );
    assert.equal(h.models().length, 1);
    assert.deepEqual(h.counts(), []);
  }));

test("receipt-only advancement invalidates output publication without a journal or policy change", () =>
  isolated(async (h) => {
    const { intent, command } = h.setup();
    const admission = h.starts.admit(
      admin,
      scope,
      intent.intentId,
      command,
      () => {},
    );
    assert(admission.status === "admitted");
    await h.runtime.start(
      admission.processId,
      admission.runId,
      admission.input,
      signal(),
    );
    const window = await windows(h).read(admission.parentRunId);
    assert(window);
    const prepared = prepareProcessOutput(window.value, scope);
    assert(prepared?.available);
    const receipt = h.catalog.invocation(
      window.value.journal.operations[0]!,
      scope.workspaceId,
      scope.userId,
    )!;
    const journal = structuredClone(window.value.journal),
      epoch = h.context.epoch(admin.organizationId);
    h.catalog.saveInvocation({
      ...receipt,
      result: { value: "TEST changed canonical source" },
    });
    await assert.rejects(
      readProcessOutput(
        window,
        { reference: prepared.reference, path: [], cursor: null },
        scope,
      ),
      code("process_output_changed"),
    );
    assert.equal(h.context.epoch(admin.organizationId), epoch);
    assert.deepEqual(
      JournalSchema.parse(
        h.catalog.turn(admission.parentRunId, scope.workspaceId, scope.userId),
      ),
      journal,
    );
    assert.deepEqual(h.counts(), [["GET", 1]]);
    assert.deepEqual(h.models(), []);
  }));

test("saved Memory-only source receipt expiry invalidates publication without direct operations or epoch change", () =>
  isolated(async (h) => {
    const sourceProcess = h.activate(h.basic());
    await h.runtime.start(
      sourceProcess,
      "TEST-memory-output-source",
      { name: "TEST input" },
      signal(),
    );
    const row = h.db
      .prepare(
        "SELECT data FROM agent_service_turn WHERE json_extract(data,'$.kind')='service-process-1'",
      )
      .get()!;
    const sourceId = JournalSchema.parse(JSON.parse(String(row.data)))
      .operations[0]!;
    await h.memoryStore.remember(h.memoryActor, {
      requestId: "TEST-output-memory",
      content: "TEST input verified source",
      kind: "fact",
      scope: "private",
      source: {
        type: "verified_operation",
        operationId: sourceId,
        serviceId: h.ids.serviceId,
        verifiedAt: new Date().toISOString(),
      },
      explicitIntent: true,
      settings: h.memorySettings,
    });
    const admission = await completed(h);
    const window = await windows(h).read(admission.parentRunId);
    assert(window);
    assert.deepEqual(window.value.journal.operations, []);
    assert.equal(
      Object.values(window.value.journal.agents)[0]!.memoryMetadata?.sources
        ?.length,
      1,
    );
    const prepared = prepareProcessOutput(window.value, scope);
    assert(prepared?.available);
    const source = h.catalog.invocation(
      sourceId,
      scope.workspaceId,
      scope.userId,
    )!;
    const epoch = h.context.epoch(admin.organizationId);
    h.catalog.saveInvocation({
      ...source,
      completedAt: Date.now() - 30 * 60 * 1000 - 1,
    });
    await assert.rejects(
      readProcessOutput(
        window,
        { reference: prepared.reference, path: [], cursor: null },
        scope,
      ),
      code("process_output_changed"),
    );
    assert.equal(h.context.epoch(admin.organizationId), epoch);
    assert.equal(h.models().length, 1);
    assert.deepEqual(h.counts(), [["GET", 1]]);
  }));

for (const fault of [
  "expired",
  "missing",
  "foreign",
  "foreign-workspace",
  "foreign-user",
  "wrong-id",
  "cycle",
  "edge-limit",
  "malformed",
] as const)
  test(`Memory-only transitive ${fault} source closes old output and Tasks publication; fresh reads preserve succeeded status without effects`, () =>
    isolated(async (h, reopen) => {
      // All three receipts and the diamond dependency graph are produced by
      // the real workflow runner: C uses B, and D uses both B and C.
      const base = h.readWrite();
      assert(base.kind === "workflow");
      const middle = base.steps[1]!;
      assert(middle.type === "action");
      const definition = ProcessDefinitionSchema.parse({
        ...base,
        steps: [
          { ...base.steps[0], next: "middle" },
          { ...middle, id: "middle", actionId: h.ids.readId, next: "last" },
          {
            ...middle,
            id: "last",
            actionId: h.ids.readId,
            input: {
              name: { source: "step", stepId: "middle", path: ["value"] },
            },
            next: "done",
          },
          {
            ...base.steps[2],
            output: {
              result: { source: "step", stepId: "last", path: ["value"] },
            },
          },
        ],
      });
      const processId = h.activate(definition);
      await h.runtime.start(
        processId,
        "TEST-memory-chain",
        { name: "TEST input" },
        signal(),
      );
      const sourceRow = h.db
        .prepare(
          "SELECT data FROM agent_service_turn WHERE json_extract(data,'$.runId')='TEST-memory-chain'",
        )
        .get()!;
      const chain = JournalSchema.parse(JSON.parse(String(sourceRow.data)));
      const [bId, cId, dId] = chain.operations;
      assert(bId && cId && dId);
      const b = h.catalog.invocation(bId, scope.workspaceId, scope.userId)!;
      const c = h.catalog.invocation(cId, scope.workspaceId, scope.userId)!;
      const d = h.catalog.invocation(dId, scope.workspaceId, scope.userId)!;
      assert.deepEqual(c.dependencies, [bId]);
      assert.deepEqual(d.dependencies, [bId, cId]);
      await h.memoryStore.remember(h.memoryActor, {
        requestId: "TEST-transitive-memory",
        content: "TEST input verified transitive source",
        kind: "fact",
        scope: "private",
        source: {
          type: "verified_operation",
          operationId: dId,
          serviceId: d.serviceId,
          verifiedAt: new Date().toISOString(),
        },
        explicitIntent: true,
        settings: h.memorySettings,
      });
      const admission = await completed(h);
      const projectionFor = (current: Harness) =>
        createProcessTaskProjection(
          current.controller,
          current.registry,
          current.starts,
          current.context,
          scope,
          admin.organizationId,
          current.memory,
          () => current.memoryStore.version(current.memoryActor),
        );
      const runtimeFor = (current: Harness) =>
        createCatalogRuntime(
          current.controller,
          current.controller.transport,
          current.context,
          scope,
          admin.organizationId,
          false,
          false,
          undefined,
          current.memory,
          undefined,
          projectionFor(current),
        );
      const runtime = runtimeFor(h);
      const window = await windows(h).read(admission.parentRunId);
      assert(window);
      assert.deepEqual(window.value.journal.operations, []);
      assert.deepEqual(window.value.journal.sources, []);
      const prepared = prepareProcessOutput(window.value, scope);
      assert(prepared?.available);
      const taskWindow = await runtime.taskWindow!();
      assert(taskWindow.validate());
      assert.equal(
        taskWindow.items[0]!.native!.process!.detailsAvailable,
        true,
      );
      const request = { reference: prepared.reference, path: [], cursor: null };
      const epoch = h.context.epoch(admin.organizationId);
      switch (fault) {
        case "expired":
          h.catalog.saveInvocation({
            ...b,
            completedAt: Date.now() - CONTACT_CONTEXT_TTL - 1,
          });
          break;
        case "missing":
          h.db
            .prepare("DELETE FROM agent_service_invocation WHERE id=?")
            .run(bId);
          break;
        case "foreign":
          h.catalog.saveInvocation({
            ...b,
            organizationId: "TEST-foreign-org",
          });
          break;
        case "foreign-workspace":
          h.catalog.saveInvocation({
            ...b,
            workspaceId: "TEST-foreign-workspace",
          });
          break;
        case "foreign-user":
          h.catalog.saveInvocation({ ...b, userId: "TEST-foreign-user" });
          break;
        case "wrong-id":
          h.db
            .prepare(
              "UPDATE agent_service_invocation SET data=json_set(data,'$.id','TEST-wrong-id') WHERE id=?",
            )
            .run(bId);
          break;
        case "cycle":
          h.catalog.saveInvocation({ ...b, contactSource: dId });
          break;
        case "edge-limit":
          h.catalog.saveInvocation({
            ...c,
            dependencies: Array.from({ length: 1025 }, () => bId),
          });
          break;
        case "malformed":
          h.db
            .prepare(
              "UPDATE agent_service_invocation SET data=json_set(data,'$.dependencies','not-an-array') WHERE id=?",
            )
            .run(bId);
          break;
      }
      const stableJournal = structuredClone(window.value.journal);
      const stableReceipts = h.db
        .prepare("SELECT * FROM agent_service_invocation ORDER BY id")
        .all();
      const models = h.models(),
        counts = h.counts();
      assert.equal(h.context.epoch(admin.organizationId), epoch);
      await assert.rejects(
        readProcessOutput(window, request, scope),
        code("process_output_changed"),
      );
      assert.equal(taskWindow.validate(), false);
      for (let index = 0; index < (fault === "expired" ? 3 : 1); index++) {
        if (index) h = await reopen();
        const fresh = await windows(h).read(admission.parentRunId);
        assert(fresh);
        assert.equal(fresh.value.detailsAvailable, false);
        assert.deepEqual(prepareProcessOutput(fresh.value, scope), {
          available: false,
          reason: "context",
        });
        await assert.rejects(
          readProcessOutput(fresh, request, scope),
          code("process_output_unavailable"),
        );
        const tasks = await runtimeFor(h).taskWindow!();
        assert(tasks.validate());
        const work = tasks.items.find(
          (item) => item.id === admission.parentRunId,
        )!;
        assert.equal(work.status, "succeeded");
        assert.equal(work.native!.process!.status, "succeeded");
        assert.equal(work.native!.process!.detailsAvailable, false);
        assert.equal(work.native!.process!.output, undefined);
        assert(!JSON.stringify(work.card).includes("TEST original output"));
        assert.deepEqual(fresh.value.journal, stableJournal);
        assert.deepEqual(
          h.db
            .prepare("SELECT * FROM agent_service_invocation ORDER BY id")
            .all(),
          stableReceipts,
        );
        assert.deepEqual(h.models(), models);
        assert.deepEqual(h.counts(), counts);
      }
      assert.equal(models.length, 1);
      assert.deepEqual(counts, [["GET", 3]]);
    }));

test("private/auth revocation, foreign reference and orphan native run never grant output access", () =>
  isolated(async (h) => {
    const admission = await completed(h);
    const window = await windows(h).read(admission.parentRunId);
    assert(window);
    const prepared = prepareProcessOutput(window.value, scope);
    assert(prepared?.available);
    await assert.rejects(
      readProcessOutput(
        window,
        {
          reference: {
            ...prepared.reference,
            nativeRevision: prepared.reference.nativeRevision + 1,
          },
          path: [],
          cursor: null,
        },
        scope,
      ),
      code("process_output_changed"),
    );
    await h.runtime.start(
      admission.processId,
      "TEST-internal-output",
      admission.input,
      signal(),
    );
    assert.equal(await windows(h).read("TEST-internal-output"), null);
    h.denyRead();
    assert.equal(await windows(h).read(admission.parentRunId), null);
    h.switchActor();
    await assert.rejects(
      windows(h).read(admission.parentRunId),
      code("identity_forbidden"),
    );
  }));

test("valid run stays succeeded while invalid/oversized saved output has explicit unavailable reason", () =>
  isolated(async (h) => {
    const admission = await completed(h),
      window = await windows(h).read(admission.parentRunId);
    assert(window);
    const captured = structuredClone(window.value);
    captured.journal.output = {
      ...captured.journal.output,
      long: "x".repeat(4001),
    };
    assert.deepEqual(prepareProcessOutput(captured, scope), {
      available: false,
      reason: "invalid",
    });
    captured.journal.output = { long: "x".repeat(8 * 1024 * 1024) };
    assert.deepEqual(prepareProcessOutput(captured, scope), {
      available: false,
      reason: "limit",
    });
    assert.equal(window.value.journal.status, "succeeded");
    assert.equal(
      JournalSchema.parse(
        h.catalog.turn(admission.parentRunId, scope.workspaceId, scope.userId),
      ).status,
      "succeeded",
    );
  }));
