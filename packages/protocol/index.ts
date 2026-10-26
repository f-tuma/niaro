import { z } from "zod";
import { MessageMentionSchema } from "./mentions";
import { PassiveCardDocumentSchema, CardResultSchema } from "./card-document";
import { ServiceResultSchema } from "./service-result";
import { ServiceConnectionCardSchema } from "./service-oauth";
import { ProcessWorkSchema } from "./process-work";
import { ProcessOfferResultSchema } from "./process-offer";
import { SkillProposalResultSchema } from "./skills";
import { ProcessProposalResultSchema } from "./process-proposal";
import { GeneratedUiSchema } from "./generative-ui";

export const PROFILE = "agent-client/0.8-fixture" as const;
const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9._:-]+$/);
const text = z.string().min(1).max(4000);
const revision = z.number().int().positive();
const sequence = z.number().int().nonnegative();
export const LanguageSchema = z.enum(["en", "cs"]);
export type Language = z.infer<typeof LanguageSchema>;
export const ScopeSchema = z.strictObject({
  connectionId: id,
  serverId: id,
  userId: id,
  workspaceId: id,
});
export type Scope = z.infer<typeof ScopeSchema>;
export const sameScope = (a: Scope, b: Scope) =>
  a.connectionId === b.connectionId &&
  a.serverId === b.serverId &&
  a.userId === b.userId &&
  a.workspaceId === b.workspaceId;
const base = { id, revision };
export const CrmContactSchema = z.strictObject({
  id,
  name: z.string().trim().min(1).max(160),
  jobTitle: z.string().trim().min(1).max(160).optional(),
  email: z.email().max(254).optional(),
  phone: z
    .string()
    .max(64)
    .regex(/^\+?[0-9][0-9 ().-]{2,62}$/)
    .optional(),
});
export type CrmContact = z.infer<typeof CrmContactSchema>;
export const CrmContactResultSchema = z
  .strictObject({
    type: z.literal("crm.contacts"),
    version: z.literal(1),
    source: z.literal("twenty"),
    contacts: z.array(CrmContactSchema).max(5),
    hasMore: z.boolean(),
  })
  .refine(
    (value) =>
      new Set(value.contacts.map((c) => c.id)).size === value.contacts.length,
    "Contact IDs must be unique within a result",
  );
export type CrmContactResult = z.infer<typeof CrmContactResultSchema>;
export const MessageResultSchema = z.union([
  CrmContactResultSchema,
  ServiceResultSchema,
  ServiceConnectionCardSchema,
  CardResultSchema,
  ProcessOfferResultSchema,
  SkillProposalResultSchema,
  ProcessProposalResultSchema,
]);
/** The open item a message is about. The title is the sender's display copy;
 * the server reads the item itself by its id. */
export const HumanTaskReferenceSchema = z.strictObject({
  id,
  title: z.string().trim().min(1).max(1000),
});
export type HumanTaskReference = z.infer<typeof HumanTaskReferenceSchema>;
export const MessageSchema = z
  .strictObject({
    id,
    role: z.enum(["user", "assistant"]),
    text,
    /** Stable identity across an explicitly retried logical chat message. */
    logicalMessageId: id.optional(),
    replyToCommandId: id.optional(),
    workItemId: id.optional(),
    inputRequestId: id.optional(),
    result: MessageResultSchema.optional(),
    /** Generated UI beside the text. Delivered only to clients that ask for
     * GENERATIVE_UI_PROFILE; the text stays a complete answer without it. */
    ui: GeneratedUiSchema.optional(),
    humanTask: HumanTaskReferenceSchema.optional(),
    /** When the server stored the message. Delivered only to clients that ask
     * for MESSAGE_TIME_PROFILE; messages stored before it carry none. */
    createdAt: z.iso.datetime().optional(),
  })
  .refine(
    (message) => !message.replyToCommandId || message.role === "assistant",
    "Only assistant replies can reference a command",
  )
  .refine(
    (message) =>
      !message.result ||
      (message.role === "assistant" &&
        !message.workItemId &&
        !message.inputRequestId),
    "A contact result is a passive assistant message, not work or input",
  )
  .refine(
    (message) => !message.humanTask || message.role === "user",
    "Only the person's message can bring an open item",
  )
  .refine(
    (message) => !message.ui || message.role === "assistant",
    "Only an assistant answer carries generated UI",
  );
