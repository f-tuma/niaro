import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  MemoryContentSchema,
  MemoryItemSchema,
  MemoryKindSchema,
  MemoryScopeSchema,
  MemorySettingsSchema,
  MemorySourceSchema,
  type MemoryItem,
  type MemorySettings,
  type MemorySource,
} from "../../packages/protocol/memory";
import { IdentityId } from "../../packages/protocol/identity";
import { IdentityError } from "./error";
import { pathToFileURL } from "node:url";
import type { NativeSavedMemory } from "../server-agent/saved-memory";
import {
  MemoryPayloadCrypto,
  memoryCipherDigest,
  type MemoryPayload,
  type MemoryPayloadBinding,
} from "./memory-payload-crypto";

/** This actor is constructed from authenticated identity, never from a tool or request payload. */
export type MemoryActor = {
  organizationId: string;
  workspaceId: string;
  userId: string;
  canManageShared: boolean;
};
export const MEMORY_SOURCE_TTL = 30 * 60 * 1000;
const actorSchema = z.strictObject({
  organizationId: IdentityId,
  workspaceId: IdentityId,
  userId: IdentityId,
  canManageShared: z.boolean(),
});
const requestSchema = z.strictObject({ requestId: IdentityId });
const rememberSchema = requestSchema.extend({
  content: MemoryContentSchema,
  kind: MemoryKindSchema,
  scope: MemoryScopeSchema.default("private"),
  source: MemorySourceSchema,
  /** Set only after the server establishes an explicit user request to remember. */
  explicitIntent: z.boolean(),
  /** Extracted/inferred material remains a candidate even when the user enabled memory. */
  derived: z.boolean().default(false),
  settings: MemorySettingsSchema,
});
export type RememberMemoryInput = z.input<typeof rememberSchema>;
const reviseSchema = requestSchema.extend({
  id: IdentityId,
  revision: z.number().int().positive(),
  content: MemoryContentSchema,
  /** Exact old content from a trusted chat instruction; also binds its retry. */
  expectedContent: MemoryContentSchema.optional(),
  source: MemorySourceSchema,
  explicitIntent: z.boolean(),
  settings: MemorySettingsSchema,
});
export type ReviseMemoryInput = z.input<typeof reviseSchema>;
const forgetSchema = requestSchema.extend({
  id: IdentityId,
  revision: z.number().int().positive(),
});
type Row = {
  id: string;
  organization_id: string;
  workspace_id: string;
  user_id: string;
  scope: "private" | "workspace";
  kind: MemoryItem["kind"];
  status: MemoryItem["status"];
  revision: number;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  supersedes_id: string | null;
  lineage_id: string;
  native_ref: string | null;
  native_resource: string | null;
  native_digest: string | null;
  publication: "staged" | "published" | "erase_pending" | "erased";
  base_version: number;
};
export type MemorySourceAccess = (
  source: MemorySource,
  actor: MemoryActor,
) => boolean;
export type MemoryReadOptions = {
  settings?: MemorySettings;
  run?: <T>(fn: () => T) => Promise<T>;
  /** Current service access + operation TTL must be checked on every read, including list views. */
  sourceAccess?: MemorySourceAccess;
};
export type MemoryContext = {
  version: number;
  items: MemoryItem[];
  contextChars: number;
  expiresAt: string | null;
};

export type MemoryCommit = {
  check?: () => void;
  checkpoint?: (item: MemoryItem) => void;
  revoked?: (item: MemoryItem) => void;
  source?: "chat" | "console";
  run?: <T>(fn: () => T) => Promise<T>;
};
type MemoryOptions = {
  run?: <T>(fn: () => T) => Promise<T>;
  now?: () => number;
  sourceTtlMs?: number;
  secret?: string;
  native?: NativeSavedMemory;
  nativeStorageUrl?: string;
  onMutation?: (
    actor: MemoryActor,
    action: "remember" | "revise" | "forget" | "preference",
    source: "chat" | "console",
  ) => void;
};
const payloadOwners = new WeakMap<
  DatabaseSync,
  Map<string, Promise<unknown>>
>();
const requestOwners = new WeakMap<
  DatabaseSync,
  Map<string, Promise<unknown>>
>();
export function assertNativeMemoryFormat(db: DatabaseSync) {
  if (
    db
      .prepare("PRAGMA table_info(agent_memory)")
      .all()
      .some((column) => column.name === "content") &&
    Number(
      db.prepare("SELECT count(*) AS count FROM agent_memory").get()?.count,
    )
  )
    throw Error("memory_copied_tuple_migration_required");
}
const nativeOwners = new WeakMap<DatabaseSync, Promise<NativeSavedMemory>>();

/**
 * Policy capture and publication run in IdentityService's queue; native payload I/O runs outside it.
 * Lexical retrieval scans at most 2,000 scoped active records; it never searches another tenant.
 * Entries are evidence/data, including user notes, and never authority to invoke tools.
 */
