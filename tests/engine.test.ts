import { FixtureEngine } from "../apps/fixture-server/engine";
import { CommandSchema, type Command } from "../packages/protocol";
import {
  answerCommand,
  messageCommand,
  retryMessageCommand,
} from "../packages/client-core/commands";
import {
  applyEvent,
  fromSnapshot,
  selectConversationWork,
  selectTasks,
} from "../packages/client-core/store";
const start = (e: FixtureEngine) =>
  e.execute(messageCommand("Choose Peter", "en", "start-1"));
describe("server-owned work", () => {
  test.each(["card", "chat"])(
    "%s answers the same input, continues to a proposal before any operation",
    (source) => {
      let clock = 1000;
      const e = new FixtureEngine("a", undefined, undefined, () => clock);
      const first = start(e);
      const input = first.snapshot.inputRequests[0]!;
      const command =
        source === "card"
          ? answerCommand(input, "peter-novak", "answer-1")
          : messageCommand("Choose Peter Novák", "en", "answer-1", input);
      const result = e.execute(command);
      expect(result.status).toBe("accepted");
      expect(result.snapshot.inputRequests[0]).toMatchObject({
        id: input.id,
        status: "resolved",
        resolution: { source },
      });
      expect(result.snapshot.workItems[0]?.status).toBe("running");
      clock += 3999;
      e.tick();
      expect(e.snapshot().workItems[0]?.status).toBe("running");
      clock++;
      e.tick();
      expect(e.snapshot().workItems[0]).toMatchObject({
        status: "waiting_approval",
        demo: true,
      });
      const store = fromSnapshot(
        "endpoint-a",
        result.snapshot.scope,
        result.snapshot,
      );
      expect(selectTasks(store, "needsInput")).toHaveLength(0);
      expect(selectConversationWork(store, "conversation-1")[0]).toBe(
        selectTasks(store, "upcoming")[0],
      );
    },
  );
  test("duplicate IDs are idempotent, changed payloads cannot reuse them", () => {
    const e = new FixtureEngine();
    const first = start(e);
    const cursor = first.snapshot.cursor;
    expect(start(e).snapshot.cursor).toBe(cursor);
    expect(e.snapshot().workItems).toHaveLength(1);
    const input = first.snapshot.inputRequests[0]!;
    const cmd = answerCommand(input, "peter-novak", "answer-1");
    e.execute(cmd);
    const after = e.snapshot().cursor;
    expect(e.execute(cmd).status).toBe("accepted");
    expect(e.snapshot().cursor).toBe(after);
    expect(
      e.execute(answerCommand(input, "peter-svoboda", "answer-1")).code,
    ).toBe("idempotency_conflict");
  });
  test("an explicit retry adds its reply without duplicating the logical user message", () => {
    const e = new FixtureEngine();
    const original = messageCommand(
      "TEST status update",
      "en",
      "TEST-original",
    );
    const interpretation = (reply: string) => ({
      decision: {
        kind: "new_topic" as const,
        contactId: null,
        title: null,
        localStart: null,
        durationMinutes: null,
        reply,
        patch: null,
      },
      expectedCursor: e.snapshot().cursor,
      timeZone: "UTC",
    });
    e.execute(original, interpretation("First response."));
    const retried = retryMessageCommand(original, "TEST-attempt-2");
    const result = e.execute(retried, interpretation("Retried response."));
    expect(e.execute(retried).snapshot.cursor).toBe(result.snapshot.cursor);
    expect(
      e.execute({ ...retried, text: "TEST changed retry payload" }).code,
    ).toBe("idempotency_conflict");
    const messages = result.snapshot.conversations[0]!.messages;
    expect(messages.filter((message) => message.role === "user")).toHaveLength(
      1,
    );
    expect(
      messages.filter((message) => message.role === "assistant"),
    ).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      text: "TEST status update",
      logicalMessageId: "TEST-original",
    });
    expect(messages.at(-1)).toMatchObject({
      text: "Retried response.",
      replyToCommandId: "TEST-attempt-2",
    });
  });
  test("an explicit retry cannot hide a changed request under another message's identity", () => {
    const e = new FixtureEngine();
    const original = messageCommand(
      "TEST original intent",
      "en",
      "TEST-parent",
    );
    const first = e.execute(original, {
      decision: {
        kind: "new_topic",
        contactId: null,
        title: null,
        localStart: null,
        durationMinutes: null,
        reply: "Original response.",
        patch: null,
      },
      expectedCursor: e.snapshot().cursor,
      timeZone: "UTC",
    });
    expect(first.status).toBe("accepted");
    const retry = retryMessageCommand(original, "TEST-forged-child");
    const rejected = e.execute({ ...retry, text: "TEST different intent" });
    expect(rejected).toMatchObject({
      status: "conflict",
      code: "idempotency_conflict",
    });
    expect(
      rejected.snapshot.conversations[0]!.messages.filter(
        (message) => message.role === "user",
      ),
    ).toHaveLength(1);
  });
  test("stale concurrent answer returns conflict with current context", () => {
    const e = new FixtureEngine();
    const input = start(e).snapshot.inputRequests[0]!;
    e.execute(answerCommand(input, "peter-novak", "first"));
    const conflict = e.execute(answerCommand(input, "peter-svoboda", "second"));
    expect(conflict.status).toBe("conflict");
    expect(conflict.snapshot.inputRequests[0]?.revision).toBe(2);
  });
  test("unknown contact, ambiguous text and wrong work do not resolve", () => {
    const e = new FixtureEngine();
    const input = start(e).snapshot.inputRequests[0]!;
    expect(e.execute(answerCommand(input, "unknown", "bad")).code).toBe(
      "invalid_answer",
    );
    expect(
      e.execute(messageCommand("Peter", "en", "ambiguous", input)).status,
    ).toBe("rejected");
    expect(
      e.execute(
        answerCommand(
          { ...input, workItemId: "another-work" },
          "peter-novak",
          "wrong",
        ),
      ).status,
    ).toBe("rejected");
    expect(e.snapshot().inputRequests[0]?.status).toBe("open");
  });
  test("persisted work and receipt survive restart and replay triggers nothing", () => {
    let saved: unknown;
    const e = new FixtureEngine(
      "a",
      undefined,
      (data) => {
        saved = structuredClone(data);
      },
      () => 0,
    );
    const initial = start(e).snapshot;
    const cmd = answerCommand(
      initial.inputRequests[0]!,
      "peter-novak",
      "answer",
    );
    e.execute(cmd);
    const restored = new FixtureEngine("a", saved, undefined, () => 5000);
    expect(restored.execute(cmd).status).toBe("accepted");
    restored.tick();
    expect(restored.snapshot().workItems[0]?.status).toBe("waiting_approval");
    expect(restored.snapshot().operations).toHaveLength(0);
    let store = fromSnapshot("a", initial.scope, initial);
    const cursor = restored.snapshot().cursor;
    for (const event of restored.events(initial.cursor)!.events)
      store = applyEvent(store, "a", event);
    expect(store.workItems["work-1"]?.status).toBe("waiting_approval");
    expect(restored.snapshot().cursor).toBe(cursor);
  });
  test("failed persistence rolls back the transaction", () => {
    const e = new FixtureEngine("a", undefined, () => {
      throw new Error("disk full");
    });
    expect(() => start(e)).toThrow("disk full");
    expect(e.snapshot().cursor).toBe(0);
    expect(e.data.receipts).toHaveLength(0);
  });
  test("B has no access to A entities", () => {
    const a = new FixtureEngine("a"),
      b = new FixtureEngine("b");
    const input = start(a).snapshot.inputRequests[0]!;
    expect(
      b.execute(answerCommand(input, "peter-novak", "cross-scope")).status,
    ).toBe("rejected");
    expect(a.snapshot().inputRequests[0]?.status).toBe("open");
  });
});

