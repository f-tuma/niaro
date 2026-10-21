import { AppState } from "react-native";
import { createVoiceReply } from "../apps/mobile/VoiceReply";
import { createVoiceCapture } from "../apps/mobile/voice-capture";
import {
  captureProcessAnswerTarget,
  processAnswerCommand,
} from "../packages/client-core/process-answers";
import { fromSnapshot } from "../packages/client-core/store";
import type {
  ClientSession,
  SessionCommand,
  SessionState,
} from "../packages/client-core/session";
import { messageCommand } from "../packages/client-core/commands";
import { emptySnapshot, processTaskQuestion } from "../packages/test-fixtures";
import {
  voiceCapabilities,
  type VoiceTranscript,
  type VoiceRequest,
} from "../packages/protocol/voice";

jest.mock("../apps/mobile/voice-capture", () => ({
  createVoiceCapture: jest.fn(),
}));
jest.mock("../apps/mobile/feedback", () => ({ feedback: () => 0 }));
jest.mock("expo-crypto", () => ({ randomUUID: () => "TEST-voice-command" }));
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
const audio = { mimeType: "audio/wav" as const, base64: "YWJjZA==" };

function fixture() {
  const snapshot = emptySnapshot();
  snapshot.workItems.push(processTaskQuestion());
  const store = fromSnapshot(
    "https://fixture.test/v1/a",
    snapshot.scope,
    snapshot,
  );
  const target = captureProcessAnswerTarget(store, "TEST-process-parent");
  const state: SessionState = {
    answerAttempts: [],
    answerRecoveryBlocked: false,
    processPending: null,
    store,
    status: "online",
    pending: null,
    commandStates: {},
    error: null,
    activity: null,
    activityConnection: "waiting",
  };
  const session = {
    getSnapshot: () => state,
    interruptPending: jest.fn(async () => true),
    voiceCapabilities: jest.fn(async () => voiceCapabilities(true)),
    transcribe: jest.fn(
      async (
        _request: VoiceRequest,
        _signal: AbortSignal,
      ): Promise<VoiceTranscript> => ({
        text: "TEST transcript",
        reviewReasons: ["uncertain"],
      }),
    ),
    send: jest.fn(async (command: SessionCommand) => {
      state.pending = command;
    }),
  };
  const capture = {
    supported: () => true,
    start: jest.fn(async (_signal: AbortSignal) => {}),
    stop: jest.fn(async () => audio),
    discard: jest.fn(async () => {}),
  };
  jest.mocked(createVoiceCapture).mockReturnValue(capture);
  const onSubmitted = jest.fn();
  let current = true;
  const draft = createVoiceReply(
    session as unknown as ClientSession,
    { kind: "process", target },
    "cs",
    onSubmitted,
    () => current,
  );
  return {
    store,
    target,
    state,
    session,
    capture,
    onSubmitted,
    draft,
    retire: () => {
      current = false;
    },
  };
}
beforeEach(() => {
  AppState.currentState = "active";
  jest.clearAllMocks();
});

test("reviewed voice preserves exact edited answer and uses the text factory, never message or approval", async () => {
  const f = fixture();
  try {
    await f.draft.start();
    await f.draft.stop();
    expect(f.session.transcribe.mock.calls[0]?.[0]).toMatchObject({
      context: { conversationId: "conversation-1" },
    });
    expect(f.draft.input).toBeUndefined();
    const answer = '  {"approved":true,"operationId":"TEST-write"}\n';
    f.draft.edit(answer);
    f.draft.submit();
    expect(f.session.send).toHaveBeenCalledWith(
      processAnswerCommand(f.store, f.target, {
        commandId: "TEST-voice-command",
        idempotencyKey: "TEST-voice-command",
        answer,
        language: "cs",
      }),
    );
    expect(f.session.send.mock.calls[0]?.[0]).toMatchObject({
      type: "process.answer",
      expectedWorkRevision: 7,
      answer,
    });
    expect(f.onSubmitted).toHaveBeenCalledTimes(1);
    expect(f.store.operations).toEqual({});
  } finally {
    await f.draft.cancel();
  }
});

test("question changed during capability lookup cannot open the microphone", async () => {
  const f = fixture(),
    capabilities = gate<ReturnType<typeof voiceCapabilities>>();
  f.session.voiceCapabilities.mockReturnValue(capabilities.promise);
  const start = f.draft.start();
  f.store.workItems[
    f.target.workItemId
  ]!.native!.process!.question!.questionId = "TEST-question-B";
  capabilities.resolve(voiceCapabilities(true));
  await start;
  expect(f.capture.start).not.toHaveBeenCalled();
  expect(f.draft.getSnapshot().error).toBe("process_question_changed");
  await f.draft.cancel();
});

