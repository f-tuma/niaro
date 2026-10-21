import { createSpeechPlayback } from "../apps/mobile/speech-playback.web";
import { audioSession } from "../apps/mobile/audio-session";

test("late failure of stopped web playback cannot stop its replacement", async () => {
  const oldAudio = global.Audio,
    oldCreate = URL.createObjectURL,
    oldRevoke = URL.revokeObjectURL;
  let rejectFirst!: (error: Error) => void;
  const instances: {
    pause: jest.Mock;
    play: jest.Mock;
    onended?: () => void;
  }[] = [];
  global.Audio = jest.fn(() => {
    const first = instances.length === 0;
    const value = {
      pause: jest.fn(),
      play: jest.fn(() =>
        first
          ? new Promise<void>((_r, reject) => {
              rejectFirst = reject;
            })
          : Promise.resolve(),
      ),
      removeAttribute: jest.fn(),
      load: jest.fn(),
    };
    instances.push(value);
    return value;
  }) as unknown as typeof Audio;
  URL.createObjectURL = jest.fn(() => "blob:test");
  URL.revokeObjectURL = jest.fn();
  const adapter = createSpeechPlayback();
  try {
    const audio = { mimeType: "audio/wav" as const, base64: "AAAA" };
    const first = adapter
      .start(
        audio,
        new AbortController().signal,
        () => {},
        () => {},
      )
      .catch(() => {});
    adapter.stop();
    await adapter.start(
      audio,
      new AbortController().signal,
      () => {},
      () => {},
    );
    rejectFirst(new Error("late rejection"));
    await first;
    expect(instances[1]!.pause).not.toHaveBeenCalled();
    expect(audioSession.current()).toBe("playback");
  } finally {
    adapter.stop();
    global.Audio = oldAudio;
    URL.createObjectURL = oldCreate;
    URL.revokeObjectURL = oldRevoke;
  }
  expect(audioSession.current()).toBe(null);
});
