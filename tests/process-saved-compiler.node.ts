import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import type { PiAgentCore, NativeWorkflowInput } from "@niaro/server-agent/pi";
import {
  assertProcessCompilerSupported,
  processCompilerVersion,
  processWorkflowDefinition,
  ProcessApprovalSchema,
  ProcessCarrySchema,
  ProcessResumeSchema,
  type NativeWorkflowBoundary,
} from "../apps/server-agent/process-workflow";
import {
  processGraphDigest,
  proveProcessRunCheckpoint,
  type ProcessRunCheckpoint,
} from "../apps/server-agent/process-checkpoint";
import { ProcessDefinitionSchema } from "../packages/protocol/service-processes";
import {
  newServiceProcessJournal,
  serviceProcessRunIdentity,
} from "../apps/server-identity/service-process-journal";
import { processWorkflow } from "./helpers/service-process";
import {
  fixture,
  admin,
  scope,
  signal,
  code,
} from "./helpers/service-process-runtime";

type Pi = typeof import("@niaro/server-agent/pi");
let pi: Pi;
before(async () => {
  pi = await import("@niaro/server-agent/pi");
});

const action = processWorkflow("TEST-service", "TEST-action");
assert(action.kind === "workflow");
const { entry: _entry, steps: _steps, ...base } = action;
const agent = ProcessDefinitionSchema.parse({
  ...base,
  kind: "agent",
  modelId: "TEST-model",
  instructions: "TEST return typed output",
  memory: "none",
  capabilities: [],
});
const passive = async () => {
  throw new Error("TEST passive proof must not execute a boundary");
};
const boundary: NativeWorkflowBoundary = {
  authorize: async () => {},
  enter: passive,
  leave: passive,
  action: passive,
  agent: passive,
};
const savedIdentity = {
  runId: "TEST-legacy-run",
  resourceId: "TEST-legacy-resource",
  artifactDigest: "TEST-legacy-artifact",
};
const saved = [
  {
    compilerVersion: "niaro-native-workflow/1",
    definition: action,
    nodeId: "lookup",
  },
  {
    compilerVersion: "niaro-native-workflow/2",
    definition: agent,
    nodeId: "agent",
  },
  {
    compilerVersion: "niaro-native-workflow/2",
    definition: action,
    nodeId: "lookup",
  },
];
/** A stored run that ended: its one node, then the return. */
function savedCheckpoint(
  item: (typeof saved)[number],
  workflowId: string,
): ProcessRunCheckpoint {
  const input = { name: "TEST-input" };
  const workflow = processWorkflowDefinition(item.definition);
  const first = { input, outputs: {}, next: workflow.entry };
  const second = {
    input,
    outputs: { [item.nodeId]: { result: "TEST-output" } },
    next: "done",
  };
  return {
    version: 1,
    workflowId,
    runId: savedIdentity.runId,
    resourceId: savedIdentity.resourceId,
    graph: processGraphDigest(item.definition, item.compilerVersion),
    input,
    status: "success",
    steps: [
      {
        nodeId: workflow.entry,
        carry: first,
        status: "success",
        output: second,
      },
      {
        nodeId: "done",
        carry: second,
        status: "success",
        output: { ...second, next: null, result: { result: "TEST-output" } },
      },
    ],
    result: { result: "TEST-output" },
  };
}
async function withCore(run: (core: PiAgentCore) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "niaro-saved-compiler-"));
  const core = await pi.PiAgentCore.open({
    file: join(dir, "core.sqlite"),
    host: { plan: passive },
  });
  try {
    await run(core);
  } finally {
    await core.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
const store = (core: PiAgentCore, run: ProcessRunCheckpoint) =>
  core.harness.commit(async (tx) => {
    const draft = await tx.doc(
      pi.ProcessRunDoc,
      run.workflowId,
      run.workflowId,
    );
    for (const key of Object.keys(draft)) delete draft[key];
    Object.assign(draft, JSON.parse(JSON.stringify(run)));
  }, pi.ctx);

for (const item of saved) {
  test(`${item.compilerVersion} ${item.definition.kind} reattaches its saved terminal and suspended checkpoints and refuses a changed graph`, () =>
    withCore(async (core) => {
      const input: NativeWorkflowInput = {
        ...savedIdentity,
        compilerVersion: item.compilerVersion,
        definition: item.definition,
        input: { name: "TEST-input" },
        signal: signal(),
        boundary,
        recordedProgress: true,
      };
      const workflowId = pi.processWorkflowId(input);
      const run = savedCheckpoint(item, workflowId);
      await store(core, run);
      assert.deepEqual(await core.executeProcess(input), {
        status: "succeeded",
        output: { result: "TEST-output" },
      });
      assert.equal(await core.proveProcessRetired(input), true);
      run.status = "suspended";
      run.steps = [
        {
          nodeId: run.steps[0]!.nodeId,
          carry: run.steps[0]!.carry,
          status: "suspended",
          pending: { nodeId: item.nodeId, operationId: "TEST-operation" },
        },
      ];
      delete run.result;
      await store(core, run);
      assert.deepEqual(await core.executeProcess(input), {
        status: "waiting",
        approval: { nodeId: item.nodeId, operationId: "TEST-operation" },
      });
      assert.equal(await core.proveProcessRetired(input), true);
      run.graph = "0".repeat(64);
      await store(core, run);
      assert.deepEqual(await core.executeProcess(input), {
        status: "failed",
        code: "process_checkpoint_invalid",
      });
      assert.equal(await core.proveProcessRetired(input), false);
    }));
}

test("saved compiler compatibility is independent of new-run selection and preserves legacy schemas", () =>
  withCore(async (core) => {
    assert.equal(processCompilerVersion(action), "niaro-native-workflow/1");
    assert.equal(processCompilerVersion(agent), "niaro-native-workflow/2");
    assert.doesNotThrow(() =>
      assertProcessCompilerSupported("niaro-native-workflow/2", action),
    );
    assert.throws(
      () => assertProcessCompilerSupported("niaro-native-workflow/1", agent),
      /process_compiler_incompatible/,
    );
    assert.throws(
      () =>
        assertProcessCompilerSupported(
          "niaro-native-workflow/1",
          processWorkflowDefinition(agent),
        ),
      /process_compiler_incompatible/,
    );
    for (const compilerVersion of [
      "niaro-native-workflow/3",
      "TEST-unsupported",
      undefined,
    ]) {
      const input: NativeWorkflowInput = {
        ...savedIdentity,
        compilerVersion: compilerVersion as string,
        definition: action,
        input: {},
        signal: signal(),
        boundary,
      };
      assert.equal(await core.proveProcessRetired(input), false);
      await assert.rejects(
        core.executeProcess(input),
        compilerVersion === "niaro-native-workflow/3"
          ? /process_compiler_incompatible/
          : /process_compiler_unsupported/,
      );
    }
    assert.deepEqual(
      ProcessApprovalSchema.parse({
        nodeId: "lookup",
        operationId: "TEST-operation",
      }),
      { nodeId: "lookup", operationId: "TEST-operation" },
    );
    assert.equal(
      ProcessApprovalSchema.safeParse({
        kind: "question",
        nodeId: "lookup",
        questionId: "TEST-question",
      }).success,
      false,
    );
    assert.equal(
      ProcessResumeSchema.safeParse({
        nodeId: "lookup",
        operationId: "TEST-operation",
        approved: true,
        answer: "TEST-answer",
      }).success,
      false,
    );
    assert.equal(
      ProcessCarrySchema.safeParse({
        input: {},
        outputs: {},
        next: null,
        questions: {},
      }).success,
      false,
    );
    // A run stopped right after it began proves without touching a boundary.
    const item = saved[2]!;
    const workflowId = "TEST-workflow";
    const checkpoint = savedCheckpoint(item, workflowId);
    checkpoint.status = "running";
    checkpoint.steps = [];
    delete checkpoint.result;
    const proof = {
      checkpoint,
      workflowId,
      definition: action,
      compilerVersion: "niaro-native-workflow/2",
      proveNode: passive,
    };
    assert.equal(await proveProcessRunCheckpoint(proof), true);
    assert.equal(
      await proveProcessRunCheckpoint({
        ...proof,
        compilerVersion: "niaro-native-workflow/3",
      }),
      false,
    );
    assert.equal(
      await proveProcessRunCheckpoint({
        ...proof,
        compilerVersion: "niaro-native-workflow/1",
        definition: agent,
      }),
      false,
    );
  }));

test("service runtime resumes the explicit saved /2 action compiler even though admission selects /1", async () => {
  const directory = mkdtempSync(join(tmpdir(), "niaro-saved-compiler-"));
  const path = join(directory, "identity.sqlite");
  const h = fixture(path);
  let restarted: ReturnType<typeof fixture> | undefined;
  try {
    const processId = h.activate(h.readWrite());
    const runId = "TEST-saved-compiler";
    const identity = serviceProcessRunIdentity(
      scope,
      admin.organizationId,
      runId,
    );
    const artifact = h.registry.pinRun(admin, processId, identity.parentRunId);
    assert.equal(
      processCompilerVersion(artifact.definition),
      "niaro-native-workflow/1",
    );
    const journal = newServiceProcessJournal(
      artifact,
      runId,
      scope,
      admin.organizationId,
      { name: "TEST-input" },
      Date.now(),
    );
    journal.compilerVersion = "niaro-native-workflow/2";
    h.catalog.saveTurn(
      identity.parentRunId,
      scope.workspaceId,
      scope.userId,
      journal,
    );
    const waiting = await h.runtime.start(
      processId,
      runId,
      journal.input,
      signal(),
    );
    assert.equal(waiting.status, "waiting");
    assert(waiting.approval);
    await h.close();
    restarted = fixture(path, h.ids);
    const done = await restarted.runtime.resume(
      runId,
      { ...waiting.approval, approved: true },
      signal(),
    );
    assert.equal(done.status, "succeeded", JSON.stringify(done));
    assert.deepEqual(restarted.counts(), [
      ["GET", 1],
      ["POST", 1],
    ]);
    const saved = restarted.catalog.turn(
      identity.parentRunId,
      scope.workspaceId,
      scope.userId,
    ) as typeof journal;
    assert.equal(saved.compilerVersion, "niaro-native-workflow/2");
    saved.compilerVersion = "niaro-native-workflow/3";
    restarted.catalog.saveTurn(
      identity.parentRunId,
      scope.workspaceId,
      scope.userId,
      saved,
    );
    await assert.rejects(
      restarted.runtime.start(processId, runId, journal.input, signal()),
      code("process_conflict"),
    );
    assert.deepEqual(restarted.counts(), [
      ["GET", 1],
      ["POST", 1],
    ]);
  } finally {
    await restarted?.close();
    await h.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
