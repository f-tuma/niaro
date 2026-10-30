import React, { useState } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react-native";
import { AppState, Modal } from "react-native";
import {
  MeetingLibrary,
  MeetingRecordingControls,
} from "../apps/mobile/MeetingLibrary";
import { Workspace } from "../apps/mobile/App";
import type { Section } from "../apps/mobile/ScreenChrome";
import { createVoiceCapture } from "../apps/mobile/voice-capture";
import {
  MeetingCapture,
  type MeetingCapturePorts,
} from "../packages/client-core/meeting-capture";
import { AudioSessionCoordinator } from "../packages/audio/coordinator";
import {
  commandTarget,
  type ClientSession,
  type SessionCommand,
  type SessionState,
} from "../packages/client-core/session";
import { fromSnapshot } from "../packages/client-core/store";
import { emptySnapshot } from "../packages/test-fixtures";
import { voiceCapabilities } from "../packages/protocol/voice";
import { CONVERSATION_HISTORY_PROFILE } from "../packages/protocol";
import { meetingRecordFixture } from "../packages/test-fixtures/meeting";
import { en } from "../packages/i18n";

let mockCapture: MeetingCapture;
const mockPickAudio = jest.fn(async () => null);
const mockSpeech = {
  player: { stop: jest.fn(), waitForReply: jest.fn() },
  state: { phase: "idle" },
  enabled: false,
};
jest.mock("../apps/mobile/voice-capture", () => ({
  createVoiceCapture: jest.fn(),
}));
jest.mock("../apps/mobile/ReplySpeech", () => ({
  useReplySpeech: () => mockSpeech,
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
jest.mock("../apps/mobile/meeting-device", () => ({
  useMeetingDevice: () => ({
    capture: mockCapture,
    durationMillis: 1200,
    pickAudio: mockPickAudio,
  }),
}));
jest.mock("../apps/mobile/meeting-notification", () => ({
  useMeetingNotification: () => {},
}));
jest.mock("expo-crypto", () => ({
  randomUUID: () => "11111111-1111-4111-8111-111111111111",
}));

async function fixture(
  gates: Partial<
    Pick<MeetingCapturePorts, "permission" | "prepare" | "stop">
  > = {},
) {
  let recording = false;
  const coordinator = new AudioSessionCoordinator();
  const stop = jest.fn(async () => {
    if (gates.stop) await gates.stop();
    recording = false;
    return "file:///document/Audio/recording-TEST-current.m4a";
  });
  const record = jest.fn(() => {
    recording = true;
  });
  mockCapture = new MeetingCapture("TEST-mobile-user-journey", {
    storage: { getItem: async () => null, setItem: async () => {} },
    coordinator,
    permission: gates.permission ?? (async () => true),
    mode: async () => {},
    prepare: gates.prepare ?? (async () => {}),
    uri: () => "file:///document/Audio/recording-TEST-current.m4a",
    record,
    importFile: async () => ({
      uri: "file:///document/Audio/import-TEST.m4a",
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
    status: () => ({ isRecording: recording, durationMillis: 1200 }),
    valid: () => true,
    size: () => 64,
    probe: async () => 1200,
    read: (_uri, _offset, length) => new Uint8Array(length),
    remove: () => {},
  });
  await mockCapture.restore();
  const session = {
    identityKey: "TEST-mobile-user-journey",
    readMeetings: jest.fn(async () => ({
      meetings: [meetingRecordFixture.meeting],
    })),
    readMeetingRecord: jest.fn(async () => meetingRecordFixture),
    readMeeting: jest.fn(async () => ({
      segments: [{ index: 0, startSeconds: 0, text: "TEST saved source" }],
    })),
    createMeeting: jest.fn(async () => ({ status: "uploading", offset: 0 })),
    uploadMeetingBlock: jest.fn(
      async (_id: string, offset: number, bytes: Uint8Array) => ({
        status: "uploading",
        offset: offset + bytes.length,
      }),
    ),
    sealMeeting: jest.fn(async () => ({ status: "sealed", offset: 64 })),
    processMeeting: jest.fn(async () => {}),
  } as unknown as ClientSession;
  return { session, capture: mockCapture, coordinator, stop, record };
}

test.each(["permission", "prepare"] as const)(
  "leaving Meetings cancels a native capture still waiting for %s",
  async (stage) => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture({
      permission: async () => {
        if (stage === "permission") await waiting;
        return true;
      },
      prepare: async () => {
        if (stage === "prepare") await waiting;
      },
    });
    const view = render(
      <MeetingLibrary session={f.session} language="en" visible />,
    );
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: en.meetingRecord }));
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });
    expect(f.capture.getSnapshot().phase).toBe("preparing");
    expect(f.coordinator.current()).toBe("recording");
    view.rerender(
      <MeetingLibrary session={f.session} language="en" visible={false} />,
    );
    // Reopening the tab cannot revive the earlier microphone request.
    view.rerender(<MeetingLibrary session={f.session} language="en" visible />);
    await act(async () => {
      release();
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });
    expect(f.record).not.toHaveBeenCalled();
    expect(f.capture.getSnapshot().phase).toBe("idle");
    expect(f.capture.getSnapshot().entries).toEqual([]);
    expect(f.coordinator.current()).toBeNull();
    expect(f.stop).toHaveBeenCalledTimes(stage === "prepare" ? 1 : 0);
    view.unmount();
  },
);

