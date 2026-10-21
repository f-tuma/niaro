import type { ClientSession } from "../../../../packages/client-core/session";
import {
  MEETING_BLOCK_BYTES,
  MEETING_MAX_BYTES,
  MEETING_MAX_SECONDS,
  MEETING_PROFILE,
  MeetingCreateSchema,
  type Meeting,
  type MeetingCreate,
} from "../../../../packages/protocol/meetings";
import { extractMp4Audio, isMp4Family } from "./meeting-mp4-audio";

/**
 * Meetings recorded or picked in the browser. Like chat caches, everything
 * stays in this page's memory: a recording lives here until the server has
 * it, and leaving the page asks first while anything is unsent.
 */

/** Stops itself just below the server's two-hour limit, paused time excluded. */
export const WEB_RECORD_SECONDS = MEETING_MAX_SECONDS - 2;
/** Room for the final buffered second and the container's tail. */
const BYTE_MARGIN = 1024 * 1024;

export type CaptureSource = "microphone" | "meeting";
export type RecorderPhase =
  | "idle"
  | "preparing"
  | "recording"
  | "paused"
  | "stopping";
export type LocalCapture = Readonly<{
  id: string;
  identityKey: string;
  input: MeetingCreate;
  blob: Blob;
  origin: "recording" | "file";
  phase: "waiting" | "uploading" | "failed";
  /** Bytes the server confirmed. */
  uploaded: number;
  error: string | null;
}>;
export type CaptureSnapshot = Readonly<{
  phase: RecorderPhase;
  source: CaptureSource | null;
  identityKey: string | null;
  /** Recorded time, paused time excluded. */
  elapsedMs: number;
  /** 0–1 input levels; `others` only while recording a meeting. */
  levels: { self: number; others: number | null };
  /** The shared tab or window stopped sharing; the microphone continues. */
  meetingAudioLost: boolean;
  error: string | null;
  captures: readonly LocalCapture[];
}>;

/** The browser APIs a recording needs; tests replace them. */
export type CapturePorts = {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  getDisplayMedia(options: DisplayMediaStreamOptions): Promise<MediaStream>;
  audioContext(): AudioContext;
  recorder(stream: MediaStream, options: MediaRecorderOptions): MediaRecorder;
  supported(type: string): boolean;
  now(): number;
  uuid(): string;
  every(fn: () => void, ms: number): () => void;
};

export function browserCapturePorts(): CapturePorts {
  return {
    getUserMedia: (constraints) =>
      navigator.mediaDevices.getUserMedia(constraints),
    getDisplayMedia: (options) =>
      navigator.mediaDevices.getDisplayMedia(options),
    audioContext: () => new AudioContext(),
    recorder: (stream, options) => new MediaRecorder(stream, options),
    supported: (type) =>
      typeof MediaRecorder !== "undefined" &&
      MediaRecorder.isTypeSupported(type),
    now: () => Date.now(),
    uuid: () => crypto.randomUUID(),
    every: (fn, ms) => {
      const timer = setInterval(fn, ms);
      return () => clearInterval(timer);
    },
  };
}

/** Recording formats the server decodes, in order of preference. */
const FORMATS = [
  { type: "audio/webm;codecs=opus", mimeType: "audio/webm" },
  { type: "audio/ogg;codecs=opus", mimeType: "audio/ogg" },
  { type: "audio/mp4;codecs=mp4a.40.2", mimeType: "audio/mp4" },
  { type: "audio/mp4", mimeType: "audio/mp4" },
] as const;
export function recordingFormat(supported: (type: string) => boolean) {
  return FORMATS.find((format) => supported(format.type)) ?? null;
}

/** Whether this browser can record at all, and share a meeting's audio. */
export function captureSupport() {
  const media = typeof navigator !== "undefined" && navigator.mediaDevices;
  return {
    microphone:
      !!media &&
      typeof media.getUserMedia === "function" &&
      typeof MediaRecorder !== "undefined",
    meeting: !!media && typeof media.getDisplayMedia === "function",
  };
}

