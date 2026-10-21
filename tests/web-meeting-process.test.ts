import { ProcessLauncher } from "../apps/server-admin/web/app/process-launch";
import { meetingRecordFixture } from "../packages/test-fixtures/meeting";
import { processLaunchFixture } from "./helpers/process-launch-client";

const flush = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
};
const ids = () => {
  let id = 0;
  return () => `TEST-web-meeting-${++id}`;
};
const task = { id: meetingRecordFixture.humanTaskIds[0]!, revision: 3 };

test("a process continued from a meeting is bound to its record and task, prefilled from the chosen parts", async () => {
  const h = processLaunchFixture(),
    session = h.open();
  await session.start(false);
  const launcher = new ProcessLauncher(
    session,
    "en",
    "conversation-1",
    null,
    ids(),
  );
  await launcher.load();
  await flush();
  const entry = launcher.getSnapshot().inventory!.processes[0]!;
  await launcher.open(entry, false, {
    record: meetingRecordFixture,
    selectedTask: task,
    sourceBindings: { name: "summary" },
  });
  await flush();
  expect(h.inputRequests).toHaveLength(1);
  expect(h.inputRequests[0]!.origin).toEqual({
    type: "meeting",
    conversationId: "conversation-1",
    requestId: "TEST-web-meeting-1",
    meetingId: meetingRecordFixture.meeting.id,
    recordDigest: meetingRecordFixture.recordDigest,
    selectedTask: task,
    sourceBindings: { name: "summary" },
  });
  const model = launcher.getSnapshot();
  expect(model.phase).toBe("editing");
  expect(model.reviewedInput).toEqual({
    name: meetingRecordFixture.analysis!.summary,
  });
  launcher.review({ name: "TEST reviewed" });
  await launcher.start();
  await flush();
  expect(h.commands).toHaveLength(1);
  expect(launcher.getSnapshot().phase).toBe("accepted");
});

test("a meeting whose record is not ready can't start a process", async () => {
  const h = processLaunchFixture(),
    session = h.open();
  await session.start(false);
  const launcher = new ProcessLauncher(session, "en", "conversation-1", null);
  await launcher.load();
  await flush();
  const entry = launcher.getSnapshot().inventory!.processes[0]!;
  await launcher.open(entry, false, {
    record: { ...meetingRecordFixture, recordDigest: null },
    selectedTask: task,
    sourceBindings: {},
  });
  expect(h.inputRequests).toHaveLength(0);
  expect(launcher.getSnapshot().error).toBe("meeting_process_record_changed");
});
