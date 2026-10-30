import { AttachmentClientError } from "./attachment-transport";
import type { AttachmentCandidate } from "./attachment-device";
import type {
  AttachmentRuntime,
  AttachmentDigest,
  AttachmentSelection,
} from "./attachments";
/** Temporary picker/preview lifetime only. A confirmation hands immutable bytes to the session's transfer owner. */
export class AttachmentSelectionFlow {
  private controller = new AbortController();
  private candidate?: AttachmentCandidate;
  private snapshot: {
    candidate?: AttachmentCandidate;
    rotation: 0 | 90 | 180 | 270;
    busy: boolean;
    error: string | null;
  } = { rotation: 0, busy: false, error: null };
  private listeners = new Set<() => void>();
  constructor(
    private runtime: AttachmentRuntime,
    private digest: AttachmentDigest,
  ) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(update: Partial<typeof this.snapshot>) {
    this.snapshot = { ...this.snapshot, ...update };
    this.listeners.forEach((fn) => fn());
  }
  cancel = () => {
    this.controller.abort();
    this.controller = new AbortController();
    this.candidate?.release();
    this.candidate = undefined;
    this.publish({
      candidate: undefined,
      rotation: 0,
      busy: false,
      error: null,
    });
  };
  reject(code: string) {
    if (!this.snapshot.busy) this.publish({ error: code });
  }
  async choose(
    pick: (signal: AbortSignal) => Promise<AttachmentCandidate | null>,
  ) {
    if (this.snapshot.busy || !this.runtime.available) return;
    this.cancel();
    const signal = this.controller.signal;
    this.publish({ busy: true });
    try {
      const candidate = await pick(signal);
      if (signal.aborted) {
        candidate?.release();
        return;
      }
      if (!candidate) return;
      this.candidate = candidate;
      if (candidate.raster) this.publish({ candidate, rotation: 0 });
      else await this.confirmSelection(candidate.selection, signal);
    } catch (error) {
      if (!signal.aborted)
        this.publish({
          error:
            error instanceof AttachmentClientError
              ? error.code
              : "attachment_selection_failed",
        });
    } finally {
      if (!signal.aborted) this.publish({ busy: false });
    }
  }
  rotate = () => {
    if (!this.snapshot.busy && this.candidate)
      this.publish({
        rotation: ((this.snapshot.rotation + 90) % 360) as 0 | 90 | 180 | 270,
      });
  };
  confirm = async () => {
    if (!this.candidate || this.snapshot.busy) return;
    const signal = this.controller.signal;
    const candidate = this.candidate;
    this.publish({ busy: true });
    try {
      const selection = await candidate.confirm(this.snapshot.rotation);
      if (signal.aborted) {
        selection.release();
        return;
      }
      await this.confirmSelection(selection, signal);
    } catch {
      if (!signal.aborted)
        this.publish({ error: "attachment_selection_failed" });
    } finally {
      if (!signal.aborted) this.publish({ busy: false });
    }
  };
  private async confirmSelection(
    selection: AttachmentSelection,
    signal: AbortSignal,
  ) {
    await this.runtime.add(selection, this.digest);
    if (signal.aborted) return;
    this.candidate?.release();
    this.candidate = undefined;
    this.publish({ candidate: undefined, rotation: 0 });
  }
}
