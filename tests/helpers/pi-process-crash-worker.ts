/**
 * One process of a Pi-level process run crash scenario (tests/pi-crash.node.ts).
 * Usage: pi-process-crash-worker.ts <scenario> <start|resume> <dir>
 *
 * A two-node process (an action, then the return) runs on the agent core
 * with a minimal domain: receipts in a side table decide whether the action
 * already took effect, as the identity server's receipts do.
 * - process-node: killed after the action's effect, before the node's end
 *   is stored in the run checkpoint.
 * - process-approval: killed while the run waits for an approval.
 */
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { NativeWorkflowInput, PiAgentCore } from "@niaro/server-agent/pi";
import type { ProcessResume } from "../../apps/server-agent/process-workflow";
import { proveProcessRunCheckpoint } from "../../apps/server-agent/process-checkpoint";
import { crashChild } from "./pi-crash";
import { processRunRow } from "./pi-process";
import { processWorkflow } from "./service-process";

const child = crashChild();

async function main() {
  const pi = await import("@niaro/server-agent/pi");
  const start = child.step === "start";
  const domain = new DatabaseSync(join(child.dir, "domain.sqlite"));
  domain.exec(
    "CREATE TABLE IF NOT EXISTS receipt(operation TEXT PRIMARY KEY, output TEXT NOT NULL, executions INTEGER NOT NULL)",
  );
  const receipt = (operation: string) =>
    domain
      .prepare("SELECT output, executions FROM receipt WHERE operation=?")
      .get(operation) as { output: string; executions: number } | undefined;
  const definition = processWorkflow("TEST-service", "TEST-action");
  const approval = child.scenario === "process-approval";
  const operation = "TEST-operation-lookup";
  let actions = 0;
  const action = async (
    _node: unknown,
    input: Record<string, unknown>,
    resume: ProcessResume | undefined,
  ): Promise<
    | { status: "complete"; output: unknown }
    | { status: "waiting"; approval: { nodeId: string; operationId: string } }
  > => {
    actions++;
    const done = receipt(operation);
    // The domain's receipt decides: a recorded effect is never repeated.
    if (done) return { status: "complete", output: JSON.parse(done.output) };
    if (approval && !resume)
      return {
        status: "waiting",
        approval: { nodeId: "lookup", operationId: operation },
      };
    if (approval && !resume?.approved) throw new Error("TEST rejected");
    const output = { value: `TEST-result for ${String(input.name)}` };
    domain
      .prepare("INSERT INTO receipt VALUES (?,?,1)")
      .run(operation, JSON.stringify(output));
    if (start && !approval) {
      child.mark("action_done");
      await child.hang();
    }
    return { status: "complete", output };
  };
  const input: NativeWorkflowInput = {
    runId: "TEST-run",
    resourceId: "TEST-resource",
    artifactDigest: "TEST-artifact",
    compilerVersion: "niaro-native-workflow/1",
    definition,
    input: { name: "TEST-input" },
    signal: new AbortController().signal,
    boundary: {
      authorize: async () => {},
      enter: async () => {},
      leave: async () => {},
      action,
      // A restart is admitted only after the domain proves every boundary.
      reconcile: (checkpoint, workflowId) =>
        proveProcessRunCheckpoint({
          checkpoint,
          workflowId,
          definition,
          compilerVersion: input.compilerVersion,
          proveNode: async () => {
            const done = receipt(operation);
            if (done)
              return { status: "complete", output: JSON.parse(done.output) };
            return approval
              ? {
                  status: "waiting",
                  approval: { nodeId: "lookup", operationId: operation },
                }
              : undefined;
          },
        }),
    },
  };
  const file = join(child.dir, "agent-core.sqlite");
  const core: PiAgentCore = await pi.PiAgentCore.open({
    file,
    host: {
      plan: async () => {
        throw new Error("TEST no model");
      },
    },
  });
  if (start) {
    const first = await core.executeProcess(input);
    if (first.status === "waiting") child.mark("suspended", first);
    child.mark("finished_without_crash", first);
    await child.hang();
  }
  const workflowId = pi.processWorkflowId(input);
  const read = () => {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return processRunRow(db, workflowId)?.parsed;
    } finally {
      db.close();
    }
  };
  const stored = read();
  const before = {
    status: stored?.status,
    steps: stored?.steps.map((step) => [step.nodeId, step.status]),
  };
  const results: unknown[] = [];
  const drive = async (resume?: ProcessResume, automatic = false) =>
    results.push(
      await core.executeProcess({
        ...input,
        recordedProgress: true,
        ...(automatic ? { automatic: true } : {}),
        ...(resume ? { resume } : {}),
      }),
    );
  // What the server does at start (policy A), no command needed.
  await drive(undefined, true);
  if (approval) {
    await drive();
    await drive({ nodeId: "lookup", operationId: operation, approved: true });
  }
  await drive();
  child.result({
    before,
    results,
    after: read()?.status,
    automaticRestarts: read()?.automaticRestarts ?? 0,
    executions: receipt(operation)?.executions ?? 0,
    actions,
  });
  await core.close();
  domain.close();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
