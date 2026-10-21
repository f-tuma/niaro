import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROCESS_VERSION_PROFILE,
  ProcessFreezeCommandSchema,
  ProcessFreezeReceiptSchema,
  ProcessVersionListSchema,
  type ProcessFreezeReceipt,
} from "../packages/protocol/process-versions";
import {
  NativeTestDetailSchema,
  NativeTestRequestSchema,
  type NativeTestJob,
  type NativeTestRequest,
} from "../packages/protocol/process-native-testing";
import {
  ProcessDefinitionSchema,
  ProcessRecordSchema,
  type ProcessVersion,
} from "../packages/protocol/service-processes";
import {
  ProcessActivationCommandSchema,
  type ProcessActivationCommand,
  type ProcessActivationReceipt,
} from "../packages/protocol/process-activation";
import { PROCESS_TEST_SCENARIOS } from "../apps/server-identity/service-processes";
import { DEFAULT_PROCESS_LIMITS } from "../apps/server-identity/process-validation";
import { processObject } from "./helpers/service-process";
import { nativeHttpPath } from "./helpers/process-native-http";
import {
  activationHttpFixture,
  activationHttpPath,
} from "./helpers/process-activation-http";

const processPath = "api/identity/catalog/processes";
const versionsPath = processPath + "/versions";
const freezePath = versionsPath + "/freeze";

