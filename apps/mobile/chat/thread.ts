import type {
  Conversation,
  ConversationSummary,
  WorkItem,
} from "../../../packages/protocol";
import { isTerminalNativeWork } from "../../../packages/client-core/store";
import type { SessionState } from "../../../packages/client-core/session";
import { messageDays } from "../../../packages/client-core/chat-days";

/**
 * The phone's thread projection: which stored messages the chat shows and
 * which part each one renders as. Pure; the parts registry draws them.
 */
export type ChatMessage = Conversation["messages"][number];

/** The part a stored message renders as (see `parts.tsx`). */
export type ThreadPart =
  /** Held back (a spoken reply waits for its audio) or nothing to show. */
  | "hidden"
  | "user"
  | "connection"
  | "offer"
  | "proposal"
  | "skill"
  | "document"
  /** Text and generated UI only. */
  | "answer"
  | "approval"
  | "contacts"
  /** The work card the message anchors. */
  | "work";

export type ThreadEntry = {
  message: ChatMessage;
  part: ThreadPart;
  /** For an offer: the request it answers, which Decline sends again. */
  request?: ChatMessage;
  /** For an offer: it is the newest message of the chat. */
  current: boolean;
  /** The calendar day this message starts (a divider precedes it). */
  day?: number;
  /** The latest request: **Edit** puts it back in the composer. */
  editable?: boolean;
  /** For the latest answer: the request **Again** sends once more. */
  again?: ChatMessage;
};

/**
 * Earlier sessions stay on the server; the chat shows only this session.
 * Once the server archives them, the boundary message is gone and every
 * remaining message is current.
 */
export function visibleMessages(
  allMessages: readonly ChatMessage[],
  historySelection: ConversationSummary | undefined,
  chatStart: { afterMessageId: string | null } | undefined,
): ChatMessage[] {
  const boundary = chatStart?.afterMessageId
    ? allMessages.findIndex((m) => m.id === chatStart.afterMessageId)
    : -1;
  return historySelection
    ? [...allMessages]
    : chatStart
      ? allMessages.slice(boundary + 1)
      : [];
}

/**
 * Each message with its part. Work a message presents is added to
 * `referencedWork`, so it is not repeated after the transcript.
 */
export function projectThread({
  messages,
  work,
  heldReply,
  anchors,
  referencedWork,
  readOnly = false,
  now = new Date(),
}: {
  messages: readonly ChatMessage[];
  /** The chat's work shown here, each with its own card. */
  work: readonly WorkItem[];
  /** A spoken reply's command: its answer appears together with the audio. */
  heldReply?: string;
  anchors: ReadonlyMap<string, string>;
  referencedWork: Set<string>;
  /** An archived chat: no Edit and no Again. */
  readOnly?: boolean;
  now?: Date;
}): ThreadEntry[] {
  const entries = parts({ messages, work, heldReply, anchors, referencedWork });
  const shown = entries.filter((entry) => entry.part !== "hidden");
  const days = messageDays(
    shown.map((entry) => entry.message),
    now,
  );
  shown.forEach((entry, index) => {
    if (days[index] !== undefined) entry.day = days[index];
  });
  if (!readOnly) {
    const request = shown.findLast((entry) => entry.message.role === "user");
    if (request) request.editable = true;
    const last = shown.at(-1);
    if (
      last &&
      last.message.role === "assistant" &&
      last.message.id === messages.at(-1)?.id
    )
      last.again = messages.findLast((message) => message.role === "user");
  }
  return entries;
}

function parts({
  messages,
  work,
  heldReply,
  anchors,
  referencedWork,
}: {
  messages: readonly ChatMessage[];
  work: readonly WorkItem[];
  heldReply?: string;
  anchors: ReadonlyMap<string, string>;
  referencedWork: Set<string>;
}): ThreadEntry[] {
  return messages.map((m, index) => {
    const entry = (part: ThreadPart): ThreadEntry => ({
      message: m,
      part,
      current: false,
    });
    const shown = m.text.trim() || m.ui ? "answer" : "hidden";
    if (
      heldReply &&
      m.role === "assistant" &&
      m.replyToCommandId === heldReply
    ) {
      if (m.workItemId) referencedWork.add(m.workItemId);
      if (m.result?.type === "service.action") {
        const operationId = m.result.operationId;
        for (const item of work)
          if (item.native?.action?.operationId === operationId)
            referencedWork.add(item.id);
      }
      return entry("hidden");
    }
    if (m.role === "user") return entry("user");
    if (m.result?.type === "service.connection") return entry("connection");
    if (m.result?.type === "process.offer")
      return {
        message: m,
        part: "offer",
        request: messages
          .slice(0, index)
          .reverse()
          .find((message) => message.role === "user"),
        current: messages.at(-1)?.id === m.id,
      };
    if (m.result?.type === "process.proposal") return entry("proposal");
    if (m.result?.type === "skill.proposal") return entry("skill");
    // Answers no longer compose cards; a stored one reads as its text.
    if (m.result?.type === "card.document") return entry("document");
    // Only a write waiting for the person's decision is a card; anything
    // else an action did, the answer tells in words, like any AI chat.
    if (
      m.result?.type === "service.action" &&
      m.result.status !== "awaiting_approval"
    )
      return entry(shown);
    if (m.result?.type === "service.action") return entry("approval");
    if (m.result?.type === "crm.contacts") return entry("contacts");
    if (
      m.workItemId &&
      work.some((w) => w.id === m.workItemId) &&
      anchors.get(m.workItemId) === m.id
    ) {
      referencedWork.add(m.workItemId);
      const anchored = work.find((w) => w.id === m.workItemId);
      // A finished action needs no card: the answer says what happened.
      if (
        anchored?.native?.action &&
        !anchored.native.process &&
        isTerminalNativeWork(anchored)
      )
        return entry(shown);
      return entry("work");
    }
    return entry("answer");
  });
}

/** Work that no message presents: shown after the transcript, as cards. */
export function trailingWork({
  work,
  referencedWork,
  openedWork,
  pending,
  conversationId,
}: {
  work: readonly WorkItem[];
  referencedWork: ReadonlySet<string>;
  openedWork: ReadonlySet<string>;
  pending: SessionState["pending"];
  conversationId: string;
}): WorkItem[] {
  return work.filter(
    (w) =>
      !referencedWork.has(w.id) &&
      (!!w.native?.process ||
        !isTerminalNativeWork(w) ||
        openedWork.has(w.id)) &&
      // The run of the message being answered is the
      // Thinking line, not a "waiting for server" card.
      !(
        pending?.type === "message.send" &&
        pending.conversationId === conversationId &&
        !w.native?.process &&
        ["queued", "running", "waiting_system"].includes(w.status)
      ),
  );
}
