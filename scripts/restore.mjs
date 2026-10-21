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
  symlinkSync,
  readlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FORMAT, MANIFEST, fail, sha256, tar } from "./backup-common.mjs";

const [input, output] = process.argv.slice(2);
if (!input || !output)
  fail(
    "Usage: node scripts/restore.mjs <backup-dir | file.tar.gz | -> <target-data-dir>",
  );
const target = resolve(output);
if (existsSync(target) && readdirSync(target).length)
  fail(
    `Target is not empty: ${target}. Restore only into a new, empty volume or directory.`,
  );

const inside = (base, path) => {
  const full = resolve(base, path);
  if (full !== base && !full.startsWith(base + sep))
    throw new Error(`Unsafe path in backup: ${path}`);
  return full;
};

async function restore(from) {
  const manifest = JSON.parse(readFileSync(join(from, MANIFEST), "utf8"));
  if (manifest.format !== FORMAT)
    throw new Error(`Unknown backup format: ${manifest.format}`);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  chmodSync(target, 0o700);
  const directory = (path) => {
    const parent = dirname(inside(target, path));
    mkdirSync(parent, { recursive: true, mode: 0o700 });
  };
  for (const path of manifest.directories ?? [])
    mkdirSync(inside(target, path), { recursive: true, mode: 0o700 });
  for (const file of manifest.files) {
    const source = inside(from, file.path);
    const destination = inside(target, file.path);
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
