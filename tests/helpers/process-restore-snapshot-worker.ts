import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { ProcessWorkflowCheckpointSchema } from "../../apps/server-agent/process-checkpoint";
import { JournalSchema } from "../../apps/server-identity/service-process-journal";
import { authRequest } from "../../packages/client-core/auth";
import { processStartCommand } from "../../packages/client-core/process-commands";
import { ClientSession } from "../../packages/client-core/session";
import { CredentialSchema, type WorkItem } from "../../packages/protocol";
import { ProcessRuntimeResponseSchema } from "../../packages/protocol/process-coordinator";
import {
  NativeTestToolsSchema,
  PROCESS_NATIVE_TEST_PROFILE,
} from "../../packages/protocol/process-native-testing";
import { PROCESS_QUESTION_EXECUTION_PROFILE } from "../../packages/protocol/process-questions";
import {
  activationHttpFixture,
  activationHttpPath,
} from "./process-activation-http";

const send = (message: Record<string, unknown>) =>
  new Promise<void>((resolve, reject) => {
    assert(
      process.send,
      "TEST snapshot worker requires its private IPC channel",
    );
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });

function fingerprints(root: string) {
  const hashes: Record<string, string> = {};
  const walk = (directory = "") => {
    for (const entry of readdirSync(join(root, directory), {
      withFileTypes: true,
    })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        assert(entry.isFile());
        hashes[path] = createHash("sha256")
          .update(readFileSync(join(root, path)))
          .digest("hex");
      }
    }
  };
  walk();
  return hashes;
}

