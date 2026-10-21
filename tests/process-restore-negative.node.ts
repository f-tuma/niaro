import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { authRequest } from "../packages/client-core/auth";
import {
  captureProcessResolveTarget,
  processResolveCommand,
  processStartCommand,
} from "../packages/client-core/process-commands";
import { ClientSession } from "../packages/client-core/session";
import { CredentialSchema, type WorkItem } from "../packages/protocol";
import { ProcessRuntimeResponseSchema } from "../packages/protocol/process-coordinator";
import {
  NativeTestToolsSchema,
  PROCESS_NATIVE_TEST_PROFILE,
} from "../packages/protocol/process-native-testing";
import { PROCESS_QUESTION_EXECUTION_PROFILE } from "../packages/protocol/process-questions";
import {
  activationHttpFixture,
  activationHttpPath,
} from "./helpers/process-activation-http";
import type { StoppedCopyProof } from "./helpers/process-design-http";

function fingerprints(root: string) {
  const hashes: Record<string, string> = {};
  const walk = (directory = "") => {
    for (const entry of readdirSync(join(root, directory), {
      withFileTypes: true,
    })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        assert(entry.isFile(), "TEST tuple contains only regular files");
        hashes[path] = createHash("sha256")
          .update(readFileSync(join(root, path)))
          .digest("hex");
      }
    }
  };
  walk();
  return hashes;
}

