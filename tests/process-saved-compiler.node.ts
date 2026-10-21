import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Mastra } from "@mastra/core/mastra";
import type { LibSQLStore } from "@mastra/libsql";
import {
  assertProcessCompilerSupported,
  compileProcessWorkflow,
  processCompilerVersion,
  processWorkflowDefinition,
  ProcessApprovalSchema,
  ProcessCarrySchema,
  ProcessResumeSchema,
  type NativeWorkflowBoundary,
} from "../apps/server-agent/process-workflow";
import {
  executeNativeWorkflow,
  proveNativeWorkflowRetirement,
  type NativeWorkflowInput,
} from "../apps/server-agent/process-runtime";
import {
  proveProcessWorkflowCheckpoint,
  type ProcessWorkflowCheckpoint,
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
// Captured from the installed legacy compiler before adding compiler dispatch.
// These pin native IDs, branch functions and the persisted carrySchema map ABI.
const legacy = [
  {
    compilerVersion: "niaro-native-workflow/1",
    definition: action,
    workflowId:
      "niaro-process-bffe9dc294730d0e342b9c68766b0b800f03fc948def29cc0f0cda2b27e34caf",
    graphDigest:
      "d9c73c51d5f502de8d5c27d77ae7e3040f9c538a805ca567a282b41a2ad76293",
    nodeId: "lookup",
  },
  {
    compilerVersion: "niaro-native-workflow/2",
    definition: agent,
    workflowId:
      "niaro-process-179472e25d590f3758589091230d65b539073a0603a89ff54d893aa69cbc6e12",
    graphDigest:
      "e045f9cbd9d4ad210652bcbd87382573c0cf2f24a3835cb0f025bf7fac57cdb7",
    nodeId: "agent",
  },
  {
    compilerVersion: "niaro-native-workflow/2",
    definition: action,
    workflowId:
      "niaro-process-179472e25d590f3758589091230d65b539073a0603a89ff54d893aa69cbc6e12",
    graphDigest:
      "ceafd37b9660e0e9f8bef7e7dd152500fd2e2b9b5d375e956b6c69d19a15105c",
    nodeId: "lookup",
  },
];
function legacyGraph(workflowId: string, nodeId: string) {
  const branch = (id: string) => ({
    type: "conditional",
    steps: [
      { type: "step", step: { id: `execute_${id}`, canSuspend: true } },
      { type: "step", step: { id: `skip_${id}`, canSuspend: false } },
    ],
    serializedConditions: [
      {
        id: `execute_${id}-condition`,
        fn: "async({inputData})=>inputData.next===node.id",
      },
      {
        id: `skip_${id}-condition`,
        fn: "async({inputData})=>inputData.next!==node.id",
      },
    ],
  });
  const mapping = (index: number) => ({
    type: "mapping",
    id: `mapping_${workflowId}_${index}`,
    mapConfig:
      "async({inputData})=>carrySchema.parse(inputData[execute.id]??inputData[skip.id])",
  });
  return [
    { type: "step", step: { id: "initialize", canSuspend: false } },
    branch(nodeId),
    mapping(0),
    branch("done"),
    mapping(1),
    { type: "step", step: { id: "finish", canSuspend: false } },
  ];
}
function savedCheckpoint(
  workflowId: string,
  nodeId: string,
): ProcessWorkflowCheckpoint {
  return {
    runId: savedIdentity.runId,
    status: "success",
    context: { input: { name: "TEST-input" } },
    serializedStepGraph: legacyGraph(workflowId, nodeId),
    activePaths: [5],
    activeStepsPath: {},
    suspendedPaths: {},
    waitingPaths: {},
    resumeLabels: {},
    result: { result: "TEST-output" },
  } satisfies ProcessWorkflowCheckpoint;
}

for (const saved of legacy) {
  test(`${saved.compilerVersion} ${saved.definition.kind} retains its exact native graph and reattaches saved terminal/suspended rows`, async () => {
    const compiled = compileProcessWorkflow(
      saved.workflowId,
      saved.definition,
      boundary,
      AbortSignal.abort(),
      saved.compilerVersion,
    );
    const graph = JSON.parse(JSON.stringify(compiled.serializedStepGraph));
    assert.deepEqual(graph, legacyGraph(saved.workflowId, saved.nodeId));
    assert.equal(
      createHash("sha256").update(JSON.stringify(graph)).digest("hex"),
      saved.graphDigest,
    );
    const snapshot: ProcessWorkflowCheckpoint = savedCheckpoint(
      saved.workflowId,
      saved.nodeId,
    );
    const queries: unknown[] = [];
    const storage = {
      getStore: async () => ({
        getWorkflowRunById: async (query: unknown) => {
          queries.push(query);
          return {
            workflowName: saved.workflowId,
            runId: savedIdentity.runId,
            resourceId: savedIdentity.resourceId,
            snapshot: JSON.stringify(snapshot),
          };
        },
      }),
    } as unknown as LibSQLStore;
    const mastra = { addWorkflow: passive } as unknown as Mastra;
    const input: NativeWorkflowInput = {
      ...savedIdentity,
      compilerVersion: saved.compilerVersion,
      definition: saved.definition,
      input: { name: "TEST-input" },
      signal: signal(),
      boundary,
      recordedProgress: true,
    };
    assert.deepEqual(await executeNativeWorkflow(mastra, storage, input), {
      status: "succeeded",
      output: { result: "TEST-output" },
    });
    assert.equal(await proveNativeWorkflowRetirement(storage, input), true);
    snapshot.status = "suspended";
    snapshot.context[`execute_${saved.nodeId}`] = {
      status: "suspended",
      suspendPayload: { nodeId: saved.nodeId, operationId: "TEST-operation" },
    };
    assert.deepEqual(await executeNativeWorkflow(mastra, storage, input), {
      status: "waiting",
      approval: { nodeId: saved.nodeId, operationId: "TEST-operation" },
    });
    assert.equal(await proveNativeWorkflowRetirement(storage, input), true);
    assert(
      queries.every(
        (query) =>
          JSON.stringify(query) ===
          JSON.stringify({
            workflowName: saved.workflowId,
            runId: savedIdentity.runId,
          }),
      ),
    );
    snapshot.serializedStepGraph[2] = { type: "mapping", id: "TEST-replaced" };
    assert.deepEqual(await executeNativeWorkflow(mastra, storage, input), {
      status: "failed",
      code: "process_checkpoint_invalid",
    });
    assert.equal(await proveNativeWorkflowRetirement(storage, input), false);
  });
}

test("saved compiler compatibility is independent of new-run selection and preserves legacy schemas", async () => {
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
    assert.throws(
      () =>
        compileProcessWorkflow(
          "TEST-unsupported",
          action,
          boundary,
          signal(),
          compilerVersion as string,
        ),
      compilerVersion === "niaro-native-workflow/3"
        ? /process_compiler_incompatible/
        : /process_compiler_unsupported/,
    );
    const input: NativeWorkflowInput = {
      ...savedIdentity,
      compilerVersion: compilerVersion as string,
      definition: action,
      input: {},
      signal: signal(),
      boundary,
    };
    const storage = { getStore: passive } as unknown as LibSQLStore;
    assert.equal(await proveNativeWorkflowRetirement(storage, input), false);
    await assert.rejects(
      executeNativeWorkflow({} as Mastra, storage, input),
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

  const saved = legacy[0]!;
  const checkpoint = savedCheckpoint(saved.workflowId, saved.nodeId);
  checkpoint.status = "running";
  checkpoint.activePaths = [0];
  checkpoint.context.initialize = {
    status: "success",
    payload: checkpoint.context.input,
    output: { input: checkpoint.context.input, outputs: {}, next: "lookup" },
  };
  const proof = {
    checkpoint,
    workflowId: saved.workflowId,
    definition: action,
    compilerVersion: "niaro-native-workflow/2",
    proveNode: passive,
  };
  assert.equal(await proveProcessWorkflowCheckpoint(proof), true);
  assert.equal(
    await proveProcessWorkflowCheckpoint({
      ...proof,
      compilerVersion: "niaro-native-workflow/3",
    }),
    false,
  );
  assert.equal(
    await proveProcessWorkflowCheckpoint({
      ...proof,
      compilerVersion: "niaro-native-workflow/1",
      definition: agent,
    }),
    false,
  );
});

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
