import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { loadStorageConfiguration } from "../apps/server-storage/config";
import { S3ObjectStore } from "../apps/server-storage/adapter";
import { createHandle, sha256 } from "../apps/server-storage/types";

import { syntheticS3 } from "./helpers/storage-s3";
test("put verifies real bytes before any network dispatch", async () => {
  const result = loadStorageConfiguration({
    NIARO_S3_ENDPOINT: "http://127.0.0.1:1",
    NIARO_S3_REGION: "us-east-1",
    NIARO_S3_BUCKET: "synthetic-storage",
    NIARO_S3_CREDENTIAL_MODE: "default",
    NIARO_S3_ALLOW_HTTP: "true",
    NIARO_S3_FORCE_PATH_STYLE: "true",
  });
  assert.equal(result.state, "configured");
  if (result.state !== "configured") return;
  const store = new S3ObjectStore(result.config);
  const handle = createHandle(result.config, randomUUID(), {
    sha256: sha256("original"),
    size: 8,
  });
  try {
    await assert.rejects(store.put(handle, Buffer.from("modified")), {
      code: "integrity",
    });
  } finally {
    store.close();
  }
});
test("actual HTTP adapter conditionally creates, verifies bytes, reads ranges and deletes repeatedly", async () => {
  const s = await syntheticS3(),
    store = new S3ObjectStore(s.config);
  const body = Buffer.from("synthetic original bytes");
  const h = createHandle(s.config, randomUUID(), {
    sha256: sha256(body),
    size: body.length,
  });
  try {
    assert.equal(await store.put(h, body), "created");
    assert.equal(await store.put(h, body), "already-present");
    assert.deepEqual(await store.head(h), {
      size: body.length,
      sha256: sha256(body),
    });
    assert.deepEqual(await store.get(h), body);
    assert.equal(
      Buffer.from(await store.range(h, { start: 2, end: 7 })).toString(),
      body.subarray(2, 8).toString(),
    );
    await store.verifyConditional(h);
    await store.anonymousDenied(h);
    await store.delete(h);
    await store.delete(h);
    await assert.rejects(store.get(h), { code: "not_found" });
    assert.ok(
      s.calls
        .filter((c) => c.method === "PUT")
        .every((c) => c.conditional === "*"),
    );
  } finally {
    store.close();
    await s.close();
  }
});
test("integrity, erasure prerequisites, denied responses and redirects fail safely", async () => {
  const s = await syntheticS3(),
    store = new S3ObjectStore(s.config);
  const body = Buffer.from("synthetic original");
  const h = createHandle(s.config, randomUUID(), {
    sha256: sha256(body),
    size: body.length,
  });
  try {
    await store.put(h, body);
    s.faults.corrupt = true;
    await assert.rejects(store.get(h), { code: "integrity" });
    s.faults.corrupt = false;
    s.faults.badRange = true;
    await assert.rejects(store.range(h, { start: 0, end: 1 }), {
      code: "integrity",
    });
    s.faults.badRange = false;
    s.faults.versioning = true;
    await assert.rejects(store.delete(h), { code: "bucket_not_erasable" });
    assert.equal(s.objects.size, 1);
    s.faults.versioning = false;
    s.faults.lockDenied = true;
    await assert.rejects(store.checkBucket(), { code: "denied" });
    s.faults.lockDenied = false;
    s.faults.deny = true;
    await assert.rejects(
      store.head(h),
      (e: Error) =>
        !JSON.stringify(e).includes("private-service-canary") &&
        e.message.includes("denied"),
    );
    s.faults.deny = false;
    s.faults.redirect = true;
    await assert.rejects(store.get(h), { code: "denied" });
  } finally {
    store.close();
    await s.close();
  }
});
test("a total response deadline aborts stalled bodies and excess transfers reject without queueing", async () => {
  const s = await syntheticS3(),
    store = new S3ObjectStore(s.config, 100);
  const body = Buffer.from("synthetic original");
  const h = createHandle(s.config, randomUUID(), {
    sha256: sha256(body),
    size: body.length,
  });
  try {
    await store.put(h, body);
    s.faults.slow = true;
    const a = store.get(h),
      b = store.get(h);
    await assert.rejects(store.get(h), { code: "busy" });
    await assert.rejects(a, { code: "timeout" });
    await assert.rejects(b, { code: "timeout" });
  } finally {
    store.close();
    await s.close();
  }
});

test("real lost PUT response keeps a durable fence when missing HEAD precedes a delayed remote write", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { StorageRegistry } = await import("../apps/server-storage/registry");
  const { RegisteredObjectStore } = await import(
    "../apps/server-storage/runtime"
  );
  const s = await syntheticS3(),
    db = new DatabaseSync(":memory:"),
    registry = new StorageRegistry(db);
  registry.activate(s.config);
  const store = new RegisteredObjectStore(
    registry,
    s.config,
    new S3ObjectStore(s.config),
  );
  try {
    const body = Buffer.from("delayed synthetic body"),
      h = store.reserve(randomUUID(), {
        sha256: sha256(body),
        size: body.length,
      });
    s.faults.losePutResponse = true;
    await assert.rejects(store.put(h, body), { outcome: "unknown" });
    await assert.rejects(store.head(h), { code: "not_found" });
    await assert.rejects(store.delete(h), {
      code: "uncertain",
      retryable: false,
    });
    assert.throws(
      () => registry.activate({ ...s.config, bucket: "replacement-storage" }),
      { code: "migration_required" },
    );
    assert.equal(s.pendingPuts.length, 1);
    s.pendingPuts[0]!();
    assert.equal(sha256(await store.get(h)), sha256(body));
    assert.equal(registry.counts().uncertainPuts, 1);
  } finally {
    store.close();
    db.close();
    await s.close();
  }
});
