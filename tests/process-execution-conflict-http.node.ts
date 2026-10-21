import assert from "node:assert/strict";
import { test } from "node:test";
import { JournalSchema } from "../apps/server-identity/service-process-journal";
import {
  PROCESS_EXECUTION_UNVERIFIED,
  processPendingRecoveryError,
} from "../packages/client-core/process-command-notice";
import { ProcessRuntimeResponseSchema } from "../packages/protocol/process-coordinator";
import {
  assertProofCopy,
  proofApprovalFixture,
  proofManifest,
} from "./helpers/process-restore-proof-matrix";

test("a present conflicting journal gets only general unverified-details copy; repairing original proof permits the exact saved decision once", async () => {
  const f = await proofApprovalFixture();
  try {
    const baseline = f.noWorkState();
    f.outageBeforeApproval();
    await f.sendApproval();
    const originalCache = await f.captureCache();
    const entry = [...originalCache].find(([key]) =>
      key.startsWith("agent-client.command.v2:"),
    )!;
    const originalEnvelope = JSON.parse(entry[1]);
    assert.equal(originalEnvelope.error, null);
    f.stopSession();
    const proof = await f.h.restoreCopy((copy) => {
      assertProofCopy(copy);
    });
    const source = proofManifest(proof.source);
    f.useCache(originalCache);
    await f.reopen();
    // A present conflicting journal also prevents fresh snapshot recovery.
    // Establish a real online owner first, then fault this isolated TEST store
    // under its identity queue; the request must recheck its exact proof.
    await f.h.identity["serial"](async () => {
      const db = f.h.identity["db"];
      const row = db
        .prepare("SELECT data FROM agent_service_turn WHERE id=?")
        .get(f.parentId)!;
      const journal = JournalSchema.parse(JSON.parse(String(row.data)));
      assert.equal(journal.status, "waiting");
      assert.notEqual(journal.inputDigest, "f".repeat(64));
      db.prepare("UPDATE agent_service_turn SET data=? WHERE id=?").run(
        JSON.stringify({ ...journal, inputDigest: "f".repeat(64) }),
        f.parentId,
      );
      assert(
        db
          .prepare("SELECT 1 FROM agent_service_turn WHERE id=?")
          .get(f.parentId),
      );
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    });
    const conflictingRows = f.rows();
    assert(
      conflictingRows.journal,
      "TEST this branch retains its admitted parent journal",
    );
    const before = f.noWorkState();
    const originalStart = await f.postBytes(f.startBytes);
    assert.equal(originalStart.status, 409);
    assert.deepEqual(originalStart.data, { error: "process_start_conflict" });
    const index = f.sessionPosts.length;
    await f.retryApproval();
    assert.equal(f.sessionPosts[index]!.bytes, f.approvalBytes);
    assert.equal(f.sessionPosts[index]!.status, 409);
    assert.deepEqual(f.sessionPosts[index]!.data, {
      error: "process_start_conflict",
    });
    assert.deepEqual(f.state().processPending, {
      command: f.approvalCommand,
      target: f.approvalTarget,
      outcome: "unknown",
      error: PROCESS_EXECUTION_UNVERIFIED,
    });
    assert.equal(
      processPendingRecoveryError(f.state().processPending, f.state().error),
      "savedProcessExecutionUnverified",
    );
    const explainedCache = await f.captureCache();
    assert.equal(
      explainedCache.get(entry[0]),
      JSON.stringify({
        ...originalEnvelope,
        error: PROCESS_EXECUTION_UNVERIFIED,
      }),
    );
    f.assertNoWork(before);
    assert.deepEqual(f.rows(), conflictingRows);
    assert.deepEqual(conflictingRows.receipt, f.original.receipt);
    assert.deepEqual(proofManifest(proof.source), source);

    f.stopSession();
    await f.h.restoreCopy((copy) => {
      assertProofCopy(copy);
      assert.equal(copy.source, proof.source);
    }, proof);
    f.useCache(explainedCache);
    await f.reopen();
    f.assertNoWork(baseline);
    assert.equal(f.state().processPending?.error, PROCESS_EXECUTION_UNVERIFIED);
    const repaired = f.sessionPosts.length;
    await f.retryApproval();
    assert.equal(f.sessionPosts[repaired]!.bytes, f.approvalBytes);
    assert.equal(f.sessionPosts[repaired]!.status, 202);
    const result = ProcessRuntimeResponseSchema.parse(
      f.sessionPosts[repaired]!.data,
    );
    assert.deepEqual(result.admission, f.startResult.admission);
    assert.equal(result.process?.status, "succeeded");
    assert.deepEqual(f.dispatches, ["POST"]);
    assert.equal(f.state().pending, null);
    const done = f.noWorkState();
    await f.retryApproval();
    assert.deepEqual((await f.postBytes(f.approvalBytes)).data, result);
    f.assertNoWork(done);
    assert.deepEqual(f.dispatches, ["POST"]);
    assert.deepEqual(proofManifest(proof.source), source);
  } finally {
    f.stopSession();
    await f.h.close();
  }
});
