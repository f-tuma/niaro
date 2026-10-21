import {
  Fragment,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
} from "react";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query";
import { AudioLines, RefreshCw, Search, SearchX, X } from "lucide-react";
import { Badge } from "@admin/components/ui/badge";
import { Button } from "@admin/components/ui/button";
import { Skeleton } from "@admin/components/ui/skeleton";
import { Spinner } from "@admin/components/ui/spinner";
import {
  Alert,
  AlertAction,
  AlertDescription,
} from "@admin/components/ui/alert";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@admin/components/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@admin/components/ui/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@admin/components/ui/item";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@admin/components/ui/toggle-group";
import type { ClientSession } from "../../../../packages/client-core/session";
import {
  CHAT_SEARCH_FILTERS,
  chatSearchOptions,
  highlightParts,
  searchDateLabel,
  type ChatSearchFilter,
} from "../../../../packages/client-core/chat-search";
import { conversationTitle } from "../../../../packages/client-core/conversation-title";
import type { ConversationSummary } from "../../../../packages/protocol";
import type { MeetingList } from "../../../../packages/protocol/meetings";
import { meetingTime } from "../../../../packages/ui-catalog/meeting-format";
import type {
  ChatSearchPage,
  ChatSearchRole,
} from "../../../../packages/protocol/chat-search";
import { useAppSession } from "./context";
import { archivedChatsKey, chatHistoryKey } from "./chat-store";
import { groupChatsByDay, searchChats } from "./chat-history";
import { useHubCopy } from "./hub-copy";
import { listenForKeys } from "./chat-question";
import { useSearchCopy, type SearchCopy } from "./search-copy";

/** Typing settles this long before the server is asked. */
export const SEARCH_DEBOUNCE_MS = 200;

/** One row of the screen: a chat (or a meeting), and where it matched. */
export type SearchRow = {
  conversationId: string;
  /** A meeting row opens the meeting instead of a chat. */
  meetingId?: string;
  /** The message a click opens at; none for a name match or a recent chat. */
  messageId?: string;
  title: string;
  titleRanges: readonly (readonly [number, number])[];
  /** When it happened: the best message, else the chat's last change. */
  at: string;
  archived: boolean;
  snippets: {
    messageId: string;
    role: ChatSearchRole;
    text: string;
    ranges: readonly (readonly [number, number])[];
  }[];
};
type Group = { label?: string; rows: SearchRow[] };

/** Search results as rows: one per chat, its best two matches beneath. */
export function resultRows(
  pages: readonly ChatSearchPage[],
  titleOf: (id: string, title: string) => string,
): SearchRow[] {
  const seen = new Set<string>();
  return pages
    .flatMap((page) => page.results)
    .filter(
      (r) => !seen.has(r.conversation.id) && !!seen.add(r.conversation.id),
    )
    .map((result) => {
      const title = titleOf(result.conversation.id, result.conversation.title);
      const best = result.matches[0];
      return {
        conversationId: result.conversation.id,
        messageId: best?.messageId,
        title,
        // A fallback name was never searched.
        titleRanges:
          title === result.conversation.title ? result.titleRanges : [],
        at: best?.createdAt ?? result.conversation.updatedAt,
        archived: result.conversation.archived,
        snippets: result.matches.slice(0, 2).map((match) => ({
          messageId: match.messageId,
          role: match.role,
          text: match.snippet,
          ranges: match.ranges,
        })),
      };
    });
}

/** Meetings whose name, summary or transcript matched, as rows. */
export function meetingRows(list: MeetingList | undefined): SearchRow[] {
  const matches = new Map(
    (list?.matches ?? []).map((match) => [match.meetingId, match]),
  );
  return (list?.meetings ?? []).slice(0, 5).map((meeting) => {
    const match = matches.get(meeting.id);
    const snippet =
      match && match.field !== "title"
        ? `${match.at !== null ? meetingTime(match.at) + " " : ""}${match.snippet}`
        : "";
    return {
      conversationId: `meeting:${meeting.id}`,
      meetingId: meeting.id,
      title: meeting.title,
      titleRanges: [],
      at: meeting.recordedAt,
      archived: false,
      snippets: snippet
        ? [
            {
              messageId: meeting.id,
              role: "assistant",
              text: snippet,
              ranges: [],
            },
          ]
        : [],
    };
  });
}

