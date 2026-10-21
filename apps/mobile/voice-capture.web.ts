import type { VoiceCapture } from "../../packages/client-core/voice";
import { VOICE_BYTES, type VoiceAudio } from "../../packages/protocol/voice";
import { audioSession as coordinator } from "./audio-session";
import { speechBands } from "../../packages/audio/spectrum";
import { analyseFrame } from "../../packages/audio/analysis";
export function createVoiceCapture(): VoiceCapture {
  let stream: MediaStream | undefined;
  let recorder: MediaRecorder | undefined;
  let owned = false;
  let chunks: Blob[] = [];
  let completion: Promise<void> | undefined;
  let failed = false;
  let audioContext: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let analyser: AnalyserNode | undefined;
  let frequencies: Float32Array<ArrayBuffer> | undefined;
  let samples: Float32Array<ArrayBuffer> | undefined;
  const discard = async () => {
    if (recorder && recorder.state !== "inactive") recorder.stop();
    stream?.getTracks().forEach((track) => track.stop());
    source?.disconnect();
    analyser?.disconnect();
    await audioContext?.close().catch(() => {});
    audioContext = undefined;
    source = undefined;
    analyser = undefined;
    samples = undefined;
    frequencies = undefined;
    if (completion) await completion;
    recorder = undefined;
    stream = undefined;
    chunks = [];
    completion = undefined;
    if (owned) coordinator.release("voice");
    owned = false;
  };
  return {
    supported: () =>
      typeof navigator !== "undefined" &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof MediaRecorder !== "undefined" &&
      MediaRecorder.isTypeSupported("audio/webm"),
    async start(signal) {
      coordinator.acquire("voice");
      owned = true;
      failed = false;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        throw new Error("voice_permission");
      }
      if (signal.aborted) throw new Error("voice_cancelled");
      // This graph is never connected to speakers. Metering cannot block capture.
      try {
        audioContext = new AudioContext();
        source = audioContext.createMediaStreamSource(stream);
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.45;
        frequencies = new Float32Array(analyser.frequencyBinCount);
        samples = new Float32Array(analyser.fftSize);
        source.connect(analyser);
        void audioContext.resume().catch(() => {});
      } catch {
        analyser = undefined;
      }
      recorder = new MediaRecorder(stream, {
        mimeType: "audio/webm",
        audioBitsPerSecond: 64000,
      });
      completion = new Promise<void>((resolve) => {
        recorder!.addEventListener("dataavailable", (e) => chunks.push(e.data));
        recorder!.addEventListener(
          "stop",
          () => {
            stream?.getTracks().forEach((track) => track.stop());
            resolve();
          },
          { once: true },
        );
        recorder!.addEventListener(
          "error",
          () => {
            failed = true;
            stream?.getTracks().forEach((track) => track.stop());
            resolve();
          },
          { once: true },
        );
      });
      recorder.start();
    },
    level() {
      if (!analyser || !samples || audioContext?.state !== "running")
        return null;
      analyser.getFloatTimeDomainData(samples);
      let energy = 0;
      for (const sample of samples) energy += sample * sample;
      const rms = Math.sqrt(energy / samples.length);
      return rms > 0 ? 20 * Math.log10(rms) : -160;
    },
    /** The same spectrum and voicing as the native recorder, from the analyser's samples. */
    frame() {
      if (!analyser || !samples || audioContext?.state !== "running")
        return null;
      analyser.getFloatTimeDomainData(samples);
      return analyseFrame(samples, audioContext.sampleRate);
    },
    bands() {
      if (!analyser || !frequencies || audioContext?.state !== "running")
        return null;
      analyser.getFloatFrequencyData(frequencies);
      return speechBands(
        frequencies,
        audioContext.sampleRate,
        analyser.fftSize,
      );
    },
    async stop(): Promise<VoiceAudio> {
      if (!recorder || recorder.state !== "recording")
        throw new Error("voice_capture_failed");
      recorder.stop();
      await completion;
      if (failed) throw new Error("voice_capture_failed");
      const blob = new Blob(chunks, { type: "audio/webm" });
      if (!blob.size || blob.size > VOICE_BYTES)
        throw new Error("voice_duration");
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]!);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      return { mimeType: "audio/webm", base64 };
    },
    discard,
  };
}
