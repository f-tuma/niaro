import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { WorkflowRunState } from "@mastra/core/workflows";
import type { WorkflowsStorage } from "@mastra/core/storage";
import type { StoredInvocation } from "../apps/server-identity/service-catalog";
import { CatalogCommand } from "../packages/protocol/service-catalog";
import { ProcessDefinitionSchema } from "../packages/protocol/service-processes";
import { PROCESS_TEST_SCENARIOS } from "../apps/server-identity/service-processes";
import { processDigest } from "../apps/server-identity/process-validation";
import { nativeCatalogOwner } from "../apps/server-identity/mastra-runtime";
import {
  fixture,
  admin,
  target,
  scope,
  signal,
} from "./helpers/service-process-runtime";

const require = createRequire(
  new URL("../apps/server-agent/package.json", import.meta.url),
);
const { LibSQLStore } =
  require("@mastra/libsql") as typeof import("@mastra/libsql");
type Harness = ReturnType<typeof fixture>;
type Mode =
  | "read-receipt"
  | "write-receipt"
  | "approval-pending"
  | "agent-retired"
  | "agent-approved-retired"
  | "agent-second-approval"
  | "agent-staged"
  | "agent-saved-retired"
  | "parent-terminal"
  | "mapping-gap"
  | "finish-gap";
type Metadata = {
  mode: Mode;
  runId: string;
  nativeRunId: string;
  resourceId: string;
  workflowName: string;
  processId: string;
  version: number;
  artifactDigest: string;
  compilerVersion: string;
  input: { name: string };
  ids: Harness["ids"];
  noteId?: string;
};
type Cut = {
  mode: Mode;
  site: string;
  childRetired?: boolean;
  childSuspended?: boolean;
  models: number;
  counts: unknown[][];
  receipts: StoredInvocation[];
  journal: {
    status: string;
    pending?: { nodeId: string; operationId: string };
    operations: string[];
    agents: Record<
      string,
      {
        runId: string;
        threadId: string;
        output?: unknown;
        pending?: { toolCallId: string; operationId: string };
        decisions: {
          toolCallId: string;
          operationId: string;
          approved: boolean;
        }[];
      }
    >;
    visited: string[];
    inference: number;
    startedAt: number;
  };
};
const sites: Record<Mode, string> = {
  "read-receipt": "canonical-read-receipt-before-native-ack",
  "write-receipt": "canonical-approved-write-receipt-before-native-ack",
  "approval-pending": "canonical-pending-approval-before-native-suspension",
  "agent-retired": "retired-typed-child-output-before-parent-ack",
  "agent-approved-retired": "retired-typed-child-output-before-parent-ack",
  "agent-second-approval": "second-child-approval-before-parent-ack",
  "agent-staged": "typed-child-output-before-native-retirement",
  "agent-saved-retired": "retired-typed-child-output-before-parent-ack",
  "parent-terminal": "native-parent-terminal-before-domain-success",
  "mapping-gap": "completed-mapping-before-native-pointer-advance",
  "finish-gap": "completed-finish-before-native-terminal-status",
};

async function crash(t: TestContext, mode: Mode) {
  const directory = mkdtempSync(join(tmpdir(), "niaro-process-recovery-cut-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const outcome = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(
          new URL(
            "./helpers/service-process-recovery-worker.ts",
            import.meta.url,
          ),
        ),
        directory,
        mode,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        Error("TEST intended crash cut timed out: " + mode + " " + stderr),
      );
    }, 20000);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stderr });
    });
  });
  assert.equal(outcome.signal, "SIGKILL", outcome.stderr);
  assert(
    existsSync(join(directory, "cut.json")),
    "worker reached the named cut",
  );
  const metadata = JSON.parse(
    readFileSync(join(directory, "metadata.json"), "utf8"),
  ) as Metadata;
  const cut = JSON.parse(
    readFileSync(join(directory, "cut.json"), "utf8"),
  ) as Cut;
  assert.equal(cut.mode, mode);
  assert.equal(cut.site, sites[mode]);
  assert.equal(cut.journal.status, "running");
  return { directory, metadata, cut, path: join(directory, "identity.sqlite") };
}
type Crashed = Awaited<ReturnType<typeof crash>>;

