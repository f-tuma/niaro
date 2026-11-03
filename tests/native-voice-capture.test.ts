import {
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
} from "expo-audio";
import { AudioRecorder } from "react-native-audio-api";
import {
  createVoiceCapture,
  ensureMicrophone,
} from "../apps/mobile/voice-capture";
import {
  loadMicrophoneHint,
  microphoneGranted,
  recheckMicrophone,
  resetMicrophoneMemory,
} from "../apps/mobile/microphone-permission";

jest.mock("expo-audio", () => ({
  getRecordingPermissionsAsync: jest.fn(),
  requestRecordingPermissionsAsync: jest.fn(),
}));
type Ready = (event: {
  buffer: { sampleRate: number; getChannelData: () => Float32Array };
}) => void;
jest.mock("react-native-audio-api", () => ({
  AudioManager: {
    setAudioSessionOptions: jest.fn(),
    setAudioSessionActivity: jest.fn(async () => {}),
  },
  AudioRecorder: jest.fn().mockImplementation(() => {
    let recording = false;
    const recorder = {
      ready: undefined as Ready | undefined,
      onAudioReady: jest.fn((_options: unknown, callback: Ready) => {
        recorder.ready = callback;
        return { status: "success" };
      }),
      clearOnAudioReady: jest.fn(),
      onError: jest.fn(),
      clearOnError: jest.fn(),
      start: jest.fn(async () => {
        recording = true;
        return { status: "success" };
      }),
      stop: jest.fn(async () => {
        recording = false;
        return { status: "success" };
      }),
      isRecording: () => recording,
    };
    return recorder;
  }),
}));

const permission = (granted: boolean) => ({
  granted,
  status: granted ? "granted" : "denied",
  canAskAgain: true,
  expires: "never",
});
const getPermission = jest.mocked(getRecordingPermissionsAsync);
const requestPermission = jest.mocked(requestRecordingPermissionsAsync);
const Recorder = jest.mocked(AudioRecorder);
const instance = (index: number) =>
  Recorder.mock.results[index]!.value as {
    start: jest.Mock;
    ready?: Ready;
  };
beforeEach(() => {
  jest.clearAllMocks();
  // Every case starts as the first use of this app run.
  resetMicrophoneMemory();
  getPermission.mockResolvedValue(
    permission(true) as Awaited<ReturnType<typeof getPermission>>,
  );
  requestPermission.mockResolvedValue(
    permission(true) as Awaited<ReturnType<typeof requestPermission>>,
  );
});

test("granted access starts and retries without reopening Android's permission activity", async () => {
  const capture = createVoiceCapture();
  // Reproduces Android interrupting the app if permission is requested again.
  const controller = new AbortController();
  requestPermission.mockImplementation(async () => {
    controller.abort();
    return permission(true) as Awaited<ReturnType<typeof requestPermission>>;
  });
  try {
    await capture.start(controller.signal);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(instance(0).start).toHaveBeenCalledTimes(1);
  } finally {
    await capture.discard();
  }
  const retry = createVoiceCapture();
  try {
    await retry.start(new AbortController().signal);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(instance(1).start).toHaveBeenCalledTimes(1);
  } finally {
    await retry.discard();
  }
});

test("denied access never prepares the recorder", async () => {
  getPermission.mockResolvedValue(
    permission(false) as Awaited<ReturnType<typeof getPermission>>,
  );
  requestPermission.mockResolvedValue(
    permission(false) as Awaited<ReturnType<typeof requestPermission>>,
  );
  const capture = createVoiceCapture();
  try {
    await expect(capture.start(new AbortController().signal)).rejects.toThrow(
      "voice_permission",
    );
    expect(Recorder).not.toHaveBeenCalled();
  } finally {
    await capture.discard();
  }
});

