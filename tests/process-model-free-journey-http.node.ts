import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  designHttpFixture,
  designHttpPath,
} from "./helpers/process-design-http";
import { createWorkflow } from "../apps/server-admin/web/lib/process-editor";
import {
  literalWorkflowStarterSuite,
  parseSuiteDraft,
} from "../apps/server-admin/web/lib/process-test-suite";
import {
  DesignCapabilitiesSchema,
  OwnedDesignReviewSchema,
  WORKSPACE_DESIGN_PROFILE,
  emptyDesignBrief,
} from "../packages/protocol/process-design";
import {
  WORKSPACE_PROCESS_PROFILE,
  WorkspaceProcessListSchema,
  ProcessVersionSchema,
  OwnedProcessRecordSchema,
} from "../packages/protocol/service-processes";
import { PROCESS_VERSION_PROFILE } from "../packages/protocol/process-versions";
import {
  NativeTestJobSchema,
  PROCESS_NATIVE_TEST_PROFILE,
} from "../packages/protocol/process-native-testing";
import {
  ProcessActivationReviewSchema,
  PROCESS_ACTIVATION_PROFILE,
} from "../packages/protocol/process-activation";
import { CredentialSchema } from "../packages/protocol";
import { authRequest } from "../packages/client-core/auth";
import { ClientSession } from "../packages/client-core/session";
import { processStartCommand } from "../packages/client-core/process-commands";

