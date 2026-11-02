import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROCESS_PROPOSAL_PROFILE } from "../packages/protocol/process-proposal";
import {
  ProcessProposalStore,
  proposalReadiness,
} from "../apps/server-identity/process-proposal";
import { ProcessDefinitionSchema } from "../packages/protocol/service-processes";
import { DEFAULT_PROCESS_LIMITS } from "../apps/server-identity/process-validation";
import { processObject } from "./helpers/service-process";
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

test("sign-in readiness: a personal sign-in that is missing, one that is there, and a service that needs none", () => {
  const definition = ProcessDefinitionSchema.parse({
    schemaVersion: 1,
    kind: "workflow",
    name: "TEST readiness",
    description: "",
    trigger: "manual",
    inputSchema: processObject({}),
    outputSchema: processObject({}),
    limits: DEFAULT_PROCESS_LIMITS,
    entry: "crm",
    steps: [
      ...["crm", "mail", "wiki"].map((serviceId, index, all) => ({
        id: serviceId,
        type: "action",
        serviceId: `11111111-1111-4111-8111-00000000000${index}`,
        actionId: "read",
        input: {},
        outputSchema: processObject({}),
        next: all[index + 1] ?? "done",
      })),
      { id: "done", type: "return", output: {} },
    ],
  });
  const ids = [0, 1, 2].map(
    (index) => `11111111-1111-4111-8111-00000000000${index}`,
  );
  const services = new Map(
    [
      // Its own sign-in, which this person has not done.
      { name: "TEST CRM", auth: "oauth", shared: false, ready: false },
      // Signed in with their own account.
      { name: "TEST Mail", auth: "oauth", shared: false, ready: "personal" },
      // Uses the key it was added with.
      { name: "TEST Wiki", auth: "bearer", shared: true, ready: "shared" },
    ].map((service, index) => [ids[index]!, service]),
  );
  const asked: string[] = [];
  const catalog = {
    service: (_workspaceId: string, id: string) => {
      const known = services.get(id);
      if (!known) throw new Error("service_not_found");
      return {
        id,
        name: known.name,
        url: `https://${id}.test`,
        revision: 1,
        auth: { type: known.auth },
        hasCredential: known.shared,
        actions: [{ id: "read", effect: "read" }],
      } as never;
    },
    oauth: {
      executionReady: (
        target: { serviceId: string },
        userId: string,
        effect: "read" | "write",
      ) => {
        asked.push(`${target.serviceId}:${userId}:${effect}`);
        return services.get(target.serviceId)!.ready as never;
      },
    },
  };
  assert.deepEqual(
    proposalReadiness(definition, catalog, {
      workspaceId,
      userId: "TEST-user",
    }),
    [
      { serviceId: ids[0], name: "TEST CRM", signIn: "needed" },
      { serviceId: ids[1], name: "TEST Mail", signIn: "connected" },
      { serviceId: ids[2], name: "TEST Wiki", signIn: "none" },
    ],
  );
  assert.deepEqual(
    asked,
    ids.map((id) => `${id}:TEST-user:read`),
  );
  // A service no longer in the catalog is left out.
  services.delete(ids[2]!);
  assert.equal(
    proposalReadiness(definition, catalog, { workspaceId, userId: "TEST-user" })
      .length,
    2,
  );
});