test("console HTTP freezes, qualifies, activates v1 and v2, and rolls back qualified v1 with durable private recovery", async () => {
  const h = await activationHttpFixture();
  try {
    const before = h.production();
    const versionQuery = (input: Record<string, string | number>) =>
      new URLSearchParams({
        ...h.target,
        profile: PROCESS_VERSION_PROFILE,
        ...Object.fromEntries(
          Object.entries(input).map(([key, value]) => [key, String(value)]),
        ),
      }).toString();
    const model = h.identity["catalog"].store.processModelMetadata(
      h.target.organizationId,
      h.modelId,
    );
    const budget = await h.request("owner", "api/identity/catalog/budget", {
      ...h.target,
      revision: h.identity["catalog"].store.inferenceBudget.policy(
        h.target.organizationId,
        h.target.workspaceId,
      ).revision,
      settings: {
        ...h.budgetSettings,
        prices: [
          {
            ...h.budgetSettings.prices[0]!,
            modelRevision: model.model.revision,
            providerRevision: model.provider.revision,
            maxInputTokens: 50000,
            maxOutputTokens: 1000,
          },
        ],
      },
    });
    assert.equal(budget.status, 200, JSON.stringify(budget.data));
    const definition = ProcessDefinitionSchema.parse({
      schemaVersion: 1,
      kind: "agent",
      name: "TEST console lifecycle v1",
      description: "TEST isolated scripts only",
      trigger: "manual",
      inputSchema: processObject({ name: { type: "string" } }),
      outputSchema: processObject({ result: { type: "string" } }),
      limits: DEFAULT_PROCESS_LIMITS,
      modelId: h.modelId,
      instructions: "TEST return JSON using the assigned lookup.",
      memory: "none",
      capabilities: [
        { serviceId: h.serviceId, actionId: h.writeId },
        { serviceId: h.serviceId, actionId: h.actionId },
      ],
    });
    const saved = await h.request("owner", processPath + "/command", {
      ...h.target,
      type: "saveDraft",
      serviceId: h.serviceId,
      revision: 0,
      definition,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    const draft = ProcessRecordSchema.parse(h.record(saved.data).process);
    const freezes: {
      command: ReturnType<typeof ProcessFreezeCommandSchema.parse>;
      receipt: ProcessFreezeReceipt;
    }[] = [];
    const decisions: {
      command: ProcessActivationCommand;
      receipt: ProcessActivationReceipt;
    }[] = [];
    const originals: { request: NativeTestRequest; job: NativeTestJob }[] = [];
    const freeze = async (revision: number, version: number) => {
      const command = ProcessFreezeCommandSchema.parse({
        ...h.target,
        profile: PROCESS_VERSION_PROFILE,
        processId: draft.id,
        revision,
        requestId: "TEST-console-freeze-v" + version,
      });
      const response = await h.request("owner", freezePath, command);
      assert.equal(response.status, 200, JSON.stringify(response.data));
      const receipt = ProcessFreezeReceiptSchema.parse(
        h.record(response.data).receipt,
      );
      assert.equal(receipt.version, version);
      assert.equal(receipt.resultingRevision, revision + 1);
      const historyResponse = await h.request(
        "owner",
        versionsPath + "?" + versionQuery({ processId: draft.id }),
      );
      assert.equal(
        historyResponse.status,
        200,
        JSON.stringify(historyResponse.data),
      );
      const artifact = ProcessVersionListSchema.parse(
        historyResponse.data,
      ).versions.find((item) => item.version === version)!;
      assert.equal(artifact.digest, receipt.artifactDigest);
      assert.equal(artifact.testStatus, "untested");
      freezes.push({ command, receipt });
      return { receipt, artifact };
    };
    const detail = async (request: NativeTestRequest, job: NativeTestJob) => {
      for (const identifier of [
        { requestId: request.requestId },
        { testId: job.testId },
      ] as Record<string, string>[]) {
        const path = nativeHttpPath + "/detail?" + h.nativeQuery(identifier);
        const response = await h.request("owner", path);
        assert.equal(response.status, 200, JSON.stringify(response.data));
        assert.deepEqual(NativeTestDetailSchema.parse(response.data), {
          request,
          job,
        });
        assert.deepEqual(Object.keys(h.record(response.data)).sort(), [
          "job",
          "request",
        ]);
        assert.equal((await h.request("admin", path)).status, 404);
      }
    };
    const qualify = async (request: NativeTestRequest) => {
      const job = await h.runNative(request);
      assert.equal(
        job.qualification?.status,
        "qualified",
        JSON.stringify(job.qualification),
      );
      assert.equal(job.qualification.liveAcceptance, false);
      assert.equal(job.report!.comparison.configuredPassed, 6);
      assert.equal(job.report!.comparison.genericPassed, 6);
      assert.equal(job.report!.observations.length, 12);
      for (const strategy of ["configured", "generic"] as const) {
        const observed = job.report!.observations.filter(
          (item) => item.strategy === strategy,
        );
        assert.deepEqual(
          new Set(observed.map((item) => item.scenario)),
          new Set(PROCESS_TEST_SCENARIOS),
        );
        assert(observed.every((item) => item.passed));
        assert(observed.find((item) => item.scenario === "restart")!.reopened);
      }
      await detail(request, job);
      originals.push({ request, job });
      return job;
    };
    const review = async (artifact: ProcessVersion, job: NativeTestJob) => {
      const path =
        activationHttpPath +
        "/review?" +
        h.query({
          processId: draft.id,
          version: artifact.version,
          testId: job.testId,
        });
      const response = await h.request("owner", path);
      assert.equal(response.status, 200, JSON.stringify(response.data));
      const current = h.review(response.data);
      assert.equal(current.artifactDigest, artifact.digest);
      assert.equal(current.testId, job.testId);
      assert.equal(
        current.qualification.qualificationDigest,
        job.qualification!.qualificationDigest,
      );
      assert.equal((await h.request("admin", path)).status, 404);
      return current;
    };
    const decide = async (
      request: NativeTestRequest,
      job: NativeTestJob,
      type: "activate" | "rollback",
      expectedActiveVersion: number | null,
      requestId: string,
    ) => {
      const current = await h.process(draft.id);
      const command = ProcessActivationCommandSchema.parse({
        ...h.command(request, job, requestId),
        type,
        revision: current.revision,
        expectedActiveVersion,
      });
      assert.equal(
        (await h.request("member", activationHttpPath, command)).status,
        403,
      );
      const response = await h.request("owner", activationHttpPath, command);
      assert.equal(response.status, 200, JSON.stringify(response.data));
      const receipt = h.receipt(response.data);
      const active = await h.process(draft.id);
      assert.equal(active.activeVersion, request.version);
      assert.equal(active.revision, receipt.resultingRevision);
      assert.equal(receipt.qualification.liveAcceptance, false);
      decisions.push({ command, receipt });
      return active;
    };

    const first = await freeze(draft.revision, 1);
    const firstRequest = h.nativeRequest(
      first.artifact,
      first.receipt.resultingRevision,
    );
    const firstJob = await qualify(firstRequest);
    const firstReview = await review(first.artifact, firstJob);
    assert.equal(firstReview.activeVersion, null);
    assert.equal(firstReview.canActivate, true);
    assert.equal(firstReview.canRollback, false);
    const firstActive = await decide(
      firstRequest,
      firstJob,
      "activate",
      null,
      "TEST-console-activate-v1",
    );

    // A new test of the active version requires its own explicit human command.
    const activeRetest = NativeTestRequestSchema.parse({
      ...firstRequest,
      requestId: "TEST-console-active-v1-retest",
      revision: firstActive.revision,
    });
    const jobsBeforeRetest = h.identity["db"]
      .prepare("SELECT COUNT(*) AS n FROM agent_process_contract_test")
      .get()!.n;
    const refused = await h.request("owner", nativeHttpPath, activeRetest);
    assert.equal(refused.status, 409, JSON.stringify(refused.data));
    assert.equal(h.record(refused.data).error, "process_test_active_version");
    assert.equal(
      h.identity["db"]
        .prepare("SELECT COUNT(*) AS n FROM agent_process_contract_test")
        .get()!.n,
      jobsBeforeRetest,
    );
    const retestRequest = NativeTestRequestSchema.parse({
      ...activeRetest,
      retestActive: true,
    });
    const retestJob = await qualify(retestRequest);
    assert.deepEqual(await h.process(draft.id), firstActive);

    const secondSaved = await h.request("owner", processPath + "/command", {
      ...h.target,
      type: "saveDraft",
      id: draft.id,
      serviceId: h.serviceId,
      revision: firstActive.revision,
      definition: {
        ...definition,
        name: "TEST console lifecycle v2",
        description: "TEST second immutable definition",
      },
    });
    assert.equal(secondSaved.status, 200, JSON.stringify(secondSaved.data));
    const secondDraft = ProcessRecordSchema.parse(
      h.record(secondSaved.data).process,
    );
    assert.equal(secondDraft.activeVersion, 1);
    const second = await freeze(secondDraft.revision, 2);
    const secondRequest = h.nativeRequest(
      second.artifact,
      second.receipt.resultingRevision,
    );
    const secondJob = await qualify(secondRequest);
    const secondReview = await review(second.artifact, secondJob);
    assert.equal(secondReview.activeVersion, 1);
    assert.equal(secondReview.canActivate, true);
    assert.equal(secondReview.canRollback, false);
    await decide(
      secondRequest,
      secondJob,
      "activate",
      1,
      "TEST-console-activate-v2",
    );

    const rollbackReview = await review(first.artifact, retestJob);
    assert.equal(rollbackReview.activeVersion, 2);
    assert.equal(rollbackReview.canActivate, false);
    assert.equal(rollbackReview.canRollback, true);
    const rolledBack = await decide(
      retestRequest,
      retestJob,
      "rollback",
      2,
      "TEST-console-rollback-v1",
    );
    assert.equal(rolledBack.latestVersion, 2);
    assert.deepEqual(rolledBack.draft, secondDraft.draft);
    const expectedProduction = {
      ...before,
      agent_service_process_test: Number(before.agent_service_process_test) + 3,
    };
    assert.deepEqual(h.production(), expectedProduction);
    assert.equal(h.modelCount(), 0);
    assert.equal(h.businessCount(), 0);

    for (let reopen = 0; reopen < 3; reopen++) {
      assert.deepEqual(await h.process(draft.id), rolledBack);
      for (const { command, receipt } of freezes) {
        const stored = await h.request(
          "owner",
          freezePath + "?" + versionQuery({ requestId: command.requestId }),
        );
        assert.equal(stored.status, 200, JSON.stringify(stored.data));
        assert.deepEqual(
          ProcessFreezeReceiptSchema.parse(h.record(stored.data).receipt),
          receipt,
        );
        assert.equal(
          (
            await h.request(
              "admin",
              freezePath + "?" + versionQuery({ requestId: command.requestId }),
            )
          ).status,
          404,
        );
        const replay = await h.request("owner", freezePath, command);
        assert.equal(replay.status, 200, JSON.stringify(replay.data));
        assert.deepEqual(
          ProcessFreezeReceiptSchema.parse(h.record(replay.data).receipt),
          receipt,
        );
      }
      for (const { command, receipt } of decisions) {
        const stored = await h.request(
          "owner",
          activationHttpPath + "?" + h.query({ requestId: command.requestId }),
        );
        assert.equal(stored.status, 200, JSON.stringify(stored.data));
        assert.deepEqual(h.receipt(stored.data), receipt);
        const replay = await h.request("owner", activationHttpPath, command);
        assert.equal(replay.status, 200, JSON.stringify(replay.data));
        assert.deepEqual(h.receipt(replay.data), receipt);
        assert.deepEqual(await h.process(draft.id), rolledBack);
      }
      for (const original of originals)
        await detail(original.request, original.job);
      const history = await h.request(
        "owner",
        versionsPath + "?" + versionQuery({ processId: draft.id }),
      );
      assert.equal(history.status, 200, JSON.stringify(history.data));
      const versions = ProcessVersionListSchema.parse(history.data);
      assert.deepEqual(
        versions.versions.map((artifact) => [
          artifact.version,
          artifact.digest,
          artifact.testStatus,
        ]),
        [
          [2, second.artifact.digest, "passed"],
          [1, first.artifact.digest, "passed"],
        ],
      );
      assert.equal(versions.nextBefore, null);
      assert.equal(
        h.identity["db"]
          .prepare(
            "SELECT COUNT(*) AS n FROM agent_process_freeze_command WHERE process_id=?",
          )
          .get(draft.id)!.n,
        2,
      );
      assert.equal(
        h.identity["db"]
          .prepare(
            "SELECT COUNT(*) AS n FROM agent_process_activation_command WHERE process_id=?",
          )
          .get(draft.id)!.n,
        3,
      );
      assert.equal(
        h.identity["db"]
          .prepare(
            "SELECT COUNT(*) AS n FROM agent_process_contract_test WHERE process_id=?",
          )
          .get(draft.id)!.n,
        3,
      );
      assert.deepEqual(h.production(), expectedProduction);
      assert.equal(h.modelCount(), 0);
      assert.equal(h.businessCount(), 0);
      if (reopen < 2) await h.restart();
    }
  } finally {
    await h.close();
  }
});