test.each(["recording", "paused"] as const)(
  "reading a saved meeting keeps the current %s capture visible and stoppable",
  async (phase) => {
    const f = await fixture();
    const view = render(
      <MeetingLibrary session={f.session} language="en" visible />,
    );
    await waitFor(() =>
      expect(
        screen.getByTestId(`meeting-${meetingRecordFixture.meeting.id}`),
      ).toBeTruthy(),
    );
    await act(async () =>
      fireEvent.press(screen.getByRole("button", { name: en.meetingRecord })),
    );
    expect(f.capture.getSnapshot().phase).toBe("recording");
    if (phase === "paused") {
      await act(async () =>
        fireEvent.press(screen.getByRole("button", { name: en.meetingPause })),
      );
    }
    fireEvent.press(
      screen.getByTestId(`meeting-${meetingRecordFixture.meeting.id}`),
    );
    await waitFor(() =>
      expect(screen.getByText(meetingRecordFixture.transcript)).toBeTruthy(),
    );
    expect(f.capture.getSnapshot().phase).toBe(phase);
    expect(f.coordinator.current()).toBe("recording");
    expect(f.stop).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: en.meetingStop })).toBeTruthy();
    const toggle = screen.getByRole("button", {
      name: phase === "paused" ? en.meetingResume : en.meetingPause,
    });
    await act(async () => fireEvent.press(toggle));
    expect(f.capture.getSnapshot().phase).toBe(
      phase === "paused" ? "recording" : "paused",
    );
    await act(async () =>
      fireEvent.press(screen.getByRole("button", { name: en.meetingStop })),
    );
    expect(f.stop).toHaveBeenCalledTimes(1);
    expect(f.capture.getSnapshot().phase).toBe("idle");
    expect(f.capture.getSnapshot().entries[0]).toMatchObject({
      state: "captured",
      uploaded: true,
    });
    expect(f.session.processMeeting).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(screen.getByTestId("meeting-detail")).toBeTruthy();
    view.unmount();
  },
);