async function collectDeferredFinalizers() {
  assert(global.gc, "TEST worker must run with --expose-gc");
  for (let pass = 0; pass < 3; pass++) {
    global.gc();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

// The worker owns a real fixture and its native suspended parent checkpoint.
// Explicit GC is isolated here; production and ordinary fixture callers never
// depend on GC, and no SQLite sidecars are manually removed by this proof.
async function main() {
  const h = await activationHttpFixture();
  let session: ClientSession | undefined;
  try {
    await send({ type: "fixture", root: h.root });
    const input = await h.fresh();
    const job = await h.runNative(input);
    assert.equal(job.qualification?.status, "qualified");
    assert.equal(job.report?.observations.length, 12);
    const activated = await h.request(
      "owner",
      activationHttpPath,
      h.command(input, job, randomUUID()),
    );
    assert.equal(activated.status, 200, JSON.stringify(activated.data));
    const toolResponse = await h.request(
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
    assert.equal(toolResponse.status, 200);
    const tool = NativeTestToolsSchema.parse(toolResponse.data)
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
    h.onModel(() => ({
      tool_calls: [
        {
          id: randomUUID(),
          type: "function",
          function: { name: tool.name, arguments: '{"name":"TEST-input"}' },
        },
      ],
    }));
    session = makeSession();
    await session.start(false);
    const inventory = await session.loadProcessInventory();
    const entry = inventory.processes.find(
      (item) => item.processId === input.processId,
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
    const command = processStartCommand(card, {
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      language: "en",
      input: { name: "TEST-input" },
    });
    const bytes = JSON.stringify(command);
    const post = async () => {
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
    const started = await post();
    assert.equal(started.status, 202, JSON.stringify(started.data));
    const result = ProcessRuntimeResponseSchema.parse(started.data);
    assert.equal(result.process?.status, "waiting");
    const work = (): WorkItem => {
      const item = Object.values(session!.getSnapshot().store!.workItems).find(
        (row) =>
          row.native?.process?.provenance.commandId === command.commandId,
      );
      assert(item);
      return item;
    };
    await session.refresh();
    assert.equal(work().status, "waiting_approval");
    const pin = structuredClone(work().native!.process!.provenance);
    const approval = structuredClone(work().native!.process!.approval);
    assert(approval);
    const models = h.modelCount();
    assert.equal(h.businessCount(), 0);
    const parentId = result.process!.parentRunId;
    const journal = JournalSchema.parse(
      h.identity["catalog"].store.turn(
        parentId,
        credential.scope.workspaceId,
        credential.scope.userId,
      ),
    );
    assert.equal(journal.status, "waiting");
    assert.equal(journal.runId, pin.runId);
    assert.equal(journal.artifactDigest, pin.artifactDigest);
    const workflowName =
      "niaro-process-" +
      createHash("sha256")
        .update(
          JSON.stringify([
            journal.compilerVersion,
            parentId,
            journal.scopeDigest,
            journal.artifactDigest,
          ]),
        )
        .digest("hex");
    session.stop();
    const nativeFile = join(
      h.root,
      "identity",
      "identity.sqlite.mastra.sqlite",
    );
    const suspended = (db: DatabaseSync) => {
      const row = db
        .prepare(
          "SELECT run_id, workflow_name, json(snapshot) AS snapshot FROM mastra_workflow_snapshot WHERE run_id=? AND workflow_name=?",
        )
        .get(parentId, workflowName);
      assert(row, "TEST exact original parent workflow checkpoint must exist");
      assert.equal(row.run_id, parentId);
      assert.equal(row.workflow_name, workflowName);
      const snapshot = ProcessWorkflowCheckpointSchema.parse(
        JSON.parse(String(row.snapshot)),
      );
      assert.equal(snapshot.runId, parentId);
      assert.deepEqual(snapshot.context.input, journal.input);
      return snapshot.status === "suspended";
    };
    const observer = new DatabaseSync(nativeFile);
    let callbackCalled = false;
    const originalDirectory = h.config.dataDirectory;
    try {
      observer.exec("BEGIN");
      assert(
        suspended(observer),
        "TEST busy reader must hold the actual suspended parent checkpoint",
      );
      await assert.rejects(
        h.restoreCopy(() => {
          callbackCalled = true;
        }),
        /TEST native snapshot is still busy/,
      );
      assert.equal(callbackCalled, false);
      assert.equal(h.config.dataDirectory, originalDirectory);
      assert.equal(h.modelCount(), models);
      assert.equal(h.businessCount(), 0);
    } finally {
      observer.exec("ROLLBACK");
      observer.close();
    }
    const copy = await h.restoreCopy(async (proof) => {
      await send({ type: "copy", destination: proof.destination });
      assert.deepEqual(proof.sourceHashes, proof.copyHashes);
      const nativeFile = join(
        proof.source,
        "identity",
        "identity.sqlite.mastra.sqlite",
      );
      assert.equal(existsSync(nativeFile + "-wal"), false);
      assert.equal(existsSync(nativeFile + "-shm"), false);
      const db = new DatabaseSync(
        pathToFileURL(nativeFile).href + "?immutable=1",
        { readOnly: true },
      );
      try {
        assert(
          suspended(db),
          "TEST original native parent must have a real suspended checkpoint",
        );
      } finally {
        db.close();
      }
      await collectDeferredFinalizers();
      assert.deepEqual(fingerprints(proof.source), proof.sourceHashes);
      assert.deepEqual(fingerprints(proof.destination), proof.copyHashes);
    });
    await collectDeferredFinalizers();
    assert.deepEqual(fingerprints(copy.source), copy.sourceHashes);
    session = makeSession();
    await session.start(false);
    await session.refresh();
    assert.equal(work().status, "waiting_approval");
    assert.deepEqual(work().native!.process!.provenance, pin);
    assert.deepEqual(work().native!.process!.approval, approval);
    assert.deepEqual(await post(), started);
    assert.equal(h.modelCount(), models);
    assert.equal(h.businessCount(), 0);
    await collectDeferredFinalizers();
    assert.deepEqual(fingerprints(copy.source), copy.sourceHashes);
    session.stop();
    const copiedConfig = structuredClone(h.config);
    await assert.rejects(
      h.restart(({ root }) => {
        assert.equal(root, copy.destination);
        const copiedNative = join(
          root,
          "identity",
          "identity.sqlite.mastra.sqlite",
        );
        rmSync(copiedNative);
        writeFileSync(copiedNative + "-wal", "TEST orphan native WAL", {
          mode: 0o600,
        });
        throw Error("TEST stop before orphan reopen");
      }),
      { message: "TEST stop before orphan reopen" },
    );
    let orphanCallbackCalled = false;
    await assert.rejects(
      h.restoreCopy(() => {
        orphanCallbackCalled = true;
      }),
      /TEST native snapshot has orphaned sidecars/,
    );
    assert.equal(orphanCallbackCalled, false);
    assert.deepEqual(h.config, copiedConfig);
    assert.equal(h.modelCount(), models);
    assert.equal(h.businessCount(), 0);
    assert.deepEqual(fingerprints(copy.source), copy.sourceHashes);
    await send({
      type: "verified",
      qualificationObservations: job.report!.observations.length,
      suspendedCheckpoint: true,
      busyReaderRefused: true,
      orphanSidecarsRefused: true,
      sourceStableAfterGc: true,
      passivePairedReopen: true,
    });
  } finally {
    session?.stop();
    await h.close();
  }
}

void main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => process.disconnect?.());
