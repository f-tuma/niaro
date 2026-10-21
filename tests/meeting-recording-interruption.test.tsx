import React from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { MeetingLibrary } from "../apps/mobile/MeetingLibrary";
import type { ClientSession } from "../packages/client-core/session";
import { cs, en } from "../packages/i18n";

const mockSnapshot = {
  phase: "idle" as const,
  entries: [],
  error: null,
  uploadOffset: 0,
};
const mockCapture = {
  subscribe: jest.fn(() => () => {}),
  getSnapshot: jest.fn(() => mockSnapshot),
  start: jest.fn(),
};

jest.mock("../apps/mobile/meeting-device", () => ({
  useMeetingDevice: () => ({ capture: mockCapture, durationMillis: 0 }),
}));

test("meeting capture waits for a confirmed interruption before starting the microphone", async () => {
  const order: string[] = [];
  mockCapture.start.mockReset();
  mockCapture.start.mockImplementation(() => {
    order.push("record");
  });
  let settleInterruption!: (settled: boolean) => void;
  const onStartRecording = jest.fn(
    () =>
      new Promise<boolean>((resolve) => {
        order.push("interrupt");
        settleInterruption = resolve;
      }),
  );
  const session = {
    identityKey: "TEST-recording-interruption",
    readMeetings: jest.fn(async () => ({ meetings: [] })),
  } as unknown as ClientSession;
  const view = render(
    <MeetingLibrary
      session={session}
      language="en"
      visible
      onStartRecording={onStartRecording}
    />,
  );

  await waitFor(() =>
    expect(view.getByRole("button", { name: en.meetingRecord })).toBeTruthy(),
  );
  fireEvent.press(view.getByRole("button", { name: en.meetingRecord }));

  expect(onStartRecording).toHaveBeenCalledTimes(1);
  expect(mockCapture.start).not.toHaveBeenCalled();
  expect(order).toEqual(["interrupt"]);
  expect(
    view.getByRole("button", { name: en.meetingStarting }).props
      .accessibilityState.disabled,
  ).toBe(true);
  fireEvent.press(view.getByRole("button", { name: en.meetingStarting }));
  expect(onStartRecording).toHaveBeenCalledTimes(1);
  await act(async () => settleInterruption(false));
  expect(mockCapture.start).not.toHaveBeenCalled();
  expect(view.getByText(en.meeting_interrupt_failed)).toBeTruthy();
  mockCapture.start.mockReset();
});

test("meeting capture starts exactly once after a successful interruption", async () => {
  const order: string[] = [];
  mockCapture.start.mockReset();
  mockCapture.start.mockImplementation(() => {
    order.push("record");
  });
  let settleInterruption!: (settled: boolean) => void;
  const onStartRecording = jest.fn(
    () =>
      new Promise<boolean>((resolve) => {
        order.push("interrupt");
        settleInterruption = resolve;
      }),
  );
  const session = {
    identityKey: "TEST-recording-interruption-success",
    readMeetings: jest.fn(async () => ({ meetings: [] })),
  } as unknown as ClientSession;
  const view = render(
    <MeetingLibrary
      session={session}
      language="en"
      visible
      onStartRecording={onStartRecording}
    />,
  );

  await waitFor(() =>
    expect(view.getByRole("button", { name: en.meetingRecord })).toBeTruthy(),
  );
  fireEvent.press(view.getByRole("button", { name: en.meetingRecord }));
  expect(mockCapture.start).not.toHaveBeenCalled();
  await act(async () => settleInterruption(true));
  await waitFor(() => expect(mockCapture.start).toHaveBeenCalledTimes(1));
  expect(order).toEqual(["interrupt", "record"]);
  mockCapture.start.mockReset();
});

