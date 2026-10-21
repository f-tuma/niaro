import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatalogCommand } from "../packages/protocol/service-catalog";
import { ProcessDefinitionSchema } from "../packages/protocol/service-processes";
import { PROCESS_TEST_SCENARIOS } from "../apps/server-identity/service-processes";
import { processDigest } from "../apps/server-identity/process-validation";
import { LoopsStore } from "../apps/server-identity/loops";
import { processObject } from "./helpers/service-process";

import {
  fixture,
  target,
  scope,
  admin,
  signal,
  code,
} from "./helpers/service-process-runtime";

async function isolated(
  run: (h: ReturnType<typeof fixture>, path: string) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), "niaro-native-process-"));
  const path = join(dir, "identity.sqlite");
  const h = fixture(path);
  try {
    await run(h, path);
  } finally {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("custom workflow uses native Mastra, authoritative receipts and passive replay", () =>
  isolated(async (h) => {
    const id = h.activate(h.basic());
    const first = await h.runtime.start(
      id,
      "TEST-run",
      { name: "TEST-input" },
      signal(),
    );
    assert.equal(first.status, "succeeded");
    assert.deepEqual(first.output, { result: "TEST-result" });
    assert.deepEqual(
      await h.runtime.start(id, "TEST-run", { name: "TEST-input" }, signal()),
      first,
    );
    assert.deepEqual(h.counts(), [["GET", 1]]);
    const loops = new LoopsStore(h.db, h.catalog);
    const page = loops.page(target);
    assert.equal(page.entries.length, 1);
    assert.equal(page.entries[0]!.status, "succeeded");
    const detail = loops.detail(target.organizationId, page.entries[0]!.id)!;
    assert.equal(
      detail.nodes.find((n) => n.kind === "tool")?.action?.operationId,
      first.operations[0],
    );
    assert(
      !JSON.stringify(detail.nodes.map((n) => n.details)).includes(
        "TEST-input",
      ),
      "Trace metadata omits private arguments; action details use authorized receipts",
    );
  }));

test("native suspended workflow resumes after restart without repeating its earlier read", () =>
  isolated(async (h, path) => {
    const id = h.activate(h.readWrite());
    const waiting = await h.runtime.start(
      id,
      "TEST-resume",
      { name: "TEST-input" },
      signal(),
    );
    assert.equal(waiting.status, "waiting");
    assert(waiting.approval);
    assert.deepEqual(h.counts(), [["GET", 1]]);
    await h.close();
    const restarted = fixture(path, h.ids);
    try {
      const done = await restarted.runtime.resume(
        "TEST-resume",
        { ...waiting.approval, approved: true },
        signal(),
      );
      assert.equal(done.status, "succeeded");
      assert.deepEqual(done.output, { result: "TEST-result" });
      assert.deepEqual(restarted.counts(), [
        ["GET", 1],
        ["POST", 1],
      ]);
      assert.deepEqual(
        await restarted.runtime.start(
          id,
          "TEST-resume",
          { name: "TEST-input" },
          signal(),
        ),
        done,
      );
      await assert.rejects(
        restarted.runtime.resume(
          "TEST-resume",
          { ...waiting.approval, approved: true },
          signal(),
        ),
        code("process_approval_conflict"),
      );
      assert.deepEqual(restarted.counts(), [
        ["GET", 1],
        ["POST", 1],
      ]);
    } finally {
      await restarted.close();
    }
  }));

test("native branch skips unchosen actions and validates final typed output", () =>
  isolated(async (h) => {
    const base = h.basic();
    assert(base.kind === "workflow");
    const definition = ProcessDefinitionSchema.parse({
      ...base,
      inputSchema: processObject({
        name: { type: "string" },
        lookup: { type: "boolean" },
      }),
      entry: "choose",
      steps: [
        {
          id: "choose",
          type: "branch",
          condition: {
            operator: "equals",
            left: { source: "input", path: ["lookup"] },
            right: true,
          },
          whenTrue: "lookup",
          whenFalse: "skip",
        },
        ...base.steps,
        {
          id: "skip",
          type: "return",
          output: { result: { source: "literal", value: "TEST-skipped" } },
        },
      ],
    });
    const id = h.activate(definition);
    const skipped = await h.runtime.start(
      id,
      "TEST-branch-false",
      { name: "TEST-input", lookup: false },
      signal(),
    );
    assert.deepEqual(skipped.output, { result: "TEST-skipped" });
    assert.deepEqual(h.counts(), []);
    const read = await h.runtime.start(
      id,
      "TEST-branch-true",
      { name: "TEST-input", lookup: true },
      signal(),
    );
    assert.deepEqual(read.output, { result: "TEST-result" });
    assert.deepEqual(h.counts(), [["GET", 1]]);
  }));

test("rejection cancels the process and never executes the write", () =>
  isolated(async (h) => {
    const id = h.activate(h.readWrite());
    const waiting = await h.runtime.start(
      id,
      "TEST-reject",
      { name: "TEST-input" },
      signal(),
    );
    assert(waiting.approval);
    const rejected = await h.runtime.resume(
      "TEST-reject",
      { ...waiting.approval, approved: false },
      signal(),
    );
    assert.equal(rejected.status, "cancelled");
    assert.equal(rejected.failure?.code, "process_action_rejected");
    assert.equal(
      h.catalog.invocation(
        waiting.approval.operationId,
        target.workspaceId,
        scope.userId,
      )?.status,
      "rejected",
    );
    assert.deepEqual(
      await h.runtime.start(
        id,
        "TEST-reject",
        { name: "TEST-input" },
        signal(),
      ),
      rejected,
    );
    assert.deepEqual(h.counts(), [["GET", 1]]);
  }));

test("unknown write outcome remains unknown and retry cannot repeat the effect", () =>
  isolated(async (h, path) => {
    const id = h.activate(h.readWrite());
    const waiting = await h.runtime.start(
      id,
      "TEST-unknown",
      { name: "TEST-input" },
      signal(),
    );
    assert(waiting.approval);
    h.setMode("unknown");
    const unknown = await h.runtime.resume(
      "TEST-unknown",
      { ...waiting.approval, approved: true },
      signal(),
    );
    assert.equal(unknown.status, "unknown");
    assert.equal(unknown.failure?.operationId, waiting.approval.operationId);
    assert.equal(
      h.catalog.invocation(
        waiting.approval.operationId,
        target.workspaceId,
        scope.userId,
      )?.status,
      "unknown",
    );
    await h.close();
    const restarted = fixture(path, h.ids);
    try {
      assert.deepEqual(
        await restarted.runtime.start(
          id,
          "TEST-unknown",
          { name: "TEST-input" },
          signal(),
        ),
        unknown,
      );
      assert.deepEqual(restarted.counts(), [
        ["GET", 1],
        ["POST", 1],
      ]);
    } finally {
      await restarted.close();
    }
  }));

test("wrong output stops downstream actions while keeping the successful business receipt", () =>
  isolated(async (h) => {
    const id = h.activate(h.readWrite());
    h.setMode("bad_output");
    const failed = await h.runtime.start(
      id,
      "TEST-schema",
      { name: "TEST-input" },
      signal(),
    );
    assert.equal(failed.status, "failed");
    assert.equal(failed.failure?.code, "process_output_invalid");
    assert.equal(
      h.catalog.invocation(
        failed.operations[0]!,
        target.workspaceId,
        scope.userId,
      )?.status,
      "succeeded",
    );
    assert.deepEqual(
      await h.runtime.start(
        id,
        "TEST-schema",
        { name: "TEST-input" },
        signal(),
      ),
      failed,
    );
    assert.deepEqual(h.counts(), [["GET", 1]]);
  }));

test("HTTP failure stops the workflow with the catalog's diagnostic code", () =>
  isolated(async (h) => {
    const id = h.activate(h.readWrite());
    h.setMode("http_error");
    const failed = await h.runtime.start(
      id,
      "TEST-failure",
      { name: "TEST-input" },
      signal(),
    );
    assert.equal(failed.status, "failed");
    assert.equal(failed.failure?.nodeId, "lookup");
    assert.equal(
      failed.failure?.code,
      h.catalog.invocation(
        failed.operations[0]!,
        target.workspaceId,
        scope.userId,
      )?.failure?.code,
    );
    assert.deepEqual(h.counts(), [["GET", 1]]);
  }));

test("canonical input, exact pending approval and authenticated actor are bound to the run", () =>
  isolated(async (h) => {
    const id = h.activate(h.readWrite());
    await assert.rejects(
      h.runtime.start(id, "TEST-missing", {}, signal()),
      code("process_input_invalid"),
    );
    await assert.rejects(
      h.runtime.start(
        id,
        "TEST-extra",
        { name: "TEST-input", userId: "TEST-other" },
        signal(),
      ),
      code("process_input_invalid"),
    );
    assert.deepEqual(h.counts(), []);
    const waiting = await h.runtime.start(
      id,
      "TEST-bound",
      { name: "TEST-input" },
      signal(),
    );
    assert(waiting.approval);
    await assert.rejects(
      h.runtime.start(id, "TEST-bound", { name: "TEST-changed" }, signal()),
      code("process_conflict"),
    );
    await assert.rejects(
      h.runtime.resume(
        "TEST-bound",
        { ...waiting.approval, operationId: "TEST-forged", approved: true },
        signal(),
      ),
      code("process_approval_conflict"),
    );
    h.switchActor();
    await assert.rejects(
      h.runtime.resume(
        "TEST-bound",
        { ...waiting.approval, approved: true },
        signal(),
      ),
      code("identity_forbidden"),
    );
    assert.deepEqual(h.counts(), [["GET", 1]]);
  }));

test("expired or revoked read provenance blocks a confirmed downstream write", () =>
  isolated(async (h) => {
    const id = h.activate(h.readWrite());
    const waiting = await h.runtime.start(
      id,
      "TEST-expired",
      { name: "TEST-input" },
      signal(),
    );
    assert(waiting.approval);
    const read = h.catalog.invocation(
      waiting.operations[0]!,
      target.workspaceId,
      scope.userId,
    )!;
    read.completedAt = Date.now() - 3_600_000;
    h.catalog.saveInvocation(read);
    await assert.rejects(
      h.runtime.resume(
        "TEST-expired",
        { ...waiting.approval, approved: true },
        signal(),
      ),
      code("catalog_conflict"),
    );
    read.completedAt = Date.now();
    h.catalog.saveInvocation(read);
    h.revoke();
    await assert.rejects(
      h.runtime.resume(
        "TEST-expired",
        { ...waiting.approval, approved: true },
        signal(),
      ),
      code("identity_forbidden"),
    );
    assert.deepEqual(h.counts(), [["GET", 1]]);
  }));

test("authorization is checked again immediately before transport dispatch", () =>
  isolated(async (h) => {
    const id = h.activate(h.basic());
    h.onDispatch(h.revoke);
    await assert.rejects(
      h.runtime.start(
        id,
        "TEST-dispatch-guard",
        { name: "TEST-input" },
        signal(),
      ),
      code("identity_forbidden"),
    );
    assert.deepEqual(h.counts(), []);
  }));

test("deadline persists through waiting/resume and cannot reset on retry", () =>
  isolated(async (h) => {
    const definition = h.readWrite();
    const id = h.activate(definition);
    const waiting = await h.runtime.start(
      id,
      "TEST-deadline",
      { name: "TEST-input" },
      signal(),
    );
    assert(waiting.approval);
    const row = h.db
      .prepare(
        "SELECT id,data FROM agent_service_turn WHERE json_extract(data,'$.runId')=?",
      )
      .get("TEST-deadline")!;
    const journal = JSON.parse(String(row.data));
    journal.startedAt = Date.now() - definition.limits.maxDurationMs - 1;
    h.db
      .prepare("UPDATE agent_service_turn SET data=? WHERE id=?")
      .run(JSON.stringify(journal), String(row.id));
    await assert.rejects(
      h.runtime.resume(
        "TEST-deadline",
        { ...waiting.approval, approved: true },
        signal(),
      ),
    );
    const failed = await h.runtime.start(
      id,
      "TEST-deadline",
      { name: "TEST-input" },
      signal(),
    );
    assert.equal(failed.failure?.code, "process_duration_exceeded");
    assert.deepEqual(h.counts(), [["GET", 1]]);
  }));

test("custom agent/model nodes require explicit enforced pricing before any effect", () =>
  isolated(async (h) => {
    const native = await import("@niaro/server-agent");
    const base = h.basic();
    assert(base.kind === "workflow");
    const { entry: _entry, steps: _steps, ...common } = base;
    const providerId = h.catalog.command(
      CatalogCommand.parse({
        ...target,
        type: "saveProvider",
        revision: 0,
        settings: {
          name: "TEST provider",
          url: "https://models.example.test/v1",
          enabled: true,
          dailyRequestLimit: 10,
        },
      }),
    );
    const modelId = h.catalog.command(
      CatalogCommand.parse({
        ...target,
        type: "saveModel",
        revision: 0,
        settings: {
          providerId,
          name: "TEST model",
          model: "TEST-offline",
          kind: "chat",
          tools: true,
          enabled: true,
        },
      }),
    );
    const definition = ProcessDefinitionSchema.parse({
      ...common,
      kind: "agent",
      modelId,
      instructions: "TEST only",
      capabilities: [],
      memory: "none",
      limits: { ...base.limits, maxModelCalls: 1 },
    });
    native.assertWorkflowSupported(definition);
    const id = h.activate(definition);
    await assert.rejects(
      h.runtime.start(
        id,
        "TEST-agent-closed",
        { name: "TEST-input" },
        signal(),
      ),
      code("process_budget_policy_required"),
    );
    assert.deepEqual(h.counts(), []);
  }));

test("concurrent retry cannot execute a second native run or action", () =>
  isolated(async (h) => {
    const id = h.activate(h.basic());
    let entered!: () => void;
    let release!: () => void;
    const running = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.onDispatch(async () => {
      entered();
      await hold;
    });
    const first = h.runtime.start(
      id,
      "TEST-concurrent",
      { name: "TEST-input" },
      signal(),
    );
    await running;
    try {
      await assert.rejects(
        h.runtime.start(
          id,
          "TEST-concurrent",
          { name: "TEST-input" },
          signal(),
        ),
        code("catalog_busy"),
      );
    } finally {
      release();
    }
    assert.equal((await first).status, "succeeded");
    assert.deepEqual(h.counts(), [["GET", 1]]);
  }));

test("a native run keeps its original process version after a new version activates", () =>
  isolated(async (h) => {
    const id = h.activate(h.readWrite());
    const waiting = await h.runtime.start(
      id,
      "TEST-version",
      { name: "TEST-input" },
      signal(),
    );
    assert(waiting.approval);
    const previous = h.registry.get(admin, id);
    const edited = h.registry.saveDraft(admin, {
      id,
      serviceId: h.ids.serviceId,
      revision: previous.revision,
      definition: { ...h.readWrite(), name: "TEST second version" },
    });
    const version = h.registry.freezeDraft(admin, id, edited.revision);
    h.registry.recordTest(admin, id, version.version, {
      testId: "TEST-second-version",
      digest: version.digest,
      runnerVersion: "TEST-offline/1",
      passed: true,
      scenarios: [...PROCESS_TEST_SCENARIOS],
      reportDigest: processDigest({ fixture: true }),
    });
    h.registry.activate(
      admin,
      id,
      h.registry.get(admin, id).revision,
      version.version,
    );
    const completed = await h.runtime.resume(
      "TEST-version",
      { ...waiting.approval, approved: true },
      signal(),
    );
    assert.equal(completed.version, 1);
    assert.equal(completed.status, "succeeded");
    const next = await h.runtime.start(
      id,
      "TEST-new-version",
      { name: "TEST-input" },
      signal(),
    );
    assert.equal(next.version, 2);
    assert.equal(next.status, "waiting");
    assert.deepEqual(h.counts(), [
      ["GET", 2],
      ["POST", 1],
    ]);
  }));

test("changed catalog source refuses resume before any effect", () =>
  isolated(async (h) => {
    const id = h.activate(h.readWrite());
    const waiting = await h.runtime.start(
      id,
      "TEST-sources",
      { name: "TEST-input" },
      signal(),
    );
    assert(waiting.approval);
    h.db
      .prepare("UPDATE agent_catalog SET revision=revision+1 WHERE id=?")
      .run(h.ids.readId);
    await assert.rejects(
      h.runtime.resume(
        "TEST-sources",
        { ...waiting.approval, approved: true },
        signal(),
      ),
      code("process_sources_changed"),
    );
    assert.deepEqual(h.counts(), [["GET", 1]]);
  }));

test("receipt uncertainty wins over an unfinished native/journal checkpoint", () =>
  isolated(async (h) => {
    const id = h.activate(h.readWrite());
    const waiting = await h.runtime.start(
      id,
      "TEST-crash-gap",
      { name: "TEST-input" },
      signal(),
    );
    assert(waiting.approval);
    // Simulate a durable business dispatch whose return was lost before the
    // parent's native checkpoint/journal could be updated.
    const receipt = h.catalog.invocation(
      waiting.approval.operationId,
      target.workspaceId,
      scope.userId,
    )!;
    receipt.status = "unknown";
    h.catalog.saveInvocation(receipt);
    const recovered = await h.runtime.resume(
      "TEST-crash-gap",
      { ...waiting.approval, approved: true },
      signal(),
    );
    assert.equal(recovered.status, "unknown");
    assert.equal(recovered.failure?.operationId, receipt.id);
    assert.deepEqual(h.counts(), [["GET", 1]]);
  }));
