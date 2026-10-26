import type { AppendMessage, ThreadMessageLike } from "@assistant-ui/react";
import type { Conversation, WorkItem } from "../../../../../packages/protocol";
import type { RequestActivity } from "../../../../../packages/protocol/activity";
import type {
  AnswerStreamApproval,
  AnswerStreamStep,
} from "../../../../../packages/protocol/answer-stream";
import type { ServiceResult } from "../../../../../packages/protocol/service-result";
import { isTerminalNativeWork } from "../../../../../packages/client-core/store";
import { summarizeLiveSteps } from "../chat-work";
import { splitDraft } from "../../../../../packages/openui-library/program";
import type { MentionItem } from "../chat-composer";

/**
 * The next chat's transport: what Niaro stores and streams, as the messages
 * and parts assistant-ui renders. The session already reads the answer
 * stream (NIAR-226/227) into its state; this maps that state, so the thread
 * is a projection and nothing here sends, stores or decides anything.
 *
 * Every system view is a tool-call part with a `niaro.*` tool name, so the
 * thread renders it through a tool UI like any agent chat would.
 */
export type ChatMessage = Conversation["messages"][number];

export const TOOL = {
  /** One streamed tool step: "Twenty CRM · Search loans · returned items 71". */
  step: "niaro.step",
  /** A write waiting for the person's approval (streamed or stored). */
  approval: "niaro.approval",
  /** The generated part of an answer (OpenUI Lang). */
  openui: "niaro.openui",
  /** The assistant's own work the answer is about: a question, a run. */
  work: "niaro.work",
  /** A service to sign in to before the assistant can go on. */
  signin: "niaro.signin",
  /** A saved process the assistant offers instead of answering ad hoc. */
  offer: "niaro.offer",
  /** A skill drafted from the chat. */
  skill: "niaro.skill",
  /** A process drafted from the chat. */
  proposal: "niaro.proposal",
  /** Contacts found in the CRM. */
  contacts: "niaro.contacts",
  /** A card composed by an earlier model: its words only. */
  document: "niaro.document",
} as const;

/** What the message components read beside the parts. */
export type NextMeta = {
  kind: "stored" | "pending" | "live";
  createdAt?: string;
  /** The day the message starts, when it differs from the one before. */
  day?: number;
  /** The open item the person's message brought. */
  task?: string;
  /** What the person's message tagged with "@". */
  tags?: readonly MentionItem[];
  /** The request this (last) answer is for: "Again" sends it once more. */
  requestText?: string;
  /** The last request: "Edit" brings it back to the composer. */
  editable?: boolean;
  /** Why the live answer stopped, in the person's language. */
  hint?: string;
};
export const nextMeta = (message: {
  metadata?: { custom?: Record<string, unknown> | undefined } | undefined;
}) => (message.metadata?.custom ?? {}) as Partial<NextMeta>;

type Part = Exclude<ThreadMessageLike["content"], string>[number];
type ToolArgs = Extract<Part, { type: "tool-call" }>["args"];
const tool = (
  toolName: string,
  toolCallId: string,
  args: Record<string, unknown>,
  done = true,
): Part => ({
  type: "tool-call",
  toolCallId,
  toolName,
  args: args as ToolArgs,
  ...(done ? { result: { shown: true } } : {}),
});

/**
 * A stored message as thread parts, with the classic chat's rules: a write
 * waiting for approval is a card, anything else an action did is told in
 * words; a finished native action needs no card. `null` is a message with
 * nothing to show.
 */
