import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { z } from "zod";
import { longPost } from "./long-post";
import { spokenPieces } from "./meeting-transcript";
import {
  MEETING_MAX_UTTERANCES,
  type MeetingUtterance,
} from "../../packages/protocol/meetings";

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
  /** Each voice's unit-length fingerprint, by speaker number, when asked. */
  embeddings: z
    .record(z.string().regex(/^\d{1,3}$/), z.array(z.number()).max(4096))
    .optional(),
});
export type Diarization = z.infer<typeof DiarizationSchema>;
const EmbeddingSchema = z.object({
  model: z.string().max(200),
  seconds: z.number().min(0),
  embedding: z.array(z.number()).min(16).max(4096),
});

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
  options: { maxSpeakers?: number; embeddings?: boolean } = {},
): Promise<Diarization> {
  const size = (await stat(wav)).size;
  const url = endpoint(config, "diarize");
  if (options.maxSpeakers)
    url.searchParams.set("maxSpeakers", String(options.maxSpeakers));
  if (options.embeddings) url.searchParams.set("embeddings", "1");
  // A long meeting can take the diarizer many minutes on the CPU.
  const response = await longPost(
    url,
    { ...headers(config), "Content-Type": "audio/wav" },
    { stream: createReadStream(wav), size },
    AbortSignal.any([signal, AbortSignal.timeout(60 * 60_000)]),
    64 * 1024 * 1024,
  );
  if (response.status !== 200)
    throw new Error(`diarization_http_${response.status}`);
  return DiarizationSchema.parse(JSON.parse(response.body));
}

/** The fingerprint of the one voice speaking in `wav` (16 kHz mono). */
export async function embedVoice(
  config: DiarizerConfig,
  wav: string,
  signal: AbortSignal,
) {
  const response = await longPost(
    endpoint(config, "embed"),
    { ...headers(config), "Content-Type": "audio/wav" },
    { stream: createReadStream(wav), size: (await stat(wav)).size },
    AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]),
    1024 * 1024,
  );
  if (response.status === 400) throw new Error("meeting_voice_too_short");
  if (response.status !== 200)
    throw new Error(`diarization_http_${response.status}`);
  return EmbeddingSchema.parse(JSON.parse(response.body));
}

/**
 * Gives each turn of `speaker` (the track that was diarized) the voice that
 * spoke most of its time; a turn no voice overlaps takes the nearest one
 * within a second, otherwise none. Voices are numbered again in the order
 * they first speak in the transcript, so "Speaker 1" opens the meeting.
 * The diarizer's speaker recognized as the person recording becomes "Me".
 * A long turn is split at sentences where the voice changes.
 */
export function assignVoices(
  utterances: readonly MeetingUtterance[],
  diarization: Pick<Diarization, "segments">,
  speaker: MeetingUtterance["speaker"],
  /** The diarizer's speaker recognized as the person recording: "Me". */
  self?: number,
): MeetingUtterance[] {
  const segments = [...diarization.segments].sort((a, b) => a.start - b.start);
  const dominant = (start: number, end: number) => {
    const overlap = new Map<number, number>();
    for (const segment of segments) {
      if (segment.start >= end) break;
      const shared =
        Math.min(end, segment.end) - Math.max(start, segment.start);
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
      const gap = Math.max(segment.start - end, start - segment.end);
      if (gap <= 1 && (!nearest || gap < nearest.gap))
        nearest = { speaker: segment.speaker, gap };
    }
    return nearest?.speaker;
  };
  const numbers = new Map<number, number>();
  const label = (turn: MeetingUtterance, found: number | undefined) => {
    const { voice: _previous, ...rest } = turn;
    if (found === undefined) return rest;
    if (found === self) return { ...rest, speaker: "me" as const };
    if (!numbers.has(found)) numbers.set(found, numbers.size + 1);
    const voice = numbers.get(found)!;
    return voice <= 20 ? { ...rest, voice } : rest;
  };
  const split = utterances.flatMap((turn) => {
    if (turn.speaker !== speaker || !segments.length) return [turn];
    // A transcriber without word times gives turns of up to a minute; its
    // sentences, timed by their place in the text, find their own voices,
    // and neighbours with the same voice join again.
    const sentences = spokenPieces(turn.text, SENTENCE_CHARACTERS);
    const total = sentences.reduce((sum, s) => sum + s.length, 0) || 1;
    const span = Math.max(0, turn.end - turn.start);
    const pieces: {
      start: number;
      end: number;
      text: string;
      found?: number;
    }[] = [];
    let offset = 0;
    for (const sentence of sentences) {
      const start = turn.start + (offset / total) * span;
      offset += sentence.length;
      const end = turn.start + (offset / total) * span;
      const found = dominant(start, Math.max(end, start + 0.01));
      const last = pieces[pieces.length - 1];
      if (last && last.found === found) {
        last.end = end;
        last.text = `${last.text} ${sentence}`;
      } else pieces.push({ start, end, text: sentence, found });
    }
    if (pieces.length <= 1) return [turn];
    return pieces.map((piece) => ({
      ...turn,
      start: Math.round(piece.start * 100) / 100,
      end: Math.round(piece.end * 100) / 100,
      text: piece.text,
    }));
  });
  // Splitting never takes a transcript past what a record may hold.
  return (split.length <= MEETING_MAX_UTTERANCES ? split : utterances).map(
    (turn) =>
      label(
        turn,
        turn.speaker === speaker && segments.length
          ? dominant(turn.start, Math.max(turn.end, turn.start + 0.01))
          : undefined,
      ),
  );
}
/** Sentences shorter than this join their neighbour before finding a voice. */
const SENTENCE_CHARACTERS = 80;

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