const importTypes: Record<string, MeetingCreate["mimeType"]> = {
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  m4v: "audio/mp4",
  mov: "audio/mp4",
  "3gp": "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  webm: "audio/webm",
  weba: "audio/webm",
  mkv: "audio/webm",
};
/** What the file picker offers: audio, and the video recordings of calls. */
export const IMPORT_ACCEPT = Object.keys(importTypes)
  .map((extension) => `.${extension}`)
  .join(",");
/** The server's demuxer for a file, by its extension. */
export function importType(name: string) {
  const extension = /\.([a-z0-9]{2,5})$/i.exec(name)?.[1]?.toLowerCase();
  return extension ? (importTypes[extension] ?? null) : null;
}

/**
 * A picked recording as something the server accepts. A video larger than
 * the limit (an MP4 from Teams, Zoom, Meet or Slack) uploads only its sound
 * track, copied without re-encoding.
 */
export async function prepareImport(file: File) {
  const mimeType = importType(file.name);
  if (!mimeType) throw new Error("meeting_import_unsupported");
  if (file.size <= MEETING_MAX_BYTES) return { blob: file as Blob, mimeType };
  if (!isMp4Family(file.name)) throw new Error("meeting_import_too_large");
  let audio: Blob;
  try {
    audio = await extractMp4Audio(file);
  } catch {
    throw new Error("meeting_import_too_large");
  }
  if (audio.size > MEETING_MAX_BYTES)
    throw new Error("meeting_import_too_large");
  return { blob: audio, mimeType: "audio/mp4" as const };
}

/** A failure as a code the copy knows; anything else is generic. */
export function captureError(error: unknown, fallback: string) {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError")
      return "meeting_permission_denied";
    if (error.name === "NotFoundError") return "meeting_microphone_missing";
  }
  const code = error instanceof Error ? error.message : "";
  return /^meeting_[a-z_]+$/.test(code) ? code : fallback;
}

type Live = {
  recorder: MediaRecorder;
  context: AudioContext;
  streams: MediaStream[];
  analysers: { self: AnalyserNode; others: AnalyserNode | null };
  chunks: Blob[];
  bytes: number;
  input: Omit<MeetingCreate, "bytes">;
  mimeType: string;
  startedAt: number;
  recordedMs: number;
  stopTicker(): void;
  stopped: Promise<void>;
};

const initial: CaptureSnapshot = {
  phase: "idle",
  source: null,
  identityKey: null,
  elapsedMs: 0,
  levels: { self: 0, others: null },
  meetingAudioLost: false,
  error: null,
  captures: [],
};

function level(analyser: AnalyserNode, buffer: Float32Array<ArrayBuffer>) {
  analyser.getFloatTimeDomainData(buffer);
  let energy = 0;
  for (const sample of buffer) energy += sample * sample;
  // Speech sits around 0.02–0.2 RMS; a square root spreads it over the meter.
  return Math.min(1, Math.sqrt(Math.sqrt(energy / buffer.length) * 4));
}

export class MeetingCaptureStore {
  private state: CaptureSnapshot = initial;
  private listeners = new Set<() => void>();
  private live: Live | null = null;
  /** Each start owns its attempt; a cancelled prompt can't start later. */
  private attempt = 0;
  constructor(private ports: CapturePorts) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<CaptureSnapshot>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private patchCapture(id: string, patch: Partial<LocalCapture>) {
    this.publish({
      captures: this.state.captures.map((capture) =>
        capture.id === id ? { ...capture, ...patch } : capture,
      ),
    });
  }
  /** Something would be lost by closing the page. */
  get unsaved() {
    return this.state.phase !== "idle" || this.state.captures.length > 0;
  }
  private elapsed(live: Live) {
    return (
      live.recordedMs +
      (this.state.phase === "recording" ? this.ports.now() - live.startedAt : 0)
    );
  }

