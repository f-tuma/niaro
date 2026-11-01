import { MAX_MESSAGE_LENGTH } from "../../../../packages/client-core/mentions";
import type { HumanTaskReference } from "../../../../packages/protocol";
import type { ReplyContext } from "../../../../packages/client-core/reply-context";
import type { MentionDirectory } from "../../../../packages/protocol/mentions";

/**
 * Page-lifetime chat memory: unsent drafts per chat, since the chat page
 * remounts for every conversation. Nothing here is stored in the browser.
 */
export type ChatDraft = {
  text: string;
  context?: ReplyContext;
  revision: number;
  /** An open item brought from Tasks; it rides on the chat's next message. */
  task?: HumanTaskReference;
  /** Tags already picked for the text, e.g. a meeting from "Ask". */
  mentions?: MentionDirectory["items"][number][];
  /** What the last "Ask" put here; untouched, the next "Ask" replaces it. */
  asked?: { text: string; mentions: string[] };
};
const drafts = new Map<string, ChatDraft>();
/** The new chat at "/chat" has no id worth remembering until its first message. */
export const UNSAVED_DRAFT = "unsaved";
export const draftKey = (identityKey: string, conversationId: string) =>
  `${identityKey}\n${conversationId}`;
export function readDraft(key: string) {
  return drafts.get(key);
}
/** Forgets every draft; tests use it between renders. */
export function clearDrafts() {
  drafts.clear();
}
export function saveDraft(key: string, draft: ChatDraft) {
  if (draft.text || draft.context || draft.task || draft.mentions?.length)
    drafts.set(key, draft);
  else drafts.delete(key);
}

/** The sidebar's chat list; invalidate it when a chat is created or renamed. */
export const chatHistoryKey = (identityKey: string) =>
  ["app", "chats", identityKey] as const;
/** The account page's archive; invalidating the chat list renews it too. */
export const archivedChatsKey = (identityKey: string) =>
  [...chatHistoryKey(identityKey), "archived"] as const;

/**
 * Puts a question into the new chat's draft without losing what the person
 * already wrote there (text, context, task, mentions). A question that would
 * overflow the draft leaves it untouched; returns whether it was added.
 */
export function addToNewChat(
  key: string,
  text: string,
  mentions: NonNullable<ChatDraft["mentions"]> = [],
) {
  const question = text.trimStart();
  if (!question.trim()) return false;
  let saved = readDraft(key);
  // An earlier "Ask" the person has not touched gives way to this one.
  if (saved?.asked && saved.text === saved.asked.text) {
    const asked = new Set(saved.asked.mentions);
    saved = {
      ...saved,
      text: "",
      mentions: saved.mentions?.filter((m) => !asked.has(`${m.kind}:${m.id}`)),
    };
  }
  const before = saved?.text.trimEnd();
  const next = before ? `${before}\n\n${question}` : question;
  if (next.length > MAX_MESSAGE_LENGTH) return false;
  const known = new Set(
    (saved?.mentions ?? []).map((m) => `${m.kind}:${m.id}`),
  );
  const added = mentions.filter((m) => !known.has(`${m.kind}:${m.id}`));
  saveDraft(key, {
    ...saved,
    text: next,
    revision: saved?.revision ?? 0,
    mentions: [...(saved?.mentions ?? []), ...added],
    asked: {
      text: next,
      mentions: added.map((m) => `${m.kind}:${m.id}`),
    },
  });
  return true;
}
/** Atomic Hub handoff: preserves context/task/mentions and both drafts on overflow. */
export function appendDraftQuestion(
  saved: ChatDraft | undefined,
  text: string,
): ChatDraft | null {
  const question = text.trim(),
    before = saved?.text.trimEnd();
  const next = question
    ? before
      ? `${before}\n\n${question}`
      : question
    : (saved?.text ?? "");
  return next.length > MAX_MESSAGE_LENGTH
    ? null
    : { ...saved, text: next, revision: saved?.revision ?? 0 };
}
