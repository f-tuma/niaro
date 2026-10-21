import {
  commandTarget,
  type ClientSession,
  type SessionCommand,
  type SessionState,
} from "../../../../packages/client-core/session";
import {
  assertProcessCommandTarget,
  deepFreezeProcessValue,
  processStartCommand,
  type ProcessStartTarget,
} from "../../../../packages/client-core/process-commands";
import {
  captureProcessNoticeOwner,
  isReservedProcessRecoveryCopy,
  processNoticeCopy,
  processPendingRecoveryError,
  selectProcessCommandNotice,
} from "../../../../packages/client-core/process-command-notice";
import { selectRecentProcessRuns } from "../../../../packages/client-core/process-run-history";
import type {
  ProcessExecutionEntry,
  ProcessInputRequest,
} from "../../../../packages/protocol/process-execution";
import type {
  MeetingProcessSource,
  ProcessStartCommand,
} from "../../../../packages/protocol/process-start";
import type { ProcessOfferResult } from "../../../../packages/protocol/process-offer";
import { processOfferInitialInput } from "../../../../packages/protocol/process-offer-input";
import type { WorkItem } from "../../../../packages/protocol";
import { en, type TranslationKey } from "../../../../packages/i18n";
import type { ProcessFormInput } from "../../../../packages/ui-catalog/process-input-form";
import type { MeetingRecord } from "../../../../packages/protocol/meeting-record";
import { meetingProcessInitialInput } from "../../../../packages/protocol/meeting-process-input";

/** A start from a ready meeting: its record, the chosen open task and which
 * record parts fill which form fields. */
export type MeetingLaunch = Readonly<{
  record: MeetingRecord;
  selectedTask: { id: string; revision: number };
  sourceBindings: Partial<Record<string, MeetingProcessSource>>;
}>;

export type LaunchPhase =
  | "selection"
  | "preparing"
  | "editing"
  | "review"
  | "sending"
  | "accepted"
  | "rejected";
type Inventory = Awaited<ReturnType<ClientSession["loadProcessInventory"]>>;
export type LaunchModel = Readonly<{
  inventory: Inventory | null;
  selected: ProcessExecutionEntry | null;
  request: ProcessInputRequest | null;
  target: ProcessStartTarget | null;
  /** Prefilled (offer) or reviewed input; the form starts from it. */
  reviewedInput: ProcessFormInput | null;
  submission: ProcessStartCommand | null;
  phase: LaunchPhase;
  loading: boolean;
  retrying: boolean;
  /** The selection came from a chat offer. */
  offered: boolean;
  error: TranslationKey | null;
  notice: TranslationKey | null;
}>;
const initialModel: LaunchModel = {
  inventory: null,
  selected: null,
  request: null,
  target: null,
  reviewedInput: null,
  submission: null,
  phase: "selection",
  loading: false,
  retrying: false,
  offered: false,
  error: null,
  notice: null,
};

/** Personal processes first ("Mine"), then the workspace's ("Company"). */
export function groupProcesses(entries: readonly ProcessExecutionEntry[]) {
  return {
    mine: entries.filter((entry) => entry.personal === true),
    company: entries.filter((entry) => entry.personal !== true),
  };
}

/** Server and client codes as copy; unknown codes fall back. */
export function launchErrorKey(
  error: unknown,
  fallback: TranslationKey,
): TranslationKey {
  const code = error instanceof Error ? error.message : null;
  return code && !isReservedProcessRecoveryCopy(code) && code in en
    ? (code as TranslationKey)
    : fallback;
}

/** Commands may go out only from a live, current, idle session. */
export function sessionFresh(state: SessionState) {
  return (
    state.status === "online" &&
    !!state.store &&
    !state.store.stale &&
    !state.store.needsSnapshot &&
    !state.answerRecoveryBlocked &&
    !state.pending
  );
}