test.each([
  { cancellation: "tab", accepted: true },
  { cancellation: "tab", accepted: false },
  { cancellation: "menu", accepted: true },
  { cancellation: "background", accepted: true },
  { cancellation: "none", accepted: true },
  { cancellation: "repeat_voice", accepted: true },
  { cancellation: "send_then_voice", accepted: true },
] as const)(
  "new chat voice waits for an owned ACK: $cancellation, accepted=$accepted",
  async ({ cancellation, accepted }) => {
    const f = await fixture();
    AppState.currentState = "active";
    const snapshot = emptySnapshot();
    let state: SessionState = {
      store: fromSnapshot(
        "https://fixture.test/v1/a",
        snapshot.scope,
        snapshot,
      ),
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
    const listeners = new Set<() => void>();
    const publish = (patch: Partial<SessionState>) => {
      state = { ...state, ...patch };
      listeners.forEach((listener) => listener());
    };
    let acknowledge!: () => void;
    const creation = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const session = {
      ...f.session,
      getSnapshot: () => state,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      start: jest.fn(async () => {}),
      stop: jest.fn(),
      refresh: jest.fn(async () => {}),
      selectConversation: jest.fn(),
      voiceCapabilities: jest.fn(async () => voiceCapabilities(true)),
      interruptPending: jest.fn(async () => true),
      readHumanTasks: jest.fn(async () => ({
        tasks: [],
        next: null,
        counts: { open: 0, done: 0 },
      })),
      readConversations: jest.fn(async () => ({
        profile: CONVERSATION_HISTORY_PROFILE,
        scope: snapshot.scope,
        conversations: [],
        nextAfter: null,
      })),
      readConversation: jest.fn(async (id: string) => ({
        profile: CONVERSATION_HISTORY_PROFILE,
        scope: snapshot.scope,
        conversation: {
          id,
          revision: 1,
          title: "",
          createdAt: "2026-10-13T00:00:00.000Z",
          updatedAt: "2026-10-13T00:00:00.000Z",
          messageCount: 0,
          readOnly: false,
        },
        messages: [],
        nextAfter: null,
      })),
      send: jest.fn((command: SessionCommand) => {
        if (state.pending) return Promise.resolve();
        publish({
          pending: command,
          commandStates: { [commandTarget(command)]: "sending" },
        });
        return command.type === "conversation.create"
          ? creation
          : Promise.resolve();
      }),
    } as unknown as ClientSession;
    const capture = {
      supported: () => true,
      start: jest.fn(async () => {}),
      stop: jest.fn(async () => ({
        mimeType: "audio/wav" as const,
        base64: "YWJjZA==",
      })),
      discard: jest.fn(async () => {}),
    };
    jest.mocked(createVoiceCapture).mockReturnValue(capture);
    function Harness() {
      const [section, setSection] = useState<Section>("chat");
      return (
        <Workspace
          session={session}
          language="en"
          section={section}
          setSection={setSection}
          settings={null}
          authError={null}
          spokenReplies={false}
        />
      );
    }
    const changes = new Set<(state: string) => void>();
    const originalListener = jest
      .mocked(AppState.addEventListener)
      .getMockImplementation();
    const appState =
      cancellation === "background"
        ? jest
            .spyOn(AppState, "addEventListener")
            .mockImplementation((_event, listener) => {
              const callback = listener as (state: string) => void;
              changes.add(callback);
              return {
                remove: () => {
                  changes.delete(callback);
                },
              };
            })
        : null;
    const view = render(<Harness />);
    await act(async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });
    fireEvent.press(screen.getByRole("button", { name: "New chat" }));
    if (cancellation === "send_then_voice") {
      fireEvent.changeText(
        screen.getByLabelText(en.composer),
        "TEST typed first intent",
      );
      fireEvent.press(screen.getByRole("button", { name: en.send }));
    } else
      fireEvent.press(screen.getByRole("button", { name: en.voice_reply }));
    if (cancellation === "repeat_voice" || cancellation === "send_then_voice") {
      await act(async () => {
        fireEvent.press(screen.getByRole("button", { name: en.voice_reply }));
        for (let i = 0; i < 20; i++) await Promise.resolve();
      });
      expect(screen.queryByText(en.requestRejected)).toBeNull();
    }
    const command = state.pending;
    expect(command?.type).toBe("conversation.create");
    if (cancellation === "tab")
      fireEvent.press(screen.getByRole("tab", { name: "Library" }));
    else if (cancellation === "menu") {
      await act(async () => {
        fireEvent.press(screen.getByRole("button", { name: "Menu" }));
      });
    } else if (cancellation === "background") {
      await act(async () => {
        changes.forEach((change) => change("background"));
        changes.forEach((change) => change("active"));
      });
    }
    await act(async () => {
      publish({
        pending: null,
        commandStates: {
          [commandTarget(command!)]: accepted ? "accepted" : "rejected",
        },
      });
      acknowledge();
      for (let i = 0; i < 30; i++) await Promise.resolve();
    });
    expect(capture.start).toHaveBeenCalledTimes(
      ["none", "repeat_voice", "send_then_voice"].includes(cancellation)
        ? 1
        : 0,
    );
    expect(
      (session.send as jest.Mock).mock.calls.filter(
        ([value]: [SessionCommand]) => value.type === "conversation.create",
      ),
    ).toHaveLength(1);
    expect(screen.queryByText(en.requestRejected)).toBeNull();
    if (cancellation === "menu")
      expect(screen.getByTestId("chat-history-panel")).toBeTruthy();
    else if (
      !accepted ||
      !["none", "repeat_voice", "send_then_voice"].includes(cancellation)
    )
      expect(
        screen.getByRole("tab", {
          name: cancellation === "tab" ? "Library" : "Chat",
        }).props.accessibilityState.selected,
      ).toBe(true);
    if (!accepted) {
      fireEvent.press(screen.getByRole("tab", { name: "Chat" }));
      expect(screen.queryByText(en.requestRejected)).toBeNull();
    }
    view.unmount();
    appState?.mockImplementation(
      originalListener ?? (() => ({ remove: () => {} })),
    );
  },
);