export function storedMessage(
  m: ChatMessage,
  options: {
    day?: number;
    tags?: readonly MentionItem[];
    /** The work this message anchors, when it is the message that shows it. */
    anchored?: WorkItem;
    requestText?: string;
    editable?: boolean;
  },
): ThreadMessageLike | null {
  const meta: NextMeta = {
    kind: "stored",
    ...(m.createdAt ? { createdAt: m.createdAt } : {}),
    ...(options.day !== undefined ? { day: options.day } : {}),
  };
  const createdAt = m.createdAt ? new Date(m.createdAt) : undefined;
  if (m.role === "user")
    return {
      id: m.id,
      role: "user",
      createdAt,
      content: [{ type: "text", text: m.text }],
      metadata: {
        custom: {
          ...meta,
          ...(m.humanTask ? { task: m.humanTask.title } : {}),
          tags: options.tags ?? [],
          ...(options.editable ? { editable: true } : {}),
        },
      },
    };
  const text: Part[] = m.text.trim() ? [{ type: "text", text: m.text }] : [];
  const ui: Part[] = m.ui
    ? [tool(TOOL.openui, `openui:${m.id}`, { program: m.ui.program })]
    : [];
  const result = m.result;
  let system: Part[] | null = [];
  let withText = true;
  if (result?.type === "service.connection")
    system = [tool(TOOL.signin, `signin:${m.id}`, { result })];
  else if (result?.type === "process.offer")
    system = [
      tool(TOOL.offer, `offer:${m.id}`, {
        offer: result,
        requestText: options.requestText ?? "",
      }),
    ];
  else if (result?.type === "skill.proposal")
    system = [tool(TOOL.skill, `skill:${m.id}`, { proposal: result })];
  else if (result?.type === "process.proposal")
    system = [tool(TOOL.proposal, `proposal:${m.id}`, { proposal: result })];
  else if (result?.type === "card.document")
    system = [
      tool(TOOL.document, `document:${m.id}`, { document: result.document }),
    ];
  else if (result?.type === "service.action")
    system =
      result.status === "awaiting_approval"
        ? [tool(TOOL.approval, `approval:${m.id}`, { result })]
        : text.length || ui.length
          ? []
          : null;
  else if (result?.type === "crm.contacts") {
    system = [
      tool(TOOL.contacts, `contacts:${m.id}`, {
        contacts: result.contacts,
        hasMore: result.hasMore,
      }),
    ];
    withText = false;
  } else if (options.anchored) {
    const work = options.anchored;
    if (
      work.native?.action &&
      !work.native.process &&
      isTerminalNativeWork(work)
    )
      system = text.length || ui.length ? [] : null;
    else {
      system = [tool(TOOL.work, `work:${work.id}`, { workId: work.id })];
      withText = false;
    }
  }
  if (system === null) return null;
  return {
    id: m.id,
    role: "assistant",
    createdAt,
    status: { type: "complete", reason: "stop" },
    content: [...(withText ? text : []), ...ui, ...system],
    metadata: {
      custom: {
        ...meta,
        ...(options.requestText !== undefined && withText
          ? { requestText: options.requestText }
          : {}),
      },
    },
  };
}

/** The person's message on its way, until the server records it. */
export function pendingMessage(
  commandId: string,
  text: string,
): ThreadMessageLike {
  return {
    id: `pending:${commandId}`,
    role: "user",
    content: [{ type: "text", text }],
    metadata: { custom: { kind: "pending", tags: [] } satisfies NextMeta },
  };
}

/**
 * The answer while it is written: the streamed steps, the draft text and
 * program, and a write the stream stopped for. The stored message replaces
 * it; nothing in it is final.
 */
export function liveMessage({
  commandId,
  activity,
  steps,
  approval,
  stopped,
  failed,
  hint,
}: {
  commandId: string;
  activity: RequestActivity | null;
  steps: readonly AnswerStreamStep[];
  approval: ServiceResult | undefined;
  stopped: boolean;
  failed: boolean;
  hint?: string;
}): ThreadMessageLike {
  const draft = activity?.draft ? splitDraft(activity.draft) : undefined;
  return {
    id: `live:${commandId}`,
    role: "assistant",
    status: stopped
      ? {
          type: "incomplete",
          reason: failed ? "error" : "cancelled",
          ...(hint ? { error: hint } : {}),
        }
      : { type: "running" },
    content: [
      ...summarizeLiveSteps(steps).map(({ key, step, count }) =>
        tool(
          TOOL.step,
          `step:${key}`,
          { step, count },
          step.status !== "running",
        ),
      ),
      ...(draft?.text
        ? [{ type: "text", text: draft.text } satisfies Part]
        : []),
      ...(draft?.program
        ? [
            tool(
              TOOL.openui,
              `openui:${commandId}`,
              { program: draft.program, streaming: true },
              false,
            ),
          ]
        : []),
      ...(approval
        ? [
            tool(
              TOOL.approval,
              `approval:${approval.operationId}`,
              { result: approval },
              false,
            ),
          ]
        : []),
    ],
    metadata: {
      custom: { kind: "live", ...(hint ? { hint } : {}) } satisfies NextMeta,
    },
  };
}

/** A write the stream announced, as the card the stored message will carry. */
export function streamedApproval(
  approval: AnswerStreamApproval,
): ServiceResult {
  return {
    type: "service.action",
    version: 1,
    operationId: approval.operationId,
    title: approval.toolName,
    service: approval.service,
    status: "awaiting_approval",
    effect: "write",
    fields: approval.input.fields,
    inputJson: "",
    reviewTruncated: approval.reviewTruncated,
    summary: "",
  };
}

/** The text of a message the composer appends. */
export function appendedText(message: Pick<AppendMessage, "content">) {
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

/** The text of a thread message, as "Copy" takes it. */
export function threadText(message: { content: ThreadMessageLike["content"] }) {
  return typeof message.content === "string"
    ? message.content
    : message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n");
}
