import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  GeneratedUiSchema,
  type GeneratedUi,
} from "../../packages/protocol/generative-ui";
import { workCard } from "../server-cards/adapters";
import {
  archivableConversation,
  CommandSchema,
  CommandResultSchema,
  EventSchema,
  SnapshotSchema,
  WorkItemSchema,
  CalendarTargetSchema,
  CrmContactResultSchema,
  MessageResultSchema,
  HumanTaskReferenceSchema,
  ConversationSchema,
  type Conversation,
  type CrmContactResult,
  type Command,
  type CommandResult,
  type DomainEvent,
  type ActionProposal,
  type WorkItem,
  type MeetingParameters,
  type Operation,
  type Scope,
  type CalendarTarget,
  type OpenWork,
  sameScope,
} from "../../packages/protocol";
import {
  choosePeter,
  emptySnapshot,
  scopeFor,
} from "../../packages/test-fixtures";

import {
  ConversationMemorySchema,
  startsNewMeeting,
  namesOnlyPeter,
  refersToLastMeeting,
  MEMORY_TTL_MS,
  emptyMeeting,
  meetingContext,
  mergeMeeting,
  localParts,
  type MeetingSlots,
  type ConversationMemory,
} from "./conversation-memory";
import { migrateDatabase } from "./migrate";
import {
  ContactLookupSchema,
  VerifiedContactSchema,
  type ContactLookup,
} from "../server-tools/contacts";
import {
  DecisionSchema,
  MeetingDraftSchema,
  localToUtc,
  type Decision,
} from "./decision";

export type Interpretation = {
  decision: Decision;
  nativeWork?: WorkItem[];
  nativeWorkAuthoritative?: boolean;
  workItemId?: string;
  expectedCursor: number;
  /** Native runs authorize their own task revisions. Progress events may advance
   * the cursor, but a different conversation must still invalidate the reply. */
  expectedConversationRevision?: number;
  /** Bounded public answer finalized by the native server runtime. The model
   * decision keeps its independent 800-character validation limit. */
  nativeReply?: string;
  /** Set only after Mastra validates and retires the exact retry parent. */
  nativeRetryAuthorized?: boolean;
  timeZone: string;
  contactResult?: CrmContactResult;
  /** The admitted UI program of a native answer, shown beside its text. */
  ui?: GeneratedUi;
  processOffer?: import("../../packages/protocol/process-offer").ProcessOfferResult;
  skillProposal?: import("../../packages/protocol/skills").SkillProposalResult;
  processProposal?: import("../../packages/protocol/process-proposal").ProcessProposalResult;
  serviceResult?: import("../../packages/protocol/service-result").ServiceResult;
  connectionResult?: import("../../packages/protocol/service-oauth").ServiceConnectionCard;
  resolvedServiceResult?: import("../../packages/protocol/service-result").ServiceResult;
  contactLookup?: ContactLookup;
  terminal?: {
    status: "rejected" | "conflict";
    reply?: string;
    code:
      | "integration_unavailable"
      | "revision_conflict"
      | "idempotency_conflict";
  };
};

const ReceiptSchema = z.strictObject({
  command: CommandSchema,
  status: z.enum(["accepted", "conflict", "rejected"]),
  code: CommandResultSchema.shape.code,
});
export type Receipt = z.infer<typeof ReceiptSchema>;
export const DatabaseSchema = z.strictObject({
  version: z.literal(2),
  snapshot: SnapshotSchema,
  events: z.array(EventSchema).max(1000),
  eventFloor: z.number().int().nonnegative().default(0),
  /** The most recent receipts only; the storage keeps every receipt and
   * answers for the older ones through `olderReceipt`. */
  receipts: z.array(ReceiptSchema),
  pending: z.array(
    z.strictObject({
      workItemId: z.string(),
      dueAt: z.number(),
      kind: z.enum([
        "prepare_proposal",
        "start_operation",
        "finish_operation",
        "calendar_operation",
      ]),
      attempts: z.number().int().nonnegative().optional(),
      operationId: z.string().optional(),
    }),
  ),
  nextWork: z.number().int().positive(),
  meetingDrafts: z.record(z.string(), MeetingDraftSchema).optional(),
  conversationMemory: ConversationMemorySchema.optional(),
  conversationMemories: z
    .record(z.string(), ConversationMemorySchema)
    .optional(),
  conversationContacts: z
    .record(
      z.string(),
      z.strictObject({ updatedAt: z.number(), result: CrmContactResultSchema }),
    )
    .optional(),
  meetingContacts: z
    .record(
      z.string(),
      z
        .array(VerifiedContactSchema.extend({ email: z.email().max(254) }))
        .max(20),
    )
    .optional(),
  recentContacts: z
    .strictObject({ updatedAt: z.number(), result: CrmContactResultSchema })
    .optional(),
});
export type Database = z.infer<typeof DatabaseSchema>;
export type CalendarOutcome =
  | {
      status: "succeeded";
      result: Extract<NonNullable<Operation["result"]>, { kind: "calendar" }>;
    }
  | { status: "failed"; error: NonNullable<Operation["error"]> }
  | {
      status: "result_unknown";
      error: NonNullable<Operation["error"]>;
      retry: boolean;
    };
const TERMINAL_WORK = new Set<WorkItem["status"]>([
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  "superseded",
]);
/**
 * Work that still waits for the person or the server: it keeps a chat from
 * being deleted or archived, and `work.cancel` can stop it. Expired and
 * superseded native work is already settled. A run that ended with an
 * unconfirmed write has nothing left to cancel: it is not open, and its
 * WorkItem stays visible in Tasks after the chat is gone.
 */
export function isOpenWork(work: WorkItem, pending: Database["pending"] = []) {
  if (TERMINAL_WORK.has(work.status)) return false;
  const process = work.native?.process;
  if (process)
    return (
      process.journalStatus === "running" || process.journalStatus === "waiting"
    );
  if (work.native)
    return !(
      work.status === "waiting_system" &&
      !work.native.question &&
      work.native.action?.status === "unknown"
    );
  // The fixture calendar: an unconfirmed write the server no longer retries.
  return !(
    work.status === "waiting_system" &&
    !pending.some((job) => job.workItemId === work.id)
  );
}
export function openWorkKind(work: WorkItem): OpenWork["kind"] {
  return work.native?.process
    ? "process"
    : work.status === "waiting_input"
      ? "question"
      : work.status === "waiting_approval"
        ? "approval"
        : "task";
}
export type ExecuteOptions = {
  /** The model service cancelled this exact `work.cancel` target at its
   * expected revision; the projection now shows the settled run. */
  workCancelled?: boolean;
};
/** Chats the apps address by a fixed id: deleting one empties it instead. */
export const resettableConversation = (id: string) =>
  id === "conversation-1" || id.startsWith("chat-hub-");
