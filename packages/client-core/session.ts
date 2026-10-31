import {
  PetProfileSchema,
  SavePetProfileSchema,
  PetMemoryPageSchema,
  PetMemoryQuerySchema,
  PetMemoryCommandSchema,
  type PetProfile,
  type SavePetProfile,
  type PetMemoryQuery,
  type PetMemoryPage,
  type PetMemoryCommand,
} from "../protocol/work-pet";
import { AttachmentRuntime } from "./attachments";
import { AttachmentTransport } from "./attachment-transport";
import { parseMeetingRecord, parseServerValue } from "./forward-compatible";
import {
  ANSWER_STREAM_MEDIA_TYPE,
  parseAnswerStreamEvent,
  splitServerSentEvents,
  type AnswerStreamChunk,
  type AnswerStreamApproval,
  type AnswerStreamStep,
} from "../protocol/answer-stream";
import {
  ConnectionHttpError,
  ConnectionJsonError,
  ConnectionPayloadError,
  connectionDiagnostic,
  type ConnectionDiagnostic,
  type ConnectionPhase,
} from "./connection-diagnostic";
import {
  HumanTaskId,
  HumanTaskSchema,
  HumanTaskListSchema,
  HumanTaskCommandSchema,
  type HumanTaskCommand,
  type HumanTaskTab,
} from "../protocol/human-tasks";
import {
  HUB_PROFILE_V3,
  HubDashboardV3CommandSchema,
  HubDashboardV3Schema,
  HubOpenRequestSchema,
  HubOpenResultSchema,
  type HubDashboardV3Command,
} from "../protocol/hub";
import {
  MEETING_PROFILE,
  MEETING_MAX_BYTES,
  MeetingRenameSchema,
  MEETING_BLOCK_BYTES,
  MeetingCreateSchema,
  MeetingSchema,
  MeetingListSchema,
  MeetingDetailSchema,
  MeetingId,
  type MeetingCreate,
} from "../protocol/meetings";
import {
  SpeechCapabilitiesSchema,
  SpeechRequestSchema,
  SpeechResultSchema,
  SPEECH_BODY_BYTES,
  type SpeechRequest,
} from "../protocol/speech";
import {
  OUTPUT_VOICE_PROFILE,
  OUTPUT_VOICE_SNAPSHOT_BYTES,
  OutputVoiceSnapshotSchema,
  OutputVoiceUpdateSchema,
  type OutputVoiceSnapshot,
  type OutputVoiceUpdate,
} from "../protocol/output-voice";
import { replyCorrelationPath } from "../protocol/reply-correlation";
import {
  ServiceConnectionStart,
  ServiceConnectionStatus,
} from "../protocol/service-oauth";
import {
  CommandSchema,
  CommandResultSchema,
  EventsResponseSchema,
  SnapshotSchema,
  sameScope,
  type Command,
  type CommandResult,
  type Credential,
  type WorkItem,
  CredentialSchema,
  CONVERSATION_HISTORY_PROFILE,
  type ConversationListState,
  CONVERSATION_PROJECTION_PROFILE,
  ConversationHistoryPageSchema,
  ConversationMessagePageSchema,
  OPEN_WORK_PROFILE,
} from "../protocol";
import { ConversationOpenWorkError } from "./conversation-directory";
import { retryMessageCommand } from "./commands";
import {
  SKILLS_PROFILE,
  SkillProposalStatusSchema,
  type SkillProposalStatus,
} from "../protocol/skills";
import {
  PROCESS_PROPOSAL_PROFILE,
  ProcessProposalAcceptSchema,
  ProcessProposalStatusSchema,
  type ProcessProposalAccept,
  type ProcessProposalStatus,
} from "../protocol/process-proposal";
import { cardDeliveryPath } from "../protocol/card-delivery";
import { questionOptionsDeliveryPath } from "../protocol/question-options";
import { messageDeliveryPath } from "../protocol/message-delivery";
import {
  MentionDirectorySchema,
  type MentionDirectory,
} from "../protocol/mentions";
import {
  PROCESS_OUTPUT_PROFILE,
  PROCESS_OUTPUT_WORK_PROFILE,
  PROCESS_OUTPUT_MAX_PAGE_BYTES,
  type ProcessOutputRequest,
} from "../protocol/process-output";
import {
  freezeProcessOutputRequest,
  assertCurrentProcessOutput,
  supportsProcessOutput,
  parseProcessOutputPage,
  processOutputServerError,
} from "./process-output-reader";
import {
  processWorkDeliveryPath,
  PROCESS_QUESTION_WORK_PROFILE,
  PROCESS_WORK_PROFILE,
  PROCESS_APPROVAL_WORK_PROFILE,
} from "../protocol/process-work";
import {
  PROCESS_QUESTION_EXECUTION_PROFILE,
  ProcessAnswerCommandSchema,
  type ProcessAnswerCommand,
} from "../protocol/process-questions";
import {
  ProcessRuntimeResponseSchema,
  ProcessRuntimeInterruptRequestSchema,
  ProcessRuntimeInterruptResponseSchema,
  ProcessRuntimeProfileSchema,
  ProcessResolveCommandSchema,
  type ProcessResolveCommand,
  type ProcessRuntimeResponse,
} from "../protocol/process-coordinator";
import { z } from "zod";
import {
  PROCESS_EXECUTION_PROFILE,
  type ProcessInputRequest,
  type ProcessExecutionEntry,
} from "../protocol/process-execution";
import {
  ProcessStartCommandSchema,
  type ProcessStartCommand,
} from "../protocol/process-start";
import {
  ProcessCommandTargetSchema,
  assertProcessCommandTarget,
  validateProcessCommandTarget,
  assertProcessCommandResponse,
  type ProcessCommandTarget,
  type ProcessStartTarget,
} from "./process-commands";
import {
  PROCESS_INVENTORY_PAGE_BYTES,
  PROCESS_INVENTORY_TOTAL_BYTES,
  PROCESS_INVENTORY_MAX_ENTRIES,
  PROCESS_INVENTORY_MAX_PAGES,
  PROCESS_INPUT_RESPONSE_BYTES,
  ProcessReaderError,
  processReaderUtf8Bytes,
  parseProcessInventoryPage,
  freezeProcessInputSelection,
  parseProcessInputTarget,
  processReaderServerError,
  type ProcessExecutionList,
  type ReadyProcessExecutionEntry,
} from "./process-execution-reader";
import {
  REQUEST_INTERRUPTION_PROFILE,
  RequestInterruptionRequestSchema,
  RequestInterruptionResponseSchema,
} from "../protocol/request-interruption";
import {
  applyEvent,
  fromSnapshot,
  mergeSnapshot,
  toSnapshot,
  type Store,
} from "./store";
import {
  ChatSearchPageSchema,
  chatSearchPath,
  type ChatSearchOptions,
} from "../protocol/chat-search";
import { authRequest, AuthenticationError } from "./auth";
import { migrateStoredWorkflowProfile } from "./migrate";
import type { KeyValueStorage } from "./preferences";
import type { LocalCommandState } from "./commands";
import {
  ProcessCommandNoticeSchema,
  processCommandNotice,
  noticeMatchesCommand,
  PROCESS_EXECUTION_UNVERIFIED,
  type ProcessCommandNoticeView,
  type ProcessNoticeOwner,
  type ProcessNoticeLocalError,
} from "./process-command-notice";
import {
  captureProcessAnswerTarget,
  processAnswerCommand,
  isProcessAnswerConsumed,
  type ProcessAnswerTarget,
} from "./process-answers";
import {
  immutableProcessAnswerAttempt,
  parseProcessAnswerAttempts,
  serializeProcessAnswerAttempts,
  ProcessAnswerAttemptsEnvelopeSchema,
  PROCESS_ANSWER_ATTEMPTS_LIMIT,
  type ProcessAnswerAttempt,
} from "./process-answer-attempts";
import {
  ACTIVITY_DRAFT_MAX,
  ACTIVITY_PROFILE,
  ActivityResponseSchema,
  type RequestActivity,
} from "../protocol/activity";
import {
  VoiceCapabilitiesSchema,
  VoiceRequestSchema,
  VoiceResultSchema,
  type VoiceRequest,
} from "../protocol/voice";
export type SessionCommand =
  | Command
  | ProcessAnswerCommand
  | ProcessStartCommand
  | ProcessResolveCommand;

export class ProcessDesignApiError extends ProcessReaderError {
  constructor(
    readonly status: number,
    code: string,
  ) {
    super(code);
    this.name = "ProcessDesignApiError";
  }
}
export type ClientSessionOptions = {
  /** Render/transfer the negotiated attachment profile; discovery preserves older text servers. */
  attachments?: boolean;
  attachmentId?: () => string;
  processQuestions?: boolean;
  processExecution?: boolean;
  /** Complete canonical reviews; also supports existing questions and execution. */
  processApprovals?: boolean;
  /** Negotiate complete passive outputs; falls back to the approval profile. */
  processOutputs?: boolean;
  /** Message result types this client renders, as `type/version` (see
   * MESSAGE_RESULTS). Others newer than the baseline arrive as their text. */
  messageResults?: readonly string[];
  /** Ask for `createdAt` on messages (MESSAGE_TIME_PROFILE). */
  messageTimes?: boolean;
  /** Ask for generated UI on answers (GENERATIVE_UI_PROFILE). */
  generativeUi?: boolean;
  /**
   * Follow a chat answer as it is written over the command's own response
   * (an event stream) instead of polling `activity`. A server or network that
   * does not stream falls back to the JSON response and polling.
   */
  stream?: boolean;
  /** The credential has no refresh token, but `renewCredential` issues a new
   * one (the web app asks its signed-in browser session). */
  reissue?: boolean;
};
const isProcessExecutionCommand = (
  command: SessionCommand,
): command is ProcessStartCommand | ProcessResolveCommand =>
  command.type === "process.start" ||
  (command.type === "service.resolve" && "profile" in command);
const isProcessRuntimeCommand = (command: SessionCommand) =>
  command.type === "process.answer" || isProcessExecutionCommand(command);
function immutableJson<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutableJson(child);
    Object.freeze(value);
  }
  return value;
}
const parseSessionCommand = (raw: unknown): SessionCommand => {
  if (
    raw &&
    typeof raw === "object" &&
    "type" in raw &&
    raw.type === "process.answer"
  )
    return Object.freeze(ProcessAnswerCommandSchema.parse(raw));
  if (raw && typeof raw === "object" && "type" in raw) {
    if (raw.type === "process.start")
      return immutableJson(ProcessStartCommandSchema.parse(raw));
    if (raw.type === "service.resolve" && "profile" in raw)
      return immutableJson(ProcessResolveCommandSchema.parse(raw));
  }
  return CommandSchema.parse(raw);
};
const ProcessPendingSchema = z.strictObject({
  profile: z.literal("agent-client.process-command/1"),
  command: z.union([ProcessStartCommandSchema, ProcessResolveCommandSchema]),
  serializedCommand: z.string().min(1).max(2_000_000),
  target: ProcessCommandTargetSchema,
  executionProfile: ProcessRuntimeProfileSchema,
  outcome: z.enum(["unknown", "accepted", "rejected"]),
  error: z.string().min(1).max(160).nullable(),
  notice: ProcessCommandNoticeSchema.optional(),
});
const ProcessExecutionConflictSchema = z.strictObject({
  error: z.literal("process_start_conflict"),
});
const RetrySourcesEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  connectionKey: z.string().min(1).max(2048),
  scope: z.strictObject({
    connectionId: z.string(),
    serverId: z.string(),
    userId: z.string(),
    workspaceId: z.string(),
  }),
  commands: z.array(z.unknown()).max(500),
});
type RetrySourcesEnvelope = {
  version: 1;
  connectionKey: string;
  scope: Credential["scope"];
  commands: Extract<SessionCommand, { type: "message.send" }>[];
};
type ProcessPending = z.infer<typeof ProcessPendingSchema>;
/** Derived from the sole existing outbox; no separate persisted launcher state. */
export type ProcessPendingView = Readonly<
  Pick<ProcessPending, "command" | "target" | "outcome" | "error" | "notice">
