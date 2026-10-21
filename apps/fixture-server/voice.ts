import { readFile } from "node:fs/promises";
import { accessSync, constants } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  VOICE_SECONDS,
  type VoiceEngine,
  type VoiceRequest,
  type VoiceTranscript,
} from "../../packages/protocol/voice";
import { VoiceError, runVoiceProcess, withPreparedVoice } from "./voice-media";
import { SpeechQueue, type SpeechPriority } from "./speech-queue";
export { VoiceError, runVoiceProcess } from "./voice-media";

export interface Transcriber {
  readonly engine?: VoiceEngine;
  readonly model?: string;
  available?(): boolean;
  transcribe(
    request: VoiceRequest,
    signal: AbortSignal,
    /** Meeting chunks wait behind chat voice. */
    options?: { priority?: SpeechPriority },
  ): Promise<string | VoiceTranscript>;
}

const WhisperOutputSchema = z.object({
  transcription: z
    .array(
      z.object({
        text: z.string(),
        tokens: z
          .array(z.object({ text: z.string(), p: z.number().min(0).max(1) }))
          .optional(),
      }),
    )
    .max(200),
});
/** Conservative signals, not a calibrated probability of transcript correctness. */
export function assessTranscript(
  raw: unknown,
  limited = false,
): VoiceTranscript {
  const parsed = WhisperOutputSchema.safeParse(raw);
  if (!parsed.success) throw new VoiceError("voice_processing_failed", 503);
  const segments = parsed.data.transcription;
  const text = segments
    .map((segment) => segment.text.trim())
    .join(" ")
    .trim();
  if (
    !text ||
    text.length > 4000 ||
    !/[\p{L}\p{N}]/u.test(text.replace(/\[[^\]]*\]|\([^)]*\)|<\|[^|]*\|>/g, ""))
  )
    throw new VoiceError("voice_empty");
  const tokens = segments
    .flatMap((segment) => segment.tokens ?? [])
    .filter(
      (token) =>
        !token.text.startsWith("[_") &&
        !token.text.startsWith("<|") &&
        /[\p{L}\p{N}]/u.test(token.text),
    );
  const reasons: VoiceTranscript["reviewReasons"] = [];
  if (
    !tokens.length ||
    segments.some((segment) => !segment.tokens?.length) ||
    tokens.reduce((sum, token) => sum + token.p, 0) / tokens.length < 0.75 ||
    tokens.filter((token) => token.p < 0.5).length / tokens.length > 0.2 ||
    tokens.some((token) => token.p < 0.12)
  )
    reasons.push("uncertain");
  const words = text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const triples = words.slice(2).map((_, i) => words.slice(i, i + 3).join(" "));
  if (words.length >= 6 && new Set(triples).size / triples.length < 0.6)
    reasons.push("repetition");
  if (limited) reasons.push("limit");
  return { text, reviewReasons: reasons };
}
/** One bounded local inference at a time, chat first. Never accepts executable/model paths from clients. */
export class LocalWhisper implements Transcriber {
  readonly engine = "whisper.cpp" as const;
  readonly adminInfo = { model: "small" };
  /** One local inference at a time; others wait in turn instead of failing. */
  private queue = new SpeechQueue(1, 1);
  readonly binary: string;
  readonly model: string;
  readonly vadModel: string;
  constructor(directory: string) {
    this.binary = resolve(directory, "whisper.cpp/build/bin/whisper-cli");
    this.model = resolve(directory, "models/ggml-small.bin");
    this.vadModel = resolve(directory, "models/ggml-silero-v6.2.0.bin");
    accessSync(this.binary, constants.X_OK);
    accessSync(this.model, constants.R_OK);
    accessSync(this.vadModel, constants.R_OK);
  }
  async transcribe(
    request: VoiceRequest,
    signal: AbortSignal,
    options?: { priority?: SpeechPriority },
  ) {
    signal.throwIfAborted();
    return this.queue.run(
      options?.priority ?? "chat",
      () =>
        withPreparedVoice(
          request,
          signal,
          async ({ directory, wav, durationSeconds }) => {
            const output = join(directory, "transcript");
            await runVoiceProcess(
              this.binary,
              [
                "-m",
                this.model,
                "-f",
                wav,
                "-l",
                // The request's language localizes the UI; detect speech itself.
                "auto",
                "-t",
                "4",
                "-ojf",
                "-of",
                output,
                "-np",
                "-nt",
                "--vad",
                "-vm",
                this.vadModel,
                "-vspd",
                "200",
                "-vsd",
                "500",
                "-vp",
                "200",
              ],
              signal,
              90_000,
            );
            const json = await readFile(`${output}.json`, "utf8");
            if (json.length > 2_000_000)
              throw new VoiceError("voice_processing_failed", 503);
            return assessTranscript(
              JSON.parse(json),
              request.stopReason === "limit" ||
                durationSeconds >= VOICE_SECONDS - 0.5,
            );
          },
        ),
      signal,
    );
  }
}