test("a novice creates, qualifies, activates and executes a literal workflow with no AI configuration", async () => {
  const h = await designHttpFixture();
  let session: ClientSession | undefined;
  const base = "api/identity/catalog/processes";
  const post = async (path: string, body: object) => {
    const response = await h.request(
      "owner",
      path,
      { ...h.target, ...body },
      { signal: AbortSignal.timeout(125000) },
    );
    assert.equal(
      response.status,
      200,
      path + ": " + JSON.stringify(response.data),
    );
    return h.record(response.data);
  };
  try {
    await post("api/identity/catalog/command", {
      type: "removeModel",
      id: h.modelId,
      revision: 1,
    });
    await post("api/identity/catalog/command", {
      type: "removeProvider",
      id: h.providerId,
      revision: 1,
    });
    const profile = "?profile=" + encodeURIComponent(WORKSPACE_DESIGN_PROFILE);
    const capabilitiesResponse = await h.request(
      "owner",
      designHttpPath + "/capabilities" + profile + "&" + h.query,
    );
    const capabilities = DesignCapabilitiesSchema.parse(
      h.record(capabilitiesResponse.data).capabilities,
    );
    assert.deepEqual(capabilities.models, []);
    const candidate = createWorkflow(capabilities);
    candidate.name = "TEST no-model return";
    candidate.limits.maxModelCalls = 0;
    candidate.steps[0] = {
      id: "finish",
      type: "return",
      output: { result: { source: "literal", value: "TEST ready" } },
    };
    const started = OwnedDesignReviewSchema.parse(
      (
        await post(designHttpPath + "/start" + profile, {
          profile: WORKSPACE_DESIGN_PROFILE,
          owner: { type: "workspace" },
          requestId: randomUUID(),
        })
      ).review,
    );
    const updated = OwnedDesignReviewSchema.parse(
      (
        await post(designHttpPath + "/update" + profile, {
          sessionId: started.id,
          revision: started.revision,
          requestId: randomUUID(),
          candidate,
          brief: {
            ...emptyDesignBrief(),
            purpose: "TEST return a known value without a provider or service",
          },
        })
      ).review,
    );
    assert.deepEqual(updated.blockers, []);
    const accepted = await post(designHttpPath + "/accept" + profile, {
      sessionId: updated.id,
      revision: updated.revision,
      reviewDigest: updated.reviewDigest,
      requestId: randomUUID(),
    });
    const processId = String(h.record(accepted.receipt).processId);
    const query = new URLSearchParams({
      ...h.target,
      profile: WORKSPACE_PROCESS_PROFILE,
    });
    const listResponse = await h.request("owner", base + "?" + query);
    const draft = WorkspaceProcessListSchema.parse(
      listResponse.data,
    ).processes.find((p) => p.id === processId)!;
    assert(draft);
    assert.equal(draft.activeVersion, null);
    const frozen = await post(base + "/versions/freeze", {
      profile: PROCESS_VERSION_PROFILE,
      processId,
      revision: draft.revision,
      requestId: randomUUID(),
    });
    const version = h.record(frozen.receipt).version;
    const versionResponse = await h.request(
      "owner",
      base + "?" + query + "&id=" + processId + "&version=" + version,
    );
    const artifact = ProcessVersionSchema.parse(
      h.record(versionResponse.data).version,
    );
    assert.deepEqual(artifact.sources.resources, []);
    const processResponse = await h.request(
      "owner",
      base + "?" + query + "&id=" + processId,
    );
    const process = OwnedProcessRecordSchema.parse(
      h.record(processResponse.data).process,
    );
    const suiteDraft = literalWorkflowStarterSuite(artifact);
    assert(suiteDraft);
    const suite = parseSuiteDraft(suiteDraft);
    const run = {
      profile: PROCESS_NATIVE_TEST_PROFILE,
      processId,
      revision: process.revision,
      version: artifact.version,
      artifactDigest: artifact.digest,
      suite,
    };
    const nativeRequest = { ...run, requestId: randomUUID() };
    const job = NativeTestJobSchema.parse(
      (await post(base + "/tests/native", nativeRequest)).job,
    );
    assert(job.qualification);
    assert(job.report);
    assert.equal(job.qualification.status, "qualified", JSON.stringify(job));
    assert.equal(job.qualification.policy, "native-scripted-runtime/2");
    assert.equal(job.report?.comparison.mode, "configured_only");
    assert.equal(job.report.experiments.generic, undefined);
    assert.equal(job.report.observations.length, 2);
    assert(
      job.report.observations.every(
        (o) =>
          o.strategy === "configured" &&
          o.modelCalls === 0 &&
          o.businessDispatches === 0,
      ),
    );
    assert.deepEqual(
      job.qualification.coverage
        .filter((c) => c.applicable)
        .map((c) => c.scenario),
      ["success", "restart"],
    );
    const activationQuery = new URLSearchParams({
      ...h.target,
      profile: PROCESS_ACTIVATION_PROFILE,
      processId,
      version: String(artifact.version),
      testId: job.testId,
    });
    const activationResponse = await h.request(
      "owner",
      base + "/activation/review?" + activationQuery,
    );
    const activation = ProcessActivationReviewSchema.parse(
      h.record(activationResponse.data).review,
    );
    assert.equal(activation.canActivate, true);
    await post(base + "/activation", {
      profile: PROCESS_ACTIVATION_PROFILE,
      requestId: randomUUID(),
      type: "activate",
      processId,
      revision: activation.revision,
      expectedActiveVersion: null,
      version: artifact.version,
      artifactDigest: artifact.digest,
      testId: job.testId,
      qualificationDigest: job.qualification.qualificationDigest,
      acknowledgement: "controlled_native_test_only",
    });
    await h.restart();
    const replay = NativeTestJobSchema.parse(
      (await post(base + "/tests/native", nativeRequest)).job,
    );
    assert.deepEqual(replay, job);
    const pairing = await post("api/identity/mobile/pairing", {});
    const credential = CredentialSchema.parse(
      await authRequest(
        String(pairing.address),
        "pair",
        fetch,
        undefined,
        String(pairing.code),
        false,
        true,
      ),
    );
    const storage = new Map<string, string>();
    session = new ClientSession(
      String(pairing.address),
      {
        getItem: async (key) => storage.get(key) ?? null,
        setItem: async (key, value) => {
          storage.set(key, value);
        },
      },
      credential,
      fetch,
      undefined,
      undefined,
      false,
      { processOutputs: true },
    );
    await session.start(false);
    const inventory = await session.loadProcessInventory();
    const entry = inventory.processes.find((p) => p.processId === processId)!;
    assert.equal(entry.availability, "ready");
    const target = await session.prepareProcessInput(
      {
        processId,
        version: artifact.version,
        artifactDigest: artifact.digest,
        language: "en",
        origin: {
          type: "command",
          conversationId: "conversation-1",
          requestId: randomUUID(),
        },
      },
      entry,
    );
    const commandId = randomUUID();
    await session.send(
      processStartCommand(target, {
        commandId,
        idempotencyKey: randomUUID(),
        language: "en",
        input: {},
      }),
      false,
      target,
    );
    const until = Date.now() + 10000;
    while (!session.getSnapshot().store || session.getSnapshot().store!.stale) {
      assert(Date.now() < until, "TEST Session did not settle");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const work = Object.values(session.getSnapshot().store!.workItems).find(
      (w) => w.native?.process?.provenance.commandId === commandId,
    )!;
    assert(work, "TEST execution should appear in paired Work");
    assert.equal(work.status, "succeeded");
    assert.equal(work.native!.process!.outputSummary?.fieldCount, 1);
    const reference = work.native!.process!.output;
    assert(reference);
    const output = await session.loadProcessOutputPage({
      reference,
      path: [],
      cursor: null,
    });
    assert.deepEqual(
      output.children.map((child) => ({
        label: child.label,
        node: child.node,
      })),
      [{ label: "result", node: { kind: "string", value: "TEST ready" } }],
    );
    assert.equal(h.modelCount(), 0);
    assert.equal(h.businessCount(), 0);
  } finally {
    session?.stop();
    await h.close();
  }
});
