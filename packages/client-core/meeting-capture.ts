import { z } from "zod";
import type { KeyValueStorage } from "./preferences";
import type { ClientSession } from "./session";
import type { AudioSessionCoordinator } from "../audio/coordinator";
import {
  MEETING_BLOCK_BYTES,
  MEETING_MAX_BYTES,
  MEETING_MAX_SECONDS,
  MEETING_PROFILE,
  MeetingCreateSchema,
} from "../protocol/meetings";
const EntrySchema = MeetingCreateSchema.extend({
  uri: z.string().min(1).max(2000),
  state: z.enum(["pending", "captured"]),
  interrupted: z.boolean(),
  uploaded: z.boolean(),
  durationMillis: z.number().nonnegative(),
});
export type LocalMeeting = z.infer<typeof EntrySchema>;
/** The encoder stops itself just below the server's limit, paused time excluded. */
export const MEETING_RECORD_SECONDS = MEETING_MAX_SECONDS - 2;
const importTypes: Record<string, LocalMeeting["mimeType"]> = {
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  "3gp": "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  webm: "audio/webm",
  weba: "audio/webm",
};
/** The audio container of a file brought in from elsewhere, by its extension. */
export function meetingImportType(name: string) {
  const extension = /\.([a-z0-9]{2,5})$/i.exec(name)?.[1]?.toLowerCase();
  const mimeType = extension ? importTypes[extension] : undefined;
  return extension && mimeType ? { extension, mimeType } : null;
}
const importErrors = new Set([
  "meeting_import_unsupported",
  "meeting_import_too_large",
  "meeting_import_too_long",
  "meeting_local_limit",
]);
export type MeetingCapturePorts = {
  storage: KeyValueStorage;
  coordinator: AudioSessionCoordinator;
  permission(): Promise<boolean>;
  mode(recording: boolean): Promise<void>;
  prepare(): Promise<void>;
  uri(): string | null;
  record(): void;
  /** Copies a picked file into this destination's recordings. */
  importFile(
    source: string,
    extension: string,
  ): Promise<{ uri: string; bytes: number }>;
  /** Deletes the picker's temporary copy once it is no longer needed. */
  discard(source: string): void;
  pause(): void;
  /** Continues the same file for at most the remaining seconds. */
  resume(remainingSeconds: number): void;
  stop(): Promise<string>;
  status(): { isRecording: boolean; durationMillis: number };
  valid(uri: string): boolean;
  size(uri: string): number;
  probe(uri: string): Promise<number>;
  read(uri: string, offset: number, length: number): Uint8Array;
  remove(uri: string): void;
  play?(uri: string, onFinish: () => void): { stop(): void };
};
export type MeetingCaptureState = {
  phase:
    | "loading"
    | "idle"
    | "preparing"
    | "recording"
    | "paused"
    | "importing"
    | "stopping"
    | "uploading"
    | "playback";
  entries: LocalMeeting[];
  error: string | null;
  uploadOffset: number;
};
export class MeetingCapture {
  private state: MeetingCaptureState = {
    phase: "loading",
    entries: [],
    error: null,
    uploadOffset: 0,
  };
  private listeners = new Set<() => void>();
  private active = true;
  private generation = 0;
  private owns = false;
  private current?: LocalMeeting;
  private playback?: { stop(): void };
  private playbackOwned = false;
  private playbackAttempt = 0;
  private errorRevision = 0;
  private removalError?: { id: string; revision: number };
  private readonly key: string;
  constructor(
    private identity: string,
    private ports: MeetingCapturePorts,
  ) {
    this.key = "niaro-meeting-capture/1:" + identity;
  }
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  private publish(patch: Partial<MeetingCaptureState>) {
    // Equal error text can belong to a newer operation; identity is revision-bound.
    if (Object.hasOwn(patch, "error")) this.errorRevision++;
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }
  private async save(entries: LocalMeeting[]) {
    const checked = z.array(EntrySchema).max(100).parse(entries);
    await this.ports.storage.setItem(this.key, JSON.stringify(checked));
    this.publish({ entries: checked });
  }
  activate() {
    this.active = true;
    this.generation++;
  }
  /** Invalidates a start that has not reached the native recorder yet. */
  cancelPreparing() {
    if (this.state.phase !== "preparing") return;
    this.generation++;
  }
  async restore() {
    if (this.state.phase !== "loading") return;
    try {
      const raw = await this.ports.storage.getItem(this.key);
      const entries = raw
        ? z.array(EntrySchema).max(100).parse(JSON.parse(raw))
        : [];
      if (entries.some((e) => !this.ports.valid(e.uri)))
        throw new Error("meeting_local_invalid");
      this.publish({ entries });
      // Recover only this destination's journaled files, never another account's orphan directory.
      for (const entry of entries.filter((e) => e.state === "pending")) {
        try {
          const durationMillis = await this.ports.probe(entry.uri);
          const bytes = this.ports.size(entry.uri);
          await this.save(
            this.state.entries.map((e) =>
              e.id === entry.id
                ? {
                    ...e,
                    bytes,
                    durationMillis,
                    state: "captured",
                    interrupted: true,
                  }
                : e,
            ),
          );
        } catch {
          this.publish({ error: "meeting_recovery_failed" });
        }
      }
      this.publish({ phase: "idle" });
    } catch {
      this.publish({ error: "meeting_storage_failed" });
    } // Loading remains blocked: do not overwrite a corrupt journal.
  }
  async start(id: string, title: string, language: "en" | "cs") {
    if (!this.active || this.state.phase !== "idle") return;
    if (this.state.entries.length >= 100) {
      this.publish({ error: "meeting_local_limit" });
      return;
    }
    const generation = this.generation;
    let prepared = false;
    let journaled: LocalMeeting | undefined;
    this.publish({ phase: "preparing", error: null });
    try {
      this.ports.coordinator.acquire("recording");
      this.owns = true;
      if (!(await this.ports.permission()))
        throw new Error("meeting_permission_denied");
      if (!this.active || generation !== this.generation)
        throw new Error("meeting_recording_interrupted");
      await this.ports.mode(true);
      if (!this.active || generation !== this.generation)
        throw new Error("meeting_recording_interrupted");
      await this.ports.prepare();
      prepared = true;
      if (!this.active || generation !== this.generation)
        throw new Error("meeting_recording_interrupted");
      const uri = this.ports.uri();
      if (!uri || !this.ports.valid(uri))
        throw new Error("meeting_local_invalid");
      const entry: LocalMeeting = EntrySchema.parse({
        profile: MEETING_PROFILE,
        id,
        title,
        language,
        recordedAt: new Date().toISOString(),
        mimeType: "audio/mp4",
        bytes: 1,
        uri,
        state: "pending",
        interrupted: false,
        uploaded: false,
        durationMillis: 0,
      });
      await this.save([entry, ...this.state.entries]);
      journaled = entry;
      if (!this.active || generation !== this.generation)
        throw new Error("meeting_recording_interrupted");
      this.current = entry;
      this.ports.record();
      if (!this.ports.status().isRecording)
        throw new Error("meeting_recording_failed");
      this.publish({ phase: "recording" });
    } catch (error) {
      // Reset a prepared encoder even if recording never started (e.g. journal write failed).
      if (prepared) {
        try {
          await this.ports.stop();
        } catch {}
      }
      let recording = false;
      try {
        recording = this.ports.status().isRecording;
      } catch {}
      if (!recording) {
        await this.release();
        const pending = journaled;
        if (pending) {
          try {
            await this.save(
              this.state.entries.filter((entry) => entry.id !== pending.id),
            );
            this.ports.remove(pending.uri);
          } catch {}
          if (this.current?.id === pending.id) this.current = undefined;
        }
      }
      this.publish({
        phase: recording ? "recording" : "idle",
        error:
          error instanceof Error ? error.message : "meeting_recording_failed",
      });
    }
  }
  /**
   * Brings an audio file recorded elsewhere in as a captured meeting, ready to
   * upload like a recording. Returns its id, or null with a visible error.
   */
  async importFile(
    file: { uri: string; name: string; size?: number | null },
    id: string,
    title: string,
    language: "en" | "cs",
  ) {
    if (!this.active || this.state.phase !== "idle") {
      this.ports.discard(file.uri);
      return null;
    }
    this.publish({ phase: "importing", error: null });
    let copied: string | undefined;
    try {
      const type = meetingImportType(file.name);
      if (!type) throw new Error("meeting_import_unsupported");
      if (this.state.entries.length >= 100)
        throw new Error("meeting_local_limit");
      if (file.size && file.size > MEETING_MAX_BYTES)
        throw new Error("meeting_import_too_large");
      const { uri, bytes } = await this.ports.importFile(
        file.uri,
        type.extension,
      );
      copied = uri;
      if (!this.ports.valid(uri)) throw new Error("meeting_local_invalid");
      if (bytes > MEETING_MAX_BYTES)
        throw new Error("meeting_import_too_large");
      let durationMillis = 0;
      try {
        durationMillis = await this.ports.probe(uri);
      } catch {
        // The server measures every format itself; this device may not play some.
      }
      if (durationMillis > MEETING_MAX_SECONDS * 1000)
        throw new Error("meeting_import_too_long");
      const entry = EntrySchema.parse({
        profile: MEETING_PROFILE,
        id,
        title,
        language,
        recordedAt: new Date().toISOString(),
        mimeType: type.mimeType,
        bytes,
        uri,
        state: "captured",
        interrupted: false,
        uploaded: false,
        durationMillis,
      });
      await this.save([entry, ...this.state.entries]);
      return entry.id;
    } catch (error) {
      if (copied)
        try {
          this.ports.remove(copied);
        } catch {}
      this.publish({
        error:
          error instanceof Error && importErrors.has(error.message)
            ? error.message
            : "meeting_import_failed",
      });
      return null;
    } finally {
      this.ports.discard(file.uri);
      this.publish({ phase: "idle" });
    }
  }
  private async release() {
    if (!this.owns) return;
    try {
      await this.ports.mode(false);
    } catch {}
    this.ports.coordinator.release("recording");
    this.owns = false;
  }
  /** Holds the microphone and the file; Stop still finishes the recording. */
  pause() {
    if (this.state.phase !== "recording") return;
    try {
      this.ports.pause();
      if (this.ports.status().isRecording)
        throw new Error("meeting_recording_failed");
      this.publish({ phase: "paused", error: null });
    } catch {
      this.publish({ error: "meeting_recording_failed" });
    }
  }
  resume() {
    if (!this.active || this.state.phase !== "paused") return;
    try {
      const recorded = this.ports.status().durationMillis / 1000;
      this.ports.resume(Math.max(1, MEETING_RECORD_SECONDS - recorded));
      if (!this.ports.status().isRecording)
        throw new Error("meeting_recording_failed");
      this.publish({ phase: "recording", error: null });
    } catch {
      this.publish({ error: "meeting_recording_failed" });
    }
  }
  async stop(interrupted = false) {
    if (this.state.phase !== "recording" && this.state.phase !== "paused")
      return;
    this.publish({ phase: "stopping" });
    try {
      const durationMillis = this.ports.status().durationMillis;
      const uri = await this.ports.stop();
      if (!this.current || uri !== this.current.uri)
        throw new Error("meeting_recording_failed");
      const bytes = this.ports.size(uri);
      if (
        bytes <= 0 ||
        bytes > MEETING_MAX_BYTES ||
        durationMillis > MEETING_MAX_SECONDS * 1000
      )
        throw new Error("meeting_recording_limit");
      await this.ports.probe(uri);
      const id = this.current.id;
      await this.save(
        this.state.entries.map((e) =>
          e.id === id
            ? { ...e, bytes, durationMillis, state: "captured", interrupted }
            : e,
        ),
      );
      this.current = undefined;
      this.publish({
        error: interrupted ? "meeting_recording_interrupted" : null,
      });
    } catch {
      this.publish({ error: "meeting_recording_failed" });
    } finally {
      let running = false;
      try {
        running = this.ports.status().isRecording;
      } catch {}
      if (!running) await this.release();
      this.publish({ phase: running ? "recording" : "idle" });
    }
  }
  async finishNative(interrupted = true) {
    if (
      (this.state.phase !== "recording" && this.state.phase !== "paused") ||
      !this.current
    )
      return;
    this.publish({ phase: "stopping" });
    try {
      const current = this.current;
      const bytes = this.ports.size(current.uri);
      const durationMillis = await this.ports.probe(current.uri);
      if (
        !bytes ||
        bytes > MEETING_MAX_BYTES ||
        durationMillis > MEETING_MAX_SECONDS * 1000
      )
        throw new Error("meeting_recording_limit");
      await this.save(
        this.state.entries.map((e) =>
          e.id === current.id
            ? { ...e, bytes, durationMillis, state: "captured", interrupted }
            : e,
        ),
      );
      this.current = undefined;
      this.publish({
        error: interrupted ? "meeting_recording_interrupted" : null,
      });
    } catch {
      this.publish({ error: "meeting_recovery_failed" });
    } finally {
      await this.release();
      this.publish({ phase: "idle" });
    }
  }
  async upload(id: string, session: ClientSession) {
    if (
      !this.active ||
      this.state.phase !== "idle" ||
      session.identityKey !== this.identity
    )
      return;
    const entry = this.state.entries.find((e) => e.id === id);
    if (!entry || entry.state !== "captured") return;
    this.publish({ phase: "uploading", error: null, uploadOffset: 0 });
    try {
      if (this.ports.size(entry.uri) !== entry.bytes)
        throw new Error("meeting_local_invalid");
      const input = MeetingCreateSchema.parse(
        Object.fromEntries(
          Object.keys(MeetingCreateSchema.shape).map((key) => [
            key,
            entry[key as keyof LocalMeeting],
          ]),
        ),
      );
      let meeting = await session.createMeeting(input);
      while (meeting.status === "uploading" && meeting.offset < entry.bytes) {
        if (!this.active) throw new Error("meeting_upload_interrupted");
        const block = this.ports.read(
          entry.uri,
          meeting.offset,
          Math.min(MEETING_BLOCK_BYTES, entry.bytes - meeting.offset),
        );
        const before = meeting.offset;
        meeting = await session.uploadMeetingBlock(id, before, block);
        if (meeting.offset <= before || meeting.offset > entry.bytes)
          throw new Error("meeting_upload_conflict");
        this.publish({ uploadOffset: meeting.offset });
      }
      if (!this.active) throw new Error("meeting_upload_interrupted");
      meeting = await session.sealMeeting(id);
      await this.save(
        this.state.entries.map((e) =>
          e.id === id ? { ...e, uploaded: true } : e,
        ),
      );
      if (meeting.status === "sealed") await session.processMeeting(id);
    } catch (error) {
      this.publish({
        error:
          error instanceof Error ? error.message : "meeting_connection_failed",
      });
    } finally {
      this.publish({ phase: "idle" });
    }
  }
  async play(id: string) {
    if (!this.active || this.state.phase !== "idle" || !this.ports.play) return;
    const entry = this.state.entries.find(
      (e) => e.id === id && e.state === "captured",
    );
    if (!entry) return;
    const generation = this.generation;
    const attempt = ++this.playbackAttempt;
    try {
      this.ports.coordinator.acquire("playback");
      this.playbackOwned = true;
      this.publish({ phase: "playback", error: null });
      await this.ports.mode(false);
      if (
        !this.active ||
        generation !== this.generation ||
        attempt !== this.playbackAttempt ||
        !this.playbackOwned
      )
        return;
      this.playback = this.ports.play(entry.uri, () => this.stopPlayback());
    } catch {
      this.stopPlayback();
      this.publish({ error: "meeting_playback_failed" });
    }
  }
  stopPlayback() {
    this.playbackAttempt++;
    try {
      this.playback?.stop();
    } finally {
      this.playback = undefined;
      if (this.playbackOwned) this.ports.coordinator.release("playback");
      this.playbackOwned = false;
      if (this.state.phase === "playback") this.publish({ phase: "idle" });
    }
  }
  async recover(id: string) {
    if (this.state.phase !== "idle") return;
    const entry = this.state.entries.find(
      (e) => e.id === id && e.state === "pending",
    );
    if (!entry) return;
    this.publish({ phase: "stopping", error: null });
    try {
      const durationMillis = await this.ports.probe(entry.uri);
      const bytes = this.ports.size(entry.uri);
      await this.save(
        this.state.entries.map((e) =>
          e.id === id
            ? {
                ...e,
                bytes,
                durationMillis,
                state: "captured",
                interrupted: true,
              }
            : e,
        ),
      );
    } catch {
      this.publish({ error: "meeting_recovery_failed" });
    } finally {
      this.publish({ phase: "idle" });
    }
  }
  async remove(id: string) {
    if (this.state.phase !== "idle") return;
    const entry = this.state.entries.find((e) => e.id === id);
    if (!entry) return;
    const errorRevision = this.errorRevision;
    const ownedError = this.removalError;
    try {
      this.ports.remove(entry.uri);
      await this.save(this.state.entries.filter((e) => e.id !== id));
      if (
        ownedError?.id === id &&
        this.removalError === ownedError &&
        this.errorRevision === ownedError.revision
      ) {
        this.removalError = undefined;
        this.publish({ error: null });
      }
    } catch {
      if (this.errorRevision === errorRevision) {
        this.publish({ error: "meeting_storage_failed" });
        this.removalError = { id, revision: this.errorRevision };
      }
    }
  }
  dispose() {
    this.active = false;
    this.generation++;
    this.stopPlayback();
    if (this.state.phase === "recording" || this.state.phase === "paused")
      void this.stop(true);
  }
}
