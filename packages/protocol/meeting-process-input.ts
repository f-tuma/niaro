import type { MeetingRecord } from "./meeting-record";
import {
  ProcessStartInputSchema,
  type MeetingProcessSource,
  type ProcessInputValue,
  type ProcessStartOrigin,
} from "./process-start";
import { processValueSchema, type ProcessData } from "./service-processes";

function meetingSourceValue(
  record: MeetingRecord,
  source: MeetingProcessSource,
  selectedTaskId?: string,
): ProcessInputValue | undefined {
  switch (source) {
    case "summary":
      return record.analysis?.summary;
    case "points":
      return record.analysis?.points.map((point) => point.text);
    case "tasks":
      return record.analysis?.tasks.map((task) => ({
        text: task.text,
        assignee: task.assignee,
        due: task.due,
      }));
    case "selectedTask": {
      const index = selectedTaskId
        ? record.humanTaskIds.indexOf(selectedTaskId)
        : -1;
      const task = index >= 0 ? record.analysis?.tasks[index] : undefined;
      return task
        ? {
            text: task.text,
            assignee: task.assignee,
            due: task.due,
            sources: task.sources.map((source) => ({
              segment: source.segment,
              quote: source.quote,
            })),
          }
        : undefined;
    }
    case "transcript":
      return record.transcriptComplete ? record.transcript : undefined;
  }
}
const useful = (value: unknown) =>
  value !== undefined &&
  !(typeof value === "string" && !value.trim()) &&
  !(Array.isArray(value) && value.length === 0);

export function meetingProcessValueFitsInput(
  field: string,
  value: unknown,
  schema: ProcessData,
): value is ProcessInputValue {
  return (
    useful(value) &&
    schema.type === "object" &&
    // Field names can come from a model: only the schema's own fields count,
    // never inherited names such as "__proto__" or "constructor".
    Object.hasOwn(schema.properties, field) &&
    !!schema.properties[field] &&
    processValueSchema(schema.properties[field]!).safeParse(value).success &&
    ProcessStartInputSchema.safeParse({ [field]: value }).success
  );
}

/** Only schema-compatible, source-backed values can prefill a process field. */
export function meetingProcessSourceOptions(
  record: MeetingRecord,
  schema: ProcessData,
  selectedTaskId?: string,
): Partial<Record<string, MeetingProcessSource[]>> {
  if (schema.type !== "object" || !record.analysis || !record.recordDigest)
    return {};
  const choices: MeetingProcessSource[] = [
    "summary",
    "points",
    "tasks",
    "transcript",
    ...(selectedTaskId ? (["selectedTask"] as const) : []),
  ];
  const result: Partial<Record<string, MeetingProcessSource[]>> = {};
  for (const field of Object.keys(schema.properties)) {
    const compatible = choices.filter((source) => {
      const value = meetingSourceValue(record, source, selectedTaskId);
      return meetingProcessValueFitsInput(field, value, schema);
    });
    if (compatible.length) result[field] = compatible;
  }
  return result;
}

export function meetingProcessInitialInput(
  record: MeetingRecord,
  schema: ProcessData,
  bindings: Partial<Record<string, MeetingProcessSource>>,
  origin?: Extract<ProcessStartOrigin, { type: "meeting" }>,
): Record<string, ProcessInputValue> {
  if (schema.type !== "object") return {};
  const values: Record<string, ProcessInputValue> = {};
  for (const field of Object.keys(bindings)) {
    const source = bindings[field];
    if (!source) continue;
    const value = meetingSourceValue(record, source, origin?.selectedTask?.id);
    if (meetingProcessValueFitsInput(field, value, schema))
      Object.defineProperty(values, field, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
  }
  return values;
}
