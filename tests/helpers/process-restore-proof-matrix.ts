import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { ProcessWorkflowCheckpointSchema } from "../../apps/server-agent/process-checkpoint";
import { JournalSchema } from "../../apps/server-identity/service-process-journal";
import { authRequest } from "../../packages/client-core/auth";
import {
  captureProcessResolveTarget,
  processResolveCommand,
  processStartCommand,
} from "../../packages/client-core/process-commands";
import { ClientSession } from "../../packages/client-core/session";
import {
  CredentialSchema,
  SnapshotSchema,
  type WorkItem,
} from "../../packages/protocol";
import { ProcessRuntimeResponseSchema } from "../../packages/protocol/process-coordinator";
import { PROCESS_EXECUTION_PROFILE } from "../../packages/protocol/process-execution";
import {
  NativeTestToolsSchema,
  PROCESS_NATIVE_TEST_PROFILE,
} from "../../packages/protocol/process-native-testing";
import { PROCESS_QUESTION_EXECUTION_PROFILE } from "../../packages/protocol/process-questions";
import {
  activationHttpFixture,
  activationHttpPath,
} from "./process-activation-http";
import type { StoppedCopyProof } from "./process-design-http";

export const proofNativePath = "identity/identity.sqlite.mastra.sqlite";

export function proofManifest(root: string) {
  const hashes: Record<string, string> = {};
  const modes: Record<string, number> = {};
  const walk = (relative = "") => {
    const stat = lstatSync(join(root, relative));
    modes[relative || "."] = stat.mode & 0o777;
    if (stat.isDirectory()) {
      for (const name of readdirSync(join(root, relative)))
        walk(join(relative, name));
    } else {
      assert(stat.isFile(), "TEST tuple contains only regular files");
      hashes[relative] = createHash("sha256")
        .update(readFileSync(join(root, relative)))
        .digest("hex");
    }
  };
  walk();
  return { hashes, modes };
}

export function assertProofCopy(copy: StoppedCopyProof) {
  assert.notEqual(copy.source, copy.destination);
  assert.deepEqual(copy.copyHashes, copy.sourceHashes);
  assert(copy.copyHashes[proofNativePath]);
  assert(copy.copyHashes["identity/identity.sqlite"]);
  assert(copy.copyHashes["identity/secret"]);
  assert(copy.copyHashes["workflow/workflow.sqlite"]);
  assert(copy.copyHashes["workflow/auth/server-id"]);
  assert(copy.copyHashes["TEST-server-config.json"]);
  const source = proofManifest(copy.source);
  assert.equal(source.modes["."], 0o700);
  assert.deepEqual(source.hashes, copy.sourceHashes);
  assert.deepEqual(proofManifest(copy.destination), source);
  assert.equal(
    copy.integrity.length,
    Object.keys(copy.copyHashes).filter((path) => path.endsWith(".sqlite"))
      .length,
  );
  for (const inspection of copy.integrity) {
    assert.deepEqual(inspection.checks, ["ok"], inspection.path);
    assert.deepEqual(inspection.foreignKeys, [], inspection.path);
  }
  return source;
}

