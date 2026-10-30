import {
  ATTACHMENT_PROFILE,
  AttachmentFilenameSchema,
  AttachmentMediaTypeSchema,
  AttachmentSendSchema,
  type AttachmentCapabilities,
  type AttachmentDraft,
  type AttachmentUpload,
  type AttachmentSend,
  type AttachmentPublicFile,
  type AttachmentProcessing,
} from "../protocol/attachments";
import { sameScope, type Scope } from "../protocol";
import {
  AttachmentClientError,
  AttachmentTransport,
} from "./attachment-transport";

export type AttachmentTarget = AttachmentDraft["target"];
export type AttachmentSelection = {
  filename: string;
  mediaType: string;
  size: number;
  read: () => Promise<Uint8Array>;
  /** Releases only resources owned by this selection; must be idempotent. */
  release: () => void;
};
export type AttachmentDigest = (bytes: Uint8Array) => Promise<string>;
export type AttachmentTransferState =
  | "preparing"
  | "uploading"
  | "verifying"
  | "uploaded"
  | "failed"
  | "uncertain"
  | "removing"
  | "expired";
export type AttachmentEntry = Readonly<{
  id: string;
  filename: string;
  mediaType: string;
  size: number;
  state: AttachmentTransferState;
  error?: string;
  retryable: boolean;
}>;
type OwnedEntry = {
  view: AttachmentEntry;
  bytes?: Uint8Array;
  sha256?: string;
  upload?: AttachmentUpload;
  create?: object;
  createRejected?: boolean;
  remove?: object;
  content?: AttachmentPublicFile;
  reference?: object;
  referenceRejected?: boolean;
  referenceFile?: AttachmentPublicFile;
  referenceSource?: {
    conversationId: string;
    messageId: string;
    contentId: string;
  };
  release: () => void;
};
// A frozen pin can be recovered by exact replay even when a generic response
// cannot recommend retries. Proven terminal refusals keep their remove-only path.
const pendingReference = (entry: OwnedEntry) =>
  !!entry.reference && !entry.content && !entry.referenceRejected;
export type AttachmentState = Readonly<{
  capabilities: AttachmentCapabilities | null;
  discovering: boolean;
  target: AttachmentTarget | null;
  draft: AttachmentDraft | null;
  entries: readonly AttachmentEntry[];
  busy: boolean;
  error: string | null;
}>;
const terminal = (draft: AttachmentDraft) =>
  draft.state !== "open" || Date.parse(draft.expiresAt) <= Date.now();
