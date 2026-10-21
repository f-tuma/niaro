import type { KeyValueStorage } from "../../packages/client-core/preferences";
import type { TranslationKey } from "../../packages/i18n";
import { AudioSessionCoordinator } from "./coordinator";

import {
  JOURNAL_KEY,
  RECORDING_KEY,
  RecordingSchema,
  JournalSchema,
  withEntry,
  type Journal,
  type LocalRecording,
  type RecoveryCandidate,
} from "./journal";
export { RECORDING_KEY, JOURNAL_KEY } from "./journal";
export type { LocalRecording } from "./journal";
export interface RecorderPort {
  prepare(): Promise<void>;
  uri(): string | null;
  record(): void;
  stop(): Promise<string>;
  status(): {
    isRecording: boolean;
    canRecord: boolean;
    durationMillis: number;
  };
}
export interface AudioPorts {
  recorder: RecorderPort;
  permission(): Promise<boolean>;
  mode(recording: boolean): Promise<void>;
  inspect(uri: string): number;
  valid(uri: string): boolean;
  list(): string[];
  probe(uri: string): Promise<number>;
  storage: KeyValueStorage;
}
interface State {
  phase:
    | "loading"
    | "idle"
    | "preparing"
    | "recording"
    | "stopping"
    | "recovering";
  candidates: RecoveryCandidate[];
  storageBlocked: boolean;
  saved?: LocalRecording;
  message?: TranslationKey;
}
/** Local diagnostic session; has no network or business command dependency. */
export class RecorderSession {
  private state: State = {
    phase: "loading",
    candidates: [],
    storageBlocked: false,
  };
  private journal: Journal = { version: 1, entries: [] };
  private restoring?: Promise<void>;
  private listeners = new Set<() => void>();
  private coordinator = new AudioSessionCoordinator();
  private foreground = true;
  private cancelled = false;
  private stopping?: Promise<void>;
  constructor(private ports: AudioPorts) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  restore(): Promise<void> {
    if (this.restoring) return this.restoring;
    if (this.state.phase !== "loading" && !this.state.storageBlocked)
      return Promise.resolve();
    this.update({ phase: "loading" });
    this.restoring = this.load().finally(() => {
      this.restoring = undefined;
    });
    return this.restoring;
  }
  private async commit(next: Journal) {
    await this.ports.storage.setItem(JOURNAL_KEY, JSON.stringify(next));
    this.journal = next;
  }
  private async load() {
    try {
      const raw = await this.ports.storage.getItem(JOURNAL_KEY);
      if (raw !== null) this.journal = JournalSchema.parse(JSON.parse(raw));
      else {
        const legacy = await this.ports.storage.getItem(RECORDING_KEY);
        const saved =
          legacy !== null
            ? RecordingSchema.parse(JSON.parse(legacy))
            : undefined;
        this.journal = {
          version: 1,
          entries: saved
            ? [{ uri: saved.uri, status: "finished", startedAt: 0 }]
            : [],
          ...(saved ? { saved } : {}),
        };
      }
      const uris = [
        ...this.journal.entries.map((entry) => entry.uri),
        ...(this.journal.saved ? [this.journal.saved.uri] : []),
      ];
      if (uris.some((uri) => !this.ports.valid(uri)))
        throw new Error("unsafe_journal_path");
      this.update({
        storageBlocked: false,
        saved: undefined,
        message: undefined,
      });
    } catch {
      this.update({
        phase: "idle",
        storageBlocked: true,
        message: "audioJournalError",
      });
      return;
    }
    const saved = this.journal.saved;
    if (saved) {
      try {
        if (this.ports.inspect(saved.uri) <= 0) throw new Error("missing_file");
        this.update({ saved, message: "audioRestored" });
      } catch {
        this.update({ message: "audioRestoreError" });
      }
    }
    try {
      this.discover();
    } catch {
      this.update({ message: "audioDiscoveryError" });
    }
    this.update({ phase: "idle" });
  }
  private discover() {
    const pending = this.journal.entries
      .filter((entry) => entry.status === "pending")
      .map((entry) => entry.uri);
    const uris = [...new Set([...pending, ...this.ports.list()])];
    const candidates: RecoveryCandidate[] = [];
    for (const uri of uris) {
      if (!this.ports.valid(uri) || uri === this.journal.saved?.uri) continue;
      const entry = this.journal.entries.find((item) => item.uri === uri);
      if (entry && entry.status !== "pending") continue;
      let bytes = 0;
      try {
        bytes = this.ports.inspect(uri);
      } catch {
        /* Offered as missing. */
      }
      candidates.push({
        uri,
        bytes,
        reason: entry ? "unfinished" : "unindexed",
        status: bytes > 0 ? "unchecked" : "missing",
      });
    }
    this.update({ candidates });
  }
  private candidate(patch: RecoveryCandidate) {
    this.update({
      candidates: this.state.candidates.map((item) =>
        item.uri === patch.uri ? patch : item,
      ),
    });
  }
  async check(uri: string) {
    const item = this.state.candidates.find((item) => item.uri === uri);
    if (
      !item ||
      this.state.phase !== "idle" ||
      this.state.storageBlocked ||
      !this.foreground
    )
      return;
    this.update({ phase: "recovering", message: undefined });
    this.candidate({ ...item, status: "checking" });
    try {
      const bytes = this.ports.inspect(uri);
      if (bytes <= 0) {
        this.candidate({ ...item, bytes: 0, status: "missing" });
        return;
      }
      const durationMillis = await this.ports.probe(uri);
      if (!Number.isFinite(durationMillis) || durationMillis <= 0)
        throw new Error("unreadable");
      this.candidate({ ...item, bytes, durationMillis, status: "ready" });
    } catch {
      this.candidate({ ...item, status: "unreadable" });
    } finally {
      this.update({ phase: "idle" });
    }
  }
  async recover(uri: string) {
    const item = this.state.candidates.find((item) => item.uri === uri);
    if (
      !item ||
      item.status !== "ready" ||
      this.state.phase !== "idle" ||
      this.state.storageBlocked ||
      !this.foreground
    )
      return;
    this.update({ phase: "recovering", message: undefined });
    try {
      const bytes = this.ports.inspect(uri);
      if (bytes !== item.bytes || bytes <= 0) throw new Error("file_changed");
      const saved = RecordingSchema.parse({
        uri,
        bytes,
        durationMillis: await this.ports.probe(uri),
        interrupted: true,
      });
      if (saved.durationMillis <= 0 || this.ports.inspect(uri) !== bytes)
        throw new Error("file_changed");
      try {
        await this.commit({
          ...withEntry(this.journal, uri, "finished"),
          saved,
        });
      } catch {
        this.update({ message: "audioRecoverySaveError" });
        return;
      }
      this.update({
        saved,
        candidates: this.state.candidates.filter((entry) => entry.uri !== uri),
        message: "audioRecovered",
      });
    } catch {
      this.candidate({ ...item, status: "unreadable" });
    } finally {
      this.update({ phase: "idle" });
    }
  }
  async ignore(uri: string) {
    if (
      this.state.phase !== "idle" ||
      this.state.storageBlocked ||
      !this.state.candidates.some((item) => item.uri === uri)
    )
      return;
    this.update({ phase: "recovering", message: undefined });
    try {
      await this.commit(withEntry(this.journal, uri, "ignored"));
      this.update({
        candidates: this.state.candidates.filter((item) => item.uri !== uri),
        message: "audioHidden",
      });
    } catch {
      this.update({ message: "audioRecoverySaveError" });
    } finally {
      this.update({ phase: "idle" });
    }
  }
  setForeground(active: boolean) {
    this.foreground = active;
    if (!active) {
      this.cancelled = true;
      void this.stop(true);
    }
  }
  async start() {
    if (
      this.state.phase !== "idle" ||
      !this.foreground ||
      this.state.storageBlocked
    )
      return;
    this.cancelled = false;
    this.coordinator.acquire("recording");
    this.update({ phase: "preparing", message: undefined });
    let prepared = false;
    let started = false;
    let journalFailed = false;
    try {
      if (!(await this.ports.permission())) {
        this.update({ message: "audioDenied" });
        return;
      }
      if (!this.foreground || this.cancelled) throw new Error("interrupted");
      await this.ports.mode(true);
      await this.ports.recorder.prepare();
      prepared = true;
      if (!this.foreground || this.cancelled) throw new Error("interrupted");
      const uri = this.ports.recorder.uri();
      if (!uri || !this.ports.valid(uri))
        throw new Error("missing_recording_path");
      try {
        await this.commit(withEntry(this.journal, uri, "pending"));
      } catch {
        journalFailed = true;
        throw new Error("journal_write_failed");
      }
      if (!this.foreground || this.cancelled) throw new Error("interrupted");
      this.ports.recorder.record();
      if (!this.ports.recorder.status().isRecording)
        throw new Error("not_recording");
      started = true;
      this.update({ phase: "recording" });
    } catch {
      if (prepared) {
        try {
          await this.ports.recorder.stop();
        } catch {
          /* No saved-file claim. */
        }
      }
      this.update({
        message: journalFailed
          ? "audioJournalWriteError"
          : this.cancelled
            ? "audioInterrupted"
            : "audioError",
      });
    } finally {
      if (!started) {
        const native = this.ports.recorder.status();
        if (native.isRecording || native.canRecord) {
          this.update({ phase: "recording", message: "audioError" });
        } else {
          this.coordinator.release("recording");
          try {
            await this.ports.mode(false);
          } catch {
            this.update({ message: "audioError" });
          }
          this.update({ phase: "idle" });
        }
      }
    }
  }
  stop(interrupted = false): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.state.phase !== "recording") return Promise.resolve();
    this.update({ phase: "stopping" });
    this.stopping = this.finish(interrupted).finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }
  private async finish(interrupted: boolean) {
    const durationMillis = this.ports.recorder.status().durationMillis;
    try {
      const uri = await this.ports.recorder.stop();
      const saved = RecordingSchema.parse({
        uri,
        durationMillis,
        bytes: this.ports.inspect(uri),
        interrupted,
      });
      this.update({
        saved,
        message: interrupted ? "audioInterrupted" : "audioSaved",
      });
      try {
        await this.commit({
          ...withEntry(this.journal, uri, "finished"),
          saved,
        });
      } catch {
        this.update({ message: "audioPersistenceError" });
      }
    } catch {
      this.update({ message: "audioError" });
    } finally {
      const native = this.ports.recorder.status();
      if (native.isRecording || native.canRecord) {
        // Keep ownership and a Stop action if native cleanup failed.
        this.update({ phase: "recording", message: "audioError" });
      } else {
        this.coordinator.release("recording");
        try {
          await this.ports.mode(false);
        } catch {
          this.update({ message: "audioError" });
        }
        this.update({ phase: "idle" });
      }
    }
  }
}
