import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { ClientSession } from "../packages/client-core/session";
import { authRequest } from "../packages/client-core/auth";
import {
  captureProcessResolveTarget,
  processResolveCommand,
  processStartCommand,
} from "../packages/client-core/process-commands";
import { CredentialSchema, type WorkItem } from "../packages/protocol";
import { ProcessRuntimeResponseSchema } from "../packages/protocol/process-coordinator";
import { PROCESS_EXECUTION_PROFILE } from "../packages/protocol/process-execution";
import {
  NativeTestToolsSchema,
  PROCESS_NATIVE_TEST_PROFILE,
} from "../packages/protocol/process-native-testing";
import { PROCESS_QUESTION_EXECUTION_PROFILE } from "../packages/protocol/process-questions";
import {
  activationHttpFixture,
  activationHttpPath,
} from "./helpers/process-activation-http";
import { nativeHttpPath } from "./helpers/process-native-http";
import { code } from "./helpers/service-process-runtime";

function fingerprints(root: string) {
  const hashes: Record<string, string> = {};
  const walk = (relative = "") => {
    for (const item of readdirSync(join(root, relative), {
      withFileTypes: true,
    })) {
      const path = join(relative, item.name);
      if (item.isDirectory()) walk(path);
      else {
        assert(item.isFile());
        hashes[path] = createHash("sha256")
          .update(readFileSync(join(root, path)))
          .digest("hex");
      }
    }
  };
  walk();
  return hashes;
}