test("waiting for interruption reserves capture before offering another local audio action", async () => {
  const f = await fixture();
  let acknowledge!: (allowed: boolean) => void;
  const interruption = new Promise<boolean>((resolve) => {
    acknowledge = resolve;
  });
  mockPickAudio.mockClear();
  const view = render(
    <MeetingLibrary
      session={f.session}
      language="en"
      visible
      onStartRecording={() => interruption}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: en.meetingRecord })).toBeTruthy(),
  );
  fireEvent.press(screen.getByRole("button", { name: en.meetingRecord }));
  expect(
    screen.getByRole("button", { name: en.meetingStarting }).props
      .accessibilityState.disabled,
  ).toBe(true);
  const upload = screen.getByRole("button", { name: en.meetingImport });
  expect(upload.props.accessibilityState.disabled).toBe(true);
  fireEvent.press(upload);
  expect(mockPickAudio).not.toHaveBeenCalled();
  await act(async () => acknowledge(true));
  expect(f.capture.getSnapshot().phase).toBe("recording");
  await act(async () => f.capture.stop());
  view.unmount();
});

test("backgrounding during meeting interruption cancels the pending start even after returning", async () => {
  const f = await fixture();
  const changes = new Set<(state: string) => void>();
  const originalListener = jest
    .mocked(AppState.addEventListener)
    .getMockImplementation();
  const appState = jest
    .spyOn(AppState, "addEventListener")
    .mockImplementation((_event, listener) => {
      const callback = listener as (state: string) => void;
      changes.add(callback);
      return {
        remove: () => {
          changes.delete(callback);
        },
      };
    });
  let acknowledge!: (allowed: boolean) => void;
  const interruption = new Promise<boolean>((resolve) => {
    acknowledge = resolve;
  });
  const view = render(
    <MeetingLibrary
      session={f.session}
      language="en"
      visible
      onStartRecording={() => interruption}
    />,
  );
  fireEvent.press(screen.getByRole("button", { name: en.meetingRecord }));
  await act(async () => {
    changes.forEach((change) => change("background"));
    changes.forEach((change) => change("active"));
    acknowledge(true);
  });
  expect(f.capture.getSnapshot().phase).toBe("idle");
  expect(f.coordinator.current()).toBeNull();
  view.unmount();
  appState.mockImplementation(
    originalListener ?? (() => ({ remove: () => {} })),
  );
});