function immutableRead<T>(path: string, read: (db: DatabaseSync) => T): T {
  // The owner is stopped. Immutable reads cannot create WAL/SHM sidecars or
  // accidentally acquire an owner lock on the protected original tuple.
  const wal = path + "-wal";
  assert(
    !existsSync(wal) || lstatSync(wal).size === 0,
    "TEST immutable identity/workflow evidence must not ignore a nonempty WAL",
  );
  const db = new DatabaseSync(pathToFileURL(path).href + "?immutable=1", {
    readOnly: true,
  });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function assertStoppedCopyModes(copy: StoppedCopyProof) {
  const modes = (root: string) => {
    const result: Record<string, number> = {};
    const walk = (path = ".") => {
      const stat = lstatSync(join(root, path));
      assert(stat.isDirectory() || stat.isFile());
      result[path] = stat.mode & 0o777;
      if (stat.isDirectory())
        for (const entry of readdirSync(join(root, path)))
          walk(join(path, entry));
    };
    walk();
    return result;
  };
  assert.equal(modes(copy.source)["."], 0o700);
  assert.deepEqual(modes(copy.destination), modes(copy.source));
}

function assertCopyBaseline(copy: StoppedCopyProof) {
  assert.notEqual(copy.source, copy.destination);
  assert.deepEqual(copy.copyHashes, copy.sourceHashes);
  assert(copy.copyHashes["identity/identity.sqlite.mastra.sqlite"]);
  assert(copy.copyHashes["workflow/workflow.sqlite"]);
  assert(copy.copyHashes["workflow/auth/server-id"]);
  assert.equal(
    copy.integrity.length,
    Object.keys(copy.copyHashes).filter((path) => path.endsWith(".sqlite"))
      .length,
  );
  for (const item of copy.integrity) {
    assert.deepEqual(item.checks, ["ok"], item.path);
    assert.deepEqual(item.foreignKeys, [], item.path);
  }
}

// Public native qualification (all twelve observations), activation, paired
// HTTP commands, Session projection and SQLite checkpoints are real. Only the
// business/model responses are synthetic and dispatch to these local counters.
async function waitingApproval() {
  const h = await activationHttpFixture();
  const dispatches: string[] = [];
  let session: ClientSession | undefined;
  try {
    const input = await h.fresh();
    const job = await h.runNative(input);
    assert.equal(job.qualification?.status, "qualified");
    assert.equal(job.report?.observations.length, 12);
    assert(job.report.observations.every((observation) => observation.passed));
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
    const writeTool = NativeTestToolsSchema.parse(toolsResponse.data)
      .configured.flatMap((node) => node.tools)
      .find((tool) => "actionId" in tool && tool.actionId === h.writeId);
    assert(writeTool, "TEST immutable inventory must bind the write action");
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
    const settle = async () => {
      const deadline = Date.now() + 15000;
      while (
        !session!.getSnapshot().store ||
        session!.getSnapshot().store!.stale
      ) {
        assert(
          Date.now() < deadline,
          "TEST restored paired Session did not settle",
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    const postBytes = async (bytes: string) => {
      const response = await fetch(
        endpoint +
          "/processes/commands?profile=" +
          encodeURIComponent(PROCESS_QUESTION_EXECUTION_PROFILE),
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + credential.accessToken,
            "Content-Type": "application/json",
          },
          body: bytes,
          signal: AbortSignal.timeout(15000),
        },
      );
      return {
        status: response.status,
        data: (await response.json()) as unknown,
      };
    };
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
                  name: writeTool.name,
                  arguments: '{"name":"TEST-input"}',
                },
              },
            ],
          },
    );
    const inventory = await session.loadProcessInventory();
    const entry = inventory.processes.find(
      (process) => process.processId === input.processId,
    )!;
    assert.equal(entry.availability, "ready");
    const card = await session.prepareProcessInput(
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
    const startCommand = processStartCommand(card, {
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      language: "en",
      input: { name: "TEST-input" },
    });
    const startBytes = JSON.stringify(startCommand);
    const started = await postBytes(startBytes);
    assert.equal(started.status, 202, JSON.stringify(started.data));
    const startResult = ProcessRuntimeResponseSchema.parse(started.data);
    assert.equal(startResult.admission?.status, "admitted");
    assert.equal(startResult.process?.status, "waiting");
    const refresh = async () => {
      await session!.refresh();
      await settle();
    };
    await refresh();
    const work = (): WorkItem => {
      const item = Object.values(session!.getSnapshot().store!.workItems).find(
        (row) =>
          row.native?.process?.provenance.commandId === startCommand.commandId,
      );
      assert(item, "TEST original pinned process work is missing");
      return item;
    };
    assert.equal(work().status, "waiting_approval");
    const parentId = work().id;
    const pin = structuredClone(work().native!.process!.provenance);
    const approval = structuredClone(work().native!.process!.approval);
    assert(approval);
    assert.equal(pin.artifactDigest, input.artifactDigest);
    assert.equal(pin.version, input.version);
    assert.equal(pin.admissionId, startResult.admission!.receiptId);
    assert.equal(startResult.process!.parentRunId, parentId);
    const target = captureProcessResolveTarget(
      session.getSnapshot().store!,
      work().id,
      undefined,
      "conversation-1",
      work(),
    );
    const approvalCommand = processResolveCommand(
      session.getSnapshot().store!,
      target,
      {
        commandId: randomUUID(),
        idempotencyKey: randomUUID(),
        language: "en",
        approved: true,
      },
    );
    const approvalBytes = JSON.stringify(approvalCommand);
    const identityEvidence = (db: DatabaseSync) => {
      const evidence = {
        nativeAdmission: db
          .prepare(
            "SELECT * FROM agent_process_native_test_admission WHERE test_id=?",
          )
          .get(job.testId),
        nativeJob: db
          .prepare("SELECT * FROM agent_process_contract_test WHERE test_id=?")
          .get(job.testId),
        qualification: db
          .prepare(
            "SELECT * FROM agent_service_process_qualification WHERE process_id=? AND version=?",
          )
          .get(input.processId, input.version),
        activation: db
          .prepare(
            "SELECT * FROM agent_process_activation_command WHERE process_id=?",
          )
          .all(input.processId),
        startAdmission: db
          .prepare("SELECT * FROM agent_process_start_command WHERE run_id=?")
          .get(parentId),
        receipt: db
          .prepare("SELECT * FROM agent_service_invocation WHERE id=?")
          .get(approval.result.operationId),
      };
      assert(
        evidence.nativeAdmission &&
          evidence.nativeJob &&
          evidence.qualification,
      );
      assert.equal(
        evidence.nativeAdmission.server_id,
        credential.scope.serverId,
      );
      assert.equal(evidence.activation.length, 1);
      assert(
        evidence.startAdmission,
        "TEST original parent admission is missing",
      );
      assert(evidence.receipt, "TEST original canonical receipt is missing");
      assert.deepEqual(
        JSON.parse(String(evidence.startAdmission.data)).receipt,
        startResult.admission,
      );
      return evidence;
    };
    const evidence = identityEvidence(h.identity["db"]);
    const canonical = () =>
      h.identity["db"]
        .prepare("SELECT * FROM agent_service_invocation WHERE id=?")
        .get(approval.result.operationId);
    const receipt = evidence.receipt;
    assert(receipt);
    const receiptData = JSON.parse(String(receipt.data));
    assert.equal(receiptData.status, "awaiting_approval");
    assert.equal(receiptData.result, undefined);
    const baseline = { models: h.modelCount(), dispatches: [...dispatches] };
    assert.deepEqual(dispatches, []);
    const assertCounts = () => {
      assert.equal(h.modelCount(), baseline.models);
      assert.equal(h.businessCount(), 0);
      assert.deepEqual(dispatches, baseline.dispatches);
    };
    const assertWaiting = () => {
      assertCounts();
      assert.equal(work().status, "waiting_approval");
      assert.deepEqual(work().native!.process!.provenance, pin);
      assert.deepEqual(work().native!.process!.approval, approval);
      assert.deepEqual(canonical(), receipt);
    };
    const reopenSession = async () => {
      install();
      session = makeSession();
      await session.start(false);
      await settle();
    };
    const nativePath = relative(
      h.root,
      fileURLToPath(h.identity["catalog"].store.nativeStorageUrl),
    );
    assert.equal(nativePath, "identity/identity.sqlite.mastra.sqlite");
    return {
      h,
      job,
      input,
      credential,
      dispatches,
      startResult,
      startBytes,
      approvalCommand,
      approvalBytes,
      activationCommand,
      activationReceipt,
      pin,
      approval,
      receipt,
      evidence,
      nativePath,
      identityEvidence,
      canonical,
      baseline,
      postBytes,
      refresh,
      work,
      assertCounts,
      assertWaiting,
      reopenSession,
      stopSession: () => session!.stop(),
      close: async () => {
        session?.stop();
        await h.close();
      },
    };
  } catch (error) {
    session?.stop();
    await h.close();
    throw error;
  }
}

