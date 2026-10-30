import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { AttachmentStore } from "../apps/server-attachments/store";
import {
  loadAttachmentConfiguration,
  AttachmentError,
} from "../apps/server-attachments/schema";
import { StorageRegistry } from "../apps/server-storage/registry";
import { initializeObjectStorage } from "../apps/server-storage/runtime";
import { loadStorageConfiguration } from "../apps/server-storage/config";
import { ATTACHMENT_PROFILE } from "../packages/protocol/attachments";
import type { Scope } from "../packages/protocol";
const scope: Scope = {
  connectionId: "account-workspace",
  serverId: "server",
  workspaceId: "workspace",
  userId: "person",
};
function setup(limits: Record<string, string> = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON; PRAGMA user_version=1");
  const registry = new StorageRegistry(db);
  const runtime = initializeObjectStorage(
    registry,
    loadStorageConfiguration({
      NIARO_S3_REGION: "us-east-1",
      NIARO_S3_BUCKET: "synthetic-storage",
      NIARO_S3_CREDENTIAL_MODE: "default",
    }),
  );
  assert.equal(runtime.state, "configured");
  let time = 1000000;
  const chats = new Map<
    string,
    {
      exists: boolean;
      archived: boolean;
      deleted: boolean;
      resettable: boolean;
    }
  >();
  const transaction = <T>(run: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const v = run();
      db.exec("COMMIT");
      return v;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  const store = new AttachmentStore(
    db,
    transaction,
    loadAttachmentConfiguration({
      NIARO_ATTACHMENTS_ENABLED: "true",
      ...limits,
    }),
    () => runtime,
    (_s, id) =>
      chats.get(id) ?? {
        exists: false,
        archived: false,
        deleted: false,
        resettable: false,
      },
    () => time,
  );
  return {
    db,
    store,
    registry,
    chats,
    transaction,
    advance: (ms: number) => {
      time += ms;
    },
    close: () => {
      if (runtime.state === "configured") runtime.store.close();
      db.close();
    },
  };
}
const draftInput = () => ({
  profile: ATTACHMENT_PROFILE,
  requestId: randomUUID(),
  target: {
    conversationId: "chat-new",
    expectedGeneration: null,
    mode: "current",
  },
});
const uploadInput = (revision: number, size = 1) => ({
  profile: ATTACHMENT_PROFILE,
  requestId: randomUUID(),
  expectedRevision: revision,
  filename: "hello.txt",
  mediaType: "text/plain",
  size,
  sha256: "a".repeat(64),
});
test("metadata uses the real registry transaction, adopts unsaved drafts and preserves exact mutation replay", () => {
  const h = setup();
  try {
    const body = draftInput(),
      a = h.store.createDraft(scope, body),
      b = h.store.createDraft(scope, draftInput());
    assert.equal(a.draft.generation, b.draft.generation);
    assert.equal(h.chats.size, 0);
    const replay = h.store.createDraft(scope, body);
    assert.equal(replay.replay, true);
    assert.equal(replay.draft.draftId, a.draft.draftId);
    assert.throws(
      () =>
        h.store.createDraft(scope, {
          ...body,
          target: { ...body.target, conversationId: "different" },
        }),
      (e) => e instanceof AttachmentError && e.code === "attachment_conflict",
    );
    assert.throws(
      () => h.store.draft({ ...scope, userId: "other" }, a.draft.draftId),
      (e) => e instanceof AttachmentError && e.status === 404,
    );
    const up = uploadInput(a.draft.revision),
      created = h.store.createUpload(scope, a.draft.draftId, up);
    assert.equal(created.draft.revision, 2);
    assert.equal(h.registry.counts().retained, 1);
    assert.equal(
      h.store.createUpload(scope, a.draft.draftId, up).upload.contentId,
      created.upload.contentId,
    );
    h.chats.set("chat-new", {
      exists: true,
      archived: false,
      deleted: false,
      resettable: false,
    });
    h.transaction(() => h.store.adopt(scope, "chat-new"));
    assert.equal(
      h.store.generation(scope, "chat-new")?.generation_id,
      a.draft.generation,
    );
    assert.equal(h.db.prepare("PRAGMA user_version").get()!.user_version, 1);
    assert.throws(() =>
      h.db.prepare("UPDATE attachment_drafts SET state='alien'").run(),
    );
  } finally {
    h.close();
  }
});
test("quota reserves declared bytes atomically and a failed create leaves no registry handle", () => {
  const h = setup({
    NIARO_ATTACHMENTS_MAX_FILE_BYTES: "1",
    NIARO_ATTACHMENTS_MAX_MESSAGE_BYTES: "1",
    NIARO_ATTACHMENTS_MAX_MESSAGE_FILES: "1",
    NIARO_ATTACHMENTS_MAX_STAGED_FILES_PER_OWNER: "1",
    NIARO_ATTACHMENTS_MAX_STAGED_FILES_GLOBAL: "1",
    NIARO_ATTACHMENTS_MAX_STAGED_BYTES_PER_OWNER: "1",
    NIARO_ATTACHMENTS_MAX_STAGED_BYTES_GLOBAL: "1",
  });
  try {
    const a = h.store.createDraft(scope, draftInput()).draft,
      b = h.store.createDraft(scope, draftInput()).draft;
    h.store.createUpload(scope, a.draftId, uploadInput(a.revision));
    assert.throws(
      () => h.store.createUpload(scope, b.draftId, uploadInput(b.revision)),
      (e) => e instanceof AttachmentError && e.code === "attachment_quota",
    );
    assert.equal(h.registry.counts().retained, 1);
    assert.equal(h.store.draft(scope, b.draftId).revision, 1);
  } finally {
    h.close();
  }
});
test("absolute expiry, foreign generation constraints and stale revisions are enforced", () => {
  const h = setup();
  try {
    const a = h.store.createDraft(scope, draftInput()).draft;
    const b = h.store.createDraft(scope, {
      ...draftInput(),
      target: {
        conversationId: "other",
        expectedGeneration: null,
        mode: "current",
      },
    }).draft;
    const c = h.store.createUpload(scope, a.draftId, uploadInput(1));
    assert.throws(() =>
      h.db
        .prepare(
          "INSERT INTO attachment_draft_items VALUES(?,?,0,NULL,'active')",
        )
        .run(b.draftId, c.upload.contentId),
    );
    assert.throws(
      () => h.store.createUpload(scope, a.draftId, uploadInput(1)),
      (e) => e instanceof AttachmentError && e.code === "attachment_stale",
    );
    h.advance(86400001);
    assert.equal(h.store.draft(scope, a.draftId).state, "expired");
    assert.throws(
      () => h.store.createUpload(scope, a.draftId, uploadInput(2)),
      (e) => e instanceof AttachmentError && e.code === "attachment_stale",
    );
  } finally {
    h.close();
  }
});
