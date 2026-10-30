import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { StorageRegistry } from "../apps/server-storage/registry";
import { loadStorageConfiguration } from "../apps/server-storage/config";

import { randomUUID } from "node:crypto";
import { RegisteredObjectStore } from "../apps/server-storage/runtime";
import { S3ObjectStore } from "../apps/server-storage/adapter";
import { sha256, StorageError } from "../apps/server-storage/types";
const settings = () => {
  const c = loadStorageConfiguration({
    NIARO_S3_REGION: "us-east-1",
    NIARO_S3_BUCKET: "synthetic-storage",
    NIARO_S3_CREDENTIAL_MODE: "default",
  });
  if (c.state !== "configured") throw Error("configuration");
  return c.config;
};
test("registry activation permits same-location credential rotation and persists location", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const registry = new StorageRegistry(db);
    registry.activate(settings());
    registry.activate(settings());
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM object_storage_locations").get()!.n,
      1,
    );
  } finally {
    db.close();
  }
});
function fixture() {
  const db = new DatabaseSync(":memory:"),
    registry = new StorageRegistry(db),
    config = settings();
  registry.activate(config);
  return {
    db,
    registry,
    config,
    other: { ...config, bucket: "another-storage" },
  };
}
test("a paused admitted PUT fences DELETE and location replacement across wrappers", async () => {
  const f = fixture();
  let release!: (v: "created") => void;
  const pending = new Promise<"created">((ok) => {
    release = ok;
  });
  const adapter = {
    put: () => pending,
    delete: async () => {},
    close() {},
  } as unknown as S3ObjectStore;
  const a = new RegisteredObjectStore(f.registry, f.config, adapter),
    b = new RegisteredObjectStore(new StorageRegistry(f.db), f.config, adapter);
  try {
    const h = a.reserve(randomUUID(), { sha256: sha256("body"), size: 4 });
    assert.ok(Object.isFrozen(h));
    const writing = a.put(h, Buffer.from("body"));
    await assert.rejects(b.delete(h), { code: "busy" });
    assert.throws(() => f.registry.activate(f.other), {
      code: "migration_required",
    });
    release("created");
    await writing;
    await b.delete(h);
    await b.delete(h);
    f.registry.activate(f.other);
    await assert.rejects(a.put(h, Buffer.from("body")), {
      code: "location_mismatch",
    });
  } finally {
    f.db.close();
  }
});
test("unknown PUT retains location even with missing remote data and a later write", async () => {
  const f = fixture();
  let remote = false;
  const adapter = {
    put: async () => {
      throw new StorageError("timeout", true, "unknown");
    },
    delete: async () => {
      remote = false;
    },
    get: async () => {
      if (!remote) throw new StorageError("not_found");
      return Buffer.from("body");
    },
    close() {},
  } as unknown as S3ObjectStore;
  const store = new RegisteredObjectStore(f.registry, f.config, adapter);
  try {
    const h = store.reserve(randomUUID(), { sha256: sha256("body"), size: 4 });
    await assert.rejects(store.put(h, Buffer.from("body")), {
      outcome: "unknown",
    });
    await assert.rejects(store.get(h), { code: "not_found" });
    await assert.rejects(store.delete(h), {
      code: "uncertain",
      retryable: false,
    });
    assert.throws(() => f.registry.activate(f.other), {
      code: "migration_required",
    });
    remote = true;
    assert.equal(Buffer.from(await store.get(h)).toString(), "body");
    assert.equal(f.registry.counts().uncertainPuts, 1);
  } finally {
    f.db.close();
  }
});
test("interrupted PUT recovery quarantines, mismatched tokens cannot clear another admission", () => {
  const f = fixture();
  try {
    const h = f.registry.reserve(f.config, randomUUID(), {
      sha256: sha256("body"),
      size: 4,
    });
    const token = f.registry.begin(f.config, h, "put")!;
    assert.throws(() => f.registry.finish(f.config, h, "wrong-token", "put"), {
      code: "conflict",
    });
    new StorageRegistry(f.db);
    assert.throws(() => f.registry.begin(f.config, h, "delete"), {
      code: "busy",
    });
    f.registry.recoverInterruptedMutations();
    assert.throws(() => f.registry.begin(f.config, h, "delete"), {
      code: "uncertain",
    });
    assert.throws(() => f.registry.finish(f.config, h, token, "put"), {
      code: "conflict",
    });
    assert.throws(() => f.registry.activate(f.other), {
      code: "migration_required",
    });
  } finally {
    f.db.close();
  }
});
test("delete uncertainty keeps irreversible deleting state but explicit delete can confirm", async () => {
  const f = fixture();
  let attempts = 0;
  const adapter = {
    delete: async () => {
      if (!attempts++) throw new StorageError("timeout", true, "unknown");
    },
    close() {},
  } as unknown as S3ObjectStore;
  const store = new RegisteredObjectStore(f.registry, f.config, adapter);
  try {
    const h = store.reserve(randomUUID(), { sha256: sha256("body"), size: 4 });
    await assert.rejects(store.delete(h));
    await assert.rejects(store.put(h, Buffer.from("body")), {
      code: "conflict",
    });
    assert.throws(() => f.registry.activate(f.other), {
      code: "migration_required",
    });
    await store.delete(h);
    f.registry.activate(f.other);
  } finally {
    f.db.close();
  }
});

test("an interrupted mutation survives closing and reopening the real workflow SQLite file", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs"),
    { tmpdir } = await import("node:os"),
    { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "niaro-s3-restart-")),
    path = join(dir, "workflow.sqlite"),
    c = settings();
  let db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL");
    let registry = new StorageRegistry(db);
    registry.activate(c);
    const h = registry.reserve(c, randomUUID(), {
      sha256: sha256("body"),
      size: 4,
    });
    registry.begin(c, h, "put");
    db.close();
    db = new DatabaseSync(path);
    registry = new StorageRegistry(db);
    registry.recoverInterruptedMutations();
    assert.throws(() => registry.begin(c, h, "delete"), { code: "uncertain" });
    assert.throws(
      () => registry.activate({ ...c, bucket: "replacement-storage" }),
      { code: "migration_required" },
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mutation admission and completion cannot join an uncommitted outer transaction", async () => {
  const f = fixture();
  let dispatched = 0;
  const adapter = {
    put: async () => {
      dispatched++;
      return "created";
    },
    close() {},
  } as unknown as S3ObjectStore;
  const store = new RegisteredObjectStore(f.registry, f.config, adapter);
  try {
    f.db.exec("BEGIN IMMEDIATE");
    const uncommitted = store.reserve(randomUUID(), {
      sha256: sha256("body"),
      size: 4,
    });
    await assert.rejects(store.put(uncommitted, Buffer.from("body")), {
      code: "busy",
    });
    assert.equal(dispatched, 0);
    f.db.exec("ROLLBACK");
    const h = store.reserve(randomUUID(), { sha256: sha256("body"), size: 4 });
    const token = f.registry.begin(f.config, h, "put")!;
    f.db.exec("BEGIN IMMEDIATE");
    assert.throws(() => f.registry.finish(f.config, h, token, "put"), {
      code: "busy",
    });
    f.db.exec("ROLLBACK");
    f.registry.finish(f.config, h, token, "put");
  } finally {
    if (f.db.isTransaction) f.db.exec("ROLLBACK");
    f.db.close();
  }
});
