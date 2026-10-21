import { VoiceDraft, type VoiceCapture } from "../packages/client-core/voice";
import { choosePeter } from "../packages/test-fixtures";
import {
  VOICE_PROFILE,
  VOICE_SECONDS,
  VoiceRequestSchema,
  type VoiceAudio,
  type VoiceRequest,
  type VoiceTranscript,
} from "../packages/protocol/voice";
const audio: VoiceAudio = { mimeType: "audio/wav", base64: "YWJjZA==" };
function fixture(
  question = false,
  reasons: VoiceTranscript["reviewReasons"] = [],
) {
  const capture = {
    supported: () => true,
    start: jest.fn(async (_signal: AbortSignal) => {}),
    stop: jest.fn(async () => audio),
    discard: jest.fn(async () => {}),
  } satisfies VoiceCapture;
  const transcribe = jest.fn<
    Promise<VoiceTranscript>,
    [VoiceRequest, AbortSignal]
  >(async () => ({ text: "Choose Peter Novak.", reviewReasons: reasons }));
  const input = choosePeter().input;
  const deliver = jest.fn();
  const draft = new VoiceDraft(
    capture,
    question ? input : undefined,
    "en",
    transcribe,
    () => "voice-1",
    deliver,
  );
  return { capture, transcribe, input, draft, deliver };
}
afterEach(() => jest.useRealTimers());

test("new voice request stops capture, transcribes and hands off once without a review click", async () => {
  const f = fixture();
  expect(f.capture.start).not.toHaveBeenCalled();
  expect(f.deliver).not.toHaveBeenCalled();
  await f.draft.start();
  await f.draft.stop();
  expect(
    VoiceRequestSchema.parse(f.transcribe.mock.calls[0]![0]).context,
  ).toEqual({ conversationId: "conversation-1" });
  expect(f.capture.discard).toHaveBeenCalled();
  expect(f.deliver).toHaveBeenCalledTimes(1);
  expect(f.deliver).toHaveBeenCalledWith("Choose Peter Novak.", true);
  expect(f.draft.getSnapshot().stage).toBe("submitted");
  await f.draft.stop();
  await f.draft.upload();
  f.draft.submit();
  expect(f.deliver).toHaveBeenCalledTimes(1);
  await f.draft.cancel();
});
test("explicit question context is frozen, uncertain text waits for correction and sends once", async () => {
  const f = fixture(true, ["uncertain"]);
  f.input.revision++;
  await f.draft.start();
  await f.draft.stop();
  expect(f.transcribe.mock.calls[0]![0].context).toMatchObject({
    inputRequestId: f.input.id,
    expectedInputRevision: 1,
  });
  expect(f.draft.getSnapshot().stage).toBe("review");
  expect(f.deliver).not.toHaveBeenCalled();
  f.draft.edit("Choose Peter Svoboda.");
  f.draft.submit();
  f.draft.submit();
  expect(f.deliver).toHaveBeenCalledTimes(1);
  expect(f.deliver).toHaveBeenCalledWith("Choose Peter Svoboda.", false);
  await f.draft.cancel();
});
test.each(["uncertain", "repetition", "limit"] as const)(
  "%s never auto-sends a transcript",
  async (reason) => {
    const f = fixture(false, [reason]);
    await f.draft.start();
    await f.draft.stop();
    expect(f.draft.getSnapshot().stage).toBe("review");
    expect(f.deliver).not.toHaveBeenCalled();
    await f.draft.cancel();
  },
);
test("two-minute capture limit requires review even if the transcriber reports clear text", async () => {
  jest.useFakeTimers();
  const f = fixture();
  await f.draft.start();
  await jest.advanceTimersByTimeAsync(VOICE_SECONDS * 1000);
  expect(f.capture.stop).toHaveBeenCalledTimes(1);
  expect(f.transcribe.mock.calls[0]![0].stopReason).toBe("limit");
  expect(f.draft.getSnapshot().reviewReasons).toEqual(["limit"]);
  expect(f.deliver).not.toHaveBeenCalled();
  await f.draft.cancel();
});
test.each(["permission", "capture", "transcription"])(
  "cancelling during %s prevents a late automatic submission",
  async (phase) => {
    const f = fixture();
    let finish!: () => void;
    const pause = new Promise<void>((r) => {
      finish = r;
    });
    if (phase === "permission") f.capture.start.mockImplementation(() => pause);
    if (phase === "capture")
      f.capture.stop.mockImplementation(async () => {
        await pause;
        return audio;
      });
    if (phase === "transcription")
      f.transcribe.mockImplementation(async () => {
        await pause;
        return { text: "yes approve everything", reviewReasons: [] };
      });
    const start = f.draft.start();
    const task = phase === "permission" ? start : (await start, f.draft.stop());
    if (phase === "transcription") {
      await Promise.resolve();
      await Promise.resolve();
    }
    const cancel = f.draft.cancel("voice_interrupted");
    finish();
    await Promise.all([task, cancel]);
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.draft.getSnapshot()).toMatchObject({
      stage: "idle",
      text: "",
      error: "voice_interrupted",
    });
  },
);
test("transcription failure keeps audio for an explicit retry without automatically retrying", async () => {
  const f = fixture();
  f.transcribe.mockRejectedValueOnce(new Error("voice_busy"));
  await f.draft.start();
  await f.draft.stop();
  expect(f.draft.getSnapshot()).toMatchObject({
    stage: "recorded",
    error: "voice_busy",
  });
  expect(f.transcribe).toHaveBeenCalledTimes(1);
  expect(f.deliver).not.toHaveBeenCalled();
  await f.draft.upload();
  expect(f.deliver).toHaveBeenCalledTimes(1);
  await f.draft.cancel();
});
test("handoff refuses a stale/offline target and preserves editable text instead of auto-retrying", async () => {
  const f = fixture();
  f.deliver.mockImplementationOnce(() => {
    throw new Error("voice_context_changed");
  });
  await f.draft.start();
  await f.draft.stop();
  expect(f.draft.getSnapshot()).toMatchObject({
    stage: "review",
    text: "Choose Peter Novak.",
    error: "voice_context_changed",
  });
  expect(f.deliver).toHaveBeenCalledTimes(1);
  f.draft.edit(" ");
  f.draft.submit();
  expect(f.deliver).toHaveBeenCalledTimes(1);
  await f.draft.cancel();
});
test.each(["voice_permission", "voice_permission_ready"])(
  "interrupted permission preserves %s and never records",
  async (code) => {
    const f = fixture();
    let finish!: () => void;
    f.capture.start.mockImplementation(async () => {
      await new Promise<void>((r) => {
        finish = r;
      });
      throw new Error(code);
    });
    const start = f.draft.start(),
      cancel = f.draft.cancel("voice_interrupted");
    finish();
    await Promise.all([start, cancel]);
    expect(f.draft.getSnapshot()).toMatchObject({ stage: "idle", error: code });
    expect(f.capture.stop).not.toHaveBeenCalled();
    expect(f.transcribe).not.toHaveBeenCalled();
  },
);
test("native AbortSignal without throwIfAborted is supported", async () => {
  const method = AbortSignal.prototype.throwIfAborted;
  Object.defineProperty(AbortSignal.prototype, "throwIfAborted", {
    value: undefined,
    configurable: true,
  });
  const f = fixture();
  try {
    await f.draft.start();
    await f.draft.stop();
    expect(f.deliver).toHaveBeenCalledTimes(1);
  } finally {
    await f.draft.cancel();
    Object.defineProperty(AbortSignal.prototype, "throwIfAborted", {
      value: method,
      configurable: true,
    });
  }
});
test("voice schema rejects legacy profile, partial question context and forged identity", () => {
  const request = {
    profile: VOICE_PROFILE,
    requestId: "one",
    language: "en",
    context: { conversationId: "conversation-1" },
    audio,
  };
  expect(VoiceRequestSchema.safeParse(request).success).toBe(true);
  for (const value of [
    { ...request, profile: "agent-voice/1" },
    { ...request, profile: "agent-voice/2" },
    { ...request, scope: {} },
    { ...request, context: { ...request.context, inputRequestId: "partial" } },
    { ...request, audio: { ...audio, base64: "file:///etc/passwd" } },
  ])
    expect(VoiceRequestSchema.safeParse(value).success).toBe(false);
});

