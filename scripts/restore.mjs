#!/usr/bin/env node
// Restores a snapshot made by scripts/backup.mjs into a new, empty data
// directory (for the container: a new volume mounted at /data).
//
//   node scripts/restore.mjs <backup> <target-data-dir>
//
// <backup> is a backup directory, a .tar.gz file, or "-" for a .tar.gz on stdin
// (`docker run --rm -i -v niaro-data-restored:/data <image> restore - < backup.tar.gz`).
// The target must be empty: restore never merges into or overwrites live data.
// Every file is checked against the manifest's SHA-256 and every database must
// pass integrity_check before the restore reports success.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  lstatSync,
  realpathSync,
  symlinkSync,
  readlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep, basename } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import {
  FORMAT,
  MANIFEST,
  fail,
  sha256,
  tar,
  RESTORE_MARKER,
  validateAttachmentManifest,
  durableRestoreMarker,
  installRestoreBarrier,
  attachmentRowsPresent,
} from "./backup-common.mjs";

const [input, output, ...extra] = process.argv.slice(2);
if (
  !input ||
  !output ||
  extra.length ||
  input.startsWith("--") ||
  output.startsWith("--")
)
  fail(
    "Usage: node scripts/restore.mjs <backup-dir | file.tar.gz | -> <target-data-dir>",
    64,
  );
const target = resolve(output);
if (existsSync(target) && readdirSync(target).length)
  fail(
    `Target is not empty: ${target}. Restore only into a new, empty volume or directory.`,
  );

const inside = (base, path) => {
  if (
    typeof path !== "string" ||
    path.split(/[\\/]/).includes("..") ||
    path.includes("\0") ||
    basename(path) === RESTORE_MARKER ||
    path.split("/").includes("attachment-spool")
  )
    throw Error("Unsafe backup path");
  const full = resolve(base, path);
  if (full !== base && !full.startsWith(base + sep))
    throw new Error(`Unsafe path in backup: ${path}`);
  return full;
};

async function restore(from) {
  const manifestBytes = readFileSync(join(from, MANIFEST));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.attachments) validateAttachmentManifest(manifest.attachments);
  if (
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.databases) ||
    !Array.isArray(manifest.directories ?? []) ||
    !Array.isArray(manifest.links ?? [])
  )
    throw Error("Invalid local manifest");
  for (const path of [
    ...(manifest.directories ?? []),
    ...(manifest.links ?? []),
    ...manifest.files.map((f) => f.path),
  ])
    inside(target, path);
  for (const path of manifest.databases) {
    const file = inside(from, path);
    if (
      !lstatSync(file).isFile() ||
      !realpathSync(file).startsWith(realpathSync(from) + sep)
    )
      throw Error("Unsafe backup database");
    if (
      attachmentRowsPresent(file) &&
      !["workflow.sqlite", "workflow/workflow.sqlite"].includes(path)
    )
      throw Error("Attachment owner layout unsupported");
  }
  const marker = {
    version: 1,
    restoreId: randomUUID(),
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    recoveryCutoff: new Date().toISOString(),
  };
  if (manifest.format !== FORMAT)
    throw new Error(`Unknown backup format: ${manifest.format}`);
  durableRestoreMarker(target, marker);
  const directory = (path) => {
    const parent = dirname(inside(target, path));
    mkdirSync(parent, { recursive: true, mode: 0o700 });
  };
  for (const path of manifest.directories ?? [])
    mkdirSync(inside(target, path), { recursive: true, mode: 0o700 });
  for (const file of manifest.files) {
    const source = inside(from, file.path);
    const destination = inside(target, file.path);
    if (
      !lstatSync(source).isFile() ||
      !realpathSync(source).startsWith(realpathSync(from) + sep)
    )
      throw Error("Unsafe backup source");
    directory(file.path);
    copyFileSync(source, destination);
    chmodSync(destination, statSync(source).mode & 0o700 || 0o600);
    if ((await sha256(destination)) !== file.sha256)
      throw new Error(`Checksum mismatch: ${file.path}`);
  }
  for (const link of manifest.links ?? []) {
    directory(link);
    symlinkSync(readlinkSync(inside(from, link)), inside(target, link));
  }
  for (const path of manifest.databases) {
    const db = new DatabaseSync(inside(target, path));
    try {
      const result = db
        .prepare("PRAGMA integrity_check")
        .all()
        .map((row) => Object.values(row)[0])
        .join("; ");
      if (result !== "ok")
        throw new Error(`${path}: integrity_check ${result}`);
    } finally {
      db.close();
    }
  }
  const candidates = ["workflow/workflow.sqlite", "workflow.sqlite"].filter(
    (path) => existsSync(join(target, path)),
  );
  if (candidates.length > 1) throw Error("Ambiguous workflow owner");
  const workflow = candidates[0];
  const attachments = workflow && attachmentRowsPresent(join(target, workflow));
  if (attachments) {
    if (
      manifest.attachments &&
      workflow !==
        join(manifest.attachments.owners.workflowDirectory, "workflow.sqlite")
    )
      throw Error("Attachment owner mismatch");
    installRestoreBarrier(
      join(target, workflow),
      marker,
      manifest,
      manifestBytes.toString("utf8"),
    );
    const db = new DatabaseSync(join(target, workflow));
    try {
      db.prepare(
        "INSERT INTO metadata(key,value) VALUES('attachment_identity_directory',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run(
        JSON.stringify(
          manifest.attachments?.owners.identityDirectory
            ? join(target, manifest.attachments.owners.identityDirectory)
            : null,
        ),
      );
    } finally {
      db.close();
    }
    manifest.attachmentRestoreStatus = "unverified";
  } else {
    if (workflow) {
      const db = new DatabaseSync(join(target, workflow));
      try {
        db.exec("DROP TABLE IF EXISTS attachment_restore_state");
      } finally {
        db.close();
      }
    }
    rmSync(join(target, RESTORE_MARKER));
    manifest.attachmentRestoreStatus = "text-only";
  }
  return manifest;
}

const archive = input === "-" || input.endsWith(".tar.gz");
const staging = archive ? mkdtempSync(join(tmpdir(), "niaro-restore-")) : null;
try {
  if (staging)
    await tar(
      [
        "-xzf",
        input === "-" ? "-" : resolve(input),
        "-C",
        staging,
        "--no-same-owner",
      ],
      input === "-" ? { input: "inherit" } : {},
    );
  const manifest = await restore(staging ?? resolve(input));
  process.stderr.write(`attachments: ${manifest.attachmentRestoreStatus}\n`);
  process.stderr.write(
    `Restore complete: ${manifest.databases.length} databases (integrity ok), ${manifest.files.length} files from ${manifest.createdAt} -> ${target}\n`,
  );
} catch (error) {
  fail(
    `Restore failed: ${error instanceof Error ? error.message : error}. The target may be partial; empty it before retrying.`,
  );
} finally {
  if (staging) rmSync(staging, { recursive: true, force: true });
}