async function withNative<T>(
  c: Crashed,
  run: (workflows: WorkflowsStorage) => Promise<T>,
) {
  const store = new LibSQLStore({
    id: "TEST-process-crash-native-inspection",
    url: `file:${c.path}.mastra.sqlite`,
  });
  await store.init();
  try {
    const workflows = await store.getStore("workflows");
    assert(workflows);
    return await run(workflows);
  } finally {
    await store.close();
  }
}
const nativeRow = (c: Crashed) =>
  withNative(c, (store) =>
    store.getWorkflowRunById({
      workflowName: c.metadata.workflowName,
      runId: c.metadata.nativeRunId,
    }),
  );
function jsonSnapshot(snapshot: WorkflowRunState | string) {
  return (
    typeof snapshot === "string"
      ? JSON.parse(snapshot)
      : structuredClone(snapshot)
  ) as WorkflowRunState;
}
async function mutateNative(
  c: Crashed,
  mutate: (snapshot: WorkflowRunState) => void,
  resourceId = c.metadata.resourceId,
) {
  await withNative(c, async (store) => {
    const row = await store.getWorkflowRunById({
      workflowName: c.metadata.workflowName,
      runId: c.metadata.nativeRunId,
    });
    assert(row);
    const snapshot = jsonSnapshot(row.snapshot);
    mutate(snapshot);
    await store.persistWorkflowSnapshot({
      workflowName: c.metadata.workflowName,
      runId: c.metadata.nativeRunId,
      resourceId,
      snapshot,
    });
  });
}
function sameCalls(h: Harness, c: Crashed) {
  assert.equal(h.models().length, c.cut.models);
  assert.deepEqual(h.counts(), c.cut.counts);
  for (const original of c.cut.receipts) {
    assert.deepEqual(
      h.catalog.invocation(original.id, scope.workspaceId, scope.userId),
      original,
      "canonical receipt is preserved",
    );
  }
}
const start = (h: Harness, c: Crashed) =>
  h.runtime.start(
    c.metadata.processId,
    c.metadata.runId,
    c.metadata.input,
    signal(),
  );
async function deny(h: Harness, c: Crashed) {
  const before = await nativeRow(c);
  const outcome = await start(h, c).catch(() => undefined);
  if (outcome) assert.equal(outcome.status, "failed", JSON.stringify(outcome));
  else {
    const journal = h.catalog.turn(
      c.metadata.nativeRunId,
      scope.workspaceId,
      scope.userId,
    ) as { status: string };
    assert.notEqual(journal.status, "succeeded");
  }
  sameCalls(h, c);
  const after = await nativeRow(c);
  assert.deepEqual(
    after,
    before,
    "denial must precede native attachment/mutation",
  );
}

async function nativeRecoveryCalls(t: TestContext, runId: string) {
  // server-agent is loaded through the native ESM boundary; patch that same
  // Mastra module instead of this test file's CommonJS package instance.
  const { Run } = await import("@mastra/core/workflows");
  const original = {
    start: Run.prototype.start,
    restart: Run.prototype.restart,
  };
  const calls = { starts: 0, restarts: 0 };
  Run.prototype.start = function (...args) {
    if (this.runId === runId) calls.starts++;
    return original.start.apply(this, args);
  };
  Run.prototype.restart = function (...args) {
    if (this.runId === runId) calls.restarts++;
    return original.restart.apply(this, args);
  };
  t.after(() => {
    Run.prototype.start = original.start;
    Run.prototype.restart = original.restart;
  });
  return calls;
}