export const ConversationSchema = z.strictObject({
  ...base,
  messages: z.array(MessageSchema).max(500),
});
export type Conversation = z.infer<typeof ConversationSchema>;
/** Public conversation history contains only the existing client projection. */
export const CONVERSATION_HISTORY_PROFILE = "agent-conversations/1" as const;
export const CONVERSATION_PROJECTION_PROFILE =
  "agent-conversation-projection/1" as const;
export const ConversationSummarySchema = z.strictObject({
  id,
  revision,
  title: z.string().max(160),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  messageCount: z.number().int().nonnegative(),
  readOnly: z.boolean(),
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;
/**
 * Optional `state` filter of the chat directory (`conversations?state=`):
 * `active` lists chats that can continue, `archived` the read-only archive.
 * Filtered pages run newest first (by last change). Without it a page lists
 * every chat oldest first, as before.
 */
/** A hub item's chat (`chat-hub-…`) is where its runs report: it is never
 * archived. Every other chat can be. */
export const archivableConversation = (id: string) =>
  !id.startsWith("chat-hub-");
export const ConversationListStateSchema = z.enum(["active", "archived"]);
export type ConversationListState = z.infer<typeof ConversationListStateSchema>;
export const ConversationHistoryPageSchema = z.strictObject({
  profile: z.literal(CONVERSATION_HISTORY_PROFILE),
  scope: ScopeSchema,
  conversations: z.array(ConversationSummarySchema).max(40),
  nextAfter: z.string().max(160).nullable(),
});
export const ConversationMessagePageSchema = z.strictObject({
  profile: z.literal(CONVERSATION_HISTORY_PROFILE),
  scope: ScopeSchema,
  conversation: ConversationSummarySchema,
  messages: z.array(MessageSchema).max(40),
  nextAfter: z.string().max(160).nullable(),
});
export type ConversationHistoryPage = z.infer<
  typeof ConversationHistoryPageSchema
>;
export type ConversationMessagePage = z.infer<
  typeof ConversationMessagePageSchema
>;
export const WorkStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_input",
  "waiting_approval",
  "waiting_system",
  "scheduled",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  "superseded",
]);
/** A server projection of a native run, never a second workflow engine. */
export const NativeQuestionSchema = z.strictObject({
  runtime: z.literal("mastra"),
  id,
  revision,
  workItemId: id,
  conversationId: id,
  question: text,
  status: z.literal("open"),
  /** Likely answers the person can pick; a typed answer stays possible.
   * Delivered only to clients that ask for QUESTION_OPTIONS_PROFILE. */
  options: z.array(z.string().trim().min(1).max(80)).min(2).max(6).optional(),
  /** Several options may be picked; they are sent joined in one answer. */
  multiple: z.literal(true).optional(),
});
export type NativeQuestion = z.infer<typeof NativeQuestionSchema>;
export type ReplyInput = InputRequest | z.infer<typeof NativeQuestionSchema>;
export const WorkItemSchema = z
  .strictObject({
    ...base,
    conversationId: id,
    title: text,
    context: text,
    card: PassiveCardDocumentSchema.optional(),
    status: WorkStatusSchema,
    inputRequestIds: z.array(id).max(20),
    actionProposalIds: z.array(id).max(20),
    operationIds: z.array(id).max(100),
    demo: z.boolean(),
    native: z
      .strictObject({
        runId: id,
        revision,
        /** Public command that created this run; a lookup hint for the scoped client outbox. */
        sourceCommandId: id.optional(),
        question: NativeQuestionSchema.optional(),
        action: ServiceResultSchema.optional(),
        process: ProcessWorkSchema.optional(),
      })
      .optional(),
    result: text.optional(),
    presentation: z.strictObject({
      type: z.literal("workflow.progress"),
      version: z.literal(1),
      variant: z.literal("default"),
    }),
  })
  .superRefine((work, ctx) => {
    const output = work.native?.process?.output;
    if (
      output &&
      (work.status !== "succeeded" ||
        output.parentRunId !== work.id ||
        output.nativeRevision !== work.native?.revision)
    )
      ctx.addIssue({
        code: "custom",
        message: "Invalid process output binding",
      });
    if (
      (!work.demo && !work.native) ||
      (work.native &&
        (work.demo ||
          work.native.runId !== work.id ||
          work.native.revision > work.revision ||
          work.inputRequestIds.length ||
          work.actionProposalIds.length ||
          work.operationIds.length ||
          (work.native.process &&
            (work.native.question ||
              work.native.action ||
              work.native.process.provenance.conversationId !==
                work.conversationId)) ||
          (work.native.question &&
            (work.status !== "waiting_input" ||
              work.native.question.workItemId !== work.id ||
              work.native.question.conversationId !== work.conversationId))))
    )
      ctx.addIssue({ code: "custom", message: "Invalid native work binding" });
  });
