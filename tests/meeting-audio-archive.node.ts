import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { MeetingStore } from "../apps/server-identity/meeting-store";
import { MEETING_AUDIO_PART_BYTES } from "../apps/server-identity/meeting-audio-archive";
import { StorageRegistry } from "../apps/server-storage/registry";
import { S3ObjectStore } from "../apps/server-storage/adapter";
import {
  RegisteredObjectStore,
  type StorageRuntime,
} from "../apps/server-storage/runtime";
import {
  MEETING_BLOCK_BYTES,
  MEETING_PROFILE,
} from "../packages/protocol/meetings";
import { syntheticS3 } from "./helpers/storage-s3";

const scope = {
  serverId: "TEST-server",
  connectionId: "TEST-connection",
  workspaceId: "TEST-workspace",
  userId: "TEST-user",
};
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "niaro-meeting-archive-"));
  const db = new DatabaseSync(join(root, "identity.sqlite"));
  db.exec("PRAGMA foreign_keys=ON");
  const store = new MeetingStore(db);
  const s3 = await syntheticS3();
  const registry = new StorageRegistry(new DatabaseSync(":memory:"));
  registry.activate(s3.config);
  const objects = new RegisteredObjectStore(
    registry,
    s3.config,
    new S3ObjectStore(s3.config),
  );
  let runtime: StorageRuntime = { state: "configured", store: objects };
  store.archive.attach(() => runtime);
  return {
    store,
    s3,
    disable() {
      runtime = { state: "disabled" };
    },
    /** A sealed, processed meeting holding `bytes`. */
    ready(bytes: Buffer) {
      const id = randomUUID();
      store.create(scope, {
        profile: MEETING_PROFILE,
        id,
        title: "TEST meeting",
        recordedAt: new Date().toISOString(),
        language: "cs",
        mimeType: "audio/webm",
        bytes: bytes.length,
      });
      for (let at = 0; at < bytes.length; at += MEETING_BLOCK_BYTES)
        store.append(
          scope,
          id,
          at,
          bytes.subarray(at, at + MEETING_BLOCK_BYTES),
        );
      store.seal(scope, id, createHash("sha256").update(bytes).digest("hex"));
      store.update(scope, id, { status: "ready" });
      return id;
    },
    async close() {
      await store.archive.close();
      objects.close();
      await s3.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
async function collect(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test("processed meeting sound moves to object storage in parts and plays from there", async () => {
  const f = await fixture();
  try {
    const sound = randomBytes(2 * MEETING_AUDIO_PART_BYTES + 12_345);
    const id = f.ready(sound);
    const meeting = f.store.get(scope, id);
    await f.store.archive.kick();
    assert.equal(existsSync(f.store.path(meeting)), false);
    assert.equal(f.s3.objects.size, 3);
    const audio = f.store.audio(scope, id);
    assert.deepEqual(await collect(audio.open(0, sound.length - 1)), sound);
    // A seek across the boundary between two parts.
    const from = MEETING_AUDIO_PART_BYTES - 10,
      to = MEETING_AUDIO_PART_BYTES + 20;
    assert.deepEqual(
      await collect(audio.open(from, to)),
      sound.subarray(from, to + 1),
    );

    // Processing gets the file back; the next pass drops it without re-uploading.
    const path = await f.store.localAudio(meeting);
    assert.deepEqual(readFileSync(path), sound);
    const puts = f.s3.calls.filter((c) => c.method === "PUT").length;
    await f.store.archive.kick();
    assert.equal(existsSync(path), false);
    assert.equal(f.s3.calls.filter((c) => c.method === "PUT").length, puts);

    f.store.deleteAudio(scope, id);
    await f.store.archive.kick();
    assert.equal(f.s3.objects.size, 0);
    assert.throws(() => f.store.audio(scope, id), {
      code: "meeting_audio_not_found",
    });
  } finally {
    await f.close();
  }
});

test("deleting a meeting erases its archived sound", async () => {
  const f = await fixture();
  try {
    const id = f.ready(randomBytes(1000));
    await f.store.archive.kick();
    assert.equal(f.s3.objects.size, 1);
    f.store.delete(scope, id);
    await f.store.archive.kick();
    assert.equal(f.s3.objects.size, 0);
  } finally {
    await f.close();
  }
});

test("sound stays local without storage or when the file no longer matches its seal", async () => {
  const f = await fixture();
  try {
    const changed = f.ready(randomBytes(1000));
    const path = f.store.path({ id: changed });
    writeFileSync(path, randomBytes(1000));
    await f.store.archive.kick();
    assert.equal(existsSync(path), true);
    assert.equal(f.s3.objects.size, 0);

    f.disable();
    const sound = randomBytes(1000);
    const local = f.ready(sound);
    await f.store.archive.kick();
    assert.equal(f.s3.objects.size, 0);
    assert.deepEqual(
      await collect(f.store.audio(scope, local).open(0, sound.length - 1)),
      sound,
    );
  } finally {
    await f.close();
  }
});

test("a failed upload is retried later and the failed object is cleaned up", async () => {
  const f = await fixture();
  try {
    const sound = randomBytes(1000);
    const id = f.ready(sound);
    f.s3.faults.deny = true;
    await f.store.archive.kick();
    assert.equal(existsSync(f.store.path({ id })), true);
    f.s3.faults.deny = false;
    await f.store.archive.kick();
    assert.equal(existsSync(f.store.path({ id })), false);
    assert.equal(f.s3.objects.size, 1);
    assert.deepEqual(
      await collect(f.store.audio(scope, id).open(0, sound.length - 1)),
      sound,
    );
  } finally {
    await f.close();
  }
});