test("changed target after stopping capture is rejected before transcription", async () => {
  const f = fixture(),
    stopped = gate<typeof audio>();
  f.capture.stop.mockReturnValue(stopped.promise);
  await f.draft.start();
  const stop = f.draft.stop();
  f.store.stale = true;
  stopped.resolve(audio);
  await stop;
  expect(f.session.transcribe).not.toHaveBeenCalled();
  expect(f.draft.getSnapshot().error).toBe("process_question_changed");
  await f.draft.cancel();
});

test.each([
  "question",
  "tool",
  "child",
  "journal",
  "pin",
  "scope",
  "stale",
  "details",
  "approval",
])("late transcript cannot follow A after %s changes", async (change) => {
  const f = fixture(),
    transcript = gate<VoiceTranscript>();
  f.session.transcribe.mockReturnValue(transcript.promise);
  try {
    await f.draft.start();
    const stop = f.draft.stop();
    await flush();
    expect(f.session.transcribe).toHaveBeenCalledTimes(1);
    const work = f.store.workItems[f.target.workItemId]!,
      process = work.native!.process!;
    switch (change) {
      case "question":
        process.question!.questionId = "TEST-question-B";
        break;
      case "tool":
        process.question!.toolCallId = "TEST-call-B";
        break;
      case "child":
        process.question!.childRunId = "TEST-child-B";
        break;
      case "journal":
        process.journalRevision!++;
        break;
      case "pin":
        process.provenance.artifactDigest = "b".repeat(64);
        break;
      case "scope":
        f.store.scope = { ...f.store.scope, connectionId: "TEST-revoked" };
        break;
      case "stale":
        f.store.stale = true;
        break;
      case "details":
        process.detailsAvailable = false;
        break;
      case "approval":
        work.status = "waiting_approval";
        delete process.question;
        break;
    }
    transcript.resolve({ text: "TEST late A answer", reviewReasons: [] });
    await stop;
    expect(f.session.send).not.toHaveBeenCalled();
    expect(f.onSubmitted).not.toHaveBeenCalled();
    expect(f.draft.getSnapshot().error).toBe("process_question_changed");
  } finally {
    await f.draft.cancel();
  }
});

test("review checks again before send and never recaptures B", async () => {
  const f = fixture();
  await f.draft.start();
  await f.draft.stop();
  f.store.workItems[f.target.workItemId]!.native!.process!.question!
    .questionRevision++;
  f.draft.submit();
  expect(f.session.send).not.toHaveBeenCalled();
  expect(f.draft.getSnapshot()).toMatchObject({
    stage: "review",
    text: "TEST transcript",
    error: "process_question_changed",
  });
  await f.draft.cancel();
});

test("native voice shares the interruption barrier and keeps transcript bound for explicit retry", async () => {
  const f = fixture(),
    interruption = gate<boolean>();
  f.state.pending = messageCommand("TEST old request", "en", "TEST-old");
  f.session.interruptPending.mockReturnValue(interruption.promise);
  f.session.transcribe.mockResolvedValue({
    text: "TEST exact spoken reply",
    reviewReasons: [],
  });
  try {
    await f.draft.start();
    const stop = f.draft.stop();
    await flush();
    expect(f.capture.start).toHaveBeenCalledTimes(1);
    expect(f.session.send).not.toHaveBeenCalled();
    interruption.resolve(false);
    await stop;
    expect(f.draft.getSnapshot()).toMatchObject({
      stage: "review",
      text: "TEST exact spoken reply",
      error: "requestInterruptFailed",
    });
    f.state.pending = null;
    f.draft.submit();
    expect(f.session.send.mock.calls[0]?.[0]).toMatchObject({
      type: "process.answer",
      questionId: "TEST-question-A",
    });
  } finally {
    await f.draft.cancel();
  }
});

test.each(["cancel", "owner", "background"])(
  "%s prevents a late transcript from submitting",
  async (change) => {
    const f = fixture(),
      transcript = gate<VoiceTranscript>();
    f.session.transcribe.mockReturnValue(transcript.promise);
    await f.draft.start();
    const stop = f.draft.stop();
    await flush();
    let cancellation: Promise<void> | undefined;
    if (change === "cancel") cancellation = f.draft.cancel();
    else if (change === "owner") f.retire();
    else AppState.currentState = "background";
    transcript.resolve({ text: "TEST late answer", reviewReasons: [] });
    await stop;
    await cancellation;
    expect(f.session.send).not.toHaveBeenCalled();
    expect(f.onSubmitted).not.toHaveBeenCalled();
    await f.draft.cancel();
  },
);
