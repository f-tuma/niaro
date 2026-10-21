// Shared by scripts/backup.mjs and scripts/restore.mjs. Plain Node 22, no
// dependencies, so the same files run on a host and inside the image.
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createReadStream, openSync, readSync, closeSync } from "node:fs";

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

export function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