/** Recent native process runs from the session store, newest first. */
export function recentRuns(state: SessionState): WorkItem[] {
  return state.store
    ? selectRecentProcessRuns(Object.values(state.store.workItems))
    : [];
}

/** A saved start whose delivery is not settled yet, from the session outbox. */
export function pendingStart(state: SessionState) {
  const pending =
    state.processPending?.command.type === "process.start" &&
    state.processPending.target.type === "process.start"
      ? state.processPending
      : null;
  if (
    !pending ||
    pending.command.type !== "process.start" ||
    pending.target.type !== "process.start"
  )
    return null;
  const sending =
    state.commandStates[commandTarget(pending.command)] === "sending";
  const recoveryError = processPendingRecoveryError(pending, state.error);
  const error: TranslationKey | null =
    state.processNotice?.errorSource.kind === "local"
      ? state.processNotice.errorSource.code === "storage_error"
        ? "processesSavingFailed"
        : state.processNotice.errorSource.code
      : pending.notice && processNoticeCopy(pending.notice)
        ? processNoticeCopy(pending.notice)!.key
        : recoveryError
          ? recoveryError in en
            ? (recoveryError as TranslationKey)
            : "processesReadFailed"
          : null;
  return {
    commandId: pending.command.commandId,
    name: pending.target.entry.name,
    conversationId: pending.command.conversationId,
    outcome: pending.outcome,
    sending,
    error,
    canRetry:
      !sending &&
      !state.answerRecoveryBlocked &&
      (pending.outcome !== "unknown" || state.status === "online"),
  };
}

/**
 * Inventory → selection → server-prepared form → review → start, as in the
 * mobile Processes sheet. The session owns every authenticated read and write;
 * this keeps local selection and review and fences stale callbacks.
 */
export class ProcessLauncher {
  private model: LaunchModel = initialModel;
  private listeners = new Set<() => void>();
  private generation = 0;
  private reads = new Set<AbortController>();
  private alive = true;
  /** The chat offer opens once; later loads are an ordinary choice. */
  private offerPending: boolean;
  constructor(
    readonly session: ClientSession,
    readonly language: "en" | "cs",
    /** The chat the run is started in; created right before the start. */
    readonly conversationId: string,
    readonly offer: ProcessOfferResult | null,
    private readonly uuid: () => string = () => crypto.randomUUID(),
  ) {
    this.offerPending = !!offer;
  }
  getSnapshot = () => this.model;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  dispose() {
    this.alive = false;
    this.invalidate();
  }
  private commit(update: Partial<LaunchModel>) {
    if (!this.alive) return;
    this.model = { ...this.model, ...update };
    for (const listener of this.listeners) listener();
  }
  private invalidate() {
    this.generation++;
    this.reads.forEach((read) => read.abort());
    this.reads.clear();
    return this.generation;
  }
  private owns(generation: number) {
    return this.alive && this.generation === generation;
  }
  private fresh() {
    return sessionFresh(this.session.getSnapshot());
  }
  private noticeOwner() {
    return captureProcessNoticeOwner(this.session, {
      conversationId: this.conversationId,
      chatGeneration: 0,
      language: this.language,
    });
  }

  async load() {
    if (this.model.loading || this.model.phase === "preparing" || !this.fresh())
      return;
    const generation = this.invalidate();
    const read = new AbortController();
    this.reads.add(read);
    this.commit({ ...initialModel, loading: true });
    try {
      const inventory = await this.session.loadProcessInventory(read.signal);
      if (!this.owns(generation)) return;
      this.commit({
        inventory,
        loading: false,
        notice: inventory.refreshed ? "process_inventory_refreshed" : null,
      });
      const offered = this.offerPending ? this.offer : null;
      this.offerPending = false;
      if (offered) {
        // Only the exact offered version may open; a changed process is a new choice.
        const entry = inventory.processes.find(
          (value) =>
            value.processId === offered.processId &&
            value.version === offered.processVersion &&
            value.artifactDigest === offered.artifactDigest &&
            value.availability === "ready",
        );
        if (!entry) this.commit({ error: "processOfferUnavailable" });
        else await this.open(entry, true);
      }
    } catch (error) {
      if (this.owns(generation))
        this.commit({
          loading: false,
          error: launchErrorKey(error, "process_read_failed"),
        });
    } finally {
      this.reads.delete(read);
    }
  }