test.each(["reader", "source"] as const)(
  "the saved meeting %s keeps microphone controls in its modal",
  async (destination) => {
    let failed = false;
    const f = await fixture({
      stop: async () => {
        if (!failed) {
          failed = true;
          throw Error("TEST native Stop rejected");
        }
        return "file:///document/Audio/recording-TEST-current.m4a";
      },
    });
    const view = render(
      <MeetingLibrary session={f.session} language="en" visible />,
    );
    await waitFor(() =>
      expect(
        screen.getByTestId(`meeting-${meetingRecordFixture.meeting.id}`),
      ).toBeTruthy(),
    );
    await act(async () =>
      fireEvent.press(screen.getByRole("button", { name: en.meetingRecord })),
    );
    fireEvent.press(
      screen.getByTestId(`meeting-${meetingRecordFixture.meeting.id}`),
    );
    await waitFor(() =>
      expect(screen.getByText(meetingRecordFixture.transcript)).toBeTruthy(),
    );
    fireEvent.press(
      screen.getByRole("button", {
        name:
          destination === "reader"
            ? en.meetingReadTranscript
            : en.meetingSource + " 0:00",
      }),
    );
    await waitFor(() =>
      expect(
        destination === "reader"
          ? screen.getByTestId("meeting-transcript-reader")
          : screen.getByText("TEST saved source"),
      ).toBeTruthy(),
    );
    const modal = within(screen.UNSAFE_getByType(Modal));
    expect(modal.getByRole("button", { name: en.meetingPause })).toBeTruthy();
    expect(f.stop).not.toHaveBeenCalled();
    await act(async () =>
      fireEvent.press(modal.getByRole("button", { name: en.meetingStop })),
    );
    expect(f.capture.getSnapshot().phase).toBe("recording");
    expect(modal.getByText(en.meeting_stop_failed_live)).toBeTruthy();
    expect(
      modal.getByRole("button", { name: en.meetingStop }).props
        .accessibilityState.disabled,
    ).toBe(false);
    await act(async () =>
      fireEvent.press(modal.getByRole("button", { name: en.meetingStop })),
    );
    expect(f.stop).toHaveBeenCalledTimes(2);
    expect(f.capture.getSnapshot().phase).toBe("idle");
    expect(f.coordinator.current()).toBeNull();
    view.unmount();
  },
);

test("returning from an old record and switching tabs preserves the same live capture", async () => {
  const f = await fixture();
  const onSelect = jest.fn();
  const content = (selectedId: string | null, visible = true) => (
    <MeetingLibrary
      session={f.session}
      language="en"
      visible={visible}
      selectedId={selectedId}
      onSelect={onSelect}
    />
  );
  const view = render(content(null));
  await waitFor(() =>
    expect(
      screen.getByTestId(`meeting-${meetingRecordFixture.meeting.id}`),
    ).toBeTruthy(),
  );
  await act(async () =>
    fireEvent.press(screen.getByRole("button", { name: en.meetingRecord })),
  );
  fireEvent.press(
    screen.getByTestId(`meeting-${meetingRecordFixture.meeting.id}`),
  );
  expect(onSelect).toHaveBeenCalledWith(meetingRecordFixture.meeting.id);
  view.rerender(content(meetingRecordFixture.meeting.id));
  await waitFor(() =>
    expect(screen.getByText(meetingRecordFixture.transcript)).toBeTruthy(),
  );
  view.rerender(content(null));
  expect(screen.getByTestId("meeting-recorder")).toBeTruthy();
  view.rerender(content(null, false));
  expect(screen.getByTestId("meeting-recording-banner")).toBeTruthy();
  expect(f.capture.getSnapshot().phase).toBe("recording");
  expect(f.coordinator.current()).toBe("recording");
  expect(f.stop).not.toHaveBeenCalled();
  await act(async () =>
    fireEvent.press(screen.getByRole("button", { name: en.meetingStop })),
  );
  expect(f.stop).toHaveBeenCalledTimes(1);
  expect(f.coordinator.current()).toBeNull();
  view.unmount();
});

