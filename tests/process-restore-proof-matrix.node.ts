import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ProcessRuntimeResponseSchema } from "../packages/protocol/process-coordinator";
import { activationHttpPath } from "./helpers/process-activation-http";
import {
  assertProofCopy,
  copyProofTuple,
  immutableProofRead,
  proofApprovalFixture,
  proofManifest,
  proofNativePath,
  type ProofApprovalFixture,
} from "./helpers/process-restore-proof-matrix";

async function completeOriginalFork(f: ProofApprovalFixture) {
  const before = f.noWorkState();
  f.assertWaiting();
  assert.deepEqual(f.rows(), f.original);
  assert.equal(JSON.stringify(f.approvalCommand), f.approvalBytes);
  const completed = await f.postBytes(f.approvalBytes);
  assert.equal(completed.status, 202, JSON.stringify(completed.data));
  const result = ProcessRuntimeResponseSchema.parse(completed.data);
  assert.deepEqual(result.scope, f.credential.scope);
  assert.deepEqual(result.admission, f.startResult.admission);
  assert.equal(result.process?.status, "succeeded");
  assert.deepEqual(result.process?.output, { result: "TEST-result" });
  await f.refresh();
  assert.equal(f.work().status, "succeeded");
  assert.deepEqual(f.work().native!.process!.provenance, f.pin);
  const receipt = f.h.identity["catalog"].store.invocation(
    f.approval.result.operationId,
    f.credential.scope.workspaceId,
    f.credential.scope.userId,
  )!;
  assert.equal(receipt.id, f.approval.result.operationId);
  assert.equal(receipt.status, "succeeded");
  assert.equal(receipt.organizationId, f.h.target.organizationId);
  assert.equal(receipt.workspaceId, f.credential.scope.workspaceId);
  assert.equal(receipt.userId, f.credential.scope.userId);
  assert.deepEqual(receipt.input, { name: "TEST-input" });
  assert.deepEqual(receipt.result, { value: "TEST-result" });
  assert.deepEqual(f.dispatches, ["POST"]);
  assert.equal(f.h.businessCount(), before.business);
  assert.equal(f.h.modelCount(), before.models + 1);
  assert.deepEqual(f.counts(), {
    ...before.counts,
    agent_process_resolve_command:
      before.counts.agent_process_resolve_command! + 1,
    agent_inference_attempt: before.counts.agent_inference_attempt! + 1,
  });
  const finished = f.rows();
  const after = f.noWorkState();
  assert.deepEqual(await f.postBytes(f.approvalBytes), completed);
  await f.refresh();
  f.assertNoWork(after);
  assert.deepEqual(f.rows(), finished);
  f.stopSession();
  await f.h.restart();
  await f.reopen();
  f.assertNoWork(after);
  assert.deepEqual(f.rows(), finished);
  assert.equal(f.work().status, "succeeded");
  assert.deepEqual(f.work().native!.process!.provenance, f.pin);
  assert.deepEqual(await f.postBytes(f.approvalBytes), completed);
  await f.refresh();
  f.assertNoWork(after);
  assert.deepEqual(f.rows(), finished);
}

