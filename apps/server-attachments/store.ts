import { randomUUID, createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Command, Scope, Snapshot } from "../../packages/protocol";
import {
  ATTACHMENT_PROFILE,
  AttachmentDraftSchema,
  AttachmentUploadSchema,
  AttachmentDraftCreateSchema,
  AttachmentUploadCreateSchema,
  AttachmentReferenceAddSchema,
  AttachmentRemoveSchema,
  AttachmentRetryLocalSchema,
  AttachmentProcessingSchema,
  type AttachmentDraft,
  type AttachmentProcessing,
} from "../../packages/protocol/attachments";
import {
  NativeAttachmentInputSchema,
  type NativeAttachmentInput,
} from "../server-identity/mastra-domain";
import { CommandSchema } from "../../packages/protocol";
import type { ObjectHandle } from "../server-storage/types";
import { StorageError } from "../server-storage/types";
import type { StorageRuntime } from "../server-storage/runtime";
import {
  AttachmentError,
  scopeKey,
  ownerKey,
  strictJson,
  type AttachmentConfiguration,
} from "./schema";

type Generation = {
  generation_id: string;
  conversation_id: string;
  state: string;
  predecessor: string | null;
};
type DraftRow = {
  id: string;
  scope_key: string;
  generation_id: string;
  target: string;
  revision: number;
  state: string;
  expires_at: number;
  accepted_command: string | null;
};
export type AttachmentContent = {
  id: string;
  scope_key: string;
  owner_key: string;
  generation_id: string;
  handle_id: string;
  handle: string;
  filename: string;
  media_type: string;
  detected_media_type: string | null;
  size: number;
  sha256: string;
  lifecycle: string;
  transfer: string;
  token: string | null;
  expires_at: number;
  received: number;
  failure: string | null;
  staged: number;
  ever_dispatched: number;
};
export type AttachmentJob = {
  id: string;
  kind: string;
  target_id: string;
  scope_key: string;
  generation_id: string;
  state: string;
  token: string;
  attempts: number;
  next_at: number;
};
type Source = (
  scope: Scope,
  conversationId: string,
) => {
  exists: boolean;
  archived: boolean;
  deleted: boolean;
  resettable: boolean;
};
export const attachmentDigest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Metadata only. All writes share the workflow owner's connection and transaction. */
export class AttachmentStore {
  constructor(
    readonly db: DatabaseSync,
    private transaction: <T>(run: () => T) => T,
    readonly config: AttachmentConfiguration,
    private objects: () => StorageRuntime,
    private source: Source,
    readonly now = () => Date.now(),
    private restoreBlocked: () => boolean = () => false,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS attachment_generations(scope_key TEXT NOT NULL,generation_id TEXT NOT NULL,conversation_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('reserved','live','archived','tombstoned')),predecessor TEXT,native_conversation_id TEXT,PRIMARY KEY(scope_key,generation_id)) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS attachment_generation_live ON attachment_generations(scope_key,conversation_id) WHERE state='live';
      CREATE UNIQUE INDEX IF NOT EXISTS attachment_generation_reserved ON attachment_generations(scope_key,conversation_id) WHERE state='reserved' AND predecessor IS NULL;
      CREATE TABLE IF NOT EXISTS attachment_drafts(id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,owner_key TEXT NOT NULL,generation_id TEXT NOT NULL,target TEXT NOT NULL CHECK(json_valid(target)),revision INTEGER NOT NULL CHECK(revision>0),state TEXT NOT NULL CHECK(state IN ('open','consumed','removed','expired')),created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,accepted_command TEXT,FOREIGN KEY(scope_key,generation_id) REFERENCES attachment_generations) STRICT;
      CREATE INDEX IF NOT EXISTS attachment_draft_expiry ON attachment_drafts(state,expires_at);
      CREATE INDEX IF NOT EXISTS attachment_draft_owner ON attachment_drafts(owner_key,state);
      CREATE TABLE IF NOT EXISTS attachment_contents(id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,owner_key TEXT NOT NULL,generation_id TEXT NOT NULL,handle_id TEXT NOT NULL UNIQUE REFERENCES object_storage_objects(id),handle TEXT NOT NULL CHECK(json_valid(handle)),filename TEXT NOT NULL,media_type TEXT NOT NULL,detected_media_type TEXT,size INTEGER NOT NULL CHECK(size>0),sha256 TEXT NOT NULL CHECK(length(sha256)=64),lifecycle TEXT NOT NULL CHECK(lifecycle IN ('staging','available','tombstoned','purged')),transfer TEXT NOT NULL CHECK(transfer IN ('created','receiving','putting','complete','unverified','retryable_failure','quarantined')),token TEXT,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,received INTEGER NOT NULL DEFAULT 0 CHECK(received>=0 AND received<=size),failure TEXT,staged INTEGER NOT NULL DEFAULT 1 CHECK(staged IN (0,1)),ever_dispatched INTEGER NOT NULL DEFAULT 0 CHECK(ever_dispatched IN (0,1)),FOREIGN KEY(scope_key,generation_id) REFERENCES attachment_generations) STRICT;
      CREATE INDEX IF NOT EXISTS attachment_content_owner ON attachment_contents(owner_key,lifecycle,staged);
      CREATE TABLE IF NOT EXISTS attachment_draft_items(draft_id TEXT NOT NULL REFERENCES attachment_drafts(id),content_id TEXT NOT NULL REFERENCES attachment_contents(id),ordinal INTEGER NOT NULL CHECK(ordinal>=0 AND ordinal<10),source_binding TEXT,state TEXT NOT NULL CHECK(state IN ('active','removed')),PRIMARY KEY(draft_id,content_id),UNIQUE(draft_id,ordinal)) STRICT;
      CREATE TABLE IF NOT EXISTS attachment_bindings(scope_key TEXT NOT NULL,message_id TEXT NOT NULL,content_id TEXT NOT NULL REFERENCES attachment_contents(id),generation_id TEXT NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal>=0 AND ordinal<10),accepted_command TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('live','tombstoned')),PRIMARY KEY(scope_key,message_id,content_id),UNIQUE(scope_key,message_id,ordinal),FOREIGN KEY(scope_key,generation_id) REFERENCES attachment_generations) STRICT;
      CREATE TABLE IF NOT EXISTS attachment_ingestions(id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,owner_key TEXT NOT NULL,generation_id TEXT NOT NULL,logical_message_id TEXT NOT NULL,message_id TEXT NOT NULL,content_ids TEXT NOT NULL CHECK(json_valid(content_ids)),intent_hash TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('blocked_capability','queued','preparing','waiting_retry','handoff_started','awaiting_publication','published','failed','cancelled','unknown')),version INTEGER NOT NULL CHECK(version>0),created_at INTEGER NOT NULL,UNIQUE(scope_key,logical_message_id),FOREIGN KEY(scope_key,generation_id) REFERENCES attachment_generations) STRICT;
      CREATE TABLE IF NOT EXISTS attachment_attempts(id TEXT PRIMARY KEY,ingestion_id TEXT NOT NULL REFERENCES attachment_ingestions(id),scope_key TEXT NOT NULL,command_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,request TEXT NOT NULL CHECK(json_valid(request)),ordinal INTEGER NOT NULL CHECK(ordinal>0),state TEXT NOT NULL CHECK(state IN ('blocked_capability','queued','preparing','waiting_retry','handoff_started','awaiting_publication','published','failed','cancelled','unknown')),version INTEGER NOT NULL CHECK(version>0),local_version INTEGER NOT NULL DEFAULT 0,boot_id TEXT NOT NULL,task_id TEXT NOT NULL,handoff_id TEXT UNIQUE,token TEXT,proof_id TEXT UNIQUE,consumed_by TEXT,native_binding TEXT,failure TEXT,created_at INTEGER NOT NULL,UNIQUE(scope_key,command_id),UNIQUE(scope_key,idempotency_key),UNIQUE(ingestion_id,ordinal)) STRICT;
      CREATE INDEX IF NOT EXISTS attachment_attempt_state ON attachment_attempts(state,created_at);
      CREATE TABLE IF NOT EXISTS attachment_mutations(scope_key TEXT NOT NULL,request_id TEXT NOT NULL,request_hash TEXT NOT NULL,target_id TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),PRIMARY KEY(scope_key,request_id)) STRICT;
      CREATE TABLE IF NOT EXISTS attachment_purge_jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('object','native_context','local_spool')),target_id TEXT NOT NULL,scope_key TEXT NOT NULL,generation_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','running','retry','blocked_uncertain','blocked_policy','done')),token TEXT,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL,error TEXT,created_at INTEGER NOT NULL,UNIQUE(kind,target_id)) STRICT;
      CREATE INDEX IF NOT EXISTS attachment_purge_due ON attachment_purge_jobs(state,next_at);
      CREATE TRIGGER IF NOT EXISTS attachment_item_generation BEFORE INSERT ON attachment_draft_items BEGIN
        SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM attachment_drafts d JOIN attachment_contents c ON c.id=NEW.content_id WHERE d.id=NEW.draft_id AND d.scope_key=c.scope_key AND d.generation_id=c.generation_id) THEN RAISE(ABORT,'attachment generation mismatch') END;
      END;
      CREATE TRIGGER IF NOT EXISTS attachment_binding_generation BEFORE INSERT ON attachment_bindings BEGIN
        SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM attachment_contents c WHERE c.id=NEW.content_id AND c.scope_key=NEW.scope_key AND c.generation_id=NEW.generation_id) THEN RAISE(ABORT,'attachment generation mismatch') END;
      END;
      CREATE TABLE IF NOT EXISTS attachment_publications(attempt_id TEXT PRIMARY KEY REFERENCES attachment_attempts(id),token TEXT NOT NULL,message_id TEXT NOT NULL) STRICT;
    `);
  }
  private write<T>(run: () => T): T {
    return this.db.isTransaction ? run() : this.transaction(run);
  }
  available() {
    return (
      this.config.enabled &&
      !this.restoreBlocked() &&
      this.objects().state === "configured"
    );
  }
  private requireServing() {
    if (!this.config.enabled || this.restoreBlocked())
      throw new AttachmentError("attachment_disabled", 503);
  }
  requireEnabled() {
    this.requireServing();
    if (this.objects().state !== "configured")
      throw new AttachmentError("attachment_unavailable", 503);
  }
  private mutate(
    scope: Scope,
    requestId: string,
    input: unknown,
    target: string,
    run: () => { draftId: string; uploadId?: string },
  ) {
    return this.write(() => {
      const key = scopeKey(scope),
        hash = attachmentDigest(input);
      const row = this.db
        .prepare(
          "SELECT request_hash,data FROM attachment_mutations WHERE scope_key=? AND request_id=?",
        )
        .get(key, requestId);
      if (row) {
        if (row.request_hash !== hash)
          throw new AttachmentError("attachment_conflict", 409);
        const data = z
          .strictObject({ draftId: z.uuid(), uploadId: z.uuid().optional() })
          .safeParse(JSON.parse(String(row.data)));
        if (!data.success)
          throw new AttachmentError("attachment_unavailable", 404);
        return { ...data.data, replay: true };
      }
      const data = run();
      this.db
        .prepare("INSERT INTO attachment_mutations VALUES(?,?,?,?,?)")
        .run(
          key,
          requestId,
          hash,
          target || data.draftId,
          JSON.stringify(data),
        );
      return { ...data, replay: false };
    });
  }
  generation(
    scope: Scope,
    conversationId: string,
    create = false,
  ): Generation | undefined {
    const key = scopeKey(scope);
    const found = this.db
      .prepare(
        "SELECT * FROM attachment_generations WHERE scope_key=? AND conversation_id=? AND state IN ('live','archived')",
      )
      .get(key, conversationId) as Generation | undefined;
    if (found || !create) return found;
    const status = this.source(scope, conversationId);
    if (!status.exists || status.deleted) return;
    const generation = randomUUID();
    this.db
      .prepare(
        "INSERT INTO attachment_generations(scope_key,generation_id,conversation_id,state,predecessor) VALUES(?,?,?,?,NULL)",
      )
      .run(
        key,
        generation,
        conversationId,
        status.archived ? "archived" : "live",
      );
    return {
      generation_id: generation,
      conversation_id: conversationId,
      state: status.archived ? "archived" : "live",
      predecessor: null,
    };
  }
  decorate(snapshot: Snapshot) {
    if (
      !this.config.enabled &&
      !this.db
        .prepare(
          "SELECT 1 FROM attachment_generations WHERE scope_key=? LIMIT 1",
        )
        .get(scopeKey(snapshot.scope))
    )
      return snapshot;
    return {
      ...snapshot,
      conversations: snapshot.conversations.map((c) => ({
        ...c,
        attachmentGeneration: this.generation(snapshot.scope, c.id)
          ?.generation_id,
      })),
    };
  }
  adopt(scope: Scope, conversationId: string) {
    const key = scopeKey(scope);
    const row = this.db
      .prepare(
        "SELECT generation_id FROM attachment_generations WHERE scope_key=? AND conversation_id=? AND state='reserved' AND predecessor IS NULL",
      )
      .get(key, conversationId);
    if (row && !this.generation(scope, conversationId))
      this.db
        .prepare(
          "UPDATE attachment_generations SET state='live' WHERE scope_key=? AND generation_id=?",
        )
        .run(key, String(row.generation_id));
  }
  createDraft(scope: Scope, input: unknown) {
    this.requireEnabled();
    const body = strictJson(AttachmentDraftCreateSchema, input);
    const result = this.mutate(
      scope,
      body.requestId,
      ["draft", body],
      "",
      () => {
        const key = scopeKey(scope),
          target = body.target,
          status = this.source(scope, target.conversationId);
        if (status.deleted || status.archived)
          throw new AttachmentError("attachment_stale", 409);
        let generation: string;
        if (status.exists) {
          const current = this.generation(scope, target.conversationId, true)!;
          if (
            target.expectedGeneration !== current.generation_id ||
            current.state !== "live"
          )
            throw new AttachmentError("attachment_stale", 409);
          if (target.mode === "new") {
            if (!status.resettable)
              throw new AttachmentError("attachment_stale", 409);
            generation = randomUUID();
            this.db
              .prepare(
                "INSERT INTO attachment_generations(scope_key,generation_id,conversation_id,state,predecessor) VALUES(?,?,?,'reserved',?)",
              )
              .run(
                key,
                generation,
                target.conversationId,
                current.generation_id,
              );
          } else generation = current.generation_id;
        } else {
          if (target.mode !== "current" || target.expectedGeneration !== null)
            throw new AttachmentError("attachment_stale", 409);
          const reserved = this.db
            .prepare(
              "SELECT generation_id FROM attachment_generations WHERE scope_key=? AND conversation_id=? AND state='reserved' AND predecessor IS NULL",
            )
            .get(key, target.conversationId);
          generation = reserved ? String(reserved.generation_id) : randomUUID();
          if (!reserved)
            this.db
              .prepare(
                "INSERT INTO attachment_generations(scope_key,generation_id,conversation_id,state,predecessor) VALUES(?,?,?,'reserved',NULL)",
              )
              .run(key, generation, target.conversationId);
        }
        const counts = this.db
          .prepare(
            "SELECT count(*) AS global,coalesce(sum(owner_key=?),0) AS own FROM attachment_drafts WHERE state='open' AND expires_at>?",
          )
          .get(ownerKey(scope), this.now())!;
        if (
          Number(counts.global) >= this.config.limits.maxDraftsGlobal ||
          Number(counts.own) >= this.config.limits.maxDraftsPerOwner
        )
          throw new AttachmentError("attachment_quota", 429);
        const id = randomUUID();
        this.db
          .prepare(
            "INSERT INTO attachment_drafts VALUES(?,?,?,?,?,1,'open',?,?,NULL)",
          )
          .run(
            id,
            key,
            ownerKey(scope),
            generation,
            JSON.stringify(target),
            this.now(),
            this.now() + this.config.limits.draftTtlSeconds * 1000,
          );
        return { draftId: id };
      },
    );
    return { replay: result.replay, draft: this.draft(scope, result.draftId) };
  }
  private draftRow(scope: Scope, id: string): DraftRow {
    const row = this.db
      .prepare("SELECT * FROM attachment_drafts WHERE id=? AND scope_key=?")
      .get(id, scopeKey(scope)) as DraftRow | undefined;
    if (!row || this.isTombstoned(scope, row.generation_id))
      throw new AttachmentError("attachment_unavailable", 404);
    return row;
  }
  private openDraft(scope: Scope, id: string, revision: number) {
    const row = this.draftRow(scope, id);
    if (
      row.state !== "open" ||
      row.expires_at <= this.now() ||
      row.revision !== revision
    )
      throw new AttachmentError("attachment_stale", 409);
    return row;
  }
  private items(id: string) {
    return this.db
      .prepare(
        "SELECT c.* FROM attachment_contents c JOIN attachment_draft_items i ON i.content_id=c.id WHERE i.draft_id=? AND i.state='active' AND c.lifecycle!='purged' ORDER BY i.ordinal",
      )
      .all(id) as AttachmentContent[];
  }
  private publicFile(c: AttachmentContent) {
    return {
      contentId: c.id,
      filename: c.filename,
      mediaType: c.detected_media_type ?? c.media_type,
      size: c.size,
      sha256: c.sha256,
      availability:
        c.lifecycle === "available" && c.transfer === "complete"
          ? ("available" as const)
          : ("unavailable" as const),
    };
  }
  draft(scope: Scope, id: string): AttachmentDraft {
    this.requireServing();
    const row = this.draftRow(scope, id);
    return AttachmentDraftSchema.parse({
      profile: ATTACHMENT_PROFILE,
      draftId: id,
      target: JSON.parse(row.target),
      generation: row.generation_id,
      revision: row.revision,
      state:
        row.state === "open" && row.expires_at <= this.now()
          ? "expired"
          : row.state,
      expiresAt: new Date(row.expires_at).toISOString(),
      items: this.items(id).map((c) => this.publicFile(c)),
    });
  }
  private quota(scope: Scope, size: number) {
    const q = this.db
      .prepare(
        "SELECT count(*) AS files,coalesce(sum(size),0) AS bytes,coalesce(sum(staged),0) AS staged_files,coalesce(sum(size*staged),0) AS staged_bytes,coalesce(sum(owner_key=?),0) AS own_files,coalesce(sum(CASE WHEN owner_key=? THEN size ELSE 0 END),0) AS own_bytes,coalesce(sum(CASE WHEN owner_key=? THEN staged ELSE 0 END),0) AS own_staged_files,coalesce(sum(CASE WHEN owner_key=? THEN size*staged ELSE 0 END),0) AS own_staged_bytes FROM attachment_contents WHERE lifecycle!='purged'",
      )
      .get(...Array(4).fill(ownerKey(scope)))!;
    const l = this.config.limits;
    if (
      Number(q.files) + 1 > l.maxRetainedFilesGlobal ||
      Number(q.bytes) + size > l.maxRetainedBytesGlobal ||
      Number(q.staged_files) + 1 > l.maxStagedFilesGlobal ||
      Number(q.staged_bytes) + size > l.maxStagedBytesGlobal ||
      Number(q.own_files) + 1 > l.maxRetainedFilesPerOwner ||
      Number(q.own_bytes) + size > l.maxRetainedBytesPerOwner ||
      Number(q.own_staged_files) + 1 > l.maxStagedFilesPerOwner ||
      Number(q.own_staged_bytes) + size > l.maxStagedBytesPerOwner
    )
      throw new AttachmentError("attachment_quota", 429);
  }
  createUpload(scope: Scope, draftId: string, input: unknown) {
    this.requireEnabled();
    const body = strictJson(AttachmentUploadCreateSchema, input);
    const result = this.mutate(
      scope,
      body.requestId,
      ["upload", draftId, body],
      draftId,
      () => {
        const draft = this.openDraft(scope, draftId, body.expectedRevision),
          items = this.items(draftId),
          l = this.config.limits;
        if (body.size > l.maxFileBytes)
          throw new AttachmentError("attachment_too_large", 413);
        if (
          items.length >= l.maxMessageFiles ||
          items.reduce((n, c) => n + c.size, 0) + body.size > l.maxMessageBytes
        )
          throw new AttachmentError("attachment_too_large", 413);
        this.quota(scope, body.size);
        const runtime = this.objects();
        if (runtime.state !== "configured")
          throw new AttachmentError("attachment_unavailable", 503);
        const id = randomUUID(),
          handle = runtime.store.reserve(draft.generation_id, {
            size: body.size,
            sha256: body.sha256,
          });
        this.db
          .prepare(
            "INSERT INTO attachment_contents(id,scope_key,owner_key,generation_id,handle_id,handle,filename,media_type,size,sha256,lifecycle,transfer,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,'staging','created',?,?)",
          )
          .run(
            id,
            scopeKey(scope),
            ownerKey(scope),
            draft.generation_id,
            handle.id,
            JSON.stringify(handle),
            body.filename,
            body.mediaType,
            body.size,
            body.sha256,
            this.now(),
            draft.expires_at,
          );
        const ordinal = this.nextOrdinal(draftId);
        this.db
          .prepare(
            "INSERT INTO attachment_draft_items VALUES(?,?,?,NULL,'active')",
          )
          .run(draftId, id, ordinal);
        this.db
          .prepare(
            "UPDATE attachment_drafts SET revision=revision+1 WHERE id=?",
          )
          .run(draftId);
        return { draftId, uploadId: id };
      },
    );
    return {
      replay: result.replay,
      draft: this.draft(scope, result.draftId),
      upload: this.upload(scope, result.uploadId!),
    };
  }
  private nextOrdinal(draftId: string) {
    // Removed slots can be reused without changing accepted historical bindings.
    const rows = this.db
      .prepare("SELECT ordinal FROM attachment_draft_items WHERE draft_id=?")
      .all(draftId);
    const used = new Set(rows.map((r) => Number(r.ordinal)));
    for (let n = 0; n < 10; n++) if (!used.has(n)) return n;
    this.db
      .prepare(
        "DELETE FROM attachment_draft_items WHERE draft_id=? AND state='removed'",
      )
      .run(draftId);
    const active = new Set(
      this.db
        .prepare("SELECT ordinal FROM attachment_draft_items WHERE draft_id=?")
        .all(draftId)
        .map((r) => Number(r.ordinal)),
    );
    for (let n = 0; n < 10; n++) if (!active.has(n)) return n;
    throw new AttachmentError("attachment_too_large", 413);
  }
  content(scope: Scope, id: string, allowTombstone = false): AttachmentContent {
    const row = this.db
      .prepare("SELECT * FROM attachment_contents WHERE id=? AND scope_key=?")
      .get(id, scopeKey(scope)) as AttachmentContent | undefined;
    if (
      !row ||
      (!allowTombstone &&
        (row.lifecycle === "tombstoned" ||
          row.lifecycle === "purged" ||
          this.isTombstoned(scope, row.generation_id)))
    )
      throw new AttachmentError("attachment_unavailable", 404);
    return row;
  }
  upload(scope: Scope, id: string) {
    this.requireServing();
    const c = this.content(scope, id, true);
    if (this.isTombstoned(scope, c.generation_id))
      throw new AttachmentError("attachment_unavailable", 404);
    const pinned = this.db
      .prepare(
        "SELECT d.state,d.expires_at FROM attachment_drafts d JOIN attachment_draft_items i ON i.draft_id=d.id WHERE i.content_id=? AND d.scope_key=? ORDER BY (d.state='open' AND d.expires_at>?) DESC LIMIT 1",
      )
      .get(id, scopeKey(scope), this.now());
    const state =
      (c.lifecycle === "tombstoned" || c.lifecycle === "purged") &&
      !(pinned?.state === "expired" || Number(pinned?.expires_at) <= this.now())
        ? "removed"
        : pinned?.state === "removed"
          ? "removed"
          : pinned?.state === "expired" ||
              (pinned?.state === "open" &&
                Number(pinned.expires_at) <= this.now())
            ? "expired"
            : c.transfer;
    return AttachmentUploadSchema.parse({
      profile: ATTACHMENT_PROFILE,
      uploadId: id,
      contentId: id,
      state,
      size: c.size,
      sha256: c.sha256,
      receivedBytes: c.received,
      expiresAt: new Date(c.expires_at).toISOString(),
      failure: c.failure,
    });
  }
  reference(scope: Scope, draftId: string, input: unknown) {
    this.requireEnabled();
    const body = strictJson(AttachmentReferenceAddSchema, input);
    const r = this.mutate(
      scope,
      body.requestId,
      ["reference", draftId, body],
      draftId,
      () => {
        const d = this.openDraft(scope, draftId, body.expectedRevision),
          c = this.authorizeRead(scope, body.source.contentId);
        const binding = this.db
          .prepare(
            "SELECT 1 FROM attachment_bindings b JOIN attachment_generations g ON g.scope_key=b.scope_key AND g.generation_id=b.generation_id WHERE b.scope_key=? AND b.message_id=? AND b.content_id=? AND b.state='live' AND g.conversation_id=?",
          )
          .get(
            scopeKey(scope),
            body.source.messageId,
            c.id,
            body.source.conversationId,
          );
        if (!binding) throw new AttachmentError("attachment_unavailable", 404);
        if (c.generation_id !== d.generation_id)
          throw new AttachmentError("attachment_stale", 409);
        const items = this.items(draftId);
        if (items.some((i) => i.id === c.id))
          throw new AttachmentError("attachment_conflict", 409);
        if (
          items.length >= this.config.limits.maxMessageFiles ||
          items.reduce((n, i) => n + i.size, 0) + c.size >
            this.config.limits.maxMessageBytes
        )
          throw new AttachmentError("attachment_too_large", 413);
        this.db
          .prepare(
            "DELETE FROM attachment_draft_items WHERE draft_id=? AND content_id=? AND state='removed'",
          )
          .run(draftId, c.id);
        this.db
          .prepare(
            "INSERT INTO attachment_draft_items VALUES(?,?,?,?,'active')",
          )
          .run(draftId, c.id, this.nextOrdinal(draftId), body.source.messageId);
        this.db
          .prepare(
            "UPDATE attachment_drafts SET revision=revision+1 WHERE id=?",
          )
          .run(draftId);
        return { draftId };
      },
    );
    return this.draft(scope, r.draftId);
  }
  remove(scope: Scope, draftId: string, input: unknown, contentId?: string) {
    this.requireEnabled();
    const body = strictJson(AttachmentRemoveSchema, input);
    const r = this.mutate(
      scope,
      body.requestId,
      ["remove", draftId, contentId ?? null, body],
      draftId,
      () => {
        this.openDraft(scope, draftId, body.expectedRevision);
        if (contentId) {
          const change = this.db
            .prepare(
              "UPDATE attachment_draft_items SET state='removed' WHERE draft_id=? AND content_id=? AND state='active'",
            )
            .run(draftId, contentId);
          if (!change.changes)
            throw new AttachmentError("attachment_unavailable", 404);
        } else
          this.db
            .prepare("UPDATE attachment_drafts SET state='removed' WHERE id=?")
            .run(draftId);
        this.db
          .prepare(
            "UPDATE attachment_drafts SET revision=revision+1 WHERE id=?",
          )
          .run(draftId);
        for (const c of contentId
          ? [this.content(scope, contentId)]
          : this.items(draftId))
          this.unreferenced(c);
        return { draftId };
      },
    );
    return this.draft(scope, r.draftId);
  }
  authorizeRead(scope: Scope, id: string) {
    this.requireEnabled();
    const c = this.content(scope, id);
    const binding = this.db
      .prepare(
        "SELECT 1 FROM attachment_bindings WHERE scope_key=? AND content_id=? AND state='live' LIMIT 1",
      )
      .get(scopeKey(scope), id);
    const pin = this.db
      .prepare(
        "SELECT 1 FROM attachment_draft_items i JOIN attachment_drafts d ON i.draft_id=d.id WHERE i.content_id=? AND i.state='active' AND d.scope_key=? AND d.state='open' AND d.expires_at>? LIMIT 1",
      )
      .get(id, scopeKey(scope), this.now());
    if (
      c.lifecycle !== "available" ||
      c.transfer !== "complete" ||
      (!binding && !pin)
    )
      throw new AttachmentError("attachment_unavailable", 404);
    return c;
  }
  handle(c: AttachmentContent): ObjectHandle {
    return JSON.parse(c.handle) as ObjectHandle;
  }
  beginReceive(scope: Scope, id: string) {
    return this.write(() => {
      this.requireEnabled();
      const c = this.content(scope, id);
      const pinned = this.db
        .prepare(
          "SELECT 1 FROM attachment_draft_items i JOIN attachment_drafts d ON d.id=i.draft_id WHERE i.content_id=? AND i.state='active' AND d.state='open' AND d.expires_at>? LIMIT 1",
        )
        .get(id, this.now());
      if (!pinned) {
        if (c.transfer !== "complete")
          throw new AttachmentError("attachment_stale", 409);
        this.authorizeRead(scope, id);
      }
      if (c.transfer === "quarantined")
        throw new AttachmentError("attachment_uncertain", 409);
      if (c.token) throw new AttachmentError("attachment_busy", 429);
      const token = randomUUID();
      this.db
        .prepare(
          "UPDATE attachment_contents SET token=?,transfer=CASE WHEN transfer IN ('complete','unverified') THEN transfer ELSE 'receiving' END,received=CASE WHEN transfer='complete' THEN size ELSE 0 END,failure=NULL WHERE id=?",
        )
        .run(token, id);
      return { ...c, token };
    });
  }
  markPutting(scope: Scope, id: string, token: string) {
    this.write(() => {
      const c = this.content(scope, id);
      if (c.token !== token) throw new AttachmentError("attachment_stale", 409);
      const registry = this.db
        .prepare(
          "SELECT write_uncertain,mutation FROM object_storage_objects WHERE id=?",
        )
        .get(c.handle_id)!;
      if (registry.write_uncertain)
        throw new AttachmentError("attachment_uncertain", 409);
      this.db
        .prepare(
          "UPDATE attachment_contents SET transfer='putting',ever_dispatched=1 WHERE id=? AND token=?",
        )
        .run(id, token);
    });
  }
  finishTransfer(
    scope: Scope,
    id: string,
    token: string,
    error?: unknown,
    detectedType?: string,
  ) {
    this.write(() => {
      const c = this.content(scope, id, true);
      if (c.token !== token) return;
      const r = this.db
        .prepare(
          "SELECT state,mutation,write_uncertain FROM object_storage_objects WHERE id=?",
        )
        .get(c.handle_id)!;
      const uncertain =
        !!r.write_uncertain ||
        (error instanceof StorageError && error.code === "uncertain");
      // A completed retry only compares local input; it cannot revoke the verified original.
      const comparisonOnly =
        c.transfer === "complete" &&
        r.state === "retained" &&
        r.mutation === "idle";
      const state = uncertain
        ? "quarantined"
        : comparisonOnly
          ? "complete"
          : error
            ? c.ever_dispatched &&
              (r.state === "retained" ||
                (error instanceof StorageError && error.code === "integrity"))
              ? "unverified"
              : "retryable_failure"
            : "complete";
      const live =
        !["tombstoned", "purged"].includes(c.lifecycle) &&
        !this.isTombstoned(scope, c.generation_id);
      this.db
        .prepare(
          "UPDATE attachment_contents SET token=NULL,transfer=?,lifecycle=?,received=?,failure=? WHERE id=? AND token=?",
        )
        .run(
          state,
          state === "complete" && live ? "available" : c.lifecycle,
          state === "complete" ? c.size : 0,
          error && state !== "complete"
            ? uncertain
              ? "attachment_uncertain"
              : "attachment_unavailable"
            : null,
          id,
          token,
        );
      if (state === "complete" && detectedType)
        this.db
          .prepare(
            "UPDATE attachment_contents SET detected_media_type=? WHERE id=?",
          )
          .run(detectedType, id);
      if (!live) this.enqueue("object", c.id, c.scope_key, c.generation_id);
    });
  }
  isTombstoned(scope: Scope, generation: string) {
    return (
      this.db
        .prepare(
          "SELECT state FROM attachment_generations WHERE scope_key=? AND generation_id=?",
        )
        .get(scopeKey(scope), generation)?.state === "tombstoned"
    );
  }
  private enqueue(
    kind: string,
    target: string,
    key: string,
    generation: string,
  ) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO attachment_purge_jobs VALUES(?,?,?,?,?,'pending',NULL,0,?,NULL,?)",
      )
      .run(randomUUID(), kind, target, key, generation, this.now(), this.now());
  }
  private unreferenced(c: AttachmentContent) {
    const bound = this.db
      .prepare(
        "SELECT 1 FROM attachment_bindings WHERE content_id=? AND state='live' LIMIT 1",
      )
      .get(c.id);
    const pin = this.db
      .prepare(
        "SELECT 1 FROM attachment_draft_items i JOIN attachment_drafts d ON d.id=i.draft_id WHERE i.content_id=? AND i.state='active' AND d.state='open' AND d.expires_at>? LIMIT 1",
      )
      .get(c.id, this.now());
    if (!bound && !pin) {
      this.db
        .prepare(
          "UPDATE attachment_contents SET lifecycle='tombstoned' WHERE id=? AND lifecycle!='purged'",
        )
        .run(c.id);
      this.enqueue("object", c.id, c.scope_key, c.generation_id);
    }
  }
  assertNoUnpublished(scope: Scope, conversationId: string, commandId: string) {
    const current = this.generation(scope, conversationId);
    if (!current) return;
    if (
      this.db
        .prepare(
          "SELECT 1 FROM attachment_attempts a JOIN attachment_ingestions i ON i.id=a.ingestion_id WHERE a.scope_key=? AND i.generation_id=? AND a.command_id!=? AND a.state IN ('handoff_started','awaiting_publication') LIMIT 1",
        )
        .get(scopeKey(scope), current.generation_id, commandId)
    )
      throw new AttachmentError("attachment_busy", 429);
  }
  accept(
    scope: Scope,
    command: Extract<Command, { type: "message.send" }>,
    messageId: string,
  ) {
    this.requireEnabled();
    this.assertNoUnpublished(scope, command.conversationId, command.commandId);
    const refs = command.attachments;
    if (!refs) throw new AttachmentError("attachment_invalid");
    const key = scopeKey(scope),
      current = this.generation(scope, command.conversationId, true);
    if (
      !current ||
      current.state !== "live" ||
      current.generation_id !== refs.generation
    )
      throw new AttachmentError("attachment_stale", 409);
    const draft = this.draftRow(scope, refs.draftId);
    const contents = this.items(draft.id);
    if (
      draft.generation_id !== current.generation_id ||
      JSON.parse(draft.target).conversationId !== command.conversationId ||
      draft.revision !== refs.draftRevision ||
      contents.length !== refs.items.length ||
      contents.some(
        (c, n) =>
          c.id !== refs.items[n]!.contentId ||
          c.sha256 !== refs.items[n]!.sha256 ||
          c.lifecycle !== "available" ||
          c.transfer !== "complete",
      )
    )
      throw new AttachmentError("attachment_stale", 409);
    for (const c of contents) this.authorizeRead(scope, c.id);
    const intent = ({ ...value }: typeof command) => {
      delete (value as Partial<typeof command>).commandId;
      delete (value as Partial<typeof command>).idempotencyKey;
      delete value.logicalMessageId;
      delete value.retryOf;
      delete value.session;
      return attachmentDigest(value);
    };
    let ingestionId: string = randomUUID(),
      ordinal = 1;
    if (command.retryOf) {
      const parent = this.db
        .prepare(
          "SELECT a.*,i.intent_hash,i.logical_message_id,i.message_id FROM attachment_attempts a JOIN attachment_ingestions i ON i.id=a.ingestion_id WHERE a.scope_key=? AND a.command_id=?",
        )
        .get(key, command.retryOf);
      if (
        !parent ||
        parent.intent_hash !== intent(command) ||
        parent.logical_message_id !== command.logicalMessageId ||
        draft.state !== "consumed" ||
        draft.accepted_command !==
          String(
            this.db
              .prepare(
                "SELECT command_id FROM attachment_attempts WHERE ingestion_id=? ORDER BY ordinal LIMIT 1",
              )
              .get(String(parent.ingestion_id))!.command_id,
          )
      )
        throw new AttachmentError("attachment_conflict", 409);
      if (parent.handoff_id)
        throw new AttachmentError("attachment_retry_required", 409);
      ingestionId = String(parent.ingestion_id);
      messageId = String(parent.message_id);
      ordinal =
        Number(
          this.db
            .prepare(
              "SELECT max(ordinal) AS n FROM attachment_attempts WHERE ingestion_id=?",
            )
            .get(ingestionId)!.n,
        ) + 1;
      const proof = parent.proof_id ?? randomUUID();
      if (parent.consumed_by && parent.consumed_by !== command.commandId)
        throw new AttachmentError("attachment_conflict", 409);
      this.db
        .prepare(
          "UPDATE attachment_attempts SET proof_id=?,consumed_by=?,token=NULL,local_version=local_version+1 WHERE id=? AND handoff_id IS NULL",
        )
        .run(String(proof), command.commandId, String(parent.id));
      this.db
        .prepare(
          "UPDATE attachment_ingestions SET state='blocked_capability',version=version+1 WHERE id=?",
        )
        .run(ingestionId);
    } else {
      if (draft.state !== "open" || draft.expires_at <= this.now())
        throw new AttachmentError("attachment_stale", 409);
      this.db
        .prepare(
          "INSERT INTO attachment_ingestions VALUES(?,?,?,?,?,?,?,?,'blocked_capability',1,?)",
        )
        .run(
          ingestionId,
          key,
          ownerKey(scope),
          current.generation_id,
          command.commandId,
          messageId,
          JSON.stringify(contents.map((c) => c.id)),
          intent(command),
          this.now(),
        );
      for (const [ordinal, c] of contents.entries())
        this.db
          .prepare("INSERT INTO attachment_bindings VALUES(?,?,?,?,?,?,'live')")
          .run(
            key,
            messageId,
            c.id,
            current.generation_id,
            ordinal,
            command.commandId,
          );
      this.db
        .prepare(
          "UPDATE attachment_drafts SET state='consumed',accepted_command=? WHERE id=?",
        )
        .run(command.commandId, draft.id);
      for (const c of contents)
        this.db
          .prepare("UPDATE attachment_contents SET staged=0 WHERE id=?")
          .run(c.id);
    }
    const attemptId = randomUUID();
    this.db
      .prepare(
        "INSERT INTO attachment_attempts(id,ingestion_id,scope_key,command_id,idempotency_key,request_hash,request,ordinal,state,version,boot_id,task_id,failure,created_at) VALUES(?,?,?,?,?,?,?,?,'blocked_capability',1,?,?,?,?)",
      )
      .run(
        attemptId,
        ingestionId,
        key,
        command.commandId,
        command.idempotencyKey,
        attachmentDigest(command),
        JSON.stringify(command),
        ordinal,
        randomUUID(),
        randomUUID(),
        "attachment_processing_unavailable",
        this.now(),
      );
    const processing: AttachmentProcessing = {
      ingestionId,
      attempt: ordinal,
      version: 1,
      state: "blocked_capability",
      failure: "attachment_processing_unavailable",
    };
    return {
      files: contents.map((c) => this.publicFile(c)),
      processing,
      messageId,
      attemptId,
    };
  }
  /** Internal future-processor seam; never called by the retention-only HTTP path. */
  recordHandoff(
    scope: Scope,
    attemptId: string,
    raw: NativeAttachmentInput,
    expectedVersion: number,
    chatRevision: number,
  ) {
    return this.write(() => {
      this.requireEnabled();
      const input = NativeAttachmentInputSchema.parse(raw),
        a = this.db
          .prepare(
            "SELECT a.*,i.generation_id,i.message_id,i.content_ids FROM attachment_attempts a JOIN attachment_ingestions i ON i.id=a.ingestion_id WHERE a.id=? AND a.scope_key=?",
          )
          .get(attemptId, scopeKey(scope));
      if (
        !a ||
        a.version !== expectedVersion ||
        !["queued", "waiting_retry"].includes(String(a.state)) ||
        a.handoff_id ||
        scopeKey(input.scope) !== scopeKey(scope) ||
        input.generation !== a.generation_id ||
        input.commandId !== a.idempotency_key ||
        input.outerCommandId !== a.command_id ||
        input.requestHash !== a.request_hash
      )
        throw new AttachmentError("attachment_stale", 409);
      const command = CommandSchema.parse(JSON.parse(String(a.request)));
      if (
        command.type !== "message.send" ||
        command.conversationId !== input.conversationId ||
        command.attachments?.generation !== input.generation ||
        this.generation(scope, input.conversationId)?.state !== "live" ||
        this.generation(scope, input.conversationId)?.generation_id !==
          input.generation
      )
        throw new AttachmentError("attachment_stale", 409);
      for (const contentId of JSON.parse(String(a.content_ids)))
        this.authorizeRead(scope, contentId);
      const pending = this.db
        .prepare(
          "SELECT count(*) AS n,coalesce(sum(i.owner_key=?),0) AS own FROM attachment_attempts a JOIN attachment_ingestions i ON i.id=a.ingestion_id WHERE a.state IN ('handoff_started','awaiting_publication')",
        )
        .get(ownerKey(scope))!;
      if (
        Number(pending.n) >= this.config.limits.maxPendingGlobal ||
        Number(pending.own) >= this.config.limits.maxPendingPerOwner
      )
        throw new AttachmentError("attachment_busy", 429);
      const token = randomUUID();
      this.db
        .prepare(
          "UPDATE attachment_attempts SET state='handoff_started',version=version+1,handoff_id=?,token=?,native_binding=?,failure=NULL WHERE id=?",
        )
        .run(
          input.handoffId,
          token,
          JSON.stringify({ input, chatRevision }),
          attemptId,
        );
      this.db
        .prepare(
          "UPDATE attachment_ingestions SET state='handoff_started',version=version+1 WHERE id=?",
        )
        .run(String(a.ingestion_id));
      return token;
    });
  }
  publication(scope: Scope, attemptId: string, token: string) {
    this.requireEnabled();
    const a = this.db
      .prepare(
        "SELECT a.*,i.generation_id,i.message_id FROM attachment_attempts a JOIN attachment_ingestions i ON i.id=a.ingestion_id WHERE a.id=? AND a.scope_key=?",
      )
      .get(attemptId, scopeKey(scope));
    if (!a || a.token !== token || !a.handoff_id || !a.native_binding)
      throw new AttachmentError("attachment_stale", 409);
    const binding = z
      .strictObject({
        input: NativeAttachmentInputSchema,
        chatRevision: z.number().int().positive(),
      })
      .parse(JSON.parse(String(a.native_binding)));
    const command = CommandSchema.parse(JSON.parse(String(a.request))),
      input = binding.input;
    if (
      command.type !== "message.send" ||
      input.requestHash !== a.request_hash ||
      input.handoffId !== a.handoff_id ||
      input.outerCommandId !== a.command_id ||
      input.commandId !== a.idempotency_key ||
      input.generation !== a.generation_id ||
      scopeKey(input.scope) !== scopeKey(scope) ||
      input.conversationId !== command.conversationId ||
      this.generation(scope, command.conversationId)?.generation_id !==
        input.generation ||
      this.generation(scope, command.conversationId)?.state !== "live"
    )
      throw new AttachmentError("attachment_stale", 409);
    const prior = this.db
      .prepare("SELECT token FROM attachment_publications WHERE attempt_id=?")
      .get(attemptId);
    if (prior && prior.token !== token)
      throw new AttachmentError("attachment_stale", 409);
    if (
      !prior &&
      !["handoff_started", "awaiting_publication"].includes(String(a.state))
    )
      throw new AttachmentError("attachment_stale", 409);
    return {
      command,
      input,
      chatRevision: binding.chatRevision,
      messageId: String(a.message_id),
      ingestionId: String(a.ingestion_id),
      ordinal: Number(a.ordinal),
      version: Number(a.version),
      published: !!prior,
    };
  }
  finishPublication(
    scope: Scope,
    attemptId: string,
    token: string,
    messageId: string,
  ) {
    const a = this.publication(scope, attemptId, token);
    if (a.published) return;
    this.db
      .prepare("INSERT INTO attachment_publications VALUES(?,?,?)")
      .run(attemptId, token, messageId);
    this.db
      .prepare(
        "UPDATE attachment_attempts SET state='published',version=version+1 WHERE id=? AND token=?",
      )
      .run(attemptId, token);
    this.db
      .prepare(
        "UPDATE attachment_ingestions SET state='published',version=version+1 WHERE id=?",
      )
      .run(a.ingestionId);
  }
  retryLocal(scope: Scope, id: string, input: unknown): never {
    this.requireServing();
    const body = strictJson(AttachmentRetryLocalSchema, input);
    return this.write(() => {
      const current = this.processing(scope, id),
        attempt = this.db
          .prepare(
            "SELECT handoff_id FROM attachment_attempts WHERE ingestion_id=? ORDER BY ordinal DESC LIMIT 1",
          )
          .get(id);
      if (
        current.attempt !== body.expectedAttempt ||
        current.version !== body.expectedVersion
      )
        throw new AttachmentError("attachment_stale", 409);
      if (
        attempt?.handoff_id ||
        !["blocked_capability", "failed", "cancelled"].includes(current.state)
      )
        throw new AttachmentError("attachment_retry_required", 409);
      // No processor is selected at this checkpoint. A local retry never spends inference.
      throw new AttachmentError("attachment_processing_unavailable", 503);
    });
  }
  processing(scope: Scope, id: string): AttachmentProcessing {
    this.requireServing();
    const row = this.db
      .prepare(
        "SELECT i.generation_id,a.ordinal,a.version,a.state,a.failure FROM attachment_ingestions i JOIN attachment_attempts a ON a.ingestion_id=i.id WHERE i.id=? AND i.scope_key=? ORDER BY a.ordinal DESC LIMIT 1",
      )
      .get(id, scopeKey(scope));
    if (!row || this.isTombstoned(scope, String(row.generation_id)))
      throw new AttachmentError("attachment_unavailable", 404);
    return AttachmentProcessingSchema.parse({
      ingestionId: id,
      attempt: Number(row.ordinal),
      version: Number(row.version),
      state: String(row.state) as AttachmentProcessing["state"],
      failure: row.failure as AttachmentProcessing["failure"],
    });
  }
  objectStore() {
    const r = this.objects();
    if (r.state !== "configured")
      throw new AttachmentError("attachment_unavailable", 503);
    return r.store;
  }
  private invalidateDrafts(key: string, generation: string, except?: string) {
    const drafts = this.db
      .prepare(
        "SELECT id FROM attachment_drafts WHERE scope_key=? AND generation_id=? AND state='open'",
      )
      .all(key, generation);
    for (const d of drafts) {
      if (d.id === except) continue;
      this.db
        .prepare(
          "UPDATE attachment_drafts SET state='removed',revision=revision+1 WHERE id=?",
        )
        .run(String(d.id));
      for (const c of this.items(String(d.id))) this.unreferenced(c);
    }
    this.db
      .prepare(
        "UPDATE attachment_attempts SET state='cancelled',token=NULL,local_version=local_version+1 WHERE ingestion_id IN (SELECT id FROM attachment_ingestions WHERE scope_key=? AND generation_id=?) AND handoff_id IS NULL AND state IN ('queued','preparing','waiting_retry','awaiting_publication')",
      )
      .run(key, generation);
  }
  assertSuccessor(
    scope: Scope,
    command: Extract<Command, { type: "message.send" }>,
  ) {
    const ref = command.attachments;
    if (!ref || command.session !== "new")
      throw new AttachmentError("attachment_stale", 409);
    const d = this.openDraft(scope, ref.draftId, ref.draftRevision),
      current = this.generation(scope, command.conversationId),
      target = JSON.parse(d.target);
    const reserved = this.db
      .prepare(
        "SELECT * FROM attachment_generations WHERE scope_key=? AND generation_id=?",
      )
      .get(scopeKey(scope), d.generation_id);
    if (
      !current ||
      !reserved ||
      reserved.state !== "reserved" ||
      reserved.predecessor !== current.generation_id ||
      target.mode !== "new" ||
      target.expectedGeneration !== current.generation_id ||
      ref.generation !== d.generation_id
    )
      throw new AttachmentError("attachment_stale", 409);
  }
  rollover(
    scope: Scope,
    conversationId: string,
    archiveId: string | null,
    successor?: string,
    keepDraft?: string,
  ) {
    const key = scopeKey(scope),
      old = this.generation(scope, conversationId);
    if (!old) return;
    if (archiveId)
      this.db
        .prepare(
          "UPDATE attachment_generations SET native_conversation_id=coalesce(native_conversation_id,conversation_id),conversation_id=?,state='archived' WHERE scope_key=? AND generation_id=?",
        )
        .run(archiveId, key, old.generation_id);
    else this.tombstone(scope, old.generation_id);
    this.invalidateDrafts(key, old.generation_id);
    const reserved = this.db
      .prepare(
        "SELECT generation_id FROM attachment_generations WHERE scope_key=? AND predecessor=? AND state='reserved'",
      )
      .all(key, old.generation_id);
    for (const row of reserved)
      if (row.generation_id !== successor)
        this.tombstone(scope, String(row.generation_id));
    if (successor) {
      const update = this.db
        .prepare(
          "UPDATE attachment_generations SET state='live' WHERE scope_key=? AND generation_id=? AND state='reserved' AND predecessor=?",
        )
        .run(key, successor, old.generation_id);
      if (!update.changes) throw new AttachmentError("attachment_stale", 409);
      this.invalidateDrafts(key, successor, keepDraft);
    } else
      this.db
        .prepare(
          "INSERT INTO attachment_generations(scope_key,generation_id,conversation_id,state,predecessor) VALUES(?,?,?,'live',?)",
        )
        .run(key, randomUUID(), conversationId, old.generation_id);
  }
  archive(scope: Scope, conversationId: string, restore = false) {
    const g = this.generation(scope, conversationId);
    if (!g) return;
    this.invalidateDrafts(scopeKey(scope), g.generation_id);
    this.db
      .prepare(
        "UPDATE attachment_generations SET state=? WHERE scope_key=? AND generation_id=? AND state!='tombstoned'",
      )
      .run(restore ? "live" : "archived", scopeKey(scope), g.generation_id);
  }
  nativePurgeConversations(scope: Scope, generation: string) {
    if (!this.isTombstoned(scope, generation))
      throw new AttachmentError("attachment_stale", 409);
    const row = this.db
      .prepare(
        "SELECT coalesce(native_conversation_id,conversation_id) AS id FROM attachment_generations WHERE scope_key=? AND generation_id=?",
      )
      .get(scopeKey(scope), generation);
    return row ? [String(row.id)] : [];
  }
  nativePurgeCommands(scope: Scope, generation: string) {
    if (!this.isTombstoned(scope, generation))
      throw new AttachmentError("attachment_stale", 409);
    return this.db
      .prepare(
        "SELECT a.idempotency_key FROM attachment_attempts a JOIN attachment_ingestions i ON i.id=a.ingestion_id WHERE i.scope_key=? AND i.generation_id=? AND a.handoff_id IS NOT NULL",
      )
      .all(scopeKey(scope), generation)
      .map((r) => String(r.idempotency_key));
  }
  hasLineage(scope: Scope, conversationId: string) {
    return !!this.db
      .prepare(
        "SELECT 1 FROM attachment_generations WHERE scope_key=? AND conversation_id=? LIMIT 1",
      )
      .get(scopeKey(scope), conversationId);
  }
  tombstoneConversation(
    scope: Scope,
    conversationId: string,
    resettable = false,
  ) {
    const key = scopeKey(scope),
      rows = this.db
        .prepare(
          "SELECT generation_id FROM attachment_generations WHERE scope_key=? AND conversation_id=? AND state!='tombstoned'",
        )
        .all(key, conversationId);
    for (const row of rows) this.tombstone(scope, String(row.generation_id));
    if (resettable && rows.length)
      this.db
        .prepare(
          "INSERT INTO attachment_generations(scope_key,generation_id,conversation_id,state,predecessor) VALUES(?,?,?,'live',NULL)",
        )
        .run(key, randomUUID(), conversationId);
  }
  tombstone(scope: Scope, generation: string) {
    const key = scopeKey(scope),
      row = this.db
        .prepare(
          "SELECT state FROM attachment_generations WHERE scope_key=? AND generation_id=?",
        )
        .get(key, generation);
    if (!row) throw new AttachmentError("attachment_unavailable", 404);
    if (row.state === "tombstoned") return;
    this.db
      .prepare(
        "UPDATE attachment_generations SET state='tombstoned' WHERE scope_key=? AND generation_id=?",
      )
      .run(key, generation);
    this.invalidateDrafts(key, generation);
    for (const child of this.db
      .prepare(
        "SELECT generation_id FROM attachment_generations WHERE scope_key=? AND predecessor=? AND state='reserved'",
      )
      .all(key, generation))
      this.tombstone(scope, String(child.generation_id));
    const contents = this.db
      .prepare(
        "SELECT * FROM attachment_contents WHERE scope_key=? AND generation_id=? AND lifecycle!='purged'",
      )
      .all(key, generation) as AttachmentContent[];
    this.db
      .prepare(
        "UPDATE attachment_contents SET lifecycle='tombstoned',filename='',media_type='application/octet-stream',detected_media_type=NULL WHERE scope_key=? AND generation_id=? AND lifecycle!='purged'",
      )
      .run(key, generation);
    this.db
      .prepare(
        "UPDATE attachment_bindings SET state='tombstoned' WHERE scope_key=? AND generation_id=?",
      )
      .run(key, generation);
    this.db
      .prepare(
        "UPDATE attachment_mutations SET data='{}' WHERE scope_key=? AND target_id IN (SELECT id FROM attachment_drafts WHERE scope_key=? AND generation_id=?)",
      )
      .run(key, key, generation);
    this.db
      .prepare(
        "UPDATE attachment_attempts SET request='{}',token=NULL,local_version=local_version+1,state=CASE WHEN handoff_id IS NULL THEN 'cancelled' ELSE 'unknown' END WHERE ingestion_id IN (SELECT id FROM attachment_ingestions WHERE scope_key=? AND generation_id=?)",
      )
      .run(key, generation);
    this.db
      .prepare(
        "UPDATE attachment_ingestions SET state='cancelled',version=version+1 WHERE scope_key=? AND generation_id=?",
      )
      .run(key, generation);
    for (const c of contents) this.enqueue("object", c.id, key, generation);
    this.enqueue("native_context", generation, key, generation);
    if (
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='attachment_restore_state'",
        )
        .get()
    )
      this.db.exec(
        "UPDATE attachment_restore_state SET reconciliation_revision=reconciliation_revision+1,reconciliation_digest=NULL WHERE state='unverified'",
      );
  }
  expire() {
    if (this.restoreBlocked()) return;
    this.write(() => {
      const rows = this.db
        .prepare(
          "SELECT id FROM attachment_drafts WHERE state='open' AND expires_at<=? ORDER BY expires_at LIMIT 100",
        )
        .all(this.now());
      for (const row of rows) {
        this.db
          .prepare(
            "UPDATE attachment_drafts SET state='expired',revision=revision+1 WHERE id=?",
          )
          .run(String(row.id));
        for (const c of this.items(String(row.id))) this.unreferenced(c);
      }
    });
  }
  claimJob(): AttachmentJob | undefined {
    if (this.restoreBlocked()) return;
    return this.write(() => {
      const row = this.db
        .prepare(
          "SELECT * FROM attachment_purge_jobs WHERE state IN ('pending','retry','blocked_policy','blocked_uncertain') AND next_at<=? ORDER BY next_at,created_at LIMIT 1",
        )
        .get(this.now()) as AttachmentJob | undefined;
      if (!row) return;
      const token = randomUUID();
      this.db
        .prepare(
          "UPDATE attachment_purge_jobs SET state='running',token=? WHERE id=?",
        )
        .run(token, row.id);
      return { ...row, token };
    });
  }
  finishJob(job: AttachmentJob, error?: unknown) {
    this.write(() => {
      const row = this.db
        .prepare("SELECT state,token FROM attachment_purge_jobs WHERE id=?")
        .get(job.id);
      if (row?.state !== "running" || row.token !== job.token) return;
      let state = "done",
        next = this.now(),
        code: string | null = null;
      if (error) {
        code =
          error instanceof StorageError
            ? error.code
            : error instanceof AttachmentError
              ? error.code
              : error instanceof Error &&
                  "code" in error &&
                  error.code === "attachment_native_unknown"
                ? "uncertain"
                : "unavailable";
        state =
          code === "uncertain"
            ? "blocked_uncertain"
            : [
                  "denied",
                  "bucket_not_erasable",
                  "integrity",
                  "location_mismatch",
                  "invalid_handle",
                ].includes(code)
              ? "blocked_policy"
              : "retry";
        const backoff = [5000, 30000, 120000, 600000, 3600000][
          Math.min(job.attempts, 4)
        ]!;
        next += state.startsWith("blocked")
          ? 3600000
          : Math.min(
              3600000,
              backoff +
                (parseInt(
                  attachmentDigest([job.id, job.attempts]).slice(0, 4),
                  16,
                ) %
                  Math.max(1, Math.floor(backoff / 10))),
            );
      }
      if (!error && job.kind === "object") {
        const c = this.db
          .prepare("SELECT * FROM attachment_contents WHERE id=?")
          .get(job.target_id) as AttachmentContent | undefined;
        const registry =
          c &&
          this.db
            .prepare(
              "SELECT state,write_uncertain,mutation FROM object_storage_objects WHERE id=?",
            )
            .get(c.handle_id);
        if (
          !registry ||
          registry.state !== "deleted" ||
          registry.write_uncertain ||
          registry.mutation !== "idle"
        )
          throw new AttachmentError("attachment_uncertain", 409);
        this.db
          .prepare(
            "UPDATE attachment_contents SET lifecycle='purged',filename='',detected_media_type=NULL,token=NULL WHERE id=? AND lifecycle='tombstoned'",
          )
          .run(job.target_id);
      }
      this.db
        .prepare(
          "UPDATE attachment_purge_jobs SET state=?,token=NULL,attempts=attempts+1,next_at=?,error=? WHERE id=? AND token=?",
        )
        .run(state, next, code, job.id, job.token);
    });
  }
  objectSettlement(c: AttachmentContent) {
    return this.db
      .prepare(
        "SELECT state,mutation,write_uncertain,put_admitted FROM object_storage_objects WHERE id=? AND owner=? AND sha256=? AND size=?",
      )
      .get(c.handle_id, c.generation_id, c.sha256, c.size);
  }
  discardUnstarted(c: AttachmentContent) {
    return this.write(() => {
      const current = this.db
        .prepare(
          "SELECT ever_dispatched,lifecycle,token FROM attachment_contents WHERE id=?",
        )
        .get(c.id)!;
      if (
        current.ever_dispatched ||
        current.lifecycle !== "tombstoned" ||
        current.token
      )
        throw new AttachmentError("attachment_busy", 429);
      this.objectStore().discardUnstarted(this.handle(c), true);
    });
  }
  diagnostics() {
    return {
      contents: this.db
        .prepare(
          "SELECT lifecycle,transfer,count(*) AS count,coalesce(sum(size),0) AS bytes FROM attachment_contents GROUP BY lifecycle,transfer",
        )
        .all(),
      cleanup: this.db
        .prepare(
          "SELECT state,count(*) AS count,min(created_at) AS oldest FROM attachment_purge_jobs WHERE state!='done' GROUP BY state",
        )
        .all(),
    };
  }
  recover() {
    this.write(() => {
      // A prior verified original under local comparison has not admitted a new PUT.
      // Retire only that comparison token; unresolved/initial writes follow normal recovery.
      this.db.exec(
        "UPDATE attachment_contents SET token=NULL,received=size,failure=NULL WHERE token IS NOT NULL AND transfer='complete' AND EXISTS (SELECT 1 FROM object_storage_objects r WHERE r.id=attachment_contents.handle_id AND r.owner=attachment_contents.generation_id AND r.sha256=attachment_contents.sha256 AND r.size=attachment_contents.size AND r.state='retained' AND r.mutation='idle' AND r.write_uncertain=0)",
      );
      this.db.exec(
        "UPDATE attachment_purge_jobs SET state='retry',token=NULL WHERE state='running'; UPDATE attachment_attempts SET state='unknown',failure='attachment_retry_required',token=NULL WHERE handoff_id IS NOT NULL AND state IN ('handoff_started','preparing'); UPDATE attachment_contents SET token=NULL,transfer=CASE WHEN ever_dispatched=1 THEN 'unverified' ELSE 'retryable_failure' END WHERE token IS NOT NULL; UPDATE attachment_contents SET transfer='quarantined',failure='attachment_uncertain' WHERE handle_id IN (SELECT id FROM object_storage_objects WHERE write_uncertain=1);",
      );
    });
  }
}
