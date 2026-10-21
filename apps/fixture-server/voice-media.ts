import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VOICE_SECONDS,
  VoiceRequestSchema,
  type VoiceRequest,
} from "../../packages/protocol/voice";

export class VoiceError extends Error {
  constructor(
    readonly code: string,
    readonly status = 422,
    readonly reason?: "no_speech",
  ) {
    super(code);
  }
}
export function runVoiceProcess(
  file: string,
  args: string[],
  signal: AbortSignal,
  timeout: number,
) {
  return new Promise<string>((ok, fail) => {
    execFile(
      file,
      args,
      { signal, timeout, killSignal: "SIGKILL", maxBuffer: 256 * 1024 },
      (error, stdout) =>
        error
          ? fail(
              new VoiceError(
                signal.aborted ? "voice_cancelled" : "voice_processing_failed",
                503,
              ),
            )
          : ok(stdout),
    );
  });
}

/** Private, bounded normalization shared by local and cloud ASR. Cleanup covers every exit. */
export async function withPreparedVoice<T>(
  raw: VoiceRequest,
  signal: AbortSignal,
  consume: (audio: {
    directory: string;
    wav: string;
    durationSeconds: number;
  }) => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const request = VoiceRequestSchema.parse(raw);
  const directory = await mkdtemp(join(tmpdir(), "agent-voice-"));
  try {
    const source = join(directory, "source");
    const pcm = join(directory, "audio.pcm");
    const wav = join(directory, "audio.wav");
    const bytes = Buffer.from(request.audio.base64, "base64");
    await writeFile(source, bytes, { mode: 0o600 });
    const format = {
      "audio/wav": "wav",
      "audio/mp4": "mov",
      "audio/webm": "matroska",
    }[request.audio.mimeType];
    // Force a media demuxer, forbid network protocols, and bound decoded output even for compressed uploads.
    await runVoiceProcess(
      "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-f",
        format,
        "-i",
        source,
        "-t",
        String(VOICE_SECONDS + 1),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "s16le",
        pcm,
      ],
      signal,
      10_000,
    );
    const samples = await readFile(pcm);
    // Encoder padding is allowed, but a longer recording is rejected rather than silently truncated.
    if (samples.length > (VOICE_SECONDS + 0.5) * 32000 || samples.length < 3200)
      throw new VoiceError("voice_duration");
    let energy = 0;
    for (let i = 0; i < samples.length - 1; i += 2)
      energy += (samples.readInt16LE(i) / 32768) ** 2;
    if (Math.sqrt(energy / (samples.length / 2)) < 0.0001)
      throw new VoiceError("voice_empty", 422, "no_speech");
    const header = Buffer.alloc(44);
    header.write("RIFF");
    header.writeUInt32LE(36 + samples.length, 4);
    header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16000, 24);
    header.writeUInt32LE(32000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(samples.length, 40);
    await writeFile(wav, Buffer.concat([header, samples]), { mode: 0o600 });

    signal.throwIfAborted();
    return await consume({
      directory,
      wav,
      durationSeconds: samples.length / 32000,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