test.each([
  { destination: "processes", failure: "native" },
  { destination: "menu", failure: "native" },
  { destination: "processes", failure: "upload" },
  { destination: "menu", failure: "upload" },
] as const)(
  "$destination exposes $failure failure and recovery for the same meeting recorder",
  async ({ destination, failure }) => {
    let failed = false;
    const f = await fixture({
      stop: async () => {
        if (failure === "native" && !failed) {
          failed = true;
          throw Error("TEST native Stop rejected");
        }
        return "file:///document/Audio/recording-TEST-current.m4a";
      },
    });
    if (failure === "upload")
      (f.session.createMeeting as jest.Mock).mockRejectedValueOnce(
        Error("meeting_connection_failed"),
      );
    const captureSubscription = jest.spyOn(f.capture, "subscribe");
    const snapshot = emptySnapshot();
    const state: SessionState = {
      store: fromSnapshot(
        "https://fixture.test/v1/a",
        snapshot.scope,
        snapshot,
      ),
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
      ...f.session,
      getSnapshot: () => state,
      subscribe: () => () => {},
      start: jest.fn(async () => {}),
      stop: jest.fn(),
      refresh: jest.fn(async () => {}),
      interruptPending: jest.fn(async () => true),
      readHumanTasks: jest.fn(async () => ({
        tasks: [],
        next: null,
        counts: { open: 0, done: 0 },
      })),
      readConversations: jest.fn(async () => ({
        profile: CONVERSATION_HISTORY_PROFILE,
        scope: snapshot.scope,
        conversations: [],
        nextAfter: null,
      })),
      readProcessExecutions: jest.fn(async () => ({ processes: [] })),
    } as unknown as ClientSession;
    function Harness() {
      const [section, setSection] = useState<Section>("meetings");
      return (
        <Workspace
          session={session}
          language="en"
          section={section}
          setSection={setSection}
          settings={null}
          authError={null}
          spokenReplies={false}
        />
      );
    }
    const flush = async () => {
      for (let i = 0; i < 30; i++) await Promise.resolve();
    };
    const view = render(<Harness />);
    await act(flush);
    await act(async () =>
      fireEvent.press(screen.getByRole("button", { name: en.meetingRecord })),
    );
    expect(f.capture.getSnapshot().phase).toBe("recording");
    fireEvent.press(screen.getByRole("tab", { name: "Chat" }));
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Menu" }));
      await flush();
    });
    if (destination === "processes")
      await act(async () => {
        fireEvent.press(screen.getByText(en.processesTitle));
        await flush();
      });
    const panel = within(
      screen.getByTestId(
        destination === "processes"
          ? "process-launch-panel"
          : "chat-history-panel",
      ),
    );
    expect(panel.getByTestId("meeting-recording-banner")).toBeTruthy();
    expect(captureSubscription).toHaveBeenCalledTimes(1);
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.coordinator.current()).toBe("recording");
    await act(async () =>
      fireEvent.press(panel.getByRole("button", { name: en.meetingPause })),
    );
    expect(f.capture.getSnapshot().phase).toBe("paused");
    await act(async () =>
      fireEvent.press(panel.getByRole("button", { name: en.meetingResume })),
    );
    const retainedStop = screen
      .UNSAFE_getAllByType(MeetingRecordingControls)
      .at(-1)!.props.control.onStop;
    await act(async () =>
      fireEvent.press(panel.getByRole("button", { name: en.meetingStop })),
    );
    if (failure === "upload") {
      expect(f.stop).toHaveBeenCalledTimes(1);
      expect(f.capture.getSnapshot().phase).toBe("idle");
      expect(f.capture.getSnapshot().entries[0]).toMatchObject({
        state: "captured",
        uploaded: false,
      });
      expect(panel.getByText(en.meeting_connection_failed)).toBeTruthy();
      expect(panel.queryByRole("button", { name: en.meetingStop })).toBeNull();
      fireEvent.press(panel.getByRole("button", { name: en.meetings }));
      expect(screen.getByTestId("meeting-library")).toBeTruthy();
      expect(
        screen.getByRole("tab", { name: "Library" }).props.accessibilityState
          .selected,
      ).toBe(true);
      expect(captureSubscription).toHaveBeenCalledTimes(1);
      expect(f.coordinator.current()).toBeNull();
      expect(session.createMeeting).toHaveBeenCalledTimes(1);
      view.unmount();
      return;
    }
    expect(f.capture.getSnapshot().phase).toBe("recording");
    expect(panel.getByText(en.meeting_stop_failed_live)).toBeTruthy();
    expect(
      panel.getByRole("button", { name: en.meetingStop }).props
        .accessibilityState.disabled,
    ).toBe(false);
    await act(async () =>
      fireEvent.press(panel.getByRole("button", { name: en.meetingStop })),
    );
    expect(f.stop).toHaveBeenCalledTimes(2);
    expect(f.capture.getSnapshot().entries[0]).toMatchObject({
      state: "captured",
      uploaded: true,
    });
    expect(f.coordinator.current()).toBeNull();
    await act(async () => retainedStop());
    expect(f.stop).toHaveBeenCalledTimes(2);
    expect(session.processMeeting).toHaveBeenCalledTimes(1);
    view.unmount();
  },
);