  /**
   * Selects a ready entry of the current inventory and opens its form. From
   * a meeting, the start is bound to its record and selected task, and the
   * chosen record parts prefill the form (the server loads them again).
   */
  async open(
    entry: ProcessExecutionEntry,
    offered = false,
    meeting?: MeetingLaunch,
  ) {
    if (entry.availability !== "ready" || !this.fresh()) return;
    const selected = this.model.inventory?.processes.find(
      (value) => value === entry,
    );
    if (!selected || selected.availability !== "ready") return;
    if (
      meeting &&
      (meeting.record.meeting.status !== "ready" ||
        !meeting.record.transcriptComplete ||
        !meeting.record.analysis ||
        !meeting.record.recordDigest)
    ) {
      this.commit({ error: "meeting_process_record_changed" });
      return;
    }
    const generation = this.invalidate();
    const request = deepFreezeProcessValue({
      processId: selected.processId,
      version: selected.version,
      artifactDigest: selected.artifactDigest,
      language: this.language,
      origin: meeting
        ? {
            type: "meeting" as const,
            conversationId: this.conversationId,
            requestId: this.uuid(),
            meetingId: meeting.record.meeting.id,
            recordDigest: meeting.record.recordDigest!,
            selectedTask: meeting.selectedTask,
            sourceBindings: Object.fromEntries(
              Object.entries(meeting.sourceBindings).filter(
                (binding): binding is [string, MeetingProcessSource] =>
                  !!binding[1],
              ),
            ),
          }
        : {
            type: "command" as const,
            conversationId: this.conversationId,
            requestId: this.uuid(),
          },
    });
    const read = new AbortController();
    this.reads.add(read);
    this.commit({
      selected,
      request,
      target: null,
      reviewedInput: null,
      submission: null,
      phase: "preparing",
      offered,
      loading: false,
      error: null,
      notice: null,
    });
    try {
      const target = await this.session.prepareProcessInput(
        request,
        selected,
        read.signal,
      );
      if (!this.owns(generation)) return;
      const reviewedInput = meeting
        ? meetingProcessInitialInput(
            meeting.record,
            target.card.form.inputSchema,
            meeting.sourceBindings,
            request.origin.type === "meeting" ? request.origin : undefined,
          )
        : offered && this.offer?.processId === selected.processId
          ? processOfferInitialInput(
              this.offer.input,
              target.card.form.inputSchema,
            )
          : null;
      this.commit({ target, phase: "editing", reviewedInput });
    } catch (error) {
      if (this.owns(generation))
        this.commit({
          phase: "selection",
          selected: null,
          error: launchErrorKey(error, "process_read_failed"),
        });
    } finally {
      this.reads.delete(read);
    }
  }

  /** Back to the list; a start in flight stays with the session outbox. */
  close() {
    if (this.model.phase === "sending" || this.model.retrying) return;
    this.invalidate();
    this.commit({
      selected: null,
      request: null,
      target: null,
      reviewedInput: null,
      submission: null,
      phase: "selection",
      offered: false,
      error: null,
    });
  }

  review(input: ProcessFormInput) {
    if (this.model.phase !== "editing" || !this.model.target || !this.fresh())
      return;
    const reviewedInput = deepFreezeProcessValue(
      JSON.parse(JSON.stringify(input)) as ProcessFormInput,
    );
    this.commit({ reviewedInput, phase: "review", error: null });
  }

