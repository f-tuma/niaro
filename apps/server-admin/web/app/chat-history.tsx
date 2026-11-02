import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEvent,
  type KeyboardEvent,
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
import { useToast } from "@admin/components/ui/toast";
import {
  conversationNamesKey,
  loadConversationPins,
  saveConversationPins,
} from "../../../../packages/client-core/conversation-preferences";
import { useHubCopy } from "./hub-copy";
import { conversationTitle } from "../../../../packages/client-core/conversation-title";
import type { KeyValueStorage } from "../../../../packages/client-core/preferences";
import { runningChat } from "../../../../packages/client-core/chat-view";
import type { ClientSession } from "../../../../packages/client-core/session";
import { groupChatsByDay } from "../../../../packages/client-core/chat-days";
import {
  archivableConversation,
  type ConversationHistoryPage,
  type ConversationSummary,
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

// Today, Yesterday, Previous 7 days, then months: shared with the phone.
export { groupChatsByDay };

/** The name a chat is shown under, in the sidebar and in its own header. */
export function useChatTitle() {
  const { tr } = useChatCopy();
  const hub = useHubCopy();
  return (conversation: Pick<ConversationSummary, "id" | "title">) =>
    conversationTitle(conversation.title) ||
    // A hub item's runs are followed in its own chat, which has no message title.
    (conversation.id.startsWith("chat-hub-")
      ? hub.overview
      : tr("untitledChat"));
}

/** The chat as the sidebar's list last read it, when it is loaded there. */
export function useListedChat(id: string) {
  const { session } = useApp();
  const client = useQueryClient();
  const identityKey = session?.identityKey ?? "";
  const subscribe = useCallback(
    (listener: () => void) => client.getQueryCache().subscribe(listener),
    [client],
  );
  const data = useSyncExternalStore(subscribe, () =>
    client.getQueryData<InfiniteData<ConversationHistoryPage>>(
      chatHistoryKey(identityKey),
    ),
  );
  return data?.pages
    .flatMap((page) => page.conversations)
    .find((conversation) => conversation.id === id);
}

/** A chat a menu acts on: its id and the name it is shown under. */
export type ChatMenuTarget = { id: string; title: string };

/**
 * Rename, pin, archive and delete for one chat, shared by the sidebar's rows
 * and the chat's header. The list shows a change at once; the server's answer
 * settles it. An archive offers Undo in the app's toast; a delete is
 * confirmed first, and work waiting in the chat is named before either.
 */
export function useChatActions(given?: ClientSession) {
  const app = useApp();
  const session = given ?? app.session;
  const { copy, tr } = useChatCopy();
  const client = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const path = useRouterState({ select: (state) => state.location.pathname });
  const activeId = path.startsWith("/chat/")
    ? decodeURIComponent(path.slice("/chat/".length))
    : null;
  const identityKey = session?.identityKey ?? "";
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
  const [failure, setFailure] = useState<string | null>(null);
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
  /** Brings an archived chat back; it outlives the header that archived it. */
  const undoArchive = async (id: string, reopen: boolean) => {
    if (!session) return;
    try {
      await session.restoreConversation(id, crypto.randomUUID());
    } catch (error) {
      failed(error);
      return;
    }
    void client.invalidateQueries({ queryKey: chatHistoryKey(identityKey) });
    void client.invalidateQueries({ queryKey: archivedChatsKey(identityKey) });
    if (reopen)
      void navigate({
        to: "/chat/$conversationId",
        params: { conversationId: id },
      });
  };
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
      const open = id === activeId;
      if (open) void navigate({ to: "/" });
      toast?.undo(copy.chatArchived, () => void undoArchive(id, open));
    },
  });
  const [deleting, setDeleting] = useState<ChatMenuTarget>();
  const pinned = pins.data ?? [];
  const dialogs = (
    <>
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
                  {deleting.title}
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
    </>
  );
  return {
    session,
    activeId,
    failure,
    pinned,
    pinsReady: pins.isSuccess && !togglePin.isPending,
    togglePin: (id: string) => togglePin.mutate(id),
    /** Names the chat for all devices; an empty name brings the title back. */
    rename: (id: string, name: string) => rename.mutate({ id, name }),
    /** Undefined for a chat that cannot be archived (a hub item's chat). */
    archive: (id: string) =>
      archivableConversation(id) ? () => archive.mutate({ id }) : undefined,
    requestDelete: (target: ChatMenuTarget) => setDeleting(target),
    /** The delete confirmation and the open-work question; render once. */
    dialogs,
  };
}

