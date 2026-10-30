import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { FixtureStorage } from "../apps/fixture-server/storage";
import { CommandSchema } from "../packages/protocol";

test("profile chat source: committed own messages, retry, archive relocation and true deletion", () => {
  const root = mkdtempSync(join(tmpdir(), "TEST-profile-source-"));
  const workspaceId = randomUUID(),
    scope = {
      connectionId: `account-${workspaceId}`,
      serverId: "TEST-server",
      workspaceId,
      userId: "TEST-alice",
    };
  let storage = new FixtureStorage(root, scope.serverId);
  try {
    let marks = 0;
    storage.attachProfileNotification(() => {
      marks++;
      throw Error("TEST missed notification");
    });
    const command = CommandSchema.parse({
      type: "message.send",
      conversationId: "conversation-1",
      commandId: "TEST-one",
      idempotencyKey: "TEST-one",
      text: "TEST I build green projects",
      language: "en",
    });
    const reply = {
      kind: "reply" as const,
      contactId: null,
      localStart: null,
      title: null,
      durationMinutes: null,
      reply: "TEST SERVICE RESULT never source",
    };
    assert.equal(
      storage.execute(scope, command, {
        decision: reply,
        expectedCursor: storage.snapshot(scope).cursor,
        timeZone: "UTC",
      }).status,
      "accepted",
    );
    assert(marks > 0);
    const refs = storage.profileRefs(scope, 0);
    assert.equal(refs.length, 1);
    const ref = refs[0]!;
    assert.equal(
      storage.profileChat(scope, ref)?.text,
      "TEST I build green projects",
    );
    assert(!JSON.stringify(ref).includes("green projects"));
    storage.execute(scope, command, {
      decision: reply,
      expectedCursor: storage.snapshot(scope).cursor,
      timeZone: "UTC",
    });
    assert.equal(storage.profileRefs(scope, 0).length, 1);
    assert.equal(
      storage.profileChat({ ...scope, userId: "TEST-bob" }, ref),
      null,
    );
    storage.startSession(scope, "conversation-1");
    assert.equal(storage.profileChat(scope, ref), null);
    const moved = storage.profileRefs(scope, 0)[0]!;
    assert.equal(moved.sourceId, ref.sourceId);
    assert.equal(moved.sequence, ref.sequence);
    assert(moved.sourceVersion > ref.sourceVersion);
    assert(
      storage
        .profileSource(scope, moved.sourceId)
        ?.href.startsWith("/chat/archived-"),
    );
    storage.close();
    storage = new FixtureStorage(root, scope.serverId);
    assert.equal(storage.profileRefs(scope, 0).length, 1);
    storage.execute(
      scope,
      CommandSchema.parse({
        type: "conversation.delete",
        conversationId: decodeURIComponent(
          storage
            .profileSource(scope, moved.sourceId)!
            .href.slice("/chat/".length),
        ),
        commandId: "TEST-delete",
        idempotencyKey: "TEST-delete",
      }),
    );
    assert.equal(storage.profileChat(scope, moved), null);
    assert.equal(storage.profileSource(scope, moved.sourceId), null);
    assert.equal(storage.profileRefs(scope, 0).length, 1);
    assert.equal(storage.profileOwners().length, 1);
  } finally {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("profile chat source: failed source transaction exposes neither message nor reference", () => {
  const root = mkdtempSync(join(tmpdir(), "TEST-profile-rollback-"));
  const workspaceId = randomUUID(),
    scope = {
      connectionId: `account-${workspaceId}`,
      serverId: "TEST-server",
      workspaceId,
      userId: "TEST-alice",
    };
  let fail = true;
  const storage = new FixtureStorage(
    root,
    scope.serverId,
    Date.now,
    (stage, change) => {
      if (fail && stage === "before_commit" && change === "command")
        throw Error("TEST commit refused");
    },
  );
  try {
    const command = CommandSchema.parse({
      type: "message.send",
      conversationId: "conversation-1",
      commandId: "TEST-rollback",
      idempotencyKey: "TEST-rollback",
      text: "TEST own text",
      language: "en",
    });
    assert.throws(() => storage.execute(scope, command), /TEST commit refused/);
    assert.deepEqual(storage.profileRefs(scope, 0), []);
    fail = false;
    storage.execute(scope, command, {
      decision: {
        kind: "reply",
        contactId: null,
        localStart: null,
        title: null,
        durationMinutes: null,
        reply: "TEST reply",
      },
      expectedCursor: storage.snapshot(scope).cursor,
      timeZone: "UTC",
    });
    assert.equal(storage.profileRefs(scope, 0).length, 1);
  } finally {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("profile meeting source: published owner me turns only; null-assignee, other/unknown and single track excluded", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { MeetingStore } = await import(
    "../apps/server-identity/meeting-store"
  );
  const root = mkdtempSync(join(tmpdir(), "TEST-profile-meeting-")),
    db = new DatabaseSync(join(root, "identity.sqlite"));
  const store = new MeetingStore(db),
    scope = {
      connectionId: "TEST-account",
      serverId: "TEST-server",
      workspaceId: "TEST-workspace",
      userId: "TEST-alice",
    };
  try {
    for (const stereo of [true, false]) {
      const id = randomUUID(),
        at = new Date().toISOString();
      store.create(scope, {
        profile: "niaro-meetings/1",
        id,
        title: "TEST planning",
        recordedAt: at,
        language: "en",
        mimeType: "audio/wav",
        bytes: 1,
        ...(stereo ? { speakerChannels: "self-others" as const } : {}),
      });
      store.update(scope, id, { durationSeconds: 60, status: "analyzing" });
      const own = "TEST I prepare green reports.",
        other = "TEST Bob owns red projects.",
        unknown = "TEST unknown person manages blue accounts.";
      store.putTranscript(
        scope,
        id,
        [
          {
            index: 0,
            startSeconds: 0,
            endSeconds: 60,
            text: [own, other, unknown].join(" "),
            reviewReasons: [],
            transcriber: "TEST",
            analyzer: null,
            analysis: null,
          },
        ],
        [
          { start: 0, end: 10, speaker: "me", text: own },
          { start: 10, end: 20, speaker: "others", text: other },
          { start: 20, end: 30, speaker: "unknown", text: unknown },
        ],
      );
      store.publishRecord(
        scope,
        id,
        {
          summary: other,
          summarySources: [{ segment: 0, quote: other }],
          points: [],
          overflow: false,
          tasks: [
            {
              text: "TEST own task",
              owner: "me",
              assignee: null,
              due: null,
              sources: [{ segment: 0, quote: own }],
            },
            {
              text: "TEST null assignee is not me",
              assignee: null,
              due: null,
              sources: [{ segment: 0, quote: other }],
            },
          ],
        },
        "TEST-model",
      );
      const ref = store
        .profileRefs(scope, 0)
        .find((ref) => ref.meetingId === id)!;
      assert(ref);
      assert.equal(
        store.profileMeeting({ ...scope, userId: "TEST-bob" }, ref),
        null,
      );
      const material = store.profileMeeting(scope, ref);
      if (stereo) {
        assert.deepEqual(material?.ownText, [own]);
        assert.deepEqual(material?.ownTasks, ["TEST own task"]);
      } else assert.equal(material, null);
      store.publishRecord(
        scope,
        id,
        {
          summary: "",
          summarySources: [],
          points: [],
          tasks: [],
          overflow: false,
        },
        "TEST-retry",
      );
      assert.equal(
        store.profileRefs(scope, 0).filter((ref) => ref.meetingId === id)
          .length,
        1,
      );
      store.delete(scope, id);
      assert.equal(store.profileMeeting(scope, ref), null);
      assert.equal(store.profileSource(scope, ref.sourceId), null);
    }
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("profile used services: names of own bound succeeded finite receipts only, never result/input", async () => {
  const { DatabaseSync } = await import("node:sqlite"),
    { ServiceCatalogStore } = await import(
      "../apps/server-identity/service-catalog"
    );
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE organization(id TEXT PRIMARY KEY);CREATE TABLE agent_workspace(id TEXT PRIMARY KEY,organization_id TEXT);INSERT INTO organization VALUES('TEST-org');INSERT INTO agent_workspace VALUES('TEST-workspace','TEST-org');",
  );
  const catalog = new ServiceCatalogStore(db, "TEST secret", []);
  try {
    catalog.saveTurn("TEST-turn", "TEST-workspace", "TEST-alice", {
      commandId: "TEST-command",
      conversationId: "TEST-chat",
      aliases: [{ logicalMessageId: "TEST-logical" }],
    });
    const base = {
      id: "TEST-ok",
      organizationId: "TEST-org",
      workspaceId: "TEST-workspace",
      userId: "TEST-alice",
      serviceId: "TEST-service",
      actionId: "TEST-action",
      serviceRevision: 1,
      actionRevision: 1,
      policyRevision: 1,
      input: { secret: "TEST input never learned" },
      status: "succeeded" as const,
      completedAt: Date.now(),
      title: "TEST Lookup",
      serviceName: "TEST CRM",
      effect: "read" as const,
      result: { secret: "TEST result never learned" },
    };
    for (const [index, patch] of [
      {},
      { status: "running" as const },
      { completedAt: undefined },
      { userId: "TEST-bob" },
      { organizationId: "TEST-other-org" },
    ].entries()) {
      const value = { ...base, ...patch, id: `TEST-${index}` };
      catalog.saveInvocation(value);
      catalog.linkTurnOperation(
        "TEST-turn",
        value.id,
        "TEST-workspace",
        value.userId,
      );
    }
    catalog.saveInvocation({ ...base, id: "TEST-unbound" });
    assert.deepEqual(
      catalog.profileUsedActions(
        "TEST-org",
        "TEST-workspace",
        "TEST-alice",
        "TEST-command",
        "TEST-chat",
      ),
      [{ service: "TEST CRM", action: "TEST Lookup" }],
    );
    assert.deepEqual(
      catalog.profileUsedActions(
        "TEST-org",
        "TEST-workspace",
        "TEST-alice",
        "TEST-logical",
        "TEST-chat",
      ),
      [{ service: "TEST CRM", action: "TEST Lookup" }],
    );
    assert.deepEqual(
      catalog.profileUsedActions(
        "TEST-org",
        "TEST-workspace",
        "TEST-bob",
        "TEST-command",
        "TEST-chat",
      ),
      [],
    );
    assert.deepEqual(
      catalog.profileUsedActions(
        "TEST-org",
        "TEST-workspace",
        "TEST-alice",
        "TEST-command",
        "TEST-other-chat",
      ),
      [],
    );
  } finally {
    db.close();
  }
});
