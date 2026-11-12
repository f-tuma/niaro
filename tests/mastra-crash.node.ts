import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DomainCommandSchema } from "../apps/server-identity/mastra-domain";
import { createNativeSavedMemory } from "../apps/server-agent/saved-memory";
import { MemoryPayloadCrypto } from "../apps/server-identity/memory-payload-crypto";
import { MemoryStore } from "../apps/server-identity/memory";
import {
  crashMemoryActor,
  correctedPreference,
  previousPreference,
} from "./helpers/mastra-domain-crash";

const worker = fileURLToPath(
  new URL("./helpers/mastra-crash-worker.ts", import.meta.url),
);
type WorkerOutcome = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};
function runWorker(directory: string, mode: string): Promise<WorkerOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", worker, directory, mode],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`TEST crash worker timed out: ${mode}\n${stderr}`));
    }, 20000);
    child.on("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(deadline);
      const outcomePath = join(directory, "outcome.json");
      if (existsSync(outcomePath)) stdout += readFileSync(outcomePath, "utf8");
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function readNativeCheckpointData(directory: string) {
  const db = new DatabaseSync(join(directory, "production.sqlite.pi.sqlite"), {
    readOnly: true,
  });
  try {
    return {
      checkpoints: db
        .prepare(
          "SELECT id,status,record FROM tasks UNION ALL SELECT document_id,seq,content FROM document_revisions ORDER BY 1,2",
        )
        .all(),
      messages: db.prepare("SELECT * FROM entries ORDER BY id").all(),
    };
  } finally {
    db.close();
  }
}

for (const erasure of ["forget", "opt-out"] as const) {
  test(`Niaro committed correction cannot hydrate its native checkpoint after ${erasure}`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), `niaro-erasure-${erasure}-`));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const crashed = await runWorker(directory, "memory-after");
    assert.equal(crashed.signal, "SIGKILL", crashed.stdout + crashed.stderr);
    const committed = await readProductionMemory(directory);
    assert.equal(committed.state.memoryReceipts.length, 1);
    assert.equal(committed.version, 2);
    const nativeBefore = readNativeCheckpointData(directory);
    assert(nativeBefore.checkpoints.length > 0);

    const db = new DatabaseSync(join(directory, "production.sqlite"));
    const memory = new MemoryStore(db, {
      secret: "TEST-memory-crash-secret",
    });
    if (erasure === "forget") {
      const active = committed.items.find((item) => item.status === "active")!;
      await memory.forget(crashMemoryActor, {
        requestId: "TEST-forget-committed-correction",
        id: String(active.id),
        revision: Number(active.revision),
      });
    } else {
      memory.setOptOut(crashMemoryActor, {
        requestId: "TEST-opt-out-committed-correction",
        optOut: true,
      });
    }
    await memory.close();
    db.close();
    const erased = await readProductionMemory(directory);
    assert(erased.version > committed.version);
    if (erasure === "forget") {
      assert(erased.items.every((item) => item.status === "deleted"));
      assert(erased.items.every((item) => item.content === null));
    }

    const rejected = await runWorker(directory, "memory-recover");
    assert.equal(rejected.code, 1, rejected.stdout + rejected.stderr);
    assert.match(rejected.stdout, /memory_context_changed/);
    assert(!rejected.stdout.includes(previousPreference));
    assert(!rejected.stdout.includes(correctedPreference));
    const after = await readProductionMemory(directory);
    assert.deepEqual(
      after.models,
      erased.models,
      "no model receives forgotten or opted-out data",
    );
    assert.deepEqual(
      after.calls,
      erased.calls,
      "the stale mutation is never replayed",
    );
    assert.equal(after.version, erased.version);
    assert.deepEqual(after.items, erased.items);
    assert.deepEqual(
      after.state.memoryReceipts,
      committed.state.memoryReceipts,
    );
    // Pi's reopen marks the cut task pending (its restart count); nothing else moves.
    const nativeAfter = readNativeCheckpointData(directory);
    assert.deepEqual(
      nativeAfter.messages,
      nativeBefore.messages,
      "authorization denies before native recovery changes its messages",
    );
    assert.deepEqual(
      nativeAfter.checkpoints.map((row) => row.id),
      nativeBefore.checkpoints.map((row) => row.id),
      "authorization denies before native recovery adds tasks or revisions",
    );
  });
}

