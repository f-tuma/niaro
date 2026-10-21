import { AbortController as NativeAbortController } from "abort-controller";
import { createAudioPlayer, setAudioModeAsync } from "expo-audio";
import { File } from "expo-file-system";
import { createSpeechPlayback } from "../apps/mobile/speech-playback";
import { audioSession } from "../apps/mobile/audio-session";

jest.mock("expo-audio", () => ({
  createAudioPlayer: jest.fn(() => ({
    play: jest.fn(),
    remove: jest.fn(),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
  })),
  setAudioModeAsync: jest.fn(async () => {}),
}));
jest.mock("expo-file-system", () => ({
  Paths: { cache: "cache" },
  File: jest.fn(() => ({
    uri: "file:///cache/speech.wav",
    exists: true,
    write: jest.fn(),
    delete: jest.fn(),
  })),
}));
const signal = () =>
  new NativeAbortController().signal as unknown as AbortSignal;
const audio = { mimeType: "audio/wav" as const, base64: "AAAA" };
beforeEach(() => {
  jest.clearAllMocks();
});

test("native AbortSignal can play; stopping releases audio and its temporary file", async () => {
  const playback = createSpeechPlayback();
  const ended = jest.fn(),
    failed = jest.fn();
  try {
    expect(signal().throwIfAborted).toBeUndefined();
    const started = jest.fn();
    const pending = playback
      .start(audio, signal(), ended, failed)
      .then(started);
    await Promise.resolve();
    const player = jest.mocked(createAudioPlayer).mock.results[0]!.value;
    expect(player.play).toHaveBeenCalledTimes(1);
    expect(audioSession.current()).toBe("playback");
    const event = player.addListener.mock.calls[0][1];
    event({ isLoaded: false, playing: true });
    await Promise.resolve();
    expect(started).not.toHaveBeenCalled();
    event({ isLoaded: true, playing: false });
    await Promise.resolve();
    expect(started).not.toHaveBeenCalled();
    event({ isLoaded: true, playing: true });
    await pending;
    expect(started).toHaveBeenCalledTimes(1);
    playback.stop();
    event({ didJustFinish: true });
    expect(ended).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    expect(player.remove).toHaveBeenCalledTimes(1);
    expect(
      jest.mocked(File).mock.results[0]!.value.delete,
    ).toHaveBeenCalledTimes(1);
    expect(audioSession.current()).toBeNull();
  } finally {
    playback.stop();
  }
});

test("a stopped native setup cannot restart or release a replacement playback", async () => {
  let finish!: () => void;
  jest.mocked(setAudioModeAsync).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const playback = createSpeechPlayback();
  const pending = playback.start(audio, signal(), jest.fn(), jest.fn());
  const rejected = expect(pending).rejects.toThrow("speech_cancelled");
  try {
    playback.stop();
    const next = playback.start(audio, signal(), jest.fn(), jest.fn());
    await Promise.resolve();
    const replacement = jest.mocked(createAudioPlayer).mock.results[0]!.value;
    replacement.addListener.mock.calls[0][1]({ isLoaded: true, playing: true });
    await next;
    finish();
    await rejected;
    expect(createAudioPlayer).toHaveBeenCalledTimes(1);
    expect(replacement.remove).not.toHaveBeenCalled();
    expect(audioSession.current()).toBe("playback");
  } finally {
    playback.stop();
  }
});

test("already cancelled native requests never acquire audio", async () => {
  const controller = new NativeAbortController();
  controller.abort();
  const playback = createSpeechPlayback();
  await expect(
    playback.start(
      audio,
      controller.signal as unknown as AbortSignal,
      jest.fn(),
      jest.fn(),
    ),
  ).rejects.toThrow("speech_cancelled");
  expect(audioSession.current()).toBeNull();
  expect(setAudioModeAsync).not.toHaveBeenCalled();
});

test("aborting while native media loads settles startup and releases its file", async () => {
  const controller = new NativeAbortController();
  const playback = createSpeechPlayback();
  const pending = playback.start(
    audio,
    controller.signal as unknown as AbortSignal,
    jest.fn(),
    jest.fn(),
  );
  const cancelled = expect(pending).rejects.toThrow("speech_cancelled");
  await Promise.resolve();
  const player = jest.mocked(createAudioPlayer).mock.results[0]!.value;
  controller.abort();
  await cancelled;
  expect(player.remove).toHaveBeenCalledTimes(1);
  expect(jest.mocked(File).mock.results[0]!.value.delete).toHaveBeenCalledTimes(
    1,
  );
  expect(audioSession.current()).toBeNull();
});

test("failed native loading never reports startup and releases playback ownership", async () => {
  const playback = createSpeechPlayback();
  const pending = playback.start(audio, signal(), jest.fn(), jest.fn());
  const failed = expect(pending).rejects.toThrow("speech_playback_failed");
  await Promise.resolve();
  const player = jest.mocked(createAudioPlayer).mock.results[0]!.value;
  player.addListener.mock.calls[0][1]({ error: "TEST load error" });
  await failed;
  expect(player.remove).toHaveBeenCalledTimes(1);
  expect(audioSession.current()).toBeNull();
});

test("a synchronous native play failure settles startup without an orphan rejection", async () => {
  const implementation = jest
    .mocked(createAudioPlayer)
    .getMockImplementation()!;
  jest.mocked(createAudioPlayer).mockImplementationOnce((...args) => {
    const player = implementation(...args);
    jest.spyOn(player, "play").mockImplementation(() => {
      throw new Error("TEST native play failure");
    });
    return player;
  });
  const playback = createSpeechPlayback();
  await expect(
    playback.start(audio, signal(), jest.fn(), jest.fn()),
  ).rejects.toThrow("TEST native play failure");
  expect(audioSession.current()).toBeNull();
});

test("native media that never loads has a bounded startup and frees its resources", async () => {
  jest.useFakeTimers();
  const playback = createSpeechPlayback();
  const pending = playback.start(audio, signal(), jest.fn(), jest.fn());
  const failed = expect(pending).rejects.toThrow("speech_playback_failed");
  try {
    await Promise.resolve();
    jest.advanceTimersByTime(10000);
    await failed;
    expect(audioSession.current()).toBeNull();
  } finally {
    playback.stop();
    jest.useRealTimers();
  }
});
