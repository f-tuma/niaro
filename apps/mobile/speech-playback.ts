import {
  createAudioPlayer,
  setAudioModeAsync,
  type AudioPlayer,
} from "expo-audio";
import { File, Paths } from "expo-file-system";
import { randomUUID } from "expo-crypto";
import type { SpeechPlayback } from "../../packages/client-core/speech";
import { audioSession } from "./audio-session";
export function createSpeechPlayback(): SpeechPlayback {
  let player: AudioPlayer | undefined;
  let file: File | undefined;
  let subscription: { remove(): void } | undefined;
  let owned = false;
  let generation = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let cancelStart: (() => void) | undefined;
  let removeAbortListener: (() => void) | undefined;
  const stop = () => {
    generation++;
    clearTimeout(timeout);
    removeAbortListener?.();
    removeAbortListener = undefined;
    const cancel = cancelStart;
    cancelStart = undefined;
    cancel?.();
    subscription?.remove();
    subscription = undefined;
    player?.remove();
    player = undefined;
    if (file?.exists) file.delete();
    file = undefined;
    if (owned) audioSession.release("playback");
    owned = false;
  };
  return {
    stop,
    async start(audio, signal, ended, failed) {
      const checkActive = () => {
        // React Native's AbortSignal does not implement throwIfAborted.
        if (signal.aborted || current !== generation) {
          const error = new Error("speech_cancelled");
          error.name = "AbortError";
          throw error;
        }
      };
      const current = generation;
      checkActive();
      audioSession.acquire("playback");
      owned = true;
      const onAbort = () => {
        if (current === generation) stop();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      try {
        await setAudioModeAsync({
          allowsRecording: false,
          playsInSilentMode: true,
          shouldPlayInBackground: false,
        });
        checkActive();
        file = new File(
          Paths.cache,
          `speech-${randomUUID()}.${audio.mimeType === "audio/wav" ? "wav" : "mp3"}`,
        );
        file.write(audio.base64, { encoding: "base64" });
        player = createAudioPlayer(file.uri, { updateInterval: 100 });
        const started = new Promise<void>((resolve, reject) => {
          let playing = false;
          cancelStart = () => {
            const error = new Error("speech_cancelled");
            error.name = "AbortError";
            reject(error);
          };
          timeout = setTimeout(() => {
            if (current === generation && !signal.aborted)
              reject(new Error("speech_playback_failed"));
          }, 10000);
          subscription = player!.addListener(
            "playbackStatusUpdate",
            (status) => {
              if (current !== generation || signal.aborted) return;
              if (status.error) {
                if (playing) failed();
                else reject(new Error("speech_playback_failed"));
              } else if (status.didJustFinish) {
                cancelStart = undefined;
                clearTimeout(timeout);
                resolve();
                ended();
              } else if (!playing && status.isLoaded && status.playing) {
                playing = true;
                cancelStart = undefined;
                clearTimeout(timeout);
                timeout = setTimeout(() => {
                  if (current === generation && !signal.aborted) failed();
                }, 150000);
                resolve();
              }
            },
          );
          player!.play();
        });
        await started;
      } catch (error) {
        if (current === generation) stop();
        throw error;
      }
    },
  };
}