export type WorkItem = z.infer<typeof WorkItemSchema>;
export const InputRequestSchema = z
  .strictObject({
    ...base,
    workItemId: id,
    conversationId: id,
    question: text,
    status: z.enum(["open", "resolved", "cancelled", "expired", "superseded"]),
    options: z
      .array(z.strictObject({ id, label: text, detail: text }))
      .min(2)
      .max(20),
    presentation: z.strictObject({
      type: z.literal("input.choice"),
      version: z.literal(1),
      variant: z.literal("contacts"),
    }),
    resolution: z
      .strictObject({
        selectedContactId: id,
        source: z.enum(["card", "chat"]),
        reason: text,
      })
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (
      v.status === "resolved" &&
      (!v.resolution ||
        !v.options.some((o) => o.id === v.resolution?.selectedContactId))
    )
      ctx.addIssue({
        code: "custom",
        message: "A resolved input needs a valid resolution",
      });
  });
export type InputRequest = z.infer<typeof InputRequestSchema>;
export const CalendarTargetSchema = z.strictObject({
  integrationId: id,
  label: z.string().min(1).max(120),
  collectionUrl: z.url().max(2048),
  provider: z.literal("caldav"),
  invitations: z.literal("none"),
});
export type CalendarTarget = z.infer<typeof CalendarTargetSchema>;
export const CalendarErrorSchema = z.enum([
  "unavailable",
  "authorization",
  "remote_conflict",
  "invalid_response",
  "configuration_changed",
  "retry_exhausted",
]);
export const MeetingParametersSchema = z
  .strictObject({
    title: text,
    participant: z.strictObject({ id, label: text, email: z.email().max(254) }),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    timeZone: z.literal("UTC"),
    calendar: CalendarTargetSchema.optional(),
  })
  .refine(
    (p) => Date.parse(p.endsAt) > Date.parse(p.startsAt),
    "Meeting end must follow start",
  );
export type MeetingParameters = z.infer<typeof MeetingParametersSchema>;
export const ActionProposalSchema = z
  .strictObject({
    ...base,
    workItemId: id,
    conversationId: id,
    operationType: z.literal("calendar.create"),
    status: z.enum(["awaiting_approval", "approved", "rejected"]),
    parameters: MeetingParametersSchema,
    approval: z
      .strictObject({
        proposalRevision: revision,
        commandId: id,
        operationId: id,
      })
      .optional(),
    demo: z.literal(true),
    presentation: z.strictObject({
      type: z.literal("action.approval"),
      version: z.literal(1),
      variant: z.literal("meeting"),
    }),
  })
  .superRefine((p, ctx) => {
    if (
      (p.status === "approved") !== !!p.approval ||
      (p.approval && p.approval.proposalRevision >= p.revision)
    )
      ctx.addIssue({
        code: "custom",
        message: "Approval must identify the accepted prior revision",
      });
  });
export type ActionProposal = z.infer<typeof ActionProposalSchema>;
export const OperationSchema = z
  .strictObject({
    ...base,
    workItemId: id,
    conversationId: id,
    proposalId: id,
    acceptedProposalRevision: revision,
    idempotencyKey: id,
    parameters: MeetingParametersSchema,
    status: z.enum([
      "pending",
      "executing",
      "succeeded",
      "failed",
      "cancelled",
      "result_unknown",
    ]),
    result: z
      .discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("simulated"), reference: id }),
        z.strictObject({
          kind: z.literal("calendar"),
          reference: id,
          etag: z.string().min(1).max(256),
          verifiedAt: z.iso.datetime(),
        }),
      ])
      .optional(),
    error: CalendarErrorSchema.optional(),
    demo: z.literal(true),
  })
  .superRefine((op, ctx) => {
    if (
      op.result &&
      (op.result.kind === "calendar") !== !!op.parameters.calendar
    )
      ctx.addIssue({
        code: "custom",
        message: "Result must match approved effect",
      });
    if ((op.status === "succeeded") !== !!op.result)
      ctx.addIssue({
        code: "custom",
        message: "Only verified success carries a result",
      });
  });
