import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { FixtureStorage } from "../apps/fixture-server/storage";
import { AttachmentCleanup } from "../apps/server-attachments/cleanup";
import { loadAttachmentConfiguration } from "../apps/server-attachments/schema";
import { ATTACHMENT_PROFILE } from "../packages/protocol/attachments";
import { sha256 } from "../apps/server-storage/types";
import { syntheticS3 } from "./helpers/storage-s3";
const scope = {
  connectionId: "fixture-a",
  serverId: "server",
  workspaceId: "a",
  userId: "alice",
};
for (const cut of [
  "before_tombstone_commit",
  "after_tombstone_commit",
  "after_claim",
  "before_delete",
  "after_delete",
  "before_completion_commit",
  "after_completion_commit",
])
  test(`SIGKILL ${cut} retains durable lineage and permits only erase-only recovery`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "niaro-purge-crash-")),
      s3 = await syntheticS3(),
      ready = join(dir, "ready"),
      script = join(dir, "worker.mts"),
      enabled = loadAttachmentConfiguration({
        NIARO_ATTACHMENTS_ENABLED: "true",
      });
    let storage: FixtureStorage | undefined = new FixtureStorage(
      dir,
      "server",
      Date.now,
      undefined,
      undefined,
      enabled,
    );
    let child: ReturnType<typeof spawn> | undefined;
    try {
      storage.initializeObjectStorage({
        state: "configured",
        config: s3.config,
      });
      const generation =
          storage.snapshot(scope).conversations[0]!.attachmentGeneration!,
        draft = storage.attachments.createDraft(scope, {
          profile: ATTACHMENT_PROFILE,
          requestId: randomUUID(),
          target: {
            conversationId: "conversation-1",
            expectedGeneration: generation,
            mode: "current",
          },
        }).draft,
        bytes = Buffer.from("SYNTHETIC CRASH ORIGINAL"),
        up = storage.attachments.createUpload(scope, draft.draftId, {
          profile: ATTACHMENT_PROFILE,
          requestId: randomUUID(),
          expectedRevision: 1,
          filename: "source.txt",
          mediaType: "text/plain",
          size: bytes.length,
          sha256: sha256(bytes),
        }),
        content = storage.attachments.beginReceive(scope, up.upload.contentId);
      storage.attachments.markPutting(scope, content.id, content.token!);
      await storage.attachments
        .objectStore()
        .put(storage.attachments.handle(content), bytes);
      storage.attachments.finishTransfer(scope, content.id, content.token!);
      storage.acceptAttachmentMessage(scope, {
        type: "message.send",
        commandId: "send",
        idempotencyKey: "send",
        conversationId: "conversation-1",
        language: "en",
        text: "",
        attachments: {
          profile: ATTACHMENT_PROFILE,
          draftId: draft.draftId,
          draftRevision: up.draft.revision,
          generation,
          items: [{ contentId: content.id, sha256: content.sha256 }],
        },
      });
      storage.close();
      storage = undefined;
      writeFileSync(
        script,
        `
import {writeFileSync} from 'node:fs';import {FixtureStorage} from ${JSON.stringify(resolve("apps/fixture-server/storage.ts"))};import {loadAttachmentConfiguration} from ${JSON.stringify(resolve("apps/server-attachments/schema.ts"))};
const dir=${JSON.stringify(dir)},scope=${JSON.stringify(scope)},cut=${JSON.stringify(cut)},ready=${JSON.stringify(ready)};
function stop(point){if(cut===point){writeFileSync(ready,point);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}}
let phase='init';const store=new FixtureStorage(dir,'server',Date.now,(point)=>{if(phase==='delete'&&point==='before_commit')stop('before_tombstone_commit');if(phase==='delete'&&point==='after_commit')stop('after_tombstone_commit');if(phase==='finish'&&point==='before_commit')stop('before_completion_commit');if(phase==='finish'&&point==='after_commit')stop('after_completion_commit');},undefined,loadAttachmentConfiguration({NIARO_ATTACHMENTS_ENABLED:'true'}));store.initializeObjectStorage({state:'configured',config:${JSON.stringify({ endpoint: s3.config.endpoint, region: s3.config.region, bucket: s3.config.bucket, prefix: s3.config.prefix, forcePathStyle: s3.config.forcePathStyle, allowHttp: s3.config.allowHttp, credentialMode: s3.config.credentialMode, credentials: { accessKeyId: s3.config.credentials!.accessKeyId, secretAccessKey: s3.config.credentials!.secretAccessKey } })}});
if(store.objectStorage.state!=='configured')throw Error('TEST storage initialization '+JSON.stringify(store.objectStorage));
phase='delete';store.execute(scope,{type:'conversation.delete',conversationId:'conversation-1',commandId:'delete',idempotencyKey:'delete'});phase='cleanup';const job=store.attachments.claimJob();if(!job||job.kind!=='object')throw Error('object job required');stop('after_claim');stop('before_delete');const c=store.attachments.content(scope,job.target_id,true);await store.attachments.objectStore().delete(store.attachments.handle(c));stop('after_delete');phase='finish';store.attachments.finishJob(job);throw Error('cut not reached');
`,
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
      storage = new FixtureStorage(
        dir,
        "server",
        () => Date.now() + 3600001,
        undefined,
        undefined,
        enabled,
      );
      storage.initializeObjectStorage({
        state: "configured",
        config: s3.config,
      });
      if (cut === "before_tombstone_commit")
        assert.equal(
          storage.attachments.authorizeRead(scope, content.id).id,
          content.id,
        );
      else
        assert.throws(() =>
          storage!.attachments.authorizeRead(scope, content.id),
        );
      storage.execute(scope, {
        type: "conversation.delete",
        conversationId: "conversation-1",
        commandId: "delete",
        idempotencyKey: "delete",
      });
      const runner = new AttachmentCleanup(storage.attachments, async () => {});
      for (let n = 0; n < 4; n++) await runner.tick();
      assert.equal(
        storage.attachments.content(scope, content.id, true).lifecycle,
        "purged",
      );
      assert.equal(s3.objects.size, 0);
      assert.equal(s3.calls.filter((c) => c.method === "PUT").length, 1);
      assert.equal(
        storage.attachments.db
          .prepare("SELECT count(*) AS n FROM attachment_attempts")
          .get()!.n,
        1,
      );
    } finally {
      if (child && child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      storage?.close();
      await s3.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