test("a late permission grant after backgrounding cannot start recording", async () => {
  getPermission.mockResolvedValue(
    permission(false) as Awaited<ReturnType<typeof getPermission>>,
  );
  const controller = new AbortController();
  requestPermission.mockImplementation(async () => {
    controller.abort();
    return permission(true) as Awaited<ReturnType<typeof requestPermission>>;
  });
  const capture = createVoiceCapture();
  try {
    await expect(capture.start(controller.signal)).rejects.toThrow(
      "voice_permission_ready",
    );
    expect(Recorder).not.toHaveBeenCalled();
  } finally {
    await capture.discard();
  }
});

test("cancelling the permission check prevents even opening a permission prompt", async () => {
  const controller = new AbortController();
  getPermission.mockImplementationOnce(async () => {
    controller.abort();
    return permission(false) as Awaited<ReturnType<typeof getPermission>>;
  });
  const capture = createVoiceCapture();
  try {
    await expect(capture.start(controller.signal)).rejects.toThrow(
      "voice_cancelled",
    );
    expect(requestPermission).not.toHaveBeenCalled();
    expect(Recorder).not.toHaveBeenCalled();
  } finally {
    await capture.discard();
  }
});

test("raw samples give a spectrum and voicing while recording and a 16 kHz WAV after", async () => {
  const capture = createVoiceCapture();
  try {
    await capture.start(new AbortController().signal);
    expect(capture.frame!()).toBeNull();
    // The device delivered 48 kHz instead of the requested 16 kHz.
    const vowel = Float32Array.from({ length: 4800 }, (_, i) => {
      let value = 0;
      for (let h = 1; h < 20; h++)
        value +=
          Math.exp(-(((140 * h - 700) / 200) ** 2)) *
          Math.sin((2 * Math.PI * 140 * h * i) / 48000);
      return 0.2 * value;
    });
    for (let second = 0; second < 5; second++)
      instance(0).ready!({
        buffer: { sampleRate: 48000, getChannelData: () => vowel },
      });
    const frame = capture.frame!()!;
    expect(frame.spectrum).toHaveLength(24);
    expect(frame.voiced).toBeGreaterThan(0.5);
    expect(capture.level!()).toBeCloseTo(frame.level);
    const audio = await capture.stop();
    expect(audio.mimeType).toBe("audio/wav");
    const bytes = Buffer.from(audio.base64, "base64");
    expect(bytes.subarray(0, 4).toString()).toBe("RIFF");
    expect(bytes.readUInt32LE(24)).toBe(16000);
    // 24 000 samples at 48 kHz become 8 000 at 16 kHz.
    expect(bytes.length).toBe(44 + 8000 * 2);
  } finally {
    await capture.discard();
  }
});

// NIAR-283: once granted, a tap starts capture with no permission round trip.
test("granted access is remembered: later starts make no permission call at all", async () => {
  const first = createVoiceCapture();
  try {
    await first.start(new AbortController().signal);
  } finally {
    await first.discard();
  }
  expect(getPermission).toHaveBeenCalledTimes(1);
  expect(microphoneGranted()).toBe(true);
  jest.clearAllMocks();
  for (let tap = 0; tap < 3; tap++) {
    expect(await ensureMicrophone()).toBe(true);
    const capture = createVoiceCapture();
    try {
      await capture.start(new AbortController().signal);
      expect(instance(tap).start).toHaveBeenCalledTimes(1);
    } finally {
      await capture.discard();
    }
  }
  expect(getPermission).not.toHaveBeenCalled();
  expect(requestPermission).not.toHaveBeenCalled();
});

test("the first use still asks before recording, and granting does not cancel the start", async () => {
  getPermission.mockResolvedValue(
    permission(false) as Awaited<ReturnType<typeof getPermission>>,
  );
  expect(await ensureMicrophone()).toBe(true);
  expect(getPermission).toHaveBeenCalledTimes(1);
  expect(requestPermission).toHaveBeenCalledTimes(1);
  expect(Recorder).not.toHaveBeenCalled();
  const capture = createVoiceCapture();
  try {
    await capture.start(new AbortController().signal);
    expect(instance(0).start).toHaveBeenCalledTimes(1);
    expect(requestPermission).toHaveBeenCalledTimes(1);
  } finally {
    await capture.discard();
  }
});

