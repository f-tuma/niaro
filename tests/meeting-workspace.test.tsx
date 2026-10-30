import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { Workspace } from "../apps/mobile/App";
import { MeetingCapture } from "../packages/client-core/meeting-capture";
import { AudioSessionCoordinator } from "../packages/audio/coordinator";
import type {
  ClientSession,
  SessionState,
} from "../packages/client-core/session";
import { fromSnapshot } from "../packages/client-core/store";
import { emptySnapshot } from "../packages/test-fixtures";
import type { Section } from "../apps/mobile/ScreenChrome";
import { MEETING_PROFILE } from "../packages/protocol/meetings";
import { meetingRecordFixture } from "../packages/test-fixtures/meeting";

const mockCaptures = new Map<string, MeetingCapture>();
const mockFactories = new Map<string, () => MeetingCapture>();
jest.mock("../apps/mobile/meeting-device", () => ({
  useMeetingDevice: (identity: string) => {
    const { useEffect, useState } = jest.requireActual("react");
    const [capture] = useState(() => {
      const next = mockFactories.get(identity)!();
      mockCaptures.set(identity, next);
      return next;
    });
    useEffect(() => {
      capture.activate();
      void capture.restore();
      return () => capture.dispose();
    }, [capture]);
    return {
      capture,
      durationMillis: 1000,
      pickAudio: async () => mockPicked,
    };
  },
}));
let mockPicked: { uri: string; name: string; size: number } | null = null;
const mockNotification = {
  show: jest.fn((_content: Record<string, unknown>) => true),
  listener: undefined as ((event: { action: string }) => void) | undefined,
  addListener: jest.fn(
    (_event: string, listener: (event: { action: string }) => void) => {
      mockNotification.listener = listener;
      return { remove: () => (mockNotification.listener = undefined) };
    },
  ),
};
// Imports run before this file's constants; read the mock when the app asks.
jest.mock("../modules/meeting-notification", () => ({
  get meetingNotification() {
    return mockNotification;
  },
}));
jest.mock("../apps/mobile/voice-capture", () => ({
  createVoiceCapture: jest.fn(),
}));
jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => {}),
}));
jest.mock("../apps/mobile/feedback", () => ({
  feedback: () => 0,
  setFeedbackEnabled: jest.fn(),
}));
jest.mock("../apps/mobile/app-login", () => ({
  loginProof: jest.fn(),
  authorizeApp: jest.fn(),
}));
jest.mock("expo-crypto", () => ({
  randomUUID: () => "11111111-1111-4111-8111-111111111111",
}));
jest.mock("../apps/mobile/ReplySpeech", () => ({
  useReplySpeech: () => ({
    player: { stop: jest.fn(), waitForReply: jest.fn() },
    state: { phase: "idle" },
    enabled: false,
  }),
}));
const flush = async () => {
  for (let n = 0; n < 30; n++) await Promise.resolve();
};
function fixture(identity: string, coordinator: AudioSessionCoordinator) {
  const storage = new Map<string, string>();
  let recording = false;
  const probe = jest.fn(async () => 1000);
  const stop = jest.fn(async () => {
    recording = false;
    return "file:///document/Audio/recording-test.m4a";
  });
  mockFactories.set(
    identity,
    () =>
      new MeetingCapture(identity, {
        storage: {
          getItem: async (key) => storage.get(key) ?? null,
          setItem: async (key, value) => {
            storage.set(key, value);
          },
        },
        coordinator,
        permission: async () => true,
        mode: async () => {},
        prepare: async () => {},
        uri: () => "file:///document/Audio/recording-test.m4a",
        record: () => {
          recording = true;
        },
        importFile: async (_source, extension) => ({
          uri: `file:///document/Audio/import-TEST.${extension}`,
          bytes: 64,
        }),
        discard: () => {},
        pause: () => {
          recording = false;
        },
        resume: () => {
          recording = true;
        },
        stop,
        status: () => ({ isRecording: recording, durationMillis: 1000 }),
        valid: () => true,
        size: () => 64,
        probe,
        read: (_uri, _offset, n) => new Uint8Array(n),
        remove: () => {},
        play: () => ({ stop: () => {} }),
      }),
  );
  const snapshot = emptySnapshot();
  const state: SessionState = {
    store: fromSnapshot("https://fixture.test/v1/a", snapshot.scope, snapshot),
    status: "online",
    pending: null,
    processPending: null,
    answerAttempts: [],
    answerRecoveryBlocked: false,
    commandStates: {},
    error: null,
    activity: null,
    activityConnection: "waiting",
  };
  const session = {
    identityKey: identity,
    getSnapshot: () => state,
    subscribe: () => () => {},
    start: jest.fn(async () => {}),
    stop: jest.fn(),
    refresh: jest.fn(async () => {}),
    selectConversation: jest.fn(),
    readMeetings: jest.fn(async () => ({
      profile: MEETING_PROFILE,
      scope: snapshot.scope,
      meetings: [],
    })),
    readProcessExecutions: jest.fn(async () => ({ processes: [] })),
  } as unknown as ClientSession;
  return {
    get capture() {
      return mockCaptures.get(identity)!;
    },
    session,
    stop,
    probe,
  };
}
function view(session: ClientSession, section: Section) {
  return (
    <Workspace
      session={session}
      language="en"
      section={section}
      setSection={() => {}}
      settings={null}
      authError={null}
      spokenReplies={false}
    />
  );
}
test("Workspace navigation retains the recorder; changing the authenticated connection interrupts the original recording", async () => {
  const coordinator = new AudioSessionCoordinator();
  const a = fixture("TEST-A", coordinator);
  const b = fixture("TEST-B", coordinator);
  const ui = render(view(a.session, "meetings"));
  await act(flush);
  fireEvent.press(screen.getByLabelText("Record meeting"));
  await act(flush);
  expect(a.capture.getSnapshot().phase).toBe("recording");
  for (const section of ["chat", "more", "meetings"] as const) {
    ui.rerender(view(a.session, section));
    await act(flush);
    expect(a.capture.getSnapshot().phase).toBe("recording");
    expect(a.stop).not.toHaveBeenCalled();
    expect(coordinator.current()).toBe("recording");
  }
  ui.rerender(view(b.session, "meetings"));
  await act(flush);
  expect(a.stop).toHaveBeenCalledTimes(1);
  expect(a.capture.getSnapshot().entries[0]).toMatchObject({
    state: "captured",
    interrupted: true,
  });
  expect(b.capture.getSnapshot().entries).toEqual([]);
  expect(coordinator.current()).toBeNull();
  expect(b.session.readMeetings).toHaveBeenCalled();
  ui.unmount();
});
test("an open meeting record is its own screen: Back returns to the list; tabs lead elsewhere", async () => {
  const coordinator = new AudioSessionCoordinator();
  const a = fixture("TEST-RECORD", coordinator);
  const meeting = {
    ...meetingRecordFixture.meeting,
    scope: emptySnapshot().scope,
  };
  (a.session as unknown as Record<string, unknown>).readMeetings = jest.fn(
    async () => ({
      profile: MEETING_PROFILE,
      scope: meeting.scope,
      meetings: [meeting],
    }),
  );
  (a.session as unknown as Record<string, unknown>).readMeetingRecord = jest.fn(
    async () => ({ ...meetingRecordFixture, meeting }),
  );
  const setSection = jest.fn();
  render(
    <Workspace
      session={a.session}
      language="en"
      section="meetings"
      setSection={setSection}
      settings={null}
      authError={null}
      spokenReplies={false}
    />,
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await flush();
  });
  fireEvent.press(screen.getByTestId(`meeting-${meeting.id}`));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await flush();
  });
  expect(screen.getByTestId("meeting-detail")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "Back" }));
  expect(setSection).not.toHaveBeenCalled();
  expect(screen.queryByTestId("meeting-detail")).toBeNull();
  expect(screen.getByTestId(`meeting-${meeting.id}`)).toBeTruthy();
  // Meetings is nested in Library; Back returns there, while Chat remains one tap away.
  fireEvent.press(screen.getByRole("button", { name: "Back" }));
  expect(setSection).toHaveBeenCalledWith("library");
  fireEvent.press(screen.getByRole("tab", { name: "Chat" }));
  expect(setSection).toHaveBeenCalledWith("chat");
});

