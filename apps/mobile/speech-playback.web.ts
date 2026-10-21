import type { SpeechPlayback } from "../../packages/client-core/speech";
import { audioSession } from "./audio-session";
export function createSpeechPlayback(): SpeechPlayback {
  let player: HTMLAudioElement | undefined;
  let url: string | undefined;
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
    if (player) {
      player.onended = null;
      player.onerror = null;
      player.pause();
      player.removeAttribute("src");
      player.load();
      player = undefined;
    }
    if (url) URL.revokeObjectURL(url);
    url = undefined;
    if (owned) audioSession.release("playback");
    owned = false;
  };
  return {
    stop,
    async start(audio, signal, ended, failed) {
      signal.throwIfAborted();
      audioSession.acquire("playback");
      owned = true;
      const current = ++generation;
      const onAbort = () => {
        if (current === generation) stop();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      try {
        const bytes = Uint8Array.from(atob(audio.base64), (char) =>
          char.charCodeAt(0),
        );
        url = URL.createObjectURL(new Blob([bytes], { type: audio.mimeType }));
        player = new Audio(url);
        const active = () => current === generation && !signal.aborted;
        player.onended = () => {
          if (active()) ended();
        };
        player.onerror = () => {
          if (active()) failed();
        };
        await Promise.race([
          player.play(),
          new Promise<void>((_resolve, reject) => {
            cancelStart = () => {
              const error = new Error("speech_cancelled");
              error.name = "AbortError";
              reject(error);
            };
            timeout = setTimeout(
              () => reject(new Error("speech_playback_failed")),
              10000,
            );
          }),
        ]);
        if (!active()) throw new Error("speech_cancelled");
        cancelStart = undefined;
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          if (active()) failed();
        }, 150000);
      } catch (error) {
        if (current === generation) stop();
        throw error;
      }
    },
  };
}