test("native conversation guard still rejects a changed conversation", () => {
  const engine = new FixtureEngine();
  const before = engine.snapshot();
  const interpretation = {
    decision: {
      kind: "reply" as const,
      contactId: null,
      title: null,
      localStart: null,
      durationMinutes: null,
      reply: "TEST task failed: step limit reached.",
    },
    expectedCursor: before.cursor,
    expectedConversationRevision: before.conversations[0]!.revision,
    timeZone: "UTC",
  };
  // A real conversation change is still stale even with the native guard.
  start(engine);
  const conflict = engine.execute(
    messageCommand("TEST request", "en", "native-stale"),
    interpretation,
  );
  expect(conflict.code).toBe("revision_conflict");
  expect(
    conflict.snapshot.conversations[0]!.messages.some(
      (message) => message.replyToCommandId === "native-stale",
    ),
  ).toBe(false);
});

test("a native final answer preserves its bounded explanation beyond the model decision limit", () => {
  const engine = new FixtureEngine();
  const full = "TEST confirmed action; ".repeat(65);
  const command = messageCommand("TEST complex task", "en", "TEST-full-native");
  const result = engine.execute(command, {
    decision: {
      kind: "reply",
      contactId: null,
      title: null,
      localStart: null,
      durationMinutes: null,
      reply: full.slice(0, 800),
    },
    nativeReply: full,
    expectedCursor: engine.snapshot().cursor,
    expectedConversationRevision: engine.snapshot().conversations[0]!.revision,
    timeZone: "UTC",
  });
  expect(result.snapshot.conversations[0]!.messages.at(-1)!.text).toBe(full);
  expect(engine.execute(command).snapshot.conversations).toEqual(
    result.snapshot.conversations,
  );
  expect(() =>
    engine.execute(messageCommand("TEST oversized", "en", "TEST-over"), {
      decision: {
        kind: "reply",
        contactId: null,
        title: null,
        localStart: null,
        durationMinutes: null,
        reply: "TEST short",
      },
      nativeReply: "x".repeat(2001),
      expectedCursor: engine.snapshot().cursor,
      timeZone: "UTC",
    }),
  ).toThrow();
});

