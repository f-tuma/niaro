import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { FixtureStorage } from "../apps/fixture-server/storage";
import { AttachmentCleanup } from "../apps/server-attachments/cleanup";
import { loadAttachmentConfiguration } from "../apps/server-attachments/schema";
import { loadStorageConfiguration } from "../apps/server-storage/config";
import { StorageRegistry } from "../apps/server-storage/registry";
import { StorageError, sha256 } from "../apps/server-storage/types";
import { ATTACHMENT_PROFILE } from "../packages/protocol/attachments";
import type { Scope } from "../packages/protocol";
import { syntheticS3 } from "./helpers/storage-s3";
const scope: Scope = {
  connectionId: "fixture-a",
  serverId: "server",
  workspaceId: "a",
  userId: "alice",
};
const configuration = loadAttachmentConfiguration({
  NIARO_ATTACHMENTS_ENABLED: "true",
});
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "niaro-attachment-lifecycle-")),
    s3 = await syntheticS3();
  let time = 1000000;
  let storage = new FixtureStorage(
    dir,
    "server",
    () => time,
    undefined,
    undefined,
    configuration,
  );
  storage.initializeObjectStorage({ state: "configured", config: s3.config });
  const upload = async (text: string, conversationId = "conversation-1") => {
    const g = storage
      .snapshot(scope, conversationId)
      .conversations.find(
        (c) => c.id === conversationId,
      )!.attachmentGeneration!;
    const draft = storage.attachments.createDraft(scope, {
      profile: ATTACHMENT_PROFILE,
      requestId: randomUUID(),
      target: { conversationId, expectedGeneration: g, mode: "current" },
    }).draft;
    const bytes = Buffer.from(text),
      created = storage.attachments.createUpload(scope, draft.draftId, {
        profile: ATTACHMENT_PROFILE,
        requestId: randomUUID(),
        expectedRevision: 1,
        filename: "private-source.txt",
        mediaType: "text/plain",
        size: bytes.length,
        sha256: sha256(bytes),
      });
    const c = storage.attachments.beginReceive(scope, created.upload.contentId);
    storage.attachments.markPutting(scope, c.id, c.token!);
    try {
      await storage.attachments
        .objectStore()
        .put(storage.attachments.handle(c), bytes);
      storage.attachments.finishTransfer(scope, c.id, c.token!);
    } catch (e) {
      storage.attachments.finishTransfer(scope, c.id, c.token!, e);
      throw e;
    }
    return { draft: created.draft, contentId: c.id, digest: c.sha256, bytes };
  };
  const send = (
    u: Awaited<ReturnType<typeof upload>>,
    id: string,
    conversationId = "conversation-1",
  ) =>
    storage.acceptAttachmentMessage(scope, {
      type: "message.send",
      commandId: id,
      idempotencyKey: id,
      conversationId,
      language: "en",
      text: "",
      attachments: {
        profile: ATTACHMENT_PROFILE,
        draftId: u.draft.draftId,
        draftRevision: u.draft.revision,
        generation: u.draft.generation,
        items: [{ contentId: u.contentId, sha256: u.digest }],
      },
    });
  return {
    get storage() {
      return storage;
    },
    s3,
    dir,
    upload,
    send,
    advance: (ms: number) => {
      time += ms;
    },
    reopen: () => {
      storage.close();
      storage = new FixtureStorage(
        dir,
        "server",
        () => time,
        undefined,
        undefined,
        configuration,
      );
      storage.initializeObjectStorage({
        state: "configured",
        config: s3.config,
      });
    },
    close: async () => {
      storage.close();
      await s3.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("old fixed-chat generation moves into archive; exact later purge preserves a new generation and its original", async () => {
  const h = await setup();
  try {
    const a = await h.upload("old evidence");
    h.send(a, "old-send");
    const archived = h.storage.execute(scope, {
      type: "conversation.archive",
      commandId: "archive-a",
      idempotencyKey: "archive-a",
      conversationId: "conversation-1",
    });
    assert.equal(archived.status, "accepted");
    const page = h.storage.conversations(scope),
      archive = page.conversations.find((c) => c.id.startsWith("archived-"))!;
    assert.ok(archive);
    assert.equal(
      h.storage.attachments.generation(scope, archive.id)!.generation_id,
      a.draft.generation,
    );
    assert.equal(
      h.storage.attachments.authorizeRead(scope, a.contentId).id,
      a.contentId,
    );
    const b = await h.upload("fresh evidence");
    h.send(b, "fresh-send");
    assert.notEqual(a.draft.generation, b.draft.generation);
    assert.equal(
      h.storage.execute(scope, {
        type: "conversation.delete",
        commandId: "delete-old",
        idempotencyKey: "delete-old",
        conversationId: archive.id,
      }).status,
      "accepted",
    );
    assert.throws(() =>
      h.storage.attachments.authorizeRead(scope, a.contentId),
    );
    const retired: string[] = [];
    const runner = new AttachmentCleanup(
      h.storage.attachments,
      async (_scope, g) => {
        retired.push(g);
      },
    );
    for (let n = 0; n < 4; n++) await runner.tick();
    assert.deepEqual(retired, [a.draft.generation]);
    assert.equal(
      h.storage.attachments.authorizeRead(scope, b.contentId).id,
      b.contentId,
    );
    assert.equal(h.s3.objects.size, 1);
    assert.equal(h.s3.calls.filter((c) => c.method === "PUT").length, 2);
    assert.equal(
      h.storage.attachments.content(scope, a.contentId, true).lifecycle,
      "purged",
    );
  } finally {
    await h.close();
  }
});
test("Edit pin removal cannot erase accepted history; removal replay increments revision once", async () => {
  const h = await setup();
  try {
    const a = await h.upload("bound original"),
      r = h.send(a, "original-send"),
      message = r.snapshot.conversations.find((c) => c.id === "conversation-1")!
        .messages[0]!;
    const draft = h.storage.attachments.createDraft(scope, {
      profile: ATTACHMENT_PROFILE,
      requestId: randomUUID(),
      target: {
        conversationId: "conversation-1",
        expectedGeneration: a.draft.generation,
        mode: "current",
      },
    }).draft;
    const pinned = h.storage.attachments.reference(scope, draft.draftId, {
      profile: ATTACHMENT_PROFILE,
      requestId: randomUUID(),
      expectedRevision: 1,
      source: {
        conversationId: "conversation-1",
        messageId: message.id,
        contentId: a.contentId,
      },
    });
    const remove = {
      profile: ATTACHMENT_PROFILE,
      requestId: randomUUID(),
      expectedRevision: pinned.revision,
    };
    const removed = h.storage.attachments.remove(
        scope,
        draft.draftId,
        remove,
        a.contentId,
      ),
      replay = h.storage.attachments.remove(
        scope,
        draft.draftId,
        remove,
        a.contentId,
      );
    assert.equal(removed.revision, replay.revision);
    assert.equal(
      h.storage.attachments.authorizeRead(scope, a.contentId).id,
      a.contentId,
    );
    assert.equal(
      h.storage.snapshot(scope).conversations[0]!.messages[0]!.attachments![0]!
        .contentId,
      a.contentId,
    );
  } finally {
    await h.close();
  }
});
test("settled purge resumes after outage/reopen while quota remains retained until settlement", async () => {
  const h = await setup();
  try {
    const a = await h.upload("delete during outage");
    h.send(a, "send-a");
    h.storage.execute(scope, {
      type: "conversation.delete",
      conversationId: "conversation-1",
      commandId: "delete-a",
      idempotencyKey: "delete-a",
    });
    h.s3.faults.deleteFailure = true;
    let runner = new AttachmentCleanup(h.storage.attachments, async () => {});
    await runner.tick();
    assert.equal(
      h.storage.attachments.content(scope, a.contentId, true).lifecycle,
      "tombstoned",
    );
    assert.equal(h.s3.objects.size, 1);
    h.reopen();
    h.s3.faults.deleteFailure = false;
    h.advance(3600001);
    runner = new AttachmentCleanup(h.storage.attachments, async () => {});
    for (let n = 0; n < 4; n++) await runner.tick();
    assert.equal(
      h.storage.attachments.content(scope, a.contentId, true).lifecycle,
      "purged",
    );
    assert.equal(h.s3.objects.size, 0);
  } finally {
    await h.close();
  }
});
test("registry no-dispatch retirement refuses prior admission, uncertainty and altered handles; rollback preserves reservation", () => {
  const db = new DatabaseSync(":memory:"),
    registry = new StorageRegistry(db);
  const configuration = loadStorageConfiguration({
    NIARO_S3_REGION: "us-east-1",
    NIARO_S3_BUCKET: "synthetic-storage",
    NIARO_S3_CREDENTIAL_MODE: "default",
  });
  assert.equal(configuration.state, "configured");
  if (configuration.state !== "configured") throw Error("config");
  const c = configuration.config;
  try {
    registry.activate(c);
    const reserve = () =>
      registry.reserve(c, randomUUID(), { size: 1, sha256: sha256("x") });
    const fresh = reserve();
    assert.throws(() => registry.discardUnstarted(c, fresh, false));
    assert.throws(
      () =>
        registry.discardUnstarted(
          c,
          { ...fresh, key: fresh.key + "-changed" },
          true,
        ),
      { code: "invalid_handle" },
    );
    db.exec("BEGIN IMMEDIATE");
    registry.discardUnstarted(c, fresh, true);
    assert.equal(registry.counts().retained, 0);
    db.exec("ROLLBACK");
    assert.equal(registry.counts().retained, 1);
    const token = registry.begin(c, fresh, "put")!;
    assert.throws(() => registry.discardUnstarted(c, fresh, true));
    registry.finish(
      c,
      fresh,
      token,
      "put",
      new StorageError("denied", false, "confirmed"),
    );
    assert.throws(
      () => new StorageRegistry(db).discardUnstarted(c, fresh, true),
      { code: "conflict" },
    );
    const uncertain = reserve(),
      unknown = registry.begin(c, uncertain, "put")!;
    registry.finish(
      c,
      uncertain,
      unknown,
      "put",
      new StorageError("timeout", true, "unknown"),
    );
    assert.throws(() => registry.discardUnstarted(c, uncertain, true), {
      code: "uncertain",
    });
    const unused = reserve();
    registry.discardUnstarted(c, unused, true);
    registry.discardUnstarted(c, unused, true);
    assert.equal(registry.counts().retained, 2);
    assert.throws(
      () =>
        registry.discardUnstarted(
          { ...c, bucket: "foreign-fixture" },
          fresh,
          true,
        ),
      { code: "location_mismatch" },
    );
    const legacy = reserve();
    db.exec("ALTER TABLE object_storage_objects DROP COLUMN put_admitted");
    const reopened = new StorageRegistry(db);
    assert.equal(
      db
        .prepare("SELECT put_admitted FROM object_storage_objects WHERE id=?")
        .get(legacy.id)!.put_admitted,
      1,
    );
    assert.throws(() => reopened.discardUnstarted(c, legacy, true), {
      code: "conflict",
    });
  } finally {
    db.close();
  }
});
test("unknown PUT plus missing HEAD and delayed arrival stays quarantined and retains quota/location with no cleanup DELETE", async () => {
  const h = await setup();
  try {
    const g = h.storage.snapshot(scope).conversations[0]!.attachmentGeneration!,
      draft = h.storage.attachments.createDraft(scope, {
        profile: ATTACHMENT_PROFILE,
        requestId: randomUUID(),
        target: {
          conversationId: "conversation-1",
          expectedGeneration: g,
          mode: "current",
        },
      }).draft,
      bytes = Buffer.from("SYNTHETIC delayed arrival"),
      up = h.storage.attachments.createUpload(scope, draft.draftId, {
        profile: ATTACHMENT_PROFILE,
        requestId: randomUUID(),
        expectedRevision: 1,
        filename: "source.txt",
        mediaType: "text/plain",
        size: bytes.length,
        sha256: sha256(bytes),
      }),
      c = h.storage.attachments.beginReceive(scope, up.upload.contentId);
    h.storage.attachments.markPutting(scope, c.id, c.token!);
    h.s3.faults.losePutResponse = true;
    let failure: unknown;
    try {
      await h.storage.attachments
        .objectStore()
        .put(h.storage.attachments.handle(c), bytes);
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    h.storage.attachments.finishTransfer(scope, c.id, c.token!, failure);
    assert.equal(
      h.storage.attachments.content(scope, c.id, true).transfer,
      "quarantined",
    );
    await assert.rejects(
      h.storage.attachments.objectStore().head(h.storage.attachments.handle(c)),
    );
    assert.equal(h.s3.objects.size, 0);
    h.storage.attachments.remove(scope, draft.draftId, {
      profile: ATTACHMENT_PROFILE,
      requestId: randomUUID(),
      expectedRevision: up.draft.revision,
    });
    const runner = new AttachmentCleanup(h.storage.attachments, async () => {});
    await runner.tick();
    assert.equal(
      h.storage.attachments.db
        .prepare("SELECT state FROM attachment_purge_jobs WHERE kind='object'")
        .get()!.state,
      "blocked_uncertain",
    );
    for (const apply of h.s3.pendingPuts) apply();
    assert.equal(h.s3.objects.size, 1);
    h.reopen();
    h.advance(3600001);
    await new AttachmentCleanup(h.storage.attachments, async () => {}).tick();
    assert.equal(
      h.storage.attachments.content(scope, c.id, true).transfer,
      "quarantined",
    );
    assert.equal(
      h.storage.attachments.content(scope, c.id, true).lifecycle,
      "tombstoned",
    );
    assert.equal(h.s3.calls.filter((c) => c.method === "DELETE").length, 0);
    assert.equal(
      h.storage.attachments.db
        .prepare(
          "SELECT count(*) AS n FROM object_storage_objects WHERE state!='deleted'",
        )
        .get()!.n,
      1,
    );
  } finally {
    await h.close();
  }
});
test("late upload completion cannot resurrect a removed draft; stale operation tokens cannot settle its purge", async () => {
  const h = await setup();
  try {
    const g = h.storage.snapshot(scope).conversations[0]!.attachmentGeneration!,
      draft = h.storage.attachments.createDraft(scope, {
        profile: ATTACHMENT_PROFILE,
        requestId: randomUUID(),
        target: {
          conversationId: "conversation-1",
          expectedGeneration: g,
          mode: "current",
        },
      }).draft,
      bytes = Buffer.from("SYNTHETIC paused upload"),
      up = h.storage.attachments.createUpload(scope, draft.draftId, {
        profile: ATTACHMENT_PROFILE,
        requestId: randomUUID(),
        expectedRevision: 1,
        filename: "source.txt",
        mediaType: "text/plain",
        size: bytes.length,
        sha256: sha256(bytes),
      }),
      c = h.storage.attachments.beginReceive(scope, up.upload.contentId);
    h.storage.attachments.markPutting(scope, c.id, c.token!);
    h.storage.attachments.remove(scope, draft.draftId, {
      profile: ATTACHMENT_PROFILE,
      requestId: randomUUID(),
      expectedRevision: up.draft.revision,
    });
    const runner = new AttachmentCleanup(h.storage.attachments, async () => {});
    await runner.tick();
    assert.equal(h.s3.calls.filter((c) => c.method === "DELETE").length, 0);
    await h.storage.attachments
      .objectStore()
      .put(h.storage.attachments.handle(c), bytes);
    h.storage.attachments.finishTransfer(scope, c.id, c.token!);
    assert.equal(
      h.storage.attachments.content(scope, c.id, true).lifecycle,
      "tombstoned",
    );
    assert.throws(() => h.storage.attachments.authorizeRead(scope, c.id));
    h.advance(3600001);
    const job = h.storage.attachments.claimJob()!;
    assert.ok(job);
    h.storage.attachments.finishJob({ ...job, token: randomUUID() });
    assert.equal(
      h.storage.attachments.db
        .prepare("SELECT state FROM attachment_purge_jobs WHERE id=?")
        .get(job.id)!.state,
      "running",
    );
    await h.storage.attachments
      .objectStore()
      .delete(h.storage.attachments.handle(c));
    h.storage.attachments.finishJob(job);
    assert.equal(
      h.storage.attachments.content(scope, c.id, true).lifecycle,
      "purged",
    );
  } finally {
    await h.close();
  }
});

test("lost DELETE response is retried after reopen without losing lineage or replaying PUT", async () => {
  const { createServer, request } = await import("node:http");
  const h = await setup();
  let lose = true;
  const proxy = createServer((req, res) => {
    const upstream = request(
      new URL(req.url!, h.s3.config.endpoint),
      { method: req.method, headers: req.headers },
      (reply) => {
        if (req.method === "DELETE" && lose) {
          reply.resume();
          reply.once("end", () => res.destroy());
          return;
        }
        res.writeHead(reply.statusCode!, reply.headers);
        reply.pipe(res);
      },
    );
    upstream.on("error", () => res.destroy());
    req.pipe(upstream);
  });
  await new Promise<void>((ok) => proxy.listen(0, "127.0.0.1", ok));
  const address = proxy.address() as import("node:net").AddressInfo,
    config = {
      ...h.s3.config,
      credentials: h.s3.config.credentials,
      endpoint: `http://127.0.0.1:${address.port}`,
    };
  try {
    h.storage.initializeObjectStorage({ state: "configured", config });
    const u = await h.upload("SYNTHETIC unknown delete");
    h.send(u, "send-unknown-delete");
    h.storage.execute(scope, {
      type: "conversation.delete",
      conversationId: "conversation-1",
      commandId: "delete-unknown",
      idempotencyKey: "delete-unknown",
    });
    await new AttachmentCleanup(h.storage.attachments, async () => {}).tick();
    assert.equal(h.s3.objects.size, 0);
    assert.equal(
      h.storage.attachments.content(scope, u.contentId, true).lifecycle,
      "tombstoned",
    );
    assert.equal(
      h.storage.attachments.db
        .prepare("SELECT state FROM object_storage_objects")
        .get()!.state,
      "deleting",
    );
    h.reopen();
    h.storage.initializeObjectStorage({ state: "configured", config });
    lose = false;
    h.advance(3600001);
    const cleanup = new AttachmentCleanup(
      h.storage.attachments,
      async () => {},
    );
    for (let n = 0; n < 4; n++) await cleanup.tick();
    assert.equal(
      h.storage.attachments.content(scope, u.contentId, true).lifecycle,
      "purged",
    );
    assert.equal(h.s3.calls.filter((c) => c.method === "PUT").length, 1);
    assert.ok(h.s3.calls.filter((c) => c.method === "DELETE").length >= 2);
  } finally {
    proxy.closeAllConnections();
    await new Promise<void>((ok) => proxy.close(() => ok()));
    await h.close();
  }
});

test("a later text turn sees an explicit unavailable-evidence notice rather than a caption-only source", async () => {
  const { ModelService } = await import("../apps/fixture-server/model-service"),
    h = await setup();
  try {
    const u = await h.upload("SYNTHETIC PRIVATE ORIGINAL");
    h.storage.acceptAttachmentMessage(scope, {
      type: "message.send",
      commandId: "caption-send",
      idempotencyKey: "caption-send",
      conversationId: "conversation-1",
      language: "en",
      text: "TEST PRIVATE SOURCE CAPTION",
      attachments: {
        profile: ATTACHMENT_PROFILE,
        draftId: u.draft.draftId,
        draftRevision: u.draft.revision,
        generation: u.draft.generation,
        items: [{ contentId: u.contentId, sha256: u.digest }],
      },
    });
    let captured = "",
      calls = 0;
    const model = new ModelService(h.storage, {
      timeZone: "UTC",
      decide: async (input) => {
        calls++;
        captured = JSON.stringify(input);
        return {
          kind: "reply",
          reply: "TEST ordinary text answer",
          contactId: null,
          title: null,
          localStart: null,
          durationMinutes: null,
        };
      },
    });
    assert.equal(
      (
        await model.execute(
          scope,
          {
            type: "message.send",
            commandId: "next-text",
            idempotencyKey: "next-text",
            conversationId: "conversation-1",
            language: "en",
            text: "TEST independent next text",
          },
          () => undefined,
          new AbortController().signal,
        )
      ).status,
      "accepted",
    );
    assert.equal(calls, 1);
    assert.ok(
      captured.includes("file evidence is unavailable for interpretation"),
    );
    assert.ok(!captured.includes("PRIVATE SOURCE CAPTION"));
    assert.ok(!captured.includes("PRIVATE ORIGINAL"));
    assert.ok(!captured.includes("private-source.txt"));
  } finally {
    await h.close();
  }
});

test("LIR-1 restart: persisted completed comparison recovers as verified with a new correct retry and one PUT", async () => {
  const h = await setup();
  try {
    const u = await h.upload("SYNTHETIC persisted comparison");
    h.send(u, "LIR1-restart-send");
    const before = h.storage.attachments.beginReceive(scope, u.contentId);
    assert.equal(before.transfer, "complete");
    assert.ok(before.token);
    h.reopen();
    const after = h.storage.attachments.upload(scope, u.contentId);
    assert.equal(after.state, "complete");
    assert.equal(after.receivedBytes, u.bytes.length);
    assert.equal(after.failure, null);
    assert.equal(h.storage.attachments.content(scope, u.contentId).token, null);
    assert.equal(
      h.storage.attachments.authorizeRead(scope, u.contentId).id,
      u.contentId,
    );
    assert.deepEqual(
      Buffer.from(
        await h.storage.attachments
          .objectStore()
          .get(
            h.storage.attachments.handle(
              h.storage.attachments.content(scope, u.contentId),
            ),
          ),
      ),
      u.bytes,
    );
    const retry = h.storage.attachments.beginReceive(scope, u.contentId);
    assert.equal(retry.transfer, "complete");
    assert.notEqual(retry.token, before.token);
    h.storage.attachments.finishTransfer(
      scope,
      u.contentId,
      before.token!,
      new Error("STALE OLD OWNER"),
    );
    assert.equal(
      h.storage.attachments.content(scope, u.contentId).token,
      retry.token,
    );
    h.storage.attachments.finishTransfer(scope, u.contentId, retry.token!);
    assert.equal(
      h.storage.attachments.upload(scope, u.contentId).state,
      "complete",
    );
    assert.equal(h.s3.calls.filter((c) => c.method === "PUT").length, 1);
  } finally {
    await h.close();
  }
});

function initialReservation(
  h: Awaited<ReturnType<typeof setup>>,
  text: string,
) {
  const bytes = Buffer.from(text),
    generation =
      h.storage.snapshot(scope).conversations[0]!.attachmentGeneration!,
    draft = h.storage.attachments.createDraft(scope, {
      profile: ATTACHMENT_PROFILE,
      requestId: randomUUID(),
      target: {
        conversationId: "conversation-1",
        expectedGeneration: generation,
        mode: "current",
      },
    }).draft,
    created = h.storage.attachments.createUpload(scope, draft.draftId, {
      profile: ATTACHMENT_PROFILE,
      requestId: randomUUID(),
      expectedRevision: 1,
      filename: "source.txt",
      mediaType: "text/plain",
      size: bytes.length,
      sha256: sha256(bytes),
    }),
    content = h.storage.attachments.beginReceive(
      scope,
      created.upload.contentId,
    );
  return { bytes, content };
}
test("comparison recovery never promotes an initial receive that had no PUT admission", async () => {
  const h = await setup();
  try {
    const u = initialReservation(h, "SYNTHETIC initial receive");
    h.reopen();
    assert.equal(
      h.storage.attachments.upload(scope, u.content.id).state,
      "retryable_failure",
    );
    assert.equal(
      h.storage.attachments.content(scope, u.content.id).token,
      null,
    );
    assert.equal(
      h.storage.attachments.objectSettlement(
        h.storage.attachments.content(scope, u.content.id),
      )!.put_admitted,
      0,
    );
    assert.throws(() =>
      h.storage.attachments.authorizeRead(scope, u.content.id),
    );
    assert.equal(h.s3.calls.filter((c) => c.method === "PUT").length, 0);
  } finally {
    await h.close();
  }
});
test("comparison recovery keeps an initial PUT awaiting workflow completion unverified until explicit verification", async () => {
  const h = await setup();
  try {
    const u = initialReservation(h, "SYNTHETIC initial verified remote only");
    h.storage.attachments.markPutting(scope, u.content.id, u.content.token!);
    await h.storage.attachments
      .objectStore()
      .put(h.storage.attachments.handle(u.content), u.bytes);
    h.reopen();
    assert.equal(
      h.storage.attachments.upload(scope, u.content.id).state,
      "unverified",
    );
    assert.throws(() =>
      h.storage.attachments.authorizeRead(scope, u.content.id),
    );
    const retry = h.storage.attachments.beginReceive(scope, u.content.id);
    assert.equal(retry.transfer, "unverified");
    assert.deepEqual(
      Buffer.from(
        await h.storage.attachments
          .objectStore()
          .get(h.storage.attachments.handle(retry)),
      ),
      u.bytes,
    );
    h.storage.attachments.finishTransfer(scope, u.content.id, retry.token!);
    assert.equal(
      h.storage.attachments.upload(scope, u.content.id).state,
      "complete",
    );
    assert.equal(h.s3.calls.filter((c) => c.method === "PUT").length, 1);
  } finally {
    await h.close();
  }
});
test("comparison recovery cannot promote an uncertain first PUT even after its delayed object arrives", async () => {
  const h = await setup();
  try {
    const u = initialReservation(h, "SYNTHETIC uncertain first PUT");
    h.storage.attachments.markPutting(scope, u.content.id, u.content.token!);
    h.s3.faults.losePutResponse = true;
    await assert.rejects(
      h.storage.attachments
        .objectStore()
        .put(h.storage.attachments.handle(u.content), u.bytes),
    );
    h.reopen();
    assert.equal(
      h.storage.attachments.upload(scope, u.content.id).state,
      "quarantined",
    );
    assert.equal(
      h.storage.attachments.objectSettlement(
        h.storage.attachments.content(scope, u.content.id),
      )!.write_uncertain,
      1,
    );
    assert.throws(() =>
      h.storage.attachments.authorizeRead(scope, u.content.id),
    );
    assert.throws(
      () => h.storage.attachments.beginReceive(scope, u.content.id),
      { code: "attachment_uncertain" },
    );
    for (const apply of h.s3.pendingPuts) apply();
    assert.equal(h.s3.objects.size, 1);
    assert.equal(
      h.storage.attachments.upload(scope, u.content.id).state,
      "quarantined",
    );
    assert.equal(
      h.storage.attachments.db
        .prepare(
          "SELECT count(*) AS n FROM object_storage_objects WHERE state!='deleted'",
        )
        .get()!.n,
      1,
    );
    assert.equal(h.s3.calls.filter((c) => c.method === "PUT").length, 1);
  } finally {
    await h.close();
  }
});
test("comparison recovery clears an old token without resurrecting a tombstoned original", async () => {
  const h = await setup();
  try {
    const u = await h.upload("SYNTHETIC deleted during comparison");
    h.send(u, "LIR1-deleted-compare");
    h.storage.attachments.beginReceive(scope, u.contentId);
    h.storage.execute(scope, {
      type: "conversation.delete",
      conversationId: "conversation-1",
      commandId: "LIR1-delete",
      idempotencyKey: "LIR1-delete",
    });
    h.reopen();
    assert.equal(
      h.storage.attachments.content(scope, u.contentId, true).lifecycle,
      "tombstoned",
    );
    assert.equal(
      h.storage.attachments.content(scope, u.contentId, true).token,
      null,
    );
    assert.throws(() =>
      h.storage.attachments.authorizeRead(scope, u.contentId),
    );
    assert.throws(() => h.storage.attachments.beginReceive(scope, u.contentId));
    const runner = new AttachmentCleanup(h.storage.attachments, async () => {});
    for (let n = 0; n < 4; n++) await runner.tick();
    assert.equal(
      h.storage.attachments.content(scope, u.contentId, true).lifecycle,
      "purged",
    );
    assert.equal(h.s3.objects.size, 0);
    assert.equal(h.s3.calls.filter((c) => c.method === "PUT").length, 1);
  } finally {
    await h.close();
  }
});
