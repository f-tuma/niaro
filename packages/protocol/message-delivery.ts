import type { Conversation, DomainEvent, Snapshot } from "./index";

type Message = Conversation["messages"][number];
type MessageResult = NonNullable<Message["result"]>;

/** Clients that show when a message was sent ask for `createdAt` with this. */
export const MESSAGE_TIME_PROFILE = "agent-message-time/1" as const;

/**
 * Result types every client of the 0.8 profile parses. Anything newer reaches
 * only clients that name it in `results=` (as `type/version`); the others
 * receive the message's text, which every result carries as its fallback.
 * `card.document` keeps its own `cards=agent-card/1` negotiation on top.
 */
export const BASELINE_MESSAGE_RESULTS = [
  "crm.contacts/1",
  "service.action/1",
  "service.connection/1",
  "card.document/1",
] as const;
/** Every result type this protocol package defines, as `type/version`. */
export const MESSAGE_RESULTS = [
  ...BASELINE_MESSAGE_RESULTS,
  "process.offer/1",
  "skill.proposal/1",
  "process.proposal/1",
] as const satisfies readonly `${MessageResult["type"]}/${MessageResult["version"]}`[];
export type MessageResultToken = (typeof MESSAGE_RESULTS)[number];

const TOKEN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+\/[1-9][0-9]{0,3}$/;
const resultToken = (result: MessageResult) =>
  `${result.type}/${result.version}`;

/** What a client asked for on a snapshot, events, commands or history read. */
export type MessageDelivery = {
  times: boolean;
  /** Declared result tokens besides the baseline; unknown ones are ignored. */
  results: ReadonlySet<string>;
};
/** Reads `messages=` and `results=`; anything malformed means "not asked". */
export function messageDelivery(params: URLSearchParams): MessageDelivery {
  const declared = (params.get("results") ?? "")
    .split(",")
    .slice(0, 32)
    .filter((token) => TOKEN.test(token));
  return {
    times: params.get("messages") === MESSAGE_TIME_PROFILE,
    results: new Set(declared),
  };
}
/** Adds this client's declarations to a delivery path. */
export function messageDeliveryPath(
  path: string,
  support: { times?: boolean; results?: readonly string[] },
) {
  const params = [
    ...(support.times
      ? [`messages=${encodeURIComponent(MESSAGE_TIME_PROFILE)}`]
      : []),
    ...(support.results?.length
      ? [
          `results=${support.results.map((token) => encodeURIComponent(token)).join(",")}`,
        ]
      : []),
  ];
  return params.length
    ? `${path}${path.includes("?") ? "&" : "?"}${params.join("&")}`
    : path;
}

const baseline = new Set<string>(BASELINE_MESSAGE_RESULTS);
/** One message as this client can parse it. */
export function messageForClient<T extends Message>(
  message: T,
  delivery: MessageDelivery,
): T {
  let value = message;
  if (!delivery.times && value.createdAt !== undefined) {
    const { createdAt: _createdAt, ...plain } = value;
    value = plain as T;
  }
  if (value.result) {
    const token = resultToken(value.result);
    if (!baseline.has(token) && !delivery.results.has(token)) {
      // The text is the result's own fallback; old parsers never see the type.
      const { result: _result, ...plain } = value;
      value = plain as T;
    }
  }
  return value;
}
function conversationForClient(
  conversation: Conversation,
  delivery: MessageDelivery,
): Conversation {
  return {
    ...conversation,
    messages: conversation.messages.map((message) =>
      messageForClient(message, delivery),
    ),
  };
}
export function snapshotForMessageDelivery(
  snapshot: Snapshot,
  delivery: MessageDelivery,
): Snapshot {
  return {
    ...snapshot,
    conversations: snapshot.conversations.map((conversation) =>
      conversationForClient(conversation, delivery),
    ),
  };
}
export function eventsForMessageDelivery(
  events: DomainEvent[],
  delivery: MessageDelivery,
): DomainEvent[] {
  return events.map((event) =>
    event.type === "conversation.upserted"
      ? { ...event, entity: conversationForClient(event.entity, delivery) }
      : event,
  );
}