/** Commands that name an archived chat: it is listed, read and can return. */
const ARCHIVE_COMMANDS = new Set<Command["type"]>([
  "conversation.rename",
  "conversation.delete",
  "conversation.archive",
  "conversation.restore",
]);
export class FixtureEngine {
  data: Database;
  private cardLanguage: "en" | "cs" = "en";
  private activeConversationId = "conversation-1";
  /** The open item the command being executed brings to its user message. */
  private attachedTask:
    | { commandId: string; task: z.infer<typeof HumanTaskReferenceSchema> }
    | undefined;
  private activeLogicalMessageId: string | undefined;
  private executeOptions: ExecuteOptions = {};
  constructor(
    workspace = "a",
    data?: unknown,
    private persist: (data: Database) => void = () => {},
    private now = () => Date.now(),
    trustedScope: Scope = scopeFor(workspace),
    private calendar?: CalendarTarget,
    private loadConversation?: (id: string) => Conversation | undefined,
    private conversationExists?: (id: string) => boolean,
    /** Chats the person deleted: never continued, only kept as an empty
     * reference while a task still points at one. */
    private deletedConversations?: {
      has(id: string): boolean;
      shell(id: string): Conversation | undefined;
    },
    /** Chats in the person's archive: read-only until restored. */
    private archivedConversation?: (id: string) => boolean,
    /** A receipt older than the loaded window, by command id or
     * idempotency key, so a retry from long ago still replays its outcome
     * and never dispatches again. */
    private olderReceipt?: (
      commandId: string,
      idempotencyKey: string,
    ) => Receipt | undefined,
  ) {
    this.calendar = calendar ? CalendarTargetSchema.parse(calendar) : undefined;
    this.data = data
      ? DatabaseSchema.parse(migrateDatabase(data))
      : {
          version: 2,
          snapshot: emptySnapshot(trustedScope),
          events: [],
          eventFloor: 0,
          receipts: [],
          pending: [],
          nextWork: 1,
        };
    const lastLanguage = this.data.receipts.findLast(
      (r) => "language" in r.command,
    )?.command;
    if (lastLanguage && "language" in lastLanguage)
      this.cardLanguage = lastLanguage.language;
    if (!sameScope(this.data.snapshot.scope, trustedScope))
      throw new Error("Persisted workspace mismatch");
    this.data.conversationMemories ??= this.data.conversationMemory
      ? {
          [this.data.conversationMemory.conversationId]:
            this.data.conversationMemory,
        }
      : {};
    this.data.conversationContacts ??= this.data.recentContacts
      ? { "conversation-1": this.data.recentContacts }
      : {};
    this.data.conversationMemory =
      this.data.conversationMemories["conversation-1"];
    this.data.recentContacts = this.data.conversationContacts["conversation-1"];
    this.selectConversation("conversation-1");
  }
  /** Projection hydration is passive; no selected task or native turn changes. */
  selectConversation(id: string) {
    if (id !== this.activeConversationId) {
      this.rememberActiveContext();
      this.activeConversationId = id;
      this.data.conversationMemory = this.data.conversationMemories?.[id];
      this.data.recentContacts = this.data.conversationContacts?.[id];
    }
    if (!this.data.snapshot.conversations.some((c) => c.id === id)) {
      const stored = this.loadConversation?.(id);
      if (stored)
        this.data.snapshot.conversations.push(ConversationSchema.parse(stored));
    }
  }
  private rememberActiveContext() {
    this.data.conversationMemories ??= {};
    this.data.conversationContacts ??= {};
    if (this.data.conversationMemory)
      this.data.conversationMemories[this.activeConversationId] =
        this.data.conversationMemory;
    else delete this.data.conversationMemories[this.activeConversationId];
    if (this.data.recentContacts)
      this.data.conversationContacts[this.activeConversationId] =
        this.data.recentContacts;
    else delete this.data.conversationContacts[this.activeConversationId];
  }
  private conversation() {
    const value = this.data.snapshot.conversations.find(
      (c) => c.id === this.activeConversationId,
    );
    if (!value) throw new Error("Unknown public conversation");
    return value;
  }
  private pruneConversations() {
    const required = new Set([
      this.activeConversationId,
      ...this.data.snapshot.workItems.map((w) => w.conversationId),
    ]);
    const room = Math.min(40, Math.max(0, 501 - required.size));
    const recent = room
      ? this.data.snapshot.conversations
          .filter((c) => !required.has(c.id))
          .slice(-room)
      : [];
    for (const c of recent) required.add(c.id);
    this.data.snapshot.conversations = this.data.snapshot.conversations.filter(
      (c) => required.has(c.id),
    );
  }
  syncNativeWork(
    items: WorkItem[],
    persist = true,
    authoritative = false,
    publishAnswer?: (workId: string, questionId: string) => boolean,
  ) {
    let changed = false;
    items = items.map((work) => WorkItemSchema.parse(work));
    if (
      items.length > 400 ||
      new Set(items.map((w) => w.id)).size !== items.length
    )
      throw new Error("Invalid native work window");
    const budget = Math.max(
      0,
      Math.min(
        400,
        500 -
          this.data.snapshot.workItems.filter((work) => !work.native).length,
      ),
    );
    const keep = new Set(items.slice(0, budget).map((w) => w.id));
    if (!authoritative) {
      const existing = this.data.snapshot.workItems
        .filter((work) => work.native)
        .toReversed();
      for (const work of existing) keep.add(work.id);
      if (keep.size > budget) throw new Error("native_work_window_required");
    }
    const retained = this.data.snapshot.workItems.filter(
      (work) => !work.native || keep.has(work.id),
    );
    if (retained.length !== this.data.snapshot.workItems.length) {
      this.data.snapshot.workItems = retained;
      // Entity removals require a new snapshot. Commit its floor with the outbox.
      this.data.eventFloor = ++this.data.snapshot.cursor;
      this.data.events = [];
      changed = true;
    }
    for (let work of items) {
      if (!work.native || work.demo) throw new Error("Expected native work");
      if (!keep.has(work.id)) continue;
      if (
        !this.data.snapshot.conversations.some(
          (c) => c.id === work.conversationId,
        )
      ) {
        const conversation =
          this.loadConversation?.(work.conversationId) ??
          this.deletedConversations?.shell(work.conversationId);
        if (!conversation)
          throw new Error("Unknown native public conversation");
        this.data.snapshot.conversations.push(conversation);
      }
      const current = this.data.snapshot.workItems.find(
        (item) => item.id === work.id,
      );
      if (
        current &&
        ((current.native?.revision ?? 0) > work.native.revision ||
          isDeepStrictEqual(
            { ...current, revision: 0 },
            { ...work, revision: 0 },
          ))
      )
        continue;
      if (current)
        work = {
          ...work,
          revision: Math.max(current.revision + 1, work.revision),
        };
      if (current)
        this.data.snapshot.workItems[
          this.data.snapshot.workItems.indexOf(current)
        ] = work;
      else this.data.snapshot.workItems.push(work);
      this.emit({ type: "work_item.upserted", entity: work });
      const history = work.native?.process?.answerHistory;
      const previousAnswers = new Set(
        current?.native?.process?.answerHistory?.map(
          (entry) => entry.questionId,
        ),
      );
      // An archived chat is read-only: its answers stay with the task.
      const conversation =
        history?.length && !this.archivedConversation?.(work.conversationId)
          ? this.data.snapshot.conversations.find(
              (c) => c.id === work.conversationId,
            )
          : undefined;
      if (conversation && history) {
        let added = false;
        for (const entry of history) {
          const id = `message-process-answer-${entry.questionId}`;
          if (publishAnswer && !publishAnswer(work.id, entry.questionId))
            continue;
          const existing = conversation.messages.find(
            (message) => message.id === id,
          );
          if (existing) {
            if (
              existing.role !== "user" ||
              existing.text !== entry.answer ||
              existing.workItemId !== work.id
            )
              throw Error("process_answer_history_conflict");
            continue;
          }
          // The retained WorkItem also remembers answers already archived from chat.
          if (previousAnswers.has(entry.questionId)) continue;
          conversation.messages.push({
            id,
            role: "user",
            text: entry.answer,
            workItemId: work.id,
            createdAt: new Date(this.now()).toISOString(),
          });
          added = true;
        }
        if (added) {
          conversation.messages = conversation.messages.slice(-500);
          conversation.revision++;
          this.emit({ type: "conversation.upserted", entity: conversation });
        }
      }
      changed = true;
    }
    if (persist && changed) this.commit();
  }
  snapshot() {
    const snapshot = structuredClone(this.data.snapshot);
    snapshot.conversations = snapshot.conversations.map((conversation) =>
      conversation.id === this.activeConversationId
        ? conversation
        : { ...conversation, messages: [] },
    );
    snapshot.workItems = snapshot.workItems.map((work) =>
      this.clientWork(work),
    );
    return snapshot;
  }
  /** What an events poll checks against, without copying every chat. */
  pollState() {
    return {
      conversations: this.data.snapshot.conversations.length,
      workItems: this.data.snapshot.workItems.map((work) =>
        this.clientWork(structuredClone(work)),
      ),
    };
  }
  private clientWork(work: WorkItem): WorkItem {
    return {
      ...work,
      card: work.native
        ? work.native.process
          ? work.card
          : undefined
        : (work.card ?? workCard(work, this.cardLanguage)),
    };
  }
  private currentMemory(
    timeZone: string,
    text?: string,
  ): ConversationMemory | undefined {
    const explicitLast =
      !!text && refersToLastMeeting(text) && !startsNewMeeting(text);
    if (this.data.conversationMemory && !explicitLast)
      return this.data.conversationMemory;
    // Compatibility for an immediately preceding unfinished card created before structured memory.
    // Only an explicit last-meeting reference may cross another reply/topic; closed work remains locked.
    const messages = this.conversation().messages;
    const last = messages.at(-1);
    const work = explicitLast
      ? this.data.snapshot.workItems
          .filter((w) => w.conversationId === this.activeConversationId)
          .at(-1)
      : last?.role === "assistant" && last.workItemId
        ? this.data.snapshot.workItems.find((w) => w.id === last.workItemId)
        : undefined;
    if (
      !work ||
      (!explicitLast &&
        !["waiting_input", "waiting_approval"].includes(work.status))
    )
      return;
    const saved = this.data.conversationMemory;
    if (
      explicitLast &&
      saved?.meeting?.workItemId === work.id &&
      meetingContext(
        saved,
        this.data.snapshot,
        this.now(),
        timeZone,
        this.data.meetingDrafts,
      )
    )
      return saved;
    const proposal = this.data.snapshot.actionProposals.find(
      (p) => p.id === work.actionProposalIds.at(-1),
    );
    const startsAt =
      proposal?.parameters.startsAt ??
      this.data.meetingDrafts?.[work.id]?.startsAt;
    if (!startsAt || (!explicitLast && Date.parse(startsAt) <= this.now()))
      return;
    return {
      conversationId: this.activeConversationId,
      updatedAt: this.now(),
      historyFrom: Math.max(0, messages.length - 1),
      timeZone,
      meeting: {
        workItemId: work.id,
        slots: { ...emptyMeeting(), contactName: "Peter" },
      },
    };
  }
  modelState(
    timeZone: string,
    text?: string,
    conversationId = this.activeConversationId,
  ) {
    this.selectConversation(conversationId);
    const snapshot = this.snapshot();
    const memory = this.currentMemory(timeZone, text);
    const fresh =
      memory &&
      this.now() - memory.updatedAt <= MEMORY_TTL_MS &&
      this.now() >= memory.updatedAt &&
      memory.timeZone === timeZone;
    return {
      snapshot,
      recentContacts:
        this.data.recentContacts &&
        this.now() >= this.data.recentContacts.updatedAt &&
        this.now() - this.data.recentContacts.updatedAt <= MEMORY_TTL_MS
          ? this.data.recentContacts.result.contacts.map((c) => ({
              id: c.id,
              label: c.name,
            }))
          : [],
      activeMeeting: meetingContext(
        memory,
        snapshot,
        this.now(),
        timeZone,
        this.data.meetingDrafts,
      ),
      historyFrom: memory
        ? fresh
          ? memory.historyFrom
          : this.conversation().messages.length
        : 0,
    };
  }
  private remember(
    slots: MeetingSlots | null,
    workItemId: string | null,
    timeZone: string,
    historyFrom?: number,
    pendingProposalRevision?: number,
  ) {
    this.data.conversationMemory = {
      conversationId: this.activeConversationId,
      updatedAt: this.now(),
      timeZone,
      historyFrom:
        historyFrom ??
        this.data.conversationMemory?.historyFrom ??
        this.conversation().messages.length,
      meeting: slots
        ? {
            workItemId,
            slots,
            ...(pendingProposalRevision ? { pendingProposalRevision } : {}),
          }
        : null,
    };
  }
  /**
   * Closes the current chat session: its messages leave the live snapshot and
   * short-term memory is cleared. Work items stay (they appear under Tasks).
   * Returns the archived messages so storage can keep them for long-term use.
   */
  startSession(conversationId = "conversation-1") {
    this.selectConversation(conversationId);
    const conversation = this.conversation();
    const archived = conversation.messages;
    const hadMemory =
      !!this.data.conversationMemory || !!this.data.recentContacts;
    this.data.conversationMemory = undefined;
    this.data.recentContacts = undefined;
    if (archived.length) {
      conversation.messages = [];
      conversation.revision++;
      this.emit({ type: "conversation.upserted", entity: conversation });
    }
    if (archived.length || hadMemory) this.commit();
    return archived.length ? archived : null;
  }
  private emit(event: Pick<DomainEvent, "type" | "entity">) {
    if (event.type === "work_item.upserted") {
      const work = event.entity as WorkItem;
      if (!work.native && (!work.card || work.card.revision !== work.revision))
        work.card = workCard(work, this.cardLanguage);
    }
    const sequence = ++this.data.snapshot.cursor;
    const parsed = EventSchema.parse({
      ...event,
      eventId: `event-${sequence}`,
      sequence,
      scope: this.data.snapshot.scope,
    });
    this.data.events.push(parsed);
    this.data.events = this.data.events.slice(-1000);
  }
  private message(
    text: string,
    commandId: string,
    role: "user" | "assistant",
    workItemId?: string,
    inputRequestId?: string,
    result?: z.infer<typeof MessageResultSchema>,
    ui?: GeneratedUi,
  ) {
    const conversation = this.conversation();
    if (
      role === "user" &&
      this.activeLogicalMessageId &&
      conversation.messages.some(
        (message) =>
          message.role === "user" &&
          message.logicalMessageId === this.activeLogicalMessageId,
      )
    )
      return;
    conversation.revision++;
    conversation.messages.push({
      id: `message-${commandId}-${conversation.revision}`,
      role,
      text,
      ...(role === "user" && this.activeLogicalMessageId
        ? { logicalMessageId: this.activeLogicalMessageId }
        : {}),
      ...(role === "assistant" ? { replyToCommandId: commandId } : {}),
      ...(workItemId ? { workItemId } : {}),
      ...(inputRequestId ? { inputRequestId } : {}),
      ...(role === "user" && this.attachedTask?.commandId === commandId
        ? { humanTask: this.attachedTask.task }
        : {}),
      ...(result ? { result: MessageResultSchema.parse(result) } : {}),
      ...(ui && role === "assistant"
        ? { ui: GeneratedUiSchema.parse(ui) }
        : {}),
      createdAt: new Date(this.now()).toISOString(),
    });
    conversation.messages = conversation.messages.slice(-500);
    this.emit({ type: "conversation.upserted", entity: conversation });
  }
  private result(
    command: Command,
    status: CommandResult["status"],
    code: CommandResult["code"],
  ): CommandResult {
    const openWork =
      status === "rejected" &&
      code === "operation_in_progress" &&
      (command.type === "conversation.delete" ||
        command.type === "conversation.archive")
        ? this.openWork(command.conversationId)
        : [];
    return {
      commandId: command.commandId,
      status,
      code,
      ...(openWork.length ? { openWork } : {}),
      snapshot: this.snapshot(),
    };
  }
  /** What still waits in a chat, for the refusal to name it. */
  openWork(conversationId: string): OpenWork[] {
    return this.data.snapshot.workItems
      .filter(
        (work) =>
          work.conversationId === conversationId &&
          isOpenWork(work, this.data.pending),
      )
      .slice(0, 50)
      .map((work) => ({
        workItemId: work.id,
        title: work.title.slice(0, 160),
        kind: openWorkKind(work),
      }));
  }
  /**
   * Stops a fixture calendar task that waits for the person: its open
   * question is cancelled and its proposal rejected (declined, no effect).
   * A task already running or retrying a dispatched write is not touched.
   */
  private cancelDemoWork(work: WorkItem) {
    if (!["waiting_input", "waiting_approval"].includes(work.status))
      return false;
    for (const input of this.data.snapshot.inputRequests)
      if (input.workItemId === work.id && input.status === "open") {
        input.status = "cancelled";
        input.revision++;
        this.emit({ type: "input_request.upserted", entity: input });
      }
    for (const proposal of this.data.snapshot.actionProposals)
      if (
        proposal.workItemId === work.id &&
        proposal.status === "awaiting_approval"
      ) {
        proposal.status = "rejected";
        delete proposal.approval;
        proposal.revision++;
        this.emit({ type: "action_proposal.upserted", entity: proposal });
      }
    this.data.pending = this.data.pending.filter(
      (job) => job.workItemId !== work.id || job.kind === "calendar_operation",
    );
    work.status = "cancelled";
    work.revision++;
    this.emit({ type: "work_item.upserted", entity: work });
    return true;
  }
  /** `cancelOpenWork`: the chat's fixture tasks stop here, in the directory
   * command's transaction; native work was settled before it. */
  private cancelChatWork(conversationId: string) {
    for (const work of this.data.snapshot.workItems)
      if (
        work.conversationId === conversationId &&
        work.demo &&
        isOpenWork(work, this.data.pending)
      )
        this.cancelDemoWork(work);
  }
  private cancelWork(
    command: Extract<Command, { type: "work.cancel" }>,
    options: ExecuteOptions,
  ): CommandResult {
    const work = this.data.snapshot.workItems.find(
      (item) => item.id === command.workItemId,
    );
    if (!work || work.conversationId !== command.conversationId)
      return this.result(command, "rejected", "unknown_context");
    if (options.workCancelled && !isOpenWork(work, this.data.pending))
      return this.result(command, "accepted", "accepted");
    if (work.revision !== command.expectedWorkRevision)
      return this.result(command, "conflict", "revision_conflict");
    // Already settled at the revision the person saw: nothing left to stop.
    if (!isOpenWork(work, this.data.pending))
      return this.result(command, "accepted", "accepted");
    if (work.demo)
      return this.cancelDemoWork(work)
        ? this.result(command, "accepted", "accepted")
        : this.result(command, "conflict", "operation_in_progress");
    // Native work is stopped by its runtime before this receipt is written.
    return this.result(command, "rejected", "integration_unavailable");
  }
  /** The receipt of a command id or idempotency key, however old. */
  private receiptOf(commandId: string, idempotencyKey = commandId) {
    return (
      this.data.receipts.find(
        (r) =>
          r.command.commandId === commandId ||
          r.command.idempotencyKey === idempotencyKey,
      ) ?? this.olderReceipt?.(commandId, idempotencyKey)
    );
  }
  replay(raw: unknown): CommandResult | undefined {
    const command = CommandSchema.parse(raw);
    const existing = this.receiptOf(command.commandId, command.idempotencyKey);
    if (existing)
      return JSON.stringify(existing.command) === JSON.stringify(command)
        ? this.result(command, existing.status, existing.code)
        : this.result(command, "rejected", "idempotency_conflict");
  }
  execute(
    raw: unknown,
    interpretation?: Interpretation,
    options: ExecuteOptions = {},
  ): CommandResult {
    const command = CommandSchema.parse(raw);
    this.executeOptions = options;
    this.activeLogicalMessageId =
      command.type === "message.send"
        ? (command.logicalMessageId ?? command.commandId)
        : undefined;
    this.selectConversation(command.conversationId);
    this.attachedTask =
      command.type === "message.send" && command.humanTask
        ? { commandId: command.commandId, task: command.humanTask }
        : undefined;
    if (command.type === "message.send" && command.retryOf) {
      const parent = this.receiptOf(command.retryOf, command.retryOf);
      const intent = (value: typeof command) => {
        const {
          commandId: _commandId,
          idempotencyKey: _idempotencyKey,
          logicalMessageId: _logicalMessageId,
          retryOf: _retryOf,
          session: _session,
          ...canonical
        } = value;
        return JSON.stringify(canonical);
      };
      if (
        (parent &&
          (parent.command.type !== "message.send" ||
            (parent.command.logicalMessageId ?? parent.command.commandId) !==
              command.logicalMessageId ||
            intent(parent.command) !== intent(command))) ||
        (!parent && !interpretation?.nativeRetryAuthorized)
      )
        return this.result(command, "conflict", "idempotency_conflict");
    }
    const existing = this.replay(command);
    if (existing) return existing;
    // A deleted chat takes no further turns, answers or names.
    if (
      command.type !== "conversation.delete" &&
      this.deletedConversations?.has(command.conversationId)
    ) {
      this.data.receipts.push({
        command,
        status: "rejected",
        code: "unknown_context",
      });
      this.commit();
      return this.result(command, "rejected", "unknown_context");
    }
    // An archived chat takes no turns or answers until it is restored.
    if (
      !ARCHIVE_COMMANDS.has(command.type) &&
      this.archivedConversation?.(command.conversationId)
    ) {
      this.data.receipts.push({
        command,
        status: "rejected",
        code: "unknown_context",
      });
      this.commit();
      return this.result(command, "rejected", "unknown_context");
    }
    const before = structuredClone(this.data);
    const previousMemory = this.data.conversationMemory;
    const messageText =
      command.type === "message.send" && !command.context
        ? command.text
        : undefined;
    const initialMemory = interpretation
      ? this.currentMemory(interpretation.timeZone, messageText)
      : undefined;
    try {
      if (
        interpretation?.terminal?.reply &&
        this.data.snapshot.conversations.some(
          (conversation) => conversation.id === command.conversationId,
        )
      ) {
        const submitted = command.type === "message.send" ? command : undefined;
        if (submitted) this.message(submitted.text, command.commandId, "user");
        this.message(
          interpretation.terminal.reply,
          command.commandId,
          "assistant",
        );
      }
      const result = interpretation?.terminal
        ? this.result(
            command,
            interpretation.terminal.status,
            interpretation.terminal.code,
          )
        : interpretation &&
            !interpretation.serviceResult &&
            (interpretation.expectedConversationRevision !== undefined
              ? this.data.snapshot.conversations.find(
                  (conversation) => conversation.id === command.conversationId,
                )?.revision !== interpretation.expectedConversationRevision
              : this.data.snapshot.cursor !== interpretation.expectedCursor)
          ? this.result(command, "conflict", "revision_conflict")
          : this.handle(command, interpretation);
      if (
        result.status === "accepted" &&
        initialMemory &&
        (!this.data.conversationMemory ||
          (messageText &&
            refersToLastMeeting(messageText) &&
            !startsNewMeeting(messageText) &&
            this.data.conversationMemory === previousMemory &&
            ["reply", "meeting_patch"].includes(interpretation!.decision.kind)))
      )
        this.data.conversationMemory = initialMemory;
      if (
        result.status === "accepted" &&
        command.type !== "message.send" &&
        "workItemId" in command &&
        !!command.workItemId &&
        this.data.conversationMemory?.meeting?.workItemId === command.workItemId
      )
        this.data.conversationMemory.updatedAt = this.now();
      this.data.receipts.push({
        command,
        status: result.status,
        code: result.code,
      });
      this.commit();
      return this.result(command, result.status, result.code);
    } catch (error) {
      this.data = before;
      throw error;
    }
  }
  /**
   * Removes a chat's messages and short-term memory. Server-owned chats that
   * apps reuse by id (the main chat, a hub item's chat) are emptied and stay
   * usable; any other chat leaves the snapshot. Removal needs a new snapshot,
   * so the event log restarts at a new floor (retained events held messages).
   */
  private deleteConversation(
    command: Extract<Command, { type: "conversation.delete" }>,
  ): CommandResult {
    const id = command.conversationId;
    if (this.deletedConversations?.has(id))
      return this.result(command, "accepted", "accepted");
    const conversation = this.data.snapshot.conversations.find(
      (c) => c.id === id,
    );
    if (!conversation && !this.conversationExists?.(id))
      return this.result(command, "rejected", "unknown_context");
    if (command.cancelOpenWork) this.cancelChatWork(id);
    const work = this.data.snapshot.workItems.filter(
      (w) => w.conversationId === id,
    );
    // An open question, approval or running task still belongs to this chat.
    if (work.some((w) => isOpenWork(w, this.data.pending)))
      return this.result(command, "rejected", "operation_in_progress");
    if (id === this.activeConversationId) {
      this.data.conversationMemory = undefined;
      this.data.recentContacts = undefined;
    }
    delete this.data.conversationMemories?.[id];
    delete this.data.conversationContacts?.[id];
    if (conversation) {
      if (resettableConversation(id) || work.length) {
        conversation.messages = [];
        conversation.revision++;
      } else
        this.data.snapshot.conversations =
          this.data.snapshot.conversations.filter((c) => c !== conversation);
    }
    this.data.eventFloor = ++this.data.snapshot.cursor;
    this.data.events = [];
    return this.result(command, "accepted", "accepted");
  }
  /**
   * Archiving and restoring change the directory (storage) in the same
   * transaction. Here: the same open-work rule as deletion, short-term memory,
   * and the live projection. An archived chat leaves the snapshot (a retained
   * task keeps an empty reference). The main chat's messages are moved into a
   * new archived chat by storage, as a new session does. Either change
   * restarts the event log, so every client re-reads its chat list.
   */
  private archiveConversation(
    command: Extract<
      Command,
      { type: "conversation.archive" | "conversation.restore" }
    >,
  ): CommandResult {
    const id = command.conversationId;
    const conversation = this.data.snapshot.conversations.find(
      (c) => c.id === id,
    );
    if (!conversation && !this.conversationExists?.(id))
      return this.result(command, "rejected", "unknown_context");
    const archived = !!this.archivedConversation?.(id);
    if (command.type === "conversation.restore") {
      if (archived) {
        this.data.eventFloor = ++this.data.snapshot.cursor;
        this.data.events = [];
      }
      return this.result(command, "accepted", "accepted");
    }
    if (archived) return this.result(command, "accepted", "accepted");
    if (!archivableConversation(id))
      return this.result(command, "rejected", "unknown_context");
    if (command.type === "conversation.archive" && command.cancelOpenWork)
      this.cancelChatWork(id);
    const work = this.data.snapshot.workItems.filter(
      (w) => w.conversationId === id,
    );
    if (work.some((w) => isOpenWork(w, this.data.pending)))
      return this.result(command, "rejected", "operation_in_progress");
    if (!resettableConversation(id)) {
      if (id === this.activeConversationId) {
        this.data.conversationMemory = undefined;
        this.data.recentContacts = undefined;
      }
      delete this.data.conversationMemories?.[id];
      delete this.data.conversationContacts?.[id];
      if (conversation) {
        if (work.length) {
          conversation.messages = [];
          conversation.revision++;
        } else
          this.data.snapshot.conversations =
            this.data.snapshot.conversations.filter((c) => c !== conversation);
      }
    }
    this.data.eventFloor = ++this.data.snapshot.cursor;
    this.data.events = [];
    return this.result(command, "accepted", "accepted");
  }
  /**
   * After storage restored a chat: its messages replace the empty reference a
   * retained task kept, under a revision above both.
   */
  restoreConversation(id: string, load: (minimumRevision: number) => void) {
    const shell = this.data.snapshot.conversations.find((c) => c.id === id);
    load(shell?.revision ?? 0);
    const stored = this.loadConversation?.(id);
    if (!stored) throw new Error("Restored conversation is missing");
    const restored = ConversationSchema.parse(stored);
    this.data.snapshot.conversations = [
      ...this.data.snapshot.conversations.filter((c) => c.id !== id),
      restored,
    ];
    this.emit({ type: "conversation.upserted", entity: restored });
    this.commit();
  }
  private handle(
    command: Command,
    interpretation?: Interpretation,
  ): CommandResult {
    const replyText =
      interpretation?.nativeReply !== undefined
        ? z.string().max(2000).parse(interpretation.nativeReply)
        : interpretation?.decision.reply;
    if (command.type === "conversation.create") {
      if (
        this.data.snapshot.conversations.some(
          (c) => c.id === command.conversationId,
        ) ||
        this.conversationExists?.(command.conversationId)
      )
        return this.result(command, "rejected", "unknown_context");
      const conversation = {
        id: command.conversationId,
        revision: 1,
        messages: [],
      };
      this.data.snapshot.conversations.push(conversation);
      this.emit({ type: "conversation.upserted", entity: conversation });
      return this.result(command, "accepted", "accepted");
    }
    if (command.type === "conversation.rename") {
      // The name lives in the chat directory (storage); the conversation entity,
      // its revision and any reply in flight stay exactly as they are.
      return this.data.snapshot.conversations.some(
        (c) => c.id === command.conversationId,
      ) || this.conversationExists?.(command.conversationId)
        ? this.result(command, "accepted", "accepted")
        : this.result(command, "rejected", "unknown_context");
    }
    if (command.type === "conversation.delete")
      return this.deleteConversation(command);
    if (command.type === "work.cancel")
      return this.cancelWork(command, this.executeOptions);
    if (
      command.type === "conversation.archive" ||
      command.type === "conversation.restore"
    )
      return this.archiveConversation(command);
    if ("language" in command) this.cardLanguage = command.language;
    if (
      !this.data.snapshot.conversations.some(
        (c) => c.id === command.conversationId,
      )
    )
      return this.result(command, "rejected", "unknown_context");
    if (interpretation?.nativeWork)
      this.syncNativeWork(
        interpretation.nativeWork,
        false,
        interpretation.nativeWorkAuthoritative,
      );
    if (command.type === "task.open") {
      const work = this.data.snapshot.workItems.find(
        (item) => item.id === command.workItemId,
      );
      if (!work?.native || !interpretation)
        return this.result(command, "rejected", "unknown_context");
      this.message(replyText!, command.commandId, "assistant");
      return this.result(command, "accepted", "accepted");
    }
    if (command.type === "service.resolve") {
      const conversation = this.conversation();
      const message = conversation.messages.find(
        (m) =>
          m.result?.type === "service.action" &&
          m.result.operationId === command.operationId,
      );
      const resolved =
        interpretation?.resolvedServiceResult ?? interpretation?.serviceResult;
      if (message && interpretation?.connectionResult) {
        this.message(
          replyText ?? "",
          command.commandId,
          "assistant",
          undefined,
          undefined,
          interpretation.connectionResult,
        );
        return this.result(command, "accepted", "accepted");
      }
      if (
        !message &&
        resolved &&
        resolved.operationId === command.operationId &&
        interpretation?.nativeWork?.some(
          (work) =>
            work.native?.action?.operationId === command.operationId ||
            work.id === command.workItemId,
        )
      ) {
        this.message(
          replyText!,
          command.commandId,
          "assistant",
          undefined,
          undefined,
          interpretation!.serviceResult ?? resolved,
        );
        return this.result(command, "accepted", "accepted");
      }
      if (!message || !resolved || resolved.operationId !== command.operationId)
        return this.result(command, "rejected", "unknown_context");
      message.result = resolved;
      if (
        interpretation?.resolvedServiceResult &&
        interpretation.serviceResult?.operationId !== command.operationId
      ) {
        const continuation = interpretation.serviceResult;
        const alreadyShown = continuation
          ? conversation.messages.some(
              (m) =>
                m.result?.type === "service.action" &&
                m.result.operationId === continuation.operationId,
            )
          : message.text ===
            (command.language === "cs" ? "Krok dokončen." : "Step completed.");
        message.text =
          command.language === "cs" ? "Krok dokončen." : "Step completed.";
        if (!alreadyShown) {
          const nativeWork =
            !interpretation.serviceResult && !interpretation.ui
              ? interpretation.nativeWork?.find(
                  (work) => work.id === interpretation.workItemId,
                )
              : undefined;
          this.message(
            replyText ?? "",
            command.commandId,
            "assistant",
            nativeWork?.id,
            nativeWork?.native?.question?.id,
            interpretation.serviceResult,
            interpretation.ui,
          );
        }
      } else {
        message.text = replyText ?? message.text;
        // The same canonical card now carries this decision's native reply.
        // Foreground speech must follow its command, including terminal failure.
        if (interpretation?.nativeReply !== undefined)
          message.replyToCommandId = command.commandId;
      }
      conversation.revision++;
      this.emit({ type: "conversation.upserted", entity: conversation });
      return this.result(command, "accepted", "accepted");
    }
    const decision =
      interpretation && command.type === "message.send"
        ? DecisionSchema.parse(interpretation.decision)
        : undefined;
    if (
      command.type === "message.send" &&
      !command.context &&
      decision?.kind === "meeting_patch"
    )
      return this.patchMeeting(command, interpretation!);
    if (
      command.type === "message.send" &&
      !command.context &&
      decision?.kind === "new_topic"
    ) {
      delete this.data.recentContacts;
      this.remember(
        null,
        null,
        interpretation!.timeZone,
        this.conversation().messages.length,
      );
      this.message(command.text, command.commandId, "user");
      this.message(
        (replyText ?? decision.reply)!,
        command.commandId,
        "assistant",
      );
      return this.result(command, "accepted", "accepted");
    }
    if (command.type === "operation.reconcile") {
      const op = this.data.snapshot.operations.find(
        (o) => o.id === command.operationId,
      );
      const work = this.data.snapshot.workItems.find(
        (w) => w.id === command.workItemId,
      );
      if (
        !op ||
        !work ||
        op.workItemId !== work.id ||
        op.conversationId !== command.conversationId
      )
        return this.result(command, "rejected", "unknown_context");
      if (
        !op.parameters.calendar ||
        op.status !== "result_unknown" ||
        op.revision !== command.expectedOperationRevision
      )
        return this.result(command, "conflict", "revision_conflict");
      if (
        JSON.stringify(op.parameters.calendar) !== JSON.stringify(this.calendar)
      )
        return this.result(command, "rejected", "integration_unavailable");
      this.data.pending = this.data.pending.filter(
        (p) => p.operationId !== op.id,
      );
      this.data.pending.push({
        workItemId: work.id,
        operationId: op.id,
        kind: "calendar_operation",
        dueAt: this.now(),
        attempts: 0,
      });
      op.status = "executing";
      delete op.error;
      op.revision++;
      work.status = "running";
      work.revision++;
      this.emit({ type: "operation.upserted", entity: op });
      this.emit({ type: "work_item.upserted", entity: work });
      return this.result(command, "accepted", "accepted");
    }
    if (
      command.type === "proposal.decide" ||
      command.type === "proposal.revise"
    )
      return this.proposalCommand(command);
    const context = command.type === "input.submit" ? command : command.context;
    if (context && context.runtime !== "mastra") {
      const input = this.data.snapshot.inputRequests.find(
        (i) => i.id === context.inputRequestId,
      );
      const work = this.data.snapshot.workItems.find(
        (w) => w.id === context.workItemId,
      );
      if (
        !input ||
        !work ||
        input.workItemId !== work.id ||
        input.conversationId !== command.conversationId
      )
        return this.result(command, "rejected", "unknown_context");
      if (
        input.revision !== context.expectedInputRevision ||
        input.status !== "open" ||
        work.status !== "waiting_input"
      )
        return this.result(command, "conflict", "revision_conflict");
      if (decision?.kind === "reply" && command.type === "message.send") {
        this.message(command.text, command.commandId, "user");
        this.message(
          (replyText ?? decision.reply)!,
          command.commandId,
          "assistant",
        );
        return this.result(command, "accepted", "accepted");
      }
      const normalized =
        command.type === "message.send"
          ? command.text.trim().toLocaleLowerCase().replace(/[.!]$/, "")
          : "";
      const selected = decision
        ? decision.kind === "contact"
          ? decision.contactId
          : null
        : command.type === "input.submit"
          ? command.answer.selectedContactId
          : (
              {
                "choose peter novák": "peter-novak",
                "choose peter novak": "peter-novak",
                "choose peter svoboda": "peter-svoboda",
                "vyber petera nováka": "peter-novak",
                "vyber petera svobodu": "peter-svoboda",
              } as Record<string, string>
            )[normalized];
      if (!selected || !input.options.some((o) => o.id === selected))
        return this.result(command, "rejected", "invalid_answer");
      this.message(
        command.type === "message.send"
          ? command.text
          : input.options.find((o) => o.id === selected)!.label,
        command.commandId,
        "user",
        work.id,
        input.id,
      );
      input.status = "resolved";
      input.revision++;
      input.resolution = {
        selectedContactId: selected,
        source: command.type === "message.send" ? "chat" : "card",
        reason: "The server validated the contact against this task's options.",
      };
      this.emit({ type: "input_request.upserted", entity: input });
      work.status = "running";
      work.revision++;
      this.emit({ type: "work_item.upserted", entity: work });
      this.data.pending.push({
        workItemId: work.id,
        dueAt: this.now() + 4000,
        kind: "prepare_proposal",
      });
      return this.result(command, "accepted", "accepted");
    }
    if (decision && command.type === "message.send") {
      if (decision.kind === "reply") {
        if (interpretation?.contactResult) {
          this.data.recentContacts = {
            updatedAt: this.now(),
            result: CrmContactResultSchema.parse(interpretation.contactResult),
          };
          this.remember(
            null,
            null,
            interpretation.timeZone,
            this.conversation().messages.length,
          );
        } else if (
          this.data.conversationMemory &&
          this.modelState(
            interpretation!.timeZone,
            undefined,
            this.activeConversationId,
          ).activeMeeting
        )
          this.data.conversationMemory.updatedAt = this.now();
        this.message(command.text, command.commandId, "user");
        const nativeWork =
          !interpretation?.connectionResult &&
          !interpretation?.serviceResult &&
          !interpretation?.ui &&
          !interpretation?.processOffer &&
          !interpretation?.skillProposal &&
          !interpretation?.processProposal &&
          !interpretation?.contactResult
            ? interpretation?.nativeWork?.find(
                (work) => work.id === interpretation.workItemId,
              )
            : undefined;
        this.message(
          (replyText ?? decision.reply)!,
          command.commandId,
          "assistant",
          nativeWork?.id,
          nativeWork?.native?.question?.id,
          interpretation?.connectionResult ??
            interpretation?.serviceResult ??
            interpretation?.processOffer ??
            interpretation?.skillProposal ??
            interpretation?.processProposal ??
            interpretation?.contactResult,
          interpretation?.ui,
        );
        return this.result(command, "accepted", "accepted");
      }
      if (decision.kind !== "meeting")
        return this.result(command, "rejected", "unknown_context");
      const startsAt = localToUtc(
        decision.localStart!,
        interpretation!.timeZone,
      );
      if (
        !startsAt ||
        Date.parse(startsAt) <= this.now() ||
        Date.parse(startsAt) > this.now() + 366 * 86400000
      )
        return this.result(command, "rejected", "invalid_proposal");
      const { work, input } = choosePeter(
        command.language,
        String(this.data.nextWork++),
      );
      work.conversationId = command.conversationId;
      input.conversationId = command.conversationId;
      const contacts = interpretation?.contactLookup?.contacts;
      const includeInput = !contacts || contacts.length > 1;
      if (contacts) {
        if (
          !contacts.length ||
          contacts.some((c) => !c.email) ||
          !interpretation.contactLookup!.complete ||
          (decision.contactId &&
            !contacts.some((c) => c.id === decision.contactId))
        )
          return this.result(command, "rejected", "invalid_answer");
        this.saveMeetingContacts(work.id, contacts);
        input.options = contacts.map((c) => ({
          id: c.id,
          label: c.name,
          detail: [c.jobTitle, c.email].filter(Boolean).join(" · "),
        }));
        input.question =
          command.language === "cs"
            ? "Našel jsem více kontaktů v CRM. Koho máš na mysli?"
            : "I found multiple CRM contacts. Which person do you mean?";
        if (!includeInput) work.inputRequestIds = [];
      } else if (
        decision.contactId &&
        !input.options.some((c) => c.id === decision.contactId)
      )
        return this.result(command, "rejected", "invalid_answer");
      work.title = decision.title!;
      work.context = `${decision.localStart!.replace("T", " ")} · ${interpretation!.timeZone} · ${decision.durationMinutes} min`;
      this.data.meetingDrafts ??= {};
      this.data.meetingDrafts[work.id] = {
        startsAt,
        durationMinutes: decision.durationMinutes!,
      };
      this.data.snapshot.workItems.push(work);
      if (includeInput) this.data.snapshot.inputRequests.push(input);
      if (decision.contactId) {
        input.status = "resolved";
        input.revision++;
        input.resolution = {
          selectedContactId: decision.contactId,
          source: "chat",
          reason:
            "The server validated the proposed participant against the configured directory.",
        };
        this.prepareProposal(work, decision.contactId, startsAt);
      } else this.emit({ type: "work_item.upserted", entity: work });
      if (includeInput)
        this.emit({ type: "input_request.upserted", entity: input });
      this.remember(
        {
          contactId: decision.contactId,
          contactName:
            input.options.find((o) => o.id === decision.contactId)?.label ??
            "Peter",
          ...localParts(startsAt, interpretation!.timeZone),
          durationMinutes: decision.durationMinutes,
          title: decision.title,
        },
        work.id,
        interpretation!.timeZone,
        this.conversation().messages.length,
      );
      this.message(command.text, command.commandId, "user");
      this.message(
        decision.contactId
          ? command.language === "cs"
            ? "Návrh schůzky je připravený ke kontrole."
            : "The meeting proposal is ready for review."
          : input.question,
        command.commandId,
        "assistant",
        work.id,
        decision.contactId ? undefined : input.id,
      );
      return this.result(command, "accepted", "accepted");
    }
    if (
      command.type !== "message.send" ||
      !/^(schedule a meeting with peter next week|choose peter|naplánuj schůzku s peterem příští týden)[.!]?$/i.test(
        command.text.trim(),
      )
    )
      return this.result(command, "rejected", "unsupported_phrase");
    const { work, input } = choosePeter(
      command.language,
      String(this.data.nextWork++),
    );
    work.conversationId = command.conversationId;
    input.conversationId = command.conversationId;
    this.data.snapshot.workItems.push(work);
    this.data.snapshot.inputRequests.push(input);
    this.emit({ type: "work_item.upserted", entity: work });
    this.emit({ type: "input_request.upserted", entity: input });
    this.message(command.text, command.commandId, "user");
    this.message(
      input.question,
      command.commandId,
      "assistant",
      work.id,
      input.id,
    );
    return this.result(command, "accepted", "accepted");
  }
  private patchMeeting(
    command: Extract<Command, { type: "message.send" }>,
    interpretation: Interpretation,
  ): CommandResult {
    const patch = {
      ...interpretation.decision.patch!,
      ...(startsNewMeeting(command.text) ? { mode: "new" as const } : {}),
    };
    if (
      patch.mode === "new" &&
      !interpretation.contactLookup &&
      namesOnlyPeter(command.text)
    ) {
      patch.contactId = null;
      patch.contactName = "Peter";
    }
    const context = this.modelState(
      interpretation.timeZone,
      command.text,
    ).activeMeeting;
    const cs = command.language === "cs";
    const respond = (text: string, workId?: string) => {
      this.message(command.text, command.commandId, "user");
      this.message(text, command.commandId, "assistant", workId);
      return this.result(command, "accepted", "accepted");
    };
    if (patch.mode === "continue" && (!context || context.phase === "locked"))
      return respond(
        !context
          ? cs
            ? "Kterou schůzku máš na mysli? Napiš prosím jméno a termín."
            : "Which meeting do you mean? Please give the name and time."
          : cs
            ? "Tato schůzka už není rozpracovaný návrh. Její změnu zatím neumím provést; můžeš zadat novou schůzku."
            : "This meeting is no longer an editable draft. I cannot change it yet; you can request a new meeting.",
      );
    const slots = mergeMeeting(
      patch.mode === "continue" ? context!.slots : emptyMeeting(),
      patch,
    );
    const workId =
      patch.mode === "continue"
        ? this.currentMemory(interpretation.timeZone, command.text)!.meeting!
            .workItemId
        : null;
    const historyFrom =
      patch.mode === "new"
        ? this.conversation().messages.length
        : this.currentMemory(interpretation.timeZone, command.text)
            ?.historyFrom;
    const keepPending = () => {
      const proposal = this.data.snapshot.actionProposals.find(
        (p) => p.workItemId === workId && p.status === "awaiting_approval",
      );
      this.remember(
        slots,
        workId,
        interpretation.timeZone,
        historyFrom,
        proposal?.revision,
      );
    };
    // Never replace an existing proposal with incomplete fields. Keep them as a draft only before work exists.
    if (
      !slots.localDate ||
      !slots.localTime ||
      (!slots.contactId && !slots.contactName)
    ) {
      keepPending();
      return respond(
        !slots.contactId && !slots.contactName
          ? cs
            ? "S kým má být schůzka?"
            : "Who is the meeting with?"
          : !slots.localDate && !slots.localTime
            ? cs
              ? "Kdy má schůzka začít?"
              : "When should the meeting start?"
            : !slots.localDate
              ? cs
                ? "Který den má být schůzka?"
                : "Which day is the meeting?"
              : cs
                ? "V kolik hodin má schůzka začít?"
                : "What time should the meeting start?",
      );
    }
    const localStart = `${slots.localDate}T${slots.localTime}`;
    const startsAt = localToUtc(localStart, interpretation.timeZone);
    if (
      !startsAt ||
      Date.parse(startsAt) <= this.now() ||
      Date.parse(startsAt) > this.now() + 366 * 86400000
    )
      return respond(
        cs
          ? "Upřesni prosím budoucí datum a čas schůzky. Tento termín nelze jednoznačně použít."
          : "Please specify a future date and time. This time cannot be used unambiguously.",
      );
    const lookup =
      interpretation.contactLookup &&
      ContactLookupSchema.parse(interpretation.contactLookup);
    const savedContacts = workId
      ? this.data.meetingContacts?.[workId]
      : undefined;
    if (lookup) {
      if (
        !lookup.complete ||
        !lookup.contacts.length ||
        lookup.contacts.some((c) => !c.email)
      ) {
        // Keep the user's requested facts, but never invent an address or infer uniqueness from a partial page.
        slots.contactId = null;
        keepPending();
        return respond(
          !lookup.complete
            ? cs
              ? "Seznam testovacích kontaktů je neúplný. Vyber konkrétní kontakt z CRM kartičky nebo upřesni jeho identitu."
              : "The test contact list is incomplete. Identify a specific contact from the CRM card."
            : !lookup.contacts.length
              ? cs
                ? "Takový kontakt jsem v testovacím CRM nenašel. Upřesni prosím jméno."
                : "I could not find that contact in the test CRM. Please clarify the name."
              : cs
                ? "U odpovídajícího kontaktu v CRM chybí platný e-mail. Upřesni kontakt nebo doplň jeho e-mail v CRM."
                : "A matching CRM contact has no valid email. Clarify the contact or add their email in CRM.",
        );
      }
      slots.contactId =
        lookup.contacts.length === 1 ? lookup.contacts[0]!.id : null;
      if (slots.contactId) slots.contactName = lookup.contacts[0]!.name;
    }
    const contacts = lookup?.contacts ?? savedContacts;
    const directory = contacts
      ? contacts.map((c) => ({
          id: c.id,
          label: c.name,
          detail: [c.jobTitle, c.email].filter(Boolean).join(" · "),
        }))
      : choosePeter(command.language).input.options;
    if (slots.contactId && !directory.some((c) => c.id === slots.contactId)) {
      keepPending();
      return respond(
        cs
          ? "Tento kontakt nemám ověřený. Upřesni prosím jeho jméno."
          : "This contact is not verified. Please clarify their name.",
      );
    }
    const ambiguousPeter =
      !slots.contactId &&
      /^(peter|petr)(em|a|ovi)?$/i.test(slots.contactName ?? "");
    if (
      !slots.contactId &&
      !ambiguousPeter &&
      !(contacts && contacts.length > 1)
    ) {
      keepPending();
      return respond(
        cs
          ? `Kontakt ${slots.contactName} nemám v testovacím adresáři. Mohu použít Petera Nováka nebo Petera Svobodu?`
          : `The test directory does not contain ${slots.contactName}. Should I use Peter Novák or Peter Svoboda?`,
      );
    }
    const name =
      directory.find((o) => o.id === slots.contactId)?.label ??
      slots.contactName;
    const title = slots.title ?? (cs ? `Schůzka: ${name}` : `Meeting: ${name}`);
    const durationMinutes = slots.durationMinutes ?? 30;
    if (!workId) {
      const result = this.handle(command, {
        ...interpretation,
        decision: {
          kind: "meeting",
          contactId: slots.contactId,
          title,
          localStart,
          durationMinutes,
          reply: null,
        },
      });
      if (result.status === "accepted")
        this.remember(
          { ...slots, durationMinutes },
          this.data.snapshot.workItems.at(-1)!.id,
          interpretation.timeZone,
          historyFrom,
        );
      return result;
    }
    const work = this.data.snapshot.workItems.find((w) => w.id === workId)!;
    const input = this.data.snapshot.inputRequests.find(
      (i) => i.workItemId === workId,
    )!;
    const proposal = this.data.snapshot.actionProposals.find(
      (p) => p.id === work.actionProposalIds.at(-1),
    );
    if (proposal && !slots.contactId) {
      if (lookup) this.saveMeetingContacts(work.id, lookup.contacts);
      keepPending();
      if (lookup && this.data.conversationMemory?.meeting)
        this.data.conversationMemory.meeting.pendingContactOptions = directory;
      return respond(
        contacts
          ? (cs
              ? "Kterého účastníka z CRM chceš? "
              : "Which CRM participant do you mean? ") +
              directory.map((c) => c.label).join(" / ")
          : cs
            ? "Kterého Petera chceš místo původního účastníka: Nováka, nebo Svobodu?"
            : "Which Peter should replace the participant: Novák or Svoboda?",
      );
    }
    // The cursor was checked atomically before this handler. Only an unapproved draft can change.
    if (
      (proposal &&
        (proposal.status !== "awaiting_approval" ||
          work.status !== "waiting_approval")) ||
      (!proposal && work.status !== "waiting_input") ||
      work.operationIds.length
    )
      return this.result(command, "conflict", "revision_conflict");
    work.title = title;
    work.context = `${localStart.replace("T", " ")} · ${interpretation.timeZone} · ${durationMinutes} min`;
    this.data.meetingDrafts ??= {};
    this.data.meetingDrafts[work.id] = { startsAt, durationMinutes };
    if (lookup) {
      this.saveMeetingContacts(work.id, lookup.contacts);
      if (input) {
        const selected = directory.find((c) => c.id === slots.contactId);
        input.options =
          slots.contactId && selected
            ? [
                selected,
                ...input.options.filter((c) => c.id !== selected.id),
              ].slice(0, 20)
            : directory;
        if (!slots.contactId) {
          input.revision++;
          this.emit({ type: "input_request.upserted", entity: input });
        }
      }
    }
    if (slots.contactId) {
      if (input) {
        input.status = "resolved";
        input.resolution = {
          selectedContactId: slots.contactId,
          source: "chat",
          reason:
            "The server validated the contact for the active meeting draft.",
        };
        input.revision++;
        this.emit({ type: "input_request.upserted", entity: input });
      }
      if (proposal) {
        proposal.parameters = this.parameters(
          work,
          slots.contactId,
          startsAt,
          proposal.parameters.calendar,
        )!;
        proposal.revision++;
        this.emit({ type: "action_proposal.upserted", entity: proposal });
      } else this.prepareProposal(work, slots.contactId, startsAt);
    }
    work.revision++;
    this.emit({ type: "work_item.upserted", entity: work });
    this.remember(
      { ...slots, durationMinutes },
      work.id,
      interpretation.timeZone,
      historyFrom,
    );
    const when = new Intl.DateTimeFormat(command.language, {
      timeZone: interpretation.timeZone,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(startsAt));
    return respond(
      cs
        ? `Návrh upraven: ${name} · ${when} · ${durationMinutes} min.`
        : `Draft updated: ${name} · ${when} · ${durationMinutes} min.`,
      work.id,
    );
  }
  private saveMeetingContacts(
    workId: string,
    contacts: ContactLookup["contacts"],
  ) {
    this.data.meetingContacts ??= {};
    const existing = this.data.meetingContacts[workId] ?? [];
    this.data.meetingContacts[workId] = [
      ...contacts,
      ...existing.filter((c) => !contacts.some((n) => n.id === c.id)),
    ]
      .slice(0, 20)
      .map((c) =>
        VerifiedContactSchema.extend({ email: z.email().max(254) }).parse(c),
      );
  }
  private parameters(
    work: WorkItem,
    participantId: string,
    startsAt: string,
    calendar?: CalendarTarget,
  ): MeetingParameters | undefined {
    const input = this.data.snapshot.inputRequests.find(
      (i) => i.workItemId === work.id,
    );
    const verified = this.data.meetingContacts?.[work.id]?.find(
      (c) => c.id === participantId,
    );
    const participant = verified
      ? { id: verified.id, label: verified.name }
      : input?.options.find(
          (o) =>
            o.id === participantId &&
            ["peter-novak", "peter-svoboda"].includes(o.id),
        );
    if (!participant || !Number.isFinite(Date.parse(startsAt))) return;
    return {
      title: work.title,
      participant: {
        id: participant.id,
        label: participant.label,
        email: verified?.email ?? `${participant.id}@example.test`,
      },
      startsAt,
      endsAt: new Date(
        Date.parse(startsAt) +
          (this.data.meetingDrafts?.[work.id]?.durationMinutes ?? 30) * 60_000,
      ).toISOString(),
      timeZone: "UTC",
      ...(calendar ? { calendar: structuredClone(calendar) } : {}),
    };
  }
  private prepareProposal(
    work: WorkItem,
    participantId: string,
    startsAt: string,
  ) {
    const proposal: ActionProposal = {
      id: `proposal-${work.id}`,
      revision: 1,
      workItemId: work.id,
      conversationId: work.conversationId,
      operationType: "calendar.create",
      status: "awaiting_approval",
      demo: true,
      parameters: this.parameters(
        work,
        participantId,
        startsAt,
        this.calendar,
      )!,
      presentation: { type: "action.approval", version: 1, variant: "meeting" },
    };
    this.data.snapshot.actionProposals.push(proposal);
    work.actionProposalIds.push(proposal.id);
    work.status = "waiting_approval";
    work.revision++;
    this.emit({ type: "action_proposal.upserted", entity: proposal });
    this.emit({ type: "work_item.upserted", entity: work });
  }
  private proposalCommand(
    command: Extract<Command, { type: "proposal.decide" | "proposal.revise" }>,
  ): CommandResult {
    const proposal = this.data.snapshot.actionProposals.find(
      (p) => p.id === command.proposalId,
    );
    const work = this.data.snapshot.workItems.find(
      (w) => w.id === command.workItemId,
    );
    if (
      !proposal ||
      !work ||
      proposal.workItemId !== work.id ||
      proposal.conversationId !== command.conversationId
    )
      return this.result(command, "rejected", "unknown_context");
    if (
      proposal.revision !== command.expectedProposalRevision ||
      proposal.status === "rejected" ||
      !["waiting_approval", "running"].includes(work.status)
    )
      return this.result(command, "conflict", "revision_conflict");
    const previous = this.data.snapshot.operations.find(
      (o) => o.id === proposal.approval?.operationId,
    );
    if (previous && previous.status !== "pending")
      return this.result(command, "conflict", "operation_in_progress");
    if (command.type === "proposal.decide" && command.decision === "approve") {
      if (
        proposal.status !== "awaiting_approval" ||
        work.status !== "waiting_approval"
      )
        return this.result(command, "conflict", "revision_conflict");
      if (
        proposal.parameters.calendar &&
        JSON.stringify(proposal.parameters.calendar) !==
          JSON.stringify(this.calendar)
      )
        return this.result(command, "rejected", "integration_unavailable");
      if (Date.parse(proposal.parameters.startsAt) <= this.now())
        return this.result(command, "rejected", "invalid_proposal");
      const operation: Operation = {
        id: `operation-${proposal.id}-${proposal.revision}`,
        revision: 1,
        workItemId: work.id,
        conversationId: work.conversationId,
        proposalId: proposal.id,
        acceptedProposalRevision: proposal.revision,
        idempotencyKey: command.idempotencyKey,
        parameters: structuredClone(proposal.parameters),
        status: "pending",
        demo: true,
      };
      this.data.snapshot.operations.push(operation);
      work.operationIds.push(operation.id);
      proposal.approval = {
        proposalRevision: proposal.revision,
        operationId: operation.id,
        commandId: command.commandId,
      };
      proposal.status = "approved";
      work.status = "running";
      this.data.pending.push({
        workItemId: work.id,
        operationId: operation.id,
        kind: "start_operation",
        dueAt: this.now() + 4000,
      });
      this.emit({ type: "operation.upserted", entity: operation });
    } else {
      const parameters =
        command.type === "proposal.revise"
          ? this.parameters(
              work,
              command.changes.participantId,
              command.changes.startsAt,
              proposal.parameters.calendar,
            )
          : undefined;
      if (
        command.type === "proposal.revise" &&
        (!parameters || Date.parse(parameters.startsAt) <= this.now())
      )
        return this.result(command, "rejected", "invalid_proposal");
      if (previous) {
        previous.status = "cancelled";
        previous.revision++;
        this.data.pending = this.data.pending.filter(
          (p) => p.operationId !== previous.id,
        );
        this.emit({ type: "operation.upserted", entity: previous });
      }
      delete proposal.approval;
      if (parameters) {
        proposal.parameters = parameters;
        proposal.status = "awaiting_approval";
        work.status = "waiting_approval";
      } else {
        proposal.status = "rejected";
        work.status = "cancelled";
      }
    }
    proposal.revision++;
    work.revision++;
    this.emit({ type: "action_proposal.upserted", entity: proposal });
    this.emit({ type: "work_item.upserted", entity: work });
    return this.result(command, "accepted", "accepted");
  }
  tick() {
    const now = this.now();
    const due = this.data.pending.filter(
      (p) => p.dueAt <= now && p.kind !== "calendar_operation",
    );
    if (!due.length) return;
    const before = structuredClone(this.data);
    try {
      for (const pending of due) {
        const work = this.data.snapshot.workItems.find(
          (w) => w.id === pending.workItemId,
        );
        if (!work) continue;
        if (
          pending.kind === "prepare_proposal" &&
          work.status === "running" &&
          work.actionProposalIds.length === 0
        ) {
          const input = this.data.snapshot.inputRequests.find(
            (i) => i.workItemId === work.id && i.status === "resolved",
          );
          if (!input?.resolution) throw new Error("Missing selected contact");
          const date = new Date(this.now());
          date.setUTCDate(
            date.getUTCDate() + (8 - (date.getUTCDay() || 7)) + 1,
          );
          date.setUTCHours(12, 0, 0, 0);
          this.prepareProposal(
            work,
            input.resolution.selectedContactId,
            this.data.meetingDrafts?.[work.id]?.startsAt ?? date.toISOString(),
          );
        } else if (pending.operationId) {
          const operation = this.data.snapshot.operations.find(
            (o) => o.id === pending.operationId,
          );
          const proposal = this.data.snapshot.actionProposals.find(
            (p) => p.id === operation?.proposalId,
          );
          if (
            !operation ||
            !proposal ||
            proposal.status !== "approved" ||
            proposal.approval?.operationId !== operation.id
          )
            continue;
          if (
            pending.kind === "start_operation" &&
            operation.status === "pending"
          ) {
            operation.status = "executing";
            operation.revision++;
            this.data.pending.push({
              workItemId: work.id,
              operationId: operation.id,
              kind: operation.parameters.calendar
                ? "calendar_operation"
                : "finish_operation",
              dueAt: this.now() + (operation.parameters.calendar ? 0 : 4000),
            });
          } else if (
            pending.kind === "finish_operation" &&
            operation.status === "executing" &&
            !operation.parameters.calendar
          ) {
            operation.status = "succeeded";
            operation.revision++;
            operation.result = {
              kind: "simulated",
              reference: `demo-event-${operation.id}`,
            };
            work.status = "succeeded";
            work.revision++;
            work.result = "Demo completed. No calendar event was created.";
          } else continue;
          this.emit({ type: "operation.upserted", entity: operation });
          this.emit({ type: "work_item.upserted", entity: work });
        }
      }
      this.data.pending = this.data.pending.filter((p) => !due.includes(p));
      this.commit();
    } catch (error) {
      this.data = before;
      throw error;
    }
  }
  claimCalendar(operationId: string) {
    const job = this.data.pending.find(
      (p) =>
        p.operationId === operationId &&
        p.kind === "calendar_operation" &&
        p.dueAt <= this.now(),
    );
    const op = this.data.snapshot.operations.find((o) => o.id === operationId);
    if (
      !job ||
      !op?.parameters.calendar ||
      !["executing", "result_unknown"].includes(op.status)
    )
      return;
    const before = structuredClone(this.data);
    try {
      job.attempts = (job.attempts ?? 0) + 1;
      // Persist a lease before any network request; expired claims can reconcile after a crash.
      job.dueAt = this.now() + 30_000;
      this.commit();
      return { operation: structuredClone(op), attempt: job.attempts };
    } catch (error) {
      this.data = before;
      throw error;
    }
  }
  completeCalendar(operationId: string, outcome: CalendarOutcome) {
    const op = this.data.snapshot.operations.find((o) => o.id === operationId);
    const job = this.data.pending.find(
      (p) => p.operationId === operationId && p.kind === "calendar_operation",
    );
    const work = this.data.snapshot.workItems.find(
      (w) => w.id === op?.workItemId,
    );
    if (
      !op ||
      !job ||
      !work ||
      !op.parameters.calendar ||
      !["executing", "result_unknown"].includes(op.status)
    )
      return;
    const before = structuredClone(this.data);
    try {
      op.status = outcome.status;
      op.revision++;
      work.revision++;
      if (outcome.status === "succeeded") {
        op.result = outcome.result;
        delete op.error;
        work.status = "succeeded";
        work.result =
          "Calendar event created and read back from the server. No invitations sent.";
      } else {
        op.error = outcome.error;
        work.status = outcome.status === "failed" ? "failed" : "waiting_system";
      }
      if (
        outcome.status === "result_unknown" &&
        outcome.retry &&
        (job.attempts ?? 0) < 8
      )
        job.dueAt =
          this.now() + Math.min(60_000, 1000 * 2 ** (job.attempts ?? 0));
      else {
        if (outcome.status === "result_unknown" && outcome.retry)
          op.error = "retry_exhausted";
        this.data.pending = this.data.pending.filter((p) => p !== job);
      }
      this.emit({ type: "operation.upserted", entity: op });
      this.emit({ type: "work_item.upserted", entity: work });
      this.commit();
    } catch (error) {
      this.data = before;
      throw error;
    }
  }
  events(after: number) {
    if (after < this.data.eventFloor) return null;
    const oldest =
      this.data.events[0]?.sequence ?? this.data.snapshot.cursor + 1;
    if (after < oldest - 1 || after > this.data.snapshot.cursor) return null;
    return {
      scope: this.data.snapshot.scope,
      events: this.data.events.filter((e) => e.sequence > after),
      cursor: this.data.snapshot.cursor,
    };
  }
  private commit() {
    this.rememberActiveContext();
    this.pruneConversations();
    this.data = DatabaseSchema.parse(this.data);
    this.persist(this.data);
  }
}