for (const mode of [
  "read-receipt",
  "write-receipt",
  "agent-retired",
  "agent-approved-retired",
  "parent-terminal",
  "mapping-gap",
  "finish-gap",
] as const) {
  test(`actual SIGKILL ${mode} recovers its native parent from canonical proof once across two reopens`, async (t) => {
    const c = await crash(t, mode);
    const nativeCalls = await nativeRecoveryCalls(t, c.metadata.nativeRunId);
    const row = await nativeRow(c);
    assert(row);
    const snapshot = jsonSnapshot(row.snapshot);
    assert.equal(
      snapshot.status,
      mode === "parent-terminal" ? "success" : "running",
    );
    if (["agent-retired", "agent-approved-retired"].includes(mode))
      assert.equal(c.cut.childRetired, true);
    if (mode === "agent-approved-retired") {
      assert.equal(c.cut.models, 2);
      assert.deepEqual(c.cut.counts, [["POST", 1]]);
    }
    let original: Awaited<ReturnType<typeof start>> | undefined;
    for (let reopen = 0; reopen < 2; reopen++) {
      const h = fixture(c.path, c.metadata.ids);
      try {
        if (["agent-retired", "agent-approved-retired"].includes(mode)) {
          const child = c.cut.journal.agents.agent!;
          const runtime = await nativeCatalogOwner(h.controller);
          assert(
            await runtime.proveRetired({
              runId: child.runId,
              threadId: child.threadId,
              resourceId: c.metadata.resourceId,
            }),
          );
          assert(runtime.isSettled(child.runId));
        }
        const done = await start(h, c);
        assert.equal(done.status, "succeeded", JSON.stringify(done));
        assert.equal(done.version, c.metadata.version);
        assert.deepEqual(done.output, {
          result:
            mode === "agent-retired"
              ? "TEST-model-result"
              : mode === "agent-approved-retired"
                ? "TEST-approved-done"
                : "TEST-result",
        });
        assert.deepEqual(done.operations, c.cut.journal.operations);
        sameCalls(h, c);
        const journal = h.catalog.turn(
          c.metadata.nativeRunId,
          scope.workspaceId,
          scope.userId,
        ) as Cut["journal"];
        assert.equal(
          journal.startedAt,
          c.cut.journal.startedAt,
          "recovery retains its absolute deadline",
        );
        assert.equal(journal.inference, c.cut.journal.inference);
        assert.equal(new Set(journal.visited).size, journal.visited.length);
        for (const charged of c.cut.journal.visited)
          assert(journal.visited.includes(charged));
        if (original) assert.deepEqual(done, original);
        original = done;
        assert.deepEqual(await start(h, c), done);
        sameCalls(h, c);
      } finally {
        await h.close();
      }
    }
    assert.deepEqual(nativeCalls, {
      starts: 0,
      restarts: mode === "parent-terminal" ? 0 : 1,
    });
  });
}

test("actual SIGKILL before native suspension restores exactly the original pending approval without dispatch", async (t) => {
  const c = await crash(t, "approval-pending");
  const nativeCalls = await nativeRecoveryCalls(t, c.metadata.nativeRunId);
  assert(c.cut.journal.pending);
  assert.equal(jsonSnapshot((await nativeRow(c))!.snapshot).status, "running");
  assert.deepEqual(c.cut.counts, [["GET", 1]]);
  for (let reopen = 0; reopen < 2; reopen++) {
    const h = fixture(c.path, c.metadata.ids);
    try {
      const waiting = await start(h, c);
      assert.equal(waiting.status, "waiting", JSON.stringify(waiting));
      assert.deepEqual(waiting.approval, c.cut.journal.pending);
      sameCalls(h, c);
      assert.equal(
        jsonSnapshot((await nativeRow(c))!.snapshot).status,
        "suspended",
      );
    } finally {
      await h.close();
    }
  }
  const h = fixture(c.path, c.metadata.ids);
  try {
    const done = await h.runtime.resume(
      c.metadata.runId,
      { ...c.cut.journal.pending, approved: true },
      signal(),
    );
    assert.equal(done.status, "succeeded", JSON.stringify(done));
    assert.deepEqual(done.output, { result: "TEST-result" });
    assert.deepEqual(h.counts(), [
      ["GET", 1],
      ["POST", 1],
    ]);
    assert.equal(h.models().length, 0);
    assert.deepEqual(await start(h, c), done);
    assert.deepEqual(h.counts(), [
      ["GET", 1],
      ["POST", 1],
    ]);
  } finally {
    await h.close();
  }
  assert.deepEqual(nativeCalls, { starts: 0, restarts: 1 });
});

