import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  WorkPetStore,
  DEFAULT_PET_SETTINGS,
  automaticPetShape,
} from "../apps/server-identity/work-pet";
import { SavePetProfileSchema } from "../packages/protocol/work-pet";
import type { MemoryActor } from "../apps/server-identity/memory";
import type { MemoryItem } from "../packages/protocol/memory";

test("pet SQLite: defaults, owner scope, CAS, request replay and reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "niaro-pet-test-"));
  const file = join(dir, "test.sqlite");
  let db = new DatabaseSync(file);
  db.exec(
    `PRAGMA foreign_keys=ON; CREATE TABLE organization(id TEXT PRIMARY KEY); CREATE TABLE user(id TEXT PRIMARY KEY); CREATE TABLE agent_workspace(id TEXT PRIMARY KEY); INSERT INTO organization VALUES ('org'),('other'); INSERT INTO user VALUES ('alice'),('bob'); INSERT INTO agent_workspace VALUES ('work'),('elsewhere');`,
  );
  const actor: MemoryActor = {
    organizationId: "org",
    workspaceId: "work",
    userId: "alice",
    canManageShared: false,
  };
  let store = new WorkPetStore(db);
  try {
    assert.equal(store.read(actor).revision, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM agent_pet").get()!.n, 0);
    const update = {
      requestId: "pet-request",
      revision: 0,
      settings: {
        ...DEFAULT_PET_SETTINGS,
        name: "TEST Kočka",
        jobTitle: "TEST Owner",
        animate: false,
      },
    };
    assert.equal(store.save(actor, update).revision, 1);
    assert.equal(store.save(actor, update).revision, 1);
    assert.throws(
      () => store.save(actor, { ...update, requestId: "stale" }),
      /pet_conflict/,
    );
    assert.throws(
      () =>
        store.save(actor, {
          ...update,
          settings: { ...update.settings, name: "changed" },
        }),
      /pet_request_conflict/,
    );
    for (const changes of [
      { userId: "bob" },
      { workspaceId: "elsewhere" },
      { organizationId: "other" },
    ])
      assert.equal(store.read({ ...actor, ...changes }).revision, 0);
    db.close();
    db = new DatabaseSync(file);
    store = new WorkPetStore(db);
    assert.deepEqual(store.read(actor), {
      settings: update.settings,
      revision: 1,
    });
    assert.equal(store.save(actor, update).revision, 1);
    assert.equal(
      SavePetProfileSchema.safeParse({ ...update, userId: "bob" }).success,
      false,
    );
    assert.equal(
      SavePetProfileSchema.safeParse({
        ...update,
        settings: { ...update.settings, shape: "frog" },
      }).success,
      false,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("automatic shape uses all current own work observations with deterministic ties", () => {
  const item = (
    section: string,
    seenAt: string,
    personal = false,
    status = "active",
  ) =>
    ({
      scope: "private",
      origin: "observed",
      status,
      seenAt,
      source: { type: "observed", section, personal },
    }) as MemoryItem;
  assert.equal(automaticPetShape([]), "circle");
  assert.equal(
    automaticPetShape([
      item("work", "2026-10-01"),
      item("tools", "2026-10-02"),
    ]),
    "sunny",
  );
  assert.equal(
    automaticPetShape([
      ...Array.from({ length: 220 }, () => item("projects", "2026-09-01")),
      item("work", "2026-10-01"),
      item("tools", "2026-10-02", true),
      item("tools", "2026-10-02", false, "superseded"),
    ]),
    "flower",
  );
});