  /**
   * Starts recording the microphone, or the microphone and a shared meeting
   * tab as two channels (left: the person, right: everyone else). Call it
   * straight from a click: browsers only open the share picker for one.
   */
  async start(
    source: CaptureSource,
    identityKey: string,
    language: "en" | "cs",
    title: string,
    /** The person confirmed the others know; stored with the meeting. */
    consent?: MeetingCreate["consent"],
  ) {
    if (this.state.phase !== "idle") return;
    const attempt = ++this.attempt;
    const format = recordingFormat(this.ports.supported);
    this.publish({
      phase: "preparing",
      source,
      identityKey,
      error: null,
      elapsedMs: 0,
      meetingAudioLost: false,
      levels: { self: 0, others: source === "meeting" ? 0 : null },
    });
    const streams: MediaStream[] = [];
    let context: AudioContext | null = null;
    try {
      if (!format) throw new Error("meeting_browser_unsupported");
      let shared: MediaStreamTrack | null = null;
      if (source === "meeting") {
        // The share picker first: it needs the click's user activation.
        const display = await this.ports
          .getDisplayMedia({
            video: true,
            audio: {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            },
            // Chrome hints: offer tabs with their audio, never this page.
            ...({
              preferCurrentTab: false,
              selfBrowserSurface: "exclude",
              systemAudio: "include",
              surfaceSwitching: "include",
            } as object),
          })
          .catch((error: unknown) => {
            // Closing the picker is a choice, not a failure.
            throw error instanceof DOMException &&
              (error.name === "NotAllowedError" || error.name === "AbortError")
              ? new Error("meeting_share_cancelled")
              : error;
          });
        streams.push(display);
        // Only the sound is recorded; the picture is never kept.
        for (const track of display.getVideoTracks()) track.stop();
        shared = display.getAudioTracks()[0] ?? null;
        if (!shared) throw new Error("meeting_share_no_audio");
      }
      const microphone = await this.ports.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streams.push(microphone);
      if (attempt !== this.attempt)
        throw new Error("meeting_recording_interrupted");
      context = this.ports.audioContext();
      const destination = context.createMediaStreamDestination();
      const self = context.createMediaStreamSource(microphone);
      const selfMeter = context.createAnalyser();
      self.connect(selfMeter);
      let othersMeter: AnalyserNode | null = null;
      if (shared) {
        // Two channels, never a mix: the server transcribes each on its own
        // and labels who spoke.
        destination.channelCount = 2;
        destination.channelCountMode = "explicit";
        destination.channelInterpretation = "discrete";
        const merger = context.createChannelMerger(2);
        const others = context.createMediaStreamSource(
          new MediaStream([shared]),
        );
        othersMeter = context.createAnalyser();
        others.connect(othersMeter);
        self.connect(merger, 0, 0);
        others.connect(merger, 0, 1);
        merger.connect(destination);
        shared.addEventListener("ended", () => {
          if (this.live && this.state.phase !== "stopping")
            this.publish({ meetingAudioLost: true });
        });
      } else {
        destination.channelCount = 1;
        self.connect(destination);
      }
      await context.resume();
      const recorder = this.ports.recorder(destination.stream, {
        mimeType: format.type,
        audioBitsPerSecond: shared ? 64000 : 48000,
      });
      let resolveStopped!: () => void;
      const live: Live = {
        recorder,
        context,
        streams,
        analysers: { self: selfMeter, others: othersMeter },
        chunks: [],
        bytes: 0,
        input: {
          profile: MEETING_PROFILE,
          id: this.ports.uuid(),
          title,
          recordedAt: new Date(this.ports.now()).toISOString(),
          language,
          mimeType: format.mimeType,
          ...(shared ? { speakerChannels: "self-others" as const } : {}),
          ...(consent ? { consent } : {}),
        },
        mimeType: format.mimeType,
        startedAt: this.ports.now(),
        recordedMs: 0,
        stopTicker: () => {},
        stopped: new Promise((resolve) => {
          resolveStopped = resolve;
        }),
      };
      recorder.addEventListener("dataavailable", (event) => {
        if (!event.data.size) return;
        live.chunks.push(event.data);
        live.bytes += event.data.size;
        if (live.bytes > MEETING_MAX_BYTES - BYTE_MARGIN)
          void this.stop("meeting_recording_limit");
      });
      recorder.addEventListener("stop", () => resolveStopped());
      for (const track of microphone.getAudioTracks())
        track.addEventListener("ended", () => {
          void this.stop("meeting_recording_interrupted");
        });
      this.live = live;
      recorder.start(1000);
      const buffer = new Float32Array(selfMeter.fftSize);
      live.stopTicker = this.ports.every(() => {
        if (this.live !== live) return;
        const elapsedMs = this.elapsed(live);
        if (elapsedMs >= WEB_RECORD_SECONDS * 1000) {
          void this.stop("meeting_recording_limit");
          return;
        }
        const recording = this.state.phase === "recording";
        this.publish({
          elapsedMs,
          levels: {
            self: recording ? level(selfMeter, buffer) : 0,
            others: othersMeter
              ? recording
                ? level(othersMeter, buffer)
                : 0
              : null,
          },
        });
      }, 100);
      this.publish({ phase: "recording" });
    } catch (error) {
      for (const stream of streams)
        for (const track of stream.getTracks()) track.stop();
      void context?.close().catch(() => {});
      const code = captureError(error, "meeting_recording_failed");
      if (attempt === this.attempt)
        this.publish({
          ...initial,
          captures: this.state.captures,
          error: code === "meeting_share_cancelled" ? null : code,
        });
    }
  }