test("actual SIGKILL second child approval preserves consumed first decision and exact pending second write across two reopens", async (t) => {
  const c = await crash(t, "agent-second-approval");
  const nativeCalls = await nativeRecoveryCalls(t, c.metadata.nativeRunId);
  const child = c.cut.journal.agents.agent!;
  assert.equal(c.cut.childSuspended, true);
  assert.equal(c.cut.models, 2);
  assert.deepEqual(c.cut.counts, [["POST", 1]]);
  assert(c.cut.journal.pending);
  assert(child.pending);
  assert.equal(child.decisions.length, 1);
  const first = child.decisions[0]!;
  assert.equal(first.approved, true);
  assert.notEqual(first.operationId, child.pending.operationId);
  assert.notEqual(first.toolCallId, child.pending.toolCallId);
  const saved = jsonSnapshot((await nativeRow(c))!.snapshot);
  assert.equal(saved.status, "running");
  const savedAgent = saved.context.execute_agent;
  assert(savedAgent && "resumePayload" in savedAgent);
  assert.deepEqual(savedAgent.resumePayload, {
    nodeId: "agent",
    operationId: first.operationId,
    approved: true,
  });
  for (let reopen = 0; reopen < 2; reopen++) {
    const h = fixture(c.path, c.metadata.ids);
    try {
      const native = await nativeCatalogOwner(h.controller);
      assert(
        await native.proveSuspended({
          runId: child.runId,
          threadId: child.threadId,
          resourceId: c.metadata.resourceId,
          toolCallId: child.pending.toolCallId,
        }),
      );
      const waiting = await start(h, c);
      assert.equal(waiting.status, "waiting", JSON.stringify(waiting));
      assert.equal(waiting.version, c.metadata.version);
      assert.deepEqual(waiting.approval, c.cut.journal.pending);
      sameCalls(h, c);
      assert.equal(
        jsonSnapshot((await nativeRow(c))!.snapshot).status,
        "suspended",
      );
    } finally {
      await h.close();
    }
  }
  const h = fixture(c.path, c.metadata.ids);
  try {
    h.onModel(() => ({ content: '{"result":"TEST-second-approved-done"}' }));
    const done = await h.runtime.resume(
      c.metadata.runId,
      { ...c.cut.journal.pending, approved: true },
      signal(),
    );
    assert.equal(done.status, "succeeded", JSON.stringify(done));
    assert.deepEqual(done.output, { result: "TEST-second-approved-done" });
    assert.deepEqual(done.operations, c.cut.journal.operations);
    assert.deepEqual(h.counts(), [["POST", 2]]);
    assert.equal(h.models().length, 3);
    assert.deepEqual(
      h.catalog.invocation(first.operationId, scope.workspaceId, scope.userId),
      c.cut.receipts.find((receipt) => receipt.id === first.operationId),
    );
    assert.equal(
      h.catalog.invocation(
        child.pending.operationId,
        scope.workspaceId,
        scope.userId,
      )?.status,
      "succeeded",
    );
    assert.deepEqual(await start(h, c), done);
    assert.deepEqual(h.counts(), [["POST", 2]]);
    assert.equal(h.models().length, 3);
  } finally {
    await h.close();
  }
  assert.deepEqual(nativeCalls, { starts: 0, restarts: 1 });
});

test("actual SIGKILL staged Agent output cannot qualify a parent while child execution is unretired", async (t) => {
  const c = await crash(t, "agent-staged");
  const child = c.cut.journal.agents.agent!;
  assert(child.output);
  assert.equal(c.cut.models, 1);
  for (let reopen = 0; reopen < 2; reopen++) {
    const h = fixture(c.path, c.metadata.ids);
    try {
      const runtime = await nativeCatalogOwner(h.controller);
      assert.equal(
        await runtime.proveRetired({
          runId: child.runId,
          threadId: child.threadId,
          resourceId: c.metadata.resourceId,
        }),
        false,
      );
      const failed = await start(h, c);
      assert.equal(failed.status, "failed");
      assert.equal(failed.failure?.code, "process_checkpoint_interrupted");
      sameCalls(h, c);
      assert.equal(
        await runtime.proveRetired({
          runId: child.runId,
          threadId: child.threadId,
          resourceId: c.metadata.resourceId,
        }),
        false,
      );
    } finally {
      await h.close();
    }
  }
});

