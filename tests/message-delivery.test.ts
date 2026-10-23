import { MessageSchema, type DomainEvent } from "../packages/protocol";
import {
  BASELINE_MESSAGE_RESULTS,
  MESSAGE_RESULTS,
  MESSAGE_TIME_PROFILE,
  eventsForMessageDelivery,
  messageDelivery,
  messageDeliveryPath,
  messageForClient,
  snapshotForMessageDelivery,
} from "../packages/protocol/message-delivery";

const scope = {
  connectionId: "connection-1",
  serverId: "server-1",
  userId: "user-1",
  workspaceId: "workspace-1",
};
const offer = MessageSchema.parse({
  id: "m-2",
  role: "assistant",
  text: "TEST there is a process for that.",
  createdAt: "2026-10-17T08:00:00.000Z",
  result: {
    type: "process.offer",
    version: 1,
    processId: "TEST-process",
    processVersion: 1,
    artifactDigest: "a".repeat(64),
    name: "TEST process",
    description: "",
    kind: "agent",
    reason: "",
    input: {},
  },
});
const contacts = MessageSchema.parse({
  id: "m-3",
  role: "assistant",
  text: "TEST no contacts.",
  result: {
    type: "crm.contacts",
    version: 1,
    source: "twenty",
    contacts: [],
    hasMore: false,
  },
});

test("clients name what they read: message times and result types", () => {
  const path = messageDeliveryPath("snapshot?chats=x", {
    times: true,
    results: ["process.offer/1", "skill.proposal/1"],
  });
  expect(path).toBe(
    `snapshot?chats=x&messages=${encodeURIComponent(MESSAGE_TIME_PROFILE)}&results=process.offer%2F1,skill.proposal%2F1`,
  );
  expect(messageDeliveryPath("events", {})).toBe("events");
  const delivery = messageDelivery(new URL(`https://x/${path}`).searchParams);
  expect(delivery.times).toBe(true);
  expect([...delivery.results]).toEqual([
    "process.offer/1",
    "skill.proposal/1",
  ]);
  // Anything malformed counts as not asked.
  const odd = messageDelivery(
    new URLSearchParams(
      "messages=agent-message-time/2&results=x,,process.offer&ui=agent-openui/2",
    ),
  );
  expect(odd).toEqual({ times: false, ui: false, results: new Set() });
  expect(MESSAGE_RESULTS).toEqual(
    expect.arrayContaining([...BASELINE_MESSAGE_RESULTS]),
  );
});

test("an old client gets the text in place of a newer result, and no times", () => {
  const old = messageDelivery(new URLSearchParams());
  expect(messageForClient(offer, old)).toEqual({
    id: "m-2",
    role: "assistant",
    text: "TEST there is a process for that.",
  });
  // Baseline results always arrive.
  expect(messageForClient(contacts, old)).toEqual(contacts);
  const current = messageDelivery(
    new URLSearchParams(
      `messages=${encodeURIComponent(MESSAGE_TIME_PROFILE)}&results=process.offer%2F1`,
    ),
  );
  expect(messageForClient(offer, current)).toBe(offer);
  const snapshot = snapshotForMessageDelivery(
    {
      profile: "agent-client/0.8-fixture",
      scope,
      cursor: 1,
      conversations: [{ id: "c-1", revision: 1, messages: [offer, contacts] }],
      workItems: [],
      inputRequests: [],
      actionProposals: [],
      operations: [],
    },
    old,
  );
  expect(snapshot.conversations[0]!.messages[0]).not.toHaveProperty("result");
  const events: DomainEvent[] = [
    {
      eventId: "e-1",
      sequence: 1,
      scope,
      type: "conversation.upserted",
      entity: { id: "c-1", revision: 1, messages: [offer] },
    },
  ];
  const [event] = eventsForMessageDelivery(events, old);
  expect(
    event!.type === "conversation.upserted" && event!.entity.messages[0],
  ).not.toHaveProperty("createdAt");
  // The stored message is untouched.
  expect(offer.result?.type).toBe("process.offer");
});
