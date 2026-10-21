import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FixtureStorage } from "../apps/fixture-server/storage";
import { messageCommand } from "../packages/client-core/commands";
import { scopeFor } from "../packages/test-fixtures";
import type { Command, Scope } from "../packages/protocol";
import {
  loadConversationPins,
  saveConversationPins,
} from "../packages/client-core/conversation-preferences";

const scope = scopeFor();
const create = (id: string, key = id): Command => ({
  type: "conversation.create",
  conversationId: id,
  commandId: key,
  idempotencyKey: key,
});
const reply = (
  storage: FixtureStorage,
  conversationId: string,
  key: string,
  actor: Scope = scope,
) => {
  const command = {
    ...messageCommand(`TEST question ${key}`, "en", key),
    conversationId,
  };
  return storage.execute(actor, command, {
    expectedCursor: storage.snapshot(actor, conversationId).cursor,
    timeZone: "UTC",
    decision: {
      kind: "reply",
      reply: `TEST answer ${key}`,
      title: null,
      contactId: null,
      localStart: null,
      durationMinutes: null,
    },
  });
};
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "TEST-chat-history-"));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

test("durable history pages contain every chat beyond the live projection and every public message beyond 500", () => {
  let storage = new FixtureStorage(directory, scope.serverId);
  for (let n = 0; n < 75; n++) {
    const id = `TEST-chat-${n}`;
    expect(storage.execute(scope, create(id)).status).toBe("accepted");
    expect(reply(storage, id, `q-${n}`).status).toBe("accepted");
  }
  expect(storage.snapshot(scope).conversations.length).toBeLessThan(50);
  expect(storage.createdConversation(scope, "TEST-chat-0")).toBe(true);
  expect(
    storage.createdConversation(
      { ...scope, userId: "test-other-user" },
      "TEST-chat-0",
    ),
  ).toBe(false);
  expect(() =>
    storage.createdConversation(
      { ...scope, connectionId: "TEST-other-connection" },
      "TEST-chat-0",
    ),
  ).toThrow("Persisted workspace mismatch");
  expect(() =>
    storage.createdConversation(
      { ...scope, serverId: "TEST-foreign-server" },
      "TEST-chat-0",
    ),
  ).toThrow("Persisted workspace mismatch");
  expect(storage.createdConversation(scopeFor("b"), "TEST-chat-0")).toBe(false);
  const ids: string[] = [];
  let after: string | null = null;
  do {
    const page = storage.conversations(scope, after);
    ids.push(...page.conversations.map((c) => c.id));
    after = page.nextAfter;
  } while (after);
  expect(new Set(ids).size).toBe(76);
  expect(ids).toContain("TEST-chat-0");
  // Import a real legacy-sized public projection, then append through production commands.
  storage.close();
  const fixtureDb = new DatabaseSync(join(directory, "workflow.sqlite"));
  const row = fixtureDb
    .prepare("SELECT scope_key,state FROM workflows LIMIT 1")
    .get()!;
  const state = JSON.parse(String(row.state));
  state.snapshot.conversations = state.snapshot.conversations.filter(
    (c: { id: string }) => c.id !== "TEST-chat-0",
  );
  state.snapshot.conversations.push({
    id: "TEST-chat-0",
    revision: 501,
    messages: Array.from({ length: 500 }, (_, n) => ({
      id: `TEST-seeded-${n}`,
      role: n % 2 === 0 ? "user" : "assistant",
      text: `TEST historical message ${n}`,
    })),
  });
  fixtureDb
    .prepare("UPDATE workflows SET state=? WHERE scope_key=?")
    .run(JSON.stringify(state), row.scope_key!);
  fixtureDb
    .prepare(
      "DELETE FROM public_conversation_message WHERE conversation_id='TEST-chat-0'",
    )
    .run();
  fixtureDb.close();
  storage = new FixtureStorage(directory, scope.serverId);
  reply(storage, "TEST-chat-0", "beyond-500");
  expect(
    storage
      .snapshot(scope, "TEST-chat-0")
      .conversations.find((c) => c.id === "TEST-chat-0")!.messages,
  ).toHaveLength(500);
  const messages: string[] = [];
  after = null;
  let revision: number | undefined;
  do {
    const page: NonNullable<
      ReturnType<FixtureStorage["conversationMessages"]>
    > = storage.conversationMessages(scope, "TEST-chat-0", after, revision)!;
    revision = page.conversation.revision;
    messages.unshift(...page.messages.map((m) => m.id));
    after = page.nextAfter;
  } while (after);
  expect(messages).toHaveLength(502);
  expect(new Set(messages).size).toBe(502);
  const first = storage.conversationMessages(scope, "TEST-chat-0")!;
  storage.close();
  storage = new FixtureStorage(directory, scope.serverId);
  expect(storage.conversationMessages(scope, "TEST-chat-0")).toEqual(first);
  expect(storage.createdConversation(scope, "TEST-chat-0")).toBe(true);
  expect(reply(storage, "TEST-chat-0", "reopened").status).toBe("accepted");
  expect(
    storage.conversationMessages(scope, "TEST-chat-0")!.conversation
      .messageCount,
  ).toBe(504);
  storage.close();
});

