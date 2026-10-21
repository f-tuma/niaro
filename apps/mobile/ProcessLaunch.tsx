import React, {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { randomUUID } from "expo-crypto";
import {
  ClientSession,
  commandTarget,
} from "../../packages/client-core/session";
import {
  assertProcessCommandTarget,
  deepFreezeProcessValue,
  processStartCommand,
  type ProcessStartTarget,
} from "../../packages/client-core/process-commands";
import type {
  ProcessExecutionEntry,
  ProcessInputRequest,
} from "../../packages/protocol/process-execution";
import type { MeetingRecord } from "../../packages/protocol/meeting-record";
import type {
  MeetingProcessSource,
  ProcessStartCommand,
} from "../../packages/protocol/process-start";
import type { Language } from "../../packages/protocol";
import { en, type TranslationKey } from "../../packages/i18n";
import {
  captureProcessNoticeOwner,
  processNoticeCopy,
  selectProcessCommandNotice,
  processPendingRecoveryError,
  isReservedProcessRecoveryCopy,
} from "../../packages/client-core/process-command-notice";
import {
  ProcessLaunchView,
  type ProcessLaunchViewProps,
} from "../../packages/ui-catalog/ProcessLaunchView";
import type { ProcessFormInput } from "../../packages/ui-catalog/process-input-form";
import {
  meetingProcessInitialInput,
  meetingProcessSourceOptions,
} from "../../packages/protocol/meeting-process-input";
import type { ProcessOfferResult } from "../../packages/protocol/process-offer";
import { processOfferInitialInput } from "../../packages/protocol/process-offer-input";

type Inventory = Awaited<ReturnType<ClientSession["loadProcessInventory"]>>;
type Owner = {
  session: ClientSession;
  identityKey: string;
  language: Language;
  conversationId: string;
  chatGeneration: number;
  meetingRecord?: MeetingRecord;
  selectedTask?: { id: string; revision: number };
  offer?: ProcessOfferResult;
};
type Model = {
  inventory: Inventory | null;
  selected: ProcessExecutionEntry | null;
  request: ProcessInputRequest | null;
  target: ProcessStartTarget | null;
  reviewedInput: ProcessFormInput | null;
  submission: ProcessStartCommand | null;
  sourceBindings: Partial<Record<string, MeetingProcessSource>>;
  phase: ProcessLaunchViewProps["phase"];
  loading: boolean;
  retrying: boolean;
  error: TranslationKey | null;
  notice: TranslationKey | null;
};
type Control = {
  owner: Owner;
  generation: number;
  alive: boolean;
  reads: Set<AbortController>;
  model: Model;
  /** The chat offer opens once; later loads are an ordinary choice. */
  offerPending: boolean;
};
const initialModel = (notice: TranslationKey | null = null): Model => ({
  inventory: null,
  selected: null,
  request: null,
  target: null,
  reviewedInput: null,
  submission: null,
  sourceBindings: {},
  phase: "selection",
  loading: false,
  retrying: false,
  error: null,
  notice,
});
const errorKey = (error: unknown, fallback: TranslationKey): TranslationKey => {
  const code = error instanceof Error ? error.message : null;
  return code && !isReservedProcessRecoveryCopy(code) && code in en
    ? (code as TranslationKey)
    : fallback;
};
const fresh = (session: ClientSession) => {
  const state = session.getSnapshot();
  return (
    state.status === "online" &&
    !!state.store &&
    !state.store.stale &&
    !state.store.needsSnapshot &&
    !state.answerRecoveryBlocked &&
    !state.pending
  );
};

type ProcessLaunchProps = {
  session: ClientSession;
  language: Language;
  conversationId: string;
  chatGeneration: number;
  meetingRecord?: MeetingRecord;
  selectedTask?: { id: string; revision: number };
  /** A process the assistant offered in chat: open its prefilled form. */
  offer?: ProcessOfferResult;
  showTitle?: boolean;
  onDone?: () => void;
};

/** Context changes create a distinct owner, before old effects/cancellations settle. */
export function ProcessLaunch(props: ProcessLaunchProps) {
  const [binding, setBinding] = useState(() => ({
    ...props,
    revision: 0,
    notice: false,
  }));
  const changed =
    binding.session !== props.session ||
    binding.language !== props.language ||
    binding.conversationId !== props.conversationId ||
    binding.chatGeneration !== props.chatGeneration ||
    binding.meetingRecord?.meeting.id !== props.meetingRecord?.meeting.id ||
    binding.meetingRecord?.recordDigest !== props.meetingRecord?.recordDigest ||
    binding.selectedTask?.id !== props.selectedTask?.id ||
    binding.selectedTask?.revision !== props.selectedTask?.revision;
  // A new or dismissed offer restarts the launcher without a warning.
  if (changed || binding.offer !== props.offer)
    setBinding({ ...props, revision: binding.revision + 1, notice: changed });
  return (
    <OwnedProcessLaunch
      key={binding.revision}
      {...props}
      contextChanged={binding.notice}
    />
  );
}

/** Local selection and review; Session owns every authenticated read and write. */
function OwnedProcessLaunch({
  session,
  language,
  conversationId,
  chatGeneration,
  meetingRecord,
  selectedTask,
  offer,
  contextChanged,
  showTitle,
  onDone,
}: ProcessLaunchProps & { contextChanged: boolean }) {
  const state = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  const [model, setModel] = useState(() =>
    initialModel(contextChanged ? "processesContextChanged" : null),
  );
  const control = useRef<Control>({
    owner: {
      session,
      identityKey: session.identityKey,
      language,
      conversationId,
      chatGeneration,
      meetingRecord,
      selectedTask,
      offer,
    },
    generation: 0,
    alive: true,
    reads: new Set(),
    model,
    offerPending: !!offer,
  });
  const commit = (owner: Control, update: Partial<Model>) => {
    if (control.current !== owner || !owner.alive) return;
    owner.model = { ...owner.model, ...update };
    setModel(owner.model);
  };
  useEffect(() => {
    const owner = control.current;
    owner.alive = true;
    return () => {
      owner.alive = false;
      owner.reads.forEach((read) => read.abort());
    };
  }, []);

  const invalidateReads = (owner: Control) => {
    owner.generation++;
    owner.reads.forEach((read) => read.abort());
    owner.reads.clear();
    return owner.generation;
  };
  const owns = (owner: Control, generation: number) =>
    control.current === owner && owner.alive && owner.generation === generation;

  const load = async () => {
    const owner = control.current;
    if (
      owner.model.loading ||
      owner.model.phase === "preparing" ||
      !fresh(owner.owner.session)
    )
      return;
    const generation = invalidateReads(owner);
    const read = new AbortController();
    owner.reads.add(read);
    commit(owner, { ...initialModel(), loading: true });
    try {
      const inventory = await owner.owner.session.loadProcessInventory(
        read.signal,
      );
      if (!owns(owner, generation)) return;
      commit(owner, {
        inventory,
        loading: false,
        notice: inventory.refreshed ? "process_inventory_refreshed" : null,
      });
      const offered = owner.offerPending ? owner.owner.offer : undefined;
      owner.offerPending = false;
      if (offered) {
        // Only the exact offered version may open; a changed process is a new choice.
        const entry = inventory.processes.find(
          (value) =>
            value.processId === offered.processId &&
            value.version === offered.processVersion &&
            value.artifactDigest === offered.artifactDigest &&
            value.availability === "ready",
        );
        if (!entry) commit(owner, { error: "processOfferUnavailable" });
        else {
          select(entry);
          await prepare();
        }
      }
    } catch (error) {
      if (owns(owner, generation))
        commit(owner, {
          loading: false,
          error: errorKey(error, "process_read_failed"),
        });
    } finally {
      owner.reads.delete(read);
    }
  };
  const select = (entry: ProcessExecutionEntry) => {
    const owner = control.current;
    if (entry.availability !== "ready" || !fresh(owner.owner.session)) return;
    // Only the complete current immutable inventory may supply an entry.
    const selected = owner.model.inventory?.processes.find(
      (value) => value === entry,
    );
    if (!selected) return;
    invalidateReads(owner);
    commit(owner, {
      selected,
      request: null,
      target: null,
      reviewedInput: null,
      submission: null,
      sourceBindings: {},
      phase: "selection",
      loading: false,
      error: null,
    });
  };
  const bindSource = (field: string, source: MeetingProcessSource | null) => {
    const owner = control.current;
    const selected = owner.model.selected;
    const record = owner.owner.meetingRecord;
    if (!selected || selected.availability !== "ready" || !record) return;
    const options = meetingProcessSourceOptions(
      record,
      selected.inputSchema,
      owner.owner.selectedTask?.id,
    )[field];
    if (source && !options?.includes(source)) return;
    const sourceBindings = { ...owner.model.sourceBindings };
    if (source) sourceBindings[field] = source;
    else delete sourceBindings[field];
    invalidateReads(owner);
    commit(owner, {
      sourceBindings,
      request: null,
      target: null,
      reviewedInput: null,
      submission: null,
      phase: "selection",
      error: null,
    });
  };
  const prepare = async () => {
    const owner = control.current;
    const selected = owner.model.selected;
    if (
      !selected ||
      selected.availability !== "ready" ||
      owner.model.phase === "preparing" ||
      !fresh(owner.owner.session)
    )
      return;
    const meeting = owner.owner.meetingRecord;
    const meetingRecordDigest = meeting?.recordDigest;
    if (
      meeting &&
      (meeting.meeting.status !== "ready" ||
        !meeting.transcriptComplete ||
        !meeting.analysis ||
        !meetingRecordDigest)
    ) {
      commit(owner, { error: "meeting_process_record_changed" });
      return;
    }
    const generation = invalidateReads(owner);
    const sourceBindings: Record<string, MeetingProcessSource> = {};
    for (const [field, source] of Object.entries(owner.model.sourceBindings))
      if (source) sourceBindings[field] = source;
    const origin = meeting
      ? {
          type: "meeting" as const,
          conversationId: owner.owner.conversationId,
          requestId: randomUUID(),
          meetingId: meeting.meeting.id,
          recordDigest: meetingRecordDigest!,
          ...(owner.owner.selectedTask
            ? { selectedTask: owner.owner.selectedTask }
            : {}),
          sourceBindings,
        }
      : {
          type: "command" as const,
          conversationId: owner.owner.conversationId,
          requestId: randomUUID(),
        };
    const request =
      owner.model.request ??
      deepFreezeProcessValue({
        processId: selected.processId,
        version: selected.version,
        artifactDigest: selected.artifactDigest,
        language: owner.owner.language,
        origin,
      });
    const read = new AbortController();
    owner.reads.add(read);
    commit(owner, {
      request,
      phase: "preparing",
      target: null,
      reviewedInput: null,
      submission: null,
      error: null,
    });
    try {
      const target = await owner.owner.session.prepareProcessInput(
        request,
        selected,
        read.signal,
      );
      if (!owns(owner, generation)) return;
      const offered = owner.owner.offer;
      const reviewedInput = owner.owner.meetingRecord
        ? meetingProcessInitialInput(
            owner.owner.meetingRecord,
            target.card.form.inputSchema,
            owner.model.sourceBindings,
            request.origin.type === "meeting" ? request.origin : undefined,
          )
        : offered?.processId === selected.processId
          ? processOfferInitialInput(
              offered.input,
              target.card.form.inputSchema,
            )
          : null;
      commit(owner, { target, phase: "editing", reviewedInput });
    } catch (error) {
      if (owns(owner, generation))
        commit(owner, {
          phase: "selection",
          error: errorKey(error, "process_read_failed"),
        });
    } finally {
      owner.reads.delete(read);
    }
  };
  useEffect(() => {
    // An offered process opens straight away; otherwise loading stays explicit.
    if (control.current.owner.offer) void load();
    // load reads the current owner through control, not render closures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const review = (input: ProcessFormInput) => {
    const owner = control.current;
    if (
      owner.model.phase !== "editing" ||
      !owner.model.target ||
      !fresh(owner.owner.session)
    )
      return;
    const reviewedInput = deepFreezeProcessValue(
      JSON.parse(JSON.stringify(input)) as ProcessFormInput,
    );
    commit(owner, { reviewedInput, phase: "review", error: null });
  };
  const edit = () => {
    const owner = control.current;
    const target = owner.model.target;
    if (
      !target ||
      !fresh(owner.owner.session) ||
      !["review", "rejected"].includes(owner.model.phase)
    )
      return;
    if (
      target.card.form.language !== owner.owner.language ||
      target.card.form.origin.conversationId !== owner.owner.conversationId
    ) {
      commit(owner, { error: "processesContextChanged" });
      return;
    }
    commit(owner, {
      phase: "editing",
      reviewedInput: null,
      submission: null,
      error: null,
    });
  };
  const settle = (owner: Control, command: ProcessStartCommand) => {
    if (
      control.current !== owner ||
      !owner.alive ||
      owner.model.submission?.commandId !== command.commandId
    )
      return;
    const latest = owner.owner.session.getSnapshot();
    const pending =
      latest.processPending?.command.commandId === command.commandId
        ? latest.processPending
        : null;
    const local = latest.commandStates[commandTarget(command)];
    const selected = selectProcessCommandNotice(
      latest,
      captureProcessNoticeOwner(owner.owner.session, owner.owner),
      command.commandId,
    );
    if (pending) {
      commit(owner, {
        phase: pending.outcome === "unknown" ? "sending" : pending.outcome,
        error: null,
      });
    } else if (local === "accepted" || local === "rejected") {
      commit(owner, {
        phase: local,
        error:
          selected.notice?.key ??
          (latest.processNotice?.notice.commandId === command.commandId &&
          !selected.suppressError &&
          latest.error
            ? errorKey(Error(latest.error), "processesReadFailed")
            : null),
      });
    } else {
      // send() may return without owning a flight. Resolution alone is no ACK.
      commit(owner, {
        phase: "review",
        submission: null,
        error: latest.error
          ? errorKey(Error(latest.error), "processesNotStarted")
          : "processesNotStarted",
      });
    }
  };
  const start = async () => {
    const owner = control.current;
    const { target, reviewedInput, phase } = owner.model;
    if (
      phase !== "review" ||
      !target ||
      !reviewedInput ||
      !fresh(owner.owner.session)
    )
      return;
    try {
      assertProcessCommandTarget(
        owner.owner.session.getSnapshot().store!,
        target,
      );
      const commandId = randomUUID();
      const command = processStartCommand(target, {
        commandId,
        idempotencyKey: commandId,
        input: reviewedInput,
        language: target.card.form.language,
      });
      // Synchronous model ownership also fences a second tap before rerender.
      commit(owner, { phase: "sending", submission: command, error: null });
      await owner.owner.session.send(
        command,
        false,
        target,
        captureProcessNoticeOwner(owner.owner.session, owner.owner),
      );
      settle(owner, command);
    } catch (error) {
      if (control.current === owner && owner.alive)
        commit(owner, {
          phase: "review",
          error: errorKey(error, "processesNotStarted"),
        });
    }
  };
  const pending =
    state.processPending?.command.type === "process.start" &&
    state.processPending.target.type === "process.start"
      ? state.processPending
      : null;
  const sending =
    !!pending &&
    state.commandStates[commandTarget(pending.command)] === "sending";
  const recoveryError = processPendingRecoveryError(pending, state.error);
  const canRetry =
    !!pending &&
    !model.retrying &&
    !sending &&
    !state.answerRecoveryBlocked &&
    (pending.outcome !== "unknown" || state.status === "online");
  const retry = async (commandId: string) => {
    const owner = control.current;
    const saved = owner.owner.session.getSnapshot().processPending;
    if (
      !saved ||
      saved.command.commandId !== commandId ||
      saved.command.type !== "process.start" ||
      saved.target.type !== "process.start" ||
      owner.model.retrying ||
      owner.owner.session.getSnapshot().answerRecoveryBlocked
    )
      return;
    if (
      owner.owner.session.getSnapshot().commandStates[
        commandTarget(saved.command)
      ] === "sending" ||
      (saved.outcome === "unknown" &&
        owner.owner.session.getSnapshot().status !== "online")
    )
      return;
    commit(owner, {
      retrying: true,
      target: saved.target,
      selected: saved.target.entry,
      reviewedInput: saved.command.input as ProcessFormInput,
      submission: saved.command,
      phase: saved.outcome === "unknown" ? "sending" : saved.outcome,
      error: null,
    });
    try {
      await owner.owner.session.retry(
        captureProcessNoticeOwner(owner.owner.session, owner.owner),
      );
      settle(owner, saved.command);
    } catch (error) {
      if (control.current === owner && owner.alive)
        commit(owner, { error: errorKey(error, "processesReadFailed") });
    } finally {
      commit(owner, { retrying: false });
    }
  };
  // A callback from an earlier rendered form/review cannot operate on a newer one.
  const ownsRenderedModel = () =>
    control.current.alive && control.current.model === model;

  return (
    <ProcessLaunchView
      language={language}
      meetingRecord={meetingRecord}
      selectedTaskId={selectedTask?.id}
      showTitle={showTitle}
      onDone={onDone}
      entries={model.inventory?.processes ?? null}
      selected={model.selected}
      sourceBindings={model.sourceBindings}
      loading={model.loading}
      phase={model.phase}
      card={model.target?.card ?? null}
      reviewedInput={model.reviewedInput}
      error={
        state.pending?.type === "process.start" && !pending
          ? "process_command_changed"
          : model.error
      }
      notice={
        state.status !== "online"
          ? state.status
          : state.answerRecoveryBlocked
            ? "savedProcessAnswerStorageBlocked"
            : state.store?.stale || state.store?.needsSnapshot
              ? "stale"
              : state.pending && !pending
                ? "processesBusy"
                : model.notice
      }
      disabled={!fresh(session) || model.retrying}
      onLoad={() => {
        if (ownsRenderedModel()) void load();
      }}
      onSelect={(entry) => {
        if (ownsRenderedModel()) select(entry);
      }}
      onSourceBinding={(field, source) => {
        if (ownsRenderedModel()) bindSource(field, source);
      }}
      onPrepare={() => {
        if (ownsRenderedModel()) void prepare();
      }}
      onReview={(input) => {
        if (ownsRenderedModel()) review(input);
      }}
      onEdit={() => {
        if (ownsRenderedModel()) edit();
      }}
      onStart={() => {
        if (ownsRenderedModel()) void start();
      }}
      recovery={
        pending &&
        pending.command.type === "process.start" &&
        pending.target.type === "process.start"
          ? {
              name: pending.target.entry.name,
              version: pending.target.entry.version,
              kind: pending.target.entry.kind,
              conversationId: pending.command.conversationId,
              language: pending.command.language,
              input: pending.command.input,
              outcome: pending.outcome,
              sending: sending || model.retrying,
              error:
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
                      : null,
              canRetry,
              onRetry: () => {
                if (ownsRenderedModel()) void retry(pending.command.commandId);
              },
            }
          : undefined
      }
    />
  );
}
