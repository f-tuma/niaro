#!/usr/bin/env node
// Consistent snapshot of a Niaro data directory (the container's /data volume).
//
//   node scripts/backup.mjs <data-dir> <output>
//
// <output> is a new directory, a file ending in .tar.gz, or "-" for a .tar.gz
// on stdout (`docker compose exec -T niaro niaro backup - > backup.tar.gz`).
//
// Every SQLite database (identity, its Mastra store, workflow, budgets, …) is
// copied with SQLite's online backup API from a read-only connection, so the
// server may keep running: each database is a consistent point-in-time copy.
// For one consistent point across all databases, stop the server first. Other
// files are copied as they are; WAL/SHM side files, the single-owner lock and
// npm caches are left out. Every copied database must pass integrity_check.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import {
  FORMAT,
  MANIFEST,
  STAGING_PREFIX,
  fail,
  isSqlite,
  sha256,
  skipped,
  tar,
  attachmentUsage,
  attachmentLayout,
  attachmentOwnerLocks,
  attachmentInventory,
  attachmentRowsPresent,
} from "./backup-common.mjs";

let parsed;
try {
  parsed = attachmentUsage(process.argv.slice(2));
} catch {
  fail(
    "Usage: node scripts/backup.mjs D OUTPUT [--attachments metadata-only|coordinated] [--object-snapshot-id ID]",
    64,
  );
}
const { source, output, mode, snapshotId } = parsed;
const root = resolve(source);
if (!existsSync(root) || !statSync(root).isDirectory())
  fail(`Data directory not found: ${root}`);
const archive = output === "-" || output.endsWith(".tar.gz");
if (!archive && existsSync(output)) fail(`Output already exists: ${output}`);
if (output !== "-" && archive && existsSync(output))
  fail(`Output already exists: ${output}`);

const log = (message) => process.stderr.write(`${message}\n`);

async function copyDatabase(file, target) {
  // Read-only: the original is never written, checkpointed or locked for writes.
  // SQLite still adds empty -wal/-shm files beside a WAL database nobody has
  // open (an old copy, a stopped server); those are removed again afterwards.
  const sides = [`${file}-wal`, `${file}-shm`];
  const existed = sides.map((side) => existsSync(side));
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (typeof backup === "function")
      // One step under one read transaction: never restarted by a concurrent
      // writer, and WAL writers are not blocked meanwhile.
      await backup(db, target, { rate: 1_000_000_000 });
    else db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  } finally {
    db.close();
    if (
      !existed[0] &&
      !existed[1] &&
      existsSync(sides[0]) &&
      statSync(sides[0]).size === 0
    )
      for (const side of sides) rmSync(side, { force: true });
  }
  const copy = new DatabaseSync(target);
  try {
    const rows = copy.prepare("PRAGMA integrity_check").all();
    const result = rows.map((row) => Object.values(row)[0]).join("; ");
    if (result !== "ok") throw new Error(`integrity_check: ${result}`);
  } finally {
    copy.close();
  }
}

async function snapshot(into) {
  const manifest = {
    format: FORMAT,
    createdAt: new Date().toISOString(),
    databases: [],
    directories: [],
    files: [],
    links: [],
  };
  const walk = async (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      const path = relative(root, file);
      if (skipped(path, entry.name)) continue;
      const target = join(into, path);
      const stats = lstatSync(file);
      if (stats.isSymbolicLink()) {
        symlinkSync(readlinkSync(file), target);
        manifest.links.push(path);
      } else if (stats.isDirectory()) {
        mkdirSync(target, { mode: 0o700 });
        manifest.directories.push(path);
        await walk(file);
      } else if (stats.isFile()) {
        if (stats.size > 0 && isSqlite(file)) {
          await copyDatabase(file, target);
          manifest.databases.push(path);
        } else copyFileSync(file, target);
        chmodSync(target, stats.mode & 0o700);
        manifest.files.push({
          path,
          size: statSync(target).size,
          sha256: await sha256(target),
        });
      }
    }
  };
  await walk(root);
  for (const file of manifest.databases)
    if (
      attachmentRowsPresent(join(into, file)) &&
      (!layout || file !== join(layout.workflowDirectory, "workflow.sqlite"))
    )
      throw Error("attachment owner layout unsupported");
  const attachments = attachmentInventory(into, layout, mode, snapshotId);
  if (attachments) manifest.attachments = attachments;
  writeFileSync(
    join(into, MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  return manifest;
}

/** The copy is staged next to the data when possible: the volume has room for
 * it, unlike the small RAM-backed /tmp of the read-only container. A
 * read-only source directory stages in the system temporary directory. */
function stagingDirectory() {
  try {
    return mkdtempSync(join(root, STAGING_PREFIX));
  } catch {
    return mkdtempSync(join(tmpdir(), "niaro-backup-"));
  }
}
const staging = archive ? stagingDirectory() : resolve(output);
let layout,
  releaseLocks = () => {};
try {
  layout = attachmentLayout(root);
  if (mode === "coordinated") releaseLocks = attachmentOwnerLocks(root, layout);
  if (!archive) mkdirSync(staging, { mode: 0o700 });
  const manifest = await snapshot(staging);
  if (archive) {
    const args = [
      "-czf",
      output === "-" ? "-" : resolve(output),
      "-C",
      staging,
      ".",
    ];
    await tar(args, output === "-" ? { output: "inherit" } : {});
    if (output !== "-") chmodSync(resolve(output), 0o600);
  }
  log(`attachments: ${manifest.attachments ? mode : "text-only"}`);
  log(
    `Backup complete: ${manifest.databases.length} databases (integrity ok), ${manifest.files.length - manifest.databases.length} other files${output === "-" ? "" : ` -> ${output}`}`,
  );
} catch (error) {
  if (!archive) rmSync(staging, { recursive: true, force: true });
  fail(`Backup failed: ${error instanceof Error ? error.message : error}`);
} finally {
  releaseLocks();
  if (archive) rmSync(staging, { recursive: true, force: true });
}
