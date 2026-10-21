import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixtureStorage } from "../apps/fixture-server/storage";
import { ModelService } from "../apps/fixture-server/model-service";
import { scopeFor } from "../packages/test-fixtures";
import { messageCommand } from "../packages/client-core/commands";
import type { Command, Scope } from "../packages/protocol";
import {
  CHAT_IDLE_MS,
  chatBackgrounded,
  chatResumed,
  resetChatSession,
  withChatSession,
} from "../apps/mobile/chat-session";

const scope: Scope = {
  connectionId: "fixture-a",
  serverId: "test-server",
  userId: "alice",
  workspaceId: "a",
};
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "agent-chat-session-"));
  resetChatSession();
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

const newSession = (command: Command) =>
  ({ ...command, session: "new" }) as Command;

test("a new session archives earlier chat, keeps work and starts memory afresh", () => {
  const storage = new FixtureStorage(directory, "test-server");
  storage.execute(scope, messageCommand("Choose Peter", "en", "first"));
  const before = storage.snapshot(scope);
  const earlier = before.conversations[0]!.messages;
  expect(earlier.length).toBeGreaterThan(0);

  const next = newSession(
    messageCommand("Schedule a meeting with Peter next week", "en", "second"),
  );
  storage.execute(scope, next);
  const after = storage.snapshot(scope);
  const current = after.conversations[0]!.messages;
  // Only the new exchange remains in the live chat.
  expect(current.some((m) => earlier.some((e) => e.id === m.id))).toBe(false);
  expect(current[0]).toMatchObject({
    role: "user",
    text: "Schedule a meeting with Peter next week",
  });
  // Work items are not part of the chat archive; they stay for Tasks.
  expect(after.workItems.map((w) => w.id)).toEqual(
    expect.arrayContaining(before.workItems.map((w) => w.id)),
  );
  expect(storage.modelState(scope, "Europe/Prague").activeMeeting).toBeNull();

  const archive = storage.sessions(scope);
  expect(archive).toHaveLength(1);
  expect(archive[0]!.messages).toEqual(earlier);

  // Delivering the same command again replays it without archiving anything.
  storage.execute(scope, next);
  expect(storage.sessions(scope)).toHaveLength(1);
  expect(storage.snapshot(scope).conversations[0]!.messages).toEqual(current);
  storage.close();
});

test("an empty chat opens a session without writing an empty archive", () => {
  const storage = new FixtureStorage(directory, "test-server");
  storage.execute(scope, newSession(messageCommand("Hi", "en", "only")));
  expect(storage.sessions(scope)).toHaveLength(0);
  storage.close();
});

test("only the first new request of a device session is marked", () => {
  const first = withChatSession(messageCommand("One", "en", "1"));
  const second = withChatSession(messageCommand("Two", "en", "2"));
  expect(first).toMatchObject({ session: "new" });
  expect(second).not.toHaveProperty("session");
});

test("replies to an open question never start a session", () => {
  const reply = withChatSession({
    ...messageCommand("Peter", "en", "reply"),
    context: {
      workItemId: "work-1",
      inputRequestId: "input-1",
      expectedInputRevision: 1,
    },
  } as Command);
  expect(reply).not.toHaveProperty("session");
  // The unused fresh session still applies to the next new request.
  expect(withChatSession(messageCommand("New", "en", "3"))).toMatchObject({
    session: "new",
  });
});

test("a short pause keeps the session; long inactivity starts a new one", () => {
  withChatSession(messageCommand("One", "en", "1"));
  chatBackgrounded(0);
  expect(chatResumed(CHAT_IDLE_MS - 1)).toBe(false);
  expect(withChatSession(messageCommand("Two", "en", "2"))).not.toHaveProperty(
    "session",
  );
  chatBackgrounded(1_000);
  expect(chatResumed(1_000 + CHAT_IDLE_MS)).toBe(true);
  expect(withChatSession(messageCommand("Three", "en", "3"))).toMatchObject({
    session: "new",
  });
});

test("the model sees only the current session as short-term memory", async () => {
  const modelScope = scopeFor();
  const storage = new FixtureStorage(directory, modelScope.serverId);
  const histories: { role: string; text: string }[][] = [];
  const model = new ModelService(storage, {
    timeZone: "UTC",
    decide: async (input) => {
      histories.push(input.history);
      return {
        kind: "reply",
        reply: `TEST reply ${histories.length}`,
        title: null,
        contactId: null,
        localStart: null,
        durationMinutes: null,
      };
    },
  });
  const send = (command: Command) =>
    model.execute(modelScope, command, () => {}, new AbortController().signal);
  await send(messageCommand("TEST earlier question", "en", "m1"));
  await send(messageCommand("TEST follow-up", "en", "m2"));
  // Within a session, earlier turns are context.
  expect(histories[1]!.map((h) => h.text)).toContain("TEST earlier question");
  await send(newSession(messageCommand("TEST fresh start", "en", "m3")));
  expect(histories[2]).toEqual([]);
  expect(storage.sessions(modelScope)[0]!.messages).toHaveLength(4);
  storage.close();
});