  /** Holds the microphone and the share; nothing is recorded meanwhile. */
  pause() {
    const live = this.live;
    if (!live || this.state.phase !== "recording") return;
    live.recorder.pause();
    live.recordedMs += this.ports.now() - live.startedAt;
    this.publish({
      phase: "paused",
      elapsedMs: live.recordedMs,
      levels: { self: 0, others: live.analysers.others ? 0 : null },
    });
  }
  resume() {
    const live = this.live;
    if (!live || this.state.phase !== "paused") return;
    live.recorder.resume();
    live.startedAt = this.ports.now();
    this.publish({ phase: "recording" });
  }

  /** Finishes the file and keeps it for upload; returns its id. */
  async stop(reason: string | null = null) {
    const live = this.live;
    if (
      !live ||
      (this.state.phase !== "recording" && this.state.phase !== "paused")
    )
      return null;
    const elapsedMs = this.elapsed(live);
    this.publish({ phase: "stopping", elapsedMs });
    live.stopTicker();
    if (live.recorder.state !== "inactive") live.recorder.stop();
    await live.stopped;
    for (const stream of live.streams)
      for (const track of stream.getTracks()) track.stop();
    void live.context.close().catch(() => {});
    this.live = null;
    const blob = new Blob(live.chunks, { type: live.mimeType });
    const identityKey = this.state.identityKey ?? "";
    const done = { ...initial, captures: this.state.captures };
    if (!blob.size || blob.size > MEETING_MAX_BYTES) {
      this.publish({
        ...done,
        error: blob.size
          ? "meeting_recording_limit"
          : "meeting_recording_failed",
      });
      return null;
    }
    const capture: LocalCapture = {
      id: live.input.id,
      identityKey,
      input: MeetingCreateSchema.parse({ ...live.input, bytes: blob.size }),
      blob,
      origin: "recording",
      phase: "waiting",
      uploaded: 0,
      error: null,
    };
    this.publish({
      ...done,
      error: reason,
      captures: [capture, ...this.state.captures],
    });
    return capture.id;
  }

