import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { z } from "zod";
import type { MeetingUtterance } from "../../packages/protocol/meetings";

/**
 * The optional diarizer service (services/diarizer): who spoke when, from
 * the recording itself. It runs next to the server (docker compose profile
 * "diarization"); meeting sound never leaves the machine.
 */
export type DiarizerConfig = {
  enabled: boolean;
  url: string;
  /** Shared with the service (NIARO_DIARIZATION_TOKEN / DIARIZER_TOKEN). */
  token?: string;
};
export const DiarizerHealthSchema = z.object({
  ready: z.boolean(),
  model: z.string().max(200),
  error: z.string().max(2000).nullable().optional(),
});
export type DiarizerHealth =
  | ({ reachable: true } & z.infer<typeof DiarizerHealthSchema>)
  | { reachable: false; error: string };
const DiarizationSchema = z.object({
  model: z.string().max(200),
  speakers: z.number().int().min(0).max(100),
  segments: z
    .array(
      z.object({
        start: z.number().min(0),
        end: z.number().min(0),
        speaker: z.number().int().min(1).max(100),
      }),
    )
    .max(200_000),
});
export type Diarization = z.infer<typeof DiarizationSchema>;

const headers = (config: DiarizerConfig): Record<string, string> =>
  config.token ? { Authorization: `Bearer ${config.token}` } : {};
const endpoint = (config: DiarizerConfig, path: string) =>
  new URL(path, config.url.endsWith("/") ? config.url : `${config.url}/`);

/** For administration: whether the service answers and its model is loaded. */
export async function diarizerHealth(
  config: DiarizerConfig,
  signal: AbortSignal = AbortSignal.timeout(5_000),
): Promise<DiarizerHealth> {
  try {
    const response = await fetch(endpoint(config, "health"), {
      headers: headers(config),
      signal,
    });
    if (response.status === 401)
      return { reachable: false, error: "unauthorized" };
    if (!response.ok)
      return { reachable: false, error: `http_${response.status}` };
    return {
      reachable: true,
      ...DiarizerHealthSchema.parse(await response.json()),
    };
  } catch (error) {
    return {
      reachable: false,
      error:
        error instanceof Error && error.name === "TimeoutError"
          ? "timeout"
          : "unreachable",
    };
  }
}

/**
 * Diarizes one track: a 16 kHz mono 16-bit WAV file, streamed so a two-hour
 * meeting is never held in memory. A CPU takes minutes for an hour of sound.
 */
export async function diarize(
  config: DiarizerConfig,
  wav: string,
  signal: AbortSignal,
  options: { maxSpeakers?: number } = {},
): Promise<Diarization> {
  const size = (await stat(wav)).size;
  const url = endpoint(config, "diarize");
  if (options.maxSpeakers)
    url.searchParams.set("maxSpeakers", String(options.maxSpeakers));
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...headers(config),
      "Content-Type": "audio/wav",
      "Content-Length": String(size),
    },
    body: Readable.toWeb(createReadStream(wav)) as ReadableStream,
    // Node streams a request body only half-duplex.
    duplex: "half",
    signal: AbortSignal.any([signal, AbortSignal.timeout(60 * 60_000)]),
  } as RequestInit & { duplex: "half" });
  if (!response.ok) throw new Error(`diarization_http_${response.status}`);
  return DiarizationSchema.parse(await response.json());
}

/**
 * Gives each turn of `speaker` (the track that was diarized) the voice that
 * spoke most of its time; a turn no voice overlaps takes the nearest one
 * within a second, otherwise none. Voices are numbered again in the order
 * they first speak in the transcript, so "Speaker 1" opens the meeting.
 */
export function assignVoices(
  utterances: readonly MeetingUtterance[],
  diarization: Pick<Diarization, "segments">,
  speaker: MeetingUtterance["speaker"],
): MeetingUtterance[] {
  const segments = [...diarization.segments].sort((a, b) => a.start - b.start);
  const raw = utterances.map((turn) => {
    if (turn.speaker !== speaker || !segments.length) return undefined;
    const overlap = new Map<number, number>();
    for (const segment of segments) {
      if (segment.start >= turn.end) break;
      const shared =
        Math.min(turn.end, segment.end) - Math.max(turn.start, segment.start);
      if (shared > 0)
        overlap.set(
          segment.speaker,
          (overlap.get(segment.speaker) ?? 0) + shared,
        );
    }
    if (overlap.size)
      return [...overlap].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0];
    let nearest: { speaker: number; gap: number } | undefined;
    for (const segment of segments) {
      const gap = Math.max(segment.start - turn.end, turn.start - segment.end);
      if (gap <= 1 && (!nearest || gap < nearest.gap))
        nearest = { speaker: segment.speaker, gap };
    }
    return nearest?.speaker;
  });
  const numbers = new Map<number, number>();
  return utterances.map((turn, index) => {
    const found = raw[index];
    const { voice: _previous, ...rest } = turn;
    if (found === undefined) return rest;
    if (!numbers.has(found)) numbers.set(found, numbers.size + 1);
    const voice = numbers.get(found)!;
    return voice <= 20 ? { ...rest, voice } : rest;
  });
}

/**
 * The diarizer as the server settings describe it; the shared token comes
 * from NIARO_DIARIZATION_TOKEN, so it stays out of the settings.
 */
export function diarizerConfig(
  settings: { enabled: boolean; url: string },
  env: Record<string, string | undefined> = process.env,
): DiarizerConfig {
  const token = env.NIARO_DIARIZATION_TOKEN?.trim();
  return { ...settings, ...(token ? { token } : {}) };
}
