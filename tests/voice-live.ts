/** Opt-in real local inference. Synthetic eSpeak input, never the host microphone. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalWhisper } from "../apps/fixture-server/voice";
import { FixtureEngine } from "../apps/fixture-server/engine";
import { messageCommand } from "../packages/client-core/commands";
import { VOICE_PROFILE, type VoiceRequest } from "../packages/protocol/voice";
async function main() {
  const directory = mkdtempSync(join(tmpdir(), "agent-voice-live-"));
  const whisper = new LocalWhisper(".voice");
  const before = readdirSync(tmpdir())
    .filter((f) => f.startsWith("agent-voice-"))
    .sort();
  try {
    for (const language of ["en", "cs"] as const) {
      // A different UI locale must not force the microphone's source language.
      const uiLanguage = language === "en" ? "cs" : "en";
      const reviewed =
        language === "en" ? "Choose Peter Novak." : "Vyber Petera Nováka.";
      const wav = join(directory, `${language}.wav`);
      execFileSync("espeak-ng", [
        "-v",
        language === "en" ? "en-us" : "cs",
        "-s",
        "140",
        "-w",
        wav,
        reviewed,
      ]);
      const engine = new FixtureEngine();
      const input = engine.execute(
        messageCommand("Choose Peter", language, `start-${language}`),
      ).snapshot.inputRequests[0]!;
      const request: VoiceRequest = {
        profile: VOICE_PROFILE,
        requestId: `voice-${language}`,
        language: uiLanguage,
        context: {
          conversationId: input.conversationId,
          workItemId: input.workItemId,
          inputRequestId: input.id,
          expectedInputRevision: input.revision,
        },
        audio: {
          mimeType: "audio/wav",
          base64: readFileSync(wav).toString("base64"),
        },
      };
      const started = Date.now();
      const transcript = await whisper.transcribe(
        request,
        new AbortController().signal,
      );
      const text = transcript.text;
      assert.ok(text.trim());
      assert.equal(engine.snapshot().inputRequests[0]!.status, "open");
      assert.equal(engine.snapshot().operations.length, 0);
      // The measured raw transcript may be wrong. Simulate the explicit, visible review correction, never quietly normalize names.
      const command = messageCommand(
        reviewed,
        language,
        `answer-${language}`,
        input,
      );
      const answer = engine.execute(command);
      assert.equal(answer.status, "accepted");
      assert.equal(answer.snapshot.inputRequests[0]!.status, "resolved");
      assert.equal(answer.snapshot.operations.length, 0);
      assert.deepEqual(engine.execute(command), answer);
      console.log(
        JSON.stringify({
          language,
          uiLanguage,
          rawTranscript: text,
          reviewReasons: transcript.reviewReasons,
          reviewedText: reviewed,
          correctionRequired: text !== reviewed,
          milliseconds: Date.now() - started,
        }),
      );
      const broken = {
        ...request,
        audio: {
          ...request.audio,
          base64: Buffer.from("invalid media").toString("base64"),
        },
      };
      await assert.rejects(
        whisper.transcribe(broken, new AbortController().signal),
      );
      const silence = join(directory, "silence.wav");
      execFileSync("ffmpeg", [
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=16000:cl=mono",
        "-t",
        "1",
        silence,
      ]);
      await assert.rejects(
        whisper.transcribe(
          {
            ...request,
            audio: {
              ...request.audio,
              base64: readFileSync(silence).toString("base64"),
            },
          },
          new AbortController().signal,
        ),
        /voice_empty/,
      );
      const cancelled = new AbortController();
      cancelled.abort();
      await assert.rejects(whisper.transcribe(request, cancelled.signal));
    }
    for (const signal of [
      "sine=frequency=440:sample_rate=16000",
      "anoisesrc=color=pink:amplitude=0.006:sample_rate=16000:seed=42",
    ]) {
      const wav = join(directory, "non-speech.wav");
      execFileSync("ffmpeg", [
        "-y",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        signal,
        "-t",
        "11",
        "-ac",
        "1",
        wav,
      ]);
      await assert.rejects(
        whisper.transcribe(
          {
            profile: VOICE_PROFILE,
            requestId: "no-speech",
            language: "cs",
            context: { conversationId: "conversation-1" },
            audio: {
              mimeType: "audio/wav",
              base64: readFileSync(wav).toString("base64"),
            },
          },
          new AbortController().signal,
        ),
        /voice_empty/,
      );
    }
    assert.deepEqual(
      readdirSync(tmpdir())
        .filter((f) => f.startsWith("agent-voice-"))
        .sort(),
      before,
    );
    console.log(
      "Voice live PASS: real EN/CS local inference, explicit corrected review, same question/command, no approval, malformed/silent/aborted audio, non-speech tone/noise rejection, temporary file cleanup. This is not speech accuracy validation.",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