const mutations = {
  "missing parent": async (c: Crashed) =>
    withNative(c, (store) =>
      store.deleteWorkflowRunById({
        workflowName: c.metadata.workflowName,
        runId: c.metadata.nativeRunId,
      }),
    ),
  "foreign resource": (c: Crashed) =>
    mutateNative(c, () => {}, "TEST-foreign-resource"),
  "foreign run": (c: Crashed) =>
    mutateNative(c, (s) => {
      s.runId = "TEST-foreign-run";
    }),
  "foreign input": (c: Crashed) =>
    mutateNative(c, (s) => {
      s.context.input = { name: "TEST-foreign-input" };
    }),
  "corrupt graph": (c: Crashed) =>
    mutateNative(c, (s) => {
      s.serializedStepGraph = [];
    }),
  "corrupt active path": (c: Crashed) =>
    mutateNative(c, (s) => {
      s.activePaths = [-1];
    }),
  "forged active success": (c: Crashed) =>
    mutateNative(c, (s) => {
      s.status = "success";
      s.result = { result: "TEST-forged-terminal-result" };
    }),
  "invalid active carry": (c: Crashed) =>
    mutateNative(c, (s) => {
      s.context.execute_lookup!.payload = {
        input: { name: "TEST-changed" },
        outputs: {},
        next: "lookup",
      };
    }),
  "invalid predecessor output": (c: Crashed) =>
    mutateNative(c, (s) => {
      s.context.execute_write!.payload = {
        input: c.metadata.input,
        outputs: { lookup: { value: "TEST-forged" } },
        next: "write",
      };
    }),
  "foreign resumed operation": (c: Crashed) =>
    mutateNative(c, (s) => {
      (
        s.context.execute_write as unknown as { resumePayload: unknown }
      ).resumePayload = {
        nodeId: "write",
        operationId: "TEST-foreign-operation",
        approved: true,
      };
    }),
  "changed resumed decision": (c: Crashed) =>
    mutateNative(c, (s) => {
      const step = s.context.execute_write as unknown as {
        resumePayload: unknown;
      };
      step.resumePayload = {
        ...(step.resumePayload as object),
        approved: false,
      };
    }),
  "foreign child resumed operation": (c: Crashed) =>
    mutateNative(c, (s) => {
      (
        s.context.execute_agent as unknown as { resumePayload: unknown }
      ).resumePayload = {
        nodeId: "agent",
        operationId: "TEST-foreign-child-operation",
        approved: true,
      };
    }),
  "changed child resumed decision": (c: Crashed) =>
    mutateNative(c, (s) => {
      const step = s.context.execute_agent as unknown as {
        resumePayload: unknown;
      };
      step.resumePayload = {
        ...(step.resumePayload as object),
        approved: false,
      };
    }),
  "invalid terminal output": (c: Crashed) =>
    mutateNative(c, (s) => {
      s.result = { result: 99 };
    }),
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`actual killed process rejects ${name} before native attachment and preserves canonical receipts`, async (t) => {
    const mode = [
      "foreign child resumed operation",
      "changed child resumed decision",
    ].includes(name)
      ? "agent-approved-retired"
      : name === "invalid terminal output"
        ? "parent-terminal"
        : [
              "invalid predecessor output",
              "foreign resumed operation",
              "changed resumed decision",
            ].includes(name)
          ? "write-receipt"
          : "read-receipt";
    const c = await crash(t, mode);
    await mutate(c);
    for (let reopen = 0; reopen < 2; reopen++) {
      const h = fixture(c.path, c.metadata.ids);
      try {
        await deny(h, c);
      } finally {
        await h.close();
      }
    }
  });
}

test("a killed approved retired child without durable decision history cannot use the saved parent approval", async (t) => {
  const c = await crash(t, "agent-approved-retired");
  const h = fixture(c.path, c.metadata.ids);
  try {
    const journal = h.catalog.turn(
      c.metadata.nativeRunId,
      scope.workspaceId,
      scope.userId,
    ) as Cut["journal"];
    Reflect.deleteProperty(journal.agents.agent!, "decisions");
    h.catalog.saveTurn(
      c.metadata.nativeRunId,
      scope.workspaceId,
      scope.userId,
      journal,
    );
    await deny(h, c);
  } finally {
    await h.close();
  }
});

