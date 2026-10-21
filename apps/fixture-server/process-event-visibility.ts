import { isDeepStrictEqual } from "node:util";
import type { DomainEvent, WorkItem } from "../../packages/protocol";

/** Stored event bodies are history, not current authorization to disclose data. */
export function processEventsForCurrentWindow(
  events: DomainEvent[],
  currentItems: WorkItem[],
): DomainEvent[] {
  const current = new Map(currentItems.map((work) => [work.id, work]));
  return events.map((event) => {
    if (event.type !== "work_item.upserted" || !event.entity.native?.process)
      return event;
    const work = event.entity;
    // Only the exact freshly projected body can retain private details. An old
    // generation (including cards saved before redaction) is never its proof.
    if (isDeepStrictEqual(work, current.get(work.id))) return event;
    const { card: _card, result: _result, ...plain } = work;
    const native = work.native!;
    const {
      output: _output,
      outputSummary: _summary,
      approval: _approval,
      question: _question,
      answerHistory: _answers,
      ...process
    } = native.process!;
    return {
      ...event,
      entity: {
        ...plain,
        // No saved language proof is available for this historical body. Use a
        // neutral placeholder; the client localizes outputUnavailable=context.
        context: "…",
        native: {
          ...native,
          process: {
            ...process,
            detailsAvailable: false,
            outputUnavailable: "context",
            ...(process.approvalUnavailable
              ? { approvalUnavailable: "context" }
              : {}),
            receipts: process.receipts.map((receipt) => ({
              ...receipt,
              title: "…",
              service: "…",
              summary: "",
            })),
          },
        },
      },
    };
  });
}
