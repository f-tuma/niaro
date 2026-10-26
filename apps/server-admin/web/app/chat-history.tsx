import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import {
  Archive,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from "lucide-react";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarInput,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from "@admin/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@admin/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@admin/components/ui/alert-dialog";
import { Button } from "@admin/components/ui/button";
import { Spinner } from "@admin/components/ui/spinner";
import {
  conversationNamesKey,
  loadConversationPins,
  saveConversationPins,
} from "../../../../packages/client-core/conversation-preferences";
import { useHubCopy } from "./hub-copy";
import { conversationTitle } from "../../../../packages/client-core/conversation-title";
import type { KeyValueStorage } from "../../../../packages/client-core/preferences";
import { runningChat } from "../../../../packages/client-core/chat-view";
import {
  archivableConversation,
  type ConversationHistoryPage,
  type ConversationSummary,
  type Language,
} from "../../../../packages/protocol";
import { useApp } from "./context";
import { chatChangeError, useChatCopy, type ChatCopy } from "./chat-copy";
import {
  OpenWorkDialog,
  openWorkRefusal,
  type OpenWorkRefusal,
} from "./open-work-dialog";
import { archivedChatsKey, chatHistoryKey } from "./chat-store";

/** Pins are presentation ids only; they stay in this browser. */
const browserStorage: KeyValueStorage = {
  getItem: async (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: async (key, value) => {
    localStorage.setItem(key, value);
  },
};

/** Case and accents don't matter when searching chat titles. */
const fold = (value: string) =>
  value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
/** Chats whose shown title contains every word of the query. */
/** A delete or archive press; `cancelOpenWork` after the person agreed. */
type DirectoryChange = { id: string; cancelOpenWork?: boolean };
export function searchChats<T extends { id: string }>(
  rows: T[],
  query: string,
  title: (row: T) => string,
) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return rows;
  return rows.filter((row) => {
    const shown = fold(title(row));
    return words.every((word) => shown.includes(word));
  });
}

const capitalize = (text: string) =>
  text.charAt(0).toLocaleUpperCase() + text.slice(1);

/** Today, Yesterday, Previous 7 days, then by month; input stays newest first. */
export function groupChatsByDay(
  conversations: ConversationSummary[],
  language: Language,
  labels: { today: string; yesterday: string; lastWeek: string },
  now = new Date(),
) {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  // Calendar days, not 24-hour spans: a daylight-saving night is 23 or 25 hours.
  const daysAgo = (n: number) => {
    const date = new Date(startOfToday);
    date.setDate(date.getDate() - n);
    return date.getTime();
  };
  const startOfYesterday = daysAgo(1),
    startOfLastWeek = daysAgo(7);
  const groups: { label: string; conversations: ConversationSummary[] }[] = [];
  for (const conversation of conversations) {
    const date = new Date(conversation.updatedAt);
    const at = date.getTime();
    const label =
      at >= startOfToday.getTime()
        ? labels.today
        : at >= startOfYesterday
          ? labels.yesterday
          : at >= startOfLastWeek
            ? labels.lastWeek
            : capitalize(
                date.toLocaleDateString(language === "cs" ? "cs-CZ" : "en-GB", {
                  month: "long",
                  ...(date.getFullYear() === startOfToday.getFullYear()
                    ? {}
                    : { year: "numeric" }),
                }),
              );
    const last = groups.at(-1);
    if (last?.label === label) last.conversations.push(conversation);
    else groups.push({ label, conversations: [conversation] });
  }
  return groups;
}

/**
 * Recent chats in the sidebar: pinned first, then by day. Opening, sorting
 * and pinning never touch the conversations themselves.
 */
export function ChatHistoryNav() {
  const { session } = useApp();
  const { copy, tr, language } = useChatCopy();
  const client = useQueryClient();
  const path = useRouterState({ select: (state) => state.location.pathname });
  const activeId = path.startsWith("/chat/")
    ? decodeURIComponent(path.slice("/chat/".length))
    : null;
  const identityKey = session?.identityKey ?? "";
  const chats = useInfiniteQuery({
    queryKey: chatHistoryKey(identityKey),
    enabled: !!session,
    initialPageParam: null as string | null,
    // Archived chats live in the account's archive, not here.
    queryFn: ({ pageParam, signal }) =>
      session!.readConversations(pageParam, signal, "active"),
    getNextPageParam: (page) => page.nextAfter,
  });
  const pinsKey = ["app", "chat-pins", identityKey] as const;
  const pins = useQuery({
    queryKey: pinsKey,
    enabled: !!session,
    queryFn: () => loadConversationPins(browserStorage, identityKey),
  });
  const togglePin = useMutation({
    mutationFn: async (id: string) => {
      const current = pins.data ?? [];
      const next = current.includes(id)
        ? current.filter((value) => value !== id)
        : [...current, id];
      await saveConversationPins(browserStorage, identityKey, next);
      return next;
    },
    onSuccess: (next) => client.setQueryData(pinsKey, next),
  });
  // Names used to live in this browser only; the server holds them now.
  useEffect(() => {
    if (!identityKey) return;
    try {
      localStorage.removeItem(conversationNamesKey(identityKey));
    } catch {
      /* Nothing to drop where storage is unavailable. */
    }
  }, [identityKey]);
  // Renames and deletions from another device arrive as a new snapshot.
  const subscribe = useCallback(
    (listener: () => void) => session?.subscribe(listener) ?? (() => {}),
    [session],
  );
  const directoryVersion = useSyncExternalStore(
    subscribe,
    () => session?.getDirectoryVersion() ?? 0,
    () => 0,
  );
  useEffect(() => {
    if (directoryVersion)
      void client.invalidateQueries({ queryKey: chatHistoryKey(identityKey) });
  }, [directoryVersion, client, identityKey]);
  // The chat whose answer is on its way.
  const runningId = useSyncExternalStore(
    subscribe,
    () => (session ? runningChat(session.getSnapshot()) : null),
    () => null,
  );
  const navigate = useNavigate();
  const [failure, setFailure] = useState<string | null>(null);
  /** The list shows the change at once; the server's answer settles it. */
  const editRows = (
    edit: (rows: ConversationSummary[]) => ConversationSummary[],
  ) =>
    client.setQueryData<InfiniteData<ConversationHistoryPage>>(
      chatHistoryKey(identityKey),
      (data) =>
        data && {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            conversations: edit(page.conversations),
          })),
        },
    );
  const failed = (error: unknown) => {
    setFailure(tr(chatChangeError(error)));
    void client.invalidateQueries({ queryKey: chatHistoryKey(identityKey) });
  };
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      session!.renameConversation(id, name, crypto.randomUUID()),
    onMutate: ({ id, name }) => {
      setFailure(null);
      // An empty name brings back the server's title, which the list re-reads.
      if (name.trim())
        editRows((rows) =>
          rows.map((row) =>
            row.id === id ? { ...row, title: name.trim() } : row,
          ),
        );
    },
    onError: failed,
    onSuccess: () =>
      void client.invalidateQueries({ queryKey: chatHistoryKey(identityKey) }),
  });
  const [refusal, setRefusal] = useState<OpenWorkRefusal>();
  const refused =
    (action: OpenWorkRefusal["action"]) =>
    (error: unknown, { id }: { id: string }) => {
      const open = openWorkRefusal(error, id, action);
      if (open) setRefusal(open);
      else failed(error);
    };
  const remove = useMutation({
    mutationFn: ({ id, cancelOpenWork }: DirectoryChange) =>
      cancelOpenWork
        ? session!.deleteConversation(id, crypto.randomUUID(), {
            cancelOpenWork,
          })
        : session!.deleteConversation(id, crypto.randomUUID()),
    onMutate: () => setFailure(null),
    onError: refused("delete"),
    onSuccess: (_, { id }) => {
      editRows((rows) => rows.filter((row) => row.id !== id));
      if ((pins.data ?? []).includes(id)) togglePin.mutate(id);
      if (id === activeId) void navigate({ to: "/" });
    },
  });
  const archive = useMutation({
    mutationFn: ({ id, cancelOpenWork }: DirectoryChange) =>
      cancelOpenWork
        ? session!.archiveConversation(id, crypto.randomUUID(), {
            cancelOpenWork,
          })
        : session!.archiveConversation(id, crypto.randomUUID()),
    onMutate: () => setFailure(null),
    onError: refused("archive"),
    onSuccess: (_, { id }) => {
      editRows((rows) => rows.filter((row) => row.id !== id));
      // The archive (account page) lists it now.
      void client.invalidateQueries({
        queryKey: archivedChatsKey(identityKey),
      });
      if (id === activeId) void navigate({ to: "/" });
    },
  });
  const [deleting, setDeleting] = useState<ConversationSummary>();
  const hub = useHubCopy();
  if (!session) return null;
  const titleOf = (conversation: ConversationSummary) =>
    conversationTitle(conversation.title) ||
    // A hub item's runs are followed in its own chat, which has no message title.
    (conversation.id.startsWith("chat-hub-")
      ? hub.overview
      : tr("untitledChat"));
  const seen = new Set<string>();
  const loaded = (chats.data?.pages.flatMap((page) => page.conversations) ?? [])
    .filter((c) => !c.readOnly && !seen.has(c.id) && !!seen.add(c.id))
    // An empty chat (e.g. the app's default one) isn't worth a history row,
    // unless it is the one open right now.
    .filter((c) => c.messageCount > 0 || c.id === activeId)
    .sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    );
  // Search has its own screen (/search, "Search" above).
  const rows = loaded;
  const pinned = pins.data ?? [];
  const groups = [
    ...(rows.some((c) => pinned.includes(c.id))
      ? [
          {
            label: copy.pinned,
            conversations: rows.filter((c) => pinned.includes(c.id)),
          },
        ]
      : []),
    ...groupChatsByDay(
      rows.filter((c) => !pinned.includes(c.id)),
      language,
      {
        today: tr("chatsToday"),
        yesterday: tr("chatsYesterday"),
        lastWeek: tr("chatsLastWeek"),
      },
    ),
  ];
  return (
    <nav
      aria-label={copy.chats}
      className="contents group-data-[collapsible=icon]:hidden"
    >
      {failure && (
        <p role="alert" className="px-4 text-xs text-destructive">
          {failure}
        </p>
      )}
      {chats.isPending ? (
        <SidebarGroup>
          <SidebarGroupLabel>{copy.chats}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {[0, 1, 2].map((index) => (
                <SidebarMenuItem key={index}>
                  <SidebarMenuSkeleton />
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ) : chats.isError && !rows.length ? (
        <SidebarGroup>
          <SidebarGroupLabel>{copy.chats}</SidebarGroupLabel>
          <SidebarGroupContent>
            <p className="px-2 text-xs text-muted-foreground">
              {copy.historyFailed}
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="mt-1"
              onClick={() => void chats.refetch()}
            >
              {copy.retry}
            </Button>
          </SidebarGroupContent>
        </SidebarGroup>
      ) : (
        groups.map((group) => (
          <Fragment key={group.label}>
            <SidebarGroup>
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.conversations.map((conversation) => (
                    <ChatRow
                      key={conversation.id}
                      conversation={conversation}
                      title={titleOf(conversation)}
                      onRename={(name) =>
                        rename.mutate({ id: conversation.id, name })
                      }
                      onDelete={() => setDeleting(conversation)}
                      onArchive={
                        archivableConversation(conversation.id)
                          ? () => archive.mutate({ id: conversation.id })
                          : undefined
                      }
                      active={conversation.id === activeId}
                      running={conversation.id === runningId}
                      pinned={pinned.includes(conversation.id)}
                      pinsReady={pins.isSuccess && !togglePin.isPending}
                      copy={copy}
                      archiveLabel={tr("archiveChat")}
                      deleteLabel={tr("deleteChat")}
                      pinLabel={tr(
                        pinned.includes(conversation.id)
                          ? "unpinChat"
                          : "pinChat",
                      )}
                      onTogglePin={() => togglePin.mutate(conversation.id)}
                    />
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </Fragment>
        ))
      )}
      {chats.hasNextPage && (
        <SidebarGroup>
          <Button
            variant="ghost"
            size="sm"
            disabled={chats.isFetchingNextPage}
            onClick={() => void chats.fetchNextPage()}
          >
            {copy.showMore}
          </Button>
        </SidebarGroup>
      )}
      <AlertDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tr("deleteChatTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting && (
                <span className="font-medium text-foreground">
                  {titleOf(deleting)}
                </span>
              )}{" "}
              {tr("deleteChatHint")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tr("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleting) remove.mutate({ id: deleting.id });
              }}
            >
              {tr("deleteChat")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {refusal && (
        <OpenWorkDialog
          refusal={refusal}
          onDismiss={() => setRefusal(undefined)}
          onConfirm={({ conversationId, action }) => {
            setRefusal(undefined);
            (action === "archive" ? archive : remove).mutate({
              id: conversationId,
              cancelOpenWork: true,
            });
          }}
        />
      )}
    </nav>
  );
}

function ChatRow({
  conversation,
  title,
  active,
  running,
  pinned,
  pinsReady,
  copy,
  archiveLabel,
  pinLabel,
  deleteLabel,
  onTogglePin,
  onRename,
  onArchive,
  onDelete,
}: {
  conversation: ConversationSummary;
  title: string;
  active: boolean;
  /** Its answer is on its way. */
  running: boolean;
  pinned: boolean;
  pinsReady: boolean;
  copy: ChatCopy;
  archiveLabel: string;
  pinLabel: string;
  deleteLabel: string;
  onTogglePin: () => void;
  /** Names the chat for all devices; an empty name brings the title back. */
  onRename: (name: string) => void;
  /** Moves the chat into the archive; absent for a hub item's chat. */
  onArchive?: () => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  // The menu would take the focus back from the name field as it closes.
  const renaming = useRef(false);
  if (editing)
    return (
      <SidebarMenuItem>
        <SidebarInput
          autoFocus
          aria-label={copy.chatName}
          defaultValue={title}
          placeholder={title}
          maxLength={160}
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (event.currentTarget.value.trim() !== title)
                onRename(event.currentTarget.value);
              setEditing(false);
            } else if (event.key === "Escape") {
              event.preventDefault();
              setEditing(false);
            }
          }}
          onBlur={(event) => {
            if (event.currentTarget.value.trim() !== title)
              onRename(event.currentTarget.value);
            setEditing(false);
          }}
        />
      </SidebarMenuItem>
    );
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active}>
        <Link
          to="/chat/$conversationId"
          params={{ conversationId: conversation.id }}
          aria-current={active ? "page" : undefined}
          title={title}
        >
          {running && (
            <Spinner aria-label={copy.answering} className="size-3 shrink-0" />
          )}
          <span className="truncate">{title}</span>
        </Link>
      </SidebarMenuButton>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction showOnHover aria-label={copy.chatOptions}>
            <MoreHorizontal aria-hidden="true" />
          </SidebarMenuAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="right"
          align="start"
          onCloseAutoFocus={(event) => {
            if (!renaming.current) return;
            renaming.current = false;
            event.preventDefault();
          }}
        >
          <DropdownMenuItem
            onSelect={() => {
              renaming.current = true;
              setEditing(true);
            }}
          >
            <Pencil aria-hidden="true" />
            {copy.renameChat}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!pinsReady} onSelect={onTogglePin}>
            {pinned ? (
              <PinOff aria-hidden="true" />
            ) : (
              <Pin aria-hidden="true" />
            )}
            {pinLabel}
          </DropdownMenuItem>
          {onArchive && (
            <DropdownMenuItem onSelect={onArchive}>
              <Archive aria-hidden="true" />
              {archiveLabel}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onDelete}>
            <Trash2 aria-hidden="true" />
            {deleteLabel}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}
