// Isolated synthetic SIGKILL fixture. Never imported by application code.
import { existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  fixture,
  signal,
  admin,
  target,
  scope,
} from "./service-process-runtime";
import { processAgent, callProcessTool } from "./service-process-agent";
import { processDigest } from "../../apps/server-identity/process-validation";
import { DatabaseSync } from "node:sqlite";
import { nativeCatalogOwner } from "../../apps/server-identity/mastra-runtime";
import { processRunRow } from "./pi-process";
import type { ProcessAgentState } from "../../apps/server-identity/process-agent-runtime";
import { processCompilerVersion } from "../../apps/server-agent/process-workflow";

type CutJournal = {
  status: string;
  agents: Record<string, ProcessAgentState>;
  operations: string[];
  pending?: { nodeId: string; operationId: string };
  trace: { steps: { callId?: string; status: string }[] };
};

async function main() {
  const directory = process.argv[2]!;
  const mode = process.argv[3]!;
  const modes = [
    "read-receipt",
    "write-receipt",
    "approval-pending",
    "agent-retired",
    "agent-approved-retired",
    "agent-second-approval",
    "agent-staged",
    "agent-saved-retired",
    "parent-terminal",
    "mapping-gap",
    "finish-gap",
  ];
  if (!directory || !modes.includes(mode))
    throw Error("TEST process recovery worker arguments invalid");
  const h = fixture(join(directory, "identity.sqlite"));
  const runId = "TEST-process-recovery-original";
  const input = { name: "TEST-input" };
  const resourceId = processDigest([
    scope.serverId,
    target.organizationId,
    scope.workspaceId,
    scope.userId,
  ]);
  const nativeRunId = processDigest(["service-process-1", resourceId, runId]);
  let noteId: string | undefined;
  if (mode === "agent-saved-retired")
    noteId = (
      await h.memoryStore.remember(h.memoryActor, {
        requestId: "TEST-process-recovery-memory",
        content: "TEST use Czech language",
        kind: "preference",
        source: { type: "user_note" },
        explicitIntent: true,
        settings: h.memorySettings,
      })
    ).id;
  const definition = mode.startsWith("agent-")
    ? processAgent(h, mode === "agent-saved-retired" ? "saved" : "conversation")
    : ["write-receipt", "approval-pending"].includes(mode)
      ? h.readWrite()
      : h.basic();
  const processId = h.activate(definition);
  if (mode === "agent-approved-retired")
    h.onModel(() =>
      h.models().length === 1
        ? callProcessTool()
        : { content: '{"result":"TEST-approved-done"}' },
    );
  if (mode === "agent-second-approval")
    h.onModel(() => {
      const call = callProcessTool();
      const first = h.models().length === 1;
      call.tool_calls[0]!.id = first
        ? "TEST-provider-write-A"
        : "TEST-provider-write-B";
      call.tool_calls[0]!.function.arguments = JSON.stringify({
        name: first ? "TEST-write-A" : "TEST-write-B",
      });
      return call;
    });
  const artifact = h.registry.version(admin, processId, 1);
  const compilerVersion = processCompilerVersion(definition);
  const workflowName =
    "niaro-process-" +
    createHash("sha256")
      .update(
        JSON.stringify([
          compilerVersion,
          nativeRunId,
          resourceId,
          artifact.digest,
        ]),
      )
      .digest("hex");
  const metadata = {
    mode,
    runId,
    nativeRunId,
    resourceId,
    input,
    processId,
    version: artifact.version,
    artifactDigest: artifact.digest,
    compilerVersion,
    workflowName,
    ids: h.ids,
    ...(noteId ? { noteId } : {}),
  };
  writeFileSync(join(directory, "metadata.json"), JSON.stringify(metadata));
  const journal = () =>
    h.catalog.turn(nativeRunId, scope.workspaceId, scope.userId) as CutJournal;
  const kill = (
    site: string,
    retired?: boolean,
    suspended?: boolean,
  ): never => {
    const current = journal();
    writeFileSync(
      join(directory, "cut.json"),
      JSON.stringify({
        mode,
        site,
        ...(retired === undefined ? {} : { childRetired: retired }),
        ...(suspended === undefined ? {} : { childSuspended: suspended }),
        journal: current,
        models: h.models().length,
        counts: h.counts(),
        receipts: current.operations.map((id) =>
          h.catalog.invocation(id, scope.workspaceId, scope.userId),
        ),
      }),
    );
    process.kill(process.pid, "SIGKILL");
    throw Error("TEST SIGKILL failed");
  };
  // The two gaps between the agent core's checkpoint commits (NIAR-303): a
  // node ended and the next one is entered but has not run; the return ended
  // and the run's terminal status is not yet stored. Read the stored
  // checkpoint at the next identity-queue call, which the engine makes before
  // anything else happens.
  let core: DatabaseSync | undefined;
  const gap = () => {
    if (!["mapping-gap", "finish-gap"].includes(mode)) return undefined;
    if (!existsSync(join(directory, "identity.sqlite.pi.sqlite")))
      return undefined;
    core ??= new DatabaseSync(join(directory, "identity.sqlite.pi.sqlite"), {
      readOnly: true,
    });
    const run = processRunRow(core, workflowName)?.parsed;
    if (!run || run.status !== "running") return undefined;
    const last = run.steps.at(-1);
    if (
      mode === "mapping-gap" &&
      run.steps.length === 2 &&
      run.steps[0]!.status === "success" &&
      last?.status === "running"
    )
      return "completed-node-before-next-node-runs";
    if (
      mode === "finish-gap" &&
      last?.nodeId === "done" &&
      last.status === "success"
    )
      return "completed-return-before-run-terminal-status";
    return undefined;
  };
  const save = h.catalog.saveTurn.bind(h.catalog);
  h.catalog.saveTurn = (...args) => {
    const state = args[3] as CutJournal;
    if (args[0] !== nativeRunId) return save(...args);
    if (mode === "parent-terminal" && state.status === "succeeded")
      kill("native-parent-terminal-before-domain-success");
    save(...args);
    const receipts = state.operations.map((id) =>
      h.catalog.invocation(id, scope.workspaceId, scope.userId),
    );
    if (
      mode === "read-receipt" &&
      receipts.some((r) => r?.effect === "read" && r.status === "succeeded")
    )
      kill("canonical-read-receipt-before-native-ack");
    if (
      mode === "write-receipt" &&
      receipts.some((r) => r?.effect === "write" && r.status === "succeeded")
    )
      kill("canonical-approved-write-receipt-before-native-ack");
    if (
      mode === "approval-pending" &&
      state.pending &&
      receipts.some((r) => r?.status === "awaiting_approval")
    )
      kill("canonical-pending-approval-before-native-suspension");
    if (
      mode === "agent-staged" &&
      Object.values(state.agents).some((agent) => agent.output)
    )
      kill("typed-child-output-before-native-retirement");
  };
  const serial = h.context.serial;
  h.context.serial = async (run) => {
    const value = await serial(run);
    const site = gap();
    if (site) kill(site);
    if (mode === "agent-second-approval" && h.models().length === 2) {
      const current = journal();
      const child = current?.agents.agent;
      if (
        child?.pending?.kind === "approval" &&
        child.decisions.length === 1 &&
        current.pending?.operationId === child.pending.operationId &&
        current.trace.steps.findLast((step) => step.callId === "agent")
          ?.status === "waiting"
      ) {
        const native = await nativeCatalogOwner(h.controller);
        if (
          !(await native.proveSuspended({
            runId: child.runId,
            threadId: child.threadId,
            resourceId,
            toolCallId: child.pending.toolCallId,
          }))
        )
          throw Error("TEST second pending child must be natively suspended");
        kill("second-child-approval-before-parent-ack", undefined, true);
      }
    }
    if (
      [
        "agent-retired",
        "agent-approved-retired",
        "agent-saved-retired",
      ].includes(mode)
    ) {
      const current = journal();
      const child = current?.agents.agent;
      if (
        child?.output &&
        current.trace.steps.some(
          (step) => step.callId === "agent" && step.status === "succeeded",
        )
      ) {
        const native = await nativeCatalogOwner(h.controller);
        const proved = await native.proveRetired({
          runId: child.runId,
          threadId: child.threadId,
          resourceId,
        });
        if (!proved || !native.isSettled(child.runId))
          throw Error("TEST typed child must be retired at this cut");
        kill("retired-typed-child-output-before-parent-ack", true);
      }
    }
    return value;
  };
  try {
    const started = await h.runtime.start(processId, runId, input, signal());
    if (
      [
        "write-receipt",
        "agent-approved-retired",
        "agent-second-approval",
      ].includes(mode)
    ) {
      if (!started.approval) throw Error("TEST write approval not reached");
      await h.runtime.resume(
        runId,
        { ...started.approval, approved: true },
        signal(),
      );
    }
    throw Error("TEST intended process crash cut was not reached");
  } finally {
    await h.close();
  }
}
void main().catch((error: unknown) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
