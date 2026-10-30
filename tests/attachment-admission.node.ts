import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AttachmentAdmission,
  identifyAttachment,
  spoolAttachment,
  cleanupAttachmentSpools,
} from "../apps/server-attachments/admission";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
test("production admission has no queue; bounded spool rejects short/overlong/digest/type inputs and releases temporary bytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "niaro-admission-"));
  try {
    const gate = new AttachmentAdmission(),
      release = gate.claim("upload"),
      read = gate.claim("download");
    assert.throws(() => gate.claim("upload"), { status: 429 });
    assert.deepEqual(gate.counts(), { uploads: 1, downloads: 1 });
    release();
    release();
    read();
    assert.deepEqual(gate.counts(), { uploads: 0, downloads: 0 });
    const run = (b: Buffer, size = b.length, digest = sha(b)) =>
      spoolAttachment(
        Readable.from([b]) as IncomingMessage,
        dir,
        randomUUID(),
        size,
        digest,
        "text/plain",
        120,
      );
    const bytes = Buffer.alloc(131073, 65);
    assert.equal((await run(bytes)).bytes.length, bytes.length);
    assert.deepEqual(readdirSync(join(dir, "attachment-spool")), []);
    await assert.rejects(run(bytes, bytes.length - 1), { status: 413 });
    await assert.rejects(run(bytes, bytes.length + 1), { status: 400 });
    await assert.rejects(run(bytes, bytes.length, "0".repeat(64)), {
      code: "attachment_integrity",
    });
    await assert.rejects(run(Buffer.from("MZrenamed executable")), {
      status: 415,
    });
    assert.deepEqual(readdirSync(join(dir, "attachment-spool")), []);
    assert.throws(
      () =>
        identifyAttachment(
          Buffer.from("PK\u0003\u0004arbitrary ZIP"),
          "text/plain",
        ),
      { status: 415 },
    );
    const stale = join(dir, "attachment-spool", randomUUID() + ".tmp");
    writeFileSync(stale, "synthetic interrupted");
    const outside = join(dir, "outside");
    writeFileSync(outside, "preserved");
    symlinkSync(outside, join(dir, "attachment-spool", randomUUID() + ".tmp"));
    cleanupAttachmentSpools(dir);
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(outside), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("spool rejects symlink directories and enforces its absolute deadline without dispatch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "niaro-spool-"));
  try {
    const outside = join(dir, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(dir, "attachment-spool"));
    await assert.rejects(
      spoolAttachment(
        Readable.from([Buffer.from("x")]) as IncomingMessage,
        dir,
        randomUUID(),
        1,
        sha(Buffer.from("x")),
        "text/plain",
        120,
      ),
    );
    rmSync(join(dir, "attachment-spool"));
    const never = new Readable({ read() {} });
    await assert.rejects(
      spoolAttachment(
        never as IncomingMessage,
        dir,
        randomUUID(),
        1,
        sha(Buffer.from("x")),
        "text/plain",
        0.02,
      ),
    );
    assert.deepEqual(readdirSync(join(dir, "attachment-spool")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
