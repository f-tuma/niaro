import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type {
  Meeting,
  MeetingUtterance,
} from "../../packages/protocol/meetings";
import { runVoiceProcess } from "../fixture-server/voice-media";
import { embedVoice, type DiarizerConfig } from "./meeting-diarization";

/**
 * A person's own voice fingerprint, kept only when they chose "This is me"
 * and "Remember my voice" on a meeting. Later diarized meetings compare
 * their voices with it to label the person's turns "Me". It is biometric
 * data: one per person, never shared, deleted on request or with the
 * person; other participants' voices are compared in memory and never kept.
 */
const ProfileSchema = z.strictObject({
  model: z.string().max(200),
  embedding: z.array(z.number()).min(16).max(4096),
  seconds: z.number().min(0),
  meetingId: z.string().max(80),
  createdAt: z.iso.datetime(),
});
export type VoiceProfile = z.infer<typeof ProfileSchema>;

/**
 * Cosine similarity a voice must reach to be taken for the person, and the
 * lead it needs over the next voice. On a Czech council recording with
 * pyannote speaker-diarization-community-1 (NIAR-261), a person enrolled
 * from one ten minutes scored 0.91 and 0.96 against their own voice in the
 * next ten, and at most 0.58 against anyone else.
 */
export const VOICE_MATCH = { similarity: 0.75, margin: 0.15 };
/** At most this much of a person's speech is used for their fingerprint. */
const ENROLL_SECONDS = 90;
/** Less speech than this gives no reliable fingerprint. */
export const ENROLL_MIN_SECONDS = 10;

export class VoiceProfiles {
  constructor(
    private db: DatabaseSync,
    private owner: (scope: Meeting["scope"]) => string,
  ) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS niaro_voice_profile(owner TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT",
    );
  }
  get(scope: Meeting["scope"]): VoiceProfile | undefined {
    const row = this.db
      .prepare("SELECT value FROM niaro_voice_profile WHERE owner=?")
      .get(this.owner(scope));
    if (!row) return;
    const parsed = ProfileSchema.safeParse(JSON.parse(String(row.value)));
    return parsed.success ? parsed.data : undefined;
  }
  set(scope: Meeting["scope"], profile: VoiceProfile) {
    this.db
      .prepare(
        "INSERT INTO niaro_voice_profile(owner,value) VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET value=excluded.value",
      )
      .run(this.owner(scope), JSON.stringify(ProfileSchema.parse(profile)));
  }
  delete(scope: Meeting["scope"]) {
    this.db
      .prepare("DELETE FROM niaro_voice_profile WHERE owner=?")
      .run(this.owner(scope));
  }
}

/**
 * The diarized voice that is the profile's person, if one is clearly them:
 * similar enough, and clearly more similar than any other voice.
 */
export function matchVoice(
  embeddings: Record<string, number[]> | undefined,
  profile: VoiceProfile | undefined,
  model: string,
): number | undefined {
  if (!embeddings || !profile || profile.model !== model) return;
  const scored = Object.entries(embeddings)
    .filter(([, vector]) => vector.length === profile.embedding.length)
    .map(([speaker, vector]) => ({
      speaker: Number(speaker),
      similarity: cosine(vector, profile.embedding),
    }))
    .sort((a, b) => b.similarity - a.similarity);
  const [best, next] = scored;
  if (
    best &&
    best.similarity >= VOICE_MATCH.similarity &&
    best.similarity - (next?.similarity ?? -1) >= VOICE_MATCH.margin
  )
    return best.speaker;
}
function cosine(a: number[], b: number[]) {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * A fingerprint of one diarized voice of a meeting: its longest turns, up
 * to a minute and a half, cut from the sound and sent to the diarizer.
 */
export async function enrollVoice(options: {
  audio: string;
  format: string;
  utterances: MeetingUtterance[];
  voice: number;
  /** A two-track recording: diarized voices are on the second channel. */
  split: boolean;
  diarizer: DiarizerConfig;
  signal: AbortSignal;
}) {
  const turns = options.utterances
    .filter((turn) => turn.speaker !== "me" && turn.voice === options.voice)
    .sort((a, b) => b.end - b.start - (a.end - a.start));
  const chosen: MeetingUtterance[] = [];
  let seconds = 0;
  for (const turn of turns) {
    if (seconds >= ENROLL_SECONDS) break;
    chosen.push(turn);
    seconds += turn.end - turn.start;
  }
  if (seconds < ENROLL_MIN_SECONDS) throw new Error("meeting_voice_too_short");
  const select = chosen
    .sort((a, b) => a.start - b.start)
    .map((turn) => `between(t,${turn.start.toFixed(2)},${turn.end.toFixed(2)})`)
    .join("+");
  const directory = await mkdtemp(join(tmpdir(), "niaro-voice-"));
  const wav = join(directory, "voice.wav");
  try {
    await runVoiceProcess(
      "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-protocol_whitelist",
        "file,pipe",
        "-f",
        options.format,
        "-i",
        options.audio,
        "-vn",
        "-af",
        `${options.split ? "pan=mono|c0=c1," : ""}aselect='${select}',asetpts=N/SR/TB`,
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-f",
        "wav",
        wav,
      ],
      options.signal,
      5 * 60_000,
    );
    return await embedVoice(options.diarizer, wav, options.signal);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