test("a recording meeting can pause and resume in the app and from its notification, whose Stop saves it like the app's", async () => {
  const a = fixture("TEST-A", new AudioSessionCoordinator());
  const ui = render(view(a.session, "meetings"));
  await act(flush);
  fireEvent.press(screen.getByLabelText("Record meeting"));
  await act(flush);
  expect(mockNotification.show).toHaveBeenLastCalledWith(
    expect.objectContaining({
      title: "Recording a meeting",
      text: expect.stringMatching(/^Meeting · /),
      paused: false,
      elapsedMillis: 1000,
      pauseLabel: "Pause",
      resumeLabel: "Resume",
      stopLabel: "Stop",
    }),
  );
  fireEvent.press(screen.getByRole("button", { name: "Pause" }));
  await act(flush);
  expect(a.capture.getSnapshot().phase).toBe("paused");
  expect(screen.getByText("Recording paused")).toBeTruthy();
  expect(mockNotification.show).toHaveBeenLastCalledWith(
    expect.objectContaining({
      title: "Recording paused",
      paused: true,
    }),
  );
  await act(async () => {
    mockNotification.listener!({ action: "resume" });
    await flush();
  });
  expect(a.capture.getSnapshot().phase).toBe("recording");
  expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
  await act(async () => {
    mockNotification.listener!({ action: "stop" });
    await flush();
  });
  expect(a.stop).toHaveBeenCalledTimes(1);
  expect(a.capture.getSnapshot().entries[0]).toMatchObject({
    state: "captured",
    interrupted: false,
  });
  ui.unmount();
  expect(mockNotification.listener).toBeUndefined();
});
test("a notification the system refuses never stops the recording", async () => {
  mockNotification.show.mockImplementation(() => {
    throw new Error("TEST channel refused");
  });
  try {
    const a = fixture("TEST-A", new AudioSessionCoordinator());
    const ui = render(view(a.session, "meetings"));
    await act(flush);
    fireEvent.press(screen.getByLabelText("Record meeting"));
    await act(flush);
    expect(mockNotification.show).toHaveBeenCalled();
    expect(a.capture.getSnapshot().phase).toBe("recording");
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    ui.unmount();
  } finally {
    mockNotification.show.mockImplementation(() => true);
  }
});
test("Upload audio file brings a recording from the device in and sends it for processing", async () => {
  const a = fixture("TEST-A", new AudioSessionCoordinator());
  const session = a.session as unknown as Record<string, jest.Mock>;
  session.createMeeting = jest.fn(async () => ({
    status: "uploading",
    offset: 0,
  }));
  session.uploadMeetingBlock = jest.fn(
    async (_id: string, at: number, block: Uint8Array) => ({
      status: "uploading",
      offset: at + block.length,
    }),
  );
  session.sealMeeting = jest.fn(async () => ({ status: "sealed", offset: 64 }));
  session.processMeeting = jest.fn(async () => {});
  const ui = render(view(a.session, "meetings"));
  await act(flush);
  mockPicked = null;
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Upload audio file" }));
    await flush();
  });
  expect(session.createMeeting).not.toHaveBeenCalled();
  mockPicked = {
    uri: "file:///cache/picked.m4a",
    name: "Porada.m4a",
    size: 64,
  };
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Upload audio file" }));
    await flush();
  });
  expect(session.createMeeting).toHaveBeenCalledWith(
    expect.objectContaining({
      mimeType: "audio/mp4",
      bytes: 64,
      title: expect.stringMatching(/^Meeting · /),
    }),
  );
  expect(session.processMeeting).toHaveBeenCalled();
  expect(a.capture.getSnapshot().entries[0]).toMatchObject({
    state: "captured",
    uploaded: true,
  });
  ui.unmount();
});

