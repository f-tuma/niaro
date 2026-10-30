import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { MemoryActor } from "./memory";
import {
  profileDigest,
  type ProfileProgress,
  type ProfileSourceRef,
} from "./profile-material";
import type { InferenceCheckpoint } from "./inference-budget";
import type { TransportResponse } from "../server-integrations/transport";

const ownerKey = (actor: MemoryActor) =>
  JSON.stringify([actor.organizationId, actor.workspaceId, actor.userId]);
export type ProfileCursor = {
  owner: string;
  progress: ProfileProgress;
  dirty: number;
  processed: number;
  runAfter: number;
  failures: number;
  token: string | null;
  generation: number;
  leaseUntil: number;
  deadline: number;
  privacy: number;
};
export type ProfileBatch = {
  id: string;
  owner: string;
  identity: string;
  root: string;
  inputDigest: string;
  privacy: number;
  state: string;
  next: ProfileProgress;
  createdAt: number;
  window: { progress: ProfileProgress; refs: ProfileSourceRef[] };
};
export type ProfileCall = {
  batchId: string;
  ordinal: number;
  attemptId: string;
  state: string;
  ciphertext: string | null;
  expiresAt: number;
};
/** All methods are synchronous and called in the existing identity queue. No content in cursors/indexes. */
export class ProfileCursorStore {
  private key: Buffer;
  constructor(
    private db: DatabaseSync,
    secret: string,
    private now = Date.now,
  ) {
    this.key = Buffer.from(
      hkdfSync(
        "sha256",
        secret,
        "niaro-private-profile",
        "profile-response-checkpoint/v1",
        32,
      ),
    );
    db.exec(`CREATE TABLE IF NOT EXISTS agent_profile_cursor (
      owner TEXT PRIMARY KEY, organization_id TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES agent_workspace(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL, chat INTEGER NOT NULL DEFAULT 0,chat_offset INTEGER NOT NULL DEFAULT 0,
      meeting INTEGER NOT NULL DEFAULT 0,meeting_offset INTEGER NOT NULL DEFAULT 0,
      dirty INTEGER NOT NULL DEFAULT 0,processed INTEGER NOT NULL DEFAULT 0,run_after INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0,token TEXT,generation INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0,
      deadline INTEGER NOT NULL DEFAULT 0,privacy INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE TABLE IF NOT EXISTS agent_profile_batch (
      id TEXT PRIMARY KEY,owner TEXT NOT NULL REFERENCES agent_profile_cursor(owner) ON DELETE CASCADE,
      identity TEXT NOT NULL,root TEXT NOT NULL UNIQUE,input_digest TEXT NOT NULL,privacy INTEGER NOT NULL,
      state TEXT NOT NULL,next_progress TEXT NOT NULL,created_at INTEGER NOT NULL,window TEXT NOT NULL,UNIQUE(owner,identity)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS agent_profile_one_pending ON agent_profile_batch(owner) WHERE state<>'committed';
    CREATE TABLE IF NOT EXISTS agent_profile_call (
      batch_id TEXT NOT NULL REFERENCES agent_profile_batch(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL CHECK(ordinal IN (1,2)),
      attempt_id TEXT NOT NULL UNIQUE,state TEXT NOT NULL,ciphertext TEXT,expires_at INTEGER NOT NULL,
      PRIMARY KEY(batch_id,ordinal)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS agent_profile_response_expiry ON agent_profile_call(expires_at) WHERE ciphertext IS NOT NULL;`);
    db.exec(`CREATE TABLE IF NOT EXISTS agent_profile_unpaid_root (
      root TEXT PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES agent_profile_batch(id) ON DELETE CASCADE,
      retired_at INTEGER NOT NULL,metadata TEXT NOT NULL CHECK(json_valid(metadata))
    ) STRICT;`);
    const columns = new Set(
      db
        .prepare("PRAGMA table_info(agent_profile_cursor)")
        .all()
        .map((row) => String(row.name)),
    );
    for (const column of ["chat_projection", "meeting_projection"])
      if (!columns.has(column))
        db.exec(`ALTER TABLE agent_profile_cursor ADD COLUMN ${column} TEXT`);
    this.expireResponses();
  }
  ensure(actor: MemoryActor) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO agent_profile_cursor(owner,organization_id,workspace_id,user_id) VALUES(?,?,?,?)",
      )
      .run(
        ownerKey(actor),
        actor.organizationId,
        actor.workspaceId,
        actor.userId,
      );
    return this.read(actor);
  }
  read(actor: MemoryActor): ProfileCursor {
    const row = this.db
      .prepare("SELECT * FROM agent_profile_cursor WHERE owner=?")
      .get(ownerKey(actor));
    if (!row) throw Error("profile_cursor_missing");
    return {
      owner: String(row.owner),
      progress: {
        chat: Number(row.chat),
        chatOffset: Number(row.chat_offset),
        meeting: Number(row.meeting),
        meetingOffset: Number(row.meeting_offset),
        ...(row.chat_projection === null
          ? {}
          : { chatProjection: String(row.chat_projection) }),
        ...(row.meeting_projection === null
          ? {}
          : { meetingProjection: String(row.meeting_projection) }),
      },
      dirty: Number(row.dirty),
      processed: Number(row.processed),
      runAfter: Number(row.run_after),
      failures: Number(row.failures),
      token: row.token === null ? null : String(row.token),
      generation: Number(row.generation),
      leaseUntil: Number(row.lease_until),
      deadline: Number(row.deadline),
      privacy: Number(row.privacy),
    };
  }
  markDirty(actor: MemoryActor) {
    this.ensure(actor);
    this.db
      .prepare("UPDATE agent_profile_cursor SET dirty=dirty+1 WHERE owner=?")
      .run(ownerKey(actor));
  }
  discover(actor: MemoryActor, type: "chat" | "meeting", sequence: number) {
    const cursor = this.ensure(actor);
    if (sequence > cursor.progress[type] && cursor.dirty === cursor.processed)
      this.markDirty(actor);
  }
  candidates(limit = 4): MemoryActor[] {
    return this.db
      .prepare(
        `SELECT organization_id,workspace_id,user_id FROM agent_profile_cursor
      WHERE dirty>processed AND run_after<=? AND lease_until<=? ORDER BY run_after,owner LIMIT ?`,
      )
      .all(this.now(), this.now(), Math.max(1, Math.min(4, limit)))
      .map((row) => ({
        organizationId: String(row.organization_id),
        workspaceId: String(row.workspace_id),
        userId: String(row.user_id),
        canManageShared: false,
      }));
  }
  acquire(actor: MemoryActor): ProfileCursor | null {
    const cursor = this.ensure(actor),
      now = this.now();
    if (
      cursor.dirty <= cursor.processed ||
      cursor.runAfter > now ||
      cursor.leaseUntil > now
    )
      return null;
    const token = randomUUID();
    this.db
      .prepare(
        "UPDATE agent_profile_cursor SET token=?,generation=generation+1,lease_until=?,deadline=?,run_after=? WHERE owner=?",
      )
      .run(token, now + 180000, now + 120000, now + 600000, cursor.owner);
    return this.read(actor);
  }
  check(actor: MemoryActor, lease: ProfileCursor) {
    const current = this.read(actor);
    if (
      current.token !== lease.token ||
      current.generation !== lease.generation ||
      current.leaseUntil <= this.now() ||
      lease.deadline <= this.now()
    )
      throw Error("profile_lease_expired");
  }
  finish(
    actor: MemoryActor,
    lease: ProfileCursor,
    next: ProfileProgress,
    more: boolean,
  ) {
    this.check(actor, lease);
    this.db
      .prepare(
        `UPDATE agent_profile_cursor SET chat=?,chat_offset=?,meeting=?,meeting_offset=?,chat_projection=?,meeting_projection=?,processed=?,
      dirty=CASE WHEN ? THEN MAX(dirty,?+1) ELSE dirty END,token=NULL,lease_until=0,failures=0 WHERE owner=?`,
      )
      .run(
        next.chat,
        next.chatOffset,
        next.meeting,
        next.meetingOffset,
        next.chatProjection ?? null,
        next.meetingProjection ?? null,
        lease.dirty,
        Number(more),
        lease.dirty,
        lease.owner,
      );
  }
  defer(actor: MemoryActor, lease: ProfileCursor, failed: boolean) {
    const current = this.read(actor);
    if (
      current.token !== lease.token ||
      current.generation !== lease.generation
    )
      return;
    const failures = Math.min(2, current.failures + Number(failed));
    this.db
      .prepare(
        "UPDATE agent_profile_cursor SET token=NULL,lease_until=0,failures=?,run_after=? WHERE owner=?",
      )
      .run(
        failures,
        this.now() + (failed ? (failures === 1 ? 3600000 : 21600000) : 600000),
        lease.owner,
      );
  }
  pending(actor: MemoryActor): ProfileBatch | null {
    const row = this.db
      .prepare(
        "SELECT * FROM agent_profile_batch WHERE owner=? AND state<>'committed'",
      )
      .get(ownerKey(actor));
    return row
      ? {
          id: String(row.id),
          owner: String(row.owner),
          identity: String(row.identity),
          root: String(row.root),
          inputDigest: String(row.input_digest),
          privacy: Number(row.privacy),
          state: String(row.state),
          next: JSON.parse(String(row.next_progress)),
          createdAt: Number(row.created_at),
          window: JSON.parse(String(row.window)),
        }
      : null;
  }
  bind(
    actor: MemoryActor,
    lease: ProfileCursor,
    window: ProfileBatch["window"],
    inputDigest: string,
    next: ProfileProgress,
    proveUnpaid?: (batch: ProfileBatch) => boolean,
  ): ProfileBatch {
    this.check(actor, lease);
    const identity = profileDigest({
        progress: window.progress,
        refs: window.refs.map(({ sourceVersion: _, ...ref }) => ref),
      }),
      pending = this.pending(actor);
    if (pending) {
      let current = pending;
      if (
        pending.state !== "unpaid_replan" &&
        (pending.identity !== identity ||
          pending.inputDigest !== inputDigest ||
          pending.privacy !== this.read(actor).privacy)
      ) {
        if (proveUnpaid?.(pending))
          current = this.replanUnpaid(actor, lease, pending, () =>
            proveUnpaid(pending),
          );
        else {
          this.scrubBatch(pending.id, "unusable");
          throw Error("profile_pending_input_changed");
        }
      }
      if (current.state === "unpaid_replan") {
        this.db
          .prepare(
            "UPDATE agent_profile_batch SET identity=?,input_digest=?,privacy=?,state='prepared',next_progress=?,window=? WHERE id=?",
          )
          .run(
            identity,
            inputDigest,
            this.read(actor).privacy,
            JSON.stringify(next),
            JSON.stringify(window),
            current.id,
          );
        return this.pending(actor)!;
      }
      this.db
        .prepare("UPDATE agent_profile_batch SET window=? WHERE id=?")
        .run(JSON.stringify(window), pending.id);
      return { ...pending, window };
    }
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO agent_profile_batch VALUES(?,?,?,?,?,?, 'prepared',?,?,?)",
      )
      .run(
        id,
        lease.owner,
        identity,
        `profile/${actor.userId}/${id}`,
        inputDigest,
        lease.privacy,
        JSON.stringify(next),
        this.now(),
        JSON.stringify(window),
      );
    return this.pending(actor)!;
  }
  /** Caller holds the identity queue and a transaction; old cancelled ledger rows are retained. */
  replanUnpaid(
    actor: MemoryActor,
    lease: ProfileCursor,
    batch: ProfileBatch,
    prove: () => boolean,
  ) {
    this.check(actor, lease);
    const current = this.pending(actor),
      calls = this.calls(batch);
    if (
      !current ||
      current.id !== batch.id ||
      current.root !== batch.root ||
      !prove() ||
      calls.some(
        (call) =>
          !["reserved", "unpaid"].includes(call.state) ||
          call.ciphertext !== null,
      )
    )
      throw Error("profile_unpaid_proof_required");
    this.db
      .prepare("INSERT INTO agent_profile_unpaid_root VALUES(?,?,?,?)")
      .run(
        current.root,
        current.id,
        this.now(),
        JSON.stringify({
          identity: current.identity,
          inputDigest: current.inputDigest,
          privacy: current.privacy,
          window: current.window,
          calls,
        }),
      );
    this.db
      .prepare("DELETE FROM agent_profile_call WHERE batch_id=?")
      .run(current.id);
    this.db
      .prepare(
        "UPDATE agent_profile_batch SET root=?,identity=?,input_digest='',privacy=?,state='unpaid_replan',next_progress=?,window=?,created_at=? WHERE id=?",
      )
      .run(
        `profile/${actor.userId}/${randomUUID()}`,
        `unpaid-replan/${current.id}`,
        this.read(actor).privacy,
        JSON.stringify(lease.progress),
        JSON.stringify({ progress: lease.progress, refs: [] }),
        this.now(),
        current.id,
      );
    return this.pending(actor)!;
  }
  calls(batch: ProfileBatch): ProfileCall[] {
    return this.db
      .prepare(
        "SELECT * FROM agent_profile_call WHERE batch_id=? ORDER BY ordinal",
      )
      .all(batch.id)
      .map((row) => ({
        batchId: batch.id,
        ordinal: Number(row.ordinal),
        attemptId: String(row.attempt_id),
        state: String(row.state),
        ciphertext: row.ciphertext === null ? null : String(row.ciphertext),
        expiresAt: Number(row.expires_at),
      }));
  }
  /** Real commit before the transport start callback; nesting would violate that guarantee. */
  atomic<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private aad(batch: ProfileBatch, ordinal: number, expiresAt: number) {
    return Buffer.from(
      JSON.stringify([
        "profile-response-checkpoint/v1",
        batch.owner,
        batch.id,
        batch.root,
        ordinal,
        batch.inputDigest,
        batch.privacy,
        expiresAt,
      ]),
    );
  }
  checkpoint(
    actor: MemoryActor,
    batch: ProfileBatch,
    ordinal: 1 | 2,
    ttlMs: number,
  ): InferenceCheckpoint {
    const owner = ownerKey(actor);
    const bound = () => {
      const current = this.pending(actor);
      if (
        !current ||
        current.id !== batch.id ||
        current.owner !== owner ||
        current.root !== batch.root ||
        current.inputDigest !== batch.inputDigest
      )
        throw Error("profile_batch_changed");
      return current;
    };
    const exact = (id: string) => {
      const row = this.calls(batch).find(
        (call) => call.ordinal === ordinal && call.attemptId === id,
      );
      if (!row) throw Error("profile_call_changed");
      return row;
    };
    return {
      profileCancelledCredit: true,
      atomic: (run) => this.atomic(run),
      reserved: (id) => {
        const current = bound();
        if (
          current.state === "unusable" ||
          current.privacy !== this.read(actor).privacy
        )
          throw Error("profile_privacy_changed");
        const calls = this.calls(batch),
          old = calls.find((call) => call.ordinal === ordinal);
        if (old && old.state !== "unpaid")
          throw Error("profile_call_already_bound");
        if (ordinal === 2 && calls[0]?.state !== "invalid")
          throw Error("profile_repair_forbidden");
        this.db
          .prepare(
            `INSERT INTO agent_profile_call VALUES(?,?,?,'reserved',NULL,0)
        ON CONFLICT(batch_id,ordinal) DO UPDATE SET attempt_id=excluded.attempt_id,state='reserved',ciphertext=NULL,expires_at=0`,
          )
          .run(batch.id, ordinal, id);
      },
      dispatched: (id) => {
        const current = bound();
        if (
          current.state === "unusable" ||
          current.privacy !== batch.privacy ||
          current.privacy !== this.read(actor).privacy
        )
          throw Error("profile_privacy_changed");
        const call = exact(id);
        if (call.state !== "reserved") throw Error("profile_dispatch_changed");
        this.db
          .prepare(
            "UPDATE agent_profile_call SET state='dispatched' WHERE attempt_id=?",
          )
          .run(id);
        this.db
          .prepare(
            "UPDATE agent_profile_batch SET state='dispatched' WHERE id=?",
          )
          .run(batch.id);
      },
      received: (id, response) => {
        const current = bound(),
          call = exact(id);
        if (!["dispatched", "unknown_response"].includes(call.state))
          throw Error("profile_response_changed");
        if (
          current.state === "unusable" ||
          current.privacy !== this.read(actor).privacy
        ) {
          this.scrubBatch(batch.id, "unusable");
          return;
        }
        if (response.status < 200 || response.status >= 300) {
          const state = [408, 504, 524].includes(response.status)
            ? "unknown_response"
            : "unpaid";
          this.db
            .prepare(
              "UPDATE agent_profile_call SET state=?,ciphertext=NULL WHERE attempt_id=?",
            )
            .run(state, id);
          this.db
            .prepare("UPDATE agent_profile_batch SET state=? WHERE id=?")
            .run(state, batch.id);
          return;
        }
        const raw = JSON.stringify({
          status: response.status,
          headers: {},
          text: response.text,
        });
        if (Buffer.byteLength(raw) > 32768) {
          this.scrubBatch(batch.id, "unusable");
          return;
        }
        const expiresAt = this.now() + Math.min(86400000, ttlMs);
        const nonce = randomBytes(12),
          cipher = createCipheriv("aes-256-gcm", this.key, nonce);
        cipher.setAAD(this.aad(batch, ordinal, expiresAt));
        // Tag is available only after final().
        const encrypted = Buffer.concat([
          cipher.update(raw, "utf8"),
          cipher.final(),
        ]);
        const sealed = Buffer.concat([
          nonce,
          cipher.getAuthTag(),
          encrypted,
        ]).toString("base64");
        this.db
          .prepare(
            "UPDATE agent_profile_call SET state='received',ciphertext=?,expires_at=? WHERE attempt_id=?",
          )
          .run(sealed, expiresAt, id);
        this.db
          .prepare("UPDATE agent_profile_batch SET state='received' WHERE id=?")
          .run(batch.id);
      },
      failed: (id) => {
        bound();
        const call = exact(id);
        if (call.state === "reserved")
          this.db
            .prepare(
              "UPDATE agent_profile_call SET state='unpaid' WHERE attempt_id=?",
            )
            .run(id);
        else if (call.state === "dispatched") {
          this.db
            .prepare(
              "UPDATE agent_profile_call SET state='unknown_response' WHERE attempt_id=?",
            )
            .run(id);
          this.db
            .prepare(
              "UPDATE agent_profile_batch SET state='unknown_response' WHERE id=?",
            )
            .run(batch.id);
        }
      },
    };
  }
  response(
    actor: MemoryActor,
    batch: ProfileBatch,
    call: ProfileCall,
  ): TransportResponse | null {
    if (call.state !== "received" || !call.ciphertext) return null;
    if (
      call.expiresAt <= this.now() ||
      batch.privacy !== this.read(actor).privacy ||
      this.pending(actor)?.state === "unusable"
    ) {
      this.scrubBatch(batch.id, "unusable");
      return null;
    }
    try {
      const raw = Buffer.from(call.ciphertext, "base64");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        raw.subarray(0, 12),
      );
      decipher.setAAD(this.aad(batch, call.ordinal, call.expiresAt));
      decipher.setAuthTag(raw.subarray(12, 28));
      const text = Buffer.concat([
        decipher.update(raw.subarray(28)),
        decipher.final(),
      ]);
      if (text.length > 32768) throw Error("profile_checkpoint_limit");
      return JSON.parse(text.toString("utf8"));
    } catch {
      this.scrubBatch(batch.id, "unusable");
      return null;
    }
  }
  invalid(batch: ProfileBatch, ordinal: number) {
    this.db
      .prepare(
        "UPDATE agent_profile_call SET state='invalid',ciphertext=NULL WHERE batch_id=? AND ordinal=? AND state='received'",
      )
      .run(batch.id, ordinal);
  }
  unpaid(batch: ProfileBatch, ordinal: number) {
    this.db
      .prepare(
        "UPDATE agent_profile_call SET state='unpaid' WHERE batch_id=? AND ordinal=? AND state='reserved'",
      )
      .run(batch.id, ordinal);
  }
  committed(
    actor: MemoryActor,
    lease: ProfileCursor,
    batch: ProfileBatch,
    more: boolean,
  ) {
    this.check(actor, lease);
    const current = this.pending(actor);
    if (
      current?.id !== batch.id ||
      current.root !== batch.root ||
      current.inputDigest !== batch.inputDigest ||
      current.privacy !== batch.privacy ||
      current.privacy !== this.read(actor).privacy ||
      current.state === "unusable"
    )
      throw Error("profile_batch_changed");
    this.db
      .prepare("UPDATE agent_profile_batch SET state='committed' WHERE id=?")
      .run(batch.id);
    this.db
      .prepare("UPDATE agent_profile_call SET ciphertext=NULL WHERE batch_id=?")
      .run(batch.id);
    this.finish(actor, lease, batch.next, more);
  }
  private scrubBatch(id: string, state: string) {
    this.db
      .prepare("UPDATE agent_profile_call SET ciphertext=NULL WHERE batch_id=?")
      .run(id);
    this.db
      .prepare(
        "UPDATE agent_profile_batch SET state=? WHERE id=? AND state<>'committed'",
      )
      .run(state, id);
  }
  /** Bounded metadata-only maintenance, independent of owner/model admission. */
  expireResponses(limit = 100) {
    const rows = this.db
      .prepare(
        "SELECT DISTINCT batch_id FROM agent_profile_call WHERE ciphertext IS NOT NULL AND expires_at<=? LIMIT ?",
      )
      .all(this.now(), Math.max(1, Math.min(100, limit)));
    for (const row of rows) this.scrubBatch(String(row.batch_id), "unusable");
    return rows.length;
  }
  privacyMutation(actor: MemoryActor) {
    this.ensure(actor);
    this.db
      .prepare(
        "UPDATE agent_profile_cursor SET privacy=privacy+1 WHERE owner=?",
      )
      .run(ownerKey(actor));
    const pending = this.pending(actor);
    if (pending) this.scrubBatch(pending.id, "unusable");
  }
  scrub(actor: MemoryActor) {
    const batch = this.pending(actor);
    if (batch) this.scrubBatch(batch.id, "unusable");
  }
}
