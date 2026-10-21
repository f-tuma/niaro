/** Opt-in, local-only corpus evaluation. It never submits a workflow command. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { LocalWhisper } from "../apps/fixture-server/voice";
import { VoiceActivity } from "../packages/audio/voice-activity";
import { scoreVoiceText } from "./audio/voice-evaluation";
import {
  VOICE_PROFILE,
  type VoiceTranscript,
} from "../packages/protocol/voice";

const Manifest = z.object({
  source: z.string(),
  language: z.enum(["en", "cs"]),
  samples: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9-]{1,50}$/),
        file: z.string(),
        text: z.string(),
        critical: z.array(z.array(z.string()).min(1)),
        speechEndMs: z.number().positive().optional(),
      }),
    )
    .min(1)
    .max(100),
});
async function main() {
  if (!process.argv[2])
    throw new Error(
      "Usage: npm run test:voice:quality -- /path/to/manifest.json",
    );
  const path = resolve(process.argv[2]);
  const corpus = Manifest.parse(JSON.parse(readFileSync(path, "utf8")));
  const whisper = new LocalWhisper(
    resolve(process.env.FIXTURE_VOICE_DIR ?? ".voice"),
  );
  const results = [];
  for (const sample of corpus.samples) {
    const file = resolve(dirname(path), sample.file);
    const pcm = execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        file,
        "-t",
        "121",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-f",
        "s16le",
        "pipe:1",
      ],
      { timeout: 10000, maxBuffer: 4_000_000 },
    );
    const activity = new VoiceActivity(0);
    let endpoint: { reason: string; atMs: number } | undefined;
    for (let offset = 0; offset + 3200 <= pcm.length; offset += 3200) {
      let energy = 0;
      for (let n = offset; n < offset + 3200; n += 2)
        energy += (pcm.readInt16LE(n) / 32768) ** 2;
      const db = energy ? 20 * Math.log10(Math.sqrt(energy / 1600)) : -160;
      const atMs = (offset / 3200 + 1) * 100;
      const reason = activity.sample(db, atMs);
      if (reason) {
        endpoint = { reason, atMs };
        break;
      }
    }
    const started = Date.now();
    let transcript: VoiceTranscript | undefined, error: string | undefined;
    try {
      transcript = await whisper.transcribe(
        {
          profile: VOICE_PROFILE,
          requestId: `eval-${sample.id}`,
          language: corpus.language,
          context: { conversationId: "conversation-1" },
          audio: {
            mimeType: "audio/wav",
            base64: readFileSync(file).toString("base64"),
          },
          stopReason: "silence",
        },
        new AbortController().signal,
      );
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "unknown";
    }
    const { missing, wordErrorRate } = scoreVoiceText(
      sample,
      transcript?.text ?? "",
    );
    const noSpeech = sample.text === "";
    const falseAutomatic =
      !!transcript &&
      !transcript.reviewReasons.length &&
      (noSpeech || missing.length > 0);
    const endpointPassed =
      sample.speechEndMs === undefined ||
      (endpoint?.reason === "silence" &&
        endpoint.atMs >= sample.speechEndMs - 300 &&
        endpoint.atMs <= sample.speechEndMs + 3000);
    const passed =
      !falseAutomatic &&
      endpointPassed &&
      (noSpeech
        ? error === "voice_empty"
        : transcript !== undefined && missing.length === 0);
    const result = {
      id: sample.id,
      expected: sample.text,
      ...transcript,
      error,
      wordErrorRate,
      missing,
      falseAutomatic,
      endpoint,
      endpointPassed,
      milliseconds: Date.now() - started,
      passed,
    };
    results.push(result);
    console.log(JSON.stringify(result));
  }
  const passed = results.every((result) => result.passed);
  console.log(
    JSON.stringify({
      source: corpus.source,
      samples: results.length,
      passed: results.filter((result) => result.passed).length,
      falseAutomatic: results.filter((result) => result.falseAutomatic).length,
      review: results.filter((result) => result.reviewReasons?.length).length,
      result: passed ? "PASS" : "FAIL",
      workflowCommands: 0,
    }),
  );
  if (!passed) process.exitCode = 1;
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