test("creation replays exactly, has atomic registry/receipt ownership and never retargets an existing chat", () => {
  const checkpoint = jest.fn();
  let storage = new FixtureStorage(
    directory,
    scope.serverId,
    Date.now,
    checkpoint,
  );
  const command = create("TEST-A");
  expect(storage.createdConversation(scope, "conversation-1")).toBe(false);
  expect(
    storage.execute(scope, create("conversation-1", "TEST-rejected-existing"))
      .status,
  ).toBe("rejected");
  expect(storage.createdConversation(scope, "conversation-1")).toBe(false);
  expect(storage.createdConversation(scope, "TEST-A")).toBe(false);
  expect(storage.execute(scope, command).status).toBe("accepted");
  expect(storage.execute(scope, command).status).toBe("accepted");
  expect(storage.createdConversation(scope, "TEST-A")).toBe(true);
  expect(
    storage.execute(scope, { ...command, conversationId: "TEST-B" }).code,
  ).toBe("idempotency_conflict");
  checkpoint.mockImplementation((stage: string) => {
    if (stage === "before_commit") throw Error("TEST crash");
  });
  expect(() => storage.execute(scope, create("TEST-crash"))).toThrow(
    "TEST crash",
  );
  expect(storage.createdConversation(scope, "TEST-crash")).toBe(false);
  expect(
    storage
      .conversations(scope)
      .conversations.some((c) => c.id === "TEST-crash"),
  ).toBe(false);
  storage.close();
  storage = new FixtureStorage(directory, scope.serverId);
  expect(storage.execute(scope, command).status).toBe("accepted");
  expect(storage.createdConversation(scope, "TEST-A")).toBe(true);
  expect(storage.createdConversation(scope, "TEST-crash")).toBe(false);
  expect(
    storage.execute(scope, create("TEST-A", "different-command")).status,
  ).toBe("rejected");
  expect(storage.execute(scope, create("TEST-crash")).status).toBe("accepted");
  storage.close();
});

test("history is scope bound, revisions cannot be mixed, and stored structured cards are not passive history authority", () => {
  const storage = new FixtureStorage(directory, scope.serverId);
  storage.execute(scope, create("TEST-A"));
  reply(storage, "TEST-A", "one");
  const page = storage.conversationMessages(scope, "TEST-A")!;
  expect(storage.conversationMessages(scopeFor("b"), "TEST-A")).toBeNull();
  expect(
    storage.conversationMessages({ ...scope, userId: "bob" }, "TEST-A"),
  ).toBeNull();
  reply(storage, "TEST-A", "two");
  expect(
    storage.conversationMessages(
      scope,
      "TEST-A",
      page.nextAfter,
      page.conversation.revision,
    ),
  ).toBeUndefined();
  const db = new DatabaseSync(join(directory, "workflow.sqlite"));
  const row = db
    .prepare(
      "SELECT rowid,payload FROM public_conversation_message WHERE conversation_id='TEST-A' AND json_extract(payload,'$.role')='assistant' LIMIT 1",
    )
    .get()!;
  const message = JSON.parse(String(row.payload));
  message.result = {
    type: "crm.contacts",
    version: 1,
    source: "twenty",
    contacts: [{ id: "TEST-private", name: "TEST private structured detail" }],
    hasMore: false,
  };
  db.prepare(
    "UPDATE public_conversation_message SET payload=? WHERE rowid=?",
  ).run(JSON.stringify(message), row.rowid!);
  db.close();
  expect(
    JSON.stringify(storage.conversationMessages(scope, "TEST-A")),
  ).not.toContain("TEST private structured detail");
  storage.close();
});

test("legacy archives migrate to stable read-only IDs without rebinding their original task ownership", () => {
  let storage = new FixtureStorage(directory, scope.serverId);
  storage.execute(scope, messageCommand("Choose Peter", "en", "legacy"));
  const before = storage.snapshot(scope);
  storage.startSession(scope);
  const db = new DatabaseSync(join(directory, "workflow.sqlite"));
  db.exec(
    "DROP TABLE public_conversation_message; DROP TABLE public_conversation",
  );
  db.close();
  storage.close();
  storage = new FixtureStorage(directory, scope.serverId);
  const archived = storage
    .conversations(scope)
    .conversations.find((c) => c.readOnly)!;
  expect(archived.id).toBe("archived-1");
  const page = storage.conversationMessages(scope, archived.id)!;
  expect(page.messages.map((m) => m.text)).toEqual(
    before.conversations[0]!.messages.map((m) => m.text),
  );
  expect(
    page.messages.every((m) => !m.workItemId && !m.inputRequestId && !m.result),
  ).toBe(true);
  expect(
    storage.execute(scope, {
      ...messageCommand("TEST unsafe archived reply", "en", "archived-send"),
      conversationId: archived.id,
    }).status,
  ).toBe("rejected");
  expect(storage.snapshot(scope).workItems[0]!.conversationId).toBe(
    "conversation-1",
  );
  storage.close();
  storage = new FixtureStorage(directory, scope.serverId);
  expect(
    storage.conversations(scope).conversations.find((c) => c.readOnly)!.id,
  ).toBe(archived.id);
  storage.close();
});

test("pins persist only IDs under the complete session identity and malformed storage fails visibly", async () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: async (key: string) => data.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      data.set(key, value);
    },
  };
  await saveConversationPins(storage, "TEST-identity-A", ["TEST-A"]);
  expect(await loadConversationPins(storage, "TEST-identity-A")).toEqual([
    "TEST-A",
  ]);
  expect(await loadConversationPins(storage, "TEST-identity-B")).toEqual([]);
  await expect(
    saveConversationPins(storage, "TEST-identity-A", ["TEST-A", "TEST-A"]),
  ).rejects.toThrow();
  expect([...data.values()].join()).not.toContain("question");
});
