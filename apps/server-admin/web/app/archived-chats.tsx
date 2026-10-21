import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { Archive, ArchiveRestore, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@admin/components/ui/button";
import { DropdownMenuItem } from "@admin/components/ui/dropdown-menu";
import { Card } from "@admin/components/ui/card";
import { Input } from "@admin/components/ui/input";
import { Skeleton } from "@admin/components/ui/skeleton";
import {
  Alert,
  AlertAction,
  AlertDescription,
} from "@admin/components/ui/alert";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@admin/components/ui/item";
import { Section, Toolbar } from "@admin/components/console/page";
import { ConfirmAction, MoreActions } from "@admin/components/console/forms";
import { RelativeTime } from "@admin/components/console/time";
import { conversationTitle } from "../../../../packages/client-core/conversation-title";
import { messageCount, type TranslationKey } from "../../../../packages/i18n";
import type { ConversationSummary } from "../../../../packages/protocol";
import { useApp } from "./context";
import { chatChangeError, useChatCopy } from "./chat-copy";
import { archivedChatsKey, chatHistoryKey } from "./chat-store";
import { searchChats } from "./chat-history";
import {
  OpenWorkDialog,
  openWorkRefusal,
  type OpenWorkRefusal,
} from "./open-work-dialog";

/** A delete press; `cancelOpenWork` after the person agreed. */
type DirectoryChange = { id: string; cancelOpenWork?: boolean };
/** More rows than fit a glance: the archive gets a search field. */
const SEARCH_FROM = 8;

/**
 * The person's archived chats (account page): open one read-only, restore it
 * to the chat list, or delete it. Nothing here without a chat session.
 */
export function ArchivedChats() {
  const { session } = useApp();
  const { copy, tr, language } = useChatCopy();
  const client = useQueryClient();
  const identityKey = session?.identityKey ?? "";
  const key = archivedChatsKey(identityKey);
  const chats = useInfiniteQuery({
    queryKey: key,
    enabled: !!session,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      session!.readConversations(pageParam, signal, "archived"),
    getNextPageParam: (page) => page.nextAfter,
    retry: false,
  });
  const [query, setQuery] = useState("");
  const [failure, setFailure] = useState<TranslationKey | null>(null);
  const [deleting, setDeleting] = useState<ConversationSummary>();
  // Restored and deleted rows leave at once; the server's answer settles it.
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const settled = (id: string) => {
    setGone((current) => new Set(current).add(id));
    // The sidebar lists a restored chat again (both lists share the prefix).
    void client.invalidateQueries({ queryKey: chatHistoryKey(identityKey) });
  };
  const failed = (error: unknown) => {
    setFailure(chatChangeError(error));
    void client.invalidateQueries({ queryKey: key });
  };
  const restore = useMutation({
    mutationFn: (id: string) =>
      session!.restoreConversation(id, crypto.randomUUID()),
    onMutate: () => setFailure(null),
    onError: failed,
    onSuccess: (_, id) => settled(id),
  });
  const [refusal, setRefusal] = useState<OpenWorkRefusal>();
  const remove = useMutation({
    mutationFn: ({ id, cancelOpenWork }: DirectoryChange) =>
      cancelOpenWork
        ? session!.deleteConversation(id, crypto.randomUUID(), {
            cancelOpenWork,
          })
        : session!.deleteConversation(id, crypto.randomUUID()),
    onMutate: () => setFailure(null),
    onError: (error, { id }) => {
      const open = openWorkRefusal(error, id, "delete");
      if (open) setRefusal(open);
      else failed(error);
    },
    onSuccess: (_, { id }) => settled(id),
  });
  // Opened from the user menu (`/me#archived-chats`): scroll here once shown.
  const shown = !!session && !chats.isPending;
  useEffect(() => {
    if (shown && globalThis.location?.hash === "#archived-chats")
      globalThis.document?.getElementById("archived-chats")?.scrollIntoView();
  }, [shown]);
  if (!session) return null;
  const titleOf = (conversation: ConversationSummary) =>
    conversationTitle(conversation.title) || tr("untitledChat");
  const seen = new Set<string>();
  const loaded = (chats.data?.pages.flatMap((page) => page.conversations) ?? [])
    .filter((c) => !gone.has(c.id) && !seen.has(c.id) && !!seen.add(c.id))
    .sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    );
  const rows = searchChats(loaded, query, titleOf);
  const busy = restore.isPending || remove.isPending;
  const unavailable =
    chats.error instanceof Error &&
    chats.error.message === "conversation_history_unavailable";
  return (
    <Section
      id="archived-chats"
      title={tr("archivedChats")}
      count={chats.data && loaded.length ? loaded.length : undefined}
    >
      {(loaded.length > SEARCH_FROM || query) && (
        <Toolbar>
          <Input
            type="search"
            aria-label={tr("searchArchivedChats")}
            placeholder={tr("searchArchivedChats")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setQuery("");
            }}
          />
        </Toolbar>
      )}
      {failure && (
        <Alert variant="destructive">
          <AlertDescription>{tr(failure)}</AlertDescription>
        </Alert>
      )}
      {chats.isError ? (
        unavailable ? (
          <p className="text-sm text-muted-foreground">
            {tr("chatArchiveUpdateRequired")}
          </p>
        ) : (
          <Alert variant="destructive">
            <AlertDescription>{tr("archivedChatsFailed")}</AlertDescription>
            <AlertAction>
              <Button
                variant="outline"
                size="sm"
                disabled={chats.isFetching}
                onClick={() => void chats.refetch()}
              >
                <RefreshCw data-icon="inline-start" aria-hidden="true" />
                {copy.retry}
              </Button>
            </AlertAction>
          </Alert>
        )
      ) : chats.isPending ? (
        <div role="status" aria-label={tr("loading")}>
          <Skeleton className="h-24 w-full" />
        </div>
      ) : rows.length ? (
        <Card variant="list" data-testid="archived-chats">
          {rows.map((conversation) => (
            <Item key={conversation.id} variant="row" size="row">
              <ItemMedia variant="icon">
                <Archive aria-hidden="true" />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>
                  <Link
                    to="/chat/$conversationId"
                    params={{ conversationId: conversation.id }}
                    className="truncate hover:underline"
                  >
                    {titleOf(conversation)}
                  </Link>
                </ItemTitle>
                <ItemDescription>
                  <RelativeTime value={conversation.updatedAt} />
                  {" · "}
                  {messageCount(language, conversation.messageCount)}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => restore.mutate(conversation.id)}
                >
                  <ArchiveRestore data-icon="inline-start" aria-hidden="true" />
                  {tr("restoreChat")}
                </Button>
                <MoreActions
                  label={`${copy.chatOptions}: ${titleOf(conversation)}`}
                  size="sm"
                >
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={busy}
                    onSelect={() => setDeleting(conversation)}
                  >
                    <Trash2 aria-hidden="true" />
                    {tr("deleteChat")}
                  </DropdownMenuItem>
                </MoreActions>
              </ItemActions>
            </Item>
          ))}
        </Card>
      ) : query ? (
        <p role="status" className="text-sm text-muted-foreground">
          {copy.noMatches}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">{tr("noArchivedChats")}</p>
      )}
      {chats.hasNextPage && (
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          disabled={chats.isFetchingNextPage}
          onClick={() => void chats.fetchNextPage()}
        >
          {query ? copy.searchOlder : copy.showMore}
        </Button>
      )}
      <ConfirmAction
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined);
        }}
        title={tr("deleteChatTitle")}
        description={
          deleting
            ? `${titleOf(deleting)}: ${tr("deleteChatHint")}`
            : tr("deleteChatHint")
        }
        confirmLabel={tr("deleteChat")}
        cancelLabel={tr("cancel")}
        onConfirm={() => {
          if (deleting) remove.mutate({ id: deleting.id });
        }}
      />
      {refusal && (
        <OpenWorkDialog
          refusal={refusal}
          onDismiss={() => setRefusal(undefined)}
          onConfirm={({ conversationId }) => {
            setRefusal(undefined);
            remove.mutate({ id: conversationId, cancelOpenWork: true });
          }}
        />
      )}
    </Section>
  );
}