test("a denied first use is not remembered", async () => {
  getPermission.mockResolvedValue(
    permission(false) as Awaited<ReturnType<typeof getPermission>>,
  );
  requestPermission.mockResolvedValue(
    permission(false) as Awaited<ReturnType<typeof requestPermission>>,
  );
  expect(await ensureMicrophone()).toBe(false);
  expect(microphoneGranted()).toBe(false);
  expect(await ensureMicrophone()).toBe(false);
  expect(requestPermission).toHaveBeenCalledTimes(2);
});

test("access revoked in the settings: the recorder fails, the start says voice_permission and the next tap asks again", async () => {
  expect(await ensureMicrophone()).toBe(true);
  jest.clearAllMocks();
  // Revoked meanwhile: the recorder cannot open the microphone.
  getPermission.mockResolvedValue(
    permission(false) as Awaited<ReturnType<typeof getPermission>>,
  );
  Recorder.mockImplementationOnce(
    () =>
      ({
        onAudioReady: jest.fn(),
        clearOnAudioReady: jest.fn(),
        onError: jest.fn(),
        clearOnError: jest.fn(),
        start: jest.fn(async () => ({ status: "error", message: "denied" })),
        stop: jest.fn(async () => ({ status: "success" })),
        isRecording: () => false,
      }) as unknown as AudioRecorder,
  );
  const capture = createVoiceCapture();
  try {
    await expect(capture.start(new AbortController().signal)).rejects.toThrow(
      "voice_permission",
    );
  } finally {
    await capture.discard();
  }
  // Checked without asking; the request flow belongs to the next tap.
  expect(getPermission).toHaveBeenCalledTimes(1);
  expect(requestPermission).not.toHaveBeenCalled();
  expect(microphoneGranted()).toBe(false);
  requestPermission.mockResolvedValue(
    permission(true) as Awaited<ReturnType<typeof requestPermission>>,
  );
  expect(await ensureMicrophone()).toBe(true);
  expect(requestPermission).toHaveBeenCalledTimes(1);
});

test("a recorder failure with access still granted stays a capture failure and keeps the memory", async () => {
  expect(await ensureMicrophone()).toBe(true);
  Recorder.mockImplementationOnce(
    () =>
      ({
        onAudioReady: jest.fn(),
        clearOnAudioReady: jest.fn(),
        onError: jest.fn(),
        clearOnError: jest.fn(),
        start: jest.fn(async () => ({ status: "error", message: "busy" })),
        stop: jest.fn(async () => ({ status: "success" })),
        isRecording: () => false,
      }) as unknown as AudioRecorder,
  );
  const capture = createVoiceCapture();
  try {
    await expect(capture.start(new AbortController().signal)).rejects.toThrow(
      "voice_capture_failed",
    );
  } finally {
    await capture.discard();
  }
  expect(microphoneGranted()).toBe(true);
});

test("a cold start uses the hint an earlier launch left; a revoked access found on return clears it", async () => {
  const saved = new Map<string, string>();
  const store = {
    getItem: async (key: string) => saved.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      saved.set(key, value);
    },
  };
  await loadMicrophoneHint(store);
  expect(microphoneGranted()).toBe(false);
  expect(await ensureMicrophone()).toBe(true);
  await Promise.resolve();
  // The next launch.
  resetMicrophoneMemory();
  jest.clearAllMocks();
  await loadMicrophoneHint(store);
  expect(microphoneGranted()).toBe(true);
  expect(await ensureMicrophone()).toBe(true);
  expect(getPermission).not.toHaveBeenCalled();
  // Back from the system settings with the microphone turned off.
  getPermission.mockResolvedValue(
    permission(false) as Awaited<ReturnType<typeof getPermission>>,
  );
  expect(await recheckMicrophone()).toBe(false);
  await Promise.resolve();
  resetMicrophoneMemory();
  await loadMicrophoneHint(store);
  expect(microphoneGranted()).toBe(false);
});