/**
 * The props of a field that renames a chat in place: Enter or leaving it
 * saves a changed name, Escape keeps the old one.
 */
export function chatNameField(
  title: string,
  label: string,
  onRename: (name: string) => void,
  onDone: () => void,
) {
  return {
    autoFocus: true,
    "aria-label": label,
    defaultValue: title,
    placeholder: title,
    maxLength: 160,
    onFocus: (event: FocusEvent<HTMLInputElement>) =>
      event.currentTarget.select(),
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        if (event.currentTarget.value.trim() !== title)
          onRename(event.currentTarget.value);
        onDone();
      } else if (event.key === "Escape") {
        event.preventDefault();
        onDone();
      }
    },
    onBlur: (event: FocusEvent<HTMLInputElement>) => {
      if (event.currentTarget.value.trim() !== title)
        onRename(event.currentTarget.value);
      onDone();
    },
  };
}

/** The items of a chat's `…` menu, the same in the sidebar and the header. */
export function ChatMenuItems({
  pinned,
  pinsReady,
  onRename,
  onTogglePin,
  onArchive,
  onDelete,
}: {
  pinned: boolean;
  pinsReady: boolean;
  onRename: () => void;
  onTogglePin: () => void;
  /** Absent for a hub item's chat. */
  onArchive?: () => void;
  onDelete: () => void;
}) {
  const { copy, tr } = useChatCopy();
  return (
    <>
      <DropdownMenuItem onSelect={onRename}>
        <Pencil aria-hidden="true" />
        {copy.renameChat}
      </DropdownMenuItem>
      <DropdownMenuItem disabled={!pinsReady} onSelect={onTogglePin}>
        {pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
        {tr(pinned ? "unpinChat" : "pinChat")}
      </DropdownMenuItem>
      {onArchive && (
        <DropdownMenuItem onSelect={onArchive}>
          <Archive aria-hidden="true" />
          {tr("archiveChat")}
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onSelect={onDelete}>
        <Trash2 aria-hidden="true" />
        {tr("deleteChat")}
      </DropdownMenuItem>
    </>
  );
}

/**
 * Recent chats in the sidebar: pinned first, then by day. Opening, sorting
 * and pinning never touch the conversations themselves.
 */
export function ChatHistoryNav() {
  const { session } = useApp();
  const { copy, tr, language } = useChatCopy();
  const client = useQueryClient();
  const actions = useChatActions();
  const { activeId } = actions;
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
  const titleOf = useChatTitle();
  if (!session) return null;
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
  const pinned = actions.pinned;
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
      {actions.failure && (
        <p role="alert" className="px-4 text-xs text-destructive">
          {actions.failure}
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
                  {group.conversations.map((conversation) => {
                    const title = titleOf(conversation);
                    return (
                      <ChatRow
                        key={conversation.id}
                        conversation={conversation}
                        title={title}
                        onRename={(name) =>
                          actions.rename(conversation.id, name)
                        }
                        onDelete={() =>
                          actions.requestDelete({ id: conversation.id, title })
                        }
                        onArchive={actions.archive(conversation.id)}
                        active={conversation.id === activeId}
                        running={conversation.id === runningId}
                        pinned={pinned.includes(conversation.id)}
                        pinsReady={actions.pinsReady}
                        copy={copy}
                        onTogglePin={() => actions.togglePin(conversation.id)}
                      />
                    );
                  })}
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
      {actions.dialogs}
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
          {...chatNameField(title, copy.chatName, onRename, () =>
            setEditing(false),
          )}
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
          <span className="min-w-0 flex-1 truncate">{title}</span>
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
          <ChatMenuItems
            pinned={pinned}
            pinsReady={pinsReady}
            onRename={() => {
              renaming.current = true;
              setEditing(true);
            }}
            onTogglePin={onTogglePin}
            onArchive={onArchive}
            onDelete={onDelete}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}