>;
/** Streamed draft and steps are published at most this often. */
const LIVE_INTERVAL_MS = 80;
const PROCESS_PENDING_MAX_BYTES = 2_000_000;
const RETRY_SOURCE_MAX_COMMANDS = 500;
function utf8Bytes(raw: string) {
  let bytes = 0;
  for (const character of raw) {
    const code = character.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}
function boundedPending(raw: string) {
  if (utf8Bytes(raw) > PROCESS_PENDING_MAX_BYTES) throw Error("storage_error");
}
export type SessionState = {
  store: Store | null;
  status: "connecting" | "online" | "offline" | "unauthorized";
  commandStates: Record<string, LocalCommandState>;
  pending: SessionCommand | null;
  processPending: ProcessPendingView | null;
  answerAttempts: readonly ProcessAnswerAttempt[];
  answerRecoveryBlocked: boolean;
  error: string | null;
  /** The chat of the command sent last: its error belongs there. */
  commandConversationId?: string;
  connectionDiagnostic?: ConnectionDiagnostic;
  processNotice?: ProcessCommandNoticeView | null;
  activity: RequestActivity | null;
  activityConnection: "waiting" | "live" | "unavailable";
  /** The streamed tool steps of the running answer, oldest first; none without a stream. */
  activitySteps?: AnswerStreamStep[] | null;
  /**
   * A write the running answer stopped for, as the stream announced it
   * before the stored card arrives; the stored message then shows the card.
   */
  activityApproval?: AnswerStreamApproval | null;
};
export const commandTarget = (c: SessionCommand) =>
  c.type === "conversation.create"
    ? `conversation:${c.conversationId}`
    : c.type === "conversation.rename" ||
        c.type === "conversation.delete" ||
        c.type === "conversation.archive" ||
        c.type === "conversation.restore"
      ? `${c.type}:${c.conversationId}`
      : c.type === "work.cancel"
        ? `${c.type}:${c.workItemId}`
        : c.type === "process.start"
          ? c.intentId
          : c.type === "process.answer"
            ? `${c.workItemId}:${c.questionId}:${c.questionRevision}`
            : c.type === "input.submit"
              ? c.inputRequestId
              : c.type === "message.send"
                ? (c.context?.inputRequestId ?? "chat")
                : c.type === "task.open"
                  ? c.workItemId
                  : c.type === "operation.reconcile" ||
                      c.type === "service.resolve"
                    ? c.operationId
                    : c.proposalId;

/** One session is permanently bound to one normalized endpoint. Never retarget it. */
/** Tolerated difference between the phone's and the server's clocks. */
const CLOCK_SKEW = 120_000;
type CommandFlight = {
  command: SessionCommand;
  serializedCommand: string;
  processPending?: ProcessPending;
  controller: AbortController;
  deliveryStarted: boolean;
  outcomeKnown: boolean;
  interruptionFailed: boolean;
  stopActivity: () => void;
  ready: Promise<void>;
  markReady: () => void;
  retired: Promise<void>;
  retire: () => void;
  interruption?: Promise<boolean>;
  localPersistence?: Promise<void>;
  noticeOwner?: ProcessNoticeOwner;
};
export class ClientSession {
  private state: SessionState = {
    store: null,
    status: "connecting",
    commandStates: {},
    pending: null,
    processPending: null,
    answerAttempts: [],
    answerRecoveryBlocked: false,
    error: null,
    processNotice: null,
    activity: null,
    activitySteps: null,
    activityApproval: null,
    activityConnection: "waiting",
  };
  private listeners = new Set<() => void>();
  private stopped = false;
  private authorized = false;
  private invalid = false;
  private controllers = new Set<AbortController>();
  readonly identityKey: string;
  readonly attachments: AttachmentRuntime;
  private selectedConversationId = "conversation-1";
  private polling = false;
  private submitting: CommandFlight | null = null;
  private commandFlight: CommandFlight | null = null;
  private commandRejection: string | null = null;
  private timer?: ReturnType<typeof setInterval>;
  private writes: Promise<void> = Promise.resolve();
  private cacheKey: string;
  private pendingKey: string;
  private answerAttemptsKey: string;
  private retrySourcesKey: string;
  private retrySources = new Map<
    string,
    Extract<SessionCommand, { type: "message.send" }>
  >();
  private retrySourcesBlocked = false;
  private retrySourcesReadFailed = false;
  private answerPendingId: string | null = null;
  private answerEnvelopePresent = false;
  private answerStorageBlocked = false;
  private outboxStorageBlocked = false;
  private pendingProcess: ProcessPending | null = null;
  private redactedAnswerIds = new Set<string>();
  /** Delivery ownership survives a failed local redaction, without retaining extra text. */
  private consumedUnknownAnswerIds = new Set<string>();
  private renewing?: Promise<void>;
  private authorizing?: Promise<void>;
  private outputSupport = false;
  private outputSupportChecked = false;
  private outputDiscovery?: Promise<void>;
  constructor(
    readonly address: string,
    private storage: KeyValueStorage,
    private credential: Credential,
    private request: typeof fetch = (url, init) => fetch(url, init),
    private onInvalid: () => void = () => {},
    private renewCredential?: (credential: Credential) => Promise<Credential>,
    private recoveringRefresh = false,
    private options: ClientSessionOptions = {},
  ) {
    CredentialSchema.parse(credential);
    this.options = Object.freeze({
      ...options,
      ...(options.processApprovals || options.processOutputs
        ? { processQuestions: true, processExecution: true }
        : {}),
      ...(options.processOutputs ? { processApprovals: true } : {}),
    });
    this.identityKey = JSON.stringify([
      address,
      credential.scope.connectionId,
      credential.scope.serverId,
      credential.scope.userId,
      credential.scope.workspaceId,
    ]);
    this.attachments = new AttachmentRuntime(
      new AttachmentTransport((path, init, timeout) =>
        this.open(path, init, timeout),
      ),
      credential.scope,
      options.attachmentId ?? (() => globalThis.crypto.randomUUID()),
      !!this.options.attachments,
    );
    this.cacheKey = `agent-client.snapshot.v2:${this.identityKey}`;
    this.pendingKey = `agent-client.command.v2:${this.identityKey}`;
    this.answerAttemptsKey = `agent-client.process-answer-attempts.v1:${this.identityKey}`;
    this.retrySourcesKey = `agent-client.retry-sources.v1:${this.identityKey}`;
  }
  getSnapshot = () => this.state;
  private directoryVersion = 0;
  /**
   * Bumps whenever the person's chat list may have changed elsewhere: a chat
   * renamed or deleted here, or a server snapshot that replaced the event log
   * (how renames and deletions on other devices arrive). Lists re-read then.
   */
  getDirectoryVersion = () => this.directoryVersion;
  private directoryChanged() {
    this.directoryVersion++;
    for (const fn of this.listeners) fn();
  }
  private messageDelivery(path: string) {
    return messageDeliveryPath(path, {
      times: this.options.messageTimes,
      attachments:
        !!this.options.attachments &&
        !!this.attachments.getSnapshot().capabilities,
      ui: this.options.generativeUi,
      results: this.options.messageResults,
    });
  }
  /** Names a chat for all of the person's clients; empty restores the title.
   * `commandId` is a fresh id for this press. */
  renameConversation(id: string, title: string, commandId: string) {
    return this.directoryCommand(
      {
        type: "conversation.rename",
        conversationId: id,
        title: title.trim().slice(0, 160).trim(),
      },
      commandId,
    );
  }
  /** Deletes a chat with its messages; it cannot be continued afterwards.
   * Refused with `ConversationOpenWorkError` while work waits in it, unless
   * `cancelOpenWork` cancels that work first. */
  deleteConversation(
    id: string,
    commandId: string,
    options: { cancelOpenWork?: boolean } = {},
  ) {
    return this.directoryCommand(
      {
        type: "conversation.delete",
        conversationId: id,
        ...(options.cancelOpenWork ? { cancelOpenWork: true as const } : {}),
      },
      commandId,
    );
  }
  /** Moves a chat into the archive, read-only, for all of the person's
   * clients. An older server answers `conversation_command_unsupported`.
   * Open work refuses it as for `deleteConversation`. */
  archiveConversation(
    id: string,
    commandId: string,
    options: { cancelOpenWork?: boolean } = {},
  ) {
    return this.directoryCommand(
      {
        type: "conversation.archive",
        conversationId: id,
        ...(options.cancelOpenWork ? { cancelOpenWork: true as const } : {}),
      },
      commandId,
    );
  }
  /**
   * Stops the person's own waiting work (a question, an approval, a waiting
   * process run) at the revision they see. Like the chat directory commands
   * it bypasses the outbox; a lost response is safe to repeat with a fresh
   * press. Throws `work_busy` while it still runs, `work_changed` when it
   * changed meanwhile and `work_not_found` when it is gone.
   */
  async cancelWork(
    work: Pick<WorkItem, "id" | "revision" | "conversationId">,
    language: "en" | "cs",
    commandId: string,
  ) {
    if (this.stopped || this.invalid) throw new Error("session_stopped");
    if (!this.authorized) await this.authorize();
    const command = CommandSchema.parse({
      type: "work.cancel",
      commandId,
      idempotencyKey: commandId,
      conversationId: work.conversationId,
      workItemId: work.id,
      expectedWorkRevision: work.revision,
      language,
    });
    let delivery;
    try {
      delivery = await this.json(replyCorrelationPath("commands"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      throw new Error("connection_failed");
    }
    const { response, value } = delivery;
    const result = CommandResultSchema.safeParse(value);
    if (!result.success || result.data.commandId !== command.commandId)
      throw new Error(
        response.status === 400
          ? "work_cancel_unsupported"
          : "connection_failed",
      );
    if (!sameScope(result.data.snapshot.scope, this.credential.scope))
      throw new Error("scope_mismatch");
    if (this.state.store)
      this.publish({ store: this.mergeProjection(result.data.snapshot) });
    if (result.data.status === "accepted") return;
    throw new Error(
      result.data.code === "operation_in_progress"
        ? "work_busy"
        : result.data.code === "revision_conflict"
          ? "work_changed"
          : result.data.code === "unknown_context"
            ? "work_not_found"
            : "work_cancel_failed",
    );
  }
  /** Brings an archived chat back to the list; it can be continued. */
  restoreConversation(id: string, commandId: string) {
    return this.directoryCommand(
      { type: "conversation.restore", conversationId: id },
      commandId,
    );
  }
  /**
   * Chat directory changes are not chat turns: they bypass the one-command
   * outbox, so they never wait for or block an answer. A lost response is
   * safe to repeat with a fresh press; both commands are idempotent by target.
   */
  private async directoryCommand(
    raw:
      | Omit<
          Extract<Command, { type: "conversation.rename" }>,
          "commandId" | "idempotencyKey"
        >
      | Omit<
          Extract<
            Command,
            {
              type:
                | "conversation.delete"
                | "conversation.archive"
                | "conversation.restore";
            }
          >,
          "commandId" | "idempotencyKey"
        >,
    commandId: string,
  ) {
    if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(raw.conversationId))
      throw new Error("conversation_changed");
    if (this.stopped || this.invalid) throw new Error("session_stopped");
    if (!this.authorized) await this.authorize();
    const command = CommandSchema.parse({
      ...raw,
      commandId,
      idempotencyKey: commandId,
    });
    let delivery;
    try {
      delivery = await this.json(
        `${replyCorrelationPath("commands")}&work=${encodeURIComponent(OPEN_WORK_PROFILE)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(command),
        },
      );
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      throw new Error("connection_failed");
    }
    const { response, value } = delivery;
    const result = CommandResultSchema.safeParse(value);
    if (!result.success || result.data.commandId !== command.commandId)
      throw new Error(
        response.status === 400 || response.status === 404
          ? "conversation_command_unsupported"
          : "connection_failed",
      );
    if (!sameScope(result.data.snapshot.scope, this.credential.scope))
      throw new Error("scope_mismatch");
    if (result.data.status === "accepted" && this.state.store) {
      let store = this.mergeProjection(result.data.snapshot);
      if (
        command.type === "conversation.delete" ||
        command.type === "conversation.archive"
      ) {
        // The chat leaves even when it was the one open here.
        const { [command.conversationId]: _gone, ...conversations } =
          store.conversations;
        store = {
          ...store,
          conversations: result.data.snapshot.conversations.some(
            (c) => c.id === command.conversationId,
          )
            ? store.conversations
            : conversations,
        };
      }
      this.publish({ store });
    }
    this.directoryChanged();
    // A refusal means open work (a question, approval or task) waits in the
    // chat; a conflict means it is answering right now.
    if (
      result.data.status === "rejected" &&
      result.data.code === "operation_in_progress"
    )
      throw new ConversationOpenWorkError(result.data.openWork ?? []);
    if (result.data.status !== "accepted")
      throw new Error(
        result.data.code === "operation_in_progress"
          ? "conversation_busy"
          : result.data.code === "unknown_context"
            ? "conversation_not_found"
            : "requestRejected",
      );
  }
  /** A local view choice only: never selects/resumes a task or changes the outbox. */
  selectConversation(id: string) {
    if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(id))
      throw new Error("conversation_changed");
    if (this.selectedConversationId !== id) this.attachments.clear();
    this.selectedConversationId = id;
  }
  private parseRetrySources(raw: string): RetrySourcesEnvelope {
    boundedPending(raw);
    const parsed = RetrySourcesEnvelopeSchema.parse(JSON.parse(raw));
    if (
      parsed.connectionKey !== this.address ||
      !sameScope(parsed.scope, this.credential.scope)
    )
      throw Error("retry_source_changed");
    const commands = parsed.commands.map((rawCommand) => {
      const command = CommandSchema.parse(rawCommand);
      if (command.type !== "message.send") throw Error("retry_source_changed");
      return command;
    });
    if (
      new Set(commands.map((command) => command.commandId)).size !==
      commands.length
    )
      throw Error("retry_source_changed");
    return { ...parsed, commands };
  }
  /** Keep retry text only while its exact native work item can still be retried. */
  private async syncRetrySources(store: Store, candidate?: SessionCommand) {
    await this.write(async () => {
      // Derive from the newest projection while holding the same queue used for
      // storage writes. A refresh that waited behind another one must never
      // restore source text that a newer snapshot has already retired.
      const current = this.state.store;
      const source =
        current && current.cursor >= store.cursor ? current : store;
      // A failed read disables retries until the exact old envelope can be
      // loaded. A corrupt envelope is repaired as an empty source set.
      if (this.retrySourcesReadFailed) {
        try {
          const raw = await this.storage.getItem(this.retrySourcesKey);
          this.retrySources = raw
            ? new Map(
                this.parseRetrySources(raw).commands.map((command) => [
                  command.commandId,
                  command,
                ]),
              )
            : new Map();
          this.retrySourcesReadFailed = false;
        } catch (error) {
          this.retrySourcesBlocked = true;
          throw error;
        }
      }
      const needed = new Map<string, Set<string>>();
      for (const work of Object.values(source.workItems)) {
        const commandId = work.native?.sourceCommandId;
        if (
          !commandId ||
          ["succeeded", "expired", "superseded"].includes(work.status)
        )
          continue;
        const conversations = needed.get(commandId) ?? new Set<string>();
        conversations.add(work.conversationId);
        needed.set(commandId, conversations);
      }
      const next = new Map(
        [...this.retrySources].filter(
          ([commandId, command]) =>
            needed.get(commandId)?.has(command.conversationId) ?? false,
        ),
      );
      if (
        candidate?.type === "message.send" &&
        needed.get(candidate.commandId)?.has(candidate.conversationId)
      ) {
        const parsed = CommandSchema.parse(candidate);
        if (parsed.type !== "message.send") throw Error("retry_source_changed");
        next.set(candidate.commandId, immutableJson(parsed));
      }
      // The protocol exposes at most 500 work items. Keep retry source capacity
      // aligned with that projection, while also respecting the device byte
      // budget. Under byte pressure, retain the just-confirmed command first,
      // then sources for failed/cancelled work, then still-active work. Missing
      // sources remain visible on their cards; they are never silently retried.
      const order = new Map([...next.keys()].map((id, index) => [id, index]));
      const priority = (commandId: string) => {
        if (commandId === candidate?.commandId) return 0;
        const statuses = Object.values(source.workItems)
          .filter((work) => work.native?.sourceCommandId === commandId)
          .map((work) => work.status);
        return statuses.some((status) =>
          ["failed", "cancelled"].includes(status),
        )
          ? 1
          : 2;
      };
      const preferred = [...next.entries()].sort(
        ([a], [b]) =>
          priority(a) - priority(b) || order.get(a)! - order.get(b)!,
      );
      const retained: typeof preferred = [];
      let retainedBytes = utf8Bytes(
        JSON.stringify({
          version: 1,
          connectionKey: this.address,
          scope: this.credential.scope,
          commands: [],
        } satisfies RetrySourcesEnvelope),
      );
      for (const entry of preferred) {
        if (retained.length >= RETRY_SOURCE_MAX_COMMANDS) continue;
        const addedBytes = utf8Bytes(JSON.stringify(entry[1]));
        const separatorBytes = retained.length ? 1 : 0;
        if (
          retainedBytes + separatorBytes + addedBytes >
          PROCESS_PENDING_MAX_BYTES
        )
          continue;
        retained.push(entry);
        retainedBytes += separatorBytes + addedBytes;
      }
      const boundedSources = new Map(retained);
      const unchanged =
        boundedSources.size === this.retrySources.size &&
        [...boundedSources].every(
          ([id, command]) => this.retrySources.get(id) === command,
        );
      if (unchanged && !this.retrySourcesBlocked) return;
      if (
        boundedSources.size === 0 &&
        this.retrySources.size === 0 &&
        !this.retrySourcesBlocked
      )
        return;
      const serialized = JSON.stringify({
        version: 1,
        connectionKey: this.address,
        scope: this.credential.scope,
        commands: [...boundedSources.values()],
      } satisfies RetrySourcesEnvelope);
      boundedPending(serialized);
      try {
        await this.storage.setItem(this.retrySourcesKey, serialized);
      } catch (error) {
        if (
          (await this.storage
            .getItem(this.retrySourcesKey)
            .catch(() => null)) !== serialized
        ) {
          this.retrySourcesBlocked = true;
          throw error;
        }
      }
      this.retrySources = boundedSources;
      this.retrySourcesBlocked = false;
    });
  }
  getRetrySource(commandId: string) {
    if (this.retrySourcesBlocked) return undefined;
    const command = this.retrySources.get(commandId);
    if (!command) return undefined;
    const parsed = CommandSchema.parse(command);
    return parsed.type === "message.send" ? immutableJson(parsed) : undefined;
  }
  canRetryNativeWork(work: WorkItem, selectedConversationId: string) {
    const current = Object.values(this.state.store?.workItems ?? {}).find(
      (item) => item.id === work.id,
    );
    const commandId = current?.native?.sourceCommandId;
    const source = commandId ? this.getRetrySource(commandId) : undefined;
    return !!(
      !this.stopped &&
      !this.invalid &&
      this.state.status === "online" &&
      !this.state.store?.stale &&
      !this.state.store?.needsSnapshot &&
      !this.state.pending &&
      !this.state.answerRecoveryBlocked &&
      current &&
      current.revision === work.revision &&
      ["failed", "cancelled"].includes(current.status) &&
      current.conversationId === selectedConversationId &&
      current.conversationId === work.conversationId &&
      current.native?.sourceCommandId === work.native?.sourceCommandId &&
      source?.type === "message.send" &&
      source.conversationId === current.conversationId &&
      source.commandId === commandId
    );
  }
  async retryNativeWork(
    work: WorkItem,
    selectedConversationId: string,
    identity: { commandId: string; idempotencyKey: string },
  ) {
    if (!this.canRetryNativeWork(work, selectedConversationId))
      throw Error("retry_not_available");
    const original = this.getRetrySource(work.native!.sourceCommandId!);
    if (!original || original.type !== "message.send")
      throw Error("retry_not_available");
    const retry = retryMessageCommand(original, identity);
    return this.send(retry);
  }
  private async personalArtifactRequest(path: string, init?: RequestInit) {
    if (!this.authorized) await this.authorize();
    const result = await this.json(path, init, 30000, 2000000, 4000000);
    if (!result.response.ok) {
      const value = result.value as { error?: unknown };
      throw new Error(
        typeof value?.error === "string" &&
        /^(meeting|human_task)_[a-z_]+$/.test(value.error)
          ? value.error
          : path.startsWith("human-tasks")
            ? "human_task_load_failed"
            : "meeting_connection_failed",
      );
    }
    return result.value;
  }
  /** The signed-in person's id, e.g. who confirmed a recording's consent. */
  get userId() {
    return this.credential.scope.userId;
  }
  /**
   * The person's meetings; `query` searches names, summaries and
   * transcripts on the server, `openTasks` adds open items per meeting.
   */
  async readMeetings(
    options: { query?: string; openTasks?: boolean; signal?: AbortSignal } = {},
  ) {
    const params = new URLSearchParams();
    if (options.query?.trim()) params.set("q", options.query.trim());
    if (options.openTasks) params.set("include", "tasks");
    const list = parseServerValue(
      MeetingListSchema,
      await this.personalArtifactRequest(
        params.size ? `meetings?${params.toString()}` : "meetings",
        options.signal ? { signal: options.signal } : undefined,
      ),
    );
    if (
      !sameScope(list.scope, this.credential.scope) ||
      list.meetings.some((m) => !sameScope(m.scope, list.scope))
    )
      throw new Error("scope_mismatch");
    return list;
  }
  async readMeeting(id: string, after = 0) {
    MeetingId.parse(id);
    if (!Number.isSafeInteger(after) || after < 0 || after > 240)
      throw new Error("invalid_payload");
    const detail = parseServerValue(
      MeetingDetailSchema,
      await this.personalArtifactRequest(`meetings/${id}?after=${after}`),
    );
    if (
      !sameScope(detail.scope, this.credential.scope) ||
      !sameScope(detail.meeting.scope, detail.scope) ||
      detail.meeting.id !== id ||
      detail.segments.some((s) => s.index < after) ||
      (detail.next !== null && detail.next <= after)
    )
      throw new Error("scope_mismatch");
    return detail;
  }
  async readMeetingRecord(id: string) {
    MeetingId.parse(id);
    const record = parseMeetingRecord(
      await this.personalArtifactRequest(`meetings/${id}/record`),
    );
    if (
      !sameScope(record.scope, this.credential.scope) ||
      !sameScope(record.meeting.scope, record.scope) ||
      record.meeting.id !== id
    )
      throw new Error("scope_mismatch");
    return record;
  }
  private async hubRequest(language: "en" | "cs", init?: RequestInit) {
    if (!this.authorized) await this.authorize();
    const { response, value } = await this.json(
      `hub?language=${language === "cs" ? "cs" : "en"}&profile=${encodeURIComponent(HUB_PROFILE_V3)}`,
      init,
      15000,
      1_000_000,
      1_000_000,
    );
    if (!response.ok) {
      const error = (value as { error?: unknown } | null)?.error;
      throw new Error(
        typeof error === "string" &&
        /^(?:(?:hub|process|catalog|identity|auth)_[a-z_]+|connection_required|model_unavailable|service_unavailable)$/.test(
          error,
        )
          ? error
          : "hub_load_failed",
      );
    }
    const view = HubDashboardV3Schema.parse(value);
    if (!sameScope(view.scope, this.credential.scope))
      throw new Error("scope_mismatch");
    return view;
  }
  /** The person's dashboard (agent-hub/3); reading never starts a refresh. */
  readHub(language: "en" | "cs", signal?: AbortSignal) {
    return this.hubRequest(language, { signal });
  }
  /** The person's own dashboard change, or an explicit refresh that runs on the server. */
  sendHubCommand(language: "en" | "cs", raw: HubDashboardV3Command) {
    const command = HubDashboardV3CommandSchema.parse(raw);
    return this.hubRequest(language, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
    });
  }
  /**
   * One item of an AI widget in full, read on the server now: `ref` is the
   * id the widget's row carries (the message's id at its source). The detail
   * is plain text and a sanitized tree, extracted on the server; `cached`
   * says it came from the server's index.
   */
  async openHubItem(
    language: "en" | "cs",
    itemId: string,
    ref: string,
    signal?: AbortSignal,
  ) {
    const request = HubOpenRequestSchema.parse({ itemId, ref });
    if (!this.authorized) await this.authorize();
    const { response, value } = await this.json(
      `hub/open?language=${language === "cs" ? "cs" : "en"}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal,
      },
      120_000,
      200_000,
      200_000,
    );
    if (!response.ok) {
      const error = (value as { error?: unknown } | null)?.error;
      throw new Error(
        typeof error === "string" &&
        /^(hub|process|catalog|identity|auth|connection|service|model)_[a-z_]+$/.test(
          error,
        )
          ? error
          : "hub_open_failed",
      );
    }
    return HubOpenResultSchema.parse(value);
  }
  async readHumanTasks(tab: HumanTaskTab, after?: string) {
    if (!["open", "done"].includes(tab)) throw new Error("invalid_payload");
    if (after) HumanTaskId.parse(after);
    const page = parseServerValue(
      HumanTaskListSchema,
      await this.personalArtifactRequest(
        `human-tasks?tab=${tab}${after ? `&after=${encodeURIComponent(after)}` : ""}`,
      ),
    );
    if (
      !sameScope(page.scope, this.credential.scope) ||
      page.tasks.some((t) => !sameScope(t.scope, page.scope))
    )
      throw new Error("scope_mismatch");
    return page;
  }
  private checkHumanTask(value: unknown, id: string) {
    const task = parseServerValue(HumanTaskSchema, value);
    if (!sameScope(task.scope, this.credential.scope) || task.id !== id)
      throw new Error("scope_mismatch");
    return task;
  }
  async readHumanTask(id: string) {
    HumanTaskId.parse(id);
    return this.checkHumanTask(
      await this.personalArtifactRequest(
        `human-tasks/${encodeURIComponent(id)}`,
      ),
      id,
    );
  }
  async submitHumanTask(id: string, raw: HumanTaskCommand) {
    HumanTaskId.parse(id);
    const input = HumanTaskCommandSchema.parse(raw);
    return this.checkHumanTask(
      await this.personalArtifactRequest(
        `human-tasks/${encodeURIComponent(id)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      ),
      id,
    );
  }
  private checkMeeting(value: unknown, id: string) {
    const meeting = parseServerValue(MeetingSchema, value);
    if (!sameScope(meeting.scope, this.credential.scope) || meeting.id !== id)
      throw new Error("scope_mismatch");
    return meeting;
  }
  async createMeeting(input: MeetingCreate) {
    const payload = MeetingCreateSchema.parse(input);
    return this.checkMeeting(
      await this.personalArtifactRequest("meetings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
      payload.id,
    );
  }
  async uploadMeetingBlock(id: string, offset: number, bytes: Uint8Array) {
    MeetingId.parse(id);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !bytes.length ||
      bytes.length > MEETING_BLOCK_BYTES
    )
      throw new Error("invalid_payload");
    return this.checkMeeting(
      await this.personalArtifactRequest(
        `meetings/${id}/blocks?offset=${offset}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: bytes.slice().buffer as ArrayBuffer,
        },
      ),
      id,
    );
  }
  async sealMeeting(id: string) {
    MeetingId.parse(id);
    return this.checkMeeting(
      await this.personalArtifactRequest(`meetings/${id}/seal`, {
        method: "POST",
      }),
      id,
    );
  }
  async processMeeting(id: string, retry = false) {
    MeetingId.parse(id);
    return this.checkMeeting(
      await this.personalArtifactRequest(`meetings/${id}/process`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: MEETING_PROFILE, retry }),
      }),
      id,
    );
  }
  async deleteMeeting(id: string) {
    MeetingId.parse(id);
    await this.personalArtifactRequest(`meetings/${id}`, { method: "DELETE" });
  }
  async renameMeeting(id: string, title: string) {
    MeetingId.parse(id);
    const payload = MeetingRenameSchema.parse({
      profile: MEETING_PROFILE,
      title,
    });
    return this.checkMeeting(
      await this.personalArtifactRequest(`meetings/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
      id,
    );
  }
  /** Deletes only the meeting's sound; its notes and transcript stay. */
  async deleteMeetingAudio(id: string) {
    MeetingId.parse(id);
    return this.checkMeeting(
      await this.personalArtifactRequest(`meetings/${id}/audio`, {
        method: "DELETE",
      }),
      id,
    );
  }
  /** The meeting's recording for the owner's player (at most 64 MB). */
  async readMeetingAudio(id: string, signal?: AbortSignal) {
    MeetingId.parse(id);
    if (this.stopped) throw new Error("session_stopped");
    if (!this.authorized) await this.authorize();
    // A read: after a refused credential is renewed, it is asked once more.
    for (let attempt = 0; ; attempt++) {
      await this.ensureCredential();
      if (this.stopped || signal?.aborted) throw new Error("session_stopped");
      const requestedCredential = this.credential;
      // Registered like json()'s requests, so stop() and invalidate() cancel it.
      const controller = new AbortController();
      const cancel = () => controller.abort();
      this.controllers.add(controller);
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        const response = await this.request(
          `${this.address}/meetings/${id}/audio`,
          {
            credentials: "omit",
            headers: {
              Authorization: `Bearer ${requestedCredential.accessToken}`,
            },
            redirect: "error",
            signal: controller.signal,
          },
        );
        if (this.stopped || this.invalid || controller.signal.aborted)
          throw new Error("session_stopped");
        if (response.status === 401 || response.status === 403) {
          if (response.status === 401 && this.renewable && attempt === 0) {
            if (this.credential.accessToken === requestedCredential.accessToken)
              await this.ensureCredential(true);
            continue;
          }
          if (response.status === 401 && this.renewable)
            throw new Error("meeting_connection_failed");
          this.invalidate();
          throw new AuthenticationError("auth_expired");
        }
        if (response.status === 404) throw new Error("meeting_audio_not_found");
        if (!response.ok) throw new Error("meeting_connection_failed");
        // Refuse an oversized body before reading it; the size is checked again after.
        const declared = Number(response.headers?.get("content-length"));
        if (declared > MEETING_MAX_BYTES) {
          controller.abort();
          throw new Error("meeting_audio_invalid");
        }
        const blob = await response.blob();
        if (this.stopped || this.invalid || controller.signal.aborted)
          throw new Error("session_stopped");
        if (blob.size > MEETING_MAX_BYTES)
          throw new Error("meeting_audio_invalid");
        return blob;
      } finally {
        signal?.removeEventListener("abort", cancel);
        this.controllers.delete(controller);
      }
    }
  }
  /** What the person can tag with "@" right now; a server without the
   * directory answers mentions_unavailable and the client hides tagging.
   * `hub`: only the services overview widgets can read; a server that does
   * not know the filter answers the whole directory instead. */
  async readMentions(
    signal?: AbortSignal,
    purpose?: "hub",
  ): Promise<MentionDirectory> {
    if (!this.authorized) await this.authorize();
    let { response, value } = await this.json(
      purpose ? `mentions?for=${purpose}` : "mentions",
      { signal },
    );
    if (purpose && response.status === 400)
      ({ response, value } = await this.json("mentions", { signal }));
    if (response.status === 404 || response.status === 406)
      throw new Error("mentions_unavailable");
    if (!response.ok) throw new Error("connection_failed");
    const directory = MentionDirectorySchema.parse(value);
    if (
      new Set(directory.items.map((item) => `${item.kind}:${item.id}`)).size !==
      directory.items.length
    )
      throw new Error("invalid_payload");
    return directory;
  }
  private async petRequest(
    path: string,
    payload: unknown,
    signal?: AbortSignal,
  ) {
    // The account sidecar authenticates directly; do not construct a chat session.
    const { response, value } = await this.json(
      path,
      {
        signal,
        ...(payload === undefined
          ? {}
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            }),
      },
      15000,
      700000,
      700000,
      true,
    );
    const code = (value as { error?: unknown } | null)?.error;
    if (response.status === 406 && code === "pet_unsupported") return undefined;
    if (!response.ok)
      throw new Error(
        typeof code === "string" &&
        /^(pet|memory|identity|plugin)_[a-z_]+$/.test(code)
          ? code
          : "pet_failed",
      );
    return value;
  }
  private checkPetScope(value: { userId: string; workspaceId: string }) {
    if (
      value.userId !== this.credential.scope.userId ||
      value.workspaceId !== this.credential.scope.workspaceId
    )
      throw new Error("invalid_payload");
  }
  async petProfile(signal?: AbortSignal): Promise<PetProfile | null> {
    const value = await this.petRequest("pet", undefined, signal);
    if (value === undefined) return null;
    const result = PetProfileSchema.parse(value);
    this.checkPetScope(result);
    return result;
  }
  async savePetProfile(
    update: SavePetProfile,
    signal?: AbortSignal,
  ): Promise<PetProfile | null> {
    const value = await this.petRequest(
      "pet",
      SavePetProfileSchema.parse(update),
      signal,
    );
    if (value === undefined) return null;
    const result = PetProfileSchema.parse(value);
    this.checkPetScope(result);
    return result;
  }
  async petMemory(
    query: PetMemoryQuery = {},
    signal?: AbortSignal,
  ): Promise<PetMemoryPage | null> {
    const parsed = PetMemoryQuerySchema.parse(query);
    const params = Object.entries(parsed)
      .map(
        ([key, value]) =>
          `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
      )
      .join("&");
    const value = await this.petRequest(
      `pet/memory${params ? `?${params}` : ""}`,
      undefined,
      signal,
    );
    if (value === undefined) return null;
    const result = PetMemoryPageSchema.parse(value);
    this.checkPetScope(result);
    return result;
  }
  async savePetMemory(
    command: PetMemoryCommand,
    signal?: AbortSignal,
  ): Promise<PetMemoryPage | null> {
    const value = await this.petRequest(
      "pet/memory",
      PetMemoryCommandSchema.parse(command),
      signal,
    );
    if (value === undefined) return null;
    const result = PetMemoryPageSchema.parse(value);
    this.checkPetScope(result);
    return result;
  }
  private async skillRequest(path: string, init?: RequestInit) {
    if (!this.authorized) await this.authorize();
    const { response, value } = await this.json(path, init, 15000);
    if (!response.ok) {
      const error = (value as { error?: unknown } | null)?.error;
      throw new Error(
        typeof error === "string" &&
        /^(skill|identity|auth)_[a-z_]+$/.test(error)
          ? error
          : "skill_failed",
      );
    }
    return value;
  }
  /** Whether a skill drafted in chat is still open or already saved. */
  async readSkillProposal(
    proposalId: string,
    signal?: AbortSignal,
  ): Promise<SkillProposalStatus> {
    const status = SkillProposalStatusSchema.parse(
      await this.skillRequest(
        `skills?proposalId=${encodeURIComponent(proposalId)}`,
        { signal },
      ),
    );
    if (status.proposalId !== proposalId) throw new Error("invalid_payload");
    return status;
  }
  /** Saves a drafted skill for the person or, for administrators, the company.
   * Repeating it returns the saved result. */
  async acceptSkillProposal(
    proposalId: string,
    target: "personal" | "workspace",
  ): Promise<SkillProposalStatus> {
    const status = SkillProposalStatusSchema.parse(
      await this.skillRequest("skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile: SKILLS_PROFILE,
          type: "accept",
          proposalId,
          target,
        }),
      }),
    );
    if (status.proposalId !== proposalId) throw new Error("invalid_payload");
    return status;
  }
  private async processProposalRequest(path: string, init?: RequestInit) {
    if (!this.authorized) await this.authorize();
    const { response, value } = await this.json(path, init, 15000);
    if (!response.ok) {
      const error = (value as { error?: unknown } | null)?.error;
      throw new Error(
        typeof error === "string" &&
        /^(process|hub|catalog|identity|auth)_[a-z_]+$/.test(error)
          ? error
          : "process_proposal_failed",
      );
    }
    const status = ProcessProposalStatusSchema.parse(value);
    return status;
  }
  /** How saving a process proposed in chat went; reading changes nothing. */
  async readProcessProposal(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<ProcessProposalStatus> {
    const status = await this.processProposalRequest(
      `process-proposals?sessionId=${encodeURIComponent(sessionId)}`,
      { signal },
    );
    if (status.sessionId !== sessionId) throw new Error("invalid_payload");
    return status;
  }
  /** "Save and turn on": the server saves, tests, turns it on and, when
   * asked, adds it to the overview, in the background; read the status to
   * follow it. Repeating the same press returns its status. */
  async acceptProcessProposal(
    raw: Omit<ProcessProposalAccept, "profile" | "type">,
    language: "en" | "cs",
  ): Promise<ProcessProposalStatus> {
    const request = ProcessProposalAcceptSchema.parse({
      ...raw,
      profile: PROCESS_PROPOSAL_PROFILE,
      type: "accept",
    });
    const status = await this.processProposalRequest(
      `process-proposals?language=${language}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      },
    );
    if (status.sessionId !== request.sessionId)
      throw new Error("invalid_payload");
    return status;
  }
  /** Whether the server filters the chat list (`state`); an older one
   * lists every chat and the filter applies to each page here instead. */
  private directoryFilter: boolean | undefined;
  /**
   * One page of the person's chats. With `state`, only chats that can
   * continue (`active`) or the archive (`archived`); filtered pages run
   * newest first on a server that filters.
   */
  async readConversations(
    after?: string | null,
    signal?: AbortSignal,
    state?: ConversationListState,
  ) {
    if (!this.authorized) await this.authorize();
    const read = (filter: boolean) =>
      this.json(
        `conversations?profile=${CONVERSATION_HISTORY_PROFILE}${after ? `&after=${encodeURIComponent(after)}` : ""}${filter && state ? `&state=${state}` : ""}`,
        { signal },
      );
    let filtered = !!state && this.directoryFilter !== false;
    let { response, value } = await read(filtered);
    if (filtered && response.status === 400 && !this.directoryFilter) {
      this.directoryFilter = false;
      filtered = false;
      ({ response, value } = await read(false));
    } else if (filtered && response.ok) this.directoryFilter = true;
    if (response.status === 404 || response.status === 406)
      throw new Error("conversation_history_unavailable");
    if (!response.ok) throw new Error("connection_failed");
    const parsed = ConversationHistoryPageSchema.parse(value);
    const page =
      state && !filtered
        ? {
            ...parsed,
            conversations: parsed.conversations.filter(
              (c) => c.readOnly === (state === "archived"),
            ),
          }
        : parsed;
    if (!sameScope(page.scope, this.credential.scope))
      throw new Error("scope_mismatch");
    if (
      new Set(page.conversations.map((c) => c.id)).size !==
        page.conversations.length ||
      (after && page.nextAfter === after)
    )
      throw new Error("conversation_changed");
    return page;
  }
  async readConversation(
    id: string,
    after?: string | null,
    revision?: number,
    signal?: AbortSignal,
  ) {
    if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(id))
      throw new Error("conversation_changed");
    if (!this.authorized) await this.authorize();
    if (this.options.attachments) await this.attachments.discover();
    const path = messageDeliveryPath(
      `conversations/messages?profile=${CONVERSATION_HISTORY_PROFILE}&conversationId=${encodeURIComponent(id)}${after ? `&after=${encodeURIComponent(after)}` : ""}${revision ? `&revision=${revision}` : ""}`,
      {
        times: this.options.messageTimes,
        ui: this.options.generativeUi,
        attachments:
          !!this.options.attachments &&
          !!this.attachments.getSnapshot().capabilities,
      },
    );
    const { response, value } = await this.json(path, { signal });
    if (response.status === 404 || response.status === 406)
      throw new Error("conversation_history_unavailable");
    if (response.status === 409) throw new Error("conversation_changed");
    if (!response.ok) throw new Error("connection_failed");
    const page = ConversationMessagePageSchema.parse(value);
    if (
      !sameScope(page.scope, this.credential.scope) ||
      page.conversation.id !== id ||
      (revision !== undefined && page.conversation.revision !== revision) ||
      page.messages.some((m) => m.result) ||
      new Set(page.messages.map((m) => m.id)).size !== page.messages.length ||
      (after && after === page.nextAfter)
    )
      throw new Error("conversation_changed");
    return page;
  }
  /**
   * One page of the person's chats matching `query`, best first (chat name,
   * the person's messages and the assistant's final answers). An empty
   * query is the caller's to answer from the chat list.
   */
  async searchConversations(
    query: string,
    options: ChatSearchOptions = {},
    signal?: AbortSignal,
  ) {
    if (!this.authorized) await this.authorize();
    const { response, value } = await this.json(
      chatSearchPath(query.trim(), options),
      { signal },
    );
    if (response.status === 404 || response.status === 406)
      throw new Error("chat_search_unavailable");
    if (response.status === 429) throw new Error("chat_search_rate_limited");
    if (response.status === 400) throw new Error("invalid_payload");
    if (!response.ok) throw new Error("connection_failed");
    const page = ChatSearchPageSchema.parse(value);
    if (!sameScope(page.scope, this.credential.scope))
      throw new Error("scope_mismatch");
    return page;
  }
  private mergeProjection(raw: unknown) {
    const next = this.state.store
      ? mergeSnapshot(this.state.store, this.address, raw)
      : fromSnapshot(this.address, this.credential.scope, raw);
    const selected =
      this.state.store?.conversations[this.selectedConversationId];
    const incoming = selected && next.conversations[selected.id];
    const preserved =
      selected && !incoming?.messages.length
        ? {
            ...next,
            conversations: {
              ...next.conversations,
              [selected.id]: {
                ...selected,
                revision: incoming?.revision ?? selected.revision,
                // Another chat's response does not prove freshness of cached cards.
                messages: selected.messages.map(
                  ({ result: _result, ...message }) => message,
                ),
              },
            },
          }
        : next;
    return this.pruneProjection(preserved);
  }
  private pruneProjection(store: Store): Store {
    const keep = new Set([
      this.selectedConversationId,
      ...(this.state.pending ? [this.state.pending.conversationId] : []),
      ...Object.values(store.workItems).map((w) => w.conversationId),
    ]);
    const room = Math.max(0, 502 - keep.size);
    const recent = Object.values(store.conversations).filter(
      (c) => !keep.has(c.id),
    );
    for (const conversation of room ? recent.slice(-Math.min(40, room)) : [])
      keep.add(conversation.id);
    return {
      ...store,
      conversations: Object.fromEntries(
        Object.entries(store.conversations).filter(([id]) => keep.has(id)),
      ),
    };
  }
  /** Negotiated metadata only; output reads still require the current work proof. */
  getProcessOutputSupport = () =>
    !this.options.processOutputs || !this.outputSupportChecked
      ? ("unknown" as const)
      : this.outputSupport
        ? ("supported" as const)
        : ("unsupported" as const);
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(update: Partial<SessionState>) {
    if (this.stopped) return;
    if (update.answerAttempts)
      update.answerAttempts = Object.freeze([...update.answerAttempts]);
    const next = { ...this.state, ...update };
    if (
      update.status === "online" ||
      update.status === "unauthorized" ||
      update.error === null
    )
      delete next.connectionDiagnostic;
    const pending = this.pendingProcess;
    const matches =
      pending &&
      next.pending &&
      pending.serializedCommand === JSON.stringify(next.pending);
    const previous = this.state.processPending;
    next.processPending = matches
      ? previous?.command === pending.command &&
        previous.target === pending.target &&
        previous.outcome === pending.outcome &&
        previous.error === pending.error &&
        previous.notice === pending.notice
        ? previous
        : Object.freeze({
            command: pending.command,
            target: pending.target,
            outcome: pending.outcome,
            error: pending.error,
            ...(pending.notice ? { notice: pending.notice } : {}),
          })
      : null;
    this.state = next;
    for (const f of this.listeners) f();
  }
  private storageError() {
    if (
      this.commandFlight &&
      isProcessRuntimeCommand(this.commandFlight.command) &&
      this.commandFlight.outcomeKnown
    )
      this.commandRejection ??= "storage_error";
    this.publish({
      processNotice: this.localNotice("storage_error"),
      error:
        this.commandFlight &&
        isProcessRuntimeCommand(this.commandFlight.command) &&
        this.commandFlight.outcomeKnown
          ? this.commandRejection
          : "storage_error",
    });
  }
  private localNotice(code: ProcessNoticeLocalError) {
    const view = this.state.processNotice;
    return view
      ? Object.freeze({
          ...view,
          errorSource: Object.freeze({ kind: "local" as const, code }),
        })
      : null;
  }
  private retainedRuntimeNotice(flight = this.commandFlight) {
    const view = this.state.processNotice;
    return view &&
      flight?.outcomeKnown &&
      noticeMatchesCommand(
        view.notice,
        flight.command,
        this.address,
        this.credential.scope,
      ) &&
      view.notice.rawCode === this.commandRejection
      ? Object.freeze({
          ...view,
          errorSource: Object.freeze({ kind: "runtime" as const }),
        })
      : view;
  }
  private connectionError() {
    return this.commandFlight &&
      isProcessRuntimeCommand(this.commandFlight.command) &&
      this.commandFlight.outcomeKnown
      ? (this.commandRejection ?? "connection_failed")
      : "connection_failed";
  }
  private invalidate() {
    if (this.stopped || this.invalid) return;
    this.attachments.dispose();
    this.invalid = true;
    this.authorized = false;
    clearInterval(this.timer);
    for (const c of this.controllers) c.abort();
    this.commandFlight?.stopActivity();
    this.commandFlight?.markReady();
    this.commandFlight?.retire();
    this.publish({
      store: null,
      pending: null,
      answerAttempts: [],
      answerRecoveryBlocked: false,
      commandStates: {},
      status: "unauthorized",
      error: "auth_expired",
      processNotice: null,
      activity: null,
      activitySteps: null,
      activityApproval: null,
      activityConnection: "unavailable",
    });
    this.onInvalid();
  }
  private checkAuthorization() {
    if (this.invalid || Date.parse(this.credential.expiresAt) <= Date.now()) {
      this.invalidate();
      throw new AuthenticationError("auth_expired");
    }
  }
  /** Whether an expired or refused credential can be replaced here. */
  private get renewable() {
    return (
      !!this.renewCredential &&
      (!!this.credential.refresh || !!this.options.reissue)
    );
  }
  private async ensureCredential(force = false) {
    if (this.stopped || this.invalid)
      throw new AuthenticationError("auth_expired");
    if (this.renewing) return this.renewing;
    if (!this.renewable) {
      this.checkAuthorization();
      return;
    }
    if (
      !force &&
      !this.recoveringRefresh &&
      Date.parse(this.credential.expiresAt) > Date.now() + 10_000
    )
      return;
    this.renewing = (async () => {
      try {
        // A recovered response may contain expired access; persist it, then rotate its refresh token.
        for (let attempt = 0; attempt < 2; attempt++) {
          const next = await this.renewCredential!(this.credential);
          if (this.stopped || this.invalid) throw new Error("session_stopped");
          if (!sameScope(next.scope, this.credential.scope))
            throw new AuthenticationError("auth_scope_mismatch");
          this.credential = next;
          this.recoveringRefresh = false;
          if (Date.parse(next.expiresAt) > Date.now()) return;
        }
        throw new Error("connection_failed");
      } catch (error) {
        if (
          error instanceof AuthenticationError &&
          error.message !== "connection_failed"
        )
          this.invalidate();
        throw error;
      } finally {
        this.renewing = undefined;
      }
    })();
    return this.renewing;
  }
  /** The server address of a path, with the delivery profiles the session negotiates. */
  private deliveryUrl(path: string) {
    return `${this.address}/${/^(?:snapshot|events|commands|server)(?:\/|\?|$)/.test(path) ? this.messageDelivery(processWorkDeliveryPath(questionOptionsDeliveryPath(cardDeliveryPath(`${path}${path.includes("?") ? "&" : "?"}chats=${CONVERSATION_PROJECTION_PROFILE}`)), this.outputSupport ? PROCESS_OUTPUT_WORK_PROFILE : this.options.processApprovals ? PROCESS_APPROVAL_WORK_PROFILE : this.options.processQuestions ? PROCESS_QUESTION_WORK_PROFILE : PROCESS_WORK_PROFILE)) : path}`;
  }
  /**
   * Opens an authenticated request and checks its status; the caller reads
   * the body and calls `done` afterwards, also when reading fails.
   */
  private async open(
    path: string,
    init?: RequestInit,
    timeoutMs = 8000,
    allowForbidden = false,
  ) {
    if (this.stopped) throw new Error("session_stopped");
    await this.ensureCredential();
    if (this.stopped || init?.signal?.aborted)
      throw new Error("session_stopped");
    if (
      this.options.attachments &&
      /^(?:snapshot|events|commands|conversations\/messages)(?:\?|\/|$)/.test(
        path,
      )
    )
      await this.attachments.discover();
    const requestedCredential = this.credential;
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    controller.signal.addEventListener("abort", () => clearTimeout(timer), {
      once: true,
    });
    const cancel = () => {
      controller.abort();
      clearTimeout(timer);
    };
    init?.signal?.addEventListener("abort", cancel, { once: true });
    if (init?.signal?.aborted) controller.abort();
    const done = () => {
      clearTimeout(timer);
      init?.signal?.removeEventListener("abort", cancel);
      this.controllers.delete(controller);
    };
    try {
      const response = await this.request(this.deliveryUrl(path), {
        ...init,
        credentials: "omit",
        headers: {
          ...init?.headers,
          Authorization: `Bearer ${requestedCredential.accessToken}`,
        },
        signal: controller.signal,
        redirect: "error",
      });
      if (this.stopped || this.invalid || controller.signal.aborted)
        throw new Error("session_stopped");
      if (
        response.status === 401 ||
        (response.status === 403 &&
          !path.startsWith("services/") &&
          !allowForbidden)
      ) {
        if (response.status === 401 && this.renewable) {
          if (this.credential.accessToken === requestedCredential.accessToken)
            await this.ensureCredential(true);
          // Never replay a write automatically. Reads recover on the next sync.
          throw new Error("connection_failed");
        }
        this.invalidate();
        throw new AuthenticationError("auth_expired");
      }
      return { response, controller, done };
    } catch (error) {
      done();
      throw error;
    }
  }
  private async readJson(
    response: Response,
    controller: AbortController,
    maxBody: number,
    maxUtf8Bytes?: number,
  ) {
    const body = await response.text();
    // A successful response is already authorized. Do not discard it because a
    // separate refresh fails; renew before the next request instead.
    if (!this.renewable) this.checkAuthorization();
    if (this.stopped || this.invalid || controller.signal.aborted)
      throw new Error("session_stopped");
    if (body.length > maxBody)
      throw new ConnectionPayloadError(response.status);
    const bodyBytes =
      maxUtf8Bytes === undefined
        ? undefined
        : processReaderUtf8Bytes(body, maxUtf8Bytes);
    if (maxUtf8Bytes !== undefined && bodyBytes! > maxUtf8Bytes)
      throw new ConnectionPayloadError(response.status);
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      throw new ConnectionJsonError(response.status);
    }
    return { response, value, bodyBytes };
  }
  private async json(
    path: string,
    init?: RequestInit,
    timeoutMs = 8000,
    maxBody = 2_000_000,
    maxUtf8Bytes?: number,
    allowForbidden = false,
  ) {
    const { response, controller, done } = await this.open(
      path,
      init,
      timeoutMs,
      allowForbidden,
    );
    try {
      return await this.readJson(response, controller, maxBody, maxUtf8Bytes);
    } finally {
      done();
    }
  }
  /**
   * Sends a chat message and follows the answer over the response: the draft
   * as it is written and each tool step, published like polled activity, then
   * the command result the JSON response would have carried. A server that
   * answers JSON instead is read as such, with polling started.
   */
  private async streamAnswer(
    path: string,
    init: RequestInit,
    command: Extract<Command, { type: "message.send" | "service.resolve" }>,
    onJson: () => void,
  ): Promise<{ response: Pick<Response, "ok" | "status">; value: unknown }> {
    const { response, controller, done } = await this.open(
      path,
      {
        ...init,
        headers: { ...init.headers, Accept: ANSWER_STREAM_MEDIA_TYPE },
      },
      // The run's own deadline; idle streams end sooner below.
      10 * 60_000,
    );
    try {
      if (
        !response.headers
          .get("content-type")
          ?.includes(ANSWER_STREAM_MEDIA_TYPE) ||
        !response.body
      ) {
        onJson();
        return await this.readJson(response, controller, 2_000_000);
      }
      const current = () =>
        !this.stopped && !this.invalid && this.state.pending === command;
      const activity: RequestActivity = {
        commandId: command.commandId,
        conversationId: command.conversationId,
        status: "running",
        steps: [
          { id: "understanding", status: "running" },
          { id: "preparing", status: "pending" },
        ],
      };
      const steps = new Map<string, AnswerStreamStep>();
      let text = "";
      let approval: AnswerStreamApproval | null = null;
      let result: { status: number; body: unknown } | undefined;
      const live = () => {
        if (!current()) return;
        this.publish({
          activity: {
            ...activity,
            ...(text ? { draft: text.slice(0, ACTIVITY_DRAFT_MAX) } : {}),
          },
          activityConnection: "live",
          activitySteps: [...steps.values()],
          activityApproval: approval,
        });
      };
      // The model writes many small chunks a second; the thread is rebuilt
      // for each publish, so text is shown at most every LIVE_INTERVAL_MS.
      let lastLive = 0;
      let liveTimer: ReturnType<typeof setTimeout> | undefined;
      const scheduleLive = () => {
        const due = lastLive + LIVE_INTERVAL_MS - Date.now();
        if (due <= 0) {
          clearTimeout(liveTimer);
          liveTimer = undefined;
          lastLive = Date.now();
          live();
        } else if (!liveTimer)
          liveTimer = setTimeout(() => {
            liveTimer = undefined;
            lastLive = Date.now();
            live();
          }, due);
      };
      const fields = (value: unknown, key: string) => {
        const list =
          value && typeof value === "object" && key in value
            ? (value as Record<string, unknown>)[key]
            : undefined;
        return Array.isArray(list)
          ? list.flatMap((item) =>
              item &&
              typeof item === "object" &&
              typeof (item as { label?: unknown }).label === "string" &&
              typeof (item as { value?: unknown }).value === "string"
                ? [item as { label: string; value: string }]
                : [],
            )
          : [];
      };
      const apply = (chunk: AnswerStreamChunk) => {
        // The draft stays through text-end: the stored message replaces it.
        if (chunk.type === "text-start") text = "";
        else if (chunk.type === "text-delta") text += chunk.delta;
        else if (chunk.type === "tool-input-start")
          steps.set(chunk.toolCallId, {
            toolCallId: chunk.toolCallId,
            label: chunk.toolName,
            status: "running",
            input: [],
            output: [],
          });
        else if (chunk.type === "tool-input-available") {
          const step = steps.get(chunk.toolCallId);
          if (step) step.input = fields(chunk.input, "fields");
        } else if (chunk.type === "tool-output-available") {
          const step = steps.get(chunk.toolCallId);
          if (step) {
            const status =
              chunk.output &&
              typeof chunk.output === "object" &&
              "status" in chunk.output &&
              chunk.output.status === "waiting"
                ? "waiting"
                : "succeeded";
            steps.set(chunk.toolCallId, {
              ...step,
              status,
              output: fields(chunk.output, "fields"),
            });
          }
        } else if (chunk.type === "tool-output-error") {
          const step = steps.get(chunk.toolCallId);
          if (step) steps.set(chunk.toolCallId, { ...step, status: "failed" });
        } else if (chunk.type === "data-tool-call-approval")
          approval = chunk.data;
        else if (chunk.type === "data-niaro-result") result = chunk.data;
      };
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let idle: ReturnType<typeof setTimeout> | undefined;
      const touch = () => {
        clearTimeout(idle);
        idle = setTimeout(() => controller.abort(), 60_000);
      };
      touch();
      try {
        for (;;) {
          const { done: ended, value } = await reader.read();
          if (ended) break;
          touch();
          buffer += decoder.decode(value, { stream: true });
          const { events, rest } = splitServerSentEvents(buffer);
          buffer = rest;
          let finished = false;
          // A step or an approval card is shown at once; only the text
          // deltas, which come many a second, wait for the interval.
          let urgent = false;
          for (const event of events) {
            const chunk = parseAnswerStreamEvent(event);
            if (chunk === "done") finished = true;
            else if (chunk) {
              apply(chunk);
              if (chunk.type !== "text-delta") urgent = true;
            }
          }
          if (result || finished) break;
          if (urgent) lastLive = 0;
          scheduleLive();
        }
      } finally {
        clearTimeout(liveTimer);
        clearTimeout(idle);
        reader.cancel().catch(() => {});
      }
      if (this.stopped || this.invalid) throw new Error("session_stopped");
      // A stream that ended without its result tells nothing about the run:
      // the command stays pending and is retried or joined as before.
      if (!result) throw new Error("network_error");
      return {
        response: { ok: result.status < 400, status: result.status },
        value: result.body,
      };
    } finally {
      done();
    }
  }
  /** Negotiated personal settings; legacy speech envelopes stay unchanged. */
  async outputVoiceSettings(
    signal: AbortSignal,
  ): Promise<OutputVoiceSnapshot | null> {
    const scope = { ...this.credential.scope };
    const { response, controller, done } = await this.open(
      `voice/output-settings?profile=${OUTPUT_VOICE_PROFILE}`,
      { signal },
    );
    try {
      if (!sameScope(scope, this.credential.scope) || signal.aborted)
        throw new Error("output_voice_context_changed");
      // Old servers may return an empty/non-JSON 404 body.
      if (response.status === 404) return null;
      const { value } = await this.readJson(
        response,
        controller,
        OUTPUT_VOICE_SNAPSHOT_BYTES,
        OUTPUT_VOICE_SNAPSHOT_BYTES,
      );
      if (!sameScope(scope, this.credential.scope) || signal.aborted)
        throw new Error("output_voice_context_changed");
      if (
        response.status === 406 &&
        z
          .strictObject({
            error: z.literal("output_voice_profile_unsupported"),
          })
          .safeParse(value).success
      )
        return null;
      if (!response.ok) throw new Error("output_voice_load_failed");
      const snapshot = OutputVoiceSnapshotSchema.parse(value);
      if (
        this.stopped ||
        this.invalid ||
        signal.aborted ||
        !sameScope(scope, this.credential.scope) ||
        !sameScope(snapshot.scope, scope)
      )
        throw new Error("output_voice_context_changed");
      return snapshot;
    } finally {
      done();
    }
  }
  /** A single authorized POST. Unknown outcomes belong to passive GET/explicit retry. */
  async saveOutputVoiceSettings(
    update: OutputVoiceUpdate,
    signal: AbortSignal,
  ): Promise<OutputVoiceSnapshot> {
    const body = JSON.stringify(OutputVoiceUpdateSchema.parse(update));
    const scope = { ...this.credential.scope };
    const { response, value } = await this.json(
      `voice/output-settings?profile=${OUTPUT_VOICE_PROFILE}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal,
      },
      8000,
      OUTPUT_VOICE_SNAPSHOT_BYTES,
      OUTPUT_VOICE_SNAPSHOT_BYTES,
    );
    if (!response.ok) {
      const refusal = z
        .strictObject({
          error: z.enum([
            "invalid_payload",
            "output_voice_conflict",
            "output_voice_catalogue_changed",
            "output_voice_choice_unavailable",
            "output_voice_profile_unsupported",
          ]),
        })
        .safeParse(value);
      if ([400, 406, 409, 422].includes(response.status) && refusal.success)
        throw new Error(refusal.data.error);
      throw new Error("output_voice_outcome_unknown");
    }
    const snapshot = OutputVoiceSnapshotSchema.parse(value);
    if (
      this.stopped ||
      this.invalid ||
      signal.aborted ||
      !sameScope(scope, this.credential.scope) ||
      !sameScope(snapshot.scope, scope)
    )
      throw new Error("output_voice_context_changed");
    return snapshot;
  }
  async speechCapabilities(signal: AbortSignal) {
    const { response, value } = await this.json("voice/speech", { signal });
    if (!response.ok) throw new Error("speech_unavailable");
    return SpeechCapabilitiesSchema.parse(value);
  }
  private async discoverProcessOutputs() {
    if (!this.options.processOutputs || this.outputSupportChecked) return;
    if (this.outputDiscovery) return this.outputDiscovery;
    this.outputDiscovery = (async () => {
      try {
        const { response, value } = await this.json(
          `processes/output/capabilities?profile=${encodeURIComponent(PROCESS_OUTPUT_PROFILE)}`,
          undefined,
          3000,
          4096,
          4096,
        );
        if (!response.ok && response.status !== 404 && response.status !== 406)
          throw new ConnectionHttpError(response.status);
        this.outputSupport =
          response.ok && supportsProcessOutput(value, this.credential.scope);
        this.outputSupportChecked = true;
      } catch (error) {
        if (
          error instanceof SyntaxError ||
          (error instanceof Error && error.message === "payload_too_large")
        ) {
          this.outputSupport = false;
          this.outputSupportChecked = true;
        } else throw error;
      }
    })();
    try {
      await this.outputDiscovery;
    } finally {
      this.outputDiscovery = undefined;
    }
  }
  /** Authorized passive read; never sends a command, refreshes a service, or persists output. */
  async loadProcessOutputPage(
    rawRequest: ProcessOutputRequest,
    expectedOffset = 0,
    signal?: AbortSignal,
  ) {
    this.assertProcessRead(signal);
    if (!this.options.processOutputs || !this.outputSupport)
      throw new ProcessReaderError("process_output_unsupported");
    const request = freezeProcessOutputRequest(rawRequest);
    const assertCurrent = () => {
      this.assertProcessRead(signal);
      if (this.state.status !== "online")
        throw new ProcessReaderError("process_output_changed");
      assertCurrentProcessOutput(
        this.state.store,
        this.address,
        this.credential.scope,
        request,
      );
    };
    try {
      assertCurrent();
      const { response, value } = await this.json(
        `processes/output?profile=${encodeURIComponent(PROCESS_OUTPUT_PROFILE)}&request=${encodeURIComponent(JSON.stringify(request))}`,
        { signal },
        8000,
        PROCESS_OUTPUT_MAX_PAGE_BYTES,
        PROCESS_OUTPUT_MAX_PAGE_BYTES,
        true,
      );
      assertCurrent();
      if (!response.ok) throw processOutputServerError(value);
      return parseProcessOutputPage(value, request, expectedOffset);
    } catch (error) {
      throw this.processReadError(
        error,
        signal,
        "process_output_invalid",
        "process_output_limit",
      );
    }
  }
  private assertProcessRead(signal?: AbortSignal) {
    if (signal?.aborted || this.stopped)
      throw new ProcessReaderError("process_read_cancelled");
    if (this.invalid) throw new AuthenticationError("auth_expired");
    if (!this.options.processExecution && !this.options.processQuestions)
      throw new ProcessReaderError("process_profile_unsupported");
  }
  private assertProcessDesignAccess(signal?: AbortSignal) {
    if (signal?.aborted || this.stopped)
      throw new ProcessReaderError("process_read_cancelled");
    if (this.invalid) throw new AuthenticationError("auth_expired");
  }
  private processReadError(
    error: unknown,
    signal: AbortSignal | undefined,
    invalidCode: string,
    limitCode: string,
  ): Error {
    if (signal?.aborted || this.stopped)
      return new ProcessReaderError("process_read_cancelled");
    if (
      error instanceof AuthenticationError ||
      error instanceof ProcessReaderError
    )
      return error;
    if (this.invalid) return new AuthenticationError("auth_expired");
    if (error instanceof SyntaxError)
      return new ProcessReaderError(invalidCode);
    if (error instanceof Error && error.message === "payload_too_large")
      return new ProcessReaderError(limitCode);
    return new ProcessReaderError("process_read_failed");
  }
  /** Passive authorized metadata only. Expose one complete fingerprint or fail. */
  async loadProcessInventory(
    signal?: AbortSignal,
  ): Promise<ProcessExecutionList> {
    this.assertProcessRead(signal);
    for (let attempt = 0; attempt < 2; attempt++) {
      const processes: ProcessExecutionEntry[] = [];
      let fingerprint: string | undefined,
        after: string | null = null,
        bytes = 0;
      try {
        for (
          let pageIndex = 0;
          pageIndex < PROCESS_INVENTORY_MAX_PAGES;
          pageIndex++
        ) {
          this.assertProcessRead(signal);
          const path =
            `processes?profile=${encodeURIComponent(PROCESS_EXECUTION_PROFILE)}` +
            (after
              ? `&after=${encodeURIComponent(after)}&fingerprint=${fingerprint}`
              : "");
          const result = await this.json(
            path,
            { signal },
            8000,
            PROCESS_INVENTORY_PAGE_BYTES,
            PROCESS_INVENTORY_PAGE_BYTES,
          );
          this.assertProcessRead(signal);
          if (!result.response.ok) throw processReaderServerError(result.value);
          bytes += result.bodyBytes!;
          if (bytes > PROCESS_INVENTORY_TOTAL_BYTES)
            throw new ProcessReaderError("process_inventory_limit");
          const page = parseProcessInventoryPage(
            result.value,
            this.credential.scope,
          );
          if (fingerprint && page.fingerprint !== fingerprint)
            throw new ProcessReaderError("process_inventory_changed");
          fingerprint ??= page.fingerprint;
          let previous: string | null = after;
          for (const entry of page.processes) {
            if (previous !== null && entry.processId <= previous)
              throw new ProcessReaderError("process_inventory_invalid");
            processes.push(entry);
            previous = entry.processId;
          }
          if (processes.length > PROCESS_INVENTORY_MAX_ENTRIES)
            throw new ProcessReaderError("process_inventory_limit");
          if (page.nextAfter === null)
            return immutableJson({
              scope: page.scope,
              fingerprint,
              processes,
              refreshed: attempt > 0,
            });
          if (!page.processes.length || page.nextAfter !== previous)
            throw new ProcessReaderError("process_inventory_invalid");
          after = page.nextAfter;
        }
        throw new ProcessReaderError("process_inventory_limit");
      } catch (error) {
        const reason = this.processReadError(
          error,
          signal,
          "process_inventory_invalid",
          "process_inventory_limit",
        );
        if (
          attempt === 0 &&
          reason instanceof ProcessReaderError &&
          reason.code === "process_inventory_changed"
        )
          continue;
        throw reason;
      }
    }
    throw new ProcessReaderError("process_inventory_changed");
  }
  /** Explicit intent preparation freezes metadata only; it never sends a command. */
  async prepareProcessInput(
    request: ProcessInputRequest,
    reviewedEntry: ReadyProcessExecutionEntry,
    signal?: AbortSignal,
  ): Promise<ProcessStartTarget> {
    this.assertProcessRead(signal);
    const selection = freezeProcessInputSelection(request, reviewedEntry);
    try {
      const { response, value } = await this.json(
        `processes/input?profile=${encodeURIComponent(PROCESS_EXECUTION_PROFILE)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(selection.request),
          signal,
        },
        8000,
        PROCESS_INPUT_RESPONSE_BYTES,
        PROCESS_INPUT_RESPONSE_BYTES,
      );
      this.assertProcessRead(signal);
      if (!response.ok) throw processReaderServerError(value);
      return parseProcessInputTarget(
        value,
        selection.request,
        selection.entry,
        this.address,
        this.credential.scope,
      );
    } catch (error) {
      throw this.processReadError(
        error,
        signal,
        "process_form_invalid",
        "process_input_limit",
      );
    }
  }
  /** Native, bearer-authenticated workspace process designer transport. */
  async requestProcessDesign(
    action:
      | "review"
      | "capabilities"
      | "start"
      | "update"
      | "acknowledge"
      | "accept"
      | "turn"
      | "turns"
      | "turns/list"
      | "sessions/list"
      | "drafts/list",
    query: Record<string, string>,
    payload?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.assertProcessDesignAccess(signal);
    const { profile: requestedProfile, ...target } = query;
    const profile = requestedProfile ?? "agent-process-design/2";
    if (
      profile !== "agent-process-design/1" &&
      profile !== "agent-process-design/2"
    )
      throw new SyntaxError("process_design_profile_unsupported");
    const params = new URLSearchParams({ ...target, profile });
    const suffix =
      action === "review" ? "" : action === "turn" ? "/turns" : `/${action}`;
    const read = [
      "review",
      "capabilities",
      "turns",
      "turns/list",
      "sessions/list",
      "drafts/list",
    ].includes(action);
    // Proposal diffs and the bounded 64-turn transcript may exceed the compact
    // mutation size while remaining within the server's per-session limits.
    const responseLimit =
      action === "review" || action === "turns/list" ? 1_000_000 : 131_072;
    const { response, value } = await this.json(
      `process-design${suffix}?${params}`,
      read
        ? { signal }
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal,
          },
      120_000,
      responseLimit,
      responseLimit,
      true,
    );
    this.assertProcessDesignAccess(signal);
    if (!response.ok) {
      const code =
        value &&
        typeof value === "object" &&
        typeof (value as { error?: unknown }).error === "string"
          ? (value as { error: string }).error
          : "process_design_unavailable";
      throw new ProcessDesignApiError(response.status, code);
    }
    return value;
  }
  async serviceConnection(
    action: "start" | "status" | "cancel",
    serviceId: string,
    signal: AbortSignal,
    attemptId?: string,
  ) {
    if (action === "cancel" && !attemptId)
      throw new Error("service_connection_changed");
    const { response, value } = await this.json(
      `services/${action}`,
      {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceId,
          ...(attemptId ? { attemptId } : {}),
        }),
      },
      8000,
      16384,
    );
    if (!response.ok) throw new Error("service_connection_failed");
    const parsed =
      action === "start"
        ? ServiceConnectionStart.parse(value)
        : ServiceConnectionStatus.parse(value);
    if (parsed.serviceId !== serviceId)
      throw new Error("service_connection_changed");
    if ("authorizationUrl" in parsed) {
      const url = new URL(parsed.authorizationUrl);
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.origin !== new URL(this.address).origin ||
        url.pathname !== "/admin/service-connect" ||
        url.hash !== `#${parsed.attemptId}` ||
        url.search ||
        url.username ||
        url.password ||
        parsed.expiresAt <= Date.now() ||
        // The server grants ten minutes by its own clock; a phone may run behind.
        parsed.expiresAt > Date.now() + 600_000 + CLOCK_SKEW
      )
        throw new Error("service_connection_changed");
    }
    return parsed;
  }
  async synthesize(raw: SpeechRequest, signal: AbortSignal) {
    const request = SpeechRequestSchema.parse(raw);
    if (!this.authorized || this.state.status !== "online")
      throw new Error("offline");
    const { response, value } = await this.json(
      "voice/speech",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal,
      },
      70000,
      SPEECH_BODY_BYTES,
    );
    if (!response.ok) {
      const code =
        value && typeof value === "object" && "error" in value
          ? value.error
          : null;
      throw new Error(
        typeof code === "string" && code.startsWith("speech_")
          ? code
          : "speech_unavailable",
      );
    }
    const result = SpeechResultSchema.parse(value);
    if (
      !sameScope(result.scope, this.credential.scope) ||
      result.requestId !== request.requestId ||
      result.messageId !== request.messageId ||
      result.conversationId !== request.conversationId ||
      result.language !== request.language
    )
      throw new Error("speech_context_changed");
    return result.audio;
  }
  async voiceCapabilities(signal: AbortSignal) {
    const { response, value } = await this.json("voice", { signal });
    if (!response.ok) throw new Error("voice_unavailable");
    return VoiceCapabilitiesSchema.parse(value);
  }
  async transcribe(raw: VoiceRequest, signal: AbortSignal) {
    const request = VoiceRequestSchema.parse(raw);
    if (!this.authorized || this.state.status !== "online")
      throw new Error("offline");
    const { response, value } = await this.json(
      "voice/transcriptions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(VoiceRequestSchema.parse(request)),
        signal,
      },
      115_000,
    );
    if (!response.ok) {
      const code =
        value && typeof value === "object" && "error" in value
          ? value.error
          : null;
      throw new Error(
        typeof code === "string" && code.startsWith("voice_")
          ? code
          : "voice_processing_failed",
      );
    }
    const result = VoiceResultSchema.parse(value);
    if (
      !sameScope(result.scope, this.credential.scope) ||
      result.requestId !== request.requestId ||
      result.language !== request.language ||
      JSON.stringify(result.context) !== JSON.stringify(request.context)
    )
      throw new Error("voice_context_changed");
    return { text: result.text, reviewReasons: result.reviewReasons };
  }
  private write(work: () => Promise<void>) {
    this.writes = this.writes.catch(() => {}).then(work);
    return this.writes;
  }
  private save() {
    if (!this.state.store) return Promise.resolve();
    const snapshot = JSON.stringify(toSnapshot(this.state.store));
    return this.write(() => this.storage.setItem(this.cacheKey, snapshot));
  }
  private parseProcessPending(raw: unknown): ProcessPending {
    const value = ProcessPendingSchema.parse(raw);
    if (value.serializedCommand !== JSON.stringify(value.command))
      throw Error("process_command_changed");
    if (
      value.notice &&
      (!noticeMatchesCommand(
        value.notice,
        value.command,
        this.address,
        this.credential.scope,
      ) ||
        value.outcome !==
          (value.notice.result.kind === "refused" ? "rejected" : "accepted") ||
        value.notice.rawCode !== value.error ||
        (value.notice.result.kind === "refused" &&
          value.notice.rawCode !== value.notice.result.reason))
    )
      throw Error("process_command_changed");
    if (
      value.notice?.result.kind === "process" &&
      value.target.type === "service.resolve"
    ) {
      const result = value.notice.result,
        p = value.target.provenance;
      if (
        result.parentRunId !== value.target.workItemId ||
        result.runId !== p.runId ||
        result.processId !== p.processId ||
        result.version !== p.version ||
        result.artifactDigest !== p.artifactDigest ||
        result.startCommandId !== p.commandId ||
        result.admissionId !== p.admissionId
      )
        throw Error("process_command_changed");
    }
    if (
      value.notice?.result.kind === "process" &&
      value.target.type === "process.start"
    ) {
      const result = value.notice.result,
        intent = value.target.card.intent;
      if (
        result.processId !== intent.processId ||
        result.version !== intent.version ||
        result.artifactDigest !== intent.artifactDigest ||
        result.startCommandId !== value.command.commandId
      )
        throw Error("process_command_changed");
    }
    validateProcessCommandTarget(
      value.command,
      value.target,
      this.address,
      this.credential.scope,
    );
    return immutableJson(value);
  }
  private persistProcessPending(
    pending: ProcessPending,
    current?: () => boolean,
  ) {
    const serialized = JSON.stringify(this.parseProcessPending(pending));
    boundedPending(serialized);
    return this.write(async () => {
      if (current && !current()) return;
      try {
        await this.storage.setItem(this.pendingKey, serialized);
      } catch (error) {
        // An unchanged old unknown envelope cannot prove this retry write
        // succeeded. Fail closed before transport; only a new known marker can
        // recognize an adapter that rejected after committing its transition.
        if (pending.outcome === "unknown") throw error;
        if (
          (await this.storage.getItem(this.pendingKey).catch(() => null)) !==
          serialized
        )
          throw error;
      }
    });
  }
  private async retainProcessExecutionConflict(flight: CommandFlight) {
    const original = flight.processPending;
    const current = () =>
      this.currentFlight(flight) &&
      !flight.outcomeKnown &&
      !flight.interruptionFailed &&
      !!original &&
      original.outcome === "unknown" &&
      !original.notice &&
      this.pendingProcess === original &&
      flight.processPending === original;
    if (!current()) return;
    const pending = this.parseProcessPending({
      ...original,
      error: PROCESS_EXECUTION_UNVERIFIED,
    });
    // Unknown metadata has the same fail-closed write semantics as an exact retry.
    // Do not publish it from readback after an adapter rejected its write.
    await this.persistProcessPending(pending, current);
    if (!current()) return;
    flight.processPending = pending;
    this.pendingProcess = pending;
  }
  private persistAnswerAttempts() {
    if (this.answerStorageBlocked)
      return Promise.reject(Error("storage_error"));
    const envelope = ProcessAnswerAttemptsEnvelopeSchema.parse({
      version: 1,
      connectionKey: this.address,
      scope: this.credential.scope,
      attempts: this.state.answerAttempts.filter(
        (attempt) => !this.redactedAnswerIds.has(attempt.command.commandId),
      ),
      pendingCommandId: this.answerPendingId,
    });
    const serialized = serializeProcessAnswerAttempts(envelope);
    return this.write(async () => {
      try {
        await this.storage.setItem(this.answerAttemptsKey, serialized);
      } catch (error) {
        // Some adapters reject after committing. Exact readback recognizes that
        // durable state without ever downgrading a known in-memory outcome.
        if (
          (await this.storage
            .getItem(this.answerAttemptsKey)
            .catch(() => null)) !== serialized
        )
          throw error;
      }
      this.answerEnvelopePresent = true;
    });
  }
  private updateAnswerAttempt(
    commandId: string,
    outcome: ProcessAnswerAttempt["outcome"],
    error: string | null,
  ) {
    this.publish({
      answerAttempts: this.updatedAnswerAttempts(commandId, outcome, error),
    });
  }
  private updatedAnswerAttempts(
    commandId: string,
    outcome: ProcessAnswerAttempt["outcome"],
    error: string | null,
  ) {
    return this.state.answerAttempts.map((attempt) =>
      attempt.command.commandId !== commandId ||
      this.redactedAnswerIds.has(commandId) ||
      (attempt.outcome !== "unknown" && outcome === "unknown")
        ? attempt
        : immutableProcessAnswerAttempt({ ...attempt, outcome, error }),
    );
  }
  /** Settle only the delivery error owned by an answer now proven consumed. */
  private consumedDeliveryErrorUpdate(
    commandId: string,
    ownsPending: boolean,
    owner: CommandFlight | null,
  ): Partial<SessionState> {
    const error = this.commandRejection;
    if (
      !ownsPending ||
      this.commandFlight !== owner ||
      !this.consumedUnknownAnswerIds.has(commandId) ||
      error === "storage_error"
    )
      return {};
    this.commandRejection = null;
    return this.state.error === error ? { error: null } : {};
  }
  /** Unknown delivery remains the exact retry barrier until a definitive outcome is obtained. */
  async discardProcessAnswerAttempt(commandId: string): Promise<boolean> {
    const attempt = this.state.answerAttempts.find(
      (value) => value.command.commandId === commandId,
    );
    if (
      !attempt ||
      attempt.outcome === "unknown" ||
      this.stopped ||
      this.invalid ||
      this.answerStorageBlocked
    )
      return false;
    const discardOwner = this.commandFlight;
    this.redactedAnswerIds.add(commandId);
    if (this.answerPendingId === commandId) this.answerPendingId = null;
    try {
      await this.persistAnswerAttempts();
      const pendingDiscarded =
        this.state.pending?.type === "process.answer" &&
        this.state.pending.commandId === commandId;
      const discardedFlight =
        pendingDiscarded && this.commandFlight?.command.commandId === commandId
          ? this.commandFlight
          : null;
      const clear = pendingDiscarded
        ? this.write(() => this.storage.setItem(this.pendingKey, "null"))
        : Promise.resolve();
      if (discardedFlight && this.submitting === discardedFlight)
        this.submitting = null;
      this.publish({
        answerAttempts: this.state.answerAttempts.filter(
          (value) => value.command.commandId !== commandId,
        ),
        ...(pendingDiscarded
          ? {
              pending: null,
              ...this.consumedDeliveryErrorUpdate(
                commandId,
                pendingDiscarded,
                discardOwner,
              ),
            }
          : {}),
      });
      this.redactedAnswerIds.delete(commandId);
      this.consumedUnknownAnswerIds.delete(commandId);
      if (discardedFlight) {
        const flight = discardedFlight;
        flight.stopActivity();
        // Discarding a known answer only retires local recovery. Its resumed
        // native execution may still be finishing the accepted HTTP request.
        flight.markReady();
        flight.retire();
      }
      await clear.catch(() => {
        if (this.commandFlight === discardOwner) this.storageError();
      });
      return true;
    } catch {
      this.redactedAnswerIds.delete(commandId);
      if (this.commandFlight === discardOwner) this.storageError();
      return false;
    }
  }
  private async retireConsumedAnswers(store: Store) {
    const consumed = this.state.answerAttempts.filter((attempt) =>
      isProcessAnswerConsumed(store, attempt.target, attempt.command),
    );
    if (!consumed.length) return;
    const originalPending = this.state.pending;
    const originalFlight = this.commandFlight;
    const pendingConsumed = consumed.some(
      (attempt) => attempt.command.commandId === this.state.pending?.commandId,
    );
    for (const attempt of consumed)
      if (attempt.outcome === "unknown")
        this.consumedUnknownAnswerIds.add(attempt.command.commandId);
    if (pendingConsumed) this.answerPendingId = null;
    for (const attempt of consumed) {
      this.updateAnswerAttempt(
        attempt.command.commandId,
        "accepted",
        attempt.error,
      );
      this.redactedAnswerIds.add(attempt.command.commandId);
    }
    if (pendingConsumed) {
      if (this.commandFlight?.command.type === "process.answer")
        this.commandFlight.outcomeKnown = true;
    }
    try {
      await this.persistAnswerAttempts();
      const ids = new Set(consumed.map((attempt) => attempt.command.commandId));
      const ownsPending =
        pendingConsumed &&
        this.state.pending?.commandId === originalPending?.commandId;
      // Queue the compatibility clear before publishing; a new command may be
      // sent synchronously by a listener, and its pending bytes must win last.
      const clear = ownsPending
        ? this.write(() => this.storage.setItem(this.pendingKey, "null"))
        : Promise.resolve();
      if (
        pendingConsumed &&
        originalFlight &&
        this.submitting === originalFlight
      )
        this.submitting = null;
      this.publish({
        answerAttempts: this.state.answerAttempts.filter(
          (attempt) => !ids.has(attempt.command.commandId),
        ),
        ...(ownsPending
          ? {
              pending: null,
              ...this.consumedDeliveryErrorUpdate(
                originalPending!.commandId,
                ownsPending,
                originalFlight,
              ),
              commandStates: {
                ...this.state.commandStates,
                [commandTarget(originalPending!)]: "accepted" as const,
              },
            }
          : {}),
      });
      if (pendingConsumed && originalFlight) {
        const flight = originalFlight;
        flight.stopActivity();
        // Consumption can be projected before the resumed native segment has
        // suspended or finished. Keep its transport live; json() retains its
        // controller for stop()/invalidate() and releases it on settlement.
        flight.markReady();
        flight.retire();
      }
      for (const id of ids) {
        this.redactedAnswerIds.delete(id);
        this.consumedUnknownAnswerIds.delete(id);
      }
      await clear;
    } catch {
      for (const attempt of consumed)
        this.redactedAnswerIds.delete(attempt.command.commandId);
      if (this.commandFlight === originalFlight) {
        this.commandRejection ??= "storage_error";
        this.storageError();
      }
    }
  }
  async start(poll = true) {
    await this.refresh();
    if (poll && !this.stopped && !this.invalid) {
      clearInterval(this.timer);
      this.timer = setInterval(() => {
        void this.sync();
      }, 1000);
    }
  }
  stop() {
    if (this.stopped) return;
    // Passive detail owners must lose their online authority immediately.
    if (this.options.processOutputs && !this.invalid)
      this.publish({
        status: "offline",
        ...(this.state.store
          ? { store: { ...this.state.store, stale: true } }
          : {}),
      });
    this.attachments.dispose();
    this.stopped = true;
    clearInterval(this.timer);
    for (const c of this.controllers) c.abort();
    this.commandFlight?.stopActivity();
    this.commandFlight?.markReady();
    this.commandFlight?.retire();
  }
  private async authorize() {
    if (this.authorizing) return this.authorizing;
    this.authorizing = this.authorizeAndRecover();
    try {
      await this.authorizing;
    } finally {
      this.authorizing = undefined;
    }
  }
  private async authorizeAndRecover() {
    await this.ensureCredential();
    const requestedCredential = this.credential;
    try {
      await authRequest(
        this.address,
        "session",
        this.request,
        requestedCredential,
      );
    } catch (error) {
      if (
        !(error instanceof AuthenticationError) ||
        error.message !== "auth_expired" ||
        !this.renewable
      )
        throw error;
      if (requestedCredential.accessToken === this.credential.accessToken)
        await this.ensureCredential(true);
      if (this.stopped || this.invalid) return;
      await authRequest(this.address, "session", this.request, this.credential);
    }
    if (this.stopped || this.invalid) return;
    this.checkAuthorization();
    try {
      const [cacheRead, pendingRead, attemptsRead, retrySourcesRead] =
        await Promise.allSettled([
          this.storage.getItem(this.cacheKey),
          this.storage.getItem(this.pendingKey),
          this.storage.getItem(this.answerAttemptsKey),
          this.storage.getItem(this.retrySourcesKey),
        ]);
      if (this.stopped || this.invalid) return;
      try {
        if (retrySourcesRead.status === "rejected")
          throw retrySourcesRead.reason;
        if (retrySourcesRead.value !== null) {
          const envelope = this.parseRetrySources(retrySourcesRead.value);
          this.retrySources = new Map(
            envelope.commands.map((command) => [command.commandId, command]),
          );
        } else this.retrySources = new Map();
        this.retrySourcesBlocked = false;
        this.retrySourcesReadFailed = false;
      } catch {
        this.retrySources.clear();
        this.retrySourcesBlocked = true;
        this.retrySourcesReadFailed = retrySourcesRead.status === "rejected";
      }
      let attemptsError = false;
      try {
        if (attemptsRead.status === "rejected") throw attemptsRead.reason;
        if (attemptsRead.value !== null) {
          const envelope = parseProcessAnswerAttempts(
            attemptsRead.value,
            this.address,
            this.credential.scope,
          );
          this.answerEnvelopePresent = true;
          this.answerPendingId = envelope.pendingCommandId;
          if (this.answerPendingId) this.pendingProcess = null;
          this.publish({ answerAttempts: envelope.attempts, pending: null });
          const pending = envelope.attempts.find(
            (attempt) =>
              attempt.command.commandId === envelope.pendingCommandId,
          );
          if (pending)
            this.publish({
              pending: pending.command,
              commandStates: {
                [commandTarget(pending.command)]: "network_error",
              },
            });
          else
            this.publish({
              commandStates: Object.fromEntries(
                envelope.attempts.map((attempt) => [
                  commandTarget(attempt.command),
                  attempt.outcome === "unknown"
                    ? "network_error"
                    : attempt.outcome,
                ]),
              ),
            });
        }
        const wasBlocked = this.answerStorageBlocked;
        this.answerStorageBlocked = false;
        this.publish({ answerRecoveryBlocked: this.outboxStorageBlocked });
        if (wasBlocked && this.commandRejection === "storage_error")
          this.commandRejection = null;
      } catch {
        attemptsError = true;
        this.answerStorageBlocked = true;
        this.authorized = false;
        this.publish({ answerRecoveryBlocked: true });
      }
      try {
        // An unknown answer's authoritative ledger owns the sole flight. Known
        // cards and empty envelopes do not own a start/resolve/ordinary outbox.
        if (!this.answerPendingId) {
          if (pendingRead.status === "rejected") throw pendingRead.reason;
          const pending = pendingRead.value;
          this.pendingProcess = null;
          if (pending && pending !== "null") {
            boundedPending(pending);
            const raw: unknown = JSON.parse(pending);
            const process =
              raw &&
              typeof raw === "object" &&
              "profile" in raw &&
              raw.profile === "agent-client.process-command/1"
                ? this.parseProcessPending(raw)
                : null;
            const c = process?.command ?? parseSessionCommand(raw);
            // The answer ledger suppresses only stale answer compatibility bytes.
            if (c.type !== "process.answer" || !this.answerEnvelopePresent) {
              this.pendingProcess = process;
              if (process && process.outcome !== "unknown")
                this.commandRejection = process.error;
              this.publish({
                pending: c,
                processNotice: process?.notice
                  ? Object.freeze({
                      notice: process.notice,
                      owner: null,
                      errorSource: Object.freeze({ kind: "runtime" as const }),
                    })
                  : null,
                commandStates: {
                  ...this.state.commandStates,
                  [commandTarget(c)]:
                    process && process.outcome !== "unknown"
                      ? process.outcome
                      : "network_error",
                },
              });
            }
          }
        }
        this.outboxStorageBlocked = false;
        this.publish({ answerRecoveryBlocked: this.answerStorageBlocked });
      } catch {
        this.outboxStorageBlocked = true;
        this.publish({ answerRecoveryBlocked: true });
        throw Error("storage_error");
      }
      if (attemptsError) throw Error("storage_error");
      if (cacheRead.status === "rejected") throw cacheRead.reason;
      const cache = cacheRead.value;
      if (cache && cache !== "null") {
        const s = SnapshotSchema.parse(
          migrateStoredWorkflowProfile(JSON.parse(cache)),
        );
        if (sameScope(s.scope, this.credential.scope))
          this.publish({
            store: {
              ...fromSnapshot(this.address, this.credential.scope, s),
              stale: true,
            },
          });
      }
    } catch {
      this.commandRejection = "storage_error";
      this.publish({
        error: "storage_error",
        processNotice: this.localNotice("storage_error"),
      });
    }
    // Authentication and local recovery form one gate. Concurrent refreshes
    // cannot publish online or deliver while an older ledger read is pending.
    this.authorized = !this.answerStorageBlocked && !this.outboxStorageBlocked;
  }
  async refresh() {
    if (this.stopped || this.invalid) return;
    let phase: ConnectionPhase = "authentication";
    let httpStatus: number | undefined;
    let received: unknown;
    try {
      if (!this.authorized) await this.authorize();
      if (this.stopped || this.invalid) return;
      phase = "capabilities";
      if (this.options.attachments)
        await Promise.all([
          this.discoverProcessOutputs(),
          this.attachments.discover(),
        ]);
      else await this.discoverProcessOutputs();
      if (this.stopped || this.invalid) return;
      phase = "snapshot";
      const { response, value } = await this.json(
        replyCorrelationPath(
          `snapshot?conversationId=${encodeURIComponent(this.selectedConversationId)}`,
        ),
      );
      httpStatus = response.status;
      received = value;
      if (!response.ok) throw new ConnectionHttpError(response.status);
      if (this.stopped || this.invalid) return;
      const snapshot = SnapshotSchema.parse(value);
      if (!sameScope(snapshot.scope, this.credential.scope))
        throw new AuthenticationError("auth_scope_mismatch");
      const store = this.mergeProjection(snapshot);
      const cacheOwner = this.commandFlight;
      this.publish({
        store: { ...store, stale: false },
        status: "online",
        error: this.commandRejection,
        processNotice: this.retainedRuntimeNotice(cacheOwner),
      });
      await this.syncRetrySources(store).catch(() => {});
      await this.retireConsumedAnswers(this.state.store!);
      if (!this.stopped)
        await this.save().catch(() => {
          if (this.commandFlight === cacheOwner) this.storageError();
        });
    } catch (error) {
      if (this.stopped || this.invalid) return;
      if (
        error instanceof AuthenticationError &&
        error.message !== "connection_failed"
      ) {
        this.invalidate();
        return;
      }
      this.publish({
        status: "offline",
        error: this.connectionError(),
        connectionDiagnostic: connectionDiagnostic(
          error,
          phase,
          httpStatus,
          received,
        ),
        processNotice: this.localNotice("connection_failed"),
        ...(this.state.store
          ? { store: { ...this.state.store, stale: true } }
          : {}),
      });
    }
  }
  async sync() {
    if (this.polling || this.stopped || this.invalid) return;
    this.polling = true;
    let httpStatus: number | undefined;
    let received: unknown;
    try {
      if (
        !this.state.store ||
        this.state.status !== "online" ||
        this.state.answerRecoveryBlocked
      ) {
        await this.refresh();
        return;
      }
      const { response, value } = await this.json(
        replyCorrelationPath(`events?after=${this.state.store.cursor}`),
      );
      httpStatus = response.status;
      received = value;
      if (response.status === 409) {
        await this.refresh();
        this.directoryChanged();
        return;
      }
      if (!response.ok) throw new ConnectionHttpError(response.status);
      if (this.stopped || this.invalid) return;
      const batch = EventsResponseSchema.parse(value);
      if (!sameScope(batch.scope, this.state.store.scope))
        throw new Error("scope_mismatch");
      let store = this.state.store;
      for (const event of batch.events)
        store = applyEvent(store, this.address, event);
      store = this.pruneProjection(store);
      if (store.needsSnapshot || batch.cursor > store.cursor) {
        await this.refresh();
        return;
      }
      toSnapshot(store); // Validate cross-entity references after the complete event batch.
      const cacheOwner = this.commandFlight;
      // Publish before awaiting local storage so a concurrent snapshot merge
      // sees this cursor and cannot roll back a newer terminal work status.
      this.publish({
        store,
        status: "online",
        error:
          this.state.error === "connection_failed" &&
          this.state.processNotice?.errorSource.kind !== "runtime"
            ? null
            : this.state.error,
        processNotice: this.retainedRuntimeNotice(cacheOwner),
      });
      await this.syncRetrySources(store).catch(() => {});
      await this.retireConsumedAnswers(store);
      await this.save().catch(() => {
        if (this.commandFlight === cacheOwner) this.storageError();
      });
    } catch (error) {
      if (this.stopped || this.invalid) return;
      if (
        error instanceof AuthenticationError &&
        error.message !== "connection_failed"
      ) {
        this.invalidate();
        return;
      }
      this.publish({
        status: "offline",
        error: this.connectionError(),
        connectionDiagnostic: connectionDiagnostic(
          error,
          "events",
          httpStatus,
          received,
        ),
        processNotice: this.localNotice("connection_failed"),
        ...(this.state.store
          ? { store: { ...this.state.store, stale: true } }
          : {}),
      });
    } finally {
      this.polling = false;
    }
  }
  private createFlight(
    command: SessionCommand,
    deliveryStarted = false,
    noticeOwner?: ProcessNoticeOwner,
  ): CommandFlight {
    let markReady!: () => void;
    let retire!: () => void;
    return {
      command,
      noticeOwner,
      serializedCommand:
        this.pendingProcess?.command.commandId === command.commandId
          ? this.pendingProcess.serializedCommand
          : JSON.stringify(command),
      ...(this.pendingProcess?.command.commandId === command.commandId
        ? { processPending: this.pendingProcess }
        : {}),
      controller: new AbortController(),
      deliveryStarted,
      outcomeKnown: false,
      interruptionFailed: false,
      stopActivity: () => {},
      ready: new Promise<void>((resolve) => {
        markReady = resolve;
      }),
      markReady: () => markReady(),
      retired: new Promise<void>((resolve) => {
        retire = resolve;
      }),
      retire: () => retire(),
    };
  }
  private currentFlight(flight: CommandFlight) {
    return (
      !this.stopped &&
      !this.invalid &&
      this.commandFlight === flight &&
      this.state.pending?.commandId === flight.command.commandId &&
      JSON.stringify(this.state.pending) === JSON.stringify(flight.command)
    );
  }
  private noticeOwner(command: SessionCommand, owner?: ProcessNoticeOwner) {
    return owner?.session === this &&
      owner.identityKey === this.identityKey &&
      owner.connectionKey === this.address &&
      sameScope(owner.scope, this.credential.scope) &&
      owner.conversationId === command.conversationId
      ? Object.freeze({ ...owner, scope: Object.freeze({ ...owner.scope }) })
      : undefined;
  }
  private runtimeNotice(
    flight: CommandFlight,
    result: ProcessRuntimeResponse,
  ): ProcessCommandNoticeView | null {
    const notice = processCommandNotice(flight.command, result, this.address);
    return notice
      ? Object.freeze({
          notice,
          owner: flight.noticeOwner ?? null,
          errorSource: Object.freeze({ kind: "runtime" as const }),
        })
      : null;
  }
  /** Both transport responses settle the same flight; a late response owns no newer state. */
  private async confirmCommand(flight: CommandFlight, result: CommandResult) {
    if (result.commandId !== flight.command.commandId)
      throw new Error("command_mismatch");
    if (!sameScope(result.snapshot.scope, this.credential.scope))
      throw new Error("scope_mismatch");
    if (!this.currentFlight(flight) || flight.outcomeKnown) return;
    let store = this.mergeProjection(result.snapshot);
    if (flight.command.type === "message.send" && flight.command.attachments)
      this.attachments.settleSend(
        flight.command.attachments,
        result.status === "accepted" ? "accepted" : "rejected",
      );
    if (flight.command.type === "message.send") {
      // The pending outbox remains durable until the exact native retry source
      // has been saved. Once the server response is authoritative, interruption
      // must not turn it back into an unknown delivery while local storage waits.
      flight.outcomeKnown = true;
      // Keep the server's receipt visible even if saving the retry source fails.
      // The exact command is still in the outbox, so a user can replay that same
      // idempotency key to repair local retry-source storage without duplicating
      // the logical message.
      this.publish({
        commandStates: {
          ...this.state.commandStates,
          [commandTarget(flight.command)]: result.status,
        },
        error: result.status !== "accepted" ? result.code : null,
      });
      await this.syncRetrySources(store, flight.command);
      if (!this.currentFlight(flight)) return;
      store = this.mergeProjection(result.snapshot);
    }
    return this.finishCommand(
      flight,
      {
        store,
        commandStates: {
          ...this.state.commandStates,
          [commandTarget(flight.command)]: result.status,
        },
        error: result.status !== "accepted" ? result.code : null,
      },
      flight.command.type === "message.send",
    );
  }
  /** Runtime envelopes prove delivery and ownership; only a subsequent snapshot projects the task. */
  private confirmProcessAnswer(
    flight: CommandFlight,
    result: ProcessRuntimeResponse,
  ) {
    const command = flight.command;
    if (
      command.type !== "process.answer" ||
      result.profile !== PROCESS_QUESTION_EXECUTION_PROFILE ||
      result.commandId !== command.commandId
    )
      throw new Error("command_mismatch");
    if (!sameScope(result.scope, this.credential.scope))
      throw new Error("scope_mismatch");
    const admission = result.admission;
    const provenance = this.state.answerAttempts.find(
      (attempt) => attempt.command.commandId === command.commandId,
    )?.target.provenance;
    if (
      admission.status !== "admitted" ||
      admission.parentRunId !== command.workItemId ||
      admission.origin.conversationId !== command.conversationId ||
      (provenance &&
        (admission.runId !== provenance.runId ||
          admission.processId !== provenance.processId ||
          admission.version !== provenance.version ||
          admission.artifactDigest !== provenance.artifactDigest ||
          (provenance.commandId !== undefined &&
            admission.commandId !== provenance.commandId) ||
          (provenance.admissionId !== undefined &&
            admission.receiptId !== provenance.admissionId))) ||
      (result.process &&
        (result.process.parentRunId !== command.workItemId ||
          result.process.runId !== admission.runId ||
          result.process.processId !== admission.processId ||
          result.process.version !== admission.version))
    )
      throw new Error("process_parent_mismatch");
    if (!this.currentFlight(flight) || flight.outcomeKnown) return;
    const persistence = this.finishCommand(flight, {
      store: { ...this.state.store!, stale: true },
      commandStates: {
        ...this.state.commandStates,
        [commandTarget(command)]: "accepted",
      },
      // An accepted answer is not a claim that the native process succeeded.
      error: result.process?.failure?.code || null,
      processNotice: this.runtimeNotice(flight, result),
    });
    return persistence;
  }
  private confirmProcessExecution(
    flight: CommandFlight,
    result: ProcessRuntimeResponse,
  ) {
    const pending = flight.processPending;
    if (!isProcessExecutionCommand(flight.command) || !pending)
      throw Error("process_command_changed");
    assertProcessCommandResponse(
      flight.command,
      pending.target,
      result,
      pending.executionProfile,
    );
    if (!this.currentFlight(flight) || flight.outcomeKnown) return;
    return this.finishProcessExecution(flight, {
      store: { ...this.state.store!, stale: true },
      commandStates: {
        ...this.state.commandStates,
        [commandTarget(flight.command)]:
          result.admission.status === "rejected" ? "rejected" : "accepted",
      },
      error:
        result.admission.status === "rejected"
          ? result.admission.reason
          : result.process?.failure?.code || null,
      processNotice: this.runtimeNotice(flight, result),
    });
  }
  private async finishProcessExecution(
    flight: CommandFlight,
    update: Partial<SessionState>,
  ) {
    if (!this.currentFlight(flight) || flight.outcomeKnown) return;
    if (!flight.processPending) throw Error("process_command_changed");
    const pending = this.parseProcessPending({
      ...flight.processPending,
      outcome:
        update.commandStates?.[commandTarget(flight.command)] === "rejected"
          ? "rejected"
          : "accepted",
      error: update.error ?? null,
      ...(update.processNotice ? { notice: update.processNotice.notice } : {}),
    });
    flight.outcomeKnown = true;
    this.commandRejection = update.error ?? null;
    flight.processPending = pending;
    this.pendingProcess = pending;
    // A known outcome becomes durable before cleanup; failed persistence retries
    // local storage only, never the acknowledged command transport.
    const persistence = this.persistProcessPending(pending).then(() =>
      this.clearKnownProcessPending(flight, update.store),
    );
    const localPersistence = persistence.catch(() => {
      if (this.commandFlight === flight) this.storageError();
    });
    flight.localPersistence = localPersistence;
    void localPersistence.finally(() => {
      if (flight.localPersistence === localPersistence)
        flight.localPersistence = undefined;
    });
    this.publish(update);
    return persistence;
  }
  private async finishProcessAnswer(
    flight: CommandFlight,
    update: Partial<SessionState>,
  ) {
    if (!this.currentFlight(flight) || flight.outcomeKnown) return;
    const outcome =
      update.commandStates?.[commandTarget(flight.command)] === "rejected"
        ? "rejected"
        : "accepted";
    const answerAttempts = this.updatedAnswerAttempts(
      flight.command.commandId,
      outcome,
      update.error ?? null,
    );
    flight.outcomeKnown = true;
    this.commandRejection = update.error ?? null;
    this.answerPendingId = null;
    this.publish({ answerAttempts });
    this.publish(update);
    await this.persistAnswerAttempts();
    return this.clearKnownProcessPending(flight, update.store);
  }
  private async clearKnownProcessPending(
    flight: CommandFlight,
    store = this.state.store,
  ) {
    if (!this.currentFlight(flight)) return Promise.resolve();
    const snapshot = store ? JSON.stringify(toSnapshot(store)) : null;
    const persistence = this.write(async () => {
      try {
        if (snapshot) await this.storage.setItem(this.cacheKey, snapshot);
      } finally {
        await this.storage.setItem(this.pendingKey, "null");
      }
    });
    void persistence.catch(() => {
      if (this.commandFlight === flight && !this.stopped && !this.invalid)
        this.storageError();
    });
    // The known marker is already durable. Keep start/resolve pending until its
    // cleanup succeeds so Retry remains an explicit local persistence action.
    if (isProcessExecutionCommand(flight.command)) await persistence;
    if (this.currentFlight(flight)) {
      if (this.submitting === flight) this.submitting = null;
      if (isProcessExecutionCommand(flight.command)) this.pendingProcess = null;
      this.publish({
        pending: null,
        commandConversationId: undefined,
        activity: null,
        activitySteps: null,
        activityApproval: null,
        processNotice: this.retainedRuntimeNotice(flight),
        ...(isProcessExecutionCommand(flight.command)
          ? {
              error: this.commandRejection,
            }
          : {}),
        ...this.consumedDeliveryErrorUpdate(
          flight.command.commandId,
          true,
          flight,
        ),
      });
      flight.stopActivity();
      if (flight.command.type !== "process.answer") flight.controller.abort();
      flight.markReady();
      flight.retire();
      // Delivery acceptance needs a fresh projection; it proves no business effect.
      if (store?.stale) void this.refresh();
    }
    return persistence;
  }
  private finishCommand(
    flight: CommandFlight,
    update: Partial<SessionState>,
    alreadyConfirmed = false,
  ) {
    if (
      !this.currentFlight(flight) ||
      (flight.outcomeKnown && !alreadyConfirmed)
    )
      return;
    if (flight.command.type === "process.answer")
      return this.finishProcessAnswer(flight, update);
    const snapshot = update.store
      ? JSON.stringify(toSnapshot(update.store))
      : null;
    flight.outcomeKnown = true;
    this.commandRejection = update.error ?? null;
    if (this.submitting === flight) this.submitting = null;
    // Queue C's cache/clear before publishing. A listener may immediately send D,
    // whose persisted command must never be erased by C's slower cache write.
    const persistence = this.write(async () => {
      try {
        if (snapshot) await this.storage.setItem(this.cacheKey, snapshot);
      } finally {
        await this.storage.setItem(this.pendingKey, "null");
      }
    });
    void persistence.catch(() => {
      if (!this.stopped && !this.invalid && this.commandFlight === flight) {
        if (flight.command.type === "process.answer")
          this.commandRejection ??= "storage_error";
        this.publish({
          error:
            flight.command.type === "process.answer"
              ? (this.commandRejection ?? "storage_error")
              : "storage_error",
        });
      }
    });
    // The acknowledged result is the fallback for json(), which discards an
    // aborted response. Publish it before aborting the original transport.
    this.publish({
      ...update,
      pending: null,
      // The command's own error stays with its chat; a later error that no
      // command caused belongs to every chat.
      ...(update.error ? {} : { commandConversationId: undefined }),
      activity: null,
      activitySteps: null,
      activityApproval: null,
    });
    flight.stopActivity();
    flight.controller.abort();
    flight.markReady();
    flight.retire();
    return persistence;
  }
  private releaseUnsubmittedAttachments(command: SessionCommand) {
    if (command.type !== "message.send" || !command.attachments) return;
    const draftId = command.attachments.draftId;
    for (const owned of [this.state.pending, this.submitting?.command])
      if (
        owned?.type === "message.send" &&
        owned.attachments?.draftId === draftId
      )
        return;
    this.attachments.settleSend(command.attachments, "rejected");
  }
  async send(
    raw: SessionCommand,
    retry = false,
    processTarget?: ProcessCommandTarget,
    noticeOwner?: ProcessNoticeOwner,
  ): Promise<void> {
    // Own a parsed immutable process copy: caller edits cannot change a persisted flight.
    const command = isProcessRuntimeCommand(raw)
      ? parseSessionCommand(raw)
      : raw.type === "message.send" && raw.attachments
        ? immutableJson(CommandSchema.parse(raw))
        : raw;
    if (!isProcessRuntimeCommand(command)) CommandSchema.parse(command);
    if (
      this.submitting ||
      this.stopped ||
      this.invalid ||
      !this.state.store ||
      this.state.status !== "online"
    ) {
      this.releaseUnsubmittedAttachments(command);
      return;
    }
    if (this.answerStorageBlocked || this.outboxStorageBlocked) {
      this.releaseUnsubmittedAttachments(command);
      this.storageError();
      return;
    }
    if (
      this.state.pending &&
      (!retry || JSON.stringify(command) !== JSON.stringify(this.state.pending))
    ) {
      this.releaseUnsubmittedAttachments(command);
      return;
    }
    let answerTarget: ProcessAnswerTarget | undefined;
    if (isProcessExecutionCommand(command)) {
      if (!this.options.processExecution && !this.options.processQuestions)
        throw Error("process_profile_unsupported");
      if (retry && this.state.pending) {
        if (!this.pendingProcess) throw Error("process_command_changed");
        validateProcessCommandTarget(
          command,
          this.pendingProcess.target,
          this.address,
          this.credential.scope,
        );
        if (
          processTarget &&
          JSON.stringify(ProcessCommandTargetSchema.parse(processTarget)) !==
            JSON.stringify(this.pendingProcess.target)
        )
          throw Error("process_command_changed");
        if (this.pendingProcess.outcome !== "unknown")
          return this.retry(noticeOwner);
      } else {
        if (!processTarget) throw Error("process_command_changed");
        const frozenTarget = immutableJson(
          ProcessCommandTargetSchema.parse(processTarget),
        );
        validateProcessCommandTarget(
          command,
          frozenTarget,
          this.address,
          this.credential.scope,
        );
        assertProcessCommandTarget(this.state.store, frozenTarget);
        this.pendingProcess = this.parseProcessPending({
          profile: "agent-client.process-command/1",
          command,
          serializedCommand: JSON.stringify(command),
          target: frozenTarget,
          executionProfile: this.options.processQuestions
            ? PROCESS_QUESTION_EXECUTION_PROFILE
            : PROCESS_EXECUTION_PROFILE,
          outcome: "unknown",
          error: null,
        });
      }
    } else this.pendingProcess = null;
    if (command.type === "process.answer") {
      if (!this.options.processQuestions)
        throw new Error("process_profile_unsupported");
      const attempt = this.state.answerAttempts.find(
        (value) => value.command.commandId === command.commandId,
      );
      if (
        attempt &&
        (JSON.stringify(attempt.command) !== JSON.stringify(command) ||
          attempt.outcome !== "unknown")
      )
        throw Error("process_answer_attempt_changed");
      // Only an exact pending retry bypasses the live target: A may already be
      // consumed while B is projected, but this cannot mint an answer to B.
      if (!retry || !this.state.pending) {
        const target = captureProcessAnswerTarget(
          this.state.store,
          command.workItemId,
          command.conversationId,
        );
        if (
          target.connectionKey !== this.address ||
          !sameScope(target.scope, this.credential.scope) ||
          (attempt &&
            JSON.stringify(attempt.target) !== JSON.stringify(target)) ||
          JSON.stringify(
            processAnswerCommand(this.state.store, target, command),
          ) !== JSON.stringify(command)
        )
          throw new Error("process_question_changed");
        answerTarget = target;
      }
      if (
        !attempt &&
        answerTarget &&
        this.state.answerAttempts.length >= PROCESS_ANSWER_ATTEMPTS_LIMIT
      )
        throw Error("process_answer_attempts_full");
    }
    const target = commandTarget(command);
    const flight = this.createFlight(
      command,
      retry && !!this.state.pending,
      this.noticeOwner(command, noticeOwner),
    );
    this.commandFlight = flight;
    this.submitting = flight;
    this.commandRejection = null;
    this.publish({
      pending: command,
      commandConversationId: command.conversationId,
      commandStates: { ...this.state.commandStates, [target]: "sending" },
      error: null,
      processNotice: null,
      activity: null,
      activitySteps: null,
      activityApproval: null,
      activityConnection: "waiting",
    });
    let persisted = false;
    let answerPersisted = false;
    let executionExplanationWriteFailed = false;
    try {
      // Persist the exact command before sending; reopening never automatically retries it.
      if (command.type === "process.answer" && answerTarget) {
        const attempt = immutableProcessAnswerAttempt({
          target: answerTarget,
          command,
          outcome: "unknown",
          error: null,
        });
        this.publish({
          answerAttempts: [
            ...this.state.answerAttempts.filter(
              (value) => value.command.commandId !== command.commandId,
            ),
            attempt,
          ],
        });
        this.answerPendingId = command.commandId;
        await this.persistAnswerAttempts();
        answerPersisted = true;
      } else if (
        command.type === "process.answer" &&
        this.answerEnvelopePresent
      ) {
        this.answerPendingId = command.commandId;
        await this.persistAnswerAttempts();
        answerPersisted = true;
      }
      if (flight.processPending)
        await this.persistProcessPending(flight.processPending);
      else
        await this.write(() =>
          this.storage.setItem(this.pendingKey, flight.serializedCommand),
        );
      persisted = true;
      if (!this.currentFlight(flight)) return;
      flight.deliveryStarted = true;
      flight.markReady();
      const streaming =
        !!this.options.stream &&
        (command.type === "message.send" || command.type === "service.resolve");
      if (!streaming && command.type === "message.send")
        flight.stopActivity = this.watchActivity(command);
      const path = isProcessRuntimeCommand(command)
        ? `processes/commands?profile=${encodeURIComponent(flight.processPending?.executionProfile ?? PROCESS_QUESTION_EXECUTION_PROFILE)}`
        : replyCorrelationPath("commands");
      const init = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: flight.serializedCommand,
        signal: flight.controller.signal,
      };
      const delivery = await Promise.race([
        (streaming &&
        (command.type === "message.send" || command.type === "service.resolve")
          ? this.streamAnswer(path, init, command, () => {
              if (command.type === "message.send")
                flight.stopActivity = this.watchActivity(command);
            })
          : this.json(path, init, 115000)
        ).then((result) => ({ ...result, retired: false as const })),
        flight.retired.then(() => ({ retired: true as const })),
      ]);
      if (delivery.retired || !this.currentFlight(flight)) return;
      const { response, value } = delivery;
      if (isProcessExecutionCommand(command)) {
        const runtime = ProcessRuntimeResponseSchema.safeParse(value);
        if (
          runtime.success &&
          (response.ok ||
            (response.status === 422 &&
              runtime.data.admission.status === "rejected"))
        ) {
          await this.confirmProcessExecution(flight, runtime.data);
          return;
        }
        if (
          !response.ok &&
          response.status === 409 &&
          ProcessExecutionConflictSchema.safeParse(value).success
        ) {
          try {
            await this.retainProcessExecutionConflict(flight);
          } catch {
            executionExplanationWriteFailed = true;
          }
          if (!this.currentFlight(flight) || flight.outcomeKnown) return;
        }
        // Uncorrelated error JSON does not prove whether an admission/effect
        // already happened. Only the frozen runtime receipt settles this owner.
        throw Error("network_error");
      }
      if (command.type === "process.answer") {
        if (!response.ok) {
          const code =
            value &&
            typeof value === "object" &&
            "error" in value &&
            typeof value.error === "string" &&
            /^[a-z][a-z0-9_]{0,159}$/.test(value.error)
              ? value.error
              : null;
          if (
            [400, 404, 406, 409, 422, 429].includes(response.status) &&
            code?.startsWith("process_")
          ) {
            await this.finishCommand(flight, {
              error: code,
              commandStates: {
                ...this.state.commandStates,
                [target]: "rejected",
              },
            });
            return;
          }
          throw new Error(code ?? "network_error");
        }
        await this.confirmProcessAnswer(
          flight,
          ProcessRuntimeResponseSchema.parse(value),
        );
        return;
      }
      if (
        [400, 404, 409, 422, 429].includes(response.status) &&
        value &&
        typeof value === "object" &&
        "error" in value &&
        typeof value.error === "string" &&
        value.error.startsWith("catalog_")
      ) {
        await this.finishCommand(flight, {
          error: value.error,
          commandStates: { ...this.state.commandStates, [target]: "rejected" },
        });
        return;
      }
      if (
        response.status === 503 &&
        value &&
        typeof value === "object" &&
        "error" in value &&
        [
          "model_unavailable",
          "model_timeout",
          "model_invalid_response",
          "model_busy",
          "model_limit",
          "model_expired",
        ].includes(String(value.error))
      )
        throw new Error(String(value.error));
      await this.confirmCommand(flight, CommandResultSchema.parse(value));
    } catch (error) {
      if (this.stopped || this.invalid || this.commandFlight !== flight) return;
      if (flight.outcomeKnown) {
        if (isProcessRuntimeCommand(command))
          this.commandRejection ??= "storage_error";
        this.publish({
          ...(this.state.pending?.commandId === command.commandId
            ? { pending: command }
            : {}),
          processNotice: this.localNotice("storage_error"),
          error: isProcessRuntimeCommand(command)
            ? (this.commandRejection ?? "storage_error")
            : "storage_error",
        });
      } else if (this.currentFlight(flight)) {
        const processError =
          isProcessRuntimeCommand(command) &&
          error instanceof Error &&
          /^[a-z][a-z0-9_]{0,159}$/.test(error.message) &&
          /^(?:process_|model_|inference_|catalog_)/.test(error.message)
            ? error.message
            : null;
        const deliveryError = flight.interruptionFailed
          ? "requestInterruptFailed"
          : executionExplanationWriteFailed
            ? "storage_error"
            : processError;
        if (isProcessRuntimeCommand(command))
          this.commandRejection = !persisted
            ? "storage_error"
            : flight.deliveryStarted
              ? (deliveryError ?? "network_error")
              : "storage_error";
        const retainedAnswer =
          command.type === "process.answer" &&
          answerPersisted &&
          this.answerPendingId === command.commandId;
        const pendingRetained =
          flight.deliveryStarted ||
          retainedAnswer ||
          (isProcessExecutionCommand(command) && !!flight.processPending);
        if (!pendingRetained && isProcessExecutionCommand(command))
          this.pendingProcess = null;
        this.publish({
          pending: pendingRetained ? command : null,
          commandStates: {
            ...this.state.commandStates,
            [target]: pendingRetained ? "network_error" : "idle",
          },
          error: !persisted
            ? "storage_error"
            : flight.deliveryStarted
              ? flight.interruptionFailed
                ? "requestInterruptFailed"
                : executionExplanationWriteFailed
                  ? "storage_error"
                  : (processError ??
                    (error instanceof Error &&
                    [
                      "model_unavailable",
                      "model_timeout",
                      "model_invalid_response",
                      "model_busy",
                      "model_limit",
                      "model_expired",
                    ].includes(error.message)
                      ? error.message
                      : "network_error"))
              : "storage_error",
          activityConnection: "unavailable",
        });
        if (command.type === "process.answer") {
          if (!answerPersisted && !flight.deliveryStarted) {
            this.answerPendingId = null;
            this.publish({
              answerAttempts: this.state.answerAttempts.filter(
                (attempt) => attempt.command.commandId !== command.commandId,
              ),
            });
          } else
            this.updateAnswerAttempt(
              command.commandId,
              "unknown",
              this.state.error,
            );
          if (answerPersisted || flight.deliveryStarted)
            await this.persistAnswerAttempts().catch(() => this.storageError());
        }
      }
    } finally {
      // A positively unattempted command has no server outcome to recover.
      // Keep uncertain dispatched commands frozen under the existing outbox.
      if (
        !flight.deliveryStarted &&
        this.state.pending?.commandId !== command.commandId &&
        command.type === "message.send" &&
        command.attachments
      )
        this.attachments.settleSend(command.attachments, "rejected");
      flight.stopActivity();
      flight.markReady();
      if (this.submitting === flight) this.submitting = null;
    }
  }
  /** Microphone capture may proceed; sending waits for a confirmed server outcome. */
  interruptPending(): Promise<boolean> {
    if (
      this.stopped ||
      this.invalid ||
      this.answerStorageBlocked ||
      this.outboxStorageBlocked ||
      this.state.status !== "online"
    )
      return Promise.resolve(false);
    const command = this.state.pending;
    if (!command) return Promise.resolve(!this.submitting);
    if (command.type === "process.answer" && !this.options.processQuestions)
      return Promise.resolve(false);
    if (
      isProcessExecutionCommand(command) &&
      ((!this.options.processExecution && !this.options.processQuestions) ||
        !this.pendingProcess)
    )
      return Promise.resolve(false);
    if (this.pendingProcess?.outcome !== "unknown" && this.pendingProcess)
      return this.retry().then(() => !this.state.pending);
    const flight = this.commandFlight ?? this.createFlight(command, true);
    this.commandFlight = flight;
    if (flight.deliveryStarted) flight.markReady();
    if (flight.interruption) return flight.interruption;
    const interruption = (async () => {
      await flight.ready;
      if (flight.outcomeKnown)
        return !this.stopped && !this.invalid && !this.state.pending;
      if (!this.currentFlight(flight))
        return (
          !this.stopped &&
          !this.invalid &&
          !this.state.pending &&
          !this.submitting
        );
      const process = isProcessRuntimeCommand(flight.command);
      const executionProfile =
        flight.processPending?.executionProfile ??
        PROCESS_QUESTION_EXECUTION_PROFILE;
      const request = this.json(
        process
          ? `processes/commands/interrupt?profile=${encodeURIComponent(executionProfile)}`
          : replyCorrelationPath("commands/interrupt"),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            process
              ? ProcessRuntimeInterruptRequestSchema.parse({
                  profile: executionProfile,
                  command: flight.command,
                })
              : RequestInterruptionRequestSchema.parse({
                  profile: REQUEST_INTERRUPTION_PROFILE,
                  command: flight.command,
                }),
          ),
        },
      )
        .then(async ({ response, value }) => {
          if (flight.outcomeKnown)
            return !this.stopped && !this.invalid && !this.state.pending;
          if (!this.currentFlight(flight)) return false;
          if (!response.ok) throw new Error("requestInterruptFailed");
          const result = process
            ? ProcessRuntimeInterruptResponseSchema.parse(value)
            : RequestInterruptionResponseSchema.parse(value);
          if (
            result.commandId !== flight.command.commandId ||
            !sameScope(result.scope, this.credential.scope) ||
            (process && result.profile !== executionProfile)
          )
            throw new Error("interruption_mismatch");
          if (result.status !== "settled")
            throw new Error("requestInterruptFailed");
          if (isProcessExecutionCommand(flight.command))
            await this.confirmProcessExecution(
              flight,
              ProcessRuntimeResponseSchema.parse(result.result),
            );
          else if (flight.command.type === "process.answer")
            await this.confirmProcessAnswer(
              flight,
              ProcessRuntimeResponseSchema.parse(result.result),
            );
          else
            await this.confirmCommand(
              flight,
              CommandResultSchema.parse(result.result),
            );
          // A validated settled interruption proves the native owner retired.
          // Unlike passive answer consumption, it can cancel the old delivery.
          flight.controller.abort();
          return flight.outcomeKnown && !this.state.pending;
        })
        .catch(() => {
          if (flight.outcomeKnown)
            return !this.stopped && !this.invalid && !this.state.pending;
          if (this.currentFlight(flight)) {
            flight.interruptionFailed = true;
            this.commandRejection = "requestInterruptFailed";
            this.publish({ error: "requestInterruptFailed" });
          }
          return false;
        });
      // A confirmed original response also retires this barrier if the ACK is lost.
      return Promise.race([
        request,
        flight.retired.then(
          () => flight.outcomeKnown && !this.stopped && !this.invalid,
        ),
      ]);
    })();
    flight.interruption = interruption;
    void interruption.finally(() => {
      if (flight.interruption === interruption) flight.interruption = undefined;
    });
    return interruption;
  }
  /** Informational polling cannot send/retry a command or overwrite its outcome. */
  private watchActivity(command: Extract<Command, { type: "message.send" }>) {
    let active = true;
    // While the answer is being written, its draft is read twice as often.
    let drafting = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const current = () =>
      active &&
      !this.stopped &&
      !this.invalid &&
      this.state.pending === command &&
      this.state.commandStates[commandTarget(command)] === "sending";
    const poll = async () => {
      if (!current()) return;
      try {
        const { response, value } = await this.json(
          `activity?commandId=${encodeURIComponent(command.commandId)}&profile=${encodeURIComponent(ACTIVITY_PROFILE)}`,
          { signal: controller.signal },
          2500,
        );
        if (!current()) return;
        if (!response.ok) throw new Error("activity_unavailable");
        const result = ActivityResponseSchema.parse(value);
        if (
          !sameScope(result.scope, this.credential.scope) ||
          result.commandId !== command.commandId ||
          (result.activity &&
            result.activity.conversationId !== command.conversationId)
        )
          throw new Error("activity_mismatch");
        drafting =
          !!result.activity &&
          "draft" in result.activity &&
          !!result.activity.draft;
        this.publish({
          activity: result.activity,
          activityConnection: result.activity ? "live" : "waiting",
        });
      } catch {
        drafting = false;
        if (current()) this.publish({ activityConnection: "unavailable" });
      } finally {
        if (current())
          timer = setTimeout(
            () => {
              void poll();
            },
            drafting ? 250 : 500,
          );
      }
    };
    timer = setTimeout(() => {
      void poll();
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }
  retry(noticeOwner?: ProcessNoticeOwner): Promise<void> {
    if (this.answerStorageBlocked || this.outboxStorageBlocked)
      return Promise.resolve();
    const pending = this.state.pending;
    if (
      pending &&
      this.pendingProcess &&
      this.pendingProcess.outcome !== "unknown" &&
      !this.stopped &&
      !this.invalid
    ) {
      const flight = this.commandFlight ?? this.createFlight(pending, true);
      this.commandFlight = flight;
      flight.noticeOwner = this.noticeOwner(pending, noticeOwner);
      if (this.pendingProcess.notice)
        this.publish({
          processNotice: Object.freeze({
            notice: this.pendingProcess.notice,
            owner: flight.noticeOwner ?? null,
            errorSource:
              this.state.processNotice?.errorSource ??
              Object.freeze({ kind: "runtime" as const }),
          }),
        });
      if (flight.localPersistence) return flight.localPersistence;
      flight.outcomeKnown = true;
      this.commandRejection = this.pendingProcess.error;
      const persistence = this.persistProcessPending(this.pendingProcess)
        .then(() => this.clearKnownProcessPending(flight))
        .catch(() => this.storageError());
      flight.localPersistence = persistence;
      void persistence.finally(() => {
        if (flight.localPersistence === persistence)
          flight.localPersistence = undefined;
      });
      return persistence;
    }
    const known =
      pending?.type === "process.answer" &&
      this.state.answerAttempts.find(
        (attempt) =>
          attempt.command.commandId === pending.commandId &&
          attempt.outcome !== "unknown",
      );
    if (known && !this.stopped && !this.invalid) {
      const flight = this.commandFlight ?? this.createFlight(pending!, true);
      this.commandFlight = flight;
      flight.noticeOwner = this.noticeOwner(pending!, noticeOwner);
      if (this.state.processNotice?.notice.commandId === pending!.commandId)
        this.publish({
          processNotice: Object.freeze({
            notice: this.state.processNotice.notice,
            owner: flight.noticeOwner ?? null,
            errorSource: this.state.processNotice.errorSource,
          }),
        });
      flight.outcomeKnown = true;
      this.answerPendingId = null;
      return this.persistAnswerAttempts()
        .then(() => this.clearKnownProcessPending(flight))
        .catch(() => this.storageError());
    }
    return this.state.pending
      ? this.send(this.state.pending, true, undefined, noticeOwner)
      : Promise.resolve();
  }
}
