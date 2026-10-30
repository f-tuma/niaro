import { createHash } from "node:crypto";
import {
  MEETING_CONSOLIDATION_VERSION,
  MEETING_SYNTHESIS_INPUT_CHARS,
  validateMeetingSynthesis,
  type MeetingConsolidationInput,
  type MeetingSynthesisDraft,
} from "../../packages/protocol/meeting-record";
import { encodeWav } from "../../packages/audio/analysis";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Scope } from "../../packages/protocol";
import {
  MEETING_MAX_SECONDS,
  isAutomaticMeetingTitle,
  meetingSpeakerLabels,
  shortMeetingTitle,
  type Meeting,
  type MeetingSegment,
  type MeetingUtterance,
} from "../../packages/protocol/meetings";
import {
  VOICE_PROFILE,
  VoiceTranscriptSchema,
} from "../../packages/protocol/voice";
import { runVoiceProcess } from "../fixture-server/voice-media";
import type { Transcriber } from "../fixture-server/voice";
import { SpeechQueue } from "../fixture-server/speech-queue";
import { resolveDateTime } from "../server-plugins/datetime";
import type { MeetingChunkTranscript } from "../server-integrations/transcription";
import { MEETING_STT_REQUEST_BYTES } from "../server-integrations/transcription";
import { IdentityError } from "./error";
import {
  assignVoices,
  diarize,
  type DiarizerConfig,
} from "./meeting-diarization";
import { MeetingStore } from "./meeting-store";
import {
  MEETING_CHUNK_OVERLAP_SECONDS,
  MEETING_CHUNK_SECONDS,
  mergeUtterances,
  minuteSegments,
  speechSpan,
  stitchChunks,
  transcriptionPrompt,
  type MeetingChunkResult,
} from "./meeting-transcript";
/** Transcribes a whole chunk of a meeting with timestamps (`verbose_json`). */
export type MeetingChunkTranscriber = {
  model: string;
  transcribe(
    input: {
      audio: Buffer;
      format: "flac" | "mp3";
      prompt: string;
      requestId: string;
    },
    signal: AbortSignal,
  ): Promise<MeetingChunkTranscript>;
};
export type MeetingProcessingAccess = {
  scope: Scope;
  run<T>(fn: () => T): Promise<T>;
  failure<T>(fn: () => T): Promise<T>;
  /** Minute-by-minute fallback through the voice transcriber. */
  transcriber?: Transcriber;
  /** Timestamped chunks through `/audio/transcriptions`; preferred when present. */
  meetingTranscriber?: MeetingChunkTranscriber;
  /** The workspace's time zone, for deadlines and the meeting's date. */
  timeZone?: string;
  analyzer?: {
    model: string;
    fingerprint?: string;
    /** The model's draft; sources are checked and repaired afterwards. */
    consolidate(
      input: MeetingConsolidationInput,
      language: "en" | "cs",
      signal: AbortSignal,
      runId: string,
    ): Promise<unknown>;
    /** A short name from the finished summary, for meetings nobody named. */
    name?(
      summary: string,
      language: "en" | "cs",
      signal: AbortSignal,
      runId: string,
    ): Promise<string>;
  };
};
export type MeetingProcessorOptions = {
  onPublished?: (scope: Scope) => void;
  /** Waits before the second and third attempt of a failed chunk. */
  retryDelaysMs?: number[];
  /** Length of a timestamped chunk, 120–600 seconds. */
  chunkSeconds?: number;
  /** Chunks of one meeting transcribed at once. */
  parallel?: number;
  /** Shared with chat voice, which always goes first. */
  queue?: SpeechQueue;
  /** Workspace-independent names and terms the transcriber should know. */
  glossary?: string[];
  /** The optional diarizer that tells the voices of a track apart. */
  diarization?: DiarizerConfig;
};
/** The server's meeting settings (`administration.identity.meetings`). */
export type MeetingSettings = {
  /** Days the sound of a processed meeting is kept; 0 keeps it forever. */
  audioRetentionDays: number;
  /** Names and terms every meeting's transcriber should know. */
  glossary: string[];
  /** Length of a timestamped transcription chunk, 120–600 seconds. */
  chunkSeconds: number;
  /** Who spoke when, from the optional diarizer service. */
  diarization: { enabled: boolean; url: string };
};
export const MEETING_SETTINGS_DEFAULTS: MeetingSettings = {
  audioRetentionDays: 30,
  glossary: [],
  chunkSeconds: 300,
  diarization: { enabled: false, url: "http://diarizer:8000" },
};
const CHUNK_SECONDS = 60;
const PERMANENT = new Set([
  "voice_model_limit",
  "voice_model_expired",
  "voice_unavailable",
  "voice_cancelled",
  "voice_duration",
  "voice_empty",
  "meeting_model_changed",
  "integration_cancelled",
  "catalog_provider_limit",
]);
const TRANSIENT = new Set([
  "voice_busy",
  "integration_timeout",
  "integration_unavailable",
  "integration_rate_limited",
  "integration_provider_unavailable",
]);
/** Busy, rate limited, a server error or a timeout: worth another attempt. */
export function transientTranscriptionError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  const status = "status" in error ? Number(error.status) : NaN;
  if (PERMANENT.has(code) || code.startsWith("catalog_budget_")) return false;
  if (TRANSIENT.has(code)) return true;
  return status === 429 || status >= 500;
}
function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    };
    const stop = () => {
      done();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      done();
      resolve();
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
}
/** At most `limit` of the jobs run at once; the first failure stops the rest. */
async function inParallel(
  jobs: (() => Promise<void>)[],
  limit: number,
  signal: AbortSignal,
) {
  let next = 0;
  let failed = false;
  const lane = async () => {
    while (!failed && next < jobs.length) {
      signal.throwIfAborted();
      const job = jobs[next++]!;
      try {
        await job();
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  const results = await Promise.allSettled(
    Array.from({ length: Math.max(1, Math.min(limit, jobs.length)) }, lane),
  );
  const failure = results.find((r) => r.status === "rejected");
  if (failure) throw (failure as PromiseRejectedResult).reason;
}
/** When a channel's speech starts, in samples; its first loud 100 ms window. */
function speechOnset(samples: Float32Array) {
  const window = 1600;
  for (let at = 0; at + window <= samples.length; at += window) {
    let energy = 0;
    for (let i = at; i < at + window; i++) energy += samples[i]! * samples[i]!;
    if (Math.sqrt(energy / window) > 0.01) return at;
  }
  return samples.length;
}
/** The meeting's local date and weekday in the workspace's time zone. */
function meetingDay(recordedAt: string, timeZone: string) {
  const resolved = resolveDateTime(
    { when: { kind: "day_offset", days: 0 } },
    { referenceNow: recordedAt, timeZone },
  );
  const date =
    resolved.status === "resolved"
      ? String(resolved.values.date)
      : recordedAt.slice(0, 10);
  return { date, weekday: new Date(`${date}T00:00:00Z`).getUTCDay() || 7 };
}
/** Durable domain checkpoints surround bounded calls to the configured STT and closed Mastra agent. */
export class MeetingProcessor {
  private onPublished?: (scope: Scope) => void;
  private active = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  private closed = false;
  private retryDelays: number[];
  private chunkSeconds: number;
  private parallel: number;
  readonly queue: SpeechQueue;
  private glossary: string[];
  private diarization: DiarizerConfig | undefined;
  /** One meeting at a time: the service diarizes one, and a track is large. */
  private diarizing: Promise<unknown> = Promise.resolve();
  constructor(
    private store: MeetingStore,
    options: MeetingProcessorOptions = {},
  ) {
    this.onPublished = options.onPublished;
    this.retryDelays = options.retryDelaysMs ?? [1000, 4000];
    this.chunkSeconds = Math.max(
      MEETING_CHUNK_SECONDS.min,
      Math.min(
        MEETING_CHUNK_SECONDS.max,
        options.chunkSeconds ?? MEETING_CHUNK_SECONDS.default,
      ),
    );
    this.parallel = Math.max(1, Math.min(3, options.parallel ?? 3));
    this.queue = options.queue ?? new SpeechQueue();
    this.glossary = (options.glossary ?? []).slice(0, 200);
    this.diarization = options.diarization;
  }
  /** New server settings: chunks started from now on use them. */
  configure(
    options: Pick<
      MeetingProcessorOptions,
      "chunkSeconds" | "glossary" | "diarization"
    >,
  ) {
    if (options.chunkSeconds !== undefined)
      this.chunkSeconds = Math.max(
        MEETING_CHUNK_SECONDS.min,
        Math.min(MEETING_CHUNK_SECONDS.max, options.chunkSeconds),
      );
    if (options.glossary) this.glossary = options.glossary.slice(0, 200);
    if (options.diarization) this.diarization = options.diarization;
  }
  /** Three attempts in all; only busy, rate-limited, 5xx and timeouts repeat. */
  private async attempt<T>(fn: () => Promise<T>, signal: AbortSignal) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (
          signal.aborted ||
          attempt >= this.retryDelays.length ||
          !transientTranscriptionError(error)
        )
          throw error;
        await pause(this.retryDelays[attempt]!, signal);
      }
    }
  }
  async start(access: MeetingProcessingAccess, id: string, retry: boolean) {
    if (this.closed)
      throw new IdentityError(503, "meeting_processing_unavailable");
    let retryAttempt: number | undefined;
    for (;;) {
      // Reserve and publish the owner in the authority queue before exposing 202.
      const admission = await access.run(() => {
        if (this.closed)
          throw new IdentityError(503, "meeting_processing_unavailable");
        const meeting = this.store.get(access.scope, id);
        // Another explicit retry may have advanced the attempt while we waited.
        // This request must not then retry that newer attempt's failure as well.
        if (
          retryAttempt !== undefined &&
          meeting.processingAttempt !== retryAttempt
        )
          return { meeting, previous: undefined };
        const previous = this.active.get(id);
        if (previous) return { meeting, previous };
        const record = this.store.record(access.scope, id);
        if (
          (!access.transcriber && !access.meetingTranscriber) ||
          !access.analyzer?.consolidate
        )
          throw new IdentityError(409, "meeting_services_unavailable");
        if (meeting.status === "ready" && record.analysis)
          return { meeting, previous: undefined };
        if (
          !meeting.sourceHash ||
          (meeting.status !== "sealed" &&
            meeting.status !== "ready" &&
            !(retry && ["failed", "interrupted"].includes(meeting.status)))
        )
          throw new IdentityError(409, "meeting_retry_required");
        // Without its sound, only a meeting with its whole transcript can be processed.
        if (meeting.audioDeletedAt && !record.transcriptComplete)
          throw new IdentityError(409, "meeting_audio_deleted");
        if (this.active.size >= 2)
          throw new IdentityError(429, "meeting_processing_busy");
        const reserved = this.store.update(access.scope, id, {
          status: "transcribing",
          failure: null,
          processingAttempt: meeting.processingAttempt + 1,
        });
        const controller = new AbortController();
        const done = this.process(access, id, controller.signal)
          .catch(() => {})
          .finally(() => {
            if (this.active.get(id)?.controller === controller)
              this.active.delete(id);
          });
        this.active.set(id, { controller, done });
        return { meeting: reserved, previous: undefined };
      });
      if (
        admission.previous &&
        retry &&
        ["failed", "interrupted"].includes(admission.meeting.status)
      ) {
        // Terminal status may precede cleanup. Only an explicit retry waits for
        // retirement; never hold the authority queue while that owner finishes.
        retryAttempt = admission.meeting.processingAttempt;
        await admission.previous.done;
        continue; // Fresh authorization/status checks precede the new reservation.
      }
      return admission.meeting;
    }
  }
  private async process(
    access: MeetingProcessingAccess,
    id: string,
    signal: AbortSignal,
  ) {
    const { scope, run } = access;
    const progress = { stage: "meeting_audio_invalid" };
    let directory: string | undefined;
    try {
      const meeting = await run(() => this.store.get(scope, id));
      const complete = await run(
        () => this.store.record(scope, id).transcriptComplete,
      );
      if (!complete) {
        directory = await mkdtemp(join(tmpdir(), "niaro-meeting-"));
        await this.transcribe(access, meeting, directory, progress, signal);
      }
      progress.stage = "meeting_analysis_failed";
      await run(() => this.store.update(scope, id, { status: "analyzing" }));
      await this.analyze(access, meeting, signal);
    } catch (error) {
      // Record failure even if the former credential/policy was revoked. No content is exposed here.
      const code =
        error instanceof IdentityError &&
        (error.code.startsWith("catalog_budget_") ||
          error.code === "catalog_provider_limit")
          ? "meeting_model_limit"
          : error instanceof Error &&
              [
                "meeting_transcript_limit",
                "meeting_consolidation_limit",
              ].includes(error.message)
            ? error.message
            : progress.stage;
      await access.failure(() =>
        this.store.update(scope, id, {
          status: signal.aborted ? "interrupted" : "failed",
          failure: signal.aborted ? "meeting_processing_interrupted" : code,
        }),
      );
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
  /** Normalizes the sealed audio, then transcribes it. */
  private async transcribe(
    access: MeetingProcessingAccess,
    meeting: Meeting,
    directory: string,
    progress: { stage: string },
    signal: AbortSignal,
  ) {
    const { scope, run } = access;
    const id = meeting.id;
    let format = {
      "audio/mp4": "mov",
      "audio/wav": "wav",
      "audio/webm": "matroska",
      "audio/mpeg": "mp3",
      "audio/ogg": "ogg",
    }[meeting.mimeType];
    let source = this.store.path(meeting);
    // Uploaded containers cannot reference network resources or choose a demuxer.
    const probe = async () => {
      const value = JSON.parse(
        await runVoiceProcess(
          "ffprobe",
          [
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-f",
            format,
            "-select_streams",
            "a:0",
            "-show_entries",
            "format=duration:stream=channels",
            "-of",
            "json",
            source,
          ],
          signal,
          15_000,
        ),
      ) as {
        format?: { duration?: string };
        streams?: { channels?: number }[];
      };
      return {
        duration: Number(value.format?.duration),
        channels: value.streams?.[0]?.channels,
      };
    };
    let probed = await probe();
    if (!Number.isFinite(probed.duration)) {
      // A browser's MediaRecorder writes a live stream with no duration or
      // seek index. Copying its audio (no re-encoding) into a private
      // working file adds both; the sealed upload itself never changes.
      const copy = join(directory, "source.mka");
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
          format,
          "-i",
          source,
          "-map",
          "0:a:0",
          "-c",
          "copy",
          "-f",
          "matroska",
          copy,
        ],
        signal,
        120_000,
      );
      source = copy;
      format = "matroska";
      probed = await probe();
    }
    const duration = probed.duration;
    const split = meeting.speakerChannels === "self-others";
    if (
      !Number.isFinite(duration) ||
      duration < 0.1 ||
      duration > MEETING_MAX_SECONDS ||
      (split && probed.channels !== 2)
    )
      throw new Error("meeting_audio_invalid");
    await run(() =>
      this.store.update(scope, id, { durationSeconds: duration }),
    );
    progress.stage = "meeting_transcription_failed";
    /** Decoded 16 kHz samples of one stretch of the meeting, one array per channel. */
    const decode = async (from: number, length: number, name: string) => {
      const file = join(directory, `${name}.pcm`);
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
          format,
          "-ss",
          String(from),
          "-i",
          source,
          "-t",
          String(length),
          "-vn",
          "-ac",
          split ? "2" : "1",
          "-ar",
          "16000",
          "-f",
          "s16le",
          file,
        ],
        signal,
        60_000,
      );
      const pcm = await readFile(file);
      await rm(file, { force: true });
      const width = split ? 4 : 2;
      if (
        pcm.length > (length + 1) * 16000 * width ||
        pcm.length < width ||
        pcm.length % width
      )
        throw new Error("meeting_audio_invalid");
      const channels = Array.from(
        { length: split ? 2 : 1 },
        () => new Float32Array(pcm.length / width),
      );
      for (let frame = 0; frame < pcm.length / width; frame++)
        for (let channel = 0; channel < channels.length; channel++)
          channels[channel]![frame] =
            pcm.readInt16LE(frame * width + channel * 2) / 32768;
      return channels;
    };
    /** The track the diarizer hears: the others' channel, or the whole mix. */
    const track = async (path: string) => {
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
          format,
          "-i",
          source,
          "-vn",
          ...(split ? ["-af", "pan=mono|c0=c1"] : ["-ac", "1"]),
          "-ar",
          "16000",
          "-c:a",
          "pcm_s16le",
          "-f",
          "wav",
          path,
        ],
        signal,
        10 * 60_000,
      );
    };
    const existing = await run(() => this.store.allSegments(scope, id));
    const chunked = await run(() => this.store.hasChunks(scope, id));
    // A meeting already transcribed minute by minute continues that way, so
    // no paid minute is transcribed twice.
    if (
      access.meetingTranscriber &&
      (!existing.length || chunked || !access.transcriber)
    )
      await this.transcribeTimed(
        access,
        meeting,
        duration,
        decode,
        track,
        directory,
        signal,
      );
    else
      await this.transcribeMinutes(access, meeting, duration, decode, signal);
  }
  /** Fallback: one recognition per minute (and channel) through the voice transcriber. */
  private async transcribeMinutes(
    access: MeetingProcessingAccess,
    meeting: Meeting,
    duration: number,
    decode: (
      from: number,
      length: number,
      name: string,
    ) => Promise<Float32Array[]>,
    signal: AbortSignal,
  ) {
    const { scope, run } = access;
    const id = meeting.id;
    const split = meeting.speakerChannels === "self-others";
    const transcriber = access.transcriber;
    if (!transcriber)
      throw new IdentityError(409, "meeting_services_unavailable");
    const transcriberName =
      transcriber.model ?? transcriber.engine ?? "configured";
    /** One channel of one chunk; digital silence needs no paid call. */
    const recognize = async (samples: Float32Array, requestId: string) => {
      let energy = 0;
      for (const sample of samples) energy += sample * sample;
      let silent = Math.sqrt(energy / samples.length) < 0.0001;
      const audio = Buffer.from(encodeWav(samples, 16000));
      await run(() => {});
      let rawResult: Awaited<ReturnType<Transcriber["transcribe"]>> | undefined;
      if (!silent) {
        try {
          rawResult = await this.attempt(
            () =>
              transcriber.transcribe(
                {
                  profile: VOICE_PROFILE,
                  requestId,
                  language: meeting.language,
                  context: { conversationId: `meeting-${id}` },
                  audio: {
                    mimeType: "audio/wav",
                    base64: audio.toString("base64"),
                  },
                  stopReason: "user",
                },
                signal,
                { priority: "background" },
              ),
            signal,
          );
        } catch (error) {
          if (
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "voice_empty" &&
            "reason" in error &&
            error.reason === "no_speech"
          )
            silent = true;
          else throw error;
        }
      }
      const result = silent
        ? {
            text: "",
            reviewReasons: [] as ("uncertain" | "repetition" | "limit")[],
          }
        : VoiceTranscriptSchema.parse(
            typeof rawResult === "string"
              ? { text: rawResult, reviewReasons: ["uncertain"] }
              : rawResult,
          );
      // Never store a truncated excerpt as a complete transcript.
      if (result.reviewReasons.includes("limit"))
        throw new Error("meeting_transcript_limit");
      return {
        silent,
        text: result.text,
        reviewReasons: result.reviewReasons.filter(
          (reason): reason is "uncertain" | "repetition" => reason !== "limit",
        ),
      };
    };
    for (let index = 0; index < Math.ceil(duration / CHUNK_SECONDS); index++) {
      signal.throwIfAborted();
      if (await run(() => this.store.segment(scope, id, index))) continue;
      await run(() => this.store.update(scope, id, { status: "transcribing" }));
      const from = index * CHUNK_SECONDS;
      const channels = await decode(
        from,
        Math.min(CHUNK_SECONDS, duration - from),
        "chunk",
      );
      let text: string,
        silent: boolean,
        reviewReasons: MeetingSegment["reviewReasons"];
      if (!split) {
        ({ text, silent, reviewReasons } = await recognize(
          channels[0]!,
          `meeting-${id}-${index}`,
        ));
      } else {
        const labels = meetingSpeakerLabels(meeting.language);
        const parts = [];
        for (const [channel, role] of (["self", "others"] as const).entries())
          parts.push({
            label: labels[role],
            onset: speechOnset(channels[channel]!),
            ...(await recognize(
              channels[channel]!,
              `meeting-${id}-${index}-${role}`,
            )),
          });
        const spoken = parts
          .filter((part) => part.text.trim())
          .sort((a, b) => a.onset - b.onset);
        // Who spoke is kept per line; the order inside one chunk is only
        // who started first, since each channel is one recognition.
        text = spoken
          .map((part) => `${part.label}: ${part.text.trim()}`)
          .join("\n");
        if (text.length > 4000) throw new Error("meeting_transcript_limit");
        silent = parts.every((part) => part.silent);
        reviewReasons = [
          ...new Set(parts.flatMap((part) => part.reviewReasons)),
        ];
      }
      const segment: MeetingSegment = {
        index,
        startSeconds: from,
        endSeconds: Math.min(duration, (index + 1) * CHUNK_SECONDS),
        text,
        reviewReasons,
        transcriber: transcriberName,
        analyzer: null,
        analysis: silent ? { summary: [], points: [], tasks: [] } : null,
      };
      signal.throwIfAborted();
      await run(() => this.store.putSegment(scope, id, segment));
    }
  }
  /**
   * Chunks of a few minutes with a short overlap, transcribed with
   * timestamps (each channel of a two-track recording on its own), a few at
   * once through the shared speech queue. Every finished chunk is saved, so
   * a retry pays only for the missing ones. The stitched turns become the
   * meeting's utterances and its minute segments.
   */
  private async transcribeTimed(
    access: MeetingProcessingAccess,
    meeting: Meeting,
    duration: number,
    decode: (
      from: number,
      length: number,
      name: string,
    ) => Promise<Float32Array[]>,
    track: (path: string) => Promise<void>,
    directory: string,
    signal: AbortSignal,
  ) {
    const { scope, run } = access;
    const id = meeting.id;
    const transcriber = access.meetingTranscriber!;
    const split = meeting.speakerChannels === "self-others";
    // A meeting keeps the chunk size it started with: saved chunks of an
    // earlier size would otherwise be paid for again after a settings change.
    const size =
      (await run(() => this.store.chunkSeconds(scope, id))) ??
      this.chunkSeconds;
    const speakers: MeetingUtterance["speaker"][] = split
      ? ["me", "others"]
      : ["unknown"];
    const count = Math.ceil(duration / size);
    const results = new Map<string, MeetingChunkResult>();
    const key = (index: number, speaker: string) =>
      `${size}:${index}:${speaker}`;
    for (let index = 0; index < count; index++)
      for (const speaker of speakers) {
        const saved = await run(() =>
          this.store.chunk(scope, id, key(index, speaker)),
        );
        if (saved) results.set(key(index, speaker), saved);
      }
    const title = isAutomaticMeetingTitle(meeting.title) ? "" : meeting.title;
    const chunk = async (index: number) => {
      const missing = speakers.filter((s) => !results.has(key(index, s)));
      if (!missing.length) return;
      signal.throwIfAborted();
      // Decoded sound is large (a 600 s stereo chunk is over 100 MB), so a
      // chunk takes its queue slot before decoding and keeps it through its
      // retries: no more chunks are in memory than there are background
      // slots, however long chat keeps the rest waiting.
      await this.queue.run(
        "background",
        () => transcribeChunk(index, missing),
        signal,
      );
    };
    const transcribeChunk = async (
      index: number,
      missing: MeetingUtterance["speaker"][],
    ) => {
      const from = Math.max(0, index * size - MEETING_CHUNK_OVERLAP_SECONDS);
      const to = Math.min(duration, (index + 1) * size);
      const channels = await decode(from, to - from, `chunk-${index}`);
      for (const speaker of missing) {
        const samples = channels[speakers.indexOf(speaker)]!;
        const span = speechSpan(samples);
        let result: MeetingChunkResult;
        if (!span)
          result = {
            start: from,
            end: to,
            speaker,
            segments: [],
            timed: true,
            text: "",
          };
        else {
          const offset = from + span.from / 16000;
          const audio = await this.encode(
            samples.subarray(span.from, span.to),
            join(directory, `chunk-${index}-${speaker}`),
            signal,
          );
          const previous = results.get(key(index - 1, speaker))?.text;
          const prompt = transcriptionPrompt({
            title,
            attendees: meeting.attendees,
            companies: meeting.companies,
            glossary: this.glossary,
            previous,
          });
          await run(() => {});
          const reply = await this.attempt(
            () =>
              transcriber.transcribe(
                {
                  ...audio,
                  prompt,
                  requestId: `meeting-${id}-${size}-${index}-${speaker}`,
                },
                signal,
              ),
            signal,
          );
          const end = offset + (span.to - span.from) / 16000;
          const clamp = (t: number) =>
            Math.max(offset, Math.min(end, offset + t));
          result = {
            start: offset,
            end,
            speaker,
            segments: reply.segments.map((s) => ({
              start: clamp(s.start),
              end: clamp(Math.max(s.start, s.end)),
              text: s.text,
            })),
            ...(reply.words
              ? {
                  words: reply.words.slice(0, 20000).map((w) => ({
                    word: w.word,
                    start: clamp(w.start),
                    end: clamp(w.end),
                  })),
                }
              : {}),
            timed: reply.timed,
            text: reply.text,
            ...(reply.language ? { language: reply.language } : {}),
          };
        }
        signal.throwIfAborted();
        await run(() =>
          this.store.putChunk(scope, id, key(index, speaker), result),
        );
        results.set(key(index, speaker), result);
      }
    };
    await run(() => this.store.update(scope, id, { status: "transcribing" }));
    await inParallel(
      Array.from({ length: count }, (_, index) => () => chunk(index)),
      this.parallel,
      signal,
    );
    let utterances = mergeUtterances(
      ...speakers.map((speaker) =>
        stitchChunks(
          Array.from(
            { length: count },
            (_, i) => results.get(key(i, speaker))!,
          ),
        ),
      ),
    );
    const languages = new Map<string, number>();
    for (const result of results.values())
      if (result.language)
        languages.set(
          result.language,
          (languages.get(result.language) ?? 0) + result.text.length,
        );
    const language = [...languages].sort((a, b) => b[1] - a[1])[0]?.[0];
    utterances = await this.voices(
      utterances,
      split ? "others" : "unknown",
      track,
      directory,
      signal,
    );
    const segments = minuteSegments(utterances, duration, {
      language: meeting.language,
      twoTrack: split,
      transcriber: transcriber.model,
    });
    signal.throwIfAborted();
    await run(() =>
      this.store.putTranscript(scope, id, segments, utterances, language),
    );
  }
  /**
   * With the diarizer on, the turns of one track learn which voice spoke
   * them. Diarization only adds detail: when the service is missing, busy
   * or failing, the meeting goes on without voices.
   */
  private async voices(
    utterances: MeetingUtterance[],
    speaker: MeetingUtterance["speaker"],
    track: (path: string) => Promise<void>,
    directory: string,
    signal: AbortSignal,
  ) {
    const config = this.diarization;
    if (!config?.enabled || !utterances.some((t) => t.speaker === speaker))
      return utterances;
    const wav = join(directory, "diarization.wav");
    const turn = this.diarizing.then(async () => {
      try {
        signal.throwIfAborted();
        await track(wav);
        return await diarize(config, wav, signal, { maxSpeakers: 20 });
      } finally {
        await rm(wav, { force: true });
      }
    });
    this.diarizing = turn.catch(() => {});
    try {
      return assignVoices(utterances, await turn, speaker);
    } catch (error) {
      if (signal.aborted) throw error;
      console.warn(
        `Meeting diarization failed: ${error instanceof Error ? error.message : "unknown"}`,
      );
      return utterances;
    }
  }
  /** FLAC when it fits one request; otherwise MP3 at 64 kb/s. */
  private async encode(
    samples: Float32Array,
    path: string,
    signal: AbortSignal,
  ): Promise<{ audio: Buffer; format: "flac" | "mp3" }> {
    const wav = `${path}.wav`;
    const budget = ((MEETING_STT_REQUEST_BYTES - 65536) * 3) / 4;
    await writeFile(wav, encodeWav(samples, 16000), { mode: 0o600 });
    try {
      for (const [format, codec] of [
        ["flac", ["-c:a", "flac"]],
        ["mp3", ["-c:a", "libmp3lame", "-b:a", "64k"]],
      ] as const) {
        const target = `${wav}.${format}`;
        try {
          await runVoiceProcess(
            "ffmpeg",
            [
              "-nostdin",
              "-v",
              "error",
              "-y",
              "-f",
              "wav",
              "-i",
              wav,
              ...codec,
              "-f",
              format,
              target,
            ],
            signal,
            60_000,
          );
          if ((await stat(target)).size <= budget)
            return { audio: await readFile(target), format };
        } finally {
          await rm(target, { force: true });
        }
      }
    } finally {
      await rm(wav, { force: true });
    }
    throw new Error("meeting_audio_invalid");
  }
  /** One whole-meeting extraction; its raw output is saved before validation. */
  private async analyze(
    access: MeetingProcessingAccess,
    meeting: Meeting,
    signal: AbortSignal,
  ) {
    const { scope, run } = access;
    const id = meeting.id;
    const segments = await run(() => this.store.allSegments(scope, id));
    const utterances = await run(() => this.store.utterances(scope, id));
    const runId = `meeting-analysis/${id}/${meeting.processingAttempt}`;
    const timeZone = access.timeZone ?? "UTC";
    const current = await run(() => this.store.get(scope, id));
    const day = meetingDay(meeting.recordedAt, timeZone);
    const input: MeetingConsolidationInput = {
      segments: segments.map((s) => ({ index: s.index, text: s.text })),
      ...(meeting.speakerChannels === "self-others" ||
      !!utterances?.utterances.some((turn) => turn.voice)
        ? { speakers: meetingSpeakerLabels(meeting.language) }
        : {}),
      meeting: {
        title: isAutomaticMeetingTitle(current.title) ? "" : current.title,
        ...day,
        timeZone,
        ...(meeting.attendees?.length ? { attendees: meeting.attendees } : {}),
        ...(meeting.companies?.length ? { companies: meeting.companies } : {}),
      },
    };
    if (JSON.stringify(input).length > MEETING_SYNTHESIS_INPUT_CHARS)
      throw new Error("meeting_consolidation_limit");
    signal.throwIfAborted();
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          MEETING_CONSOLIDATION_VERSION,
          meeting.sourceHash,
          access.analyzer!.fingerprint ?? access.analyzer!.model,
          input,
        ]),
      )
      .digest("hex");
    let raw = await run(() => this.store.synthesis(scope, id, key));
    if (raw === undefined) {
      if (input.segments.every((s) => !s.text.trim()))
        raw = {
          summary: "",
          summarySources: [],
          points: [],
          decisions: [],
          tasks: [],
          openQuestions: [],
          overflow: false,
        } satisfies MeetingSynthesisDraft;
      else
        raw = await access.analyzer!.consolidate(
          input,
          meeting.language,
          signal,
          runId,
        );
      signal.throwIfAborted();
      // Saved before validation: a retry after a validation failure never pays again.
      raw = await run(() => this.store.putSynthesis(scope, id, key, raw));
    }
    const result = validateMeetingSynthesis(raw, input, {
      utterances: utterances?.utterances,
      resolveDue: (due) => {
        const resolved = resolveDateTime(
          { when: due.when, ...(due.time ? { time: due.time } : {}) },
          { referenceNow: meeting.recordedAt, timeZone },
        );
        if (resolved.status !== "resolved") return null;
        return String(due.time ? resolved.values.iso : resolved.values.date);
      },
    });
    signal.throwIfAborted();
    // Named before publication, so the proposed tasks carry the new name.
    // A name is cosmetic: failing to make one never fails the record.
    if (
      isAutomaticMeetingTitle(current.title) &&
      result.summary.trim() &&
      access.analyzer!.name
    )
      try {
        const title = shortMeetingTitle(
          await access.analyzer!.name(
            result.summary,
            meeting.language,
            signal,
            `${runId}/name`,
          ),
        );
        signal.throwIfAborted();
        // The owner may have renamed it while the analysis ran: theirs stays.
        if (title)
          await run(() => {
            if (isAutomaticMeetingTitle(this.store.get(scope, id).title))
              this.store.update(scope, id, { title });
          });
      } catch (error) {
        if (signal.aborted) throw error;
      }
    await run(() =>
      this.store.publishRecord(scope, id, result, access.analyzer!.model, {
        timeZone,
      }),
    );
    try {
      this.onPublished?.(scope);
    } catch {
      /* Bounded discovery repairs a missed mark. */
    }
  }
  async close() {
    this.closed = true;
    for (const entry of this.active.values()) entry.controller.abort();
    await Promise.allSettled(
      [...this.active.values()].map((entry) => entry.done),
    );
  }
}
