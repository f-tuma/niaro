import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  createNativeSavedMemory,
  type NativeSavedMemory,
} from "../apps/server-agent/saved-memory";
import { MemoryStore, MEMORY_SOURCE_TTL } from "../apps/server-identity/memory";
import { MemoryPayloadCrypto } from "../apps/server-identity/memory-payload-crypto";
import { createMemoryRuntime } from "../apps/server-identity/memory-runtime";
import { createMastraDomain } from "../apps/server-identity/mastra-domain";
import { ServiceCatalogStore } from "../apps/server-identity/service-catalog";
import {
  CatalogController,
  type CatalogContext,
} from "../apps/server-identity/catalog-controller";
import { IdentityError } from "../apps/server-identity/error";
import { MemorySettingsSchema } from "../packages/protocol/memory";
const secret = "T".repeat(64),
  actor = {
    organizationId: "org",
    workspaceId: "workspace",
    userId: "user",
    canManageShared: true,
  };
const settings = MemorySettingsSchema.parse({});
function fixture(
  wrap: (native: NativeSavedMemory) => NativeSavedMemory = (n) => n,
) {
  const directory = mkdtempSync(join(tmpdir(), "niaro-saved-native-"));
  chmodSync(directory, 0o700);
  const file = join(directory, "identity.sqlite"),
    db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE organization(id TEXT PRIMARY KEY);CREATE TABLE user(id TEXT PRIMARY KEY);
    CREATE TABLE agent_workspace(id TEXT PRIMARY KEY,organization_id TEXT REFERENCES organization(id));
    INSERT INTO organization VALUES('org');INSERT INTO user VALUES('user');INSERT INTO agent_workspace VALUES('workspace','org');`);
  let now = Date.parse("2026-10-07T12:00:00.000Z"),
    audits = 0;
  const native = createNativeSavedMemory(
    pathToFileURL(file + ".memory.sqlite").href,
  );
  const store = new MemoryStore(db, {
    secret,
    native: wrap(native),
    now: () => now,
    onMutation: () => audits++,
  });
  const input = {
    requestId: "request",
    content: "TEST private preference",
    kind: "preference" as const,
    source: { type: "user_note" as const },
    explicitIntent: true,
    settings,
  };
  return {
    directory,
    file,
    db,
    native,
    store,
    input,
    audits: () => audits,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    close: async () => {
      await store.close();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
function latch() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
/** An old Mastra store file as servers left it: one payload from before NIAR-304 (a JSONB thread), one after. */
function mastraStore(directory: string) {
  const legacy = join(directory, "identity.sqlite.mastra.sqlite");
  const db = new DatabaseSync(legacy);
  db.exec(
    'CREATE TABLE mastra_threads ("id" TEXT NOT NULL PRIMARY KEY, "resourceId" TEXT NOT NULL, "title" TEXT NOT NULL, "metadata" TEXT, "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL);' +
      "CREATE TABLE mastra_messages (id TEXT PRIMARY KEY, content TEXT);" +
      "INSERT INTO mastra_messages VALUES ('TEST-message', 'TEST old chat content');" +
      "CREATE TABLE niaro_saved_memory (thread_id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, ciphertext TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;" +
      "INSERT INTO niaro_saved_memory VALUES ('TEST-later', 'TEST-resource', 'TEST-later-ciphertext', '2026-02-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z')",
  );
  const insert = db.prepare(
    "INSERT INTO mastra_threads VALUES (?,?,?,jsonb(?),?,?)",
  );
  insert.run(
    "TEST-saved",
    "TEST-resource",
    "Saved memory payload",
    JSON.stringify({
      niaroSavedMemory: "niaro-saved-memory/1",
      workingMemory: "TEST-ciphertext",
    }),
    "2026-01-01T00:00:00.000Z",
    "2026-01-02T00:00:00.000Z",
  );
  insert.run(
    "TEST-chat",
    "TEST-resource",
    "A chat",
    JSON.stringify({}),
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
  );
  db.close();
  return {
    legacy,
    file: join(directory, "identity.sqlite.memory.sqlite"),
  };
}
const movedPayloads = [
  { threadId: "TEST-later", resourceId: "TEST-resource" },
  { threadId: "TEST-saved", resourceId: "TEST-resource" },
];

test("saved memory in the old Mastra store moves to its own file once, then the old file is deleted", async () => {
  const directory = mkdtempSync(join(tmpdir(), "niaro-saved-mastra-"));
  const { legacy, file } = mastraStore(directory);
  writeFileSync(legacy + "-shm", "TEST stale side file");
  try {
    const moved: number[] = [];
    for (let open = 0; open < 2; open++) {
      const native = createNativeSavedMemory(pathToFileURL(file).href, (n) =>
        moved.push(n),
      );
      assert.equal(
        await native.read("TEST-saved", "TEST-resource"),
        "TEST-ciphertext",
      );
      assert.equal(
        await native.read("TEST-later", "TEST-resource"),
        "TEST-later-ciphertext",
      );
      assert.deepEqual(await native.list(), movedPayloads);
      // The same document again is no conflict: timestamps moved exactly.
      await native.put({
        threadId: "TEST-saved",
        resourceId: "TEST-resource",
        ciphertext: "TEST-ciphertext",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      });
      await native.close();
    }
    assert.deepEqual(moved, [2]);
    assert.deepEqual(readdirSync(directory), ["identity.sqlite.memory.sqlite"]);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a restart during the move repeats or finishes it, and a copy that differs keeps the old file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "niaro-saved-move-"));
  try {
    // Stopped while copying: a partial temporary file is replaced.
    let { legacy, file } = mastraStore(directory);
    writeFileSync(file + ".tmp", "TEST partial copy");
    let native = createNativeSavedMemory(pathToFileURL(file).href);
    assert.deepEqual(await native.list(), movedPayloads);
    await native.close();
    assert.deepEqual(
      readdirSync(directory).filter(
        (n) => n.includes("mastra") || n.endsWith(".tmp"),
      ),
      [],
    );

    // Stopped after the copy was in place: the old file is verified and deleted.
    ({ legacy } = mastraStore(directory));
    native = createNativeSavedMemory(pathToFileURL(file).href);
    assert.deepEqual(await native.list(), movedPayloads);
    await native.close();
    assert.equal(existsSync(legacy), false);

    // A payload missing from the copy refuses to open and keeps the old file.
    const changed = new DatabaseSync(file);
    changed.exec("DELETE FROM niaro_saved_memory WHERE thread_id='TEST-later'");
    changed.close();
    ({ legacy } = mastraStore(directory));
    assert.throws(
      () => createNativeSavedMemory(pathToFileURL(file).href),
      /memory_native_move_unverified/,
    );
    assert.equal(existsSync(legacy), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native payload: authoritative ciphertext, exact concurrent retry publishes once", async () => {
  const f = fixture();
  try {
    const [first, second] = await Promise.all([
      f.store.remember(actor, f.input),
      f.store.remember(actor, f.input),
    ]);
    assert.deepEqual(second, first);
    assert.equal(f.store.version(actor), 1);
    assert.equal(f.audits(), 1);
    assert.equal((await f.native.list()).length, 1);
    const row = f.db.prepare("SELECT * FROM agent_memory").get()!;
    assert(!("content" in row));
    assert(!("source" in row));
    assert(!("trust" in row));
    const ciphertext = await f.native.read(
      String(row.native_ref),
      String(row.native_resource),
    );
    assert(ciphertext);
    assert(ciphertext.startsWith("v1."));
    assert(!ciphertext.includes(f.input.content));
    await f.native.remove(String(row.native_ref), String(row.native_resource));
    await assert.rejects(
      f.store.find(actor, first.id),
      (error) =>
        error instanceof Error &&
        error.message.includes("memory_payload_unavailable"),
    );
  } finally {
    await f.close();
  }
});
test("native staging: interrupted native write remains unpublished and exact retry reuses its immutable envelope", async () => {
  let fail = true;
  const f = fixture((native) => ({
    ...native,
    put: async (document) => {
      await native.put(document);
      if (fail) {
        fail = false;
        throw Error("TEST interrupted after native write");
      }
    },
  }));
  try {
    await assert.rejects(f.store.remember(actor, f.input), /TEST interrupted/);
    assert.equal(f.store.version(actor), 0);
    assert.deepEqual(await f.store.list(actor), []);
    assert.equal(
      await f.store.resultForRequest(actor, "request", "remember"),
      null,
    );
    const staged = f.db.prepare("SELECT * FROM agent_memory").get()!;
    assert.equal(staged.publication, "staged");
    const cipher = await f.native.read(
      String(staged.native_ref),
      String(staged.native_resource),
    );
    const saved = await f.store.remember(actor, f.input);
    assert.equal(saved.id, staged.id);
    assert.equal(
      await f.native.read(
        String(staged.native_ref),
        String(staged.native_resource),
      ),
      cipher,
    );
    assert.equal(f.store.version(actor), 1);
    assert.equal(f.audits(), 1);
  } finally {
    await f.close();
  }
});
test("native delayed publication: revocation and deadline change prevent publication after awaited I/O", async () => {
  const entered = latch(),
    resume = latch();
  let blocked = true;
  const f = fixture((native) => ({
    ...native,
    put: async (document) => {
      if (blocked) {
        entered.release();
        await resume.wait;
      }
      await native.put(document);
    },
  }));
  let allowed = true;
  const commit = {
    check: () => {
      if (!allowed) throw Error("TEST revoked");
    },
  };
  try {
    const saving = f.store.remember(actor, f.input, commit);
    await entered.wait;
    // A separate synchronous policy transaction can run while native storage is delayed.
    f.store.setOptOut(actor, { requestId: "optout", optOut: true });
    allowed = false;
    resume.release();
    await assert.rejects(saving, /TEST revoked/);
    assert.deepEqual(await f.store.list(actor), []);
    assert.equal(f.audits(), 1);
    blocked = false;
    f.store.setOptOut(actor, { requestId: "optin", optOut: false });
    const source = {
      type: "verified_operation" as const,
      operationId: "operation",
      serviceId: "service",
      verifiedAt: new Date("2026-10-07T12:00:00.000Z").toISOString(),
    };
    f.advance(MEMORY_SOURCE_TTL);
    await assert.rejects(
      f.store.remember(actor, {
        ...f.input,
        requestId: "expired-source",
        source,
      }),
      /memory_context_changed/,
    );
  } finally {
    resume.release();
    await f.close();
  }
});
test("native erasure: immediate revocation, no successful checkpoint until verified removal, reopen retry cannot resurrect", async () => {
  let fail = true,
    committed = 0,
    revoked = 0;
  const f = fixture((native) => ({
    ...native,
    remove: async (thread, resource) => {
      if (fail) throw Error("TEST remove interrupted");
      await native.remove(thread, resource);
    },
  }));
  try {
    const saved = await f.store.remember(actor, f.input),
      version = f.store.version(actor);
    const input = {
      requestId: "forget",
      id: saved.id,
      revision: saved.revision,
    };
    await assert.rejects(
      f.store.forget(actor, input, {
        revoked: () => revoked++,
        checkpoint: () => committed++,
      }),
      /TEST remove interrupted/,
    );
    assert.equal(revoked, 1);
    assert.equal(committed, 0);
    assert.equal(f.store.version(actor), version + 1);
    assert.equal(await f.store.find(actor, saved.id), null);
    assert.equal(
      f.db.prepare("SELECT publication FROM agent_memory").get()?.publication,
      "erase_pending",
    );
    await assert.rejects(
      f.store.remember(actor, f.input),
      /TEST remove interrupted/,
    );
    fail = false;
    const reopened = new MemoryStore(f.db, {
      secret,
      native: { ...f.native },
      now: () => Date.parse("2026-10-07T12:00:00.000Z"),
    });
    const erased = await reopened.forget(actor, input, {
      checkpoint: () => committed++,
    });
    assert.equal(erased.status, "deleted");
    assert.equal(committed, 1);
    await assert.rejects(
      reopened.forget(actor, { ...input, id: "another-memory" }),
      /memory_request_conflict/,
    );
    assert.equal(f.store.version(actor), version + 1);
    assert.deepEqual(await f.native.list(), []);
    assert.equal(
      (
        await reopened.remember(actor, {
          ...f.input,
          content: "TEST different erased retry",
        })
      ).status,
      "deleted",
    );
    assert.deepEqual(await f.native.list(), []);
  } finally {
    fail = false;
    await f.close();
  }
});
test("native read: scoped selection rechecks source authority and deadline after delayed native read", async () => {
  const entered = latch(),
    resume = latch();
  let delay = false,
    canRead = true;
  const f = fixture((native) => ({
    ...native,
    read: async (thread, resource) => {
      if (delay) {
        entered.release();
        await resume.wait;
      }
      return native.read(thread, resource);
    },
  }));
  try {
    await f.store.remember(actor, {
      ...f.input,
      source: {
        type: "verified_operation",
        operationId: "operation",
        serviceId: "service",
        verifiedAt: "2026-10-07T12:00:00.000Z",
      },
    });
    delay = true;
    const reading = f.store.search(actor, { sourceAccess: () => canRead });
    await entered.wait;
    canRead = false;
    f.advance(MEMORY_SOURCE_TTL);
    resume.release();
    assert.deepEqual((await reading).items, []);
  } finally {
    resume.release();
    await f.close();
  }
});
test("native correction: asynchronous OLD candidate hydration is pinned to its captured generation", async () => {
  const entered = latch(),
    resume = latch();
  let oldRef = "",
    reads = 0;
  const f = fixture((native) => ({
    ...native,
    read: async (thread, resource) => {
      if (thread === oldRef && ++reads === 2) {
        entered.release();
        await resume.wait;
      }
      return native.read(thread, resource);
    },
  }));
  try {
    const old = await f.store.remember(actor, f.input);
    oldRef = String(
      f.db
        .prepare("SELECT native_ref FROM agent_memory WHERE id=?")
        .get(old.id)!.native_ref,
    );
    const input = {
      requestId: "correction",
      id: old.id,
      revision: old.revision,
      expectedContent: old.content!,
      content: "TEST corrected preference",
      source: { type: "user_message" as const, commandId: "correction" },
      explicitIntent: true,
      settings,
    };
    const changing = f.store.revise(actor, input, undefined, () => true);
    const refused = assert.rejects(changing, /memory_conflict/);
    await entered.wait;
    await f.store.remember(actor, { ...f.input, requestId: "duplicate" });
    resume.release();
    await refused;
    assert.equal(f.store.version(actor), 2);
    assert.deepEqual(
      (await f.store.list(actor)).map((item) => item.content),
      [f.input.content, f.input.content],
    );
    assert.equal(
      f.db
        .prepare(
          "SELECT count(*) AS n FROM agent_memory_request WHERE request_id='correction'",
        )
        .get()!.n,
      0,
    );
    await assert.rejects(
      f.store.revise(actor, input, undefined, () => true),
      /memory_ambiguous/,
    );
    assert.equal((await f.native.list()).length, 2);
  } finally {
    resume.release();
    await f.close();
  }
});
for (const kind of ["remember", "revise", "resultForRequest"] as const)
  test(`native receipt: ${kind} hydration cannot return active content after concurrent verified erasure`, async () => {
    const entered = latch(),
      resume = latch();
    let delay = false;
    const f = fixture((native) => ({
      ...native,
      read: async (thread, resource) => {
        const ciphertext = await native.read(thread, resource);
        if (delay) {
          delay = false;
          entered.release();
          await resume.wait;
        }
        return ciphertext;
      },
    }));
    try {
      let saved = await f.store.remember(actor, f.input);
      const revision = {
        requestId: "revision",
        id: saved.id,
        revision: saved.revision,
        content: "TEST revised preference",
        source: { type: "user_note" as const },
        explicitIntent: true,
        settings,
      };
      if (kind === "revise") saved = await f.store.revise(actor, revision);
      let checkpoint: { status: string; version: number } | undefined;
      const commit = {
        checkpoint: (item: { status: string }) => {
          checkpoint = { status: item.status, version: f.store.version(actor) };
        },
      };
      delay = true;
      const retrying =
        kind === "remember"
          ? f.store.remember(actor, f.input, commit)
          : kind === "revise"
            ? f.store.revise(actor, revision, commit.checkpoint)
            : f.store.resultForRequest(actor, f.input.requestId, "remember");
      await entered.wait;
      const tombstone = await f.store.forget(actor, {
        requestId: "erase",
        id: saved.id,
        revision: saved.revision,
      });
      resume.release();
      const retry = await retrying;
      assert.deepEqual(retry, tombstone);
      assert.equal(retry.content, null);
      assert.equal(retry.source, null);
      if (kind !== "resultForRequest")
        assert.deepEqual(checkpoint, {
          status: "deleted",
          version: f.store.version(actor),
        });
      assert.deepEqual(await f.native.list(), []);
      assert.equal(
        f.db
          .prepare(
            "SELECT count(*) AS n FROM agent_memory WHERE publication<>'erased'",
          )
          .get()!.n,
        0,
      );
    } finally {
      resume.release();
      await f.close();
    }
  });
for (const failure of [
  "remember_abort",
  "revise_abort",
  "forget_abort",
  "request_revoked",
] as const)
  test(`native domain request lifetime: ${failure} during awaited storage cannot checkpoint public success`, async () => {
    const entered = latch(),
      resume = latch();
    let delay = false,
      requestAllowed = true;
    const hold = async () => {
      if (delay) {
        entered.release();
        await resume.wait;
      }
    };
    const f = fixture((native) => ({
      ...native,
      put: async (document) => {
        await hold();
        await native.put(document);
      },
      remove: async (thread, resource) => {
        await hold();
        await native.remove(thread, resource);
      },
    }));
    try {
      f.db
        .exec(`CREATE TABLE member(id TEXT PRIMARY KEY,"organizationId" TEXT,"userId" TEXT);
        INSERT INTO member VALUES('member','org','user');`);
      let queue: Promise<unknown> = Promise.resolve();
      const serial: CatalogContext["serial"] = (run) => {
        const result = queue.then(run);
        queue = result.catch(() => {});
        return result;
      };
      const context: CatalogContext = {
        serial,
        actor: async () => ({ userId: actor.userId, role: "owner" }),
        epoch: () => 0,
        change: () => {},
        audit: () => 1,
        finish: () => {},
        transaction: async (run) => run(),
      };
      const catalog = new ServiceCatalogStore(f.db, secret, []);
      const controller = new CatalogController(catalog, async () => {
        throw Error("TEST unexpected transport");
      });
      const runtime = createMemoryRuntime(f.store, actor, settings, {
        read: (run) => serial(async () => undefined).then(run),
        mutate: (run) => serial(async () => undefined).then(run),
        transaction: (run) => serial(async () => run()),
        check: () => {},
        sourceAccess: () => true,
      });
      const domain = createMastraDomain(
        controller,
        context,
        {
          serverId: "server",
          connectionId: "connection",
          workspaceId: actor.workspaceId,
          userId: actor.userId,
        },
        actor.organizationId,
        { enabled: ["memory"], timeZone: "Europe/Prague" },
        async () => ({ reply: "" }),
        runtime,
      );
      const old =
        failure === "revise_abort" || failure === "forget_abort"
          ? await f.store.remember(actor, f.input)
          : undefined;
      const name =
        failure === "revise_abort"
          ? "memory_revise"
          : failure === "forget_abort"
            ? "memory_forget"
            : "memory_remember";
      const text =
        name === "memory_revise"
          ? `Revise memory: ${JSON.stringify(old!.content)} -> "TEST replacement"`
          : name === "memory_forget"
            ? `Forget: ${old!.content}`
            : "Remember: TEST request-lifetime preference";
      const args =
        name === "memory_remember"
          ? {
              facts: [
                {
                  text: "TEST request-lifetime preference",
                  kind: "preference",
                },
              ],
            }
          : {
              id: old!.id,
              revision: old!.revision,
              ...(name === "memory_revise"
                ? { content: "TEST replacement" }
                : {}),
            };
      const abort = new AbortController();
      const session = await domain.begin(
        "request",
        text,
        "en",
        [],
        undefined,
        {
          conversationId: "conversation",
          session: "new",
          validateRequest: () => {
            if (!requestAllowed)
              throw new IdentityError(409, "request_interrupted");
          },
        },
        { signal: abort.signal },
      );
      delay = true;
      const saving = session.invoke(name, args, {
        toolCallId: "call",
        runId: session.state.runId,
      });
      const refused = assert.rejects(
        saving,
        failure === "request_revoked"
          ? /request_interrupted/
          : (error: unknown) =>
              error instanceof DOMException && error.name === "AbortError",
      );
      await entered.wait;
      if (failure === "request_revoked") requestAllowed = false;
      else abort.abort();
      resume.release();
      await refused;
      assert.deepEqual(session.state.memoryReceipts, []);
      if (name === "memory_forget") {
        assert.equal(f.store.version(actor), 2);
        assert.equal(
          session.state.memoryPendingErase?.result.status,
          "deleted",
        );
        assert.equal(
          f.db.prepare("SELECT publication FROM agent_memory").get()!
            .publication,
          "erased",
        );
        assert.deepEqual(await f.native.list(), []);
      } else {
        assert.equal(f.store.version(actor), old ? 1 : 0);
        assert.equal(
          f.db
            .prepare(
              "SELECT count(*) AS n FROM agent_memory WHERE publication='staged'",
            )
            .get()!.n,
          1,
        );
        assert.equal((await f.store.list(actor)).length, old ? 1 : 0);
        assert.equal(
          f.db
            .prepare(
              "SELECT count(*) AS n FROM agent_memory_request WHERE state='committed'",
            )
            .get()!.n,
          old ? 1 : 0,
        );
      }
    } finally {
      resume.release();
      await f.close();
    }
  });
test("native encryption: wrong original secret and altered immutable AAD fail closed", () => {
  const key = {
    id: "memory",
    organizationId: "org",
    workspaceId: "workspace",
    userId: "user",
    scope: "private" as const,
    threadId: "thread",
    resourceId: "resource",
    createdAt: "2026-10-07T12:00:00.000Z",
    expiresAt: "2026-11-07T12:00:00.000Z",
  };
  const crypto = new MemoryPayloadCrypto(secret),
    payload = {
      content: "TEST encrypted fact",
      source: { type: "user_note" as const },
      trust: "user_assertion" as const,
    };
  const ciphertext = crypto.seal(payload, key);
  assert.deepEqual(crypto.open(ciphertext, key), payload);
  assert.throws(() =>
    new MemoryPayloadCrypto("U".repeat(64)).open(ciphertext, key),
  );
  for (const change of [
    { workspaceId: "foreign" },
    { userId: "foreign" },
    { createdAt: "2026-10-06T12:00:00.000Z" },
    { expiresAt: "2026-12-07T12:00:00.000Z" },
    { threadId: "foreign" },
  ])
    assert.throws(() => crypto.open(ciphertext, { ...key, ...change }));
});
function legacyTuple() {
  const f = fixture(); // Build supported empty metadata, then explicitly replace only the disposable test DB table.
  f.db
    .exec(`DROP TABLE agent_memory;CREATE TABLE agent_memory(id TEXT PRIMARY KEY,organization_id TEXT REFERENCES organization(id),workspace_id TEXT REFERENCES agent_workspace(id),user_id TEXT REFERENCES user(id),
    scope TEXT,kind TEXT,status TEXT,revision INTEGER,content TEXT,source TEXT,trust TEXT,created_at TEXT,updated_at TEXT,expires_at TEXT,supersedes_id TEXT,lineage_id TEXT) STRICT;
    ALTER TABLE agent_memory_request DROP COLUMN state;
    ALTER TABLE agent_memory_preference DROP COLUMN personal_things;
    INSERT INTO agent_memory_version VALUES('org','workspace',17);
    INSERT INTO agent_memory_preference VALUES('org','workspace','user',0);
    INSERT INTO agent_memory_request VALUES('org','workspace','user','remember-old','remember','ORIGINAL-FINGERPRINT','memory-old',NULL);`);
  f.db
    .prepare("INSERT INTO agent_memory VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(
      "memory-old",
      "org",
      "workspace",
      "user",
      "private",
      "preference",
      "active",
      3,
      "TEST migration exact saved fact",
      JSON.stringify({ type: "user_note" }),
      "user_assertion",
      "2026-10-01T01:02:03.004Z",
      "2026-10-02T02:03:04.005Z",
      "2027-10-01T01:02:03.004Z",
      null,
      "memory-old",
    );
  for (const name of [
    "secret",
    "workflow.sqlite",
    "server-id",
    "config.json",
    "key",
    "owner.lock",
  ])
    writeFileSync(
      join(f.directory, name),
      name === "secret" ? secret : "TEST copied tuple",
      { mode: 0o600 },
    );
  return f;
}
test("legacy startup: populated table refuses ordinary open without changing its bytes", async () => {
  const f = legacyTuple();
  try {
    const before = f.db.prepare("SELECT * FROM agent_memory").all();
    assert.throws(
      () => new MemoryStore(f.db, { secret }),
      /memory_legacy_format_unsupported/,
    );
    assert.deepEqual(f.db.prepare("SELECT * FROM agent_memory").all(), before);
  } finally {
    await f.close();
  }
});

test("native erasure serializes with an in-flight revision payload and verifies removal before success", async () => {
  const entered = latch(),
    resume = latch();
  let delay = false,
    completed = false;
  const f = fixture((native) => ({
    ...native,
    put: async (document) => {
      if (delay) {
        entered.release();
        await resume.wait;
      }
      await native.put(document);
    },
  }));
  try {
    const original = await f.store.remember(actor, f.input);
    delay = true;
    const revising = f.store.revise(actor, {
      requestId: "revise",
      id: original.id,
      revision: original.revision,
      content: "TEST correction",
      source: { type: "user_note" },
      explicitIntent: true,
      settings,
    });
    const revisionFailure = assert.rejects(revising, /memory_conflict/);
    await entered.wait;
    const forgetting = f.store.forget(
      actor,
      { requestId: "forget", id: original.id, revision: original.revision },
      {
        checkpoint: () => {
          completed = true;
        },
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(completed, false);
    assert.equal(await f.store.find(actor, original.id), null);
    resume.release();
    assert.equal((await forgetting).status, "deleted");
    await revisionFailure;
    assert.equal(completed, true);
    assert.deepEqual(await f.native.list(), []);
    assert(
      f.db
        .prepare("SELECT publication FROM agent_memory")
        .all()
        .every((row) => row.publication === "erased"),
    );
    assert.equal(
      (
        await f.store.revise(actor, {
          requestId: "revise",
          id: original.id,
          revision: original.revision,
          content: "TEST correction",
          source: { type: "user_note" },
          explicitIntent: true,
          settings,
        })
      ).status,
      "deleted",
    );
  } finally {
    resume.release();
    await f.close();
  }
});

const observedInput = (
  f: ReturnType<typeof fixture>,
  statement = "TEST observed project work",
) => ({
  batchId: randomUUID(),
  expectedVersion: f.store.version(actor),
  deadline: f.now() + 120000,
  settings,
  add: [
    {
      statement,
      section: "projects" as const,
      personal: false,
      sources: [
        {
          type: "chat" as const,
          sourceId: randomUUID(),
          messageId: "TEST-owned-message",
          at: new Date(f.now()).toISOString(),
          digest: "a".repeat(64),
        },
      ],
    },
  ],
  refresh: [],
  update: [],
});

test("observed native stage: cleanup preserves live ciphertext, publication and cursor are atomic", async () => {
  const entered = latch(),
    resume = latch();
  const f = fixture((native) => ({
    ...native,
    put: async (document) => {
      await native.put(document);
      entered.release();
      await resume.wait;
    },
  }));
  try {
    f.db.exec("CREATE TABLE observed_checkpoint(value INTEGER) STRICT");
    const input = observedInput(f);
    const pending = f.store.observe(actor, input, {
      observationSourceAccess: () => true,
      batchCheckpoint: () => {
        f.db.prepare("INSERT INTO observed_checkpoint VALUES(1)").run();
      },
    });
    await entered.wait;
    assert.equal((await f.store.list(actor)).length, 0);
    const stages = JSON.stringify(
      f.db.prepare("SELECT * FROM agent_memory_observation_stage").all(),
    );
    assert(!stages.includes(input.add[0]!.statement));
    assert(!stages.includes("TEST-owned-message"));
    await f.store.cleanup();
    assert.equal(
      (await f.native.list()).length,
      1,
      "A live observation stage owns its ciphertext before publication",
    );
    resume.release();
    const result = await pending;
    assert.equal(result.items.length, 1);
    assert.equal(f.store.version(actor), 1);
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM observed_checkpoint").get()!.n,
      1,
    );
    assert.equal(
      f.db
        .prepare("SELECT count(*) AS n FROM agent_memory_observation_stage")
        .get()!.n,
      0,
    );
    const row = f.db.prepare("SELECT * FROM agent_memory").get()!;
    const cipher = await f.native.read(
      String(row.native_ref),
      String(row.native_resource),
    );
    assert(cipher && !cipher.includes(input.add[0]!.statement));
    const opened = new MemoryPayloadCrypto(secret).open(cipher, {
      id: String(row.id),
      organizationId: actor.organizationId,
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      scope: "private",
      threadId: String(row.native_ref),
      resourceId: String(row.native_resource),
      createdAt: String(row.created_at),
      expiresAt: String(row.expires_at),
    });
    assert.equal(opened.source.type, "observed");
    assert.equal(opened.trust, "model_inference");
  } finally {
    resume.release();
    await f.close();
  }
});

for (const failure of [
  "stale_version",
  "source_deleted",
  "revoked",
  "checkpoint",
] as const)
  test(`observed native publication: ${failure} leaves no partial profile or cursor`, async () => {
    const entered = latch(),
      resume = latch();
    let block = false,
      allowed = true,
      sourceAlive = true;
    const f = fixture((native) => ({
      ...native,
      put: async (document) => {
        await native.put(document);
        if (block) {
          entered.release();
          await resume.wait;
        }
      },
    }));
    try {
      const explicit = await f.store.remember(actor, f.input);
      const before = f.store.version(actor),
        audits = f.audits();
      f.db.exec("CREATE TABLE observed_checkpoint(value INTEGER) STRICT");
      block = failure !== "checkpoint";
      const pending = f.store.observe(actor, observedInput(f), {
        observationSourceAccess: () => sourceAlive,
        check: () => {
          if (!allowed) throw Error("TEST observed revoked");
        },
        batchCheckpoint: () => {
          f.db.prepare("INSERT INTO observed_checkpoint VALUES(1)").run();
          if (failure === "checkpoint") throw Error("TEST checkpoint rollback");
        },
      });
      if (block) {
        await entered.wait;
        if (failure === "stale_version")
          await f.store.forget(actor, {
            requestId: "TEST-forget-during-observe",
            id: explicit.id,
            revision: explicit.revision,
          });
        if (failure === "source_deleted") sourceAlive = false;
        if (failure === "revoked") allowed = false;
        resume.release();
      }
      await assert.rejects(
        pending,
        failure === "revoked"
          ? /TEST observed revoked/
          : failure === "checkpoint"
            ? /TEST checkpoint rollback/
            : /memory_context_changed/,
      );
      assert.equal(
        (await f.store.list(actor)).filter((item) => item.origin === "observed")
          .length,
        0,
      );
      assert.equal(
        f.db.prepare("SELECT count(*) AS n FROM observed_checkpoint").get()!.n,
        0,
      );
      assert.equal(
        f.db
          .prepare("SELECT count(*) AS n FROM agent_memory_observation_stage")
          .get()!.n,
        0,
      );
      assert.equal(
        f.store.version(actor),
        before + Number(failure === "stale_version"),
      );
      assert.equal(f.audits(), audits + Number(failure === "stale_version"));
      assert.equal(
        (await f.native.list()).length,
        Number(failure !== "stale_version"),
      );
    } finally {
      resume.release();
      await f.close();
    }
  });

test("observed abandoned stage: native cleanup resumes from real reopened files without publishing", async () => {
  let preventRemove = true,
    closed = false;
  const f = fixture((native) => ({
    ...native,
    remove: async (thread, resource) => {
      if (preventRemove) throw Error("TEST interrupted cleanup");
      return native.remove(thread, resource);
    },
  }));
  let reopened: DatabaseSync | undefined, restarted: MemoryStore | undefined;
  try {
    await assert.rejects(
      f.store.observe(actor, observedInput(f), {
        observationSourceAccess: () => true,
        batchCheckpoint: () => {
          throw Error("TEST fail before commit");
        },
      }),
      /TEST fail before commit/,
    );
    assert.equal(
      f.db
        .prepare(
          "SELECT count(*) AS n FROM agent_memory_observation_stage WHERE state='erase_pending'",
        )
        .get()!.n,
      1,
    );
    assert.equal((await f.native.list()).length, 1);
    assert.equal((await f.store.list(actor)).length, 0);
    preventRemove = false;
    await f.store.close();
    f.db.close();
    closed = true;
    reopened = new DatabaseSync(f.file);
    restarted = new MemoryStore(reopened, { secret, now: f.now });
    await restarted.cleanup();
    assert.equal((await restarted.list(actor)).length, 0);
    assert.equal(
      reopened
        .prepare("SELECT count(*) AS n FROM agent_memory_observation_stage")
        .get()!.n,
      0,
    );
    assert.equal(restarted.version(actor), 0);
  } finally {
    if (closed) {
      await restarted?.close();
      reopened?.close();
      rmSync(f.directory, { recursive: true, force: true });
    } else await f.close();
  }
});

test("native additive upgrade preserves populated explicit records and preferences; old positional downgrade fails closed", async () => {
  const f = fixture();
  let upgraded: MemoryStore | undefined,
    reopened: DatabaseSync | undefined,
    closed = false;
  try {
    const old = await f.store.remember(actor, f.input);
    f.store.setOptOut(actor, { requestId: "TEST-old-pref-on", optOut: true });
    f.store.setOptOut(actor, { requestId: "TEST-old-pref-off", optOut: false });
    f.db.exec(
      "ALTER TABLE agent_memory DROP COLUMN origin;ALTER TABLE agent_memory DROP COLUMN seen_at;ALTER TABLE agent_memory_preference DROP COLUMN personal_things;",
    );
    await f.store.close();
    f.db.close();
    closed = true;
    reopened = new DatabaseSync(f.file);
    upgraded = new MemoryStore(reopened, { secret, now: f.now });
    assert.equal((await upgraded.find(actor, old.id))!.content, old.content);
    assert.equal((await upgraded.find(actor, old.id))!.origin, "explicit");
    assert.deepEqual(upgraded.readPreferences(actor), {
      optOut: false,
      personalThings: "keep",
    });
    const fresh = await upgraded.remember(actor, {
      ...f.input,
      requestId: "TEST-after-upgrade",
      content: "TEST new explicit",
    });
    assert.equal(fresh.origin, "explicit");
    const revised = await upgraded.revise(actor, {
      requestId: "TEST-upgraded-revise",
      id: old.id,
      revision: old.revision,
      content: "TEST corrected explicit",
      source: { type: "user_note" },
      explicitIntent: true,
      settings,
    });
    assert.equal(revised.trust, "user_assertion");
    upgraded.setOptOut(actor, { requestId: "TEST-new-optout", optOut: true });
    upgraded.setOptOut(actor, { requestId: "TEST-new-optin", optOut: false });
    await upgraded.setPersonalThings(actor, {
      requestId: "TEST-new-personal",
      value: "keep",
    });
    const source = {
      type: "chat" as const,
      sourceId: randomUUID(),
      messageId: "TEST-message",
      at: new Date(f.now()).toISOString(),
      digest: "a".repeat(64),
    };
    const observed = await upgraded.observe(
      actor,
      {
        batchId: randomUUID(),
        expectedVersion: upgraded.version(actor),
        deadline: f.now() + 120000,
        settings,
        add: [
          {
            statement: "TEST works on green delivery",
            section: "work",
            personal: false,
            sources: [source],
          },
        ],
        refresh: [],
        update: [],
      },
      { observationSourceAccess: () => true },
    );
    assert.equal(
      (await upgraded.find(actor, observed.items[0]!.id))!.origin,
      "observed",
    );
    assert.throws(
      () =>
        reopened!.prepare(
          `INSERT INTO agent_memory VALUES(${Array(18).fill("?").join(",")})`,
        ),
      /20 columns.*18 values|18 values.*20 columns/,
    );
  } finally {
    if (upgraded) await upgraded.close();
    if (reopened) reopened.close();
    if (!closed) await f.close();
    else rmSync(f.directory, { recursive: true, force: true });
  }
});
