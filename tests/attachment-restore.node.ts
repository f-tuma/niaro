import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { spawnSync, spawn } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { FixtureStorage } from "../apps/fixture-server/storage";
import { loadAttachmentConfiguration } from "../apps/server-attachments/schema";
import {
  verifyAttachmentRestore,
  restoreVerifyArguments,
} from "../apps/server-attachments/restore";
import { ATTACHMENT_PROFILE } from "../packages/protocol/attachments";
import type { Scope } from "../packages/protocol";
import type { ServerConfig } from "../apps/reference-server/config";
import { sha256 } from "../apps/server-storage/types";
import {
  attachmentOwnerLocks,
  RESTORE_MARKER,
  MANIFEST,
} from "../scripts/backup-common.mjs";
import { syntheticS3 } from "./helpers/storage-s3";
const scope: Scope = {
  connectionId: "fixture-a",
  serverId: "server",
  workspaceId: "a",
  userId: "alice",
};
const enabled = loadAttachmentConfiguration({
  NIARO_ATTACHMENTS_ENABLED: "true",
});
function profile(dataDirectory: string): ServerConfig {
  return {
    version: 1,
    name: "Restore fixture",
    listen: { host: "127.0.0.1", port: 8793 },
    dataDirectory,
    allowedOrigins: [],
    sessionSeconds: 1800,
    adapters: {
      model: { provider: "fixture" },
      voice: { provider: "disabled" },
      crm: { provider: "disabled" },
      calendar: { provider: "simulated" },
    },
  };
}
function command(script: string, args: string[], expected = 0) {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
  });
  assert.equal(r.status, expected, r.stderr);
  return r;
}
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "niaro-restore-")),
    source = join(dir, "source"),
    backup = join(dir, "backup"),
    target = join(dir, "target"),
    s3 = await syntheticS3();
  let storage: FixtureStorage | undefined = new FixtureStorage(
    source,
    "server",
    Date.now,
    undefined,
    undefined,
    enabled,
  );
  storage.initializeObjectStorage({ state: "configured", config: s3.config });
  async function upload(text: string, id: string) {
    const st = storage!,
      generation = st.snapshot(scope).conversations[0]!.attachmentGeneration!,
      draft = st.attachments.createDraft(scope, {
        profile: ATTACHMENT_PROFILE,
        requestId: randomUUID(),
        target: {
          conversationId: "conversation-1",
          expectedGeneration: generation,
          mode: "current",
        },
      }).draft;
    const bytes = Buffer.from(text),
      created = st.attachments.createUpload(scope, draft.draftId, {
        profile: ATTACHMENT_PROFILE,
        requestId: randomUUID(),
        expectedRevision: 1,
        filename: "source.txt",
        mediaType: "text/plain",
        size: bytes.length,
        sha256: sha256(bytes),
      }),
      c = st.attachments.beginReceive(scope, created.upload.contentId);
    st.attachments.markPutting(scope, c.id, c.token!);
    await st.attachments.objectStore().put(st.attachments.handle(c), bytes);
    st.attachments.finishTransfer(scope, c.id, c.token!);
    st.acceptAttachmentMessage(scope, {
      type: "message.send",
      commandId: id,
      idempotencyKey: id,
      conversationId: "conversation-1",
      language: "en",
      text: "",
      attachments: {
        profile: ATTACHMENT_PROFILE,
        draftId: draft.draftId,
        draftRevision: created.draft.revision,
        generation,
        items: [{ contentId: c.id, sha256: c.sha256 }],
      },
    });
    return { generation, contentId: c.id };
  }
  return {
    dir,
    source,
    backup,
    target,
    s3,
    upload,
    get storage() {
      return storage!;
    },
    closeOwner() {
      storage?.close();
      storage = undefined;
    },
    backupNow(args: string[] = []) {
      command("scripts/backup.mjs", [source, backup, ...args]);
    },
    restore() {
      command("scripts/restore.mjs", [backup, target]);
      return JSON.parse(readFileSync(join(target, RESTORE_MARKER), "utf8"));
    },
    verify: (options: Parameters<typeof verifyAttachmentRestore>[1] = {}) =>
      verifyAttachmentRestore(profile(target), {
        objectStorage: { state: "configured", config: s3.config },
        ...options,
      }),
    async close() {
      storage?.close();
      await s3.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
function evidence(
  marker: { restoreId: string; manifestSha256: string; recoveryCutoff: string },
  deletions: unknown[] = [],
  reviewedThrough = marker.recoveryCutoff,
) {
  return {
    version: 1,
    restoreId: marker.restoreId,
    manifestSha256: marker.manifestSha256,
    objectSnapshotId: null,
    recoveryCutoff: marker.recoveryCutoff,
    basis: "manual-review",
    reviewedThrough,
    quiescence: {
      oldOwnersStoppedBeforeCutoff: true,
      remainStoppedThroughActivation: true,
    },
    complete: true,
    deletions,
  };
}
function evidenceFile(h: { dir: string }, e: unknown) {
  const path = join(h.dir, "evidence.json");
  writeFileSync(path, JSON.stringify(e));
  return path;
}
test("real backup/restore requires fresh cutoff-covered evidence even for exact bytes; repair then verify and explicit activation are repeatable", async () => {
  const h = await setup();
  try {
    await h.upload("SYNTHETIC retained original", "send-a");
    h.closeOwner();
    h.backupNow();
    const marker = h.restore();
    let r = await h.verify();
    assert.equal(r.exitCode, 2);
    assert.equal(r.result.code, "deletion_gap");
    assert.equal(r.result.verifiedCount, 1);
    const key = [...h.s3.objects.keys()][0]!,
      saved = h.s3.objects.get(key)!;
    h.s3.objects.delete(key);
    const reconcile = evidenceFile(h, evidence(marker));
    r = await h.verify({ reconcile, activate: true });
    assert.equal(r.result.code, "object_missing");
    assert.equal(r.result.barrier, "unverified");
    h.s3.objects.set(key, {
      ...saved,
      body: Buffer.alloc(saved.body.length, 88),
    });
    r = await h.verify({ reconcile });
    assert.equal(r.result.code, "object_corrupt");
    h.s3.objects.set(key, saved);
    r = await h.verify({ reconcile });
    assert.equal(r.result.status, "verified");
    assert.equal(r.result.barrier, "unverified");
    r = await h.verify({ activate: true });
    assert.equal(r.result.status, "activated");
    assert.equal(
      (await h.verify({ activate: true })).result.status,
      "already-serving",
    );
    const reopened = new FixtureStorage(
      h.target,
      "server",
      Date.now,
      undefined,
      undefined,
      enabled,
    );
    try {
      assert.equal(reopened.attachments.available(), false);
      assert.ok(
        reopened.attachmentGenerationAllowed(
          scope,
          reopened.snapshot(scope).conversations[0]!.attachmentGeneration!,
        ),
      );
    } finally {
      reopened.close();
    }
  } finally {
    await h.close();
  }
});
test("T0 backup/T1 deletion/T2 cutoff rejects stale empty evidence and stale nonempty H-only evidence, including quiescence gaps", async () => {
  const h = await setup();
  try {
    const g = await h.upload("SYNTHETIC G", "send-g");
    h.storage.execute(scope, {
      type: "conversation.archive",
      conversationId: "conversation-1",
      commandId: "archive-g",
      idempotencyKey: "archive-g",
    });
    const hg = await h.upload("SYNTHETIC H", "send-h");
    h.storage.execute(scope, {
      type: "conversation.archive",
      conversationId: "conversation-1",
      commandId: "archive-h",
      idempotencyKey: "archive-h",
    });
    const fresh = await h.upload("SYNTHETIC fresh fixed B", "send-b");
    const archivedId = (generation: string) =>
      String(
        h.storage.attachments.db
          .prepare(
            "SELECT conversation_id FROM attachment_generations WHERE generation_id=?",
          )
          .get(generation)!.conversation_id,
      );
    const gid = archivedId(g.generation),
      hid = archivedId(hg.generation);
    h.backupNow();
    const manifest = JSON.parse(readFileSync(join(h.backup, MANIFEST), "utf8")); // T0 includes G/H and independent B.
    h.storage.execute(scope, {
      type: "conversation.delete",
      conversationId: hid,
      commandId: "delete-h",
      idempotencyKey: "delete-h",
    });
    const t1 = new Date().toISOString();
    h.storage.execute(scope, {
      type: "conversation.delete",
      conversationId: gid,
      commandId: "delete-g",
      idempotencyKey: "delete-g",
    });
    h.closeOwner();
    await new Promise((ok) => setTimeout(ok, 5));
    const marker = h.restore(); // T4 cutoff follows both old-owner deletions.
    const stale = evidence(marker, [], manifest.createdAt);
    let r = await h.verify({
      reconcile: evidenceFile(h, stale),
      activate: true,
    });
    assert.equal(r.result.code, "deletion_gap");
    const nonempty = evidence(
      marker,
      [{ scope, conversationId: hid, generation: hg.generation }],
      t1,
    );
    r = await h.verify({
      reconcile: evidenceFile(h, nonempty),
      activate: true,
    });
    assert.equal(r.result.code, "deletion_gap");
    const broken = {
      ...evidence(marker),
      quiescence: {
        oldOwnersStoppedBeforeCutoff: true,
        remainStoppedThroughActivation: false,
      },
    };
    r = await h.verify({ reconcile: evidenceFile(h, broken), activate: true });
    assert.equal(r.result.code, "deletion_gap");
    const unknown = { ...evidence(marker), recoveryCutoff: null };
    r = await h.verify({ reconcile: evidenceFile(h, unknown) });
    assert.equal(r.result.code, "deletion_gap");
    r = await h.verify({
      reconcile: evidenceFile(
        h,
        evidence(marker, [
          { scope, conversationId: gid, generation: g.generation },
          { scope, conversationId: hid, generation: hg.generation },
        ]),
      ),
      activate: true,
    });
    assert.equal(r.result.status, "activated");
    const check = new FixtureStorage(
      h.target,
      "server",
      Date.now,
      undefined,
      undefined,
      enabled,
    );
    try {
      assert.equal(check.attachments.isTombstoned(scope, g.generation), true);
      assert.equal(check.attachments.isTombstoned(scope, hg.generation), true);
      assert.equal(
        check.attachments.isTombstoned(scope, fresh.generation),
        false,
      );
      assert.equal(
        check.attachments.content(scope, fresh.contentId).id,
        fresh.contentId,
      );
    } finally {
      check.close();
    }
    assert.equal(h.s3.calls.filter((c) => c.method === "PUT").length, 3);
    assert.equal(h.s3.calls.filter((c) => c.method === "DELETE").length, 0);
  } finally {
    await h.close();
  }
});
test("owner lock and pre-barrier marker fail closed; argv contracts preserve legacy text", async () => {
  const h = await setup();
  try {
    await h.upload("SYNTHETIC lock", "send-a");
    h.closeOwner();
    h.backupNow();
    const marker = h.restore();
    const release = attachmentOwnerLocks(h.target, {
      workflowDirectory: ".",
      identityDirectory: null,
    });
    try {
      assert.equal((await h.verify()).result.code, "owner_busy");
    } finally {
      release();
    }
    const db = new DatabaseSync(join(h.target, "workflow.sqlite"));
    db.exec("DROP TABLE attachment_restore_state");
    db.close();
    assert.equal((await h.verify()).result.code, "identity_mismatch");
    assert.ok(existsSync(join(h.target, RESTORE_MARKER)));
    assert.throws(() => restoreVerifyArguments(["--activate"]));
    assert.throws(() =>
      restoreVerifyArguments(["", "--activate", "--activate"]),
    );
    assert.deepEqual(
      restoreVerifyArguments(["", "--reconcile", "evidence", "--activate"]),
      { profile: "", reconcile: "evidence", activate: true },
    );
    command(
      "scripts/backup.mjs",
      [h.source, join(h.dir, "bad"), "--attachments", "coordinated"],
      64,
    );
    command(
      "scripts/restore.mjs",
      [h.backup, join(h.dir, "bad"), "--activate"],
      64,
    );
    const text = join(h.dir, "text"),
      copy = join(h.dir, "text-copy"),
      textTarget = join(h.dir, "text-target");
    mkdirSync(text);
    writeFileSync(join(text, "plain.txt"), "old text");
    command("scripts/backup.mjs", [text, copy]);
    const restored = command("scripts/restore.mjs", [copy, textTarget]);
    assert.match(restored.stderr, /attachments: text-only/);
    assert.equal(
      readFileSync(join(textTarget, "plain.txt"), "utf8"),
      "old text",
    );
    assert.equal(existsSync(join(textTarget, RESTORE_MARKER)), false);
    assert.equal(marker.version, 1);
  } finally {
    await h.close();
  }
});

for (const cut of ["before_activation", "after_activation"] as const)
  test(`restore activation ${cut} failure preserves the durable instance boundary`, async () => {
    const h = await setup();
    try {
      await h.upload("SYNTHETIC activation", "send-a");
      h.closeOwner();
      h.backupNow();
      const marker = h.restore(),
        reconcile = evidenceFile(h, evidence(marker));
      const failed = await h.verify({
        reconcile,
        activate: true,
        checkpoint: (point) => {
          if (point === cut) throw Error("TEST activation interruption");
        },
      });
      assert.equal(failed.exitCode, 1);
      const repeat = await h.verify();
      assert.equal(
        repeat.result.status,
        cut === "after_activation" ? "already-serving" : "verified",
      );
      assert.equal(
        repeat.result.barrier,
        cut === "after_activation" ? "serving" : "unverified",
      );
    } finally {
      await h.close();
    }
  });
test("unresolved PUT survives metadata backup/offline verification and coordinated backup refuses it", async () => {
  const h = await setup();
  try {
    const u = await h.upload("SYNTHETIC quarantine", "send-a"),
      db = h.storage.attachments.db;
    db.prepare(
      "UPDATE object_storage_objects SET mutation='put',mutation_id=?,put_admitted=1 WHERE id=(SELECT handle_id FROM attachment_contents WHERE id=?)",
    ).run(randomUUID(), u.contentId);
    command(
      "scripts/backup.mjs",
      [
        h.source,
        join(h.dir, "coordinated"),
        "--attachments",
        "coordinated",
        "--object-snapshot-id",
        "snapshot-1",
      ],
      1,
    );
    h.backupNow();
    h.closeOwner();
    const marker = h.restore(),
      reconcile = evidenceFile(h, evidence(marker));
    const r = await h.verify({ reconcile, activate: true });
    assert.equal(r.result.code, "mutation_unsettled");
    assert.equal(r.result.blockedUncertainCount, 1);
    const check = new DatabaseSync(join(h.target, "workflow.sqlite"), {
      readOnly: true,
    });
    try {
      const row = check
        .prepare("SELECT mutation,put_admitted FROM object_storage_objects")
        .get()!;
      assert.equal(row.mutation, "put");
      assert.equal(row.put_admitted, 1);
    } finally {
      check.close();
    }
  } finally {
    await h.close();
  }
});

test("actual container wrapper forwards every operator argument without swallowing flags or changing empty profile", () => {
  const dir = mkdtempSync(join(tmpdir(), "niaro-wrapper-"));
  try {
    const node = join(dir, "node");
    writeFileSync(node, "#!/bin/sh\nprintf '%s\\0' \"$@\"\n");
    chmodSync(node, 0o700);
    const wrapper = join(process.cwd(), "scripts/docker/niaro");
    const invoke = (args: string[]) => {
      const r = spawnSync(
        "/bin/sh",
        [
          "-c",
          'wrapper="$1"; shift; cd() { :; }; . "$wrapper"',
          "sh",
          wrapper,
          ...args,
        ],
        {
          encoding: "utf8",
          env: {
            NODE_ENV: "test",
            PATH: dir,
            NIARO_DATA: "/synthetic data",
            NIARO_CONFIG: "/absent-fixture-profile",
          },
        },
      );
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.split("\0").slice(0, -1);
    };
    assert.deepEqual(
      invoke([
        "backup",
        "--attachments",
        "coordinated",
        "--object-snapshot-id",
        "snap:1",
      ]),
      [
        "--disable-warning=ExperimentalWarning",
        "scripts/backup.mjs",
        "/synthetic data",
        "-",
        "--attachments",
        "coordinated",
        "--object-snapshot-id",
        "snap:1",
      ],
    );
    assert.deepEqual(invoke(["restore", "archive.tar.gz", "--unexpected"]), [
      "--disable-warning=ExperimentalWarning",
      "scripts/restore.mjs",
      "archive.tar.gz",
      "/synthetic data",
      "--unexpected",
    ]);
    assert.deepEqual(
      invoke([
        "attachment-restore-verify",
        "--reconcile",
        "evidence with spaces",
        "--activate",
      ]),
      [
        "--disable-warning=ExperimentalWarning",
        "--import",
        "tsx",
        "apps/reference-server/cli.ts",
        "attachment-restore-verify",
        "",
        "--reconcile",
        "evidence with spaces",
        "--activate",
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const cut of ["before_activation", "after_activation"] as const)
  test(`SIGKILL ${cut} cannot duplicate or bypass restore activation`, async () => {
    const h = await setup();
    let child: ReturnType<typeof spawn> | undefined;
    try {
      await h.upload("SYNTHETIC activation crash", "send-a");
      h.closeOwner();
      h.backupNow();
      const marker = h.restore(),
        reconcile = evidenceFile(h, evidence(marker)),
        ready = join(h.dir, "activation-ready"),
        script = join(h.dir, "activation-worker.mts"),
        c = h.s3.config;
      const config = { ...c, credentials: c.credentials };
      writeFileSync(
        script,
        `import{writeFileSync}from'node:fs';import{verifyAttachmentRestore}from ${JSON.stringify(resolve("apps/server-attachments/restore.ts"))};await verifyAttachmentRestore(${JSON.stringify(profile(h.target))},{reconcile:${JSON.stringify(reconcile)},activate:true,objectStorage:{state:'configured',config:${JSON.stringify(config)}},checkpoint(point){if(point===${JSON.stringify(cut)}){writeFileSync(${JSON.stringify(ready)},point);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}}});throw Error('CUT NOT REACHED');`,
      );
      child = spawn(process.execPath, ["--import", "tsx", script], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr!.on("data", (b) => {
        stderr += String(b);
      });
      const deadline = Date.now() + 15000;
      while (
        !existsSync(ready) &&
        Date.now() < deadline &&
        child.exitCode === null
      )
        await delay(10);
      assert.ok(existsSync(ready), stderr);
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      assert.equal((await exited)[1], "SIGKILL");
      const repeat = await h.verify();
      assert.equal(
        repeat.result.status,
        cut === "after_activation" ? "already-serving" : "verified",
      );
      assert.equal(
        repeat.result.barrier,
        cut === "after_activation" ? "serving" : "unverified",
      );
      assert.equal(h.s3.calls.filter((c) => c.method === "PUT").length, 1);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await h.close();
    }
  });
