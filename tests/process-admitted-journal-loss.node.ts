import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { commandTarget } from "../packages/client-core/session";
import {
  PROCESS_EXECUTION_UNVERIFIED,
  processPendingRecoveryError,
} from "../packages/client-core/process-command-notice";
import { translate } from "../packages/i18n";
import { ProcessRuntimeResponseSchema } from "../packages/protocol/process-coordinator";
import type { StoppedCopyProof } from "./helpers/process-design-http";
import {
  assertProofCopy,
  immutableProofRead,
  proofApprovalFixture,
  proofManifest,
  proofNativePath,
  type ProofApprovalFixture,
} from "./helpers/process-restore-proof-matrix";

function quoted(name: string) {
  assert.match(name, /^[a-zA-Z_][a-zA-Z0-9_]*$/);
  return `"${name}"`;
}

function databaseRows(db: DatabaseSync) {
  return Object.fromEntries(
    db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map(({ name }) => [
        String(name),
        db.prepare(`SELECT * FROM ${quoted(String(name))}`).all(),
      ]),
  );
}

function executionRows(db: DatabaseSync) {
  return Object.fromEntries(
    Object.entries(databaseRows(db)).filter(([name]) =>
      /^agent_(?:service_|process_|inference_|memory(?:_|$))/.test(name),
    ),
  );
}

function nativeRows(root: string) {
  // An active native owner may have committed WAL frames. A normal read-only
  // transaction includes them; immutable main-only inspection would not.
  const db = new DatabaseSync(join(root, proofNativePath), { readOnly: true });
  try {
    db.exec("BEGIN");
    assert.deepEqual(
      db
        .prepare("PRAGMA integrity_check")
        .all()
        .map((row) => row.integrity_check),
      ["ok"],
    );
    return databaseRows(db);
  } finally {
    db.exec("ROLLBACK");
    db.close();
  }
}

function parentReferences(db: DatabaseSync, parentId: string) {
  return Object.keys(databaseRows(db)).flatMap((table) =>
    db
      .prepare(`PRAGMA foreign_key_list(${quoted(table)})`)
      .all()
      .filter((fk) => fk.table === "agent_service_turn")
      .map((fk) => {
        assert.equal(fk.to, "id");
        const rows = db
          .prepare(
            `SELECT rowid AS proof_rowid,* FROM ${quoted(table)} WHERE ${quoted(String(fk.from))}=? ORDER BY rowid`,
          )
          .all(parentId);
        return { table, fk, rows };
      }),
  );
}

function pendingEnvelope(cache: Map<string, string>) {
  const saved = [...cache].find(([key]) =>
    key.startsWith("agent-client.command.v2:"),
  );
  assert(saved, "TEST approval must have its real Session outbox");
  return { key: saved[0], bytes: saved[1], value: JSON.parse(saved[1]) };
}

function assertUnknown(
  f: ProofApprovalFixture,
  expectedOutbox: string,
  explanation: typeof PROCESS_EXECUTION_UNVERIFIED | null = null,
) {
  const state = f.state();
  assert.equal(state.status, "online");
  assert.deepEqual(state.pending, f.approvalCommand);
  assert.deepEqual(state.processPending, {
    command: f.approvalCommand,
    target: f.approvalTarget,
    outcome: "unknown",
    error: explanation,
  });
  assert.equal(
    state.commandStates[commandTarget(f.approvalCommand)],
    "network_error",
  );
  assert.equal(state.processNotice, null);
  assert.equal(JSON.parse(expectedOutbox).serializedCommand, f.approvalBytes);
}