function readProductionAction(directory: string) {
  const db = new DatabaseSync(join(directory, "production.sqlite"), {
    readOnly: true,
  });
  try {
    const turns = db.prepare("SELECT data FROM agent_service_turn").all();
    assert.equal(turns.length, 1);
    return {
      state: DomainCommandSchema.parse(JSON.parse(String(turns[0]!.data))),
      receipts: db
        .prepare("SELECT data FROM agent_service_invocation")
        .all()
        .map(
          (row) =>
            JSON.parse(String(row.data)) as {
              id: string;
              status: string;
              effect: string;
              failure?: { retry: string; dispatched: boolean };
            },
        ),
      effects: db.prepare("SELECT * FROM production_provider_effect").all(),
      calls: db
        .prepare("SELECT * FROM production_action_call ORDER BY id")
        .all(),
      models: db
        .prepare("SELECT * FROM production_model_call ORDER BY id")
        .all(),
    };
  } finally {
    db.close();
  }
}

for (const stage of ["before", "succeeded-after", "unknown-after"] as const) {
  test(`Niaro service action survives SIGKILL ${stage} its receipt without duplicating a provider write`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), `niaro-action-${stage}-`));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const crashed = await runWorker(directory, `action-${stage}`);
    assert.equal(crashed.signal, "SIGKILL", crashed.stdout + crashed.stderr);
    const prior = readProductionAction(directory);
    assert.equal(prior.models.length, 3);
    assert.equal(prior.calls.length, 1);
    assert.equal(prior.state.receipts.length, 1);
    assert.equal(prior.state.operations.length, 1);
    const originalCallId = String(prior.calls[0]!.call_id);
    const operationId = String(prior.calls[0]!.operation_id);
    assert.equal(prior.state.receipts[0]!.callId, originalCallId);
    assert.equal(prior.state.operations[0], operationId);
    assert.equal(prior.effects.length, stage === "before" ? 0 : 1);
    assert.equal(prior.receipts.length, stage === "before" ? 0 : 1);
    if (stage !== "before")
      assert.equal(
        prior.receipts[0]!.status,
        stage === "unknown-after" ? "unknown" : "succeeded",
      );

    const recovered = await runWorker(directory, "action-recover");
    assert.equal(recovered.code, 0, recovered.stdout + recovered.stderr);
    assert.doesNotMatch(recovered.stderr, /CLIENT_CLOSED|unsettled top-level/);
    const output = JSON.parse(recovered.stdout) as {
      answer: {
        reply: string;
        result: { status: string; operationId: string };
      };
      runId: string;
      threadId: string;
      nativeCalls: { toolName: string; toolCallId: string; state: string }[];
    };
    const status = stage === "unknown-after" ? "unknown" : "succeeded";
    assert.equal(output.answer.result.status, status);
    assert.equal(output.answer.result.operationId, operationId);
    assert.equal(output.runId, prior.state.runId);
    assert.equal(output.threadId, prior.state.threadId);
    if (status === "unknown") assert.match(output.answer.reply, /unknown/i);
    const actual = readProductionAction(directory);
    assert.equal(
      actual.effects.length,
      1,
      "provider write must execute exactly once",
    );
    assert.equal(actual.receipts.length, 1);
    assert.equal(actual.receipts[0]!.id, operationId);
    assert.equal(actual.receipts[0]!.status, status);
    assert.deepEqual(actual.state.receipts, prior.state.receipts);
    assert.deepEqual(actual.state.operations, prior.state.operations);
    assert.deepEqual(
      actual.calls.map((row) => row.call_id),
      [originalCallId, originalCallId],
    );
    assert.deepEqual(
      actual.calls.map((row) => row.operation_id),
      [operationId, operationId],
    );
    const actionCalls = output.nativeCalls.filter((call) =>
      call.toolName.startsWith("action_"),
    );
    assert.equal(actionCalls.length, 1);
    assert.equal(actionCalls[0]!.toolCallId, originalCallId);
    assert.equal(actionCalls[0]!.state, "result");
    assert.equal(actual.models.length, 4);
    assert.equal(actual.models[3]!.has_receipt, 1);
  });
}

async function readProductionMemory(directory: string) {
  const db = new DatabaseSync(join(directory, "production.sqlite"), {
    readOnly: true,
  });
  try {
    const saved = db.prepare("SELECT data FROM agent_service_turn").all();
    assert.equal(saved.length, 1);
    const native = createNativeSavedMemory(
      pathToFileURL(join(directory, "production.sqlite.mastra.sqlite")).href,
    );
    const crypto = new MemoryPayloadCrypto("TEST-memory-crash-secret");
    const items: (Record<string, import("node:sqlite").SQLOutputValue> & {
      content: string | null;
    })[] = [];
    try {
      for (const row of db
        .prepare(
          "SELECT * FROM agent_memory WHERE publication IN ('published','erased') ORDER BY created_at,id",
        )
        .all()) {
        const content =
          row.status === "deleted"
            ? null
            : crypto.open(
                (await native.read(
                  String(row.native_ref),
                  String(row.native_resource),
                ))!,
                {
                  id: String(row.id),
                  organizationId: String(row.organization_id),
                  workspaceId: String(row.workspace_id),
                  userId: String(row.user_id),
                  scope: row.scope as "private" | "workspace",
                  threadId: String(row.native_ref),
                  resourceId: String(row.native_resource),
                  createdAt: String(row.created_at),
                  expiresAt: String(row.expires_at),
                },
              ).content;
        items.push({ ...row, content });
      }
    } finally {
      await native.close();
    }
    return {
      state: DomainCommandSchema.parse(JSON.parse(String(saved[0]!.data))),
      items,
      version: Number(
        db.prepare("SELECT version FROM agent_memory_version").get()!.version,
      ),
      requests: db
        .prepare("SELECT kind,memory_id FROM agent_memory_request")
        .all(),
      calls: db
        .prepare("SELECT * FROM production_memory_call ORDER BY id")
        .all(),
      models: db
        .prepare("SELECT * FROM production_model_call ORDER BY id")
        .all(),
    };
  } finally {
    db.close();
  }
}