test("a killed retired Agent still rejects an invalid persisted typed output before parent attachment", async (t) => {
  const c = await crash(t, "agent-retired");
  const h = fixture(c.path, c.metadata.ids);
  try {
    const journal = h.catalog.turn(
      c.metadata.nativeRunId,
      scope.workspaceId,
      scope.userId,
    ) as Cut["journal"];
    journal.agents.agent!.output = { result: 99 };
    h.catalog.saveTurn(
      c.metadata.nativeRunId,
      scope.workspaceId,
      scope.userId,
      journal,
    );
    await deny(h, c);
  } finally {
    await h.close();
  }
});

test("a killed known receipt cannot reset the original expired duration deadline", async (t) => {
  const c = await crash(t, "read-receipt");
  const h = fixture(c.path, c.metadata.ids);
  try {
    const journal = h.catalog.turn(
      c.metadata.nativeRunId,
      scope.workspaceId,
      scope.userId,
    ) as Cut["journal"];
    const artifact = h.registry.version(
      admin,
      c.metadata.processId,
      c.metadata.version,
    );
    journal.startedAt =
      Date.now() - artifact.definition.limits.maxDurationMs - 1;
    h.catalog.saveTurn(
      c.metadata.nativeRunId,
      scope.workspaceId,
      scope.userId,
      journal,
    );
    await deny(h, c);
  } finally {
    await h.close();
  }
});

for (const revocation of ["permission", "model", "budget", "memory"] as const) {
  test(`actual killed process rechecks current ${revocation} before recovered native attachment`, async (t) => {
    const c = await crash(
      t,
      revocation === "memory" ? "agent-saved-retired" : "agent-retired",
    );
    const h = fixture(c.path, c.metadata.ids);
    try {
      if (revocation === "permission") h.revoke();
      else if (revocation === "memory")
        h.memoryStore.setOptOut(h.memoryActor, {
          requestId: "TEST-recovery-optout",
          optOut: true,
        });
      else if (revocation === "budget") {
        const policy = h.catalog.inferenceBudget.policy(
          target.organizationId,
          target.workspaceId,
        );
        h.catalog.inferenceBudget.savePolicy(
          target.organizationId,
          target.workspaceId,
          policy.revision,
          { ...policy.settings, mode: "observe" },
        );
      } else {
        const id = h.model();
        const selected = h.catalog.model(
          target.organizationId,
          id,
          "tools",
        ).model;
        h.catalog.command(
          CatalogCommand.parse({
            ...target,
            type: "saveModel",
            id,
            revision: selected.revision,
            settings: {
              providerId: selected.providerId,
              name: selected.name,
              model: selected.model,
              kind: selected.kind,
              tools: selected.tools,
              enabled: false,
            },
          }),
        );
      }
      await deny(h, c);
    } finally {
      await h.close();
    }
  });
}

test("a killed retired child rechecks an enforce budget policy revision before cached output recovery", async (t) => {
  const c = await crash(t, "agent-retired");
  const h = fixture(c.path, c.metadata.ids);
  try {
    const policy = h.catalog.inferenceBudget.policy(
      target.organizationId,
      target.workspaceId,
    );
    assert.equal(policy.settings.mode, "enforce");
    h.catalog.inferenceBudget.savePolicy(
      target.organizationId,
      target.workspaceId,
      policy.revision,
      { ...policy.settings, maxTokens: policy.settings.maxTokens - 1 },
    );
    assert.equal(
      h.catalog.inferenceBudget.policy(
        target.organizationId,
        target.workspaceId,
      ).settings.mode,
      "enforce",
    );
    await deny(h, c);
  } finally {
    await h.close();
  }
});