export class MemoryStore {
  private now: () => number;
  private sourceTtlMs: number;
  private crypto: MemoryPayloadCrypto;
  private nativePromise?: Promise<NativeSavedMemory>;
  private nativeStorageUrl: string;
  private get native(): Promise<NativeSavedMemory> {
    if (!this.nativePromise) {
      this.nativePromise =
        nativeOwners.get(this.db) ??
        import("@niaro/server-agent").then((module) =>
          module.createNativeSavedMemory(this.nativeStorageUrl),
        );
      nativeOwners.set(this.db, this.nativePromise);
    }
    return this.nativePromise;
  }
  constructor(
    private db: DatabaseSync,
    private options: MemoryOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.sourceTtlMs = options.sourceTtlMs ?? MEMORY_SOURCE_TTL;
    if (!Number.isSafeInteger(this.sourceTtlMs) || this.sourceTtlMs < 1)
      throw Error("Invalid memory source TTL");
    const file = db
      .prepare("PRAGMA database_list")
      .all()
      .find((row) => row.name === "main")?.file;
    if (file && !options.secret) throw Error("memory_original_secret_required");
    assertNativeMemoryFormat(db);
    const columns = db.prepare("PRAGMA table_info(agent_memory)").all();
    if (columns.some((column) => column.name === "content")) {
      if (
        Number(
          db.prepare("SELECT count(*) AS count FROM agent_memory").get()?.count,
        )
      )
        throw Error("memory_copied_tuple_migration_required");
      db.exec("DROP TABLE agent_memory");
    }
    this.crypto = new MemoryPayloadCrypto(
      options.secret ?? "NIARO TEST in-memory saved-memory key",
    );
    this.nativeStorageUrl =
      options.nativeStorageUrl ??
      (file ? pathToFileURL(`${file}.mastra.sqlite`).href : ":memory:");
    if (options.native) {
      this.nativePromise = Promise.resolve(options.native);
      nativeOwners.set(db, this.nativePromise);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_memory (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES agent_workspace(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
        scope TEXT NOT NULL CHECK(scope IN ('private','workspace')),
        kind TEXT NOT NULL CHECK(kind IN ('preference','fact','note')),
        status TEXT NOT NULL CHECK(status IN ('candidate','active','superseded','deleted')),
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT,
        supersedes_id TEXT, lineage_id TEXT NOT NULL,
        native_ref TEXT, native_resource TEXT, native_digest TEXT,
        publication TEXT NOT NULL CHECK(publication IN ('staged','published','erase_pending','erased')),
        base_version INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS agent_memory_scope ON agent_memory
        (organization_id,workspace_id,scope,user_id,status,updated_at);
      CREATE INDEX IF NOT EXISTS agent_memory_lineage ON agent_memory
        (organization_id,workspace_id,lineage_id);
      CREATE TABLE IF NOT EXISTS agent_memory_version (
        organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
        workspace_id TEXT PRIMARY KEY REFERENCES agent_workspace(id) ON DELETE CASCADE,
        version INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS agent_memory_preference (
        organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES agent_workspace(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
        opt_out INTEGER NOT NULL CHECK(opt_out IN (0,1)),
        PRIMARY KEY(organization_id,workspace_id,user_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS agent_memory_request (
        organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES agent_workspace(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,kind TEXT NOT NULL,fingerprint TEXT,memory_id TEXT,opt_out INTEGER,
        state TEXT NOT NULL DEFAULT 'committed' CHECK(state IN ('staged','committed','erasing')),
        PRIMARY KEY(organization_id,workspace_id,user_id,request_id)
      ) STRICT;
    `);
    if (
      !db
        .prepare("PRAGMA table_info(agent_memory_request)")
        .all()
        .some((column) => column.name === "state")
    )
      db.exec(
        "ALTER TABLE agent_memory_request ADD COLUMN state TEXT NOT NULL DEFAULT 'committed'",
      );
  }
  private gate<T>(
    commit: { run?: <R>(fn: () => R) => Promise<R> },
    fn: () => T,
  ): Promise<T> {
    return commit.run
      ? commit.run(fn)
      : this.options.run
        ? this.options.run(fn)
        : Promise.resolve().then(fn);
  }
  private serialRequest<T>(
    actor: MemoryActor,
    requestId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const owners =
      requestOwners.get(this.db) ?? new Map<string, Promise<unknown>>();
    requestOwners.set(this.db, owners);
    const key = JSON.stringify([
      actor.organizationId,
      actor.workspaceId,
      actor.userId,
      requestId,
    ]);
    const previous = owners.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(fn);
    owners.set(key, result);
    void result
      .finally(() => {
        if (owners.get(key) === result) owners.delete(key);
      })
      .catch(() => undefined);
    return result;
  }
  private serialPayload<T>(
    reference: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const owners =
      payloadOwners.get(this.db) ?? new Map<string, Promise<unknown>>();
    payloadOwners.set(this.db, owners);
    const previous = owners.get(reference) ?? Promise.resolve(),
      result = previous.catch(() => undefined).then(fn);
    owners.set(reference, result);
    void result
      .finally(() => {
        if (owners.get(reference) === result) owners.delete(reference);
      })
      .catch(() => undefined);
    return result;
  }
  remember(
    actor: MemoryActor,
    input: RememberMemoryInput,
    commit: MemoryCommit = {},
  ) {
    return this.serialRequest(actor, input.requestId, () =>
      this.rememberImpl(actor, input, commit),
    );
  }
  revise(
    actor: MemoryActor,
    input: ReviseMemoryInput,
    checkpoint?: (item: MemoryItem) => void,
    sourceAccess?: MemorySourceAccess,
    commit: MemoryCommit = {},
  ) {
    return this.serialRequest(actor, input.requestId, () =>
      this.reviseImpl(actor, input, checkpoint, sourceAccess, commit),
    );
  }
  forget(
    actor: MemoryActor,
    input: z.input<typeof forgetSchema>,
    commit: MemoryCommit = {},
  ) {
    return this.serialRequest(actor, input.requestId, () =>
      this.forgetImpl(actor, input, commit),
    );
  }
  private actor(raw: MemoryActor) {
    const actor = actorSchema.parse(raw);
    if (
      !this.db
        .prepare(
          "SELECT 1 FROM agent_workspace WHERE id=? AND organization_id=?",
        )
        .get(actor.workspaceId, actor.organizationId)
    )
      throw new IdentityError(404, "memory_not_found");
    return actor;
  }
  private atomic<T>(run: () => T): T {
    this.db.exec("SAVEPOINT memory_mutation");
    try {
      const result = run();
      this.db.exec("RELEASE memory_mutation");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK TO memory_mutation; RELEASE memory_mutation");
      throw error;
    }
  }
  private bump(actor: MemoryActor) {
    this.db
      .prepare(
        `INSERT INTO agent_memory_version VALUES (?,?,1)
      ON CONFLICT(workspace_id) DO UPDATE SET version=version+1`,
      )
      .run(actor.organizationId, actor.workspaceId);
  }
  version(raw: MemoryActor) {
    const actor = this.actor(raw);
    return Number(
      this.db
        .prepare(
          "SELECT version FROM agent_memory_version WHERE organization_id=? AND workspace_id=?",
        )
        .get(actor.organizationId, actor.workspaceId)?.version ?? 0,
    );
  }
  isCurrent(actor: MemoryActor, version: number, expiresAt?: string | null) {
    return (
      this.version(actor) === version &&
      (expiresAt == null || Date.parse(expiresAt) > this.now())
    );
  }
  readPreferences(raw: MemoryActor) {
    const actor = this.actor(raw);
    return {
      optOut: Boolean(
        this.db
          .prepare(
            "SELECT opt_out FROM agent_memory_preference WHERE organization_id=? AND workspace_id=? AND user_id=?",
          )
          .get(actor.organizationId, actor.workspaceId, actor.userId)?.opt_out,
      ),
    };
  }
  private fingerprint(value: unknown) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  }
  private replay(
    actor: MemoryActor,
    requestId: string,
    kind: string,
    fingerprint: string,
  ) {
    const row = this.db
      .prepare(
        `SELECT kind,fingerprint,memory_id,opt_out,state FROM agent_memory_request
      WHERE organization_id=? AND workspace_id=? AND user_id=? AND request_id=?`,
      )
      .get(actor.organizationId, actor.workspaceId, actor.userId, requestId);
    if (!row) return null;
    if (
      row.kind !== kind ||
      (row.fingerprint != null && row.fingerprint !== fingerprint)
    )
      throw new IdentityError(409, "memory_request_conflict");
    return {
      memoryId: row.memory_id == null ? null : String(row.memory_id),
      optOut: Boolean(row.opt_out),
      state: String(row.state),
    };
  }
  private request(
    actor: MemoryActor,
    requestId: string,
    kind: string,
    fingerprint: string | null,
    memoryId: string | null,
    optOut: boolean | null = null,
    state = "committed",
  ) {
    this.db
      .prepare(
        `INSERT INTO agent_memory_request
      (organization_id,workspace_id,user_id,request_id,kind,fingerprint,memory_id,opt_out,state) VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        actor.organizationId,
        actor.workspaceId,
        actor.userId,
        requestId,
        kind,
        fingerprint,
        memoryId,
        optOut == null ? null : Number(optOut),
        state,
      );
  }
  private commitRequest(actor: MemoryActor, requestId: string) {
    this.db
      .prepare(
        "UPDATE agent_memory_request SET state='committed' WHERE organization_id=? AND workspace_id=? AND user_id=? AND request_id=?",
      )
      .run(actor.organizationId, actor.workspaceId, actor.userId, requestId);
  }
  async resultForRequest(
    raw: MemoryActor,
    requestId: string,
    kind: "remember" | "revise" | "forget",
    options: MemoryReadOptions = {},
  ) {
    const actor = this.actor(raw);
    IdentityId.parse(requestId);
    const receipt = this.db
      .prepare(
        `SELECT memory_id,state FROM agent_memory_request
      WHERE organization_id=? AND workspace_id=? AND user_id=? AND request_id=? AND kind=?`,
      )
      .get(
        actor.organizationId,
        actor.workspaceId,
        actor.userId,
        requestId,
        kind,
      );
    if (!receipt?.memory_id || receipt.state === "staged") return null;
    return this.receiptItem(actor, String(receipt.memory_id), options);
  }
  setOptOut(
    raw: MemoryActor,
    rawInput: { requestId: string; optOut: boolean },
  ) {
    const actor = this.actor(raw),
      input = requestSchema.extend({ optOut: z.boolean() }).parse(rawInput);
    const fingerprint = this.fingerprint(input);
    return this.atomic(() => {
      if (this.replay(actor, input.requestId, "preference", fingerprint))
        return this.readPreferences(actor);
      const previous = this.readPreferences(actor);
      if (previous.optOut !== input.optOut) {
        this.db
          .prepare(
            `INSERT INTO agent_memory_preference VALUES (?,?,?,?)
          ON CONFLICT(organization_id,workspace_id,user_id) DO UPDATE SET opt_out=excluded.opt_out`,
          )
          .run(
            actor.organizationId,
            actor.workspaceId,
            actor.userId,
            Number(input.optOut),
          );
        this.bump(actor);
        this.options.onMutation?.(actor, "preference", "console");
      }
      this.request(
        actor,
        input.requestId,
        "preference",
        fingerprint,
        null,
        input.optOut,
      );
      return this.readPreferences(actor);
    });
  }
  private binding(row: Row): MemoryPayloadBinding {
    if (!row.native_ref || !row.native_resource || !row.expires_at)
      throw Error("memory_payload_binding_missing");
    return {
      id: row.id,
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
      userId: row.user_id,
      scope: row.scope,
      threadId: row.native_ref,
      resourceId: row.native_resource,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }
  private deletedItem(row: Row): MemoryItem {
    return MemoryItemSchema.parse({
      id: row.id,
      scope: row.scope,
      kind: row.kind,
      status: "deleted",
      revision: row.revision,
      content: null,
      source: null,
      trust: null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: null,
      supersedesId: null,
    });
  }
  private async payload(row: Row): Promise<MemoryPayload> {
    const binding = this.binding(row),
      ciphertext = await (
        await this.native
      ).read(binding.threadId, binding.resourceId);
    if (!ciphertext || memoryCipherDigest(ciphertext) !== row.native_digest)
      throw new IdentityError(409, "memory_payload_unavailable");
    try {
      return this.crypto.open(ciphertext, binding);
    } catch {
      throw new IdentityError(409, "memory_payload_unavailable");
    }
  }
  private async item(row: Row): Promise<MemoryItem> {
    if (row.status === "deleted") return this.deletedItem(row);
    const payload = await this.payload(row);
    return MemoryItemSchema.parse({
      id: row.id,
      scope: row.scope,
      kind: row.kind,
      status: row.status,
      revision: row.revision,
      ...payload,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
      supersedesId: row.supersedes_id,
    });
  }
  /** A receipt must reflect current policy after native I/O, including erasure. */
  private async receiptItem(
    actor: MemoryActor,
    id: string,
    options: MemoryReadOptions,
    commit: MemoryCommit = {},
  ): Promise<MemoryItem | null> {
    const gate = { run: commit.run ?? options.run };
    const capture = await this.gate(gate, () => {
      commit.check?.();
      return { row: this.row(actor, id), version: this.version(actor) };
    });
    const deleted = async () => {
      await this.cleanup();
      return this.gate(gate, () =>
        this.atomic(() => {
          commit.check?.();
          const current = this.row(actor, id);
          if (current.status !== "deleted" || current.publication !== "erased")
            throw new IdentityError(409, "memory_context_changed");
          const item = this.deletedItem(current);
          commit.checkpoint?.(item);
          return item;
        }),
      );
    };
    if (capture.row.status === "deleted") return deleted();
    let item: MemoryItem;
    try {
      item = await this.item(capture.row);
    } catch (error) {
      const erased = await this.gate(gate, () => {
        commit.check?.();
        return this.row(actor, id).status === "deleted";
      });
      if (erased) return deleted();
      throw error;
    }
    const result = await this.gate(gate, () =>
      this.atomic(() => {
        commit.check?.();
        const current = this.row(actor, id);
        if (current.status === "deleted") return { erased: true } as const;
        if (
          this.version(actor) !== capture.version ||
          JSON.stringify(current) !== JSON.stringify(capture.row) ||
          current.publication !== "published"
        )
          throw new IdentityError(409, "memory_context_changed");
        if (!this.readable(item, actor, options, this.now()))
          return { item: null } as const;
        commit.checkpoint?.(item);
        return { item } as const;
      }),
    );
    return "erased" in result ? deleted() : result.item;
  }
  private row(actor: MemoryActor, id: string) {
    const row = this.db
      .prepare(
        `SELECT * FROM agent_memory WHERE id=? AND organization_id=? AND workspace_id=?
      AND (scope='workspace' OR user_id=?)`,
      )
      .get(id, actor.organizationId, actor.workspaceId, actor.userId) as
      | Row
      | undefined;
    if (!row) throw new IdentityError(404, "memory_not_found");
    return row;
  }
  private mutable(actor: MemoryActor, row: Row, settings?: MemorySettings) {
    if (
      row.scope === "workspace" &&
      (!actor.canManageShared || settings?.allowShared === false)
    )
      throw new IdentityError(403, "memory_shared_forbidden");
  }
  private writable(
    actor: MemoryActor,
    scope: Row["scope"],
    settings: MemorySettings,
  ) {
    if (this.readPreferences(actor).optOut)
      throw new IdentityError(403, "memory_opted_out");
    if (
      scope === "workspace" &&
      (!settings.allowShared || !actor.canManageShared)
    )
      throw new IdentityError(403, "memory_shared_forbidden");
    const count = Number(
      this.db
        .prepare(
          `SELECT count(*) AS count FROM agent_memory
      WHERE organization_id=? AND workspace_id=? AND scope=? AND (scope='workspace' OR user_id=?)
      AND status<>'deleted' AND publication='published'`,
        )
        .get(actor.organizationId, actor.workspaceId, scope, actor.userId)
        ?.count ?? 0,
    );
    if (count >= 2000) throw new IdentityError(429, "memory_capacity");
  }
  private trust(
    source: MemorySource,
    derived: boolean,
  ): MemoryPayload["trust"] {
    return derived
      ? "model_inference"
      : source.type === "verified_operation"
        ? "verified_result"
        : "user_assertion";
  }
  private stage(
    actor: MemoryActor,
    input: z.output<typeof rememberSchema>,
    kind: "remember" | "revise",
    fingerprint: string,
    previous?: Row,
  ) {
    const id = randomUUID(),
      createdAt = this.now(),
      timestamp = new Date(createdAt).toISOString();
    const resource = this.fingerprint([
      "saved-memory/1",
      actor.organizationId,
      actor.workspaceId,
      input.scope,
      input.scope === "private" ? actor.userId : "workspace",
    ]);
    const nativeRef = this.fingerprint(["saved-memory/1", resource, id]);
    const row: Row = {
      id,
      organization_id: actor.organizationId,
      workspace_id: actor.workspaceId,
      user_id: actor.userId,
      scope: input.scope,
      kind: input.kind,
      status: input.derived ? "candidate" : "active",
      revision: 1,
      created_at: timestamp,
      updated_at: timestamp,
      expires_at: new Date(
        createdAt + input.settings.retentionDays * 86400000,
      ).toISOString(),
      supersedes_id: previous?.id ?? null,
      lineage_id: previous?.lineage_id ?? id,
      native_ref: nativeRef,
      native_resource: resource,
      native_digest: null,
      publication: "staged",
      base_version: this.version(actor),
    };
    this.atomic(() => {
      this.db
        .prepare(
          `INSERT INTO agent_memory VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          row.id,
          row.organization_id,
          row.workspace_id,
          row.user_id,
          row.scope,
          row.kind,
          row.status,
          row.revision,
          row.created_at,
          row.updated_at,
          row.expires_at,
          row.supersedes_id,
          row.lineage_id,
          row.native_ref,
          row.native_resource,
          row.native_digest,
          row.publication,
          row.base_version,
        );
      this.request(
        actor,
        input.requestId,
        kind,
        fingerprint,
        id,
        null,
        "staged",
      );
    });
    return row;
  }
  private preparePayload(
    row: Row,
    payload: MemoryPayload,
    commit: MemoryCommit,
  ) {
    return this.serialPayload(row.native_ref!, () =>
      this.preparePayloadLocked(row, payload, commit),
    );
  }
  private async preparePayloadLocked(
    row: Row,
    payload: MemoryPayload,
    commit: MemoryCommit,
  ) {
    const native = await this.native,
      binding = this.binding(row);
    let ciphertext = await native.read(binding.threadId, binding.resourceId);
    if (ciphertext) {
      if (
        memoryCipherDigest(ciphertext) !== row.native_digest ||
        JSON.stringify(this.crypto.open(ciphertext, binding)) !==
          JSON.stringify(payload)
      )
        throw new IdentityError(409, "memory_payload_unavailable");
    } else {
      ciphertext = this.crypto.seal(payload, binding);
      row.native_digest = memoryCipherDigest(ciphertext);
      await this.gate(commit, () =>
        this.atomic(() => {
          commit.check?.();
          if (
            this.db
              .prepare(
                "UPDATE agent_memory SET native_digest=? WHERE id=? AND publication='staged' AND status<>'deleted'",
              )
              .run(row.native_digest, row.id).changes !== 1
          )
            throw new IdentityError(409, "memory_conflict");
        }),
      );
      await native.put({
        threadId: binding.threadId,
        resourceId: binding.resourceId,
        ciphertext,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    }
    const verified = await native.read(binding.threadId, binding.resourceId);
    if (verified !== ciphertext)
      throw new IdentityError(409, "memory_payload_unavailable");
    this.crypto.open(verified, binding);
  }
  private published(
    actor: MemoryActor,
    row: Row,
    requestId: string,
    action: "remember" | "revise",
    payload: MemoryPayload,
    commit: MemoryCommit,
  ) {
    return this.atomic(() => {
      commit.check?.();
      this.actor(actor);
      if (
        payload.source.type === "verified_operation" &&
        (Date.parse(payload.source.verifiedAt) > this.now() ||
          Date.parse(payload.source.verifiedAt) + this.sourceTtlMs <=
            this.now())
      )
        throw new IdentityError(409, "memory_context_changed");
      const current = this.row(actor, row.id);
      if (
        this.version(actor) !== current.base_version ||
        current.publication !== "staged" ||
        current.status !== row.status ||
        !current.expires_at ||
        Date.parse(current.expires_at) <= this.now() ||
        current.native_digest !== row.native_digest
      )
        throw new IdentityError(409, "memory_conflict");
      if (
        this.db
          .prepare(
            "UPDATE agent_memory SET publication='published' WHERE id=? AND publication='staged'",
          )
          .run(row.id).changes !== 1
      )
        throw new IdentityError(409, "memory_conflict");
      this.bump(actor);
      this.commitRequest(actor, requestId);
      const item = MemoryItemSchema.parse({
        id: row.id,
        scope: row.scope,
        kind: row.kind,
        status: row.status,
        revision: row.revision,
        ...payload,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        expiresAt: row.expires_at,
        supersedesId: row.supersedes_id,
      });
      commit.checkpoint?.(item);
      this.options.onMutation?.(actor, action, commit.source ?? "console");
      return item;
    });
  }
  private async rememberImpl(
    raw: MemoryActor,
    rawInput: RememberMemoryInput,
    commit: MemoryCommit = {},
  ) {
    const actor = this.actor(raw),
      input = rememberSchema.parse(rawInput);
    if (!input.derived && !input.explicitIntent)
      throw new IdentityError(403, "memory_intent_required");
    const fingerprint = this.fingerprint(input),
      replay = this.replay(actor, input.requestId, "remember", fingerprint);
    if (replay?.memoryId && replay.state !== "staged") {
      const item = await this.receiptItem(
        actor,
        replay.memoryId,
        { sourceAccess: () => true },
        commit,
      );
      if (!item) throw new IdentityError(409, "memory_context_changed");
      return item;
    }
    const row = await this.gate(commit, () => {
      commit.check?.();
      this.writable(actor, input.scope, input.settings);
      return replay?.memoryId
        ? this.row(actor, replay.memoryId)
        : this.stage(actor, input, "remember", fingerprint);
    });
    const payload = {
      content: input.content,
      source: input.source,
      trust: this.trust(input.source, input.derived),
    };
    await this.preparePayload(row, payload, commit);
    return this.gate(commit, () => {
      commit.check?.();
      this.writable(actor, input.scope, input.settings);
      return this.published(
        actor,
        row,
        input.requestId,
        "remember",
        payload,
        commit,
      );
    });
  }
  private async reviseImpl(
    raw: MemoryActor,
    rawInput: ReviseMemoryInput,
    checkpoint?: (item: MemoryItem) => void,
    sourceAccess?: MemorySourceAccess,
    commit: MemoryCommit = {},
  ) {
    const actor = this.actor(raw),
      input = reviseSchema.parse(rawInput);
    if (!input.explicitIntent)
      throw new IdentityError(403, "memory_intent_required");
    const fingerprint = this.fingerprint(input),
      replay = this.replay(actor, input.requestId, "revise", fingerprint);
    if (replay?.memoryId && replay.state !== "staged") {
      const item = await this.receiptItem(
        actor,
        replay.memoryId,
        { sourceAccess: sourceAccess ?? (() => true) },
        {
          ...commit,
          checkpoint: (item) => {
            checkpoint?.(item);
            commit.checkpoint?.(item);
          },
        },
      );
      if (!item) throw new IdentityError(409, "memory_context_changed");
      return item;
    }
    const capture = await this.gate(commit, () => {
      commit.check?.();
      const row = this.row(actor, input.id);
      this.mutable(actor, row, input.settings);
      this.writable(actor, row.scope, input.settings);
      return { row, version: this.version(actor) };
    });
    const previous = capture.row;
    if (
      previous.revision !== input.revision ||
      !["active", "candidate"].includes(previous.status) ||
      previous.publication !== "published" ||
      previous.expires_at == null ||
      Date.parse(previous.expires_at) <= this.now()
    )
      throw new IdentityError(409, "memory_conflict");
    const previousItem = await this.item(previous);
    let matches: MemoryItem[] = [];
    if (input.expectedContent !== undefined) {
      if (
        previous.scope !== "private" ||
        previous.status !== "active" ||
        previousItem.content !== input.expectedContent
      )
        throw new IdentityError(403, "memory_explicit_instruction_required");
      const candidates = await this.gate(commit, () => {
        commit.check?.();
        if (this.version(actor) !== capture.version)
          throw new IdentityError(409, "memory_conflict");
        return this.db
          .prepare(
            `SELECT * FROM agent_memory WHERE organization_id=? AND workspace_id=?
        AND user_id=? AND scope='private' AND status='active' AND publication='published' AND expires_at>? LIMIT 2000`,
          )
          .all(
            actor.organizationId,
            actor.workspaceId,
            actor.userId,
            new Date(this.now()).toISOString(),
          ) as Row[];
      });
      matches = await Promise.all(candidates.map((row) => this.item(row)));
    }
    const checkPrevious = () => {
      commit.check?.();
      const current = this.row(actor, input.id);
      if (
        this.version(actor) !== capture.version ||
        current.revision !== input.revision ||
        current.status !== previous.status ||
        current.publication !== "published" ||
        !current.expires_at ||
        Date.parse(current.expires_at) <= this.now()
      )
        throw new IdentityError(409, "memory_conflict");
      this.mutable(actor, current, input.settings);
      this.writable(actor, current.scope, input.settings);
      if (input.expectedContent !== undefined) {
        if (!this.readable(previousItem, actor, { sourceAccess }, this.now()))
          throw new IdentityError(409, "memory_conflict");
        if (
          matches.filter(
            (item) =>
              item.content === input.expectedContent &&
              this.readable(item, actor, { sourceAccess }, this.now()),
          ).length > 1
        )
          throw new IdentityError(409, "memory_ambiguous");
      }
    };
    const row = await this.gate(commit, () => {
      checkPrevious();
      return replay?.memoryId
        ? this.row(actor, replay.memoryId)
        : this.stage(
            actor,
            {
              ...input,
              kind: previous.kind,
              scope: previous.scope,
              derived: false,
            },
            "revise",
            fingerprint,
            previous,
          );
    });
    const payload = {
      content: input.content,
      source: input.source,
      trust: this.trust(input.source, false),
    };
    await this.preparePayload(row, payload, commit);
    return this.gate(commit, () =>
      this.atomic(() => {
        checkPrevious();
        this.db
          .prepare(
            "UPDATE agent_memory SET status='superseded',revision=revision+1,updated_at=? WHERE id=?",
          )
          .run(new Date(this.now()).toISOString(), previous.id);
        return this.published(actor, row, input.requestId, "revise", payload, {
          ...commit,
          checkpoint: (item) => {
            checkpoint?.(item);
            commit.checkpoint?.(item);
          },
        });
      }),
    );
  }
  private erase(actor: MemoryActor, row: Row, entireLineage = true) {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_memory WHERE organization_id=? AND workspace_id=?
      AND ${entireLineage ? "lineage_id" : "id"}=? AND status<>'deleted'`,
      )
      .all(
        actor.organizationId,
        actor.workspaceId,
        entireLineage ? row.lineage_id : row.id,
      ) as Row[];
    if (!rows.length) return 0;
    for (const current of rows) {
      this.db
        .prepare(
          `UPDATE agent_memory SET status='deleted',revision=revision+1,expires_at=NULL,supersedes_id=NULL,
        publication=CASE WHEN native_ref IS NULL THEN 'erased' ELSE 'erase_pending' END,updated_at=? WHERE id=?`,
        )
        .run(new Date(this.now()).toISOString(), current.id);
      this.db
        .prepare(
          "UPDATE agent_memory_request SET fingerprint=NULL,state=CASE WHEN state='staged' THEN 'erasing' ELSE state END WHERE memory_id=?",
        )
        .run(current.id);
    }
    this.bump(actor);
    return rows.length;
  }
  private async forgetImpl(
    raw: MemoryActor,
    rawInput: z.input<typeof forgetSchema>,
    commit: MemoryCommit = {},
  ) {
    const actor = this.actor(raw),
      input = forgetSchema.parse(rawInput),
      fingerprint = this.fingerprint(input);
    const replay = this.replay(actor, input.requestId, "forget", fingerprint);
    if (replay?.memoryId) {
      await this.cleanup();
      const item = this.deletedItem(this.row(actor, replay.memoryId));
      await this.gate(commit, () =>
        this.atomic(() => {
          commit.check?.();
          commit.checkpoint?.(item);
        }),
      );
      return item;
    }
    const previous = this.row(actor, input.id);
    this.mutable(actor, previous);
    if (previous.status !== "deleted" && previous.revision !== input.revision)
      throw new IdentityError(409, "memory_conflict");
    await this.gate(commit, () =>
      this.atomic(() => {
        commit.check?.();
        const current = this.row(actor, input.id);
        this.mutable(actor, current);
        if (current.status !== "deleted" && current.revision !== input.revision)
          throw new IdentityError(409, "memory_conflict");
        this.erase(actor, current);
        this.request(
          actor,
          input.requestId,
          "forget",
          fingerprint,
          previous.id,
          null,
          "erasing",
        );
        commit.revoked?.(this.deletedItem(this.row(actor, previous.id)));
        this.options.onMutation?.(actor, "forget", commit.source ?? "console");
      }),
    );
    await this.cleanup();
    const item = this.deletedItem(this.row(actor, previous.id));
    await this.gate(commit, () =>
      this.atomic(() => {
        commit.check?.();
        commit.checkpoint?.(item);
      }),
    );
    return item;
  }
  private readable(
    item: MemoryItem,
    actor: MemoryActor,
    options: MemoryReadOptions,
    now: number,
  ) {
    if (!item.expiresAt || Date.parse(item.expiresAt) <= now) return false;
    if (item.source?.type === "verified_operation") {
      const verifiedAt = Date.parse(item.source.verifiedAt);
      if (
        verifiedAt > now ||
        verifiedAt + this.sourceTtlMs <= now ||
        !options.sourceAccess?.(item.source, actor)
      )
        return false;
    }
    return true;
  }
  private rows(
    actor: MemoryActor,
    settings: MemorySettings,
    activeOnly: boolean,
  ) {
    return this.db
      .prepare(
        `SELECT * FROM agent_memory WHERE organization_id=? AND workspace_id=?
      AND ((scope='private' AND user_id=?) OR (scope='workspace' AND ?=1)) AND publication='published'
      AND status ${activeOnly ? "='active'" : "IN ('active','candidate','superseded')"}
      AND expires_at>? ORDER BY ${activeOnly ? "CASE WHEN kind='preference' THEN 0 ELSE 1 END," : ""}updated_at DESC,id ASC LIMIT 2000`,
      )
      .all(
        actor.organizationId,
        actor.workspaceId,
        actor.userId,
        Number(settings.allowShared),
        new Date(this.now()).toISOString(),
      ) as Row[];
  }
  async list(raw: MemoryActor, options: MemoryReadOptions = {}) {
    const capture = await this.gate(options, () => {
      const actor = this.actor(raw),
        settings = MemorySettingsSchema.parse(options.settings ?? {});
      return {
        actor,
        version: this.version(actor),
        rows: this.rows(actor, settings, false),
      };
    });
    const items = await Promise.all(capture.rows.map((row) => this.item(row)));
    return this.gate(options, () => {
      if (this.version(capture.actor) !== capture.version)
        throw new IdentityError(409, "memory_context_changed");
      return items
        .filter((item) =>
          this.readable(item, capture.actor, options, this.now()),
        )
        .slice(0, 200);
    });
  }
  async find(
    raw: MemoryActor,
    id: string,
    options: MemoryReadOptions = {},
  ): Promise<MemoryItem | null> {
    const capture = await this.gate(options, () => {
      const actor = this.actor(raw);
      IdentityId.parse(id);
      const settings = MemorySettingsSchema.parse(options.settings ?? {});
      const row = this.db
        .prepare(
          `SELECT * FROM agent_memory WHERE id=? AND organization_id=? AND workspace_id=?
        AND ((scope='private' AND user_id=?) OR (scope='workspace' AND ?=1)) AND publication='published'
        AND status IN ('active','candidate','superseded') AND expires_at>?`,
        )
        .get(
          id,
          actor.organizationId,
          actor.workspaceId,
          actor.userId,
          Number(settings.allowShared),
          new Date(this.now()).toISOString(),
        ) as Row | undefined;
      return { actor, version: this.version(actor), row };
    });
    if (!capture.row) return null;
    const item = await this.item(capture.row);
    return this.gate(options, () => {
      if (this.version(capture.actor) !== capture.version)
        throw new IdentityError(409, "memory_context_changed");
      return this.readable(item, capture.actor, options, this.now())
        ? item
        : null;
    });
  }
  async search(
    raw: MemoryActor,
    options: MemoryReadOptions & { query?: string } = {},
  ): Promise<MemoryContext> {
    const capture = await this.gate(options, () => {
      const actor = this.actor(raw),
        settings = MemorySettingsSchema.parse(options.settings ?? {});
      const query = z
        .string()
        .trim()
        .max(500)
        .parse(options.query ?? "");
      const tokens = [
        ...new Set(
          query
            .normalize("NFKC")
            .toLowerCase()
            .match(/[\p{L}\p{N}]{2,}/gu) ?? [],
        ),
      ].slice(0, 20);
      return {
        actor,
        settings,
        tokens,
        version: this.version(actor),
        rows: this.readPreferences(actor).optOut
          ? []
          : this.rows(actor, settings, true),
      };
    });
    const items = await Promise.all(capture.rows.map((row) => this.item(row)));
    return this.gate(options, () => {
      const { actor, settings, tokens, version } = capture;
      if (this.version(actor) !== version)
        throw new IdentityError(409, "memory_context_changed");
      const result: MemoryContext = {
        version,
        items: [],
        contextChars: 2,
        expiresAt: null,
      };
      const scored = items
        .filter((item) => this.readable(item, actor, options, this.now()))
        .map((item) => ({
          item,
          score: tokens.reduce(
            (score, token) =>
              score +
              Number(
                item.content?.normalize("NFKC").toLowerCase().includes(token),
              ),
            0,
          ),
        }))
        .filter(({ item, score }) => item.kind === "preference" || score > 0)
        .sort(
          (a, b) =>
            Number(b.item.kind === "preference") -
              Number(a.item.kind === "preference") ||
            b.score - a.score ||
            b.item.updatedAt.localeCompare(a.item.updatedAt) ||
            a.item.id.localeCompare(b.item.id),
        );
      for (const { item } of scored) {
        if (result.items.length >= settings.maxItems) break;
        const chars =
          JSON.stringify(item).length + (result.items.length ? 1 : 0);
        if (result.contextChars + chars > settings.maxContextChars) continue;
        result.items.push(item);
        result.contextChars += chars;
        const sourceExpiry =
          item.source?.type === "verified_operation"
            ? new Date(
                Date.parse(item.source.verifiedAt) + this.sourceTtlMs,
              ).toISOString()
            : null;
        for (const expiry of [item.expiresAt, sourceExpiry])
          if (expiry && (!result.expiresAt || expiry < result.expiresAt))
            result.expiresAt = expiry;
      }
      return result;
    });
  }
  async purgeExpired(raw: MemoryActor) {
    const actor = this.actor(raw);
    const count = await this.gate({}, () =>
      this.atomic(() =>
        (
          this.db
            .prepare(
              `SELECT * FROM agent_memory WHERE organization_id=? AND workspace_id=?
      AND status<>'deleted' AND expires_at<=? AND ((scope='private' AND user_id=?) OR (scope='workspace' AND ?=1))`,
            )
            .all(
              actor.organizationId,
              actor.workspaceId,
              new Date(this.now()).toISOString(),
              actor.userId,
              Number(actor.canManageShared),
            ) as Row[]
        ).reduce((total, row) => total + this.erase(actor, row, false), 0),
      ),
    );
    await this.cleanup();
    return count;
  }
  async purgeExpiredAll() {
    const count = await this.gate({}, () =>
      this.atomic(() =>
        (
          this.db
            .prepare(
              "SELECT * FROM agent_memory WHERE status<>'deleted' AND expires_at<=?",
            )
            .all(new Date(this.now()).toISOString()) as Row[]
        ).reduce(
          (total, row) =>
            total +
            this.erase(
              {
                organizationId: row.organization_id,
                workspaceId: row.workspace_id,
                userId: row.user_id,
                canManageShared: true,
              },
              row,
              false,
            ),
          0,
        ),
      ),
    );
    await this.cleanup();
    return count;
  }
  /** Completes durable erasures only; staging is never automatically published. */
  async cleanup() {
    const rows = this.db
      .prepare(
        "SELECT * FROM agent_memory WHERE publication='erase_pending' ORDER BY id LIMIT 10001",
      )
      .all() as Row[];
    if (rows.length > 10000) throw Error("memory_cleanup_limit");
    for (const row of rows) {
      if (!row.native_ref || !row.native_resource)
        throw Error("memory_cleanup_binding_missing");
      await this.serialPayload(row.native_ref, async () => {
        await (await this.native).remove(row.native_ref!, row.native_resource!);
      });
      await this.gate({}, () =>
        this.atomic(() =>
          this.db
            .prepare(
              `UPDATE agent_memory SET native_ref=NULL,native_resource=NULL,native_digest=NULL,
        publication='erased' WHERE id=? AND publication='erase_pending'`,
            )
            .run(row.id),
        ),
      );
    }
    const native = await this.native,
      documents = await native.list();
    if (documents.length > 10000) throw Error("memory_cleanup_limit");
    for (const document of documents) {
      const exists = await this.gate({}, () =>
        this.db
          .prepare(
            "SELECT 1 FROM agent_memory WHERE native_ref=? AND native_resource=?",
          )
          .get(document.threadId, document.resourceId),
      );
      if (!exists)
        await this.serialPayload(document.threadId, async () => {
          const current = await this.gate({}, () =>
            this.db
              .prepare(
                "SELECT 1 FROM agent_memory WHERE native_ref=? AND native_resource=?",
              )
              .get(document.threadId, document.resourceId),
          );
          if (!current)
            await native.remove(document.threadId, document.resourceId);
        });
    }
    await this.gate({}, () =>
      this.atomic(() =>
        this.db
          .prepare(
            `UPDATE agent_memory_request SET state='committed' WHERE state='erasing' AND
      NOT EXISTS (SELECT 1 FROM agent_memory m JOIN agent_memory n ON n.lineage_id=m.lineage_id
      WHERE m.id=agent_memory_request.memory_id AND n.publication='erase_pending')`,
          )
          .run(),
      ),
    );
  }
  async close() {
    const native = this.nativePromise ?? nativeOwners.get(this.db);
    if (native) await (await native).close();
    nativeOwners.delete(this.db);
  }
}