test("a foreign server-id in a stopped qualified HTTP copy rejects bootstrap, preserves original authority and releases both locks for exact-ID recovery", async () => {
  const f = await waitingApproval();
  let copy: StoppedCopyProof | undefined;
  let originalId: Buffer | undefined;
  try {
    f.stopSession();
    await assert.rejects(
      f.h.restoreCopy((proof) => {
        copy = proof;
        assertCopyBaseline(proof);
        assertStoppedCopyModes(proof);
        assert.equal(
          f.h.config.dataDirectory,
          join(proof.destination, "workflow"),
        );
        const idPath = "workflow/auth/server-id";
        originalId = readFileSync(join(proof.destination, idPath));
        assert.equal(originalId.toString(), f.credential.scope.serverId);
        const foreignId =
          originalId.toString() === "fixture-" + "a".repeat(24)
            ? "fixture-" + "b".repeat(24)
            : "fixture-" + "a".repeat(24);
        writeFileSync(join(proof.destination, idPath), foreignId);
        const expected = {
          ...proof.copyHashes,
          [idPath]: createHash("sha256").update(foreignId).digest("hex"),
        };
        assert.notDeepEqual(expected, proof.copyHashes);
        assert.deepEqual(fingerprints(proof.destination), expected);
      }),
      { message: "Persisted server identity mismatch" },
    );
    assert(copy && originalId);
    f.assertCounts();
    const inspect = (root: string) => {
      assert.deepEqual(
        immutableRead(
          join(root, "identity", "identity.sqlite"),
          f.identityEvidence,
        ),
        f.evidence,
      );
      assert.equal(
        immutableRead(
          join(root, "workflow", "workflow.sqlite"),
          (db) =>
            db.prepare("SELECT value FROM metadata WHERE key='server_id'").get()
              ?.value,
        ),
        originalId!.toString(),
      );
    };
    assert.deepEqual(fingerprints(copy.source), copy.sourceHashes);
    inspect(copy.source);
    inspect(copy.destination);
    assert.deepEqual(fingerprints(copy.source), copy.sourceHashes);
    // Recover only the original ID bytes, without deleting either SQLite lock.
    await f.h.restart(({ root }) => {
      assert.equal(root, copy!.destination);
      writeFileSync(join(root, "workflow", "auth", "server-id"), originalId!);
    });
    await f.reopenSession();
    f.assertWaiting();
    const activationReplay = await f.h.request(
      "owner",
      activationHttpPath,
      f.activationCommand,
    );
    assert.equal(activationReplay.status, 200);
    assert.deepEqual(f.h.receipt(activationReplay.data), f.activationReceipt);
    f.assertWaiting();
    assert.equal(JSON.stringify(f.approvalCommand), f.approvalBytes);
    const completed = await f.postBytes(f.approvalBytes);
    assert.equal(completed.status, 202, JSON.stringify(completed.data));
    const result = ProcessRuntimeResponseSchema.parse(completed.data);
    assert.equal(result.process?.status, "succeeded");
    assert.deepEqual(result.process?.output, { result: "TEST-result" });
    assert.deepEqual(f.dispatches, ["POST"]);
    const canonical = f.h.identity["catalog"].store.invocation(
      f.approval.result.operationId,
      f.credential.scope.workspaceId,
      f.credential.scope.userId,
    )!;
    assert.equal(canonical.status, "succeeded");
    assert.deepEqual(canonical.result, { value: "TEST-result" });
    await f.refresh();
    assert.equal(f.work().status, "succeeded");
    assert.deepEqual(f.work().native!.process!.provenance, f.pin);
    const modelAfter = f.h.modelCount();
    assert.deepEqual(await f.postBytes(f.approvalBytes), completed);
    assert.equal(f.h.modelCount(), modelAfter);
    assert.deepEqual(f.dispatches, ["POST"]);
    assert.deepEqual(fingerprints(copy.source), copy.sourceHashes);
  } finally {
    await f.close();
  }
});