  edit() {
    const target = this.model.target;
    if (
      !target ||
      !this.fresh() ||
      !["review", "rejected"].includes(this.model.phase)
    )
      return;
    if (
      target.card.form.language !== this.language ||
      target.card.form.origin.conversationId !== this.conversationId
    ) {
      this.commit({ error: "processesContextChanged" });
      return;
    }
    this.commit({ phase: "editing", submission: null, error: null });
  }

  /** The run's chat must exist before the run can be followed in it. */
  private async saveConversation() {
    if (this.session.getSnapshot().store?.conversations[this.conversationId])
      return;
    const key = this.conversationId.slice("chat-".length);
    const command: SessionCommand = {
      type: "conversation.create",
      conversationId: this.conversationId,
      commandId: key,
      idempotencyKey: key,
    };
    await this.session.send(command);
    if (
      this.session.getSnapshot().commandStates[commandTarget(command)] !==
      "accepted"
    )
      throw new Error("processesNotStarted");
  }

  async start() {
    const { target, reviewedInput, phase } = this.model;
    if (phase !== "review" || !target || !reviewedInput || !this.fresh())
      return;
    // Synchronous ownership fences a second click before the rerender.
    this.commit({ phase: "sending", error: null });
    try {
      await this.saveConversation();
      if (!this.alive) return;
      assertProcessCommandTarget(this.session.getSnapshot().store!, target);
      const commandId = this.uuid();
      const command = processStartCommand(target, {
        commandId,
        idempotencyKey: commandId,
        input: reviewedInput,
        language: target.card.form.language,
      });
      this.commit({ submission: command });
      await this.session.send(command, false, target, this.noticeOwner());
      this.settle(command);
    } catch (error) {
      this.commit({
        phase: "review",
        submission: null,
        error: launchErrorKey(error, "processesNotStarted"),
      });
    }
  }

  private settle(command: ProcessStartCommand) {
    if (!this.alive || this.model.submission?.commandId !== command.commandId)
      return;
    const latest = this.session.getSnapshot();
    const pending =
      latest.processPending?.command.commandId === command.commandId
        ? latest.processPending
        : null;
    const local = latest.commandStates[commandTarget(command)];
    const selected = selectProcessCommandNotice(
      latest,
      this.noticeOwner(),
      command.commandId,
    );
    if (pending) {
      this.commit({
        phase: pending.outcome === "unknown" ? "sending" : pending.outcome,
        error: null,
      });
    } else if (local === "accepted" || local === "rejected") {
      this.commit({
        phase: local,
        error:
          selected.notice?.key ??
          (latest.processNotice?.notice.commandId === command.commandId &&
          !selected.suppressError &&
          latest.error
            ? launchErrorKey(Error(latest.error), "processesReadFailed")
            : null),
      });
    } else {
      // send() may return without owning a flight. Resolution alone is no ACK.
      this.commit({
        phase: "review",
        submission: null,
        error: latest.error
          ? launchErrorKey(Error(latest.error), "processesNotStarted")
          : "processesNotStarted",
      });
    }
  }

  /** Resends the exact saved start; never revises its payload. */
  async retry(commandId: string) {
    const state = this.session.getSnapshot();
    const saved = state.processPending;
    if (
      !saved ||
      saved.command.commandId !== commandId ||
      saved.command.type !== "process.start" ||
      saved.target.type !== "process.start" ||
      this.model.retrying ||
      state.answerRecoveryBlocked ||
      state.commandStates[commandTarget(saved.command)] === "sending" ||
      (saved.outcome === "unknown" && state.status !== "online")
    )
      return;
    this.commit({
      retrying: true,
      target: saved.target,
      selected: saved.target.entry,
      reviewedInput: saved.command.input as ProcessFormInput,
      submission: saved.command,
      phase: saved.outcome === "unknown" ? "sending" : saved.outcome,
      error: null,
    });
    try {
      await this.session.retry(this.noticeOwner());
      this.settle(saved.command);
    } catch (error) {
      this.commit({ error: launchErrorKey(error, "processesReadFailed") });
    } finally {
      this.commit({ retrying: false });
    }
  }
}