export type Operation = z.infer<typeof OperationSchema>;
const envelope = { eventId: id, sequence, scope: ScopeSchema };
export const EventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...envelope,
    type: z.literal("conversation.upserted"),
    entity: ConversationSchema,
  }),
  z.strictObject({
    ...envelope,
    type: z.literal("work_item.upserted"),
    entity: WorkItemSchema,
  }),
  z.strictObject({
    ...envelope,
    type: z.literal("input_request.upserted"),
    entity: InputRequestSchema,
  }),
  z.strictObject({
    ...envelope,
    type: z.literal("action_proposal.upserted"),
    entity: ActionProposalSchema,
  }),
  z.strictObject({
    ...envelope,
    type: z.literal("operation.upserted"),
    entity: OperationSchema,
  }),
]);
export type DomainEvent = z.infer<typeof EventSchema>;
export const SnapshotSchema = z
  .strictObject({
    profile: z.literal(PROFILE),
    scope: ScopeSchema,
    cursor: sequence,
    // Work references (at most 500), selected chat and sole pending command.
    // The complete directory and older messages use the paginated history profile.
    conversations: z.array(ConversationSchema).max(502),
    workItems: z.array(WorkItemSchema).max(500),
    inputRequests: z.array(InputRequestSchema).max(500),
    actionProposals: z.array(ActionProposalSchema).max(500),
    operations: z.array(OperationSchema).max(1000),
  })
  .superRefine((s, ctx) => {
    const unique = (list: { id: string }[]) =>
      new Set(list.map((x) => x.id)).size === list.length;
    if (
      ![
        s.conversations,
        s.workItems,
        s.inputRequests,
        s.actionProposals,
        s.operations,
      ].every(unique)
    )
      ctx.addIssue({ code: "custom", message: "Duplicate entity ID" });
    for (const w of s.workItems)
      if (
        !s.conversations.some((c) => c.id === w.conversationId) ||
        w.inputRequestIds.some(
          (id) =>
            !s.inputRequests.some((i) => i.id === id && i.workItemId === w.id),
        )
      )
        ctx.addIssue({ code: "custom", message: "Invalid work references" });
    for (const i of s.inputRequests)
      if (
        !s.workItems.some(
          (w) =>
            w.id === i.workItemId &&
            w.conversationId === i.conversationId &&
            w.inputRequestIds.includes(i.id),
        )
      )
        ctx.addIssue({ code: "custom", message: "Invalid input references" });
    for (const w of s.workItems) {
      if (
        w.actionProposalIds.some(
          (id) =>
            !s.actionProposals.some(
              (p) => p.id === id && p.workItemId === w.id,
            ),
        ) ||
        w.operationIds.some(
          (id) =>
            !s.operations.some((o) => o.id === id && o.workItemId === w.id),
        )
      )
        ctx.addIssue({ code: "custom", message: "Invalid action references" });
    }
    for (const p of s.actionProposals) {
      if (
        !s.workItems.some(
          (w) =>
            w.id === p.workItemId &&
            w.conversationId === p.conversationId &&
            w.actionProposalIds.includes(p.id),
        )
      )
        ctx.addIssue({
          code: "custom",
          message: "Invalid proposal references",
        });
      if (
        p.approval &&
        !s.operations.some(
          (o) =>
            o.id === p.approval!.operationId &&
            o.status !== "cancelled" &&
            o.proposalId === p.id &&
            o.acceptedProposalRevision === p.approval!.proposalRevision &&
            JSON.stringify(o.parameters) === JSON.stringify(p.parameters),
        )
      )
        ctx.addIssue({
          code: "custom",
          message: "Approval operation mismatch",
        });
    }
    for (const o of s.operations) {
      if (
        o.status !== "cancelled" &&
        !s.actionProposals.some(
          (p) =>
            p.id === o.proposalId &&
            p.status === "approved" &&
            p.approval?.operationId === o.id,
        )
      )
        ctx.addIssue({
          code: "custom",
          message: "Active or completed operation requires matching consent",
        });
      if (
        !s.workItems.some(
          (w) =>
            w.id === o.workItemId &&
            w.conversationId === o.conversationId &&
            w.operationIds.includes(o.id),
        ) ||
        !s.actionProposals.some(
          (p) =>
            p.id === o.proposalId &&
            p.workItemId === o.workItemId &&
            p.conversationId === o.conversationId &&
            p.revision > o.acceptedProposalRevision,
        )
      )
        ctx.addIssue({
          code: "custom",
          message: "Invalid operation references",
        });
    }
  });