const chatRow = (
  conversation: ConversationSummary,
  title: string,
): SearchRow => ({
  conversationId: conversation.id,
  title,
  titleRanges: [],
  at: conversation.updatedAt,
  archived: conversation.readOnly,
  snippets: [],
});

/**
 * `?m=` opens a chat at a message (chat-page scrolls to it). The app's routes
 * aren't the registered (console) router's, whose search types don't know it.
 */
const messageSearch = (messageId?: string) =>
  (messageId ? { m: messageId } : {}) as never;

function useDebounced<T>(value: T, delay: number) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/** `/search`: the person's chats by what was said in them. */
export function SearchPage() {
  const session = useAppSession();
  return <ChatSearch key={session.identityKey} session={session} />;
}

export function ChatSearch({
  session,
  now,
}: {
  session: ClientSession;
  /** The clock for day groups and dates (tests). */
  now?: Date;
}) {
  const { copy, language, days, untitled } = useSearchCopy();
  const hub = useHubCopy();
  const navigate = useNavigate();
  const router = useRouter();
  const identityKey = session.identityKey;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ChatSearchFilter>("all");
  const typed = query.trim();
  const settled = useDebounced(typed, SEARCH_DEBOUNCE_MS);
  // A cleared field shows recent chats at once.
  const words = typed ? settled : "";
  const archive = filter === "archived";

  // Without words: recent chats, the same pages the sidebar and archive read.
  const recent = useInfiniteQuery({
    queryKey: archive
      ? archivedChatsKey(identityKey)
      : chatHistoryKey(identityKey),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      session.readConversations(
        pageParam,
        signal,
        archive ? "archived" : "active",
      ),
    getNextPageParam: (page) => page.nextAfter,
    retry: false,
  });
  const found = useInfiniteQuery({
    queryKey: ["app", "chat-search", identityKey, words, filter] as const,
    enabled: !!words,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      session.searchConversations(
        words,
        { ...chatSearchOptions(filter), after: pageParam },
        signal,
      ),
    getNextPageParam: (page) => page.nextAfter,
    placeholderData: keepPreviousData,
    retry: false,
  });
  // Meetings are a group of their own; an older server just has none.
  const meetings = useQuery({
    queryKey: ["app", "meeting-search", identityKey, words] as const,
    enabled: !!words && filter === "all",
    queryFn: ({ signal }) => session.readMeetings({ query: words, signal }),
    retry: false,
  });
  const failure =
    found.error instanceof Error ? found.error.message : undefined;
  // An older server has no search: its chat names are searched here instead.
  const titlesOnly = failure === "chat_search_unavailable";

  const titleOf = (id: string, title: string) =>
    conversationTitle(title) ||
    (id.startsWith("chat-hub-") ? hub.overview : untitled);
  const seen = new Set<string>();
  const loaded = (
    recent.data?.pages.flatMap((page) => page.conversations) ?? []
  )
    .filter((c) => !seen.has(c.id) && !!seen.add(c.id))
    .filter((c) => c.messageCount > 0)
    .sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    );
  const groups: Group[] = !words
    ? groupChatsByDay(loaded, language, days, now).map((group) => ({
        label: group.label,
        rows: group.conversations.map((c) =>
          chatRow(c, titleOf(c.id, c.title)),
        ),
      }))
    : titlesOnly
      ? [
          {
            rows: searchChats(loaded, words, (c) => titleOf(c.id, c.title)).map(
              (c) => chatRow(c, titleOf(c.id, c.title)),
            ),
          },
        ]
      : [
          {
            rows: resultRows(found.data?.pages ?? [], titleOf),
          },
          {
            label: copy.meetings,
            rows:
              filter === "all" && meetings.data
                ? meetingRows(meetings.data)
                : [],
          },
        ];
  const rows = groups.flatMap((group) => group.rows);

  // The first row is ready for Enter; arrows move from there.
  const [active, setActive] = useState(0);
  const listKey = `${words}\n${filter}`;
  const [shownKey, setShownKey] = useState(listKey);
  if (shownKey !== listKey) {
    setShownKey(listKey);
    setActive(0);
  }
  const current = Math.min(active, rows.length - 1);
  const baseId = useId();
  const optionId = (index: number) => `${baseId}-option-${index}`;
  useEffect(() => {
    if (current < 0) return;
    globalThis.document
      ?.getElementById(optionId(current))
      ?.scrollIntoView?.({ block: "nearest" });
    // optionId only depends on the stable base id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const inputRef = useRef<HTMLInputElement>(null);
  // Ctrl/Cmd+K again (the shell's shortcut to this page) picks the field.
  const onWindowKey = useEffectEvent((event: KeyboardEvent) => {
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === "k"
    ) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  });
  useEffect(() => listenForKeys((event) => onWindowKey(event)), []);

  const open = (row: SearchRow) =>
    void (row.meetingId
      ? navigate({
          to: "/meetings/$meetingId",
          params: { meetingId: row.meetingId },
        })
      : navigate({
          to: "/chat/$conversationId",
          params: { conversationId: row.conversationId },
          search: messageSearch(row.messageId),
        }));
  const leave = () => {
    if (router.history.canGoBack()) router.history.back();
    else void navigate({ to: "/" });
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!rows.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive(Math.min(rows.length - 1, Math.max(0, current + step)));
    } else if (event.key === "Enter") {
      const row = rows[current];
      if (!row) return;
      event.preventDefault();
      open(row);
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (query) setQuery("");
      else leave();
    }
  };

  const pending = words ? !titlesOnly && found.isPending : recent.isPending;
  const failed = words
    ? !!failure && !titlesOnly && failure !== "chat_search_rate_limited"
    : recent.isError;
  const more = words ? !titlesOnly && found.hasNextPage : recent.hasNextPage;
  const fetchingMore = words
    ? found.isFetchingNextPage
    : recent.isFetchingNextPage;
  let index = 0;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <div className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-4 px-4 pt-4 pb-12 md:px-8 md:pt-10">
        <h1 className="sr-only">{copy.search}</h1>
        <div className="sticky top-0 z-10 flex flex-col gap-3 bg-background pt-2 pb-1">
          <InputGroup className="h-12">
            <InputGroupAddon>
              {found.isFetching && words ? (
                <Spinner aria-hidden="true" />
              ) : (
                <Search aria-hidden="true" />
              )}
            </InputGroupAddon>
            <InputGroupInput
              ref={inputRef}
              autoFocus
              type="search"
              role="combobox"
              aria-label={copy.search}
              aria-expanded={rows.length > 0}
              aria-controls={`${baseId}-list`}
              aria-autocomplete="list"
              aria-activedescendant={
                current >= 0 ? optionId(current) : undefined
              }
              placeholder={copy.placeholder}
              maxLength={200}
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onKeyDown}
            />
            {query && (
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-xs"
                  aria-label={copy.clear}
                  onClick={() => {
                    setQuery("");
                    inputRef.current?.focus();
                  }}
                >
                  <X aria-hidden="true" />
                </InputGroupButton>
              </InputGroupAddon>
            )}
          </InputGroup>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            aria-label={copy.filters}
            value={filter}
            onValueChange={(value) => {
              if (value) setFilter(value as ChatSearchFilter);
            }}
            className="flex-wrap"
          >
            {CHAT_SEARCH_FILTERS.map((value) => (
              <ToggleGroupItem key={value} value={value}>
                {copy.filter[value]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        {words && !pending && !failed && (
          <p role="status" className="sr-only">
            {copy.found(rows.length)}
          </p>
        )}
        {words && titlesOnly && (
          <p className="text-xs text-muted-foreground">{copy.titlesOnly}</p>
        )}
        {words && failure === "chat_search_rate_limited" && (
          <p role="status" className="text-xs text-muted-foreground">
            {copy.slowDown}
          </p>
        )}
        {failed ? (
          <Alert variant="destructive">
            <AlertDescription>{copy.failed}</AlertDescription>
            <AlertAction>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void (words ? found.refetch() : recent.refetch())
                }
              >
                <RefreshCw data-icon="inline-start" aria-hidden="true" />
                {copy.retry}
              </Button>
            </AlertAction>
          </Alert>
        ) : pending ? (
          <div
            role="status"
            aria-label={copy.search}
            className="flex flex-col gap-3"
          >
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-2/3" />
          </div>
        ) : rows.length ? (
          <div
            id={`${baseId}-list`}
            role="listbox"
            aria-label={words ? copy.results : copy.recent}
            className="flex flex-col gap-4"
          >
            {groups.map((group, groupIndex) =>
              group.rows.length ? (
                <Fragment key={group.label ?? groupIndex}>
                  <ItemGroup role="group" aria-label={group.label}>
                    {group.label && (
                      <p className="px-3 pb-1 text-xs font-medium text-muted-foreground">
                        {group.label}
                      </p>
                    )}
                    {group.rows.map((row) => {
                      const position = index++;
                      return (
                        <ResultRow
                          key={row.conversationId}
                          id={optionId(position)}
                          row={row}
                          active={position === current}
                          copy={copy}
                          date={searchDateLabel(row.at, language, days, now)}
                          onHover={() => setActive(position)}
                        />
                      );
                    })}
                  </ItemGroup>
                </Fragment>
              ) : null,
            )}
          </div>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                {words ? (
                  <SearchX aria-hidden="true" />
                ) : (
                  <Search aria-hidden="true" />
                )}
              </EmptyMedia>
              <EmptyTitle>
                {words
                  ? copy.noResults
                  : archive
                    ? copy.noArchived
                    : copy.noChats}
              </EmptyTitle>
            </EmptyHeader>
          </Empty>
        )}
        {more && !failed && (
          <Button
            variant="ghost"
            size="sm"
            className="self-center"
            disabled={fetchingMore}
            onClick={() =>
              void (words ? found.fetchNextPage() : recent.fetchNextPage())
            }
          >
            {copy.more}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Plain text with its matched parts marked; never markup from the server. */
export function Highlighted({
  text,
  ranges,
}: {
  text: string;
  ranges: readonly (readonly [number, number])[];
}) {
  return highlightParts(text, ranges).map((part, index) =>
    part.match ? (
      <mark
        key={index}
        className="bg-transparent font-semibold text-foreground"
      >
        {part.text}
      </mark>
    ) : (
      <Fragment key={index}>{part.text}</Fragment>
    ),
  );
}

function ResultRow({
  id,
  row,
  active,
  copy,
  date,
  onHover,
}: {
  id: string;
  row: SearchRow;
  active: boolean;
  copy: SearchCopy;
  date: string;
  onHover: () => void;
}) {
  const body = (
    <>
      {row.meetingId && (
        <ItemMedia>
          <AudioLines aria-hidden="true" />
        </ItemMedia>
      )}
      <ItemContent>
        <ItemTitle>
          <span className="truncate">
            <Highlighted text={row.title} ranges={row.titleRanges} />
          </span>
        </ItemTitle>
        {row.snippets.map((snippet) => (
          <ItemDescription key={snippet.messageId}>
            <span className="sr-only">
              {snippet.role === "user" ? copy.you : copy.assistant}:{" "}
            </span>
            <Highlighted text={snippet.text} ranges={snippet.ranges} />
          </ItemDescription>
        ))}
      </ItemContent>
      <ItemActions className="self-start">
        {row.archived && <Badge variant="secondary">{copy.archived}</Badge>}
        <time
          dateTime={row.at}
          className="text-xs whitespace-nowrap text-muted-foreground tabular-nums"
        >
          {date}
        </time>
      </ItemActions>
    </>
  );
  const props = {
    id,
    role: "option",
    "aria-selected": active,
    onMouseMove: active ? undefined : onHover,
    "data-testid": row.meetingId ? "search-meeting" : "search-result",
  };
  return (
    <Item asChild variant="option" size="sm">
      {row.meetingId ? (
        <Link
          {...props}
          to="/meetings/$meetingId"
          params={{ meetingId: row.meetingId }}
        >
          {body}
        </Link>
      ) : (
        <Link
          {...props}
          to="/chat/$conversationId"
          params={{ conversationId: row.conversationId }}
          search={messageSearch(row.messageId)}
        >
          {body}
        </Link>
      )}
    </Item>
  );
}
