import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { DeviceSessions } from "../apps/server-identity/device-sessions";
import { DEVICE_SESSION_PROFILE } from "../packages/protocol";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
test("device rotation recovers after suspension, never extends a replay, enforces scope and idle expiry", (t) => {
  const db = new DatabaseSync(":memory:");
  // DeviceSessions' authorization callback supplies current membership checks.
  db.exec("PRAGMA foreign_keys=OFF");
  const realNow = Date.now();
  let now = realNow;
  t.mock.method(Date, "now", () => now);
  const identity = {
    member_id: "member",
    organization_id: "org",
    workspace_id: "a",
    user_id: "alice",
    server_id: "server-test",
  };
  const create = () =>
    new DeviceSessions(db, 30_000, 86_400_000, (grant, workspace) => {
      assert.equal(grant.workspace_id, workspace);
    });
  try {
    let store = create();
    const first = store.issue(identity);
    const actor = store.authenticate(
      hash(first.accessToken),
      "a",
      "server-test",
    )!;
    const request = {
      profile: DEVICE_SESSION_PROFILE,
      refreshToken: first.refresh!.token,
      requestId: "TEST-first-request-id",
    };
    now += 25_000;
    const next = store.refresh(request, "a", "server-test");
    assert.equal(
      store.authenticate(hash(first.accessToken), "a", "server-test")!
        .credentialId,
      actor.credentialId,
    );
    now += 60_000;
    // Recreate the service and replay a lost response after its access token has expired.
    store = create();
    assert.deepEqual(store.refresh(request, "a", "server-test"), next);
    assert.throws(() =>
      store.authenticate(hash(next.accessToken), "a", "server-test"),
    );
    assert.throws(() =>
      store.authenticate(hash(first.accessToken), "a", "server-test"),
    );
    assert.equal(
      store.authenticate(actor.credentialId, "a", "server-test", true)!
        .credentialId,
      actor.credentialId,
    );
    assert.throws(() =>
      store.refresh(
        { ...request, requestId: "TEST-wrong-request-id" },
        "a",
        "server-test",
      ),
    );
    assert.throws(() => store.refresh(request, "b", "server-test"));
    assert.throws(() => store.refresh(request, "a", "wrong-server"));
    const latest = store.refresh(
      {
        ...request,
        refreshToken: next.refresh!.token,
        requestId: "TEST-second-request-id",
      },
      "a",
      "server-test",
    );
    assert.throws(() => store.refresh(request, "a", "server-test"));
    assert.equal(
      store.authenticate(hash(latest.accessToken), "a", "server-test")!
        .credentialId,
      actor.credentialId,
    );
    // The consumed token still permits an explicit logout after a lost response.
    store.revokeRefresh(
      { profile: DEVICE_SESSION_PROFILE, refreshToken: next.refresh!.token },
      "a",
      "server-test",
    );
    assert.equal(
      store.authenticate(actor.credentialId, "a", "server-test", true),
      undefined,
    );
    const expiring = store.issue(identity);
    store.authenticate(hash(expiring.accessToken), "a", "server-test");
    now += 86_400_001;
    assert.throws(() =>
      store.refresh(
        { ...request, refreshToken: expiring.refresh!.token },
        "a",
        "server-test",
      ),
    );
    store.prune();
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM agent_mobile_device").get()!.n,
      0,
    );
  } finally {
    db.close();
  }
});
test("unclaimed enrollment is reclaimed after five minutes, activated devices remain", (t) => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=OFF");
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const store = new DeviceSessions(db, 1_800_000, 86_400_000, () => {});
  const identity = {
    member_id: "member",
    organization_id: "org",
    workspace_id: "a",
    user_id: "alice",
    server_id: "server-test",
  };
  try {
    const lost = store.issue(identity),
      active = store.issue(identity);
    store.authenticate(hash(active.accessToken), "a", "server-test");
    now += 300_001;
    assert.throws(() =>
      store.authenticate(hash(lost.accessToken), "a", "server-test"),
    );
    store.prune();
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM agent_mobile_device").get()!.n,
      1,
    );
    assert(store.authenticate(hash(active.accessToken), "a", "server-test"));
  } finally {
    db.close();
  }
});

test("migration preserves enrolled devices from the initial device table", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=OFF");
  const create = () => new DeviceSessions(db, 1_800_000, 86_400_000, () => {});
  try {
    const prior = create().issue({
      member_id: "member",
      organization_id: "org",
      workspace_id: "a",
      user_id: "alice",
      server_id: "server-test",
    });
    db.exec("ALTER TABLE agent_mobile_device DROP COLUMN activation_deadline");
    const migrated = create();
    migrated.prune();
    assert(migrated.authenticate(hash(prior.accessToken), "a", "server-test"));
  } finally {
    db.close();
  }
});