test("the live journal entry is not a recovery failure, while older idle recovery and saved audio remain actionable", async () => {
  const a = fixture("TEST-JOURNAL-DISPLAY", new AudioSessionCoordinator());
  const ui = render(view(a.session, "meetings"));
  await act(flush);
  await act(async () => {
    // A prior recording whose duration could not be read remains recoverable.
    await a.capture.start(
      "22222222-2222-4222-8222-222222222222",
      "TEST earlier recording",
      "en",
    );
    a.probe.mockRejectedValueOnce(new Error("TEST unreadable duration"));
    await a.capture.stop();
  });
  expect(a.capture.getSnapshot().entries[0]?.state).toBe("pending");
  fireEvent.press(screen.getByRole("button", { name: "Record meeting" }));
  await act(flush);
  expect(
    a.capture
      .getSnapshot()
      .entries.filter((entry) => entry.state === "pending"),
  ).toHaveLength(2);
  expect(screen.getAllByText(/Couldn't recover/)).toHaveLength(1);
  expect(screen.getByText("TEST earlier recording")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Recover recording" }),
  ).toBeDisabled();
  fireEvent.press(screen.getByRole("button", { name: "Pause" }));
  await act(flush);
  expect(screen.getAllByText(/Couldn't recover/)).toHaveLength(1);
  fireEvent.press(screen.getByRole("button", { name: "Stop and process" }));
  await act(flush);
  expect(a.capture.getSnapshot().entries[0]?.state).toBe("captured");
  expect(screen.getByText(/Not uploaded yet/)).toBeTruthy();
  const recover = screen.getByRole("button", { name: "Recover recording" });
  expect(recover).toBeEnabled();
  fireEvent.press(recover);
  await act(flush);
  expect(
    a.capture
      .getSnapshot()
      .entries.every((entry) => entry.state === "captured"),
  ).toBe(true);
  expect(
    screen.queryByRole("button", { name: "Recover recording" }),
  ).toBeNull();
  fireEvent.press(
    screen.getAllByRole("button", { name: "Delete recording" })[0]!,
  );
  fireEvent.press(screen.getByRole("button", { name: "Cancel" }));
  expect(a.capture.getSnapshot().entries).toHaveLength(2);
  fireEvent.press(
    screen.getAllByRole("button", { name: "Delete recording" })[0]!,
  );
  fireEvent.press(screen.getByRole("button", { name: "Delete permanently" }));
  await act(flush);
  expect(a.capture.getSnapshot().entries).toHaveLength(1);
  ui.unmount();
});

test("a settled failed recording remains recoverable while older saved audio plays", async () => {
  const a = fixture("TEST-SETTLED-JOURNAL", new AudioSessionCoordinator());
  const ui = render(view(a.session, "meetings"));
  await act(flush);
  await act(async () => {
    await a.capture.start(
      "22222222-2222-4222-8222-222222222222",
      "TEST older saved recording",
      "en",
    );
    await a.capture.stop();
  });
  fireEvent.press(screen.getByRole("button", { name: "Record meeting" }));
  await act(flush);
  a.probe.mockRejectedValueOnce(new Error("TEST unreadable current duration"));
  fireEvent.press(screen.getByRole("button", { name: "Stop and process" }));
  await act(flush);
  expect(a.capture.getSnapshot().phase).toBe("idle");
  expect(
    a.capture
      .getSnapshot()
      .entries.filter((entry) => entry.state === "pending"),
  ).toHaveLength(1);
  expect(
    screen.getByRole("button", { name: "Recover recording" }),
  ).toBeEnabled();
  fireEvent.press(screen.getByRole("button", { name: "Play saved recording" }));
  await act(flush);
  expect(a.capture.getSnapshot().phase).toBe("playback");
  expect(
    screen.getByRole("button", { name: "Recover recording" }),
  ).toBeDisabled();
  expect(
    a.capture
      .getSnapshot()
      .entries.filter((entry) => entry.state === "pending"),
  ).toHaveLength(1);
  fireEvent.press(screen.getByRole("button", { name: "Stop playback" }));
  await act(flush);
  expect(
    screen.getByRole("button", { name: "Recover recording" }),
  ).toBeEnabled();
  ui.unmount();
});