test("loss of a copied completed native job and its actual FK admission cascade blocks paired execution while the exact whole E fork resumes the original approval", async () => {
  const f = await proofApprovalFixture();
  try {
    const baseline = f.noWorkState();
    const earlyCache = await f.captureCache();
    assert.equal(f.cacheWork(earlyCache).status, "waiting_approval");
    f.stopSession();
    let earlyManifest: ReturnType<typeof proofManifest> | undefined;
    const early = await f.h.restoreCopy((proof) => {
      earlyManifest = assertProofCopy(proof);
      const before = proofManifest(proof.destination);
      const db = new DatabaseSync(
        join(proof.destination, "identity/identity.sqlite"),
      );
      try {
        db.exec("PRAGMA foreign_keys=ON");
        assert.deepEqual(f.rows(db), f.original);
        assert.equal(
          db
            .prepare("DELETE FROM agent_process_contract_test WHERE test_id=?")
            .run(f.job.testId).changes,
          1,
        );
        assert.deepEqual(f.rows(db), {
          ...f.original,
          nativeJob: undefined,
          nativeAdmission: undefined,
        });
        assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
        assert.deepEqual(
          db
            .prepare("PRAGMA integrity_check")
            .all()
            .map((row) => row.integrity_check),
          ["ok"],
        );
      } finally {
        db.close();
      }
      const after = proofManifest(proof.destination);
      assert.notEqual(
        after.hashes["identity/identity.sqlite"],
        before.hashes["identity/identity.sqlite"],
      );
      assert.deepEqual(after, {
        hashes: {
          ...before.hashes,
          "identity/identity.sqlite": after.hashes["identity/identity.sqlite"]!,
        },
        modes: before.modes,
      });
    });
    assert(earlyManifest);
    assert.equal(f.checkpoint(early.source).parsed.status, "suspended");
    const missing = {
      ...f.original,
      nativeJob: undefined,
      nativeAdmission: undefined,
    };
    const noWork = {
      ...baseline,
      counts: {
        ...baseline.counts,
        agent_process_contract_test:
          baseline.counts.agent_process_contract_test! - 1,
        agent_process_native_test_admission:
          baseline.counts.agent_process_native_test_admission! - 1,
      },
    };
    const assertMissing = () => {
      f.assertNoWork(noWork);
      f.assertWaiting();
      assert.deepEqual(f.rows(), missing);
      assert.deepEqual(proofManifest(early.source), earlyManifest);
    };
    await f.reopen();
    assertMissing();
    const blocked = (await f.inventory()).processes.find(
      (item) => item.processId === f.input.processId,
    )!;
    assert.equal(blocked.availability, "blocked");
    if (blocked.availability === "blocked")
      assert.equal(blocked.reason, "qualification_required");
    const form = await f.form();
    assert.equal(form.status, 409, JSON.stringify(form.data));
    assert.equal(f.h.record(form.data).error, "process_execution_unavailable");
    for (const bytes of [f.preparedBytes, f.approvalBytes, f.denialBytes]) {
      const rejected = await f.postBytes(bytes);
      assert.equal(rejected.status, 404, JSON.stringify(rejected.data));
      assert.equal(f.h.record(rejected.data).error, "process_test_not_found");
      assert.deepEqual(await f.postBytes(bytes), rejected);
      assertMissing();
    }
    assert.deepEqual(await f.postBytes(f.startBytes), f.started);
    const activation = await f.h.request(
      "owner",
      activationHttpPath,
      f.activationCommand,
    );
    assert.equal(activation.status, 200);
    assert.deepEqual(f.h.receipt(activation.data), f.activationReceipt);
    await f.refresh();
    assertMissing();
    f.stopSession();
    await f.h.restart();
    await f.reopen();
    assertMissing();
    assert.deepEqual(await f.postBytes(f.startBytes), f.started);
    const refusedAgain = await f.postBytes(f.approvalBytes);
    assert.equal(refusedAgain.status, 404);
    assert.equal(f.h.record(refusedAgain.data).error, "process_test_not_found");
    await f.refresh();
    assertMissing();
    assert.deepEqual(
      immutableProofRead(
        join(early.source, "identity/identity.sqlite"),
        f.rows,
      ),
      f.original,
    );
    assert.deepEqual(proofManifest(early.source), earlyManifest);
    // Never POST the native request after its journal was removed. Recovery is
    // a separate complete original E copy, with the original E client cache.
    f.stopSession();
    const fork = await f.h.restoreCopy((proof) => {
      assertProofCopy(proof);
      copyProofTuple(early.source, proof.destination);
      assert.deepEqual(proofManifest(proof.destination), earlyManifest);
    });
    assert.notEqual(fork.destination, early.destination);
    f.useCache(earlyCache);
    await f.reopen();
    f.assertNoWork(baseline);
    f.assertWaiting();
    assert.deepEqual(f.rows(), f.original);
    await completeOriginalFork(f);
    assert.deepEqual(proofManifest(early.source), earlyManifest);
    assert.deepEqual(
      immutableProofRead(
        join(early.source, "identity/identity.sqlite"),
        f.rows,
      ),
      f.original,
    );
  } finally {
    await f.close();
  }
});