// The native six-scenario comparison, human HTTP activation, paired Session,
// Mastra checkpoints and copied SQLite tuple are real. All business/model
// transports are synthetic and dispatch only to the counters below.
for (const fault of ["qualification reference", "admission ordinal"] as const) {
  test(`loss of only the copied native ${fault} blocks fresh execution while passive provenance survives and restoring the exact proof resumes the original pin`, async () => {
    const failureCode =
      fault === "qualification reference"
        ? "process_qualification_unavailable"
        : "process_test_superseded";
    const h = await activationHttpFixture();
    const dispatches: string[] = [];
    const install = () =>
      Object.defineProperty(h.identity["catalog"], "transport", {
        configurable: true,
        value: async (
          request: Parameters<typeof h.scriptedModelTransport>[0],
        ) => {
          if (new URL(request.url).origin === "https://models.example.test")
            return h.scriptedModelTransport(request);
          assert.equal(
            new URL(request.url).origin,
            "https://services.example.test",
          );
          assert(request.beforeDispatch);
          await request.beforeDispatch(() =>
            dispatches.push(request.method ?? "GET"),
          );
          return { status: 200, headers: {}, text: '{"value":"TEST-result"}' };
        },
      });
    let session: ClientSession | undefined;
    try {
      const input = await h.fresh();
      const job = await h.runNative(input);
      assert.equal(job.qualification?.status, "qualified");
      assert.equal(job.report?.observations.length, 12);
      const activationCommand = h.command(input, job, randomUUID());
      const activated = await h.request(
        "owner",
        activationHttpPath,
        activationCommand,
      );
      assert.equal(activated.status, 200, JSON.stringify(activated.data));
      const activationReceipt = h.receipt(activated.data);
      const toolsResponse = await h.request(
        "owner",
        "api/identity/catalog/processes/tests/native/tools?" +
          new URLSearchParams({
            ...h.target,
            profile: PROCESS_NATIVE_TEST_PROFILE,
            processId: input.processId,
            version: String(input.version),
            genericModelId: h.modelId,
          }),
      );
      assert.equal(toolsResponse.status, 200);
      const tool = NativeTestToolsSchema.parse(toolsResponse.data)
        .configured.flatMap((node) => node.tools)
        .find((item) => "actionId" in item && item.actionId === h.writeId);
      assert(tool);
      const pairingResponse = await h.request(
        "owner",
        "api/identity/mobile/pairing",
        h.target,
      );
      assert.equal(pairingResponse.status, 200);
      const pairing = h.record(pairingResponse.data);
      const endpoint = String(pairing.address);
      const credential = CredentialSchema.parse(
        await authRequest(
          endpoint,
          "pair",
          fetch,
          undefined,
          String(pairing.code),
          false,
          true,
        ),
      );
      const actor = {
        ...h.target,
        userId: credential.scope.userId,
        role: "owner" as const,
      };
      const saved = new Map<string, string>();
      const storage = {
        getItem: async (key: string) => saved.get(key) ?? null,
        setItem: async (key: string, value: string) => {
          saved.set(key, value);
        },
      };
      const makeSession = () =>
        new ClientSession(
          endpoint,
          storage,
          credential,
          fetch,
          undefined,
          undefined,
          false,
          { processQuestions: true, processApprovals: true },
        );
      const settle = async () => {
        const end = Date.now() + 15000;
        while (
          !session!.getSnapshot().store ||
          session!.getSnapshot().store!.stale
        ) {
          assert(
            Date.now() < end,
            "TEST paired qualification-loss Session did not settle",
          );
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };
      const mobile = async (
        path: string,
        body: unknown,
        profile: string = PROCESS_QUESTION_EXECUTION_PROFILE,
      ) => {
        const response = await fetch(
          endpoint +
            "/processes/" +
            path +
            "?profile=" +
            encodeURIComponent(profile),
          {
            method: "POST",
            headers: {
              Authorization: "Bearer " + credential.accessToken,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(15000),
          },
        );
        return {
          status: response.status,
          data: (await response.json()) as unknown,
        };
      };
      const prepare = async () => {
        const inventory = await session!.loadProcessInventory();
        const entry = inventory.processes.find(
          (item) => item.processId === input.processId,
        )!;
        assert.equal(entry.availability, "ready");
        return session!.prepareProcessInput(
          {
            processId: input.processId,
            version: input.version,
            artifactDigest: input.artifactDigest,
            language: "en",
            origin: {
              type: "command",
              conversationId: "conversation-1",
              requestId: randomUUID(),
            },
          },
          entry,
        );
      };
      const work = (commandId: string): WorkItem => {
        const item = Object.values(
          session!.getSnapshot().store!.workItems,
        ).find(
          (row) => row.native?.process?.provenance.commandId === commandId,
        );
        assert(item);
        return item;
      };
      const start = async () => {
        const card = await prepare();
        const command = processStartCommand(card, {
          commandId: randomUUID(),
          idempotencyKey: randomUUID(),
          language: "en",
          input: { name: "TEST-input" },
        });
        // Exercise the actual authenticated POST, never merely the admission store.
        const response = await mobile("commands", command);
        assert.equal(response.status, 202, JSON.stringify(response.data));
        const result = ProcessRuntimeResponseSchema.parse(response.data);
        assert.equal(result.admission?.status, "admitted");
        assert.equal(result.process?.status, "waiting");
        await session!.refresh();
        await settle();
        return { card, command, result };
      };
      const decision = (commandId: string, approved: boolean) => {
        const item = work(commandId);
        const target = captureProcessResolveTarget(
          session!.getSnapshot().store!,
          item.id,
          undefined,
          "conversation-1",
          item,
        );
        return processResolveCommand(session!.getSnapshot().store!, target, {
          commandId: randomUUID(),
          idempotencyKey: randomUUID(),
          language: "en",
          approved,
        });
      };
      const counts = () =>
        Object.fromEntries(
          [
            "agent_service_process_run",
            "agent_service_turn",
            "agent_service_invocation",
            "agent_inference_run",
            "agent_inference_attempt",
            "agent_process_resolve_command",
            "agent_process_start_intent",
            "agent_process_contract_test",
            "agent_process_native_test_admission",
            "agent_service_process_test",
          ].map((table) => [
            table,
            Number(
              h.identity["db"]
                .prepare(`SELECT count(*) AS n FROM ${table}`)
                .get()!.n,
            ),
          ]),
        );
      session = makeSession();
      await session.start(false);
      install();
      h.onModel((request) =>
        (request.messages ?? []).some((message) => message.role === "tool")
          ? { content: '{"result":"TEST-result"}' }
          : {
              tool_calls: [
                {
                  id: randomUUID(),
                  type: "function",
                  function: {
                    name: tool.name,
                    arguments: '{"name":"TEST-input"}',
                  },
                },
              ],
            },
      );
      const a = await start();
      const c = await start();
      const denialC = decision(c.command.commandId, false);
      const deniedC = await mobile("commands", denialC);
      assert.equal(deniedC.status, 202, JSON.stringify(deniedC.data));
      assert.equal(
        ProcessRuntimeResponseSchema.parse(deniedC.data).process?.status,
        "cancelled",
      );
      await session.refresh();
      await settle();
      const cardB = await prepare();
      const commandB = processStartCommand(cardB, {
        commandId: randomUUID(),
        idempotencyKey: randomUUID(),
        language: "en",
        input: { name: "TEST-input" },
      });
      const parentA = work(a.command.commandId).id;
      const pinA = structuredClone(
        work(a.command.commandId).native!.process!.provenance,
      );
      const approvalA = structuredClone(
        work(a.command.commandId).native!.process!.approval,
      );
      const reference = h.identity["db"]
        .prepare(
          "SELECT reference FROM agent_service_process_qualification WHERE process_id=? AND version=?",
        )
        .get(input.processId, input.version)!;
      assert(reference);
      const ordinal = h.identity["db"]
        .prepare(
          "SELECT * FROM agent_process_native_test_admission WHERE test_id=?",
        )
        .get(job.testId)!;
      assert(ordinal);
      const qualifiedJob = h.identity["db"]
        .prepare("SELECT * FROM agent_process_contract_test WHERE test_id=?")
        .get(job.testId)!;
      assert(qualifiedJob);
      const historicalTest = h.identity["db"]
        .prepare(
          "SELECT * FROM agent_service_process_test WHERE process_id=? AND version=?",
        )
        .get(input.processId, input.version)!;
      assert(historicalTest);
      const canonicalA = () =>
        h.identity["db"]
          .prepare("SELECT * FROM agent_service_invocation WHERE id=?")
          .get(approvalA!.result.operationId);
      const receiptA = canonicalA();
      assert(receiptA);
      assert.equal(
        JSON.parse(String(receiptA.data)).status,
        "awaiting_approval",
      );
      const commandCount = () =>
        h.identity["db"]
          .prepare("SELECT count(*) AS n FROM agent_process_start_command")
          .get()!.n;
      const baseline = {
        models: h.modelCount(),
        dispatches: [...dispatches],
        counts: counts(),
        commands: Number(commandCount()),
      };
      assert.deepEqual(dispatches, []);
      session.stop();
      const copied = await h.restoreCopy();
      assert.deepEqual(copied.copyHashes, copied.sourceHashes);
      if (fault === "qualification reference") {
        assert.equal(
          h.identity["db"]
            .prepare(
              "DELETE FROM agent_service_process_qualification WHERE process_id=? AND version=?",
            )
            .run(input.processId, input.version).changes,
          1,
        );
      } else {
        assert.equal(
          h.identity["db"]
            .prepare(
              "DELETE FROM agent_process_native_test_admission WHERE test_id=?",
            )
            .run(job.testId).changes,
          1,
        );
      }
      await h.restart();
      install();
      session = makeSession();
      await session.start(false);
      await settle();
      const assertPassive = () => {
        assert.equal(h.modelCount(), baseline.models);
        assert.deepEqual(dispatches, baseline.dispatches);
        assert.deepEqual(
          counts(),
          fault === "qualification reference"
            ? baseline.counts
            : {
                ...baseline.counts,
                agent_process_native_test_admission:
                  baseline.counts.agent_process_native_test_admission! - 1,
              },
        );
        assert.deepEqual(canonicalA(), receiptA);
        assert.equal(
          commandCount(),
          baseline.commands + (fault === "qualification reference" ? 1 : 0),
        );
        assert.equal(work(a.command.commandId).status, "waiting_approval");
        assert.deepEqual(
          work(a.command.commandId).native!.process!.provenance,
          pinA,
        );
        assert.deepEqual(
          work(a.command.commandId).native!.process!.approval,
          approvalA,
        );
        assert.equal(
          h.identity["db"]
            .prepare(
              "SELECT count(*) AS n FROM agent_service_process_qualification WHERE process_id=? AND version=?",
            )
            .get(input.processId, input.version)!.n,
          fault === "qualification reference" ? 0 : 1,
        );
        assert.deepEqual(
          h.identity["db"]
            .prepare(
              "SELECT * FROM agent_process_native_test_admission WHERE test_id=?",
            )
            .get(job.testId),
          fault === "qualification reference" ? ordinal : undefined,
        );
        assert.deepEqual(
          h.identity["db"]
            .prepare(
              "SELECT * FROM agent_process_contract_test WHERE test_id=?",
            )
            .get(job.testId),
          qualifiedJob,
        );
        assert.deepEqual(
          h.identity["db"]
            .prepare(
              "SELECT * FROM agent_service_process_test WHERE process_id=? AND version=?",
            )
            .get(input.processId, input.version),
          historicalTest,
        );
        if (fault === "admission ordinal")
          assert.deepEqual(
            h.identity["db"]
              .prepare(
                "SELECT reference FROM agent_service_process_qualification WHERE process_id=? AND version=?",
              )
              .get(input.processId, input.version),
            reference,
          );
      };
      const inventory = await session.loadProcessInventory();
      const blocked = inventory.processes.find(
        (item) => item.processId === input.processId,
      )!;
      assert.equal(blocked.availability, "blocked");
      if (blocked.availability === "blocked")
        assert.equal(blocked.reason, "qualification_required");
      const newForm = await mobile(
        "input",
        {
          processId: input.processId,
          version: input.version,
          artifactDigest: input.artifactDigest,
          language: "en",
          origin: {
            type: "command",
            conversationId: "conversation-1",
            requestId: randomUUID(),
          },
        },
        PROCESS_EXECUTION_PROFILE,
      );
      assert.equal(newForm.status, 409, JSON.stringify(newForm.data));
      assert.equal(
        h.record(newForm.data).error,
        "process_execution_unavailable",
      );
      const rejectedB = await mobile("commands", commandB);
      if (fault === "qualification reference") {
        assert.equal(rejectedB.status, 422, JSON.stringify(rejectedB.data));
        const rejection = ProcessRuntimeResponseSchema.parse(
          rejectedB.data,
        ).admission;
        assert.equal(rejection?.status, "rejected");
        if (rejection?.status === "rejected")
          assert.equal(rejection.reason, failureCode);
        assert.equal(
          ProcessRuntimeResponseSchema.parse(rejectedB.data).process,
          undefined,
        );
      } else {
        assert.equal(rejectedB.status, 409, JSON.stringify(rejectedB.data));
        assert.equal(h.record(rejectedB.data).error, failureCode);
      }
      assert.deepEqual(
        (await mobile("commands", commandB)).data,
        rejectedB.data,
      );
      assert.throws(
        () => h.identity["processes"].resolveRun(actor, parentA),
        code(failureCode),
      );
      for (const approved of [true, false]) {
        const response = await mobile(
          "commands",
          decision(a.command.commandId, approved),
        );
        assert.equal(response.status, 409, JSON.stringify(response.data));
        assert.equal(h.record(response.data).error, failureCode);
      }
      assertPassive();
      // Exact history is passive. A running native recovery would still require proof.
      const replayA = await mobile("commands", a.command);
      assert.equal(replayA.status, 202, JSON.stringify(replayA.data));
      assert.deepEqual(
        ProcessRuntimeResponseSchema.parse(replayA.data).admission,
        a.result.admission,
      );
      assert.equal(
        ProcessRuntimeResponseSchema.parse(replayA.data).process?.status,
        "waiting",
      );
      assert.deepEqual(
        h.identity["processStarts"]!.read(
          actor,
          credential.scope,
          a.command.commandId,
          a.command.idempotencyKey,
        ),
        a.result.admission,
      );
      assert.equal(
        h.identity["processes"].pinnedVersion(actor, parentA).digest,
        input.artifactDigest,
      );
      assert.equal(
        h.identity["processes"].version(actor, input.processId, input.version)
          .testStatus,
        "passed",
      );
      assert.equal(
        h.identity["processes"].listVersions(actor, input.processId)
          .versions[0]!.digest,
        input.artifactDigest,
      );
      const replayC = await mobile("commands", denialC);
      assert.equal(replayC.status, 202, JSON.stringify(replayC.data));
      assert.deepEqual(replayC.data, deniedC.data);
      const replayActivation = await h.request(
        "owner",
        activationHttpPath,
        activationCommand,
      );
      assert.equal(replayActivation.status, 200);
      assert.deepEqual(h.receipt(replayActivation.data), activationReceipt);
      const replayNative = await h.request("owner", nativeHttpPath, input);
      assert.equal(replayNative.status, 200);
      assert.deepEqual(h.job(replayNative.data), job);
      await session.refresh();
      await settle();
      assertPassive();
      assert.deepEqual(fingerprints(copied.source), copied.sourceHashes);
      // The protected source is stopped and has no pending WAL frames. Immutable
      // inspection must never silently read a main-file-only view of live WAL data.
      const sourceIdentityPath = join(
        copied.source,
        "identity",
        "identity.sqlite",
      );
      assert(
        !existsSync(sourceIdentityPath + "-wal") ||
          lstatSync(sourceIdentityPath + "-wal").size === 0,
        "TEST protected identity has unapplied WAL frames",
      );
      const original = new DatabaseSync(
        pathToFileURL(sourceIdentityPath).href + "?immutable=1",
        { readOnly: true },
      );
      try {
        assert.deepEqual(
          original
            .prepare(
              "SELECT reference FROM agent_service_process_qualification WHERE process_id=? AND version=?",
            )
            .get(input.processId, input.version),
          reference,
        );
        assert.deepEqual(
          original
            .prepare(
              "SELECT * FROM agent_process_native_test_admission WHERE test_id=?",
            )
            .get(job.testId),
          ordinal,
        );
      } finally {
        original.close();
      }
      assert.deepEqual(fingerprints(copied.source), copied.sourceHashes);

      // Restore the exact bytes that were copied; no retest, replacement authority or activation.
      if (fault === "qualification reference") {
        h.identity["db"]
          .prepare(
            "INSERT INTO agent_service_process_qualification VALUES (?,?,?)",
          )
          .run(input.processId, input.version, String(reference.reference));
      } else {
        assert.equal(
          h.identity["db"]
            .prepare(
              "INSERT INTO agent_process_native_test_admission (seq,test_id,server_id,organization_id,workspace_id,process_id,version) VALUES (?,?,?,?,?,?,?)",
            )
            .run(
              ordinal.seq!,
              ordinal.test_id!,
              ordinal.server_id!,
              ordinal.organization_id!,
              ordinal.workspace_id!,
              ordinal.process_id!,
              ordinal.version!,
            ).changes,
          1,
        );
      }
      const assertOriginalProof = () => {
        assert.deepEqual(
          h.identity["db"]
            .prepare(
              "SELECT * FROM agent_process_native_test_admission WHERE test_id=?",
            )
            .get(job.testId),
          ordinal,
        );
        assert.deepEqual(
          h.identity["db"]
            .prepare(
              "SELECT * FROM agent_process_contract_test WHERE test_id=?",
            )
            .get(job.testId),
          qualifiedJob,
        );
        assert.deepEqual(
          h.identity["db"]
            .prepare(
              "SELECT * FROM agent_service_process_test WHERE process_id=? AND version=?",
            )
            .get(input.processId, input.version),
          historicalTest,
        );
        assert.deepEqual(
          h.identity["db"]
            .prepare(
              "SELECT reference FROM agent_service_process_qualification WHERE process_id=? AND version=?",
            )
            .get(input.processId, input.version),
          reference,
        );
      };
      assertOriginalProof();
      session.stop();
      await h.restart();
      install();
      session = makeSession();
      await session.start(false);
      await settle();
      assertOriginalProof();
      assert.equal(h.modelCount(), baseline.models);
      assert.deepEqual(dispatches, baseline.dispatches);
      assert.deepEqual(canonicalA(), receiptA);
      assert.equal(
        h.identity["processes"].resolveRun(actor, parentA).digest,
        input.artifactDigest,
      );
      assert.deepEqual(
        work(a.command.commandId).native!.process!.provenance,
        pinA,
      );
      const approval = decision(a.command.commandId, true);
      const completed = await mobile("commands", approval);
      assert.equal(completed.status, 202, JSON.stringify(completed.data));
      const outcome = ProcessRuntimeResponseSchema.parse(completed.data);
      assert.equal(outcome.process?.status, "succeeded");
      assert.deepEqual(outcome.process?.output, { result: "TEST-result" });
      assert.deepEqual(dispatches, ["POST"]);
      const canonical = h.identity["catalog"].store.invocation(
        approvalA!.result.operationId,
        credential.scope.workspaceId,
        credential.scope.userId,
      )!;
      assert.equal(canonical.status, "succeeded");
      assert.equal(canonical.effect, "write");
      assert.deepEqual(canonical.input, { name: "TEST-input" });
      assert.deepEqual(canonical.result, { value: "TEST-result" });
      const modelAfter = h.modelCount();
      assert.deepEqual(
        (await mobile("commands", approval)).data,
        completed.data,
      );
      assert.equal(h.modelCount(), modelAfter);
      assert.deepEqual(dispatches, ["POST"]);
      const terminalReceipt = canonicalA();
      session.stop();
      await h.restart();
      install();
      session = makeSession();
      await session.start(false);
      await settle();
      assertOriginalProof();
      assert.deepEqual(canonicalA(), terminalReceipt);
      assert.deepEqual(
        work(a.command.commandId).native!.process!.provenance,
        pinA,
      );
      assert.deepEqual(
        (await mobile("commands", approval)).data,
        completed.data,
      );
      assert.deepEqual(canonicalA(), terminalReceipt);
      assert.equal(h.modelCount(), modelAfter);
      assert.deepEqual(dispatches, ["POST"]);
      assert.deepEqual(fingerprints(copied.source), copied.sourceHashes);
    } finally {
      session?.stop();
      await h.close();
    }
  });
}
