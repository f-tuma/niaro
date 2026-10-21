import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROCESS_PROPOSAL_PROFILE } from "../packages/protocol/process-proposal";
import { ProcessProposalStore } from "../apps/server-identity/process-proposal";
import { IdentityError } from "../apps/server-identity/error";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const owner = { organizationId: "TEST-org", workspaceId, userId: "TEST-user" };
const press = (sessionId: string, requestId = randomUUID()) => ({
  profile: PROCESS_PROPOSAL_PROFILE,
  type: "accept" as const,
  sessionId,
  requestId,
  revision: 2,
  reviewDigest: "a".repeat(64),
  assumptions: [],
  addToHub: true,
});
const code = (name: string) => (error: unknown) =>
  error instanceof IdentityError && error.code === name;

test("saving a chat proposal is per person, recognises a retried press, refuses a second one while running and does not survive a restart", () => {
  const root = mkdtempSync(join(tmpdir(), "niaro-proposal-store-"));
  const path = join(root, "identity.sqlite");
  try {
    let db = new DatabaseSync(path);
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE agent_workspace(id TEXT PRIMARY KEY);
      INSERT INTO agent_workspace VALUES ('${workspaceId}');`);
    let store = new ProcessProposalStore(db, "TEST-server");
    const sessionId = randomUUID();
    assert.throws(
      () => store.read(owner, sessionId),
      code("process_proposal_not_found"),
    );
    store.register(owner, sessionId, "TEST-model");
    // Registering again keeps the original designer model.
    assert.equal(
      store.register(owner, sessionId, "TEST-other").modelId,
      "TEST-model",
    );
    assert.equal(store.read(owner, sessionId).status.state, "open");
    // Someone else, or another server, does not see it.
    assert.throws(
      () => store.read({ ...owner, userId: "TEST-other" }, sessionId),
      code("process_proposal_not_found"),
    );
    assert.throws(
      () =>
        new ProcessProposalStore(db, "TEST-other-server").read(
          owner,
          sessionId,
        ),
      code("process_proposal_not_found"),
    );

    const first = press(sessionId);
    const begun = store.begin(owner, first);
    assert.equal(begun.start, true);
    assert.equal(begun.status.state, "running");
    assert.equal(begun.status.phase, "saving");
    // The same press (a lost response) starts nothing new.
    assert.deepEqual(store.begin(owner, first), {
      status: begun.status,
      start: false,
    });
    assert.throws(
      () => store.begin(owner, { ...first, addToHub: false }),
      code("process_proposal_conflict"),
    );
    assert.throws(
      () => store.begin(owner, press(sessionId)),
      code("process_proposal_busy"),
    );
    store.update(owner, sessionId, (s) => ({
      ...s,
      phase: "testing",
      processId: "TEST-process",
      version: 1,
    }));

    // A restart leaves nothing running: the save reads as interrupted, and a
    // new press continues from what is already saved.
    db.close();
    db = new DatabaseSync(path);
    store = new ProcessProposalStore(db, "TEST-server");
    const interrupted = store.read(owner, sessionId).status;
    assert.equal(interrupted.state, "failed");
    assert.equal(interrupted.failure, "process_proposal_interrupted");
    assert.equal(interrupted.phase, undefined);
    assert.equal(interrupted.processId, "TEST-process");
    const again = store.begin(owner, press(sessionId));
    assert.equal(again.start, true);
    assert.equal(again.status.processId, "TEST-process");
    assert.equal(again.status.failure, undefined);
    store.update(owner, sessionId, (s) => ({
      ...s,
      state: "done",
      phase: undefined,
    }));
    // Once done, another press only reads the result.
    assert.equal(store.begin(owner, press(sessionId)).start, false);

    // Removing the workspace removes its proposals.
    db.exec(`DELETE FROM agent_workspace WHERE id = '${workspaceId}'`);
    assert.throws(
      () => store.read(owner, sessionId),
      code("process_proposal_not_found"),
    );
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
