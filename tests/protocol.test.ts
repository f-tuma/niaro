import {
  CommandSchema,
  EventSchema,
  InputRequestSchema,
  SnapshotSchema,
  WorkItemSchema,
  MessageSchema,
  CrmContactResultSchema,
  PROFILE,
  PairingRequestSchema,
} from "../packages/protocol";
import {
  choosePeter,
  openSnapshot,
  scopeFor,
  crmContactResult,
} from "../packages/test-fixtures";
import {
  answerCommand,
  messageCommand,
  retryMessageCommand,
} from "../packages/client-core/commands";
import { ServerInfoSchema } from "../packages/protocol/server-info";
describe("runtime contract", () => {
  test("explicit chat retry gets a new attempt identity while retaining one logical message", () => {
    const original = messageCommand(
      "TEST retry this request",
      "en",
      "TEST-retry-original",
    );
    if (original.type !== "message.send") throw new Error("unreachable");
    const retry = retryMessageCommand(original, {
      commandId: "TEST-retry-attempt-2-public",
      idempotencyKey: "TEST-retry-attempt-2-key",
    });
    expect(retry).toMatchObject({
      commandId: "TEST-retry-attempt-2-public",
      idempotencyKey: "TEST-retry-attempt-2-key",
      logicalMessageId: "TEST-retry-original",
      retryOf: "TEST-retry-original",
      text: original.text,
      conversationId: original.conversationId,
    });
    expect(
      retryMessageCommand(retry, {
        commandId: "TEST-retry-attempt-3-public",
        idempotencyKey: "TEST-retry-attempt-3-key",
      }),
    ).toMatchObject({
      commandId: "TEST-retry-attempt-3-public",
      logicalMessageId: "TEST-retry-original",
      retryOf: "TEST-retry-attempt-2-public",
    });
    expect(
      CommandSchema.safeParse({
        ...retry,
        logicalMessageId: undefined,
      }).success,
    ).toBe(false);
    expect(
      CommandSchema.safeParse({
        ...original,
        logicalMessageId: "TEST-unlinked-message",
      }).success,
    ).toBe(false);
    expect(CommandSchema.safeParse({ ...retry, session: "new" }).success).toBe(
      false,
    );
  });
  test("0.6 requires the new workflow profile and service presentation capability", () => {
    expect(PROFILE).toBe("agent-client/0.8-fixture");
    expect(
      SnapshotSchema.safeParse({
        ...openSnapshot(),
        profile: "agent-client/0.5-fixture",
      }).success,
    ).toBe(false);
    expect(
      PairingRequestSchema.safeParse({
        authProfile: "agent-pairing/1",
        profile: "agent-client/0.5-fixture",
        code: "a".repeat(32),
      }).success,
    ).toBe(false);
    const catalog = {
      "workflow.progress": 1,
      "input.choice": 1,
      "action.approval": 1,
      "crm.contacts": 1,
      "service.action": 2,
    };
    expect(
      ServerInfoSchema.shape.componentCatalog.safeParse(catalog).success,
    ).toBe(true);
    expect(
      ServerInfoSchema.shape.componentCatalog.safeParse({
        ...catalog,
        "service.action": 1,
      }).success,
    ).toBe(false);
  });
  test("CRM result is bounded typed data, not model-defined UI or a user command", () => {
    const result = crmContactResult();
    const message = {
      id: "crm",
      role: "assistant",
      text: "One test contact",
      result,
    };
    expect(MessageSchema.safeParse(message).success).toBe(true);
    expect(MessageSchema.safeParse({ ...message, role: "user" }).success).toBe(
      false,
    );
    expect(
      MessageSchema.safeParse({ ...message, workItemId: "work-1" }).success,
    ).toBe(false);
    for (const invalid of [
      { ...result, version: 2 },
      { ...result, type: "remote.component" },
      { ...result, style: { color: "red" } },
      { ...result, contacts: [...result.contacts, ...result.contacts] },
      {
        ...result,
        contacts: Array.from({ length: 6 }, (_, i) => ({
          ...result.contacts[0],
          id: `id-${i}`,
        })),
      },
      {
        ...result,
        contacts: [{ ...result.contacts[0], email: "javascript:alert(1)" }],
      },
      {
        ...result,
        contacts: [{ ...result.contacts[0], phone: "https://example.test" }],
      },
      { ...result, contacts: [{ ...result.contacts[0], onPress: "delete" }] },
    ])
      expect(CrmContactResultSchema.safeParse(invalid).success).toBe(false);
  });
  test.each(["en", "cs"] as const)("%s fixture validates", (language) =>
    expect(SnapshotSchema.safeParse(openSnapshot(language)).success).toBe(true),
  );
  test("rejects server styling and unknown catalog variants", () => {
    const { work, input } = choosePeter();
    expect(
      WorkItemSchema.safeParse({ ...work, style: { color: "red" } }).success,
    ).toBe(false);
    expect(
      InputRequestSchema.safeParse({
        ...input,
        presentation: { ...input.presentation, variant: "remote-code" },
      }).success,
    ).toBe(false);
    expect(
      InputRequestSchema.safeParse({
        ...input,
        presentation: { ...input.presentation, version: 2 },
      }).success,
    ).toBe(false);
  });
  test("rejects unresolved resolution and broken references", () => {
    const fixture = openSnapshot();
    expect(
      InputRequestSchema.safeParse({
        ...fixture.inputRequests[0],
        status: "resolved",
      }).success,
    ).toBe(false);
    expect(
      SnapshotSchema.safeParse({ ...fixture, inputRequests: [] }).success,
    ).toBe(false);
    expect(
      SnapshotSchema.safeParse({
        ...fixture,
        workItems: [...fixture.workItems, ...fixture.workItems],
      }).success,
    ).toBe(false);
  });
  test("bounded text and strict command scope", () => {
    const command = answerCommand(choosePeter().input, "peter-novak", "cmd-1");
    expect(
      CommandSchema.safeParse({ ...command, scope: scopeFor("b") }).success,
    ).toBe(false);
    expect(
      CommandSchema.safeParse({ ...command, expectedInputRevision: 0 }).success,
    ).toBe(false);
    expect(
      InputRequestSchema.safeParse({
        ...choosePeter().input,
        question: "x".repeat(4001),
      }).success,
    ).toBe(false);
    expect(
      EventSchema.safeParse({ type: "run-code", payload: "danger" }).success,
    ).toBe(false);
  });
});
test("an open item rides only on a new message from the person", () => {
  const send = {
    ...messageCommand("TEST when can we meet?", "en", "TEST-task-send"),
    humanTask: { id: "meeting:TEST:0", title: "Arrange the next meeting" },
  };
  expect(CommandSchema.safeParse(send).success).toBe(true);
  expect(
    CommandSchema.safeParse({
      ...send,
      context: {
        workItemId: "TEST-work",
        inputRequestId: "TEST-input",
        expectedInputRevision: 1,
      },
    }).success,
  ).toBe(false);
  expect(
    CommandSchema.safeParse({
      ...send,
      humanTask: { id: "TEST invalid id", title: "Arrange" },
    }).success,
  ).toBe(false);
  expect(
    CommandSchema.safeParse({ ...send, humanTask: { id: "TEST", title: " " } })
      .success,
  ).toBe(false);
  const message = {
    id: "TEST-message",
    text: "TEST",
    humanTask: send.humanTask,
  };
  expect(MessageSchema.safeParse({ ...message, role: "user" }).success).toBe(
    true,
  );
  expect(
    MessageSchema.safeParse({ ...message, role: "assistant" }).success,
  ).toBe(false);
});
