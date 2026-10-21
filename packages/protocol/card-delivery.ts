import type { Conversation, DomainEvent, Snapshot, WorkItem } from "./index";
import { CARD_PROFILE } from "./card-document";

export function cardDeliveryPath(path: string) {
  return `${path}${path.includes("?") ? "&" : "?"}cards=${encodeURIComponent(CARD_PROFILE)}`;
}
function conversationForClient(value: Conversation): Conversation {
  return {
    ...value,
    messages: value.messages.map((message) => {
      if (message.result?.type === "card.document") {
        const { result: _result, ...plain } = message;
        return plain;
      }
      if (message.result?.type === "service.action") {
        const { card: _card, ...result } = message.result;
        return { ...message, result };
      }
      return message;
    }),
  };
}
function workForClient(value: WorkItem): WorkItem {
  const { card: _card, ...work } = value;
  if (!work.native?.action) return work;
  const { card: _actionCard, ...action } = work.native.action;
  return { ...work, native: { ...work.native, action } };
}
/** Strict older clients receive the existing textual result and workflow entities. */
export function snapshotWithoutCards(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    conversations: snapshot.conversations.map(conversationForClient),
    workItems: snapshot.workItems.map(workForClient),
  };
}
export function eventsWithoutCards(events: DomainEvent[]): DomainEvent[] {
  return events.map((event) =>
    event.type === "conversation.upserted"
      ? { ...event, entity: conversationForClient(event.entity) }
      : event.type === "work_item.upserted"
        ? { ...event, entity: workForClient(event.entity) }
        : event,
  );
}