for (const stage of ["before", "after"] as const) {
  test(`Niaro memory correction survives SIGKILL ${stage} its atomic domain checkpoint without resampling the native call`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), `niaro-memory-${stage}-`));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const crashed = await runWorker(directory, `memory-${stage}`);
    assert.equal(crashed.signal, "SIGKILL", crashed.stdout + crashed.stderr);
    const prior = await readProductionMemory(directory);
    const originalCallId = String(prior.calls[0]!.call_id);
    assert.equal(prior.calls.length, 1);
    assert.equal(prior.models.length, 2);
    assert.equal(prior.version, stage === "before" ? 1 : 2);
    assert.equal(prior.items.length, stage === "before" ? 1 : 2);
    assert.equal(prior.state.memoryReceipts.length, stage === "before" ? 0 : 1);
    if (stage === "before") {
      assert.equal(prior.items[0]!.content, previousPreference);
      assert.equal(prior.items[0]!.status, "active");
    } else {
      assert.equal(prior.state.memoryReceipts[0]!.toolCallId, originalCallId);
      assert.equal(prior.state.memoryVersion, 2);
      // The thread keeps a pin of the saved items it used; the corrected
      // item is the person's own change, so nothing remains pinned.
      assert.deepEqual(prior.state.memoryMetadata, { items: [] });
      assert.equal(prior.state.memoryChanged, true);
      assert.deepEqual(prior.state.memoryReads, []);
    }

    const recovered = await runWorker(directory, "memory-recover");
    assert.equal(recovered.code, 0, recovered.stdout + recovered.stderr);
    assert.doesNotMatch(recovered.stderr, /CLIENT_CLOSED|unsettled top-level/);
    const output = JSON.parse(recovered.stdout) as {
      answer: { reply: string };
      runId: string;
      threadId: string;
      nativeCalls: {
        toolName: string;
        toolCallId: string;
        state: string;
        args: unknown;
      }[];
    };
    assert.equal(output.answer.reply, "TEST corrected preference saved");
    assert.equal(output.runId, prior.state.runId);
    assert.equal(output.threadId, prior.state.threadId);
    const actual = await readProductionMemory(directory);
    assert.equal(actual.version, 2, "replay cannot bump memory a second time");
    assert.equal(actual.items.length, 2, "there is exactly one replacement");
    const active = actual.items.filter((item) => item.status === "active");
    const superseded = actual.items.filter(
      (item) => item.status === "superseded",
    );
    assert.equal(active.length, 1);
    assert.equal(superseded.length, 1);
    assert.equal(active[0]!.content, correctedPreference);
    assert.equal(superseded[0]!.content, previousPreference);
    assert.equal(active[0]!.supersedes_id, superseded[0]!.id);
    assert.equal(active[0]!.lineage_id, superseded[0]!.lineage_id);
    assert.equal(
      actual.requests.filter((row) => row.kind === "revise").length,
      1,
    );
    assert.equal(actual.state.memoryReceipts.length, 1);
    assert.equal(actual.state.memoryReceipts[0]!.toolCallId, originalCallId);
    assert.equal(actual.state.memoryReceipts[0]!.result.id, active[0]!.id);
    assert.deepEqual(
      actual.calls.map((row) => row.call_id),
      [originalCallId, originalCallId],
    );
    const calls = output.nativeCalls.filter(
      (call) => call.toolName === "memory_revise",
    );
    assert.equal(calls.length, 1, "native memory has one paired mutation call");
    assert.equal(calls[0]!.toolCallId, originalCallId);
    assert.equal(calls[0]!.state, "result");
    assert.deepEqual(
      calls[0]!.args,
      {},
      "native transcript redacts private input",
    );
    assert.equal(actual.models.length, 3);
    assert.equal(
      actual.models[2]!.has_receipt,
      1,
      "the recovered model sees the committed mutation receipt before any new call",
    );
  });
}
