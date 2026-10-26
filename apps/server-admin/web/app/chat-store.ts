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
