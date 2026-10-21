import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixtureStorage } from "../apps/fixture-server/storage";
import {
  CommandSchema,
  SnapshotSchema,
  WorkItemSchema,
  type WorkItem,
} from "../packages/protocol";

const scope = {
  connectionId: "fixture-a",
  serverId: "fixture-0123456789abcdef01234567",
  userId: "alice",
  workspaceId: "a",
};
const command = (value: object) => CommandSchema.parse(value);
const reply = (text: string) => ({
  kind: "reply" as const,
  contactId: null,
  localStart: null,
  title: null,
  durationMinutes: null,
  reply: text,
});
const work = (status: WorkItem["status"], revision = 1) =>
  WorkItemSchema.parse({
    id: "TEST-native-run",
    revision,
    conversationId: "chat-TEST-work",
    title: "TEST task",
    context: "TEST context",
    status,
    inputRequestIds: [],
    actionProposalIds: [],
    operationIds: [],
    demo: false,
    native: { runId: "TEST-native-run", revision },
    presentation: { type: "workflow.progress", version: 1, variant: "default" },
  });

test("a deleted chat that a finished task still points at stays only as an empty reference, across restarts", () => {
  const directory = mkdtempSync(join(tmpdir(), "TEST-directory-storage-"));
  let now = Date.parse("2026-10-17T08:00:00.000Z");
  let storage = new FixtureStorage(directory, scope.serverId, () => now);
  try {
    storage.execute(
      scope,
      command({
        type: "conversation.create",
        conversationId: "chat-TEST-work",
        commandId: "TEST-create",
        idempotencyKey: "TEST-create",
      }),
    );
    storage.execute(
      scope,
      command({
        type: "message.send",
        conversationId: "chat-TEST-work",
        commandId: "TEST-ask",
        idempotencyKey: "TEST-ask",
        text: "TEST secret request",
        language: "en",
        mentions: [{ kind: "skill", id: "TEST-skill" }],
      }),
      {
        decision: reply("TEST secret reply"),
        expectedCursor: storage.snapshot(scope, "chat-TEST-work").cursor,
        timeZone: "UTC",
      },
    );
    const stored = storage.snapshot(scope, "chat-TEST-work");
    expect(
      stored.conversations
        .find((c) => c.id === "chat-TEST-work")!
        .messages.map((m) => m.createdAt),
    ).toEqual(["2026-10-17T08:00:00.000Z", "2026-10-17T08:00:00.000Z"]);
    storage.syncNativeWork(scope, [work("running")], true);
    const remove = command({
      type: "conversation.delete",
      conversationId: "chat-TEST-work",
      commandId: "TEST-delete",
      idempotencyKey: "TEST-delete",
    });
    expect(storage.execute(scope, remove).code).toBe("operation_in_progress");
    storage.syncNativeWork(scope, [work("succeeded", 2)], true);
    const removed = command({
      ...remove,
      commandId: "TEST-delete-2",
      idempotencyKey: "TEST-delete-2",
    });
    now += 60_000;
    const result = storage.execute(scope, removed);
    expect(result.code).toBe("accepted");
    const check = () => {
      const snapshot = SnapshotSchema.parse(
        storage.snapshot(scope, "chat-TEST-work"),
      );
      expect(snapshot.workItems.map((w) => w.id)).toEqual(["TEST-native-run"]);
      expect(
        snapshot.conversations.find((c) => c.id === "chat-TEST-work")?.messages,
      ).toEqual([]);
      expect(
        storage.conversations(scope).conversations.map((c) => c.id),
      ).not.toContain("chat-TEST-work");
      expect(storage.conversationMessages(scope, "chat-TEST-work")).toBeNull();
      expect(JSON.stringify(storage.events(scope, 0))).not.toContain(
        "TEST secret",
      );
    };
    check();
    // The task window keeps publishing the finished task without the chat.
    storage.syncNativeWork(scope, [work("succeeded", 3)], true);
    check();
    expect(
      storage.execute(
        scope,
        command({
          type: "message.send",
          conversationId: "chat-TEST-work",
          commandId: "TEST-after",
          idempotencyKey: "TEST-after",
          text: "TEST after deletion",
          language: "en",
        }),
      ).code,
    ).toBe("unknown_context");
    storage.close();
    storage = new FixtureStorage(directory, scope.serverId, () => now);
    check();
    // The original request's receipt answers its replay, without its words.
    const original = storage.replay(
      scope,
      command({
        type: "message.send",
        conversationId: "chat-TEST-work",
        commandId: "TEST-ask",
        idempotencyKey: "TEST-ask",
        text: "TEST secret request",
        language: "en",
        mentions: [{ kind: "skill", id: "TEST-skill" }],
      }),
    );
    expect(original?.code).toBe("idempotency_conflict");
    expect(storage.replay(scope, removed)?.code).toBe("accepted");
  } finally {
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a renamed chat keeps its name through archiving; an archive can be renamed and deleted", () => {
  const directory = mkdtempSync(join(tmpdir(), "TEST-directory-archive-"));
  const storage = new FixtureStorage(directory, scope.serverId);
  try {
    const ask = (id: string, text: string, session?: "new") =>
      storage.execute(
        scope,
        command({
          type: "message.send",
          conversationId: "conversation-1",
          commandId: id,
          idempotencyKey: id,
          text,
          language: "en",
          ...(session ? { session } : {}),
        }),
        {
          decision: reply("TEST reply"),
          expectedCursor: storage.snapshot(scope).cursor,
          timeZone: "UTC",
        },
      );
    ask("TEST-a1", "TEST first session");
    storage.execute(
      scope,
      command({
        type: "conversation.rename",
        conversationId: "conversation-1",
        commandId: "TEST-name",
        idempotencyKey: "TEST-name",
        title: "TEST named",
      }),
    );
    // A new session archives the chat with its name; the live chat starts unnamed.
    storage.startSession(scope);
    ask("TEST-a2", "TEST second session");
    const list = () => storage.conversations(scope).conversations;
    const archive = list().find((c) => c.readOnly)!;
    expect(archive.title).toBe("TEST named");
    expect(list().find((c) => c.id === "conversation-1")?.title).toBe(
      "TEST second session",
    );
    storage.execute(
      scope,
      command({
        type: "conversation.rename",
        conversationId: archive.id,
        commandId: "TEST-name-archive",
        idempotencyKey: "TEST-name-archive",
        title: "TEST archive",
      }),
    );
    expect(list().find((c) => c.id === archive.id)?.title).toBe("TEST archive");
    expect(
      storage.execute(
        scope,
        command({
          type: "conversation.delete",
          conversationId: archive.id,
          commandId: "TEST-drop-archive",
          idempotencyKey: "TEST-drop-archive",
        }),
      ).code,
    ).toBe("accepted");
    expect(list().map((c) => c.id)).toEqual(["conversation-1"]);
    expect(JSON.stringify(storage.sessions(scope))).not.toContain(
      "TEST first session",
    );
  } finally {
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an archived chat leaves the list, refuses turns and returns with its messages in a new native generation", () => {
  const directory = mkdtempSync(join(tmpdir(), "TEST-directory-archive-chat-"));
  let now = Date.parse("2026-10-17T08:00:00.000Z");
  let storage = new FixtureStorage(directory, scope.serverId, () => now);
  const id = "chat-TEST-work";
  const directoryCommand = (
    type: "conversation.archive" | "conversation.restore",
    key: string,
    conversationId = id,
  ) =>
    storage.execute(
      scope,
      command({ type, conversationId, commandId: key, idempotencyKey: key }),
    );
  const ask = (key: string, text: string) =>
    storage.execute(
      scope,
      command({
        type: "message.send",
        conversationId: id,
        commandId: key,
        idempotencyKey: key,
        text,
        language: "en",
      }),
      {
        decision: reply(`TEST reply to ${text}`),
        expectedCursor: storage.snapshot(scope, id).cursor,
        timeZone: "UTC",
      },
    );
  const ids = (state?: "active" | "archived") =>
    storage.conversations(scope, null, state).conversations.map((c) => c.id);
  try {
    storage.execute(
      scope,
      command({
        type: "conversation.create",
        conversationId: id,
        commandId: "TEST-create",
        idempotencyKey: "TEST-create",
      }),
    );
    ask("TEST-ask", "TEST first");
    storage.syncNativeWork(scope, [work("waiting_input")], true);
    // An open question still waits in the chat.
    expect(directoryCommand("conversation.archive", "TEST-arch-0").code).toBe(
      "operation_in_progress",
    );
    storage.syncNativeWork(scope, [work("succeeded", 2)], true);
    const generation = storage.conversationSession(scope, id);
    now += 60_000;
    expect(directoryCommand("conversation.archive", "TEST-arch-1").code).toBe(
      "accepted",
    );
    // The same press and a late second press both succeed.
    expect(directoryCommand("conversation.archive", "TEST-arch-1").code).toBe(
      "accepted",
    );
    expect(directoryCommand("conversation.archive", "TEST-arch-2").code).toBe(
      "accepted",
    );
    const archivedCheck = () => {
      expect(ids("active")).not.toContain(id);
      expect(ids("archived")).toEqual([id]);
      const row = storage
        .conversations(scope)
        .conversations.find((c) => c.id === id)!;
      expect(row).toMatchObject({ readOnly: true, messageCount: 2 });
      expect(row.updatedAt).toBe("2026-10-17T08:01:00.000Z");
      // The finished task keeps an empty reference to its chat.
      const snapshot = SnapshotSchema.parse(storage.snapshot(scope, id));
      expect(snapshot.conversations.find((c) => c.id === id)?.messages).toEqual(
        [],
      );
      expect(
        storage.conversationMessages(scope, id)!.messages.map((m) => m.text),
      ).toEqual(["TEST first", "TEST reply to TEST first"]);
    };
    archivedCheck();
    expect(ask("TEST-ask-archived", "TEST while archived").code).toBe(
      "unknown_context",
    );
    // The task window keeps publishing the finished task.
    storage.syncNativeWork(scope, [work("succeeded", 3)], true);
    storage.close();
    storage = new FixtureStorage(directory, scope.serverId, () => now);
    archivedCheck();
    // An archived chat can still be renamed.
    expect(
      storage.execute(
        scope,
        command({
          type: "conversation.rename",
          conversationId: id,
          commandId: "TEST-arch-name",
          idempotencyKey: "TEST-arch-name",
          title: "TEST archived name",
        }),
      ).code,
    ).toBe("accepted");

    now += 60_000;
    expect(directoryCommand("conversation.restore", "TEST-restore").code).toBe(
      "accepted",
    );
    expect(
      directoryCommand("conversation.restore", "TEST-restore-2").code,
    ).toBe("accepted");
    expect(ids("archived")).toEqual([]);
    expect(ids("active")).toContain(id);
    const restored = storage
      .conversations(scope, null, "active")
      .conversations.find((c) => c.id === id)!;
    expect(restored).toMatchObject({
      readOnly: false,
      title: "TEST archived name",
      updatedAt: "2026-10-17T08:02:00.000Z",
    });
    const live = storage
      .snapshot(scope, id)
      .conversations.find((c) => c.id === id)!;
    expect(live.messages.map((m) => m.text)).toEqual([
      "TEST first",
      "TEST reply to TEST first",
    ]);
    // A fresh native generation: the archived thread is never resumed.
    const next = storage.conversationSession(scope, id);
    expect(next).toMatch(/^[a-f0-9]{64}$/);
    expect(next).not.toBe(generation);
    expect(ask("TEST-ask-again", "TEST continued").code).toBe("accepted");
    expect(
      storage.conversationMessages(scope, id)!.messages.map((m) => m.text),
    ).toEqual([
      "TEST first",
      "TEST reply to TEST first",
      "TEST continued",
      "TEST reply to TEST continued",
    ]);
    // The receipt of a repeated restore stays; deleting still works after.
    expect(
      storage.replay(
        scope,
        command({
          type: "conversation.restore",
          conversationId: id,
          commandId: "TEST-restore",
          idempotencyKey: "TEST-restore",
        }),
      )?.code,
    ).toBe("accepted");
  } finally {
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("archiving the main chat moves its messages into the archive; a session archive restores in place", () => {
  const directory = mkdtempSync(join(tmpdir(), "TEST-directory-archive-main-"));
  const storage = new FixtureStorage(directory, scope.serverId);
  const run = (value: object) => storage.execute(scope, command(value));
  const ask = (key: string, conversationId: string, text: string) =>
    storage.execute(
      scope,
      command({
        type: "message.send",
        conversationId,
        commandId: key,
        idempotencyKey: key,
        text,
        language: "en",
      }),
      {
        decision: reply("TEST reply"),
        expectedCursor: storage.snapshot(scope, conversationId).cursor,
        timeZone: "UTC",
      },
    );
  try {
    ask("TEST-m1", "conversation-1", "TEST main request");
    const before = storage.conversationSession(scope, "conversation-1");
    expect(
      run({
        type: "conversation.archive",
        conversationId: "conversation-1",
        commandId: "TEST-m-arch",
        idempotencyKey: "TEST-m-arch",
      }).code,
    ).toBe("accepted");
    const archives = storage.conversations(
      scope,
      null,
      "archived",
    ).conversations;
    expect(archives).toHaveLength(1);
    const archive = archives[0]!;
    expect(archive).toMatchObject({
      readOnly: true,
      title: "TEST main request",
      messageCount: 2,
    });
    expect(
      storage
        .snapshot(scope, "conversation-1")
        .conversations.find((c) => c.id === "conversation-1")?.messages,
    ).toEqual([]);
    // The main chat continues in a new native generation.
    expect(storage.conversationSession(scope, "conversation-1")).not.toBe(
      before,
    );
    expect(JSON.stringify(storage.sessions(scope))).toContain(
      "TEST main request",
    );
    // A hub item's chat is never archived; unknown chats are refused.
    for (const conversationId of ["chat-hub-TEST", "chat-TEST-missing"])
      expect(
        run({
          type: "conversation.archive",
          conversationId,
          commandId: `TEST-arch-${conversationId}`,
          idempotencyKey: `TEST-arch-${conversationId}`,
        }).code,
      ).toBe("unknown_context");
    expect(
      ask("TEST-archived-ask", archive.id, "TEST into the archive").code,
    ).toBe("unknown_context");

    expect(
      run({
        type: "conversation.restore",
        conversationId: archive.id,
        commandId: "TEST-m-restore",
        idempotencyKey: "TEST-m-restore",
      }).code,
    ).toBe("accepted");
    expect(
      storage
        .conversations(scope, null, "active")
        .conversations.map((c) => c.id),
    ).toContain(archive.id);
    expect(ask("TEST-m2", archive.id, "TEST restored request").code).toBe(
      "accepted",
    );
    const page = storage.conversationMessages(scope, archive.id)!;
    expect(page.conversation.readOnly).toBe(false);
    expect(page.messages.map((m) => m.text)).toEqual([
      "TEST main request",
      "TEST reply",
      "TEST restored request",
      "TEST reply",
    ]);
    // A restored chat can be deleted like any other.
    expect(
      run({
        type: "conversation.delete",
        conversationId: archive.id,
        commandId: "TEST-m-delete",
        idempotencyKey: "TEST-m-delete",
      }).code,
    ).toBe("accepted");
    expect(JSON.stringify(storage.sessions(scope))).not.toContain(
      "TEST main request",
    );
  } finally {
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