test("same-server-ID E domain with genuinely denied L native checkpoints refuses the original paired approval and a separate exact whole E fork performs one controlled write", async () => {
  const f = await proofApprovalFixture();
  try {
    const baseline = f.noWorkState();
    const earlyCache = await f.captureCache();
    const earlyCacheBytes = [...earlyCache];
    assert.equal(f.cacheWork(earlyCache).status, "waiting_approval");
    f.stopSession();
    let capturedEarlyManifest: ReturnType<typeof proofManifest> | undefined;
    const early = await f.h.restoreCopy((proof) => {
      capturedEarlyManifest = assertProofCopy(proof);
    });
    assert(capturedEarlyManifest);
    const earlyManifest = capturedEarlyManifest;
    const earlyCheckpoint = f.checkpoint(early.source);
    assert.equal(earlyCheckpoint.parsed.status, "suspended");
    await f.reopen();
    f.assertNoWork(baseline);
    f.assertWaiting();
    assert.deepEqual(f.rows(), f.original);
    assert.equal(JSON.stringify(f.denialCommand), f.denialBytes);
    const denied = await f.postBytes(f.denialBytes);
    assert.equal(denied.status, 202, JSON.stringify(denied.data));
    const deniedResult = ProcessRuntimeResponseSchema.parse(denied.data);
    assert.deepEqual(deniedResult.scope, f.credential.scope);
    assert.deepEqual(deniedResult.admission, f.startResult.admission);
    assert.equal(deniedResult.process?.status, "cancelled");
    await f.refresh();
    assert.equal(f.work().status, "cancelled");
    assert.deepEqual(f.work().native!.process!.provenance, f.pin);
    assert.equal(f.h.modelCount(), baseline.models);
    assert.equal(f.h.businessCount(), baseline.business);
    assert.deepEqual(f.dispatches, []);
    const deniedRows = f.rows();
    assert.equal(
      JSON.parse(String(deniedRows.receipt!.data)).status,
      "rejected",
    );
    assert.equal(deniedRows.resolves.length, 1);
    assert.deepEqual(f.counts(), {
      ...baseline.counts,
      agent_process_resolve_command:
        baseline.counts.agent_process_resolve_command! + 1,
    });
    const laterCache = await f.captureCache();
    const laterCacheBytes = [...laterCache];
    assert.equal(f.cacheWork(laterCache).status, "cancelled");
    f.stopSession();
    let laterManifest: ReturnType<typeof proofManifest> | undefined;
    const later = await f.h.restoreCopy((proof) => {
      laterManifest = assertProofCopy(proof);
      assert.equal(f.checkpoint(proof.source).parsed.status, "failed");
      assert.deepEqual(
        immutableProofRead(
          join(proof.source, "identity/identity.sqlite"),
          f.rows,
        ),
        deniedRows,
      );
      assert.equal(
        readFileSync(
          join(proof.destination, "workflow/auth/server-id"),
          "utf8",
        ),
        f.credential.scope.serverId,
      );
      assert.equal(
        readFileSync(join(early.source, "workflow/auth/server-id"), "utf8"),
        f.credential.scope.serverId,
      );
      assert(!existsSync(join(proof.destination, proofNativePath + "-wal")));
      assert(!existsSync(join(proof.destination, proofNativePath + "-shm")));
      const nativeBytes = readFileSync(
        join(proof.destination, proofNativePath),
      );
      const nativeMode =
        lstatSync(join(proof.destination, proofNativePath)).mode & 0o777;
      assert.notEqual(
        proof.copyHashes[proofNativePath],
        early.sourceHashes[proofNativePath],
      );
      // Every nonnative byte is the real E snapshot. Only the complete genuine
      // denied L native database is substituted; no journal is manufactured.
      copyProofTuple(early.source, proof.destination);
      writeFileSync(join(proof.destination, proofNativePath), nativeBytes);
      chmodSync(join(proof.destination, proofNativePath), nativeMode);
      assert.deepEqual(proofManifest(proof.destination), {
        hashes: {
          ...earlyManifest.hashes,
          [proofNativePath]: proof.copyHashes[proofNativePath]!,
        },
        modes: { ...earlyManifest.modes, [proofNativePath]: nativeMode },
      });
      assert.deepEqual(
        f.checkpoint(proof.destination).row,
        f.checkpoint(proof.source).row,
      );
      assert.deepEqual(
        immutableProofRead(
          join(proof.destination, "identity/identity.sqlite"),
          f.rows,
        ),
        f.original,
      );
    });
    assert(laterManifest);
    const assertOriginals = () => {
      assert.deepEqual(proofManifest(early.source), earlyManifest);
      assert.deepEqual(proofManifest(later.source), laterManifest);
      assert.deepEqual(f.checkpoint(early.source).row, earlyCheckpoint.row);
      assert.deepEqual(
        immutableProofRead(
          join(early.source, "identity/identity.sqlite"),
          f.rows,
        ),
        f.original,
      );
      assert.deepEqual(
        immutableProofRead(
          join(later.source, "identity/identity.sqlite"),
          f.rows,
        ),
        deniedRows,
      );
      assert.deepEqual([...earlyCache], earlyCacheBytes);
      assert.deepEqual([...laterCache], laterCacheBytes);
      assert.equal(f.cacheWork(laterCache).status, "cancelled");
    };
    // The client which saw L retains cancellation. This is an independent E
    // Session/cache fork using the same original credential, not a promise to
    // roll back that client's known cancellation or any external effect.
    f.useCache(earlyCache);
    await f.reopen();
    f.assertNoWork(baseline);
    f.assertWaiting();
    assert.deepEqual(f.rows(), f.original);
    assertOriginals();
    const failed = await f.postBytes(f.approvalBytes);
    assert.equal(failed.status, 202, JSON.stringify(failed.data));
    const failure = ProcessRuntimeResponseSchema.parse(failed.data);
    assert.deepEqual(failure.scope, f.credential.scope);
    assert.deepEqual(failure.admission, f.startResult.admission);
    assert.equal(failure.process?.status, "failed");
    assert.equal(
      failure.process?.failure?.code,
      "process_checkpoint_interrupted",
    );
    assert.equal(failure.process?.approval, undefined);
    assert.equal(failure.process?.output, undefined);
    await f.refresh();
    const failedRows = f.rows();
    const noWork = {
      ...baseline,
      counts: {
        ...baseline.counts,
        agent_process_resolve_command:
          baseline.counts.agent_process_resolve_command! + 1,
      },
    };
    assert.equal(failedRows.resolves.length, 1);
    assert.deepEqual(failedRows, {
      ...f.original,
      journal: failedRows.journal,
      resolves: failedRows.resolves,
    });
    const assertFailed = () => {
      f.assertNoWork(noWork);
      assert.deepEqual(f.rows(), failedRows);
      assert.equal(f.work().status, "failed");
      assert.deepEqual(f.work().native!.process!.provenance, f.pin);
      assert.equal(f.work().native!.process!.approval, undefined);
      assert.match(f.work().context, /process_checkpoint_interrupted/);
      assert.match(f.work().result!, /process_checkpoint_interrupted/);
      const card = f.work().card;
      assert(card, "TEST checkpoint failure must have its public card");
      const reachable = new Set<string>();
      const visit = (id: string) => {
        if (reachable.has(id)) return;
        reachable.add(id);
        const node = card.nodes.find((item) => item.id === id);
        assert(node);
        if ("children" in node) node.children.forEach(visit);
      };
      card.root.forEach(visit);
      assert(
        card.nodes.some(
          (node) =>
            reachable.has(node.id) &&
            node.type === "notice" &&
            node.text.includes("process_checkpoint_interrupted"),
        ),
        "TEST checkpoint failure code must be visible in a reachable card notice",
      );
      assert.equal(
        JSON.parse(String(f.rows().receipt!.data)).status,
        "awaiting_approval",
      );
      assert.equal(
        JSON.parse(String(f.rows().receipt!.data)).result,
        undefined,
      );
      assertOriginals();
    };
    assertFailed();
    assert.deepEqual(await f.postBytes(f.approvalBytes), failed);
    await f.refresh();
    assertFailed();
    f.stopSession();
    await f.h.restart();
    await f.reopen();
    assertFailed();
    assert.deepEqual(await f.postBytes(f.approvalBytes), failed);
    await f.refresh();
    assertFailed();
    // Do not patch the mixed failed command or canonical receipt. Fork the
    // exact complete protected E snapshot into a different disposable target.
    f.stopSession();
    const fork = await f.h.restoreCopy((proof) => {
      assertProofCopy(proof);
      copyProofTuple(early.source, proof.destination);
      assert.deepEqual(proofManifest(proof.destination), earlyManifest);
    });
    assert.notEqual(fork.destination, early.destination);
    assert.notEqual(fork.destination, later.destination);
    f.useCache(earlyCache);
    await f.reopen();
    f.assertNoWork(baseline);
    f.assertWaiting();
    assert.deepEqual(f.rows(), f.original);
    assertOriginals();
    await completeOriginalFork(f);
    assertOriginals();
  } finally {
    await f.close();
  }
});
