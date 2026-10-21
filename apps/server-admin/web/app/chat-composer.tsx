import { useQuery } from "@tanstack/react-query";
import {
  AudioLines,
  Plug,
  Sparkles,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@admin/components/ui/item";
import { Badge } from "@admin/components/ui/badge";
import type { ClientSession } from "../../../../packages/client-core/session";
import type {
  MentionDirectory,
  MentionKind,
  MessageMention,
} from "../../../../packages/protocol/mentions";
import { useChatCopy } from "./chat-copy";

export type MentionItem = MentionDirectory["items"][number];
/** The protocol's limits for one message. */
export const MAX_MESSAGE_LENGTH = 4000;
const MAX_MENTIONS = 10;
const PICKER_SIZE = 8;

export const mentionIcon: Record<MentionKind, LucideIcon> = {
  service: Plug,
  process: Workflow,
  skill: Sparkles,
  meeting: AudioLines,
};
const mentionKey = (item: Pick<MentionItem, "kind" | "id">) =>
  `${item.kind}:${item.id}`;

/**
 * What the person can tag with "@". A server without the directory (404),
 * or one that fails, leaves tagging hidden; the chat itself is unaffected.
 */
export function useMentionDirectory(session: ClientSession) {
  const directory = useQuery({
    queryKey: ["app", "mentions", session.identityKey],
    queryFn: ({ signal }) => session.readMentions(signal),
    retry: false,
    staleTime: 60_000,
    // A few hundred names per identity; kept for the page's lifetime.
    gcTime: Infinity,
  });
  return directory.data?.items ?? [];
}

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
/**
 * The tags each text sent from this page carried. The server keeps only a
 * message's text, and a meeting isn't in the directory, so its tag could not
 * be read back from the text alone.
 */
const sentTags = new Map<string, MentionItem[]>();
export function rememberMentions(
  text: string,
  items: readonly MentionItem[],
  mentions: readonly MessageMention[],
) {
  const key = text.trim();
  sentTags.delete(key);
  const sent = mentions.flatMap(
    (mention) =>
      items.find((item) => mentionKey(item) === mentionKey(mention)) ?? [],
  );
  if (!sent.length) return;
  sentTags.set(key, sent);
  if (sentTags.size > 200) sentTags.delete(sentTags.keys().next().value!);
}
/** Tags a sent text carried: as sent from here, then by the directory. */
export function sentMentions(
  text: string,
  directory: readonly MentionItem[],
): MentionItem[] {
  const seen = new Set<string>();
  return [
    ...(sentTags.get(text.trim()) ?? []).filter((item) => isTagged(text, item)),
    ...mentionsInText(text, directory),
  ]
    .filter(
      (item) => !seen.has(mentionKey(item)) && !!seen.add(mentionKey(item)),
    )
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

export const mentionOptionId = (listId: string, index: number) =>
  `${listId}-${index}`;

/** The "@" suggestions above the composer; the textarea keeps the focus. */
export function MentionPicker({
  id,
  items,
  active,
  onPick,
  onHover,
}: {
  id: string;
  items: readonly MentionItem[];
  active: number;
  onPick: (item: MentionItem) => void;
  onHover: (index: number) => void;
}) {
  const { copy } = useChatCopy();
  return (
    <div
      id={id}
      role="listbox"
      aria-label={copy.mentionPicker}
      data-testid="mention-picker"
      className="absolute inset-x-0 bottom-full z-20 mb-2 flex max-h-72 flex-col gap-0.5 overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {items.map((item, index) => {
        const Icon = mentionIcon[item.kind];
        return (
          <Item
            key={mentionKey(item)}
            id={mentionOptionId(id, index)}
            role="option"
            aria-selected={index === active}
            variant="option"
            size="xs"
            // The textarea keeps the focus and the caret while picking.
            onMouseDown={(event) => event.preventDefault()}
            onMouseMove={() => onHover(index)}
            onClick={() => onPick(item)}
          >
            <ItemMedia variant="icon">
              <Icon aria-hidden="true" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{item.name}</ItemTitle>
              <ItemDescription>
                {item.description || copy.mentionKinds[item.kind]}
              </ItemDescription>
            </ItemContent>
          </Item>
        );
      })}
    </div>
  );
}

/** The tags of the message being written; removing one drops its "@Name". */
export function MentionChips({
  items,
  onRemove,
}: {
  items: readonly MentionItem[];
  onRemove: (item: MentionItem) => void;
}) {
  const { copy } = useChatCopy();
  return (
    <div
      data-testid="composer-mentions"
      className="flex min-w-0 flex-wrap gap-1"
    >
      {items.map((item) => {
        const Icon = mentionIcon[item.kind];
        return (
          <Badge key={mentionKey(item)} variant="secondary">
            <Icon data-icon="inline-start" aria-hidden="true" />
            {item.name}
            <button
              type="button"
              aria-label={`${copy.removeMention}: ${item.name}`}
              className="-mr-1 rounded-full hover:text-foreground"
              onClick={() => onRemove(item)}
            >
              <X aria-hidden="true" className="size-3" />
            </button>
          </Badge>
        );
      })}
    </div>
  );
}

/** What a sent message tagged, shown above its bubble. */
export function MessageTags({ items }: { items: readonly MentionItem[] }) {
  if (!items.length) return null;
  return (
    <span
      data-testid="message-mentions"
      className="flex max-w-full flex-wrap justify-end gap-1"
    >
      {items.map((item) => {
        const Icon = mentionIcon[item.kind];
        return (
          <Badge key={mentionKey(item)} variant="outline">
            <Icon data-icon="inline-start" aria-hidden="true" />
            {item.name}
          </Badge>
        );
      })}
    </span>
  );
}
