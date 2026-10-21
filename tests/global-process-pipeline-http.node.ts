import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ClientSession } from "../packages/client-core/session";
import { PROCESS_QUESTION_EXECUTION_PROFILE } from "../packages/protocol/process-questions";
import {
  processStartCommand,
  captureProcessResolveTarget,
  processResolveCommand,
} from "../packages/client-core/process-commands";
import {
  captureProcessAnswerTarget,
  processAnswerCommand,
} from "../packages/client-core/process-answers";
import { WORKSPACE_DESIGN_PROFILE } from "../packages/protocol/process-design";
import { pipelineHttpChildFixture } from "./helpers/process-pipeline-http-child";

const ids = () => {
  const commandId = randomUUID();
  return {
    commandId,
    idempotencyKey: commandId + "-key",
    language: "en" as const,
  };
};
const storage = () => {
  const values = new Map<string, string>();
  return {
    getItem: async (k: string) => values.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      values.set(k, v);
    },
  };
};
async function settle(s: ClientSession) {
  const until = Date.now() + 10000;
  while (!s.getSnapshot().store || s.getSnapshot().store!.stale) {
    assert(Date.now() < until);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("workspace designer, real native qualification, explicit activation and paired Session share exact multi-service effects across restart", async () => {
  const h = await pipelineHttpChildFixture({ workspaceOwned: true });
  try {
    const setup = await h.completePipeline();
    for (const path of [
      "/admin/processes",
      "/admin/processes/design",
      "/admin/processes/" + setup.artifact.processId,
    ]) {
      const response = await fetch(h.origin + path);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
    }
    assert.equal(setup.design.review.profile, WORKSPACE_DESIGN_PROFILE);
    assert.equal(setup.design.review.serviceId, undefined);
    assert.equal(setup.job.qualification?.status, "qualified");
    assert.equal(setup.job.report?.observations.length, 12);
    assert(setup.job.report!.observations.every((o) => o.passed));
    assert.equal(setup.activation.processId, setup.artifact.processId);
    assert.deepEqual(
      new Set(
        setup.artifact.sources.resources
          .filter((r) => r.kind === "service")
          .map((r) => r.id),
      ),
      new Set([setup.serviceId, setup.calendarId]),
    );
    assert.deepEqual((await h.inspect()).serviceDispatches, []);
    for (const scenario of ["success", "unknown"] as const) {
      await h.restart();
      await h.runtimeScenario(scenario);
      const saved = storage();
      let session = new ClientSession(
        setup.endpoint,
        saved,
        setup.credential,
        fetch,
        undefined,
        undefined,
        false,
        { processOutputs: true },
      );
      try {
        await session.start(false);
        await settle(session);
        const inventory = await session.loadProcessInventory(),
          entry = inventory.processes.find(
            (p) => p.processId === setup.artifact.processId,
          );
        assert(entry?.availability === "ready");
        const target = await session.prepareProcessInput(
          {
            processId: entry.processId,
            version: entry.version,
            artifactDigest: entry.artifactDigest,
            language: "en",
            origin: {
              type: "command",
              conversationId: "conversation-1",
              requestId: randomUUID(),
            },
          },
          entry,
        );
        const start = processStartCommand(target, {
          ...ids(),
          input: setup.input,
        });
        await session.send(start, false, target);
        await settle(session);
        const work = () =>
          Object.values(session.getSnapshot().store!.workItems).find(
            (w) => w.native?.process?.provenance.commandId === start.commandId,
          )!;
        assert.equal(work().status, "waiting_input");
        const answerTarget = captureProcessAnswerTarget(
          session.getSnapshot().store!,
          work().id,
          "conversation-1",
        );
        const answer = processAnswerCommand(
          session.getSnapshot().store!,
          answerTarget,
          { ...ids(), answer: setup.answer },
        );
        await session.send(answer);
        await settle(session);
        assert.equal(work().status, "waiting_approval");
        const resolveTarget = captureProcessResolveTarget(
          session.getSnapshot().store!,
          work().id,
          undefined,
          "conversation-1",
        );
        const operationId = resolveTarget.receipt.operationId;
        const before = await h.inspect();
        session.stop();
        await h.restart();
        session = new ClientSession(
          setup.endpoint,
          saved,
          setup.credential,
          fetch,
          undefined,
          undefined,
          false,
          { processOutputs: true },
        );
        await session.start(false);
        await settle(session);
        assert.equal(
          work().native!.process!.approval!.result.operationId,
          operationId,
        );
        const command = processResolveCommand(
          session.getSnapshot().store!,
          resolveTarget,
          { ...ids(), approved: true },
        );
        await session.send(command, false, resolveTarget);
        await settle(session);
        const final = await h.inspect();
        const newReceipts = final.receipts.filter(
          (r) => !before.receipts.some((old) => old.id === r.id),
        );
        const effect = final.receipts.find((r) => r.id === operationId)!;
        assert.equal(effect.serviceId, setup.calendarId);
        assert.equal(
          effect.status,
          scenario === "success" ? "succeeded" : "unknown",
        );
        const writeCount = final.serviceDispatches.filter(
          (d) => d.method === "POST",
        ).length;
        const replay = await fetch(
          setup.endpoint +
            "/processes/commands?profile=" +
            PROCESS_QUESTION_EXECUTION_PROFILE,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${setup.credential.accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(command),
          },
        );
        assert(replay.ok);
        assert.equal(
          (await h.inspect()).serviceDispatches.filter(
            (d) => d.method === "POST",
          ).length,
          writeCount,
        );
        assert.equal(
          work().status,
          scenario === "success" ? "succeeded" : "waiting_system",
        );
        assert.equal(
          work().native!.process!.status,
          scenario === "success" ? "succeeded" : "unknown",
        );
        if (scenario === "success")
          assert(
            newReceipts.some(
              (r) => r.effect === "read" && r.status === "succeeded",
            ),
          );
      } finally {
        session.stop();
      }
    }
  } finally {
    await h.close();
  }
});

test("authenticated mobile draft qualifies as the exact inactive artifact without service dispatch", async () => {
  const h = await pipelineHttpChildFixture({ workspaceOwned: true });
  try {
    const setup = await h.qualifyMobileDraft();
    assert.equal(setup.design.review.profile, WORKSPACE_DESIGN_PROFILE);
    assert.equal(
      setup.design.review.acceptedProcessId,
      setup.artifact.processId,
    );
    assert.equal(
      (setup.design.receipt as { processId?: string }).processId,
      setup.artifact.processId,
    );
    assert.equal(setup.job.qualification?.status, "qualified");
    assert.equal(setup.job.processId, setup.artifact.processId);
    assert.equal(setup.job.version, setup.artifact.version);
    assert.equal(setup.job.stamp.artifactDigest, setup.artifact.digest);
    assert.equal(setup.job.report?.qualification, "native_scripted");
    assert.equal(
      setup.job.report?.agentExecution,
      "native_agent_scripted_provider",
    );
    assert.equal(setup.job.report?.adapterMode, "isolated_catalog_receipts");
    assert.equal(setup.job.report?.activationEligible, false);
    assert.equal(setup.job.report?.observations.length, 12);
    assert(
      setup.job.report?.observations.every((observation) => observation.passed),
    );
    assert.equal(setup.activation, undefined);

    const after = await h.inspect();
    const designRequests = after.requests.filter((request) =>
      request.path.includes("process-design"),
    );
    for (const action of ["start", "turns", "acknowledge", "accept"]) {
      assert(
        designRequests.some(
          (request) =>
            request.method === "POST" &&
            request.path.startsWith(
              `/v1/${setup.target.workspaceId}/process-design/${action}`,
            ),
        ),
        `mobile bearer designer must POST ${action}`,
      );
    }
    assert(
      after.requests.every(
        (request) =>
          !request.path.startsWith(
            "/admin/api/identity/catalog/processes/design",
          ),
      ),
      "mobile acceptance must not use the admin designer route",
    );
    const saved = after.processes.find(
      (process) => process.id === setup.artifact.processId,
    );
    assert(saved);
    assert.equal(saved.activeVersion, null);
    assert.equal(after.serviceDispatches.length, 0);
  } finally {
    await h.close();
  }
});

test("authenticated service-owned mobile draft qualifies its exact inactive artifact without execution inventory or service dispatch", async () => {
  const h = await pipelineHttpChildFixture();
  let session: ClientSession | undefined;
  try {
    const setup = await h.qualifyMobileServiceDraft();
    assert.equal(setup.design.review.profile, "agent-process-design/1");
    assert.equal(setup.design.review.serviceId, setup.serviceId);
    assert.equal(
      setup.design.review.acceptedProcessId,
      setup.artifact.processId,
    );
    assert.equal(
      (setup.design.receipt as { processId?: string }).processId,
      setup.artifact.processId,
    );
    assert.equal(setup.job.qualification?.status, "qualified");
    assert.equal(setup.job.processId, setup.artifact.processId);
    assert.equal(setup.job.version, setup.artifact.version);
    assert.equal(setup.job.stamp.artifactDigest, setup.artifact.digest);
    assert.equal(setup.job.report?.qualification, "native_scripted");
    assert.equal(
      setup.job.report?.agentExecution,
      "native_agent_scripted_provider",
    );
    assert.equal(setup.job.report?.adapterMode, "isolated_catalog_receipts");
    assert.equal(setup.job.report?.activationEligible, false);
    assert.equal(setup.job.report?.observations.length, 12);
    assert(
      setup.job.report?.observations.every((observation) => observation.passed),
    );
    assert.equal(setup.activation, undefined);

    const after = await h.inspect();
    const process = after.processes.find(
      (item) => item.id === setup.artifact.processId,
    );
    assert(process);
    assert.equal(process.activeVersion, null);
    assert.equal(after.serviceDispatches.length, 0);
    const designRequests = after.requests.filter((request) =>
      request.path.includes("process-design"),
    );
    for (const action of ["start", "turns", "acknowledge", "accept"])
      assert(
        designRequests.some(
          (request) =>
            request.method === "POST" &&
            request.path.startsWith(
              `/v1/${setup.target.workspaceId}/process-design/${action}`,
            ) &&
            request.path.includes("profile=agent-process-design%2F1"),
        ),
        `service-owned mobile designer must POST ${action} through its native profile`,
      );
    assert(
      after.requests.every(
        (request) =>
          !request.path.startsWith(
            "/admin/api/identity/catalog/processes/design",
          ),
      ),
      "service-owned mobile acceptance must use the bearer-session route",
    );

    session = new ClientSession(
      setup.endpoint,
      storage(),
      setup.credential,
      fetch,
      undefined,
      undefined,
      false,
      { processOutputs: true },
    );
    await session.start(false);
    await settle(session);
    const inventory = await session.loadProcessInventory();
    assert(
      !inventory.processes.some(
        (item) => item.processId === setup.artifact.processId,
      ),
      "qualification must not put the service draft in executable inventory before activation",
    );
    assert.equal((await h.inspect()).serviceDispatches.length, 0);
  } finally {
    if (session) session.stop();
    await h.close();
  }
});