export function immutableProofRead<T>(
  path: string,
  read: (db: DatabaseSync) => T,
): T {
  assert(
    !existsSync(path + "-wal") || lstatSync(path + "-wal").size === 0,
    "TEST immutable inspection must not omit committed WAL frames",
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

/** A new disposable TEST fork of a complete stopped snapshot. No live owner,
 * selective receipt/auth reset, replacement lineage or production rollback. */
export function copyProofTuple(source: string, destination: string) {
  assert.notEqual(source, destination);
  const original = proofManifest(source);
  for (const name of readdirSync(destination))
    rmSync(join(destination, name), { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });
  for (const [relative, mode] of Object.entries(original.modes))
    chmodSync(join(destination, relative === "." ? "" : relative), mode);
  assert.deepEqual(proofManifest(destination), original);
  assert.deepEqual(proofManifest(source), original);
}

// Exactly one real pairing per fixture. Native qualification, activation,
// mobile HTTP, Session projections and every persisted proof are genuine;
// model and business transports return only these controlled TEST responses.
export async function proofApprovalFixture() {
  const h = await activationHttpFixture();
  const dispatches: string[] = [];
  let session: ClientSession | undefined;
  let stopped = true;
  let sessionCache = new Map<string, string>();
  let outageBeforeApprovalForward = false;
  const sessionPosts: {
    bytes: string;
    forwarded: boolean;
    status?: number;
    data?: unknown;
  }[] = [];
  const sessionRequest: typeof fetch = async (url, init) => {
    const address = url instanceof Request ? url.url : String(url);
    if (
      init?.method === "POST" &&
      new URL(address).pathname.endsWith("/processes/commands")
    ) {
      assert.equal(typeof init.body, "string");
      const bytes = String(init.body);
      const post: (typeof sessionPosts)[number] = { bytes, forwarded: false };
      sessionPosts.push(post);
      if (outageBeforeApprovalForward) {
        outageBeforeApprovalForward = false;
        const saved = [...sessionCache].find(([key]) =>
          key.startsWith("agent-client.command.v2:"),
        );
        assert(saved, "TEST outage must follow actual Session persistence");
        const envelope = JSON.parse(saved[1]);
        assert.equal(envelope.serializedCommand, bytes);
        assert.equal(envelope.command.type, "service.resolve");
        assert.equal(envelope.outcome, "unknown");
        post.forwarded = false;
        throw Error("TEST outage before forwarding the saved approval");
      }
      post.forwarded = true;
      const response = await fetch(url, init);
      post.status = response.status;
      post.data = (await response.clone().json()) as unknown;
      return response;
    }
    return fetch(url, init);
  };
  try {
    const input = await h.fresh();
    const job = await h.runNative(input);
    assert.equal(job.status, "completed");
    assert.equal(job.qualification?.status, "qualified");
    assert.equal(job.report?.observations.length, 12);
    assert(job.report.observations.every((item) => item.passed));
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
    const counts = () =>
      Object.fromEntries(
        [
          "agent_service_process_run",
          "agent_service_turn",
          "agent_service_invocation",
          "agent_inference_run",
          "agent_inference_attempt",
          "agent_memory",
          "agent_memory_request",
          "agent_process_start_intent",
          "agent_process_start_command",
          "agent_process_resolve_command",
          "agent_process_answer_command",
          "agent_process_contract_test",
          "agent_process_native_test_admission",
          "agent_service_process_test",
          "agent_service_process_qualification",
          "agent_process_activation_command",
        ].map((table) => [
          table,
          Number(
            h.identity["db"]
              .prepare(`SELECT count(*) AS n FROM ${table}`)
              .get()!.n,
          ),
        ]),
      );
    const noWorkState = () => ({
      models: h.modelCount(),
      business: h.businessCount(),
      dispatches: [...dispatches],
      counts: counts(),
    });
    const assertNoWork = (expected: ReturnType<typeof noWorkState>) =>
      assert.deepEqual(noWorkState(), expected);
    const settle = async () => {
      const end = Date.now() + 15000;
      while (
        !session!.getSnapshot().store ||
        session!.getSnapshot().store!.stale
      ) {
        assert(Date.now() < end, "TEST proof-matrix Session did not settle");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    const reopen = async () => {
      assert(stopped, "TEST old Session must stop before owner replacement");
      const passive = noWorkState();
      install();
      // Bind each Session to its own cache. A stopped L Session cannot write
      // into a distinct E fork's saved cache after an asynchronous completion.
      const backing = sessionCache;
      session = new ClientSession(
        endpoint,
        {
          getItem: async (key) => backing.get(key) ?? null,
          setItem: async (key, value) => {
            backing.set(key, value);
          },
        },
        credential,
        sessionRequest,
        undefined,
        undefined,
        false,
        { processQuestions: true, processApprovals: true },
      );
      stopped = false;
      await session.start(false);
      await settle();
      assertNoWork(passive);
    };
    const refresh = async () => {
      await session!.refresh();
      await settle();
    };
    const postBytes = async (
      bytes: string,
      path = "commands",
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
          body: bytes,
          signal: AbortSignal.timeout(15000),
        },
      );
      return {
        status: response.status,
        data: (await response.json()) as unknown,
      };
    };
    const formRequest = () => ({
      processId: input.processId,
      version: input.version,
      artifactDigest: input.artifactDigest,
      language: "en" as const,
      origin: {
        type: "command" as const,
        conversationId: "conversation-1",
        requestId: randomUUID(),
      },
    });
    await reopen();
    const entry = (await session!.loadProcessInventory()).processes.find(
      (process) => process.processId === input.processId,
    )!;
    assert.equal(entry.availability, "ready");
    const card = await session!.prepareProcessInput(formRequest(), entry);
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
    assert.equal(startResult.admission.status, "admitted");
    assert.equal(startResult.process?.status, "waiting");
    assert.deepEqual(startResult.scope, credential.scope);
    await refresh();
    const work = (): WorkItem => {
      const item = Object.values(session!.getSnapshot().store!.workItems).find(
        (row) =>
          row.native?.process?.provenance.commandId === startCommand.commandId,
      );
      assert(item, "TEST original paired process work is missing");
      return item;
    };
    assert.equal(work().status, "waiting_approval");
    const parentId = work().id;
    const pin = structuredClone(work().native!.process!.provenance);
    const approval = structuredClone(work().native!.process!.approval)!;
    assert(approval);
    assert.equal(pin.actorId, credential.scope.userId);
    assert.equal(pin.version, input.version);
    assert.equal(pin.artifactDigest, input.artifactDigest);
    const target = captureProcessResolveTarget(
      session!.getSnapshot().store!,
      parentId,
      undefined,
      "conversation-1",
      work(),
    );
    const decision = (approved: boolean) =>
      processResolveCommand(session!.getSnapshot().store!, target, {
        commandId: randomUUID(),
        idempotencyKey: randomUUID(),
        language: "en",
        approved,
      });
    const approvalCommand = decision(true);
    const denialCommand = decision(false);
    const approvalBytes = JSON.stringify(approvalCommand);
    const denialBytes = JSON.stringify(denialCommand);
    // A real issued form tests admission after proof loss, without issuing a
    // synthetic intent or preparing a forbidden fresh form after the mutation.
    const preparedCard = await session!.prepareProcessInput(
      formRequest(),
      entry,
    );
    const preparedStart = processStartCommand(preparedCard, {
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      language: "en",
      input: { name: "TEST-input" },
    });
    const preparedBytes = JSON.stringify(preparedStart);
    const rows = (db: DatabaseSync = h.identity["db"]) => ({
      process: db
        .prepare("SELECT * FROM agent_service_process WHERE id=?")
        .get(input.processId),
      version: db
        .prepare(
          "SELECT * FROM agent_service_process_version WHERE process_id=? AND version=?",
        )
        .get(input.processId, input.version),
      qualification: db
        .prepare(
          "SELECT * FROM agent_service_process_qualification WHERE process_id=? AND version=?",
        )
        .get(input.processId, input.version),
      nativeJob: db
        .prepare("SELECT * FROM agent_process_contract_test WHERE test_id=?")
        .get(job.testId),
      nativeAdmission: db
        .prepare(
          "SELECT * FROM agent_process_native_test_admission WHERE test_id=?",
        )
        .get(job.testId),
      historicalTest: db
        .prepare("SELECT * FROM agent_service_process_test WHERE test_id=?")
        .get(job.testId),
      activation: db
        .prepare(
          "SELECT * FROM agent_process_activation_command WHERE process_id=? ORDER BY command_key",
        )
        .all(input.processId),
      pin: db
        .prepare("SELECT * FROM agent_service_process_run WHERE run_id=?")
        .get(parentId),
      startAdmission: db
        .prepare("SELECT * FROM agent_process_start_command WHERE run_id=?")
        .get(parentId),
      journal: db
        .prepare("SELECT * FROM agent_service_turn WHERE id=?")
        .get(parentId),
      receipt: db
        .prepare("SELECT * FROM agent_service_invocation WHERE id=?")
        .get(approval.result.operationId),
      budgetRun: db
        .prepare("SELECT * FROM agent_inference_run WHERE id=?")
        .get(parentId),
      inferenceAttempts: db
        .prepare(
          "SELECT * FROM agent_inference_attempt WHERE run_id=? ORDER BY id",
        )
        .all(parentId),
      resolves: db
        .prepare(
          "SELECT * FROM agent_process_resolve_command WHERE parent_id=? ORDER BY command_key",
        )
        .all(parentId),
    });
    const original = rows();
    for (const value of Object.values(original)) assert(value);
    assert.equal(original.resolves.length, 0);
    assert.equal(original.budgetRun!.id, parentId);
    assert.equal(original.inferenceAttempts.length, 1);
    assert.equal(
      original.nativeAdmission!.server_id,
      credential.scope.serverId,
    );
    assert.equal(
      JSON.parse(String(original.nativeJob!.data)).job.status,
      "completed",
    );
    assert.deepEqual(
      JSON.parse(String(original.startAdmission!.data)).receipt,
      startResult.admission,
    );
    const originalJournal = JournalSchema.parse(
      JSON.parse(String(original.journal!.data)),
    );
    assert.equal(originalJournal.status, "waiting");
    assert.equal(originalJournal.artifactDigest, pin.artifactDigest);
    assert.deepEqual(originalJournal.input, { name: "TEST-input" });
    assert.equal(
      JSON.parse(String(original.receipt!.data)).status,
      "awaiting_approval",
    );
    assert.equal(JSON.parse(String(original.receipt!.data)).result, undefined);
    assert.deepEqual(dispatches, []);
    const assertWaiting = () => {
      assert.equal(work().status, "waiting_approval");
      assert.deepEqual(work().native!.process!.provenance, pin);
      assert.deepEqual(work().native!.process!.approval, approval);
      assert.deepEqual(rows().receipt, original.receipt);
    };
    const workflowName =
      "niaro-process-" +
      createHash("sha256")
        .update(
          JSON.stringify([
            originalJournal.compilerVersion,
            parentId,
            originalJournal.scopeDigest,
            originalJournal.artifactDigest,
          ]),
        )
        .digest("hex");
    const checkpoint = (root: string) =>
      immutableProofRead(join(root, proofNativePath), (db) => {
        const row = db
          .prepare(
            "SELECT run_id,workflow_name,json(snapshot) AS snapshot FROM mastra_workflow_snapshot WHERE run_id=? AND workflow_name=?",
          )
          .get(parentId, workflowName);
        assert(row, "TEST exact original parent native checkpoint is missing");
        assert.equal(row.run_id, parentId);
        assert.equal(row.workflow_name, workflowName);
        const parsed = ProcessWorkflowCheckpointSchema.parse(
          JSON.parse(String(row.snapshot)),
        );
        assert.equal(parsed.runId, parentId);
        assert.deepEqual(parsed.context.input, originalJournal.input);
        return { row, parsed };
      });
    return {
      h,
      input,
      job,
      credential,
      startCommand,
      startBytes,
      startResult,
      started,
      approvalCommand,
      approvalBytes,
      approvalTarget: target,
      denialCommand,
      denialBytes,
      preparedBytes,
      activationCommand,
      activationReceipt,
      parentId,
      pin,
      approval,
      original,
      rows,
      work,
      counts,
      noWorkState,
      assertNoWork,
      assertWaiting,
      checkpoint,
      dispatches,
      refresh,
      reopen,
      sessionPosts,
      state: () => session!.getSnapshot(),
      sendApproval: () => session!.send(approvalCommand, false, target),
      retryApproval: () => session!.retry(),
      outageBeforeApproval: () => {
        assert(!outageBeforeApprovalForward);
        outageBeforeApprovalForward = true;
      },
      postBytes,
      form: () =>
        postBytes(
          JSON.stringify(formRequest()),
          "input",
          PROCESS_EXECUTION_PROFILE,
        ),
      inventory: () => session!.loadProcessInventory(),
      captureCache: async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        return new Map(sessionCache);
      },
      useCache: (cache: Map<string, string>) => {
        assert(stopped, "TEST cache forks require a stopped Session");
        sessionCache = new Map(cache);
      },
      cacheWork: (cache: Map<string, string>) => {
        const entry = [...cache].find(([key]) =>
          key.startsWith("agent-client.snapshot.v2:"),
        );
        assert(entry, "TEST original Session snapshot cache must be preserved");
        const snapshot = SnapshotSchema.parse(JSON.parse(entry[1]));
        assert.deepEqual(snapshot.scope, credential.scope);
        const item = snapshot.workItems.find((row) => row.id === parentId);
        assert(item);
        return item;
      },
      stopSession: () => {
        session!.stop();
        stopped = true;
      },
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

export type ProofApprovalFixture = Awaited<
  ReturnType<typeof proofApprovalFixture>
>;