test("precise loss of the original admitted parent journal blocks both public commands across original forks and two owner/Session reopens", async (t) => {
  const f = await proofApprovalFixture();
  try {
    const baseline = f.noWorkState();
    f.outageBeforeApproval();
    await f.sendApproval();
    assert.equal(f.sessionPosts.length, 1);
    assert.deepEqual(f.sessionPosts[0], {
      bytes: f.approvalBytes,
      forwarded: false,
    });
    f.assertNoWork(baseline);
    f.assertWaiting();
    const originalCache = await f.captureCache();
    const originalCacheBytes = [...originalCache];
    const cachedWaiting = f.cacheWork(originalCache);
    assert.equal(cachedWaiting.status, "waiting_approval");
    const outbox = pendingEnvelope(originalCache);
    assert.equal(outbox.value.serializedCommand, f.approvalBytes);
    assert.deepEqual(outbox.value.command, f.approvalCommand);
    assert.deepEqual(outbox.value.target, f.approvalTarget);
    assert.equal(outbox.value.outcome, "unknown");
    assert.equal(outbox.value.error, null);
    assert.equal(outbox.value.notice, undefined);
    assertUnknown(f, outbox.bytes);
    assert.equal(f.state().error, "network_error");
    f.stopSession();

    let originalProof: StoppedCopyProof | undefined;
    let originalManifest: ReturnType<typeof proofManifest> | undefined;
    let originalExecution: ReturnType<typeof executionRows> | undefined;
    let originalCheckpoint: ReturnType<typeof f.checkpoint> | undefined;
    let originalNative: ReturnType<typeof nativeRows> | undefined;
    const destinations = new Set<string>();
    const inject = (proof: StoppedCopyProof) => {
      const beforeManifest = assertProofCopy(proof);
      if (!originalProof) {
        originalProof = proof;
        originalManifest = beforeManifest;
        originalCheckpoint = f.checkpoint(proof.source);
        assert.equal(originalCheckpoint.parsed.status, "suspended");
        originalNative = immutableProofRead(
          join(proof.source, proofNativePath),
          databaseRows,
        );
      } else {
        assert.equal(proof.source, originalProof.source);
        assert.deepEqual(beforeManifest, originalManifest);
      }
      assert(!destinations.has(proof.destination));
      destinations.add(proof.destination);
      const db = new DatabaseSync(
        join(proof.destination, "identity/identity.sqlite"),
      );
      let references: ReturnType<typeof parentReferences>;
      let orphans: ReturnType<ReturnType<DatabaseSync["prepare"]>["all"]>;
      try {
        db.exec("PRAGMA foreign_keys=ON");
        assert.equal(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
        assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
        assert.deepEqual(f.rows(db), f.original);
        const before = databaseRows(db);
        originalExecution ??= executionRows(db);
        assert.deepEqual(executionRows(db), originalExecution);
        references = parentReferences(db, f.parentId);
        assert.deepEqual(references.map((ref) => ref.table).sort(), [
          "agent_service_conversation_cursor",
          "agent_service_task_selection",
          "agent_service_turn_cursor",
          "agent_service_turn_operation",
        ]);
        const conversationCursor = references.find(
          (ref) => ref.table === "agent_service_conversation_cursor",
        )!;
        assert.deepEqual(
          conversationCursor.rows,
          [],
          "TEST admitted process parent must not own a native conversation-thread cursor",
        );
        assert(
          references.some((ref) => ref.rows.length > 0),
          "TEST must preserve actual action-boundary parent links",
        );
        // Fault injection only, on the verified private stopped destination.
        // Keep the orphaned action-boundary links; they are part of this loss.
        db.exec("PRAGMA foreign_keys=OFF");
        assert.equal(
          db
            .prepare("DELETE FROM agent_service_turn WHERE id=?")
            .run(f.parentId).changes,
          1,
        );
        db.exec("PRAGMA foreign_keys=ON");
        assert.equal(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
        const expected = {
          ...before,
          agent_service_turn: before.agent_service_turn!.filter(
            (row) => row.id !== f.parentId,
          ),
        };
        assert.deepEqual(
          databaseRows(db),
          expected,
          "TEST injection deletes exactly one original journal and preserves every other row",
        );
        assert.deepEqual(parentReferences(db, f.parentId), references);
        orphans = db.prepare("PRAGMA foreign_key_check").all();
        const expectedOrphans = references.flatMap((ref) =>
          ref.rows.map((row) => ({
            table: ref.table,
            rowid: row.proof_rowid!,
            parent: "agent_service_turn",
            fkid: ref.fk.id!,
          })),
        );
        const sorted = (rows: typeof orphans) =>
          rows
            .map((row) => ({ ...row }))
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        assert.deepEqual(sorted(orphans), sorted(expectedOrphans));
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
      const afterManifest = proofManifest(proof.destination);
      assert.notEqual(
        afterManifest.hashes["identity/identity.sqlite"],
        beforeManifest.hashes["identity/identity.sqlite"],
      );
      assert.deepEqual(afterManifest, {
        hashes: {
          ...beforeManifest.hashes,
          "identity/identity.sqlite":
            afterManifest.hashes["identity/identity.sqlite"]!,
        },
        modes: beforeManifest.modes,
      });
      assert.deepEqual(
        f.checkpoint(proof.destination).row,
        originalCheckpoint!.row,
      );
      assert.deepEqual(nativeRows(proof.destination), originalNative);
      t.diagnostic(
        JSON.stringify({
          phase: "precise stopped injection",
          references: references!.map((ref) => ({
            table: ref.table,
            rows: ref.rows.length,
          })),
          orphans: orphans!,
        }),
      );
    };

    for (const first of ["start", "approval"] as const) {
      await t.test(
        `${first}-first exact original commands fail closed without recreating proof`,
        async () => {
          const proof = await f.h.restoreCopy(inject, originalProof);
          f.useCache(originalCache);
          const missingRows = { ...f.original, journal: undefined };
          const noWork = {
            ...baseline,
            counts: {
              ...baseline.counts,
              agent_service_turn: baseline.counts.agent_service_turn! - 1,
            },
          };
          const expectedExecution = immutableProofRead(
            join(proof.destination, "identity/identity.sqlite"),
            executionRows,
          );
          let explanation: typeof PROCESS_EXECUTION_UNVERIFIED | null = null;
          const preserved = async () => {
            f.assertNoWork(noWork);
            assert.deepEqual(f.rows(), missingRows);
            assert.deepEqual(
              executionRows(f.h.identity["db"]),
              expectedExecution,
            );
            assert.deepEqual(nativeRows(proof.destination), originalNative);
            assert.deepEqual(
              proofManifest(originalProof!.source),
              originalManifest,
            );
            assert.deepEqual(
              f.checkpoint(originalProof!.source).row,
              originalCheckpoint!.row,
            );
            assert.deepEqual(
              immutableProofRead(
                join(originalProof!.source, "identity/identity.sqlite"),
                f.rows,
              ),
              f.original,
            );
            assert.deepEqual([...originalCache], originalCacheBytes);
            assert.equal(
              pendingEnvelope(await f.captureCache()).bytes,
              JSON.stringify({ ...outbox.value, error: explanation }),
            );
          };
          await f.reopen();
          assertUnknown(f, outbox.bytes);
          await preserved();
          // The cache is historical. A fresh snapshot has no authoritative root.
          assert.equal(f.state().store!.workItems[f.parentId], undefined);
          assert.equal(f.cacheWork(originalCache).status, "waiting_approval");
          const rejectStart = async () => {
            const result = await f.postBytes(f.startBytes);
            assert.equal(result.status, 409, JSON.stringify(result.data));
            assert.equal(
              f.h.record(result.data).error,
              "process_start_conflict",
            );
            assert.deepEqual(await f.postBytes(f.startBytes), result);
            await preserved();
          };
          const rejectApproval = async () => {
            const index = f.sessionPosts.length;
            await f.retryApproval();
            const post = f.sessionPosts[index];
            assert(post);
            assert.equal(post.bytes, f.approvalBytes);
            assert.equal(post.forwarded, true);
            assert.equal(post.status, 409, JSON.stringify(post.data));
            assert.equal(f.h.record(post.data).error, "process_start_conflict");
            explanation = PROCESS_EXECUTION_UNVERIFIED;
            assertUnknown(f, outbox.bytes, explanation);
            assert.equal(f.state().error, "network_error");
            assert.equal(
              processPendingRecoveryError(
                f.state().processPending,
                f.state().error,
              ),
              "savedProcessExecutionUnverified",
            );
            await f.retryApproval();
            assert.deepEqual(f.sessionPosts[index + 1], post);
            await preserved();
          };
          if (first === "start") {
            await rejectStart();
            await rejectApproval();
          } else {
            await rejectApproval();
            await rejectStart();
          }
          t.diagnostic(
            JSON.stringify({
              branch: first,
              publicStatus: 409,
              publicError: "process_start_conflict",
              liveSessionError: f.state().error,
              outcome: f.state().processPending!.outcome,
              authoritativeParentPresent: false,
              copy: {
                en: translate("en")("savedProcessExecutionUnverified"),
                cs: translate("cs")("savedProcessExecutionUnverified"),
                liveEn: translate("en")("network_error"),
                liveCs: translate("cs")("network_error"),
              },
            }),
          );
          for (let reopen = 1; reopen <= 2; reopen++) {
            f.stopSession();
            await f.h.restart();
            await f.reopen();
            assertUnknown(f, outbox.bytes, explanation);
            assert.equal(f.state().error, null);
            assert.equal(
              processPendingRecoveryError(
                f.state().processPending,
                f.state().error,
              ),
              "savedProcessExecutionUnverified",
            );
            assert.equal(f.state().store!.workItems[f.parentId], undefined);
            await preserved();
            await rejectStart();
            await rejectApproval();
            await f.refresh();
            await preserved();
          }
          f.stopSession();
        },
      );
    }

    await t.test(
      "intact original-source control completes one original write then replay and two reopens perform no extra work",
      async () => {
        assert(originalProof);
        const proof = await f.h.restoreCopy((copy) => {
          assert.deepEqual(assertProofCopy(copy), originalManifest);
          assert.equal(copy.source, originalProof!.source);
          assert(!destinations.has(copy.destination));
          destinations.add(copy.destination);
          assert.deepEqual(
            f.checkpoint(copy.destination).row,
            originalCheckpoint!.row,
          );
        }, originalProof);
        f.useCache(originalCache);
        await f.reopen();
        f.assertNoWork(baseline);
        f.assertWaiting();
        assert.deepEqual(f.rows(), f.original);
        const index = f.sessionPosts.length;
        await f.retryApproval();
        const completed = f.sessionPosts[index]!;
        assert.equal(completed.bytes, f.approvalBytes);
        assert.equal(completed.status, 202, JSON.stringify(completed.data));
        const result = ProcessRuntimeResponseSchema.parse(completed.data);
        assert.deepEqual(result.scope, f.credential.scope);
        assert.deepEqual(result.admission, f.startResult.admission);
        assert.equal(result.process?.status, "succeeded");
        assert.deepEqual(result.process?.output, { result: "TEST-result" });
        assert.equal(f.state().pending, null);
        assert.equal(f.state().processPending, null);
        await f.refresh();
        assert.equal(f.work().status, "succeeded");
        assert.deepEqual(f.work().native!.process!.provenance, f.pin);
        assert.deepEqual(f.dispatches, ["POST"]);
        assert.equal(f.h.modelCount(), baseline.models + 1);
        assert.equal(f.h.businessCount(), baseline.business);
        assert.deepEqual(f.counts(), {
          ...baseline.counts,
          agent_process_resolve_command:
            baseline.counts.agent_process_resolve_command! + 1,
          agent_inference_attempt: baseline.counts.agent_inference_attempt! + 1,
        });
        const finished = f.rows();
        assert.equal(
          JSON.parse(String(finished.receipt!.data)).status,
          "succeeded",
        );
        assert.deepEqual(JSON.parse(String(finished.receipt!.data)).result, {
          value: "TEST-result",
        });
        const after = f.noWorkState();
        const replay = async () => {
          assert.deepEqual(await f.postBytes(f.approvalBytes), {
            status: completed.status,
            data: completed.data,
          });
          assert.equal((await f.postBytes(f.startBytes)).status, 202);
          await f.retryApproval();
          await f.refresh();
          f.assertNoWork(after);
          assert.deepEqual(f.rows(), finished);
          assert.deepEqual(
            proofManifest(originalProof!.source),
            originalManifest,
          );
        };
        await replay();
        for (let reopen = 1; reopen <= 2; reopen++) {
          f.stopSession();
          await f.h.restart();
          await f.reopen();
          f.assertNoWork(after);
          assert.equal(f.work().status, "succeeded");
          await replay();
        }
        assert.equal(destinations.size, 3);
        assert.notEqual(proof.destination, originalProof.source);
        t.diagnostic(
          JSON.stringify({
            branch: "intact",
            dispatches: f.dispatches,
            additionalModels: f.h.modelCount() - baseline.models,
            canonicalInvocation: "succeeded",
            repeatEffects: 0,
            reopens: 2,
          }),
        );
      },
    );
  } finally {
    await f.close();
  }
});
