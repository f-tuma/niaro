import type { DomainEvent, Snapshot, WorkItem } from "./index";

/** Clients that render a native question's options ask for them with this. */
export const QUESTION_OPTIONS_PROFILE = "agent-question-options/1" as const;

export function questionOptionsDeliveryPath(path: string) {
  return `${path}${path.includes("?") ? "&" : "?"}questions=${encodeURIComponent(QUESTION_OPTIONS_PROFILE)}`;
}

function workWithoutOptions(work: WorkItem): WorkItem {
  const question = work.native?.question;
  if (!question || (!question.options && !question.multiple)) return work;
  const { options: _options, multiple: _multiple, ...plain } = question;
  return { ...work, native: { ...work.native!, question: plain } };
}
/** Strict older clients receive the question text only; they answer by typing. */
export function snapshotWithoutQuestionOptions(snapshot: Snapshot): Snapshot {
  return { ...snapshot, workItems: snapshot.workItems.map(workWithoutOptions) };
}
export function eventsWithoutQuestionOptions(
  events: DomainEvent[],
): DomainEvent[] {
  return events.map((event) =>
    event.type === "work_item.upserted"
      ? { ...event, entity: workWithoutOptions(event.entity) }
      : event,
  );
}