  /** A recording made elsewhere, ready to upload like a recording. */
  async addFile(
    file: File,
    identityKey: string,
    language: "en" | "cs",
    title: string,
  ) {
    try {
      const { blob, mimeType } = await prepareImport(file);
      const id = this.ports.uuid();
      const capture: LocalCapture = {
        id,
        identityKey,
        input: MeetingCreateSchema.parse({
          profile: MEETING_PROFILE,
          id,
          title,
          recordedAt: new Date(
            file.lastModified || this.ports.now(),
          ).toISOString(),
          language,
          mimeType,
          bytes: blob.size,
        }),
        blob,
        origin: "file",
        phase: "waiting",
        uploaded: 0,
        error: null,
      };
      this.publish({
        error: null,
        captures: [capture, ...this.state.captures],
      });
      return id;
    } catch (error) {
      this.publish({ error: captureError(error, "meeting_import_failed") });
      return null;
    }
  }

  /**
   * Sends a kept recording in 256 KiB blocks and starts its processing. A
   * retry continues where the server stopped; the same id never uploads
   * twice. Returns the meeting once the server has it.
   */
  async upload(id: string, session: ClientSession): Promise<Meeting | null> {
    const capture = this.state.captures.find((entry) => entry.id === id);
    if (
      !capture ||
      capture.phase === "uploading" ||
      capture.identityKey !== session.identityKey
    )
      return null;
    this.patchCapture(id, { phase: "uploading", error: null });
    try {
      const size = capture.blob.size;
      let meeting = await session.createMeeting(capture.input);
      this.patchCapture(id, { uploaded: meeting.offset });
      while (meeting.status === "uploading" && meeting.offset < size) {
        const before = meeting.offset;
        const block = new Uint8Array(
          await capture.blob
            .slice(before, Math.min(size, before + MEETING_BLOCK_BYTES))
            .arrayBuffer(),
        );
        meeting = await session.uploadMeetingBlock(id, before, block);
        if (meeting.offset <= before || meeting.offset > size)
          throw new Error("meeting_upload_conflict");
        this.patchCapture(id, { uploaded: meeting.offset });
      }
      // A retry after the server has sealed it goes on from there: sealing
      // again rereads the whole recording, and fails once its sound is gone.
      if (meeting.status === "uploading")
        meeting = await session.sealMeeting(id);
      if (meeting.status === "sealed")
        meeting = await session.processMeeting(id);
      this.publish({
        captures: this.state.captures.filter((entry) => entry.id !== id),
      });
      return meeting;
    } catch (error) {
      this.patchCapture(id, {
        phase: "failed",
        error: captureError(error, "meeting_connection_failed"),
      });
      return null;
    }
  }

  /** Forgets a kept recording that was never sent. */
  discard(id: string) {
    const capture = this.state.captures.find((entry) => entry.id === id);
    if (!capture || capture.phase === "uploading") return;
    this.publish({
      captures: this.state.captures.filter((entry) => entry.id !== id),
    });
  }

  clearError() {
    if (this.state.error) this.publish({ error: null });
  }
}

/** The page's one recorder: a recording continues across the app's pages. */
let shared: MeetingCaptureStore | null = null;
export function meetingCaptureStore() {
  if (!shared) {
    shared = new MeetingCaptureStore(browserCapturePorts());
    const store = shared;
    if (typeof window !== "undefined")
      window.addEventListener("beforeunload", (event) => {
        if (store.unsaved) event.preventDefault();
      });
  }
  return shared;
}

/** A file name for saving a kept recording. */
export function captureFileName(capture: LocalCapture) {
  const extension = {
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mp4": "m4a",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
  }[capture.input.mimeType];
  const date = capture.input.recordedAt.slice(0, 16).replace(/[T:]/g, "-");
  return `meeting-${date}.${extension}`;
}
