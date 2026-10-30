import type { MentionDirectory, MessageMention } from "../protocol/mentions";
export type MentionItem = MentionDirectory["items"][number];
export const MAX_MESSAGE_LENGTH = 4000;
export const MAX_MENTIONS = 10;
const PICKER_SIZE = 8;
export const mentionKey = (item: Pick<MentionItem, "kind" | "id">) =>
  `${item.kind}:${item.id}`;

const fold = (value: string) =>
  value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();

/** The "@query" right before the caret, if the person is typing a tag. */
export function mentionQuery(text: string, caret: number) {
  const before = text.slice(0, caret);
  const match = /(?:^|\s)@([^\s@]{0,40})$/u.exec(before);
  if (!match) return null;
  return { start: caret - match[1]!.length - 1, query: match[1]! };
}

/** Best matches first: name prefix, then a word prefix, then anywhere. */
export function filterMentions(items: readonly MentionItem[], query: string) {
  const wanted = fold(query);
  const rank = (item: MentionItem) => {
    const name = fold(item.name);
    if (!wanted || name.startsWith(wanted)) return 0;
    if (name.split(/\s+/).some((word) => word.startsWith(wanted))) return 1;
    if (name.includes(wanted)) return 2;
    return -1;
  };
  return items
    .map((item) => ({ item, rank: rank(item) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, PICKER_SIZE)
    .map((entry) => entry.item);
}

/** The text still carries this tag as "@Name". */
export const isTagged = (text: string, item: MentionItem) => {
  const at = text.indexOf(`@${item.name}`);
  if (at < 0) return false;
  const after = text.charAt(at + item.name.length + 1);
  return !after || !/[\p{L}\p{N}]/u.test(after);
};
/** Picked tags whose "@Name" is still in the text, as sent on the message. */
export function messageMentions(
  text: string,
  picked: readonly MentionItem[],
): MessageMention[] {
  const seen = new Set<string>();
  return picked
    .filter((item) => isTagged(text, item))
    .filter(
      (item) => !seen.has(mentionKey(item)) && !!seen.add(mentionKey(item)),
    )
    .slice(0, MAX_MENTIONS)
    .map(({ kind, id }) => ({ kind, id }));
}
/** Tags a saved text refers to, read back against the directory. */
export function mentionsInText(
  text: string,
  directory: readonly MentionItem[],
): MentionItem[] {
  // The longest name wins where one name starts another ("CRM", "CRM Plus").
  return [...directory]
    .sort((a, b) => b.name.length - a.name.length)
    .filter((item) => isTagged(text, item))
    .slice(0, MAX_MENTIONS);
}
/** Puts "@Name " in place of the typed "@query"; returns the new caret too. */
export function insertMention(
  text: string,
  at: { start: number; query: string },
  item: MentionItem,
) {
  const end = at.start + 1 + at.query.length;
  const inserted = `@${item.name} `;
  const rest = text.slice(end).replace(/^ /, "");
  return {
    text: text.slice(0, at.start) + inserted + rest,
    caret: at.start + inserted.length,
  };
}
/** Removes a tag and its "@Name" from the text. */
export function removeMention(text: string, item: MentionItem) {
  return text
    .split(`@${item.name}`)
    .join("")
    .replace(/ {2,}/g, " ")
    .trimStart();
}

/** The exact draft that owns a picker. Equal text after a new edit is a new owner. */
export type MentionDraftOwner = {
  identityKey: string;
  conversationId: string;
  revision: number;
};
export type MentionIntent = MentionDraftOwner & {
  text: string;
  caret: number;
  at: ReturnType<typeof mentionQuery>;
};
/** Opening the explicit sheet is read-only until a person chooses a reference. */
export function captureMentionIntent(
  owner: MentionDraftOwner,
  text: string,
  caret: number,
  explicit = false,
): MentionIntent | null {
  if (!Number.isInteger(caret) || caret < 0 || caret > text.length) return null;
  const at = mentionQuery(text, caret);
  return at || explicit ? { ...owner, text, caret, at } : null;
}
/** Returns only an owned draft update. Sending and process execution are caller actions. */
export function applyMentionPick(
  intent: MentionIntent,
  current: MentionDraftOwner & {
    text: string;
    picked: readonly MentionItem[];
    directory: readonly MentionItem[];
  },
  item: MentionItem,
): { text: string; caret: number; picked: MentionItem[] } | null {
  if (
    intent.identityKey !== current.identityKey ||
    intent.conversationId !== current.conversationId ||
    intent.revision !== current.revision ||
    intent.text !== current.text ||
    !current.directory.some(
      (entry) =>
        mentionKey(entry) === mentionKey(item) && entry.name === item.name,
    )
  )
    return null;
  const before = current.text.slice(0, intent.caret);
  const next = intent.at
    ? insertMention(current.text, intent.at, item)
    : {
        text:
          before +
          (before && !/\s$/u.test(before) ? " " : "") +
          `@${item.name} ` +
          current.text.slice(intent.caret).replace(/^ /u, ""),
        caret:
          before.length +
          (before && !/\s$/u.test(before) ? 1 : 0) +
          item.name.length +
          2,
      };
  const picked = current.picked.filter((entry) => isTagged(next.text, entry));
  if (!picked.some((entry) => mentionKey(entry) === mentionKey(item)))
    picked.push(item);
  if (next.text.length > MAX_MESSAGE_LENGTH || picked.length > MAX_MENTIONS)
    return null;
  return { ...next, picked };
}
