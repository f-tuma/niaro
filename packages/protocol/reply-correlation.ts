import type { Conversation, DomainEvent, Snapshot } from "./index";

export const REPLY_CORRELATION_PROFILE = "agent-reply-correlation/1" as const;
export function replyCorrelationPath(path: string) {
  return `${path}${path.includes("?") ? "&" : "?"}replies=${encodeURIComponent(REPLY_CORRELATION_PROFILE)}`;
}
/** Older 0.6 clients have strict message schemas; correlation is opt-in on the wire. */
function conversationForClient(value: Conversation): Conversation {
  return {
    ...value,
    messages: value.messages.map(
      ({ replyToCommandId: _command, ...message }) => message,
    ),
  };
}
export function snapshotForClient(
  snapshot: Snapshot,
  correlated: boolean,
): Snapshot {
  return correlated
    ? snapshot
    : {
        ...snapshot,
        conversations: snapshot.conversations.map(conversationForClient),
      };
}
export function eventsForClient(
  events: DomainEvent[],
  correlated: boolean,
): DomainEvent[] {
  return correlated
    ? events
    : events.map((event) =>
        event.type === "conversation.upserted"
          ? { ...event, entity: conversationForClient(event.entity) }
          : event,
      );
}