test("missing copied canonical native SQLite lets passive approval history reopen but original paired approval fails with process_checkpoint_missing and never dispatches", async () => {
  const f = await waitingApproval();
  try {
    f.stopSession();
    const copy = await f.h.restoreCopy((proof) => {
      assertCopyBaseline(proof);
      assertStoppedCopyModes(proof);
      const family = [
        f.nativePath,
        f.nativePath + "-wal",
        f.nativePath + "-shm",
      ];
      const removed = family.filter((path) =>
        existsSync(join(proof.destination, path)),
      );
      assert(removed.includes(f.nativePath));
      const expected = { ...proof.copyHashes };
      for (const path of removed) {
        assert(
          expected[path],
          "TEST removed file must belong to the verified baseline",
        );
        rmSync(join(proof.destination, path));
        delete expected[path];
      }
      assert.deepEqual(fingerprints(proof.destination), expected);
      assert.deepEqual(fingerprints(proof.source), proof.sourceHashes);
    });
    // The returned hashes prove the pristine stopped baseline; the hook above
    // separately proves its exact removal manifest before owner startup.
    assertCopyBaseline(copy);
    await f.reopenSession();
    f.assertWaiting();
    assert.equal(JSON.stringify(f.approvalCommand), f.approvalBytes);
    const rejected = await f.postBytes(f.approvalBytes);
    assert.equal(rejected.status, 202, JSON.stringify(rejected.data));
    const result = ProcessRuntimeResponseSchema.parse(rejected.data);
    assert.equal(result.process?.status, "failed");
    assert.equal(result.process?.failure?.code, "process_checkpoint_missing");
    assert.equal(result.process?.approval, undefined);
    assert.equal(result.process?.output, undefined);
    const assertFailed = () => {
      f.assertCounts();
      assert.deepEqual(f.canonical(), f.receipt);
      const canonical = JSON.parse(String(f.canonical()!.data));
      assert.equal(canonical.status, "awaiting_approval");
      assert.equal(canonical.result, undefined);
      const work = f.work();
      assert.equal(work.status, "failed");
      assert.deepEqual(work.native!.process!.provenance, f.pin);
      assert.equal(work.native!.process!.approval, undefined);
      assert.match(work.context, /process_checkpoint_missing/);
      assert.match(work.result!, /process_checkpoint_missing/);
      assert(work.card, "TEST failed work must have its public card");
      const reachable = new Set<string>();
      const visit = (id: string) => {
        if (reachable.has(id)) return;
        reachable.add(id);
        const node = work.card!.nodes.find((item) => item.id === id);
        assert(node);
        if ("children" in node) node.children.forEach(visit);
      };
      work.card.root.forEach(visit);
      assert(
        work.card.nodes.some(
          (node) =>
            reachable.has(node.id) &&
            node.type === "notice" &&
            node.text.includes("process_checkpoint_missing"),
        ),
        "TEST failure code must be visible in a reachable root card notice",
      );
      assert.deepEqual(fingerprints(copy.source), copy.sourceHashes);
    };
    await f.refresh();
    assertFailed();
    assert.deepEqual(await f.postBytes(f.approvalBytes), rejected);
    await f.refresh();
    assertFailed();
    f.stopSession();
    await f.h.restart();
    await f.reopenSession();
    assertFailed();
    assert.deepEqual(await f.postBytes(f.approvalBytes), rejected);
    await f.refresh();
    assertFailed();
    assert.deepEqual(
      immutableRead(
        join(copy.source, "identity", "identity.sqlite"),
        f.identityEvidence,
      ),
      f.evidence,
    );
    assert.deepEqual(fingerprints(copy.source), copy.sourceHashes);
    // No partial SQLite replacement is attempted after this failed decision.
    // Positive whole-tuple restoration is covered by process-matched-restore.
  } finally {
    await f.close();
  }
});
