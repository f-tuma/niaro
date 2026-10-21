import React from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { MeetingLibrary } from "../apps/mobile/MeetingLibrary";
import type { ClientSession } from "../packages/client-core/session";
import { meetingRecordFixture } from "../packages/test-fixtures/meeting";
import { en } from "../packages/i18n";
import { Text } from "react-native";
jest.mock("../apps/mobile/ProcessLaunch", () => {
  const ReactModule = jest.requireActual<typeof import("react")>("react");
  const Native =
    jest.requireActual<typeof import("react-native")>("react-native");
  return {
    ProcessLaunch: ({
      selectedTask,
    }: {
      selectedTask?: { id: string; revision: number };
    }) =>
      ReactModule.createElement(
        Native.Text,
        { testID: "selected-process-task" },
        selectedTask ? `${selectedTask.id}:${selectedTask.revision}` : "none",
      ),
  };
});
jest.mock("../apps/mobile/meeting-device", () => ({
  useMeetingDevice: () => ({ capture: null, durationMillis: 0 }),
}));
const fixture = () => {
  let exists = true;
  const session = {
    identityKey: "TEST-meeting-library",
    readMeetings: jest.fn(async () => ({
      meetings: exists ? [meetingRecordFixture.meeting] : [],
    })),
    readMeetingRecord: jest.fn(async () => meetingRecordFixture),
    readMeeting: jest.fn(async () => ({
      segments: [{ index: 0, startSeconds: 0, text: "TEST private source" }],
    })),
    readHumanTask: jest.fn(async (id: string) => ({
      ...{
        id,
        scope: meetingRecordFixture.scope,
        title: "Prepare the prototype",
        detail: "",
        assignee: "Anna",
        due: "Friday",
        revision: 7,
        status: "open" as const,
        resolution: null,
        createdAt: "2026-10-08T10:00:00.000Z",
        updatedAt: "2026-10-08T10:00:00.000Z",
        origin: {
          kind: "meeting" as const,
          meetingId: meetingRecordFixture.meeting.id,
          meetingTitle: meetingRecordFixture.meeting.title,
          recordDigest: meetingRecordFixture.recordDigest!,
          sources: meetingRecordFixture.analysis!.tasks[0]!.sources,
        },
      },
    })),
    processMeeting: jest.fn(async () => {}),
  } as unknown as ClientSession;
  return {
    session,
    remove() {
      exists = false;
    },
  };
};
const row = `meeting-${meetingRecordFixture.meeting.id}`;
test("detail shows one full record without transcript pagination; explicit sources disappear after another device deletes the meeting", async () => {
  const f = fixture();
  const view = render(
    <MeetingLibrary session={f.session} language="en" visible />,
  );
  await waitFor(() => expect(view.getByTestId(row)).toBeTruthy());
  fireEvent.press(view.getByTestId(row));
  await waitFor(() =>
    expect(view.getByText(meetingRecordFixture.transcript)).toBeTruthy(),
  );
  expect(view.queryByText(en.meetingNext)).toBeNull();
  expect(view.queryByText(en.meetingPrevious)).toBeNull();
  fireEvent.press(
    view.getByRole("button", { name: en.meetingSource + " 0:00" }),
  );
  await waitFor(() =>
    expect(view.getByText("TEST private source")).toBeTruthy(),
  );
  f.remove();
  view.rerender(
    <MeetingLibrary
      session={f.session}
      language="en"
      visible
      refreshVersion={1}
    />,
  );
  // The refresh is scheduled, not synchronous; allow the sheet's frames to run.
  await waitFor(
    () => expect(view.queryByText(meetingRecordFixture.transcript)).toBeNull(),
    { timeout: 4000 },
  );
  expect(view.queryByText("TEST private source")).toBeNull();
  expect(view.queryByTestId(row)).toBeNull();
});
test("the full transcript opens in its own reader and closes back to the record", async () => {
  const f = fixture();
  const view = render(
    <MeetingLibrary session={f.session} language="en" visible />,
  );
  await waitFor(() => expect(view.getByTestId(row)).toBeTruthy());
  fireEvent.press(view.getByTestId(row));
  await waitFor(() =>
    expect(
      view.getByRole("button", { name: en.meetingReadTranscript }),
    ).toBeTruthy(),
  );
  expect(view.queryByTestId("meeting-transcript-reader")).toBeNull();
  fireEvent.press(view.getByRole("button", { name: en.meetingReadTranscript }));
  expect(view.getByTestId("meeting-transcript-reader")).toBeTruthy();
  fireEvent.press(view.getByRole("button", { name: en.close }));
  expect(view.queryByTestId("meeting-transcript-reader")).toBeNull();
});
test("a meeting process uses the latest open task revision", async () => {
  const f = fixture();
  const view = render(
    <MeetingLibrary
      session={f.session}
      language="en"
      visible
      conversationId="TEST-chat"
    />,
  );
  await waitFor(() => expect(view.getByTestId(row)).toBeTruthy());
  fireEvent.press(view.getByTestId(row));
  await waitFor(() =>
    expect(
      view.getByRole("button", { name: en.meetingProcessSelectTask }),
    ).toBeTruthy(),
  );
  fireEvent.press(
    view.getByRole("button", { name: en.meetingProcessSelectTask }),
  );
  await waitFor(() =>
    expect(view.getByTestId("selected-process-task").props.children).toBe(
      `${meetingRecordFixture.humanTaskIds[0]}:7`,
    ),
  );
  expect(f.session.readHumanTask).toHaveBeenCalledWith(
    meetingRecordFixture.humanTaskIds[0],
  );
});
test("a closed meeting task cannot be selected; reopening it refreshes its revision", async () => {
  const f = fixture();
  const reader = f.session.readHumanTask as jest.Mock;
  reader.mockResolvedValueOnce({
    id: meetingRecordFixture.humanTaskIds[0],
    scope: meetingRecordFixture.scope,
    title: "Prepare the prototype",
    detail: "",
    assignee: "Anna",
    due: "Friday",
    revision: 2,
    status: "done",
    resolution: {
      by: "user",
      reason: "",
      at: "2026-10-08T10:01:00.000Z",
    },
    createdAt: "2026-10-08T10:00:00.000Z",
    updatedAt: "2026-10-08T10:01:00.000Z",
    origin: {
      kind: "meeting",
      meetingId: meetingRecordFixture.meeting.id,
      meetingTitle: meetingRecordFixture.meeting.title,
      recordDigest: meetingRecordFixture.recordDigest!,
      sources: meetingRecordFixture.analysis!.tasks[0]!.sources,
    },
  });
  const view = render(
    <MeetingLibrary
      session={f.session}
      language="en"
      visible
      conversationId="TEST-chat"
    />,
  );
  await waitFor(() => expect(view.getByTestId(row)).toBeTruthy());
  fireEvent.press(view.getByTestId(row));
  await waitFor(() =>
    expect(
      view.getByRole("button", { name: en.meetingProcessSelectTask }),
    ).toBeTruthy(),
  );
  fireEvent.press(
    view.getByRole("button", { name: en.meetingProcessSelectTask }),
  );
  await waitFor(() =>
    expect(
      view.getByRole("button", { name: en.meetingProcessTaskCheck }),
    ).toBeTruthy(),
  );
  expect(view.queryByTestId("selected-process-task")).toBeNull();
  fireEvent.press(
    view.getByRole("button", { name: en.meetingProcessTaskCheck }),
  );
  await waitFor(() =>
    expect(view.getByTestId("selected-process-task").props.children).toBe(
      `${meetingRecordFixture.humanTaskIds[0]}:7`,
    ),
  );
});
test("a superseded task read cannot overwrite a newer selection result", async () => {
  const f = fixture();
  const taskId = meetingRecordFixture.humanTaskIds[0]!;
  const reader = f.session.readHumanTask as jest.Mock;
  const staleTask = await reader(taskId);
  let resolveStale!: (task: typeof staleTask) => void;
  reader.mockImplementationOnce(
    () => new Promise((resolve) => (resolveStale = resolve)),
  );
  const view = render(
    <MeetingLibrary
      session={f.session}
      language="en"
      visible
      conversationId="TEST-chat"
    />,
  );
  await waitFor(() => expect(view.getByTestId(row)).toBeTruthy());
  fireEvent.press(view.getByTestId(row));
  const selectTask = await waitFor(() =>
    view.getByRole("button", { name: en.meetingProcessSelectTask }),
  );
  fireEvent.press(selectTask);
  fireEvent.press(selectTask);
  await waitFor(() =>
    expect(view.getByTestId("selected-process-task").props.children).toBe(
      `${taskId}:7`,
    ),
  );
  await act(async () => {
    resolveStale({
      ...staleTask,
      revision: 8,
      status: "done",
      resolution: {
        by: "user",
        reason: "completed",
        at: "2026-10-08T10:01:00.000Z",
      },
    });
  });
  expect(view.getByTestId("selected-process-task").props.children).toBe(
    `${taskId}:7`,
  );
});
test("a controlled record opens only through the screen selection", async () => {
  const f = fixture();
  const select = jest.fn();
  const view = render(
    <MeetingLibrary
      session={f.session}
      language="en"
      visible
      selectedId={null}
      onSelect={select}
    />,
  );
  await waitFor(() => expect(view.getByTestId(row)).toBeTruthy());
  fireEvent.press(view.getByTestId(row));
  expect(select).toHaveBeenCalledWith(meetingRecordFixture.meeting.id);
  expect(f.session.readMeetingRecord).not.toHaveBeenCalled();
  view.rerender(
    <MeetingLibrary
      session={f.session}
      language="en"
      visible
      selectedId={meetingRecordFixture.meeting.id}
      onSelect={select}
    />,
  );
  await waitFor(() => expect(view.getByTestId("meeting-detail")).toBeTruthy());
  await waitFor(() =>
    expect(f.session.readMeetingRecord).toHaveBeenCalledTimes(1),
  );
});
test("legacy ready meeting exposes its full transcript and requires an explicit model action to create the whole record", async () => {
  const f = fixture();
  (f.session.readMeetingRecord as jest.Mock).mockResolvedValue({
    ...meetingRecordFixture,
    analysis: null,
    humanTaskIds: [],
    recordDigest: null,
    analyzer: null,
  });
  const view = render(
    <MeetingLibrary session={f.session} language="en" visible />,
  );
  await waitFor(() => expect(view.getByTestId(row)).toBeTruthy());
  fireEvent.press(view.getByTestId(row));
  const consolidate = () =>
    view.getByRole("button", { name: en.meetingConsolidate });
  await waitFor(() => expect(consolidate()).toBeTruthy());
  expect(f.session.processMeeting).not.toHaveBeenCalled();
  expect(view.getByText(meetingRecordFixture.transcript)).toBeTruthy();
  fireEvent.press(consolidate());
  await waitFor(() =>
    expect(f.session.processMeeting).toHaveBeenCalledWith(
      meetingRecordFixture.meeting.id,
    ),
  );
});
test("scheduled calendar meetings belong to the list, never under an open record", async () => {
  const f = fixture();
  const view = render(
    <MeetingLibrary
      session={f.session}
      language="en"
      visible
      scheduled={<Text>TEST scheduled meeting</Text>}
    />,
  );
  await waitFor(() => expect(view.getByTestId(row)).toBeTruthy());
  expect(view.getByText(en.meetingsScheduled)).toBeTruthy();
  expect(view.getByText("TEST scheduled meeting")).toBeTruthy();
  fireEvent.press(view.getByTestId(row));
  await waitFor(() => expect(view.getByTestId("meeting-detail")).toBeTruthy());
  expect(view.queryByText("TEST scheduled meeting")).toBeNull();
});
