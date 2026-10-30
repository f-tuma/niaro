// Shared by scripts/backup.mjs and scripts/restore.mjs. Plain Node 22, no
// dependencies, so the same files run on a host and inside the image.
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import {
  createReadStream,
  openSync,
  readSync,
  closeSync,
  existsSync,
  lstatSync,
  realpathSync,
  mkdirSync,
  chmodSync,
  writeFileSync,
  fsyncSync,
} from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const MANIFEST = "niaro-backup.json";
/** A backup in progress stages here, inside the data directory it copies. */
export const STAGING_PREFIX = ".niaro-backup-";
export const FORMAT = "niaro-backup/1";

/** SQLite side files, the single-owner lock and a first-start administrator
 * key still waiting to be shown are never part of a snapshot. */
export function skipped(relative, name) {
  return (
    /-(wal|shm|journal)$/.test(name) ||
    name === "server-lock.sqlite" ||
    name === "admin-key.initial" ||
    name === ".attachment-restore.json" ||
    relative.split("/").includes("attachment-spool") ||
    name.startsWith(STAGING_PREFIX) ||
    /\.tmp$/.test(name) ||
    relative.split("/").includes(".npm-cache")
  );
}

export function isSqlite(file) {
  const fd = openSync(file, "r");
  try {
    const header = Buffer.alloc(16);
    return (
      readSync(fd, header, 0, 16, 0) === 16 &&
      header.toString("latin1") === "SQLite format 3\0"
    );
  } finally {
    closeSync(fd);
  }
}

export function sha256(file) {
  return new Promise((ok, fail) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", fail)
      .on("end", () => ok(hash.digest("hex")));
  });
}

/** Runs tar with the given arguments; stdin/stdout are passed through when requested. */
export function tar(args, { input, output } = {}) {
  return new Promise((ok, fail) => {
    const child = spawn("tar", args, {
      stdio: [input ?? "ignore", output ?? "ignore", "inherit"],
    });
    child.on("error", fail);
    child.on("close", (code) =>
      code === 0 ? ok() : fail(new Error(`tar exited with ${code}`)),
    );
  });
}

export function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

export {
  RESTORE_MARKER,
  SNAPSHOT_ID,
  validateAttachmentManifest,
  validateRestoreMarker,
  validateDeletionEvidence,
  deletionCoverage,
  validRestoreActivation,
} from "../apps/server-attachments/restore-contract.cjs";
import {
  RESTORE_MARKER,
  SNAPSHOT_ID,
  validateAttachmentManifest,
  validateRestoreMarker,
} from "../apps/server-attachments/restore-contract.cjs";