test("a definitive rejection keeps the submitted text and correlated explanation on replay", () => {
  const engine = new FixtureEngine();
  const command = messageCommand(
    "TEST request without permission",
    "en",
    "denied",
  );
  const result = engine.execute(command, {
    decision: {
      kind: "reply",
      contactId: null,
      title: null,
      localStart: null,
      durationMinutes: null,
      reply: null,
    },
    expectedCursor: engine.snapshot().cursor,
    timeZone: "UTC",
    terminal: {
      status: "rejected",
      code: "integration_unavailable",
      reply: "TEST This action is unavailable to your account.",
    },
  });
  expect(result.status).toBe("rejected");
  expect(result.snapshot.conversations[0]!.messages).toMatchObject([
    { role: "user", text: "TEST request without permission" },
    {
      role: "assistant",
      replyToCommandId: command.commandId,
      text: "TEST This action is unavailable to your account.",
    },
  ]);
  expect(engine.execute(command).snapshot.conversations).toEqual(
    result.snapshot.conversations,
  );
});

test.each(["task.open", "service.resolve"] as const)(
  "a %s rejection stores its explanation in chat without inventing user text",
  (type) => {
    const engine = new FixtureEngine();
    const command: Command = CommandSchema.parse({
      type,
      commandId: "TEST-rejected-action",
      idempotencyKey: "TEST-rejected-action",
      conversationId: "conversation-1",
      language: "en",
      ...(type === "task.open"
        ? { workItemId: "TEST-work", expectedWorkRevision: 1 }
        : { operationId: "TEST-operation", approved: true }),
    });
    const result = engine.execute(command, {
      decision: {
        kind: "reply",
        contactId: null,
        title: null,
        localStart: null,
        durationMinutes: null,
        reply: null,
      },
      expectedCursor: engine.snapshot().cursor,
      timeZone: "UTC",
      terminal: {
        status: "rejected",
        code: "integration_unavailable",
        reply: "TEST The service is currently unavailable.",
      },
    });
    expect(result.status).toBe("rejected");
    expect(result.snapshot.conversations[0]!.messages).toMatchObject([
      {
        role: "assistant",
        replyToCommandId: command.commandId,
        text: "TEST The service is currently unavailable.",
      },
    ]);
    expect(engine.execute(command).snapshot.conversations).toEqual(
      result.snapshot.conversations,
    );
  },
);

test("an open item brought to a message stays on that person's message only", () => {
  const e = new FixtureEngine();
  const humanTask = { id: "meeting:TEST:0", title: "Arrange the next meeting" };
  e.execute({
    ...messageCommand("Choose Peter", "en", "TEST-task-1"),
    humanTask,
  });
  e.execute(messageCommand("Choose Peter", "en", "TEST-task-2"));
  const messages = e
    .snapshot()
    .conversations.find((c) => c.id === "conversation-1")!.messages;
  const marked = messages.filter((m) => m.humanTask);
  expect(marked).toHaveLength(1);
  expect(marked[0]).toMatchObject({
    id: expect.stringMatching(/^message-TEST-task-1-/),
    role: "user",
    humanTask,
  });
});
