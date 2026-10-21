import { useEffect, useState } from "react";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AudioLines, ChevronRight, RefreshCw } from "lucide-react";
import { Button } from "@admin/components/ui/button";
import { Card } from "@admin/components/ui/card";
import { Skeleton } from "@admin/components/ui/skeleton";
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
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@admin/components/ui/item";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@admin/components/ui/toggle-group";
import { PageHeader } from "@admin/components/console/page";
import { StatusBadge } from "@admin/components/console/status";
import { EntityIcon } from "@admin/components/console/entity-icon";
import { SearchField } from "@admin/components/console/forms";
import type { ClientSession } from "../../../../packages/client-core/session";
import type {
  Meeting,
  MeetingMatch,
} from "../../../../packages/protocol/meetings";
import { meetingTime } from "../../../../packages/ui-catalog/meeting-format";
import { translate } from "../../../../packages/i18n";
import { useApp, useAppSession } from "./context";
import { MenuPage } from "./menu-page";
import {
  filterMeetings,
  meetingMeta,
  meetingsRefetchInterval,
  meetingTone,
  meetingsKey,
  type MeetingFilter,
} from "./meetings-list";
import {
  MeetingCaptureActions,
  MeetingRecordingPanel,
  UnsentMeetings,
} from "./meeting-recorder";
import {
  meetingErrorText,
  useMeetingsCopy,
  type MeetingsCopy,
} from "./meetings-copy";

/** Recorded and uploaded meetings, like the Meetings tab of the app. */
export function MeetingsPage() {
  const session = useAppSession();
  return <MeetingLibrary key={session.identityKey} session={session} />;
}

/** Typing settles this long before the server searches. */
export const MEETING_SEARCH_DEBOUNCE_MS = 250;
function useDebounced<T>(value: T, delay: number) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

function MeetingLibrary({ session }: { session: ClientSession }) {
  const { language } = useApp();
  const copy = useMeetingsCopy();
  const tr = translate(language);
  const client = useQueryClient();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<MeetingFilter>("all");
  const typed = search.trim();
  const settled = useDebounced(typed, MEETING_SEARCH_DEBOUNCE_MS);
  const words = typed ? settled : "";
  const query = useQuery({
    queryKey: meetingsKey(session),
    queryFn: ({ signal }) => session.readMeetings({ openTasks: true, signal }),
    // Only an upload or processing changes a meeting by itself.
    refetchInterval: (current) =>
      meetingsRefetchInterval(current.state.data?.meetings),
    retry: false,
  });
  // Names, summaries and transcripts are searched on the server.
  const found = useQuery({
    queryKey: [...meetingsKey(session), "search", words],
    enabled: !!words,
    queryFn: ({ signal }) =>
      session.readMeetings({ query: words, openTasks: true, signal }),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const meetings = query.data?.meetings ?? [];
  // An older server can't search: its names are filtered here instead.
  const searched = words && !found.isError ? found.data : undefined;
  const shown = filterMeetings(
    searched ? searched.meetings : meetings,
    searched ? "" : search,
    filter,
  );
  const openTasks = { ...query.data?.openTasks, ...searched?.openTasks };
  const matches = new Map(
    (searched?.matches ?? []).map((match) => [match.meetingId, match]),
  );
  const refresh = () =>
    void client.invalidateQueries({ queryKey: meetingsKey(session) });

  return (
    <MenuPage>
      <PageHeader
        title={copy.meetings}
        count={meetings.length || undefined}
        toolbar={
          meetings.length > 0 && (
            <>
              <SearchField
                value={search}
                onChange={setSearch}
                placeholder={copy.search}
              />
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={filter}
                aria-label={copy.filter}
                onValueChange={(value) =>
                  value && setFilter(value as MeetingFilter)
                }
              >
                <ToggleGroupItem value="all">{copy.filterAll}</ToggleGroupItem>
                <ToggleGroupItem value="processing">
                  {copy.filterProcessing}
                </ToggleGroupItem>
                <ToggleGroupItem value="ready">
                  {copy.filterReady}
                </ToggleGroupItem>
                <ToggleGroupItem value="failed">
                  {copy.filterFailed}
                </ToggleGroupItem>
              </ToggleGroup>
            </>
          )
        }
        actions={
          <MeetingCaptureActions session={session} onUploaded={refresh} />
        }
      />
      <MeetingRecordingPanel session={session} onUploaded={refresh} />
      <UnsentMeetings session={session} onUploaded={refresh} />
      {query.isError ? (
        <Alert variant="destructive">
          <AlertDescription>
            {meetingErrorText(
              query.error instanceof Error
                ? query.error.message
                : "meeting_connection_failed",
              copy,
              language,
            )}
          </AlertDescription>
          <AlertAction>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void query.refetch()}
            >
              <RefreshCw data-icon="inline-start" aria-hidden="true" />
              {copy.retry}
            </Button>
          </AlertAction>
        </Alert>
      ) : query.isPending ? (
        <div role="status" aria-label={copy.meetings}>
          <Skeleton className="h-40 w-full" />
        </div>
      ) : !meetings.length ? (
        <Empty variant="outline">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <AudioLines />
            </EmptyMedia>
            <EmptyTitle>{tr("meetingsEmptyTitle")}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : shown.length ? (
        <Card variant="list" aria-label={copy.meetings}>
          {shown.map((meeting) => (
            <MeetingRow
              key={meeting.id}
              meeting={meeting}
              openTasks={openTasks[meeting.id] ?? 0}
              match={matches.get(meeting.id)}
              copy={copy}
              language={language}
            />
          ))}
        </Card>
      ) : words && found.isFetching ? (
        <p role="status" className="text-sm text-muted-foreground">
          {copy.searching}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">{copy.noMatch}</p>
      )}
    </MenuPage>
  );
}

/** One meeting: name (with a badge only for an exception), when and how
 * long, open tasks on the right; a search adds where it matched. */
function MeetingRow({
  meeting,
  openTasks,
  match,
  copy,
  language,
}: {
  meeting: Meeting;
  openTasks: number;
  match?: MeetingMatch;
  copy: MeetingsCopy;
  language: "en" | "cs";
}) {
  const tr = translate(language);
  const tone = meetingTone[meeting.status];
  return (
    <Item asChild variant="row" size="row">
      <Link to="/meetings/$meetingId" params={{ meetingId: meeting.id }}>
        <ItemMedia>
          <EntityIcon size="sm" tone="muted">
            <AudioLines />
          </EntityIcon>
        </ItemMedia>
        <ItemContent>
          <ItemTitle>
            <span className="truncate">{meeting.title}</span>
            {tone && (
              <StatusBadge tone={tone}>
                {tr(`meetingPill_${meeting.status}`)}
              </StatusBadge>
            )}
          </ItemTitle>
          <ItemDescription>
            {meeting.failure
              ? meetingErrorText(meeting.failure, copy, language)
              : meetingMeta(meeting, language)}
          </ItemDescription>
          {match && match.field !== "title" && (
            <ItemDescription data-testid="meeting-match">
              {match.at !== null && (
                <span className="tabular-nums">{meetingTime(match.at)} </span>
              )}
              {match.snippet}
            </ItemDescription>
          )}
        </ItemContent>
        <ItemActions>
          {openTasks > 0 && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {copy.openTaskCount(openTasks)}
            </span>
          )}
          <ChevronRight
            aria-hidden="true"
            className="size-4 text-muted-foreground"
          />
        </ItemActions>
      </Link>
    </Item>
  );
}