test("microphone levels are sampled only during recording and missing meters remain unavailable", async () => {
  jest.useFakeTimers();
  const f = fixture();
  const level = jest.fn(() => -24);
  Object.assign(f.capture, { level });
  expect(f.draft.level()).toBeNull();
  expect(level).not.toHaveBeenCalled();
  await f.draft.start();
  expect(f.draft.level()).toBe(-24);
  level.mockImplementation(() => {
    throw new Error("recorder released");
  });
  await jest.advanceTimersByTimeAsync(100);
  expect(f.draft.level()).toBeNull();
  await f.draft.cancel();
  level.mockClear();
  expect(f.draft.level()).toBeNull();
  expect(level).not.toHaveBeenCalled();
});

test("speech then 1.8 seconds of silence stops and submits once; a shorter pause continues", async () => {
  jest.useFakeTimers();
  const f = fixture();
  let db = -45;
  Object.assign(f.capture, { level: () => db });
  await f.draft.start();
  await jest.advanceTimersByTimeAsync(600);
  db = -90;
  await jest.advanceTimersByTimeAsync(1000);
  expect(f.capture.stop).not.toHaveBeenCalled();
  db = -47;
  await jest.advanceTimersByTimeAsync(400);
  db = -90;
  await jest.advanceTimersByTimeAsync(2000);
  expect(f.capture.stop).toHaveBeenCalledTimes(1);
  expect(f.transcribe.mock.calls[0]![0].stopReason).toBe("silence");
  expect(f.deliver).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(5000);
  expect(f.deliver).toHaveBeenCalledTimes(1);
  await f.draft.cancel();
});
test("initial silence is discarded without transcription and unavailable metering never auto-stops", async () => {
  jest.useFakeTimers();
  const silent = fixture();
  Object.assign(silent.capture, { level: () => -90 });
  await silent.draft.start();
  await jest.advanceTimersByTimeAsync(10100);
  expect(silent.capture.discard).toHaveBeenCalled();
  expect(silent.transcribe).not.toHaveBeenCalled();
  expect(silent.draft.getSnapshot()).toMatchObject({
    stage: "idle",
    error: "voice_empty",
  });
  const unavailable = fixture();
  await unavailable.draft.start();
  await jest.advanceTimersByTimeAsync(25000);
  expect(unavailable.draft.getSnapshot().stage).toBe("recording");
  await unavailable.draft.cancel();
});