export type Snapshot = z.infer<typeof SnapshotSchema>;
const command = { commandId: id, idempotencyKey: id };
export const InputContextSchema = z.strictObject({
  inputRequestId: id,
  workItemId: id,
  expectedInputRevision: revision,
  runtime: z.literal("mastra").optional(),
});
export const ProposalContextSchema = z.strictObject({
  proposalId: id,
  workItemId: id,
  expectedProposalRevision: revision,
});
/** The person's own name for a chat; empty brings back the server's title. */
export const ConversationTitleSchema = z
  .string()
  .max(160)
  .refine((value) => value === value.trim(), "Trim the chat name");
export const CommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...command,
    type: z.literal("conversation.create"),
    conversationId: id.refine((value) => !value.startsWith("archived-")),
  }),
  /** Names a chat for every client of the person. Changes no message. */
  z.strictObject({
    ...command,
    type: z.literal("conversation.rename"),
    conversationId: id,
    title: ConversationTitleSchema,
  }),
  /** Removes a chat and its messages from history, the snapshot and the
   * assistant's memory of it. A deleted chat cannot be continued. */
  z.strictObject({
    ...command,
    type: z.literal("conversation.delete"),
    conversationId: id,
    /** First cancel the chat's open work exactly as `work.cancel` does. */
    cancelOpenWork: z.literal(true).optional(),
  }),
  /** Moves a chat out of the list into the person's archive, read-only.
   * The main chat's messages move into a new archived chat instead. */
  z.strictObject({
    ...command,
    type: z.literal("conversation.archive"),
    conversationId: id,
    /** First cancel the chat's open work exactly as `work.cancel` does. */
    cancelOpenWork: z.literal(true).optional(),
  }),
  /** Brings an archived chat back to the list; it can be continued. */
  z.strictObject({
    ...command,
    type: z.literal("conversation.restore"),
    conversationId: id,
  }),
  /** The person stops their own waiting work: a question or task ends as
   * cancelled, an approval is declined, a waiting process run is cancelled.
   * Never cancels an effect already dispatched. */
  z.strictObject({
    ...command,
    type: z.literal("work.cancel"),
    conversationId: id,
    workItemId: id,
    expectedWorkRevision: revision,
    language: LanguageSchema,
  }),
  z.strictObject({
    ...command,
    type: z.literal("task.open"),
    conversationId: id,
    workItemId: id,
    expectedWorkRevision: revision,
    language: LanguageSchema,
  }),
  z.strictObject({
    ...command,
    type: z.literal("service.resolve"),
    conversationId: id,
    operationId: id,
    workItemId: id.optional(),
    expectedWorkRevision: revision.optional(),
    approved: z.boolean(),
    language: LanguageSchema,
  }),
  z.strictObject({
    ...command,
    type: z.literal("operation.reconcile"),
    conversationId: id,
    workItemId: id,
    operationId: id,
    expectedOperationRevision: revision,
  }),
  z
    .strictObject({
      ...command,
      type: z.literal("message.send"),
      conversationId: id,
      text,
      language: LanguageSchema,
      context: InputContextSchema.optional(),
      /** An open item from Tasks the person wants to resolve in this chat. */
      humanTask: HumanTaskReferenceSchema.optional(),
      /** Stable visible-message identity shared by explicit retries. */
      logicalMessageId: id.optional(),
      /** Parent attempt for a deliberate retry; transport retries keep the same command ids. */
      retryOf: id.optional(),
      /** First message after an app restart or long inactivity: the server
       * archives the previous chat and starts short-term memory afresh. */
      session: z.literal("new").optional(),
      /** The person declined an offered saved process: handle this request
       * with services and offer no process in this turn. */
      withoutProcess: z.literal(true).optional(),
      /** Services, processes and skills the person tagged with "@". */
      mentions: z.array(MessageMentionSchema).max(10).optional(),
      /** The device's IANA timezone, e.g. Europe/Prague. The server validates it and
       * otherwise uses its own default; "tomorrow" means the person's tomorrow. */
      timeZone: z
        .string()
        .max(100)
        .regex(/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+)$/)
        .optional(),
    })
    .refine(
      (message) => !message.context || !message.humanTask,
      "An answer to a question cannot also bring an open item",
    )
    .refine(
      (message) =>
        (!message.retryOf && !message.logicalMessageId) ||
        (!!message.retryOf &&
          !!message.logicalMessageId &&
          message.session !== "new" &&
          message.retryOf !== message.commandId &&
          message.retryOf !== message.idempotencyKey),
      "An explicit retry must identify its logical message and a different parent attempt without starting a new session",
    ),
  z.strictObject({
    ...command,
    type: z.literal("input.submit"),
    conversationId: id,
    ...InputContextSchema.shape,
    answer: z.strictObject({ selectedContactId: id }),
  }),
  z.strictObject({
    ...command,
    type: z.literal("proposal.decide"),
    conversationId: id,
    ...ProposalContextSchema.shape,
    decision: z.enum(["approve", "reject"]),
  }),
  z.strictObject({
    ...command,
    type: z.literal("proposal.revise"),
    conversationId: id,
    ...ProposalContextSchema.shape,
    changes: z.strictObject({ participantId: id, startsAt: z.iso.datetime() }),
  }),
]);
export type Command = z.infer<typeof CommandSchema>;
/** Clients that show why a chat cannot be deleted or archived ask for the
 * open work list with `work=agent-open-work%2F1` on `commands`. */