test("an accepted first message keeps edits made while the new chat was being saved", async () => {
  const f = await fixture();
  const snapshot = emptySnapshot();
  let state: SessionState = {
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
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<SessionState>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  let acknowledge!: () => void;
  const creation = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  const session = {
    ...f.session,
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: jest.fn(async () => {}),
    stop: jest.fn(),
    refresh: jest.fn(async () => {}),
    selectConversation: jest.fn(),
    readHumanTasks: jest.fn(async () => ({
      tasks: [],
      next: null,
      counts: { open: 0, done: 0 },
    })),
    readConversation: jest.fn(async (id: string) => ({
      profile: CONVERSATION_HISTORY_PROFILE,
      scope: snapshot.scope,
      conversation: {
        id,
        revision: state.store!.conversations[id]!.revision,
        title: "",
        createdAt: "2026-10-13T00:00:00.000Z",
        updatedAt: "2026-10-13T00:00:00.000Z",
        messageCount: state.store!.conversations[id]!.messages.length,
        readOnly: false,
      },
      messages: state.store!.conversations[id]!.messages,
      nextAfter: null,
    })),
    send: jest.fn((command: SessionCommand) => {
      if (command.type === "conversation.create") {
        publish({
          pending: command,
          commandStates: { [commandTarget(command)]: "sending" },
        });
        return creation;
      }
      if (command.type === "message.send") {
        const store = state.store!;
        const conversation = store.conversations[command.conversationId]!;
        publish({
          commandStates: {
            ...state.commandStates,
            [commandTarget(command)]: "accepted",
          },
          store: {
            ...store,
            conversations: {
              ...store.conversations,
              [conversation.id]: {
                ...conversation,
                revision: conversation.revision + 1,
                messages: [
                  {
                    id: `message-${command.commandId}-user`,
                    role: "user",
                    text: command.text,
                  },
                ],
              },
            },
          },
        });
      }
      return Promise.resolve();
    }),
  } as unknown as ClientSession;
  function Harness() {
    const [section, setSection] = useState<Section>("chat");
    return (
      <Workspace
        session={session}
        language="en"
        section={section}
        setSection={setSection}
        settings={null}
        authError={null}
        spokenReplies={false}
      />
    );
  }
  const view = render(<Harness />);
  fireEvent.press(screen.getByRole("button", { name: "New chat" }));
  fireEvent.changeText(
    screen.getByLabelText(en.composer),
    "TEST original first message",
  );
  fireEvent.press(screen.getByRole("button", { name: en.send }));
  const command = state.pending;
  expect(command?.type).toBe("conversation.create");
  fireEvent.changeText(
    screen.getByLabelText(en.composer),
    "TEST newer unsent edit",
  );
  await act(async () => {
    publish({
      pending: null,
      commandStates: { [commandTarget(command!)]: "accepted" },
      store: {
        ...state.store!,
        conversations: {
          ...state.store!.conversations,
          [command!.conversationId]: {
            id: command!.conversationId,
            revision: 1,
            messages: [],
          },
        },
      },
    });
    acknowledge();
    for (let i = 0; i < 40; i++) await Promise.resolve();
  });
  expect(session.send).toHaveBeenCalledTimes(2);
  expect((session.send as jest.Mock).mock.calls[1]![0].text).toBe(
    "TEST original first message",
  );
  expect(screen.getByLabelText(en.composer).props.value).toBe(
    "TEST newer unsent edit",
  );
  view.unmount();
});
