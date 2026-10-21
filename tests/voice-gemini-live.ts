/** Real FFmpeg/Silero integration, synthetic audio, fake cloud. No paid requests. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  GeminiTranscriber,
  OpenRouterAsrClient,
  GEMINI_ASR_MODEL,
} from "../apps/fixture-server/voice-openrouter";
import {
  VOICE_PROFILE,
  type VoiceRequest,
  type VoiceAudio,
} from "../packages/protocol/voice";
async function main() {
  const before = readdirSync(tmpdir())
    .filter((f) => f.startsWith("agent-voice-"))
    .sort();
  const directory = mkdtempSync(join(tmpdir(), "gemini-media-check-"));
  let reservations = 0,
    calls = 0;
  const text = "Prepare a meeting tomorrow at two for half an hour.";
  const transport: typeof fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(init!.body as string);
    const wav = Buffer.from(
      body.messages[1].content[0].input_audio.data,
      "base64",
    );
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.readUInt32LE(24), 16000);
    assert.equal(wav.readUInt16LE(22), 1);
    return new Response(
      JSON.stringify({
        model: GEMINI_ASR_MODEL,
        choices: [{ finish_reason: "stop", message: { content: text } }],
      }),
    );
  };
  const config = {
    apiKey: "synthetic-not-used",
    model: "unused-text-model",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    maxRequests: 100,
    timeZone: "Europe/Prague",
  };
  const transcriber = new GeminiTranscriber(
    resolve(".voice"),
    new OpenRouterAsrClient(
      config,
      () => {
        reservations++;
      },
      transport,
    ),
  );
  const request = (
    file: string,
    mimeType: VoiceAudio["mimeType"] = "audio/wav",
  ): VoiceRequest => ({
    profile: VOICE_PROFILE,
    requestId: "synthetic",
    language: "en",
    context: { conversationId: "conversation-1" },
    audio: { mimeType, base64: readFileSync(file).toString("base64") },
  });
  const signal = () => new AbortController().signal;
  const ffmpeg = (args: string[], file: string) =>
    execFileSync("ffmpeg", ["-y", "-v", "error", ...args, file]);
  try {
    const wav = join(directory, "speech.wav");
    execFileSync("espeak-ng", ["-v", "en-us", "-s", "140", "-w", wav, text]);
    for (const [extension, mime, codec] of [
      ["wav", "audio/wav", "pcm_s16le"],
      ["webm", "audio/webm", "libopus"],
      ["m4a", "audio/mp4", "aac"],
    ] as const) {
      const file = join(directory, `converted.${extension}`);
      ffmpeg(["-i", wav, "-ac", "1", "-ar", "48000", "-c:a", codec], file);
      assert.deepEqual(
        await transcriber.transcribe(request(file, mime), signal()),
        { text, reviewReasons: [] },
      );
    }
    assert.equal(calls, 3);
    assert.equal(reservations, 3);
    for (const input of [
      "anullsrc=r=16000:cl=mono",
      "sine=frequency=440:sample_rate=16000",
      "anoisesrc=color=pink:amplitude=0.006:sample_rate=16000:seed=42",
    ]) {
      const file = join(directory, "non-speech.wav");
      ffmpeg(["-f", "lavfi", "-i", input, "-t", "4", "-ac", "1"], file);
      await assert.rejects(
        transcriber.transcribe(request(file), signal()),
        /voice_empty/,
      );
    }
    const bad = {
      ...request(wav),
      audio: {
        mimeType: "audio/wav" as const,
        base64: Buffer.from("not audio").toString("base64"),
      },
    };
    await assert.rejects(
      transcriber.transcribe(bad, signal()),
      /voice_processing_failed/,
    );
    const long = join(directory, "long.wav");
    ffmpeg(
      [
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=16000",
        "-t",
        "121",
        "-ac",
        "1",
      ],
      long,
    );
    await assert.rejects(
      transcriber.transcribe(request(long), signal()),
      /voice_duration/,
    );
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(transcriber.transcribe(request(wav), aborted.signal));
    assert.equal(calls, 3);
    assert.equal(reservations, 3);
    // Cancellation during cloud processing discards a late reply and cleans private audio.
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish: (response: Response) => void = () => {};
    const slow = new GeminiTranscriber(
      resolve(".voice"),
      new OpenRouterAsrClient(
        config,
        () => {},
        async () => {
          started();
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      ),
    );
    const cancellation = new AbortController();
    const pending = slow.transcribe(request(wav), cancellation.signal);
    await ready;
    cancellation.abort();
    finish(
      new Response(
        JSON.stringify({
          model: GEMINI_ASR_MODEL,
          choices: [{ finish_reason: "stop", message: { content: text } }],
        }),
      ),
    );
    await assert.rejects(pending, /voice_cancelled/);
    assert.deepEqual(
      readdirSync(tmpdir())
        .filter((f) => f.startsWith("agent-voice-"))
        .sort(),
      before,
    );
    console.log(
      "PASS Gemini media: WAV/WebM/AAC normalization, real Silero speech gate; silence/noise/tone/malformed/overlong/pre-abort make zero cloud requests; cancel/late result and private audio cleanup. Paid requests: 0.",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