export const OPEN_WORK_PROFILE = "agent-open-work/1" as const;
/** Work in a chat that still waits for the person or the server. */
export const OpenWorkSchema = z.strictObject({
  workItemId: id,
  title: text,
  kind: z.enum(["question", "approval", "process", "task"]),
});
export type OpenWork = z.infer<typeof OpenWorkSchema>;
export const CommandResultSchema = z.strictObject({
  commandId: id,
  status: z.enum(["accepted", "conflict", "rejected"]),
  code: z.enum([
    "accepted",
    "revision_conflict",
    "invalid_answer",
    "unknown_context",
    "unsupported_phrase",
    "idempotency_conflict",
    "operation_in_progress",
    "invalid_proposal",
    "integration_unavailable",
  ]),
  /** Why `conversation.delete`/`conversation.archive` was refused
   * (`operation_in_progress`); only for clients that asked for it. */
  openWork: z.array(OpenWorkSchema).max(50).optional(),
  snapshot: SnapshotSchema,
});
export type CommandResult = z.infer<typeof CommandResultSchema>;
export const EventsResponseSchema = z.strictObject({
  scope: ScopeSchema,
  events: z.array(EventSchema).max(2000),
  cursor: sequence,
});

// Authentication is negotiated separately; the workflow wire schema is unchanged.
export const AUTH_PROFILE = "agent-pairing/1" as const;
export const PairingRequestSchema = z.strictObject({
  authProfile: z.literal(AUTH_PROFILE),
  profile: z.literal(PROFILE),
  code: z.string().regex(/^[a-f0-9]{32}$/),
});
export const AuthSessionSchema = z.strictObject({
  authProfile: z.literal(AUTH_PROFILE),
  profile: z.literal(PROFILE),
  scope: ScopeSchema,
  expiresAt: z.iso.datetime(),
  permissions: z.tuple([
    z.literal("workflow.read"),
    z.literal("workflow.write"),
  ]),
});
export type AuthSession = z.infer<typeof AuthSessionSchema>;
export const DEVICE_SESSION_PROFILE = "agent-device-session/1" as const;
export const RefreshCredentialSchema = z.strictObject({
  profile: z.literal(DEVICE_SESSION_PROFILE),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: z.iso.datetime(),
});
export const CredentialSchema = AuthSessionSchema.extend({
  accessToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  refresh: RefreshCredentialSchema.optional(),
});
export type Credential = z.infer<typeof CredentialSchema>;
