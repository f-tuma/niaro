import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  LegacyInventoryManifestSchema,
  observeLegacyTuple,
  ordinarySchema,
  type LegacyInventoryManifest,
} from "./legacy-run-inventory";
import { MemoryStore } from "./memory";
import {
  MemoryPayloadCrypto,
  memoryCipherDigest,
  type MemoryPayloadBinding,
} from "./memory-payload-crypto";
import { MemoryItemSchema } from "../../packages/protocol/memory";

const limits = { rows: 10_000, payloadBytes: 64 * 1024 * 1024 };
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const comparable = ({ tupleRoot: _, ...rest }: LegacyInventoryManifest) =>
  JSON.stringify(rest);
const Input = z.strictObject({
  manifest: LegacyInventoryManifestSchema,
  sourceIsDisposableCopy: z.literal(true),
});
export type CopiedMemoryTupleInput = z.infer<typeof Input>;
export type CopiedMemoryTupleReport = {
  profile: "niaro-memory-copied-tuple/1";
  format: "legacy" | "native";
  rows: number;
  generationDigest: string;
  receiptDigest: string;
  outputDirectory?: string;
};
function requireTrue(value: unknown, code: string): asserts value {
  if (!value) throw Error(code);
}
function clone(input: CopiedMemoryTupleInput, destination: string) {
  const { manifest } = Input.parse(input);
  requireTrue(
    isAbsolute(destination) &&
      resolve(destination) === destination &&
      !existsSync(destination),
    "memory_copy_destination_required",
  );
  // The output parent must already exist and have no symlink aliases. A lexical
  // sibling can otherwise resolve inside the source before post-copy checks.
  const parent = dirname(destination);
  requireTrue(
    realpathSync(parent) === parent,
    "memory_copy_destination_parent_alias",
  );
  const rel = relative(realpathSync(manifest.tupleRoot), destination);
  requireTrue(
    rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel),
    "memory_copy_destination_inside_source",
  );
  const observed = observeLegacyTuple(manifest.tupleRoot, manifest.roles);
  requireTrue(
    comparable(observed) === comparable(manifest),
    "memory_copy_tuple_changed",
  );
  for (const entry of observed.files)
    requireTrue(!(entry.mode & 0o077), "memory_copy_private_files_required");
  mkdirSync(destination, { mode: 0o700 });
  for (const directory of [...manifest.directories].sort(
    (a, b) => a.path.length - b.path.length,
  )) {
    const path =
      directory.path === "." ? destination : join(destination, directory.path);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
  for (const file of manifest.files) {
    const source = join(manifest.tupleRoot, file.path);
    requireTrue(
      lstatSync(source).isFile() && !lstatSync(source).isSymbolicLink(),
      "memory_copy_tuple_changed",
    );
    copyFileSync(source, join(destination, file.path));
    chmodSync(join(destination, file.path), file.mode);
  }
  requireTrue(
    comparable(observeLegacyTuple(manifest.tupleRoot, manifest.roles)) ===
      comparable(manifest),
    "memory_copy_tuple_changed",
  );
  // File bytes and modes must match; the destination root itself is always private.
  const copied = observeLegacyTuple(destination, manifest.roles);
  requireTrue(
    JSON.stringify(copied.files) === JSON.stringify(manifest.files),
    "memory_copy_unverified",
  );
  return { ...manifest, tupleRoot: destination };
}
function boundedTable(
  db: DatabaseSync,
  table: string,
  columns: string[],
  maxRows: number,
  maxRowBytes: number,
  maxBytes: number,
) {
  const size = columns
    .map(
      (column) =>
        `coalesce(length(CAST("${column.replaceAll('"', '""')}" AS BLOB)),0)`,
    )
    .join("+");
  const meta = db
    .prepare(
      `SELECT count(*) AS n,max(${size}) AS largest,sum(${size}) AS bytes FROM "${table}"`,
    )
    .get()!;
  requireTrue(
    Number(meta.n) <= maxRows &&
      Number(meta.largest ?? 0) <= maxRowBytes &&
      Number(meta.bytes ?? 0) <= maxBytes,
    "memory_copy_row_limit",
  );
}
function preflightNative(path: string) {
  if (!existsSync(path)) return;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    ordinarySchema(db, {});
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
        .all()
        .map((row) => row.name),
    );
    if (tables.has("mastra_threads")) {
      ordinarySchema(db, {
        mastra_threads: [
          "id",
          "resourceId",
          "title",
          "createdAt",
          "updatedAt",
          "metadata",
        ],
      });
      // Native getThread parses metadata JSON before the adapter can inspect workingMemory.
      boundedTable(
        db,
        "mastra_threads",
        ["id", "resourceId", "title", "createdAt", "updatedAt", "metadata"],
        100000,
        128 * 1024,
        limits.payloadBytes,
      );
    }
  } finally {
    db.close();
  }
}
function rows(db: DatabaseSync) {
  ordinarySchema(db, {
    agent_memory: [
      "id",
      "organization_id",
      "workspace_id",
      "user_id",
      "scope",
      "kind",
      "status",
      "revision",
      "created_at",
      "updated_at",
      "expires_at",
      "supersedes_id",
      "lineage_id",
    ],
    agent_memory_version: ["organization_id", "workspace_id", "version"],
    agent_memory_request: [
      "organization_id",
      "workspace_id",
      "user_id",
      "request_id",
      "kind",
      "fingerprint",
      "memory_id",
      "opt_out",
    ],
  });
  const columns = db
    .prepare("PRAGMA table_info(agent_memory)")
    .all()
    .map((column) => String(column.name));
  boundedTable(
    db,
    "agent_memory",
    columns,
    limits.rows,
    32768,
    limits.payloadBytes,
  );
  boundedTable(
    db,
    "agent_memory_request",
    [
      "organization_id",
      "workspace_id",
      "user_id",
      "request_id",
      "kind",
      "fingerprint",
      "memory_id",
      "opt_out",
    ],
    limits.rows * 2,
    32768,
    limits.payloadBytes,
  );
  boundedTable(
    db,
    "agent_memory_version",
    ["organization_id", "workspace_id", "version"],
    limits.rows,
    32768,
    limits.payloadBytes,
  );
  requireTrue(
    db.prepare("PRAGMA integrity_check(1)").get()?.integrity_check === "ok",
    "memory_copy_database_invalid",
  );
  const result = db
    .prepare("SELECT * FROM agent_memory ORDER BY id LIMIT 10001")
    .all();
  requireTrue(result.length <= limits.rows, "memory_copy_row_limit");
  return result;
}
function report(
  db: DatabaseSync,
  format: "legacy" | "native",
  count: number,
): CopiedMemoryTupleReport {
  const versions = db
    .prepare("SELECT * FROM agent_memory_version ORDER BY workspace_id")
    .all();
  const receipts = db
    .prepare(
      `SELECT organization_id,workspace_id,user_id,request_id,kind,fingerprint,memory_id,opt_out
    FROM agent_memory_request ORDER BY organization_id,workspace_id,user_id,request_id`,
    )
    .all();
  return {
    profile: "niaro-memory-copied-tuple/1",
    format,
    rows: count,
    generationDigest: hash(versions),
    receiptDigest: hash(receipts),
  };
}
function binding(row: Record<string, unknown>): MemoryPayloadBinding {
  const resource = hash([
    "saved-memory/1",
    row.organization_id,
    row.workspace_id,
    row.scope,
    row.scope === "private" ? row.user_id : "workspace",
  ]);
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    workspaceId: String(row.workspace_id),
    userId: String(row.user_id),
    scope: row.scope as "workspace" | "private",
    threadId: hash(["saved-memory/1", resource, row.id]),
    resourceId: resource,
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
  };
}
function nativeBinding(row: Record<string, unknown>): MemoryPayloadBinding {
  return {
    ...binding(row),
    threadId: String(row.native_ref),
    resourceId: String(row.native_resource),
  };
}
const legacySchema = `CREATE TABLE agent_memory (
  id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES agent_workspace(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK(scope IN ('private','workspace')),kind TEXT NOT NULL CHECK(kind IN ('preference','fact','note')),
  status TEXT NOT NULL CHECK(status IN ('candidate','active','superseded','deleted')),revision INTEGER NOT NULL,
  content TEXT,source TEXT,trust TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,expires_at TEXT,supersedes_id TEXT,lineage_id TEXT NOT NULL
) STRICT;`;
async function operate(
  manifest: LegacyInventoryManifest,
  action: "check" | "migrate" | "reverse",
) {
  const secretEntry = manifest.files.find(
    (file) => file.path === manifest.roles.originalSecret,
  );
  requireTrue(secretEntry?.size === 64, "memory_original_secret_required");
  const identity = join(manifest.tupleRoot, manifest.roles.identityDatabase),
    secret = readFileSync(
      join(manifest.tupleRoot, manifest.roles.originalSecret),
      "utf8",
    );
  requireTrue(
    /^[A-Za-z0-9_-]{64}$/.test(secret),
    "memory_original_secret_required",
  );
  const nativePath = manifest.roles.identityDatabase + ".mastra.sqlite";
  requireTrue(
    !existsSync(join(manifest.tupleRoot, nativePath)) ||
      manifest.roles.nativeDatabases.includes(nativePath),
    "memory_copy_native_family_required",
  );
  for (const nativeFile of manifest.roles.nativeDatabases)
    preflightNative(join(manifest.tupleRoot, nativeFile));
  const db = new DatabaseSync(identity);
  db.exec(
    "PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA busy_timeout=1000;",
  );
  let native:
    | Awaited<
        ReturnType<
          (typeof import("@niaro/server-agent"))["createNativeSavedMemory"]
        >
      >
    | undefined;
  try {
    const original = rows(db),
      legacy = db
        .prepare("PRAGMA table_info(agent_memory)")
        .all()
        .some((column) => column.name === "content");
    const before = report(db, legacy ? "legacy" : "native", original.length),
      crypto = new MemoryPayloadCrypto(secret);
    requireTrue(action !== "migrate" || legacy, "memory_copy_expected_legacy");
    requireTrue(action !== "reverse" || !legacy, "memory_copy_expected_native");
    requireTrue(
      action !== "reverse" ||
        !original.some((row) => row.origin === "observed"),
      "memory_copy_observed_reverse_unsupported",
    );
    const payloads = new Map<
      string,
      { content: string; source: unknown; trust: unknown }
    >();
    let bytes = 0;
    if (!legacy || action === "migrate") {
      preflightNative(join(manifest.tupleRoot, nativePath));
      native = (await import("@niaro/server-agent")).createNativeSavedMemory(
        pathToFileURL(join(manifest.tupleRoot, nativePath)).href,
      );
      for (const row of original) {
        if (row.status === "deleted") {
          requireTrue(
            legacy || row.publication === "erased",
            "memory_copy_pending_erasure",
          );
          continue;
        }
        requireTrue(
          legacy || row.publication === "published",
          "memory_copy_pending_publication",
        );
        const key = legacy ? binding(row) : nativeBinding(row);
        let payload;
        if (legacy) {
          payload = MemoryItemSchema.parse({
            id: row.id,
            scope: row.scope,
            kind: row.kind,
            status: row.status,
            revision: row.revision,
            content: row.content,
            source: JSON.parse(String(row.source)),
            trust: row.trust,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            expiresAt: row.expires_at,
            supersedesId: row.supersedes_id,
          });
          const ciphertext = crypto.seal(
            {
              content: payload.content!,
              source: payload.source!,
              trust: payload.trust!,
            },
            key,
          );
          await native.put({
            threadId: key.threadId,
            resourceId: key.resourceId,
            ciphertext,
            createdAt: key.createdAt,
            updatedAt: String(row.updated_at),
          });
          const verified = await native.read(key.threadId, key.resourceId);
          requireTrue(
            verified === ciphertext,
            "memory_copy_native_write_unverified",
          );
          payload = crypto.open(verified, key);
          row.native_ref = key.threadId;
          row.native_resource = key.resourceId;
          row.native_digest = memoryCipherDigest(ciphertext);
        } else {
          const ciphertext = await native.read(key.threadId, key.resourceId);
          requireTrue(
            ciphertext && memoryCipherDigest(ciphertext) === row.native_digest,
            "memory_copy_native_payload_missing",
          );
          payload = crypto.open(ciphertext, key);
        }
        bytes += Buffer.byteLength(JSON.stringify(payload));
        requireTrue(bytes <= limits.payloadBytes, "memory_copy_payload_limit");
        payloads.set(String(row.id), payload);
      }
      const references = await native.list();
      requireTrue(
        references.length ===
          original.filter((row) => row.status !== "deleted").length,
        "memory_copy_native_orphan",
      );
    }
    if (action === "migrate") {
      db.exec(
        "BEGIN IMMEDIATE; ALTER TABLE agent_memory RENAME TO agent_memory_previous;",
      );
      try {
        new MemoryStore(db, { secret, native });
        for (const row of original)
          db.prepare(
            `INSERT INTO agent_memory (id,organization_id,workspace_id,user_id,scope,kind,status,revision,
              created_at,updated_at,expires_at,supersedes_id,lineage_id,native_ref,native_resource,native_digest,publication,base_version)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ).run(
            row.id!,
            row.organization_id!,
            row.workspace_id!,
            row.user_id!,
            row.scope!,
            row.kind!,
            row.status!,
            row.revision!,
            row.created_at!,
            row.updated_at!,
            row.expires_at ?? null,
            row.supersedes_id ?? null,
            row.lineage_id!,
            row.status === "deleted" ? null : row.native_ref!,
            row.status === "deleted" ? null : row.native_resource!,
            row.status === "deleted" ? null : row.native_digest!,
            row.status === "deleted" ? "erased" : "published",
            Number(
              db
                .prepare(
                  "SELECT version FROM agent_memory_version WHERE workspace_id=?",
                )
                .get(row.workspace_id!)?.version ?? 0,
            ),
          );
        db.exec("DROP TABLE agent_memory_previous; COMMIT;");
        new MemoryStore(db, { secret, native });
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    } else if (action === "reverse") {
      db.exec(
        "BEGIN IMMEDIATE; ALTER TABLE agent_memory RENAME TO agent_memory_previous;",
      );
      try {
        db.exec(legacySchema);
        for (const row of original) {
          const payload = payloads.get(String(row.id));
          db.prepare(
            "INSERT INTO agent_memory VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          ).run(
            row.id!,
            row.organization_id!,
            row.workspace_id!,
            row.user_id!,
            row.scope!,
            row.kind!,
            row.status!,
            row.revision!,
            payload?.content ?? null,
            payload ? JSON.stringify(payload.source) : null,
            (payload?.trust as string) ?? null,
            row.created_at!,
            row.updated_at!,
            row.expires_at ?? null,
            row.supersedes_id ?? null,
            row.lineage_id!,
          );
        }
        db.exec(`DROP TABLE agent_memory_previous; CREATE INDEX agent_memory_scope ON agent_memory
          (organization_id,workspace_id,scope,user_id,status,updated_at);CREATE INDEX agent_memory_lineage ON agent_memory(organization_id,workspace_id,lineage_id);COMMIT;`);
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      if (
        db
          .prepare("PRAGMA table_info(agent_memory_request)")
          .all()
          .some((column) => column.name === "state")
      )
        db.exec("ALTER TABLE agent_memory_request DROP COLUMN state");
      for (const row of original)
        if (row.native_ref)
          await native!.remove(
            String(row.native_ref),
            String(row.native_resource),
          );
    }
    if (action !== "check") db.exec("VACUUM; PRAGMA wal_checkpoint(TRUNCATE);");
    const after = report(
      db,
      action === "migrate"
        ? "native"
        : action === "reverse"
          ? "legacy"
          : before.format,
      rows(db).length,
    );
    requireTrue(
      after.generationDigest === before.generationDigest &&
        after.receiptDigest === before.receiptDigest,
      "memory_copy_receipt_changed",
    );
    requireTrue(
      db.prepare("PRAGMA foreign_key_check").iterate().next().done === true,
      "memory_copy_database_invalid",
    );
    return after;
  } finally {
    await native?.close();
    db.close();
  }
}
/** Always writes a fresh disposable output tuple. Input bytes are never modified. */
export async function convertCopiedMemoryTuple(
  input: CopiedMemoryTupleInput,
  destination: string,
  action: "migrate" | "reverse",
) {
  const copied = clone(input, destination);
  return { ...(await operate(copied, action)), outputDirectory: destination };
}
/** Even verification opens only a temporary private clone, because native LibSQL initializes on open. */
export async function checkCopiedMemoryTuple(input: CopiedMemoryTupleInput) {
  Input.parse(input);
  const outer = mkdtempSync(
    join(realpathSync(tmpdir()), "niaro-memory-check-"),
  );
  chmodSync(outer, 0o700);
  try {
    return await operate(clone(input, join(outer, "tuple")), "check");
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
}
