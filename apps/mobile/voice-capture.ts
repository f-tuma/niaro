import { Platform } from "react-native";
import {
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
} from "expo-audio";
import { AudioManager, AudioRecorder } from "react-native-audio-api";
import type { VoiceCapture } from "../../packages/client-core/voice";
import { VOICE_BYTES, VOICE_SECONDS } from "../../packages/protocol/voice";
import {
  analyseFrame,
  encodeWav,
  resample,
  SampleWindow,
  type VoiceFrame,
} from "../../packages/audio/analysis";
import { audioSession as coordinator } from "./audio-session";

/** What the server transcribes; also keeps two minutes well under the upload limit. */
const SPEECH_RATE = 16000;
/** ~64 ms at 16 kHz: long enough for formants, short enough to follow syllables. */
const FRAME = 1024;

function base64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Raw microphone samples feed the spectrum, voicing and a WAV upload. Nothing is
 * written to disk and nothing is analysed outside an active recording. */
export function createVoiceCapture(): VoiceCapture {
  let recorder: AudioRecorder | undefined;
  let owned = false;
  let chunks: Float32Array[] = [];
  let collected = 0;
  let rate = SPEECH_RATE;
  let window = new SampleWindow(FRAME);
  let latest: VoiceFrame | null = null;
  let dirty = false;
  const release = async () => {
    const current = recorder;
    recorder = undefined;
    if (current) {
      current.clearOnAudioReady();
      current.clearOnError();
      if (current.isRecording()) await current.stop().catch(() => undefined);
    }
    chunks = [];
    collected = 0;
    latest = null;
    window = new SampleWindow(FRAME);
    if (owned) {
      try {
        if (Platform.OS === "ios")
          await AudioManager.setAudioSessionActivity(false).catch(() => {});
      } finally {
        coordinator.release("voice");
        owned = false;
      }
    }
  };
  return {
    supported: () => true,
    async start(signal) {
      coordinator.acquire("voice");
      owned = true;
      if (signal.aborted) throw new Error("voice_cancelled");
      let permission = await getRecordingPermissionsAsync();
      if (signal.aborted) throw new Error("voice_cancelled");
      // Even an already-granted Android request can open a permission activity
      // and interrupt capture. Only request access when it is actually missing.
      const requested = !permission.granted;
      if (requested) permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) throw new Error("voice_permission");
      // Android's system permission activity can background this app. A granted
      // late permission never starts capture; the user must press Record again.
      if (signal.aborted)
        throw new Error(
          requested ? "voice_permission_ready" : "voice_cancelled",
        );
      if (Platform.OS === "ios") {
        AudioManager.setAudioSessionOptions({
          iosCategory: "playAndRecord",
          iosMode: "spokenAudio",
          iosOptions: ["defaultToSpeaker", "allowBluetoothHFP"],
        });
        await AudioManager.setAudioSessionActivity(true);
      }
      if (signal.aborted) throw new Error("voice_cancelled");
      const next = new AudioRecorder();
      recorder = next;
      const limit = VOICE_SECONDS * 48000;
      next.onAudioReady(
        { sampleRate: SPEECH_RATE, bufferLength: FRAME, channelCount: 1 },
        ({ buffer }) => {
          if (recorder !== next) return;
          rate = buffer.sampleRate;
          // The native buffer is reused for the next callback; keep a copy.
          const samples = Float32Array.from(buffer.getChannelData(0));
          if (collected < limit) {
            chunks.push(samples);
            collected += samples.length;
          }
          window.push(samples);
          dirty = true;
        },
      );
      next.onError(() => {
        if (recorder === next) latest = null;
      });
      const started = await next.start();
      if (started.status !== "success") throw new Error("voice_capture_failed");
      if (signal.aborted) throw new Error("voice_cancelled");
    },
    frame() {
      if (!recorder) return null;
      if (dirty) {
        const frame = window.frame();
        latest = frame ? analyseFrame(frame, rate) : null;
        dirty = false;
      }
      return latest;
    },
    level() {
      return this.frame?.()?.level ?? null;
    },
    async stop() {
      const current = recorder;
      if (!current) throw new Error("voice_capture_failed");
      current.clearOnAudioReady();
      await current.stop();
      const joined = new Float32Array(collected);
      let at = 0;
      for (const chunk of chunks) {
        joined.set(chunk.subarray(0, joined.length - at), at);
        at += chunk.length;
      }
      const wav = encodeWav(resample(joined, rate, SPEECH_RATE), SPEECH_RATE);
      if (joined.length < SPEECH_RATE / 10 || wav.length > VOICE_BYTES)
        throw new Error("voice_capture_failed");
      return { mimeType: "audio/wav", base64: base64(wav) };
    },
    discard: release,
  };
}
