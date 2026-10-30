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
  MentionKind,
  MessageMention,
} from "../../../../packages/protocol/mentions";
import { useChatCopy } from "./chat-copy";

import {
  MAX_MENTIONS,
  mentionKey,
  isTagged,
  mentionsInText,
  type MentionItem,
} from "../../../../packages/client-core/mentions";
export {
  MAX_MESSAGE_LENGTH,
  mentionQuery,
  filterMentions,
  isTagged,
  messageMentions,
  mentionsInText,
  insertMention,
  removeMention,
  type MentionItem,
} from "../../../../packages/client-core/mentions";

export const mentionIcon: Record<MentionKind, LucideIcon> = {
  service: Plug,
  process: Workflow,
  skill: Sparkles,
  meeting: AudioLines,
};

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
