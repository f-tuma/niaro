import { sameScope, type Scope } from "../../packages/protocol";
import type { MeetingRecord } from "../../packages/protocol/meeting-record";
import type { HumanTask } from "../../packages/protocol/human-tasks";
import {
  type MeetingProcessSource,
  type ProcessStartOrigin,
} from "../../packages/protocol/process-start";
import { meetingProcessValueFitsInput } from "../../packages/protocol/meeting-process-input";
import type { ProcessData } from "../../packages/protocol/service-processes";
import { IdentityError } from "./error";

type MeetingOrigin = Extract<ProcessStartOrigin, { type: "meeting" }>;
type MeetingRecordReader = (scope: Scope, meetingId: string) => MeetingRecord;
type HumanTaskReader = (scope: Scope, taskId: string) => HumanTask;

function sourceValue(
  record: MeetingRecord,
  source: MeetingProcessSource,
): unknown {
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
    case "selectedTask":
      return undefined;
    case "transcript":
      return record.transcriptComplete ? record.transcript : undefined;
  }
}
/** Re-read the owner-scoped immutable meeting artifact at form preparation and admission. */
export function assertMeetingProcessOrigin(
  readRecord: MeetingRecordReader,
  scope: Scope,
  origin: MeetingOrigin,
  inputSchema?: ProcessData,
  readTask?: HumanTaskReader,
) {
  let record: MeetingRecord;
  try {
    record = readRecord(scope, origin.meetingId);
  } catch (error) {
    if (error instanceof IdentityError && error.code === "meeting_not_found")
      throw new IdentityError(409, "process_origin_changed");
    throw error;
  }
  if (
    !sameScope(record.scope, scope) ||
    record.meeting.id !== origin.meetingId ||
    record.meeting.status !== "ready" ||
    !record.transcriptComplete ||
    !record.analysis ||
    !record.recordDigest ||
    record.recordDigest !== origin.recordDigest
  )
    throw new IdentityError(409, "process_origin_changed");

  const selectedTaskId = origin.selectedTask?.id;
  const selectedTaskIndex = selectedTaskId
    ? record.humanTaskIds.indexOf(selectedTaskId)
    : -1;
  const selectedAnalysisTask =
    selectedTaskIndex >= 0
      ? record.analysis?.tasks[selectedTaskIndex]
      : undefined;
  const selectedTaskSourceBound =
    !!origin.sourceBindings &&
    Object.values(origin.sourceBindings).includes("selectedTask");
  if (selectedTaskSourceBound && !origin.selectedTask)
    throw new IdentityError(409, "process_origin_changed");
  if (origin.selectedTask) {
    if (!selectedAnalysisTask || !readTask)
      throw new IdentityError(409, "process_origin_changed");
    let task: HumanTask;
    try {
      task = readTask(scope, origin.selectedTask.id);
    } catch (error) {
      if (
        error instanceof IdentityError &&
        error.code === "human_task_not_found"
      )
        throw new IdentityError(409, "process_origin_changed");
      throw error;
    }
    if (
      !sameScope(task.scope, scope) ||
      task.status !== "open" ||
      task.revision !== origin.selectedTask.revision ||
      task.origin.kind !== "meeting" ||
      task.origin.meetingId !== origin.meetingId ||
      task.origin.recordDigest !== origin.recordDigest ||
      JSON.stringify(task.origin.sources) !==
        JSON.stringify(selectedAnalysisTask.sources)
    )
      throw new IdentityError(409, "process_origin_changed");
  }
  if (!inputSchema) return record;
  if (inputSchema.type !== "object")
    throw new IdentityError(400, "process_input_invalid");
  for (const [field, source] of Object.entries(origin.sourceBindings)) {
    const definition = inputSchema.properties[field];
    const value =
      source === "selectedTask" && selectedAnalysisTask
        ? {
            text: selectedAnalysisTask.text,
            assignee: selectedAnalysisTask.assignee,
            due: selectedAnalysisTask.due,
            sources: selectedAnalysisTask.sources,
          }
        : sourceValue(record, source);
    if (!definition || !meetingProcessValueFitsInput(field, value, inputSchema))
      throw new IdentityError(400, "process_input_invalid");
  }
  return record;
}
