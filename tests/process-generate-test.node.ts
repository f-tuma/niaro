import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NativeTestGenerateQuerySchema,
  NativeTestGeneratedSchema,
  PROCESS_NATIVE_TEST_PROFILE,
} from "../packages/protocol/process-native-testing";
import { ProcessDefinitionSchema } from "../packages/protocol/service-processes";
import { createProcessNativeTesting } from "../apps/server-identity/process-native-testing-controller";
import { ProcessTestingStore } from "../apps/server-identity/process-testing-store";
import { type CatalogContext } from "../apps/server-identity/catalog-controller";
import { AuditStore } from "../apps/server-identity/audit";
import { IdentityError } from "../apps/server-identity/error";
import { DEFAULT_PROCESS_LIMITS } from "../apps/server-identity/process-validation";
import { fixture, admin, target } from "./helpers/service-process-runtime";
import { processObject, processWorkflow } from "./helpers/service-process";

type H = ReturnType<typeof fixture>;
// NIAR-271: Generate test in the console reads a suite; it never runs one.
async function setup(
  run: (h: H, testing: ReturnType<typeof createProcessNativeTesting>, context: CatalogContext) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "niaro-generate-test-"));
  const h = fixture(join(root, "identity.sqlite"));
  try {
    const audit = new AuditStore(h.db);
    const journal = new ProcessTestingStore(
      h.db,
      "TEST-server",
      h.registry,
      (record) => audit.append(record),
    );
    const testing = createProcessNativeTesting(h.registry, h.catalog, journal);
    let queue: Promise<unknown> = Promise.resolve();
    const context = {
      ...h.context,
      serial: (work: () => unknown) => {
        const pending = queue.then(work);
        queue = pending.catch(() => {});
        return pending;
      },
      actor: async (value: { organizationId: string; workspaceId: string }) => {
        if (
          value.organizationId !== target.organizationId ||
          value.workspaceId !== target.workspaceId
        )
          throw new IdentityError(403, "identity_forbidden");
        return { userId: admin.userId, role: admin.role };
      },
    } as CatalogContext;
    await run(h, testing, context);
  } finally {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  }
}
const tables = (h: H) =>
  Object.fromEntries(
    [
      "agent_service_process_test",
      "agent_service_invocation",
      "test_dispatch",
      "test_model",
    ].map((name) => [
      name,
      h.db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get()!.n,
    ]),
  );
const query = (processId: string, version: number) =>
  NativeTestGenerateQuerySchema.parse({
    ...target,
    profile: PROCESS_NATIVE_TEST_PROFILE,
    processId,
    version: String(version),
  });

test("Generate test returns a suite for a canvas-built read workflow and runs nothing", () =>
  setup(async (h, testing, context) => {
    h.model();
    const draft = h.registry.saveDraft(admin, {
      serviceId: h.ids.serviceId,
      revision: 0,
      definition: processWorkflow(h.ids.serviceId, h.ids.readId),
    });
    const artifact = h.registry.freezeDraft(admin, draft.id, draft.revision);
    const before = tables(h);
    const result = NativeTestGeneratedSchema.parse(
      await testing.generate(context, query(draft.id, artifact.version)),
    );
    assert.equal(result.processId, draft.id);
    assert.equal(result.version, artifact.version);
    assert.equal(result.artifactDigest, artifact.digest);
    assert("suite" in result.generated, JSON.stringify(result.generated));
    assert(result.generated.suite.cases.length > 0);
    // Reading a generated suite starts no test, call or dispatch.
    assert.deepEqual(tables(h), before);
  }));

test("Generate test says why when no suite can be made", () =>
  setup(async (h, testing, context) => {
    const modelId = h.model();
    // An agent that can only write through its own tool needs a person.
    const definition = ProcessDefinitionSchema.parse({
      schemaVersion: 1,
      kind: "agent",
      name: "TEST writer",
      description: "Synthetic",
      trigger: "manual",
      inputSchema: processObject({}),
      outputSchema: processObject({ summary: { type: "string" } }),
      limits: DEFAULT_PROCESS_LIMITS,
      modelId,
      instructions: "Goal: TEST write.",
      memory: "none",
      capabilities: [{ serviceId: h.ids.serviceId, actionId: h.ids.writeId }],
    });
    const draft = h.registry.saveDraft(admin, {
      serviceId: h.ids.serviceId,
      revision: 0,
      definition,
    });
    const artifact = h.registry.freezeDraft(admin, draft.id, draft.revision);
    const before = tables(h);
    const result = NativeTestGeneratedSchema.parse(
      await testing.generate(context, query(draft.id, artifact.version)),
    );
    assert.deepEqual(result.generated, { gap: "scenario_unsupported" });
    assert.deepEqual(tables(h), before);
    // Another workspace's process is never generated.
    await assert.rejects(
      testing.generate(context, {
        ...query(draft.id, artifact.version),
        workspaceId: "22222222-2222-4222-8222-222222222222",
      }),
      (error: unknown) => error instanceof IdentityError,
    );
  }));
