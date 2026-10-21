import { AppState } from "react-native";
import { createVoiceReply } from "../apps/mobile/VoiceReply";
import { createVoiceCapture } from "../apps/mobile/voice-capture";
import type {
  ClientSession,
  SessionState,
} from "../packages/client-core/session";
import { messageCommand } from "../packages/client-core/commands";
import { voiceCapabilities } from "../packages/protocol/voice";
import type { Command } from "../packages/protocol";

jest.mock("../apps/mobile/voice-capture", () => ({
  createVoiceCapture: jest.fn(),
}));
jest.mock("../apps/mobile/feedback", () => ({ feedback: () => 0 }));
jest.mock("expo-crypto", () => ({ randomUUID: () => "new-voice-command" }));
jest.mock("../packages/ui-catalog/VoiceComposer", () => ({
  VoiceComposer: () => null,
}));

const gate = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function fixture() {
  const pending = messageCommand("Old request", "en", "old-command");
  const state: SessionState = {
    answerAttempts: [],
    answerRecoveryBlocked: false,
    processPending: null,
    store: null,
    status: "online",
    pending,
    commandStates: { chat: "sending" },
    error: null,
    activity: null,
    activityConnection: "waiting",
  };
  const interruption = gate<boolean>();
  const session = {
    getSnapshot: () => state,
    interruptPending: jest.fn(() => interruption.promise),
    voiceCapabilities: jest.fn(async () => voiceCapabilities(true)),
    transcribe: jest.fn(async () => ({
      text: "New spoken request",
      reviewReasons: [],
    })),
    send: jest.fn(async (command: Command) => {
      state.pending = command;
    }),
  };
  const capture = {
    supported: () => true,
    start: jest.fn(async (_signal: AbortSignal) => {}),
    stop: jest.fn(async () => ({
      mimeType: "audio/wav" as const,
      base64: "YWJjZA==",
    })),
    discard: jest.fn(async () => {}),
  };
  jest.mocked(createVoiceCapture).mockReturnValue(capture);
  const onSubmitted = jest.fn();
  const draft = createVoiceReply(
    session as unknown as ClientSession,
    undefined,
    "en",
    onSubmitted,
  );
  return { draft, state, session, capture, interruption, onSubmitted };
}
beforeEach(() => {
  AppState.currentState = "active";
  jest.clearAllMocks();
});

test("capture starts while interruption is pending, but automatic submission waits for retirement", async () => {
  const f = fixture();
  try {
    await f.draft.start();
    expect(f.capture.start).toHaveBeenCalledTimes(1);
    expect(f.session.interruptPending).toHaveBeenCalledTimes(1);
    expect(f.draft.getSnapshot().stage).toBe("recording");
    const stop = f.draft.stop();
    await flush();
    expect(f.session.transcribe).toHaveBeenCalledTimes(1);
    expect(f.session.send).not.toHaveBeenCalled();
    expect(f.draft.getSnapshot().stage).toBe("transcribing");
    f.state.pending = null;
    f.interruption.resolve(true);
    await stop;
    expect(f.session.send).toHaveBeenCalledTimes(1);
    expect(f.onSubmitted).toHaveBeenCalledTimes(1);
    expect(f.draft.getSnapshot().stage).toBe("submitted");
  } finally {
    await f.draft.cancel();
  }
});

test("unconfirmed interruption preserves the transcript as a draft for later explicit submission", async () => {
  const f = fixture();
  try {
    await f.draft.start();
    const stop = f.draft.stop();
    f.interruption.resolve(false);
    await stop;
    expect(f.draft.getSnapshot()).toMatchObject({
      stage: "review",
      text: "New spoken request",
      error: "requestInterruptFailed",
    });
    expect(f.session.send).not.toHaveBeenCalled();
    expect(f.onSubmitted).not.toHaveBeenCalled();
    f.state.pending = null;
    f.draft.submit();
    expect(f.session.send).toHaveBeenCalledTimes(1);
    expect(f.draft.getSnapshot().stage).toBe("submitted");
  } finally {
    await f.draft.cancel();
  }
});

test("a failed interruption cannot auto-send after the old pending request disappears", async () => {
  const f = fixture();
  const transcription = gate<{
    text: string;
    reviewReasons: [];
  }>();
  f.session.transcribe.mockReturnValue(transcription.promise);
  try {
    await f.draft.start();
    const stop = f.draft.stop();
    await flush();
    expect(f.session.transcribe).toHaveBeenCalledTimes(1);

    f.interruption.resolve(false);
    await flush();
    f.state.pending = null;
    transcription.resolve({ text: "New spoken request", reviewReasons: [] });
    await stop;

    expect(f.session.send).not.toHaveBeenCalled();
    expect(f.onSubmitted).not.toHaveBeenCalled();
    expect(f.draft.getSnapshot()).toMatchObject({
      stage: "review",
      text: "New spoken request",
      error: "requestInterruptFailed",
    });
  } finally {
    await f.draft.cancel();
  }
});

test("duplicate recording starts request a single interruption and capture", async () => {
  const f = fixture();
  try {
    const first = f.draft.start();
    expect(f.draft.start()).toBe(first);
    await first;
    expect(f.session.interruptPending).toHaveBeenCalledTimes(1);
    expect(f.capture.start).toHaveBeenCalledTimes(1);
    f.interruption.resolve(false);
  } finally {
    await f.draft.cancel();
  }
});

test("recording retry after permission recovery also interrupts the current command", async () => {
  const f = fixture();
  try {
    f.capture.start.mockRejectedValueOnce(new Error("voice_permission_ready"));
    await f.draft.start();
    expect(f.draft.getSnapshot().stage).toBe("idle");
    await f.draft.start();
    expect(f.session.interruptPending).toHaveBeenCalledTimes(2);
    expect(f.capture.start).toHaveBeenCalledTimes(2);
    expect(f.draft.getSnapshot().stage).toBe("recording");
    f.interruption.resolve(false);
  } finally {
    await f.draft.cancel();
  }
});