export function attachmentUsage(args) {
  const [source, output, ...flags] = args;
  if (!source || !output) throw Error("usage");
  let mode = "metadata-only",
    snapshotId = null;
  const seen = new Set();
  for (let n = 0; n < flags.length; n += 2) {
    const flag = flags[n],
      value = flags[n + 1];
    if (
      !["--attachments", "--object-snapshot-id"].includes(flag) ||
      seen.has(flag) ||
      !value ||
      value.startsWith("--")
    )
      throw Error("usage");
    seen.add(flag);
    if (flag === "--attachments") {
      if (!["metadata-only", "coordinated"].includes(value))
        throw Error("usage");
      mode = value;
    } else {
      if (!SNAPSHOT_ID.test(value)) throw Error("usage");
      snapshotId = value;
    }
  }
  if ((mode === "coordinated") !== !!snapshotId) throw Error("usage");
  return { source, output, mode, snapshotId };
}
export function attachmentLayout(root) {
  const candidates = ["workflow", "."].filter((p) =>
    existsSync(join(root, p, "workflow.sqlite")),
  );
  if (candidates.length > 1) throw Error("attachment owner layout ambiguous");
  if (!candidates.length) return null;
  const workflowDirectory = candidates[0],
    workflowFile = join(root, workflowDirectory, "workflow.sqlite");
  if (
    lstatSync(workflowFile).isSymbolicLink() ||
    !realpathSync(workflowFile).startsWith(realpathSync(root) + sep)
  )
    throw Error("attachment owner outside root");
  const identityDirectory = existsSync(
    join(root, "identity", "identity.sqlite"),
  )
    ? "identity"
    : null;
  if (
    identityDirectory &&
    (!realpathSync(join(root, "identity", "identity.sqlite")).startsWith(
      realpathSync(root) + sep,
    ) ||
      lstatSync(join(root, "identity")).isSymbolicLink())
  )
    throw Error("attachment owner outside root");
  const db = new DatabaseSync(workflowFile, { readOnly: true });
  try {
    const hasMetadata = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='metadata'",
      )
      .get();
    const owner =
      hasMetadata &&
      db
        .prepare(
          "SELECT value FROM metadata WHERE key='attachment_identity_directory'",
        )
        .get();
    if (owner && owner.value !== "null") {
      const actual = JSON.parse(String(owner.value)),
        rel = relative(resolve(root), resolve(actual));
      if (rel !== "identity" || !identityDirectory)
        throw Error("attachment owner outside root");
    }
  } finally {
    db.close();
  }
  return { workflowDirectory, identityDirectory };
}
export function attachmentOwnerLocks(root, layout) {
  const held = [];
  try {
    for (const path of [
      layout?.identityDirectory,
      layout?.workflowDirectory,
    ].filter((v) => v !== null && v !== undefined)) {
      const directory = join(root, path);
      if (
        existsSync(directory) &&
        (lstatSync(directory).isSymbolicLink() ||
          (realpathSync(directory) !== realpathSync(root) &&
            !realpathSync(directory).startsWith(realpathSync(root) + sep)))
      )
        throw Error("owner_busy");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const db = new DatabaseSync(join(directory, "server-lock.sqlite"));
      try {
        db.exec("BEGIN EXCLUSIVE");
        held.push(db);
      } catch {
        db.close();
        throw Error("owner_busy");
      }
    }
    return () => {
      for (const db of held.reverse()) db.close();
    };
  } catch (error) {
    for (const db of held.reverse()) db.close();
    throw error;
  }
}
export function attachmentInventory(
  root,
  layout,
  mode = "metadata-only",
  snapshotId = null,
) {
  if (!layout) return null;
  const db = new DatabaseSync(
    join(root, layout.workflowDirectory, "workflow.sqlite"),
    { readOnly: true },
  );
  try {
    const table = (name) =>
      !!db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(name);
    const registry = table("object_storage_objects"),
      metadata = table("attachment_contents");
    const refs = registry
      ? Number(
          db
            .prepare(
              "SELECT count(*) AS n FROM object_storage_objects WHERE state!='deleted'",
            )
            .get().n,
        )
      : 0;
    if (!metadata && !refs) return null;
    if (refs && !metadata) throw Error("attachment lineage missing");
    const server = db
      .prepare("SELECT value FROM metadata WHERE key='server_id'")
      .get();
    if (!server) throw Error("attachment identity missing");
    const objects = [],
      locations = new Map();
    let after = "",
      blockedUncertainCount = 0;
    for (;;) {
      const page = registry
        ? db
            .prepare(
              "SELECT * FROM object_storage_objects WHERE state!='deleted' AND id>? ORDER BY id LIMIT 100",
            )
            .all(after)
        : [];
      if (!page.length) break;
      for (const r of page) {
        const c = db
          .prepare("SELECT * FROM attachment_contents WHERE handle_id=?")
          .get(r.id);
        if (
          !c ||
          c.generation_id !== r.owner ||
          c.sha256 !== r.sha256 ||
          c.size !== r.size
        )
          throw Error("attachment lineage missing");
        if (r.write_uncertain || r.mutation === "put") blockedUncertainCount++;
        if (
          mode === "coordinated" &&
          (r.write_uncertain || r.mutation !== "idle")
        )
          throw Error("mutation_unsettled");
        const location = db
          .prepare("SELECT descriptor FROM object_storage_locations WHERE id=?")
          .get(r.location_id);
        if (!location) throw Error("attachment location missing");
        locations.set(r.location_id, {
          id: r.location_id,
          descriptor: JSON.parse(String(location.descriptor)),
        });
        const state =
          r.write_uncertain || r.mutation === "put"
            ? "quarantined"
            : r.state === "deleting" || c.lifecycle === "tombstoned"
              ? "deleting"
              : r.state === "reserved" &&
                  !c.ever_dispatched &&
                  r.put_admitted === 0
                ? "never-uploaded"
                : "retained";
        objects.push({
          handleId: r.id,
          locationId: r.location_id,
          key: r.object_key,
          owner: r.owner,
          contentId: c.id,
          generation: c.generation_id,
          kind: "original",
          size: r.size,
          sha256: r.sha256,
          state,
        });
        if (objects.length > 5000)
          throw Error("attachment inventory too large");
      }
      after = page.at(-1).id;
    }
    const pendingPurgeCount = table("attachment_purge_jobs")
      ? Number(
          db
            .prepare(
              "SELECT count(*) AS n FROM attachment_purge_jobs WHERE state!='done'",
            )
            .get().n,
        )
      : 0;
    return validateAttachmentManifest({
      version: 1,
      completeness: mode,
      serverId: String(server.value),
      owners: layout,
      locations: [...locations.values()],
      objects,
      pendingPurgeCount,
      blockedUncertainCount,
      objectSnapshotId: snapshotId,
    });
  } finally {
    db.close();
  }
}
export function attachmentRowsPresent(file) {
  if (!existsSync(file)) return false;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    for (const table of [
      "attachment_generations",
      "attachment_drafts",
      "attachment_contents",
      "attachment_bindings",
      "attachment_ingestions",
      "attachment_attempts",
      "attachment_purge_jobs",
      "object_storage_objects",
    ]) {
      if (
        db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
          .get(table) &&
        db
          .prepare(
            `SELECT 1 FROM ${table} ${table === "object_storage_objects" ? "WHERE state!='deleted'" : ""} LIMIT 1`,
          )
          .get()
      )
        return true;
    }
    return false;
  } finally {
    db.close();
  }
}
export function durableRestoreMarker(target, marker) {
  validateRestoreMarker(marker);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  chmodSync(target, 0o700);
  const fd = openSync(join(target, RESTORE_MARKER), "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(marker) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const dir = openSync(target, "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
export function installRestoreBarrier(file, marker, manifest, manifestBytes) {
  const db = new DatabaseSync(file);
  try {
    db.exec(
      "PRAGMA synchronous=FULL; BEGIN IMMEDIATE; DROP TABLE IF EXISTS attachment_restore_state; CREATE TABLE attachment_restore_state(slot INTEGER PRIMARY KEY CHECK(slot=1),restore_id TEXT NOT NULL UNIQUE,source_manifest TEXT,manifest_sha256 TEXT,snapshot_id TEXT,recovery_cutoff TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('unverified','serving')),reconciliation_revision INTEGER NOT NULL CHECK(reconciliation_revision>=0),reconciliation_digest TEXT,reconciliation_evidence TEXT,last_verification TEXT,verification_digest TEXT,activated_at TEXT) STRICT",
    );
    db.prepare(
      "INSERT INTO attachment_restore_state VALUES(1,?,?,?,?,?,'unverified',0,NULL,NULL,NULL,NULL,NULL)",
    ).run(
      marker.restoreId,
      manifest.attachments ? String(manifestBytes) : null,
      marker.manifestSha256,
      manifest.attachments?.objectSnapshotId ?? null,
      marker.recoveryCutoff,
    );
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    db.close();
  }
}