test("a rejected interruption keeps the recorder stopped and explains the block", async () => {
  mockCapture.start.mockReset();
  const onStartRecording = jest.fn(async () => {
    throw Error("network_offline");
  });
  const session = {
    identityKey: "TEST-recording-interruption-rejected",
    readMeetings: jest.fn(async () => ({ meetings: [] })),
  } as unknown as ClientSession;
  const view = render(
    <MeetingLibrary
      session={session}
      language="cs"
      visible
      onStartRecording={onStartRecording}
    />,
  );

  await waitFor(() =>
    expect(view.getByRole("button", { name: cs.meetingRecord })).toBeTruthy(),
  );
  fireEvent.press(view.getByRole("button", { name: cs.meetingRecord }));
  await waitFor(() =>
    expect(view.getByText(cs.meeting_interrupt_failed)).toBeTruthy(),
  );
  expect(mockCapture.start).not.toHaveBeenCalled();
  mockCapture.start.mockReset();
});

test("a late interruption acknowledgement after unmount never starts capture", async () => {
  mockCapture.start.mockReset();
  let settleInterruption!: (settled: boolean) => void;
  const onStartRecording = jest.fn(
    () =>
      new Promise<boolean>((resolve) => {
        settleInterruption = resolve;
      }),
  );
  const session = {
    identityKey: "TEST-recording-interruption-unmount",
    readMeetings: jest.fn(async () => ({ meetings: [] })),
  } as unknown as ClientSession;
  const view = render(
    <MeetingLibrary
      session={session}
      language="en"
      visible
      onStartRecording={onStartRecording}
    />,
  );

  await waitFor(() =>
    expect(view.getByRole("button", { name: en.meetingRecord })).toBeTruthy(),
  );
  fireEvent.press(view.getByRole("button", { name: en.meetingRecord }));
  expect(onStartRecording).toHaveBeenCalledTimes(1);
  view.unmount();
  await act(async () => settleInterruption(true));
  expect(mockCapture.start).not.toHaveBeenCalled();
  mockCapture.start.mockReset();
});

test("leaving Meetings invalidates a pending interruption before microphone start", async () => {
  mockCapture.start.mockReset();
  let settleInterruption!: (settled: boolean) => void;
  const onStartRecording = jest.fn(
    () =>
      new Promise<boolean>((resolve) => {
        settleInterruption = resolve;
      }),
  );
  const session = {
    identityKey: "TEST-recording-interruption-navigation",
    readMeetings: jest.fn(async () => ({ meetings: [] })),
  } as unknown as ClientSession;
  const view = render(
    <MeetingLibrary
      session={session}
      language="en"
      visible
      onStartRecording={onStartRecording}
    />,
  );

  await waitFor(() =>
    expect(view.getByRole("button", { name: en.meetingRecord })).toBeTruthy(),
  );
  fireEvent.press(view.getByRole("button", { name: en.meetingRecord }));
  view.rerender(
    <MeetingLibrary
      session={session}
      language="en"
      visible={false}
      onStartRecording={onStartRecording}
    />,
  );
  view.rerender(
    <MeetingLibrary
      session={session}
      language="en"
      visible
      onStartRecording={onStartRecording}
    />,
  );
  await act(async () => settleInterruption(true));

  expect(mockCapture.start).not.toHaveBeenCalled();
  mockCapture.start.mockReset();
});

test("standalone meeting capture starts without an interruption callback", async () => {
  mockCapture.start.mockReset();
  const session = {
    identityKey: "TEST-recording-without-interruption",
    readMeetings: jest.fn(async () => ({ meetings: [] })),
  } as unknown as ClientSession;
  const view = render(
    <MeetingLibrary session={session} language="en" visible />,
  );

  await waitFor(() =>
    expect(view.getByRole("button", { name: en.meetingRecord })).toBeTruthy(),
  );
  fireEvent.press(view.getByRole("button", { name: en.meetingRecord }));
  await waitFor(() => expect(mockCapture.start).toHaveBeenCalledTimes(1));
  mockCapture.start.mockReset();
});