/** In-memory unsent transfer ownership, within the existing session. Never sends chat commands or retries paid work. */
export class AttachmentRuntime {
  private state: AttachmentState = {
    capabilities: null,
    discovering: false,
    target: null,
    draft: null,
    entries: [],
    busy: false,
    error: null,
  };
  private listeners = new Set<() => void>();
  private epoch = 0;
  private controller = new AbortController();
  private entries: OwnedEntry[] = [];
  private draftCreate?: object;
  private discovery?: Promise<void>;
  private discovered = false;
  private disposed = false;
  private downloadBusy = false;
  private frozenSend?: AttachmentSend;
  private localRetries = new Map<string, object>();
  constructor(
    private transport: AttachmentTransport,
    private scope: Scope,
    private uuid: () => string,
    private supported = true,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(update: Partial<AttachmentState> = {}) {
    this.state = Object.freeze({
      ...this.state,
      ...update,
      entries: Object.freeze(this.entries.map((entry) => entry.view)),
    });
    this.listeners.forEach((fn) => fn());
  }
  private current(epoch: number) {
    return (
      !this.disposed && epoch === this.epoch && !this.controller.signal.aborted
    );
  }
  private assert(epoch: number) {
    if (!this.current(epoch))
      throw new AttachmentClientError("attachment_stale");
  }
  private set(entry: OwnedEntry, update: Partial<AttachmentEntry>) {
    entry.view = Object.freeze({ ...entry.view, ...update });
    this.publish();
  }
  async discover() {
    if (!this.supported || this.disposed || this.discovery || this.discovered)
      return this.discovery;
    const epoch = this.epoch;
    this.publish({ discovering: true });
    this.discovery = (async () => {
      try {
        const capabilities = await this.transport.capabilities(
          this.controller.signal,
        );
        this.assert(epoch);
        if (capabilities && !sameScope(capabilities.scope, this.scope))
          throw new AttachmentClientError("attachment_stale");
        this.discovered = true;
        this.publish({ capabilities, error: null });
      } catch {
        // Discovery is passive; only explicit attachment actions own failure notices.
        if (this.current(epoch)) this.publish({ capabilities: null });
      } finally {
        if (this.current(epoch)) {
          this.discovery = undefined;
          this.publish({ discovering: false });
        }
      }
    })();
    return this.discovery;
  }
  /** Changing chat, account, workspace, local session or ownership generation aborts every callback and frees bytes. */
  select(target: AttachmentTarget, localGeneration: string | number = 0) {
    const key = JSON.stringify([target, localGeneration]);
    if (key === this.selectionKey || this.disposed) return;
    if (
      this.state.target?.conversationId === target.conversationId &&
      this.localGeneration === localGeneration &&
      this.state.target.expectedGeneration === null &&
      target.expectedGeneration === this.state.draft?.generation
    ) {
      this.selectionKey = key;
      return; // conversation.create adopted this reserved unsaved generation
    }
    this.clear();
    this.selectionKey = key;
    this.localGeneration = localGeneration;
    this.publish({ target: Object.freeze({ ...target }) });
  }
  private selectionKey = "";
  private localGeneration: string | number = 0;
  clear() {
    this.epoch++;
    this.controller.abort();
    this.controller = new AbortController();
    this.entries.forEach((entry) => {
      entry.bytes = undefined;
      entry.release();
    });
    this.entries = [];
    this.downloadBusy = false;
    this.draftCreate = undefined;
    this.frozenSend = undefined;
    this.localRetries.clear();
    this.discovery = undefined;
    this.publish({ draft: null, busy: false, error: null, discovering: false });
  }
  dispose() {
    this.clear();
    this.disposed = true;
    this.listeners.clear();
  }
  get available() {
    return !!(
      this.supported &&
      !this.disposed &&
      this.state.capabilities?.enabled &&
      this.state.capabilities.storageAvailable &&
      this.state.target
    );
  }
  get ready() {
    const draft = this.state.draft;
    return (
      this.available &&
      !this.state.busy &&
      !this.frozenSend &&
      !!draft &&
      !terminal(draft) &&
      this.entries.length > 0 &&
      this.entries.length === draft.items.length &&
      this.entries.every(
        (entry, i) =>
          entry.view.state === "uploaded" &&
          (entry.content?.contentId ?? entry.upload?.contentId) ===
            draft.items[i]?.contentId &&
          draft.items[i]?.availability === "available",
      )
    );
  }
  private error(error: unknown) {
    return error instanceof AttachmentClientError
      ? error.code
      : "attachment_unavailable";
  }
  private async ownDraft(epoch: number) {
    if (!this.state.target) throw new AttachmentClientError("attachment_stale");
    if (!this.state.draft) {
      this.draftCreate ??= {
        profile: ATTACHMENT_PROFILE,
        requestId: this.uuid(),
        target: this.state.target,
      };
      const draft = await this.transport.createDraft(
        this.draftCreate,
        this.controller.signal,
      );
      this.assert(epoch);
      if (
        draft.target.conversationId !== this.state.target.conversationId ||
        draft.target.expectedGeneration !==
          this.state.target.expectedGeneration ||
        draft.target.mode !== this.state.target.mode
      )
        throw new AttachmentClientError("attachment_stale");
      this.publish({ draft });
    }
    if (terminal(this.state.draft!))
      throw new AttachmentClientError("attachment_stale");
    return this.state.draft!;
  }
  async add(selection: AttachmentSelection, digest: AttachmentDigest) {
    if (!this.available || this.state.busy || this.frozenSend) {
      selection.release();
      return false;
    }
    const limits = this.state.capabilities!.limits;
    if (
      this.entries.length >= limits.maxMessageFiles ||
      selection.size <= 0 ||
      selection.size > limits.maxFileBytes ||
      this.entries.reduce((n, entry) => n + entry.view.size, 0) +
        selection.size >
        limits.maxMessageBytes
    ) {
      selection.release();
      this.publish({ error: "attachment_too_large" });
      return false;
    }
    const epoch = this.epoch;
    const entry: OwnedEntry = {
      view: Object.freeze({
        id: this.uuid(),
        filename: selection.filename,
        mediaType: selection.mediaType,
        size: selection.size,
        state: "preparing",
        retryable: false,
      }),
      release: selection.release,
    };
    this.entries.push(entry);
    this.publish({ busy: true, error: null });
    try {
      AttachmentFilenameSchema.parse(selection.filename);
      AttachmentMediaTypeSchema.parse(selection.mediaType);
      const bytes = await selection.read();
      this.assert(epoch);
      if (bytes.byteLength !== selection.size)
        throw new AttachmentClientError("attachment_integrity");
      entry.bytes = new Uint8Array(bytes); // caller cannot change retry identity
      entry.sha256 = await digest(entry.bytes);
      this.assert(epoch);
      await this.transfer(entry, epoch);
      return true;
    } catch (error) {
      if (this.current(epoch))
        this.set(entry, {
          state: "failed",
          error: this.error(error),
          retryable:
            !!entry.bytes &&
            !!entry.sha256 &&
            (!(error instanceof AttachmentClientError) || error.retryable),
        });
      return false;
    } finally {
      selection.release();
      if (this.current(epoch)) this.publish({ busy: false });
    }
  }
  private async transfer(entry: OwnedEntry, epoch: number) {
    const draft = await this.ownDraft(epoch);
    entry.create ??= {
      profile: ATTACHMENT_PROFILE,
      requestId: entry.view.id,
      expectedRevision: draft.revision,
      filename: entry.view.filename,
      mediaType: entry.view.mediaType,
      size: entry.view.size,
      sha256: entry.sha256,
    };
    if (!entry.upload) {
      let created;
      try {
        created = await this.transport.createUpload(
          draft.draftId,
          entry.create,
          this.controller.signal,
        );
        entry.createRejected = false;
      } catch (error) {
        entry.createRejected =
          error instanceof AttachmentClientError &&
          error.status > 0 &&
          error.code !== "attachment_uncertain";
        throw error;
      }
      this.assert(epoch);
      this.checkUpload(entry, created.upload);
      entry.upload = created.upload;
      this.publish({ draft: created.draft });
    }
    // Before *every* repeat PUT recover status; never clear a server's unknown PUT fence.
    if (entry.view.state !== "preparing") {
      entry.upload = await this.transport.upload(
        entry.upload.uploadId,
        this.controller.signal,
      );
      this.assert(epoch);
      this.checkUpload(entry, entry.upload);
    }
    if (entry.upload.state === "complete") return this.verified(entry, epoch);
    if (
      !["created", "retryable_failure", "unverified"].includes(
        entry.upload.state,
      )
    ) {
      this.applyUpload(entry);
      return;
    }
    this.set(entry, { state: "uploading", error: undefined, retryable: false });
    try {
      const upload = await this.transport.put(
        entry.upload,
        entry.bytes!,
        this.controller.signal,
        this.state.capabilities!.limits.uploadDeadlineSeconds,
      );
      this.assert(epoch);
      this.checkUpload(entry, upload);
      entry.upload = upload;
    } catch (error) {
      this.assert(epoch);
      // A transport failure proves nothing about dispatch. Status is the only automatic recovery operation.
      this.set(entry, {
        state: "uncertain",
        error: this.error(error),
        retryable: false,
      });
      try {
        const upload = await this.transport.upload(
          entry.upload.uploadId,
          this.controller.signal,
        );
        this.assert(epoch);
        this.checkUpload(entry, upload);
        entry.upload = upload;
      } catch {
        return;
      }
    }
    this.applyUpload(entry);
    if (entry.upload.state === "complete") await this.verified(entry, epoch);
  }
  private checkUpload(entry: OwnedEntry, upload: AttachmentUpload) {
    if (
      upload.contentId !== upload.uploadId ||
      upload.size !== entry.view.size ||
      upload.sha256 !== entry.sha256 ||
      (entry.upload && upload.uploadId !== entry.upload.uploadId)
    )
      throw new AttachmentClientError("attachment_integrity");
  }
  private applyUpload(entry: OwnedEntry) {
    const upload = entry.upload!;
    const state: AttachmentTransferState =
      upload.state === "complete"
        ? "verifying"
        : upload.state === "created" || upload.state === "retryable_failure"
          ? "failed"
          : upload.state === "quarantined"
            ? "uncertain"
            : ["removed", "expired"].includes(upload.state)
              ? "expired"
              : "verifying";
    this.set(entry, {
      state,
      error: upload.failure ?? undefined,
      retryable:
        ["created", "retryable_failure", "unverified"].includes(upload.state) &&
        !!entry.bytes &&
        [
          null,
          "attachment_unavailable",
          "attachment_busy",
          "attachment_quota",
        ].includes(upload.failure),
    });
  }
  private async verified(entry: OwnedEntry, epoch: number) {
    const draft = await this.transport.draft(
      this.state.draft!.draftId,
      this.controller.signal,
    );
    this.assert(epoch);
    const file = draft.items.find(
      (file) => file.contentId === entry.upload!.contentId,
    );
    if (
      !file ||
      file.sha256 !== entry.sha256 ||
      file.availability !== "available"
    )
      throw new AttachmentClientError("attachment_integrity");
    entry.content = file;
    this.publish({ draft });
    this.set(entry, { state: "uploaded", retryable: false, error: undefined });
    entry.bytes = undefined;
    entry.release();
  }
  async refresh(id: string) {
    const entry = this.entries.find((entry) => entry.view.id === id);
    if (!entry?.upload || this.state.busy || this.frozenSend) return;
    const epoch = this.epoch;
    this.publish({ busy: true });
    try {
      const upload = await this.transport.upload(
        entry.upload.uploadId,
        this.controller.signal,
      );
      this.assert(epoch);
      this.checkUpload(entry, upload);
      entry.upload = upload;
      this.applyUpload(entry);
      if (upload.state === "complete") await this.verified(entry, epoch);
    } catch (error) {
      if (this.current(epoch)) this.publish({ error: this.error(error) });
    } finally {
      if (this.current(epoch)) this.publish({ busy: false });
    }
  }
  async retry(id: string) {
    const entry = this.entries.find((entry) => entry.view.id === id);
    if (!entry?.view.retryable || this.state.busy || this.frozenSend) return;
    const epoch = this.epoch;
    this.publish({ busy: true });
    try {
      if (entry.referenceFile) await this.prepareReferences(epoch);
      else await this.transfer(entry, epoch);
    } catch (error) {
      if (this.current(epoch) && !entry.referenceFile)
        this.set(entry, {
          state: "failed",
          error: this.error(error),
          retryable:
            entry.view.state !== "uncertain" &&
            (!(error instanceof AttachmentClientError) || error.retryable),
        });
    } finally {
      if (this.current(epoch)) this.publish({ busy: false });
    }
  }
  async remove(id: string) {
    const entry = this.entries.find((entry) => entry.view.id === id);
    if (!entry || this.state.busy || this.frozenSend) return;
    const epoch = this.epoch;
    this.publish({ busy: true });
    try {
      if (entry.reference && !entry.content && !entry.referenceRejected)
        await this.prepareReference(entry, epoch);
      if (entry.create && !entry.upload && !entry.createRejected) {
        // Lost create response: recover the same mutation before removing its membership.
        const created = await this.transport.createUpload(
          this.state.draft!.draftId,
          entry.create,
          this.controller.signal,
        );
        this.assert(epoch);
        this.checkUpload(entry, created.upload);
        entry.upload = created.upload;
        this.publish({ draft: created.draft });
      }
      if ((entry.upload || entry.content) && this.state.draft) {
        entry.remove ??= {
          profile: ATTACHMENT_PROFILE,
          requestId: this.uuid(),
          expectedRevision: this.state.draft.revision,
        };
        this.set(entry, { state: "removing" });
        const draft = await this.transport.remove(
          this.state.draft.draftId,
          entry.content?.contentId ?? entry.upload!.contentId,
          entry.remove,
          this.controller.signal,
        );
        this.assert(epoch);
        this.publish({ draft });
      }
      this.entries = this.entries.filter((candidate) => candidate !== entry);
      entry.bytes = undefined;
      entry.release();
      this.publish();
      await this.prepareReferences(epoch);
    } catch (error) {
      if (this.current(epoch) && this.entries.includes(entry))
        this.set(entry, {
          state: "failed",
          error: this.error(error),
          retryable: pendingReference(entry),
        });
    } finally {
      if (this.current(epoch)) this.publish({ busy: false });
    }
  }
  /** Explicit Again/Edit creates a new draft with same-generation pins; no message is sent here. */
  async reuse(source: {
    conversationId: string;
    messageId: string;
    files: readonly AttachmentPublicFile[];
  }) {
    if (
      !this.available ||
      this.state.busy ||
      this.entries.length ||
      this.frozenSend
    )
      throw new AttachmentClientError("attachment_stale");
    const limits = this.state.capabilities!.limits;
    if (
      source.files.length > limits.maxMessageFiles ||
      source.files.reduce((n, file) => n + file.size, 0) >
        limits.maxMessageBytes ||
      source.files.some(
        (file) =>
          file.size > limits.maxFileBytes || file.availability !== "available",
      )
    )
      throw new AttachmentClientError("attachment_unavailable");
    const epoch = this.epoch;
    this.publish({ busy: true });
    try {
      // Preserve the whole ordered intent before the first uncertain request.
      // A failed middle pin must not make the remaining source files disappear.
      this.entries = source.files.map(
        (file): OwnedEntry => ({
          view: Object.freeze({
            id: this.uuid(),
            filename: file.filename,
            mediaType: file.mediaType,
            size: file.size,
            state: "preparing",
            retryable: false,
          }),
          sha256: file.sha256,
          referenceFile: Object.freeze({ ...file }),
          referenceSource: {
            conversationId: source.conversationId,
            messageId: source.messageId,
            contentId: file.contentId,
          },
          release: () => {},
        }),
      );
      this.publish();
      await this.prepareReferences(epoch);
    } finally {
      if (this.current(epoch)) this.publish({ busy: false });
    }
  }
  private async prepareReferences(epoch: number) {
    for (const entry of this.entries) {
      if (!entry.referenceFile || entry.content || entry.referenceRejected)
        continue;
      this.set(entry, {
        state: "preparing",
        retryable: false,
        error: undefined,
      });
      try {
        await this.prepareReference(entry, epoch);
      } catch (error) {
        if (this.current(epoch))
          this.set(entry, {
            state: "failed",
            error: this.error(error),
            retryable:
              pendingReference(entry) ||
              !(error instanceof AttachmentClientError) ||
              error.retryable,
          });
        throw error;
      }
    }
  }
  private async prepareReference(entry: OwnedEntry, epoch: number) {
    const draft = await this.ownDraft(epoch);
    entry.reference ??= {
      profile: ATTACHMENT_PROFILE,
      requestId: entry.view.id,
      expectedRevision: draft.revision,
      source: entry.referenceSource,
    };
    await this.addReference(entry, epoch);
  }
  private async addReference(entry: OwnedEntry, epoch: number) {
    let result: AttachmentDraft;
    try {
      result = await this.transport.reference(
        this.state.draft!.draftId,
        entry.reference,
        this.controller.signal,
      );
      entry.referenceRejected = false;
    } catch (error) {
      // Only a validated terminal 4xx refusal proves this pin was not added.
      // Transport loss, unknown envelopes, 5xx and uncertainty keep exact recovery.
      entry.referenceRejected =
        error instanceof AttachmentClientError &&
        error.knownFailure &&
        [400, 404, 409, 411, 413, 415].includes(error.status) &&
        !error.retryable &&
        error.code !== "attachment_uncertain";
      throw error;
    }
    this.assert(epoch);
    const file = result.items.find(
      (file) => file.contentId === entry.referenceFile!.contentId,
    );
    if (
      !file ||
      file.availability !== "available" ||
      file.sha256 !== entry.sha256
    )
      throw new AttachmentClientError("attachment_integrity");
    entry.content = file;
    this.publish({ draft: result });
    this.set(entry, { state: "uploaded", retryable: false, error: undefined });
  }
  /** Freeze once for the existing session command owner. Lost delivery must keep this same draft and command. */
  takeForSend(): AttachmentSend {
    if (!this.ready) throw new AttachmentClientError("attachment_stale");
    const draft = this.state.draft!;
    this.frozenSend = Object.freeze(
      AttachmentSendSchema.parse({
        profile: ATTACHMENT_PROFILE,
        draftId: draft.draftId,
        draftRevision: draft.revision,
        generation: draft.generation,
        items: draft.items.map(({ contentId, sha256 }) =>
          Object.freeze({ contentId, sha256 }),
        ),
      }),
    );
    Object.freeze(this.frozenSend.items);
    this.publish();
    return this.frozenSend;
  }
  settleSend(
    attachments: AttachmentSend,
    outcome: "accepted" | "rejected" | "unknown",
  ) {
    if (this.frozenSend?.draftId !== attachments.draftId) return;
    if (outcome === "accepted") this.clear();
    else if (outcome === "rejected") {
      this.frozenSend = undefined;
      this.publish();
    }
  }
  async download(
    file: AttachmentPublicFile,
    digest: AttachmentDigest,
    save: (bytes: Uint8Array, filename: string) => Promise<void>,
  ) {
    if (
      this.downloadBusy ||
      file.availability !== "available" ||
      file.size >
        (this.state.capabilities?.limits.maxFileBytes ?? 25 * 1024 * 1024)
    )
      throw new AttachmentClientError("attachment_unavailable");
    const epoch = this.epoch;
    this.downloadBusy = true;
    try {
      const bytes = await this.transport.original(
        file.contentId,
        file.size,
        this.controller.signal,
      );
      this.assert(epoch);
      if ((await digest(bytes)) !== file.sha256)
        throw new AttachmentClientError("attachment_integrity");
      this.assert(epoch);
      await save(bytes, file.filename);
    } finally {
      if (this.current(epoch)) this.downloadBusy = false;
    }
  }
  async retryLocal(processing: AttachmentProcessing) {
    if (
      !["blocked_capability", "failed"].includes(processing.state) ||
      !this.state.capabilities?.processingAvailable
    )
      throw new AttachmentClientError("attachment_retry_required");
    // Explicit preparation retry only; never sends message.send or starts a native retry.
    const key = `${processing.ingestionId}:${processing.attempt}:${processing.version}`;
    let request = this.localRetries.get(key);
    if (!request) {
      request = {
        profile: ATTACHMENT_PROFILE,
        requestId: this.uuid(),
        expectedAttempt: processing.attempt,
        expectedVersion: processing.version,
      };
      this.localRetries.set(key, request);
    }
    return this.transport.retryLocal(
      processing.ingestionId,
      request,
      this.controller.signal,
    );
  }
}
