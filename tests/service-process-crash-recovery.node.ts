import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { ProcessRunCheckpoint } from "../apps/server-agent/process-checkpoint";
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
import { processRunRow } from "./helpers/pi-process";
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
  "mapping-gap": "completed-node-before-next-node-runs",
  "finish-gap": "completed-return-before-run-terminal-status",
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

/** The process run checkpoints live in the agent core beside the identity DB. */
const coreFile = (c: Crashed) => `${c.path}.pi.sqlite`;
async function nativeRow(c: Crashed) {
  const db = new DatabaseSync(coreFile(c), { readOnly: true });
  try {
    return processRunRow(db, c.metadata.workflowName);
  } finally {
    db.close();
  }
}
/** Rewrite the stored run checkpoint through a core opened without resuming. */
async function withCore(
  c: Crashed,
  change: (
    tx: Parameters<
      Parameters<
        Awaited<
          ReturnType<
            (typeof import("@niaro/server-agent/pi"))["PiAgentCore"]["open"]
          >
        >["harness"]["commit"]
      >[0]
    >[0],
    pi: typeof import("@niaro/server-agent/pi"),
  ) => Promise<void>,
) {
  const pi = await import("@niaro/server-agent/pi");
  const core = await pi.PiAgentCore.open({
    file: coreFile(c),
    resume: false,
    host: {
      plan: async () => {
        throw new Error("TEST no model");
      },
    },
  });
  try {
    await core.harness.commit((tx) => change(tx, pi), pi.ctx);
  } finally {
    await core.close();
  }
}
async function mutateNative(
  c: Crashed,
  mutate: (run: ProcessRunCheckpoint) => void,
  resourceId = c.metadata.resourceId,
) {
  await withCore(c, async (tx, pi) => {
    const key = c.metadata.workflowName;
    const draft = await tx.doc(pi.ProcessRunDoc, key, key);
    const run = JSON.parse(JSON.stringify(draft)) as ProcessRunCheckpoint;
    mutate(run);
    run.resourceId = resourceId;
    for (const name of Object.keys(draft)) delete draft[name];
    Object.assign(draft, JSON.parse(JSON.stringify(run)));
  });
}
/** Drives of process runs the agent core has started (one task each). */
function drives(c: Crashed) {
  const db = new DatabaseSync(coreFile(c), { readOnly: true });
  try {
    return Number(
      (
        db
          .prepare("SELECT count(*) AS n FROM tasks WHERE kind IN (?,?)")
          .get(
            "niaro.process-segment",
            JSON.stringify("niaro.process-segment"),
          ) as { n: number }
      ).n,
    );
  } finally {
    db.close();
  }
}
const step = (run: ProcessRunCheckpoint, nodeId: string) => {
  const found = run.steps.find((item) => item.nodeId === nodeId);
  assert(found, `TEST stored run must have entered ${nodeId}`);
  return found;
};
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

/** Count the drives a test causes after the crash; a restart is one drive. */
function nativeRecoveryCalls(_t: TestContext, c: Crashed) {
  const before = drives(c);
  return { restarts: () => drives(c) - before };
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
    const nativeCalls = nativeRecoveryCalls(t, c);
    const row = await nativeRow(c);
    assert(row);
    const snapshot = row.parsed;
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
    assert.equal(nativeCalls.restarts(), mode === "parent-terminal" ? 0 : 1);
  });
}

test("actual SIGKILL before native suspension restores exactly the original pending approval without dispatch", async (t) => {
  const c = await crash(t, "approval-pending");
  const nativeCalls = nativeRecoveryCalls(t, c);
  assert(c.cut.journal.pending);
  assert.equal((await nativeRow(c))!.parsed.status, "running");
  assert.deepEqual(c.cut.counts, [["GET", 1]]);
  for (let reopen = 0; reopen < 2; reopen++) {
    const h = fixture(c.path, c.metadata.ids);
    try {
      const waiting = await start(h, c);
      assert.equal(waiting.status, "waiting", JSON.stringify(waiting));
      assert.deepEqual(waiting.approval, c.cut.journal.pending);
      sameCalls(h, c);
      assert.equal((await nativeRow(c))!.parsed.status, "suspended");
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
  // One proved restart, then the approval's own drive.
  assert.equal(nativeCalls.restarts(), 2);
});

test("actual SIGKILL second child approval preserves consumed first decision and exact pending second write across two reopens", async (t) => {
  const c = await crash(t, "agent-second-approval");
  const nativeCalls = nativeRecoveryCalls(t, c);
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
  const saved = (await nativeRow(c))!.parsed;
  assert.equal(saved.status, "running");
  const savedAgent = step(saved, "agent");
  assert.deepEqual(savedAgent.resume, {
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
      assert.equal((await nativeRow(c))!.parsed.status, "suspended");
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
  // One proved restart, then the approval's own drive.
  assert.equal(nativeCalls.restarts(), 2);
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
  "missing parent": (c: Crashed) =>
    withCore(c, (tx, pi) =>
      tx.retireDoc(pi.ProcessRunDoc, c.metadata.workflowName),
    ),
  "foreign resource": (c: Crashed) =>
    mutateNative(c, () => {}, "TEST-foreign-resource"),
  "foreign run": (c: Crashed) =>
    mutateNative(c, (s) => {
      s.runId = "TEST-foreign-run";
    }),
  "foreign input": (c: Crashed) =>
    mutateNative(c, (s) => {
      s.input = { name: "TEST-foreign-input" };
    }),
  "corrupt graph": (c: Crashed) =>
    mutateNative(c, (s) => {
      s.graph = "0".repeat(64);
    }),
  "corrupt step order": (c: Crashed) =>
    mutateNative(c, (s) => {
      s.steps[0]!.nodeId = "TEST-unknown-node";
    }),
  "forged active success": (c: Crashed) =>
    mutateNative(c, (s) => {
      s.status = "success";
      s.result = { result: "TEST-forged-terminal-result" };
    }),
  "invalid active carry": (c: Crashed) =>
    mutateNative(c, (s) => {
      step(s, "lookup").carry = {
        input: { name: "TEST-changed" },
        outputs: {},
        next: "lookup",
      };
    }),
  "invalid predecessor output": (c: Crashed) =>
    mutateNative(c, (s) => {
      step(s, "write").carry = {
        input: c.metadata.input,
        outputs: { lookup: { value: "TEST-forged" } },
        next: "write",
      };
    }),
  "foreign resumed operation": (c: Crashed) =>
    mutateNative(c, (s) => {
      step(s, "write").resume = {
        nodeId: "write",
        operationId: "TEST-foreign-operation",
        approved: true,
      };
    }),
  "changed resumed decision": (c: Crashed) =>
    mutateNative(c, (s) => {
      const write = step(s, "write");
      write.resume = { ...(write.resume as object), approved: false };
    }),
  "foreign child resumed operation": (c: Crashed) =>
    mutateNative(c, (s) => {
      step(s, "agent").resume = {
        nodeId: "agent",
        operationId: "TEST-foreign-child-operation",
        approved: true,
      };
    }),
  "changed child resumed decision": (c: Crashed) =>
    mutateNative(c, (s) => {
      const agent = step(s, "agent");
      agent.resume = { ...(agent.resume as object), approved: false };
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
  await mutateNative(c, (run) => {
    run.steps = [];
    run.status = "running";
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