test("a killed retired child's cached output cannot bypass an enforce policy revision through an earlier native control checkpoint", async (t) => {
  const c = await crash(t, "agent-retired");
  // Preserve the actual SIGKILL and retired domain child, then test a saved
  // native control point behind that domain commit. Never forge a terminal job.
  await mutateNative(c, (snapshot) => {
    for (const key of Object.keys(snapshot.context))
      if (key !== "input") delete snapshot.context[key];
    snapshot.context.initialize = {
      payload: c.metadata.input,
      status: "running",
      startedAt: Date.now(),
    };
    snapshot.activePaths = [0];
    snapshot.activeStepsPath = { initialize: [0] };
    snapshot.stepExecutionPath = [];
  });
  let expected: Awaited<ReturnType<typeof start>> | undefined;
  for (let reopen = 0; reopen < 2; reopen++) {
    const h = fixture(c.path, c.metadata.ids);
    try {
      if (reopen === 0) {
        const policy = h.catalog.inferenceBudget.policy(
          target.organizationId,
          target.workspaceId,
        );
        h.catalog.inferenceBudget.savePolicy(
          target.organizationId,
          target.workspaceId,
          policy.revision,
          { ...policy.settings, maxTokens: policy.settings.maxTokens - 1 },
        );
      }
      const before = await nativeRow(c);
      const failed = await start(h, c);
      assert.equal(failed.status, "failed", JSON.stringify(failed));
      assert.equal(failed.failure?.code, "catalog_budget_policy_changed");
      if (expected) assert.deepEqual(failed, expected);
      expected = failed;
      sameCalls(h, c);
      assert.deepEqual(await nativeRow(c), before);
    } finally {
      await h.close();
    }
  }
});

test("abort before recovery of a killed retired child leaves native checkpoints and receipts unchanged", async (t) => {
  const c = await crash(t, "agent-retired");
  for (let reopen = 0; reopen < 2; reopen++) {
    const h = fixture(c.path, c.metadata.ids);
    try {
      const before = await nativeRow(c);
      const controller = new AbortController();
      const reason = Error("TEST abort before process recovery");
      controller.abort(reason);
      await assert.rejects(
        h.runtime.start(
          c.metadata.processId,
          c.metadata.runId,
          c.metadata.input,
          controller.signal,
        ),
        (error) => error === reason,
      );
      assert.deepEqual(await nativeRow(c), before);
      sameCalls(h, c);
    } finally {
      await h.close();
    }
  }
});

test("recovery keeps the killed run's immutable version after a different version is activated", async (t) => {
  const c = await crash(t, "read-receipt");
  const h = fixture(c.path, c.metadata.ids);
  try {
    const process = h.registry.get(admin, c.metadata.processId);
    const replacement = ProcessDefinitionSchema.parse({
      ...process.draft,
      name: "TEST replacement active process",
    });
    assert.equal(replacement.kind, "workflow");
    if (replacement.kind !== "workflow") throw Error("TEST workflow expected");
    const last = replacement.steps.at(-1)!;
    assert.equal(last.type, "return");
    if (last.type !== "return") throw Error("TEST return expected");
    last.output = {
      result: { source: "literal", value: "TEST-replacement-result" },
    };
    const draft = h.registry.saveDraft(admin, {
      id: process.id,
      serviceId: process.serviceId,
      revision: process.revision,
      definition: replacement,
    });
    const version = h.registry.freezeDraft(admin, process.id, draft.revision);
    h.registry.recordTest(admin, process.id, version.version, {
      testId: "TEST-recovery-replacement-evidence",
      digest: version.digest,
      runnerVersion: "TEST-offline/1",
      passed: true,
      scenarios: [...PROCESS_TEST_SCENARIOS],
      reportDigest: processDigest({ replacement: true }),
    });
    h.registry.activate(
      admin,
      process.id,
      h.registry.get(admin, process.id).revision,
      version.version,
    );
    const old = await start(h, c);
    assert.equal(old.status, "succeeded", JSON.stringify(old));
    assert.equal(old.version, c.metadata.version);
    assert.deepEqual(old.output, { result: "TEST-result" });
    sameCalls(h, c);
    const next = await h.runtime.start(
      process.id,
      "TEST-recovery-new-run",
      c.metadata.input,
      signal(),
    );
    assert.equal(next.status, "succeeded");
    assert.equal(next.version, version.version);
    assert.deepEqual(next.output, { result: "TEST-replacement-result" });
    assert.deepEqual(h.counts(), [["GET", 2]]);
    assert.deepEqual(await start(h, c), old);
    assert.deepEqual(h.counts(), [["GET", 2]]);
  } finally {
    await h.close();
  }
});
