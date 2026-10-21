import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  CalendarClock,
  ClipboardList,
  Copy,
  Download,
  MessageSquare,
  Play,
  Quote,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  UserRound,
  VolumeX,
} from "lucide-react";
import { Button } from "@admin/components/ui/button";
import { Card, CardContent } from "@admin/components/ui/card";
import { Input } from "@admin/components/ui/input";
import { Progress } from "@admin/components/ui/progress";
import { Skeleton } from "@admin/components/ui/skeleton";
import { Spinner } from "@admin/components/ui/spinner";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@admin/components/ui/alert";
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
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@admin/components/ui/dropdown-menu";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@admin/components/ui/item";
import { PageHeader, Section } from "@admin/components/console/page";
import { StatusBadge } from "@admin/components/console/status";
import { ConfirmAction, MoreActions } from "@admin/components/console/forms";
import type { ClientSession } from "../../../../packages/client-core/session";
import {
  meetingSpeakerLabels,
  type Meeting,
  type MeetingSegment,
} from "../../../../packages/protocol/meetings";
import type { MeetingRecord } from "../../../../packages/protocol/meeting-record";
import {
  meetingNotes,
  type MeetingNoteItem,
  type MeetingUtterance,
} from "../../../../packages/protocol/meeting-notes";
import { translate } from "../../../../packages/i18n";
import {
  cleanTranscriptForReading,
  meetingTime,
} from "../../../../packages/ui-catalog/meeting-format";
import { useApp, useAppSession } from "./context";
import { MenuPage } from "./menu-page";
import { MeetingPlayer } from "./meeting-player";
import {
  paragraphAt,
  transcriptBlocks,
  type TranscriptBlock,
} from "./meeting-transcript-view";
import { MeetingProcessSheet } from "./meeting-process";
import { UNSAVED_DRAFT, draftKey, saveDraft } from "./chat-store";
import {
  meetingDay,
  meetingMarkdown,
  meetingMeta,
  meetingTone,
  meetingTranscriptText,
  meetingsKey,
  type SpeakerNames,
} from "./meetings-list";
import {
  meetingErrorText,
  useMeetingsCopy,
  type MeetingsCopy,
} from "./meetings-copy";

type Source = { segment: number; quote: string };
const busy = (status: Meeting["status"]) =>
  status === "transcribing" || status === "analyzing";
/** Still changing on the server: keep reading it. */
const settling = (record: MeetingRecord | undefined) =>
  !record ||
  ["uploading", "transcribing", "analyzing"].includes(record.meeting.status);
/** The owner can still play the sound of this meeting. */
const playable = (meeting: Meeting) =>
  meeting.status === "ready" && !!meeting.sourceHash && !meeting.audioDeletedAt;

/** One meeting: notes on the left, the transcript and its player on the right. */
export function MeetingDetailPage() {
  const session = useAppSession();
  const { meetingId } = useParams({ strict: false }) as { meetingId: string };
  return (
    <MeetingDetail
      key={`${session.identityKey}:${meetingId}`}
      session={session}
      id={meetingId}
    />
  );
}

/**
 * The meeting's sound, read only when the person plays it or jumps to a
 * time (a recording is tens of MB). Jumps wait until the player is ready.
 */
function useMeetingPlayer(session: ClientSession, id: string) {
  const [url, setUrl] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "ready" | "failed">(
    "idle",
  );
  const audio = useRef<HTMLAudioElement | null>(null);
  const pending = useRef<number | null>(null);
  const loading = useRef<Promise<void> | null>(null);
  const objectUrl = useRef<string | null>(null);
  /** Bumped on reset and unmount: a download that finishes later is dropped. */
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
    },
    [],
  );
  /** Plays from the time asked for, once the player has the sound. */
  const apply = () => {
    const element = audio.current;
    if (!element || pending.current === null) return;
    element.currentTime = pending.current;
    pending.current = null;
    void Promise.resolve(element.play?.()).catch(() => {});
  };
  const load = () => {
    const current = generation.current;
    loading.current ??= Promise.resolve()
      .then(() => {
        setPhase("loading");
        return session.readMeetingAudio(id);
      })
      .then((blob) => {
        if (generation.current !== current) return;
        objectUrl.current = URL.createObjectURL(blob);
        setUrl(objectUrl.current);
        setPhase("ready");
      })
      .catch(() => {
        if (generation.current !== current) return;
        loading.current = null;
        setPhase("failed");
      });
    return loading.current;
  };
  return {
    url,
    phase,
    audio,
    apply,
    async seek(seconds: number) {
      pending.current = seconds;
      if (objectUrl.current && audio.current) apply();
      else await load();
    },
    /** After the sound was deleted. */
    reset() {
      generation.current++;
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
      loading.current = null;
      setUrl(null);
      setPhase("idle");
    },
  };
}

export function MeetingDetail({
  session,
  id,
}: {
  session: ClientSession;
  id: string;
}) {
  const { language } = useApp();
  const copy = useMeetingsCopy();
  const tr = translate(language);
  const client = useQueryClient();
  const navigate = useNavigate();
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [acting, setActing] = useState(false);
  const [confirm, setConfirm] = useState<"retry" | "delete" | "audio" | null>(
    null,
  );
  const [process, setProcess] = useState<{
    id: string;
    revision: number;
    text: string;
  } | null>(null);
  const [unavailable, setUnavailable] = useState<string[]>([]);
  /** The moment asked for in the notes or by a time: its paragraph shows. */
  const [focus, setFocus] = useState<{ seconds: number } | null>(null);
  useEffect(() => {
    if (focus) scrollTo("meeting-focus");
  }, [focus]);
  const [original, setOriginal] = useState(false);
  const {
    url: audioUrl,
    phase: audioPhase,
    audio: audioRef,
    apply: applySeek,
    seek,
    reset: resetPlayer,
  } = useMeetingPlayer(session, id);
  const key = ["app", "meeting", session.identityKey, id];
  const query = useQuery({
    queryKey: key,
    queryFn: () => session.readMeetingRecord(id),
    refetchInterval: (current) => (settling(current.state.data) ? 3000 : false),
    retry: false,
  });
  const record = query.data;
  const meeting = record?.meeting;
  const segments = useInfiniteQuery({
    queryKey: [...key, "segments", meeting?.completedSegments ?? 0],
    enabled: !!meeting?.completedSegments,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => session.readMeeting(id, pageParam),
    getNextPageParam: (page) => page.next ?? undefined,
    retry: false,
  });
  const loaded = segments.data?.pages.flatMap((page) => page.segments) ?? [];
  const notes = record ? meetingNotes(record) : null;
  const speakerNames: SpeakerNames = {
    self: copy.speakerSelf,
    others: copy.speakerOthers,
    unknown: copy.speakerUnknown,
  };

  const act = async (fn: () => Promise<unknown>) => {
    setActing(true);
    setActionError(null);
    try {
      await fn();
      await query.refetch();
      void client.invalidateQueries({ queryKey: meetingsKey(session) });
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "meeting_processing_failed",
      );
    } finally {
      setActing(false);
    }
  };
  /** Opens the transcript at a quote's minute, loading parts up to it. */
  const reveal = async (segment: number) => {
    let pages = segments.data?.pages ?? [];
    let next = pages.at(-1)?.next ?? null;
    while (
      !pages.some((page) => page.segments.some((s) => s.index === segment)) &&
      next !== null &&
      next <= segment
    ) {
      const result = await segments.fetchNextPage();
      pages = result.data?.pages ?? [];
      next = pages.at(-1)?.next ?? null;
    }
  };
  /** A time in the notes or transcript: show it and play from there. */
  const jump = (seconds: number) => {
    if (notes?.utterances.length) setFocus({ seconds });
    else
      void reveal(Math.floor(seconds / 60)).then(() => setFocus({ seconds }));
    if (meeting && playable(meeting)) void seek(seconds);
  };
  /** A task can continue in a process only while it is still open. */
  const selectTask = async (index: number) => {
    const taskId = record?.humanTaskIds[index];
    const task = record?.analysis?.tasks[index];
    if (!record || !taskId || !task || !record.recordDigest) return;
    setActionError(null);
    try {
      const current = await session.readHumanTask(taskId);
      if (
        current.status !== "open" ||
        current.origin.kind !== "meeting" ||
        current.origin.meetingId !== record.meeting.id ||
        current.origin.recordDigest !== record.recordDigest
      ) {
        setUnavailable((ids) => [...ids, taskId]);
        return;
      }
      setProcess({ id: taskId, revision: current.revision, text: task.text });
    } catch (error) {
      if (error instanceof Error && error.message === "human_task_not_found")
        setUnavailable((ids) => [...ids, taskId]);
      else
        setActionError(
          error instanceof Error ? error.message : "human_task_load_failed",
        );
    }
  };
  /** Every minute of the transcript, reading the parts not loaded yet. */
  const allSegments = async () => {
    let result = segments;
    for (let i = 0; i < 25 && result.hasNextPage; i++)
      result = await segments.fetchNextPage();
    return result.data?.pages.flatMap((page) => page.segments) ?? loaded;
  };

  if (query.isError && !record)
    return (
      <MenuPage>
        <PageHeader
          title={copy.meetings}
          back={{ to: "/meetings", label: copy.back }}
        />
        <Alert variant="destructive">
          <AlertDescription>
            {query.error instanceof Error &&
            query.error.message === "meeting_not_found"
              ? copy.notFound
              : meetingErrorText(
                  query.error instanceof Error ? query.error.message : null,
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
      </MenuPage>
    );
  if (!record || !meeting || !notes)
    return (
      <MenuPage>
        <div role="status" aria-label={copy.meetings}>
          <Skeleton className="h-64 w-full" />
        </div>
      </MenuPage>
    );

  const analysis = record.analysis;
  const tone = meetingTone[meeting.status];
  const failed =
    meeting.status === "failed" || meeting.status === "interrupted";
  const total = meeting.durationSeconds
    ? Math.ceil(meeting.durationSeconds / 60)
    : 0;
  const canContinue =
    meeting.status === "ready" &&
    !!analysis &&
    record.transcriptComplete &&
    !!record.recordDigest;
  const turns = notes.utterances;
  // Without timed turns, the minutes read as turns of their own.
  const blocks = transcriptBlocks(
    turns.length ? turns : minuteTurns(loaded, meeting, original),
  );
  const focused = focus ? paragraphAt(blocks, focus.seconds) : null;
  const hasTranscript =
    turns.length > 0 ||
    loaded.some((segment) => segment.text) ||
    !!record.transcript;
  const speakerCount = new Set(
    turns.map((turn) => turn.speaker).filter((s) => s !== "unknown"),
  ).size;
  const status = [
    meetingMeta(meeting, language),
    speakerCount
      ? copy.speakers(speakerCount)
      : meeting.speakerChannels === "self-others"
        ? copy.twoTracks
        : null,
    meeting.consent ? null : copy.noConsent,
  ]
    .filter(Boolean)
    .join(" · ");

  const ask = () => {
    const name = meeting.title.slice(0, 120);
    saveDraft(draftKey(session.identityKey, UNSAVED_DRAFT), {
      text: copy.askPrefix(name, meetingDay(meeting, language)),
      revision: 0,
      mentions: [{ kind: "meeting", id: meeting.id, name }],
    });
    void navigate({ to: "/chat" });
  };
  const transcriptText = async () =>
    meetingTranscriptText(
      notes,
      await allSegments(),
      speakerNames,
      record.transcript,
    );
  const copyMarkdown = async () => {
    const markdown = async () =>
      meetingMarkdown(record, notes, copy, await transcriptText(), language);
    try {
      // The write starts within the click and gets its text later; Safari
      // refuses a clipboard write that only starts after the transcript loads.
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write)
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": markdown().then(
              (text) => new Blob([text], { type: "text/plain" }),
            ),
          }),
        ]);
      else await navigator.clipboard.writeText(await markdown());
      setNotice(copy.copied);
      setTimeout(() => setNotice(null), 2000);
    } catch {
      setActionError("meeting_copy_failed");
    }
  };
  const downloadTranscript = async () => {
    const blob = new Blob([(await transcriptText()) + "\n"], {
      type: "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${meeting.title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "meeting"}.txt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const player = playable(meeting) && (
    <MeetingPlayer
      url={audioUrl}
      phase={audioPhase}
      audio={audioRef}
      onReady={applySeek}
      seek={seek}
      duration={meeting.durationSeconds ?? 0}
      copy={copy}
    />
  );
  // On a wide screen each column scrolls on its own, the player stays.
  const pane =
    "flex min-w-0 flex-col gap-8 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:overscroll-contain lg:pr-2";
  const notesColumn = analysis && (
    <div className={pane}>
      <Section title={copy.summary}>
        <Claim sources={analysis.summarySources} copy={copy} onSource={jump}>
          <p className="text-sm leading-relaxed whitespace-pre-wrap">
            {notes.summary || tr("meetingNoSummary")}
          </p>
        </Claim>
        {analysis.points.length > 0 && (
          <ul className="flex flex-col gap-2" aria-label={copy.points}>
            {analysis.points.map((point, index) => (
              <li key={index}>
                <Claim sources={point.sources} copy={copy} onSource={jump}>
                  <p className="text-sm">{point.text}</p>
                </Claim>
              </li>
            ))}
          </ul>
        )}
      </Section>
      {notes.decisions.length > 0 && (
        <Section title={copy.decisions} count={notes.decisions.length}>
          <NoteList items={notes.decisions} copy={copy} onJump={jump} />
        </Section>
      )}
      <Section
        title={copy.tasks}
        count={notes.tasks.length || undefined}
        actions={
          notes.tasks.length > 0 && (
            <Button variant="ghost" size="sm" asChild>
              <Link to="/tasks">
                <ClipboardList data-icon="inline-start" aria-hidden="true" />
                {copy.openTasks}
              </Link>
            </Button>
          )
        }
      >
        {notes.tasks.length ? (
          <Card variant="list">
            {notes.tasks.map((task) => {
              const taskId = record.humanTaskIds[task.index];
              return (
                <Item key={taskId ?? task.index} variant="row" size="row">
                  <ItemContent>
                    <ItemTitle>{task.text}</ItemTitle>
                    <ItemDescription>
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        {task.owner && (
                          <span className="inline-flex items-center gap-1">
                            <UserRound
                              aria-hidden="true"
                              className="size-3.5"
                            />
                            <span className="sr-only">
                              {tr("meetingAssignee")}:{" "}
                            </span>
                            {task.owner === "me"
                              ? copy.speakerSelf
                              : task.owner}
                          </span>
                        )}
                        {task.due && (
                          <span className="inline-flex items-center gap-1">
                            <CalendarClock
                              aria-hidden="true"
                              className="size-3.5"
                            />
                            <span className="sr-only">
                              {tr("meetingDue")}:{" "}
                            </span>
                            {task.due}
                            {task.dueDate && (
                              <span className="tabular-nums">
                                {" "}
                                ({formatDue(task.dueDate, language)})
                              </span>
                            )}
                          </span>
                        )}
                        {task.at !== null && (
                          <TimeLink at={task.at} copy={copy} onJump={jump} />
                        )}
                      </span>
                    </ItemDescription>
                  </ItemContent>
                  {canContinue && taskId && (
                    <ItemActions>
                      {unavailable.includes(taskId) ? (
                        <StatusBadge tone="neutral">
                          {copy.taskClosed}
                        </StatusBadge>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void selectTask(task.index)}
                        >
                          <Play data-icon="inline-start" aria-hidden="true" />
                          {copy.continueProcess}
                        </Button>
                      )}
                    </ItemActions>
                  )}
                </Item>
              );
            })}
          </Card>
        ) : (
          <p className="text-sm text-muted-foreground">
            {tr("meetingNoTasks")}
          </p>
        )}
      </Section>
      {notes.openQuestions.length > 0 && (
        <Section title={copy.openQuestions} count={notes.openQuestions.length}>
          <NoteList items={notes.openQuestions} copy={copy} onJump={jump} />
        </Section>
      )}
    </div>
  );

  const transcriptColumn = (
    <div className={pane}>
      <Section
        title={copy.transcript}
        actions={
          !turns.length &&
          loaded.some((segment) => segment.text) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setOriginal(!original)}
            >
              {original
                ? tr("meetingTranscriptReadable")
                : tr("meetingTranscriptOriginal")}
            </Button>
          )
        }
      >
        {record.reviewReasons.length > 0 && (
          <Alert>
            <AlertTitle>{tr("meetingTranscriptReview")}</AlertTitle>
            <AlertDescription>
              {tr("meetingTranscriptReviewHint")}
            </AlertDescription>
          </Alert>
        )}
        {!record.transcriptComplete && meeting.status !== "failed" && (
          <p className="text-sm text-muted-foreground">
            {tr("meetingIncompleteTranscript")}
          </p>
        )}
        {segments.isError && !turns.length ? (
          <Alert variant="destructive">
            <AlertDescription>
              {meetingErrorText(
                segments.error instanceof Error ? segments.error.message : null,
                copy,
                language,
              )}
            </AlertDescription>
            <AlertAction>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void segments.refetch()}
              >
                <RefreshCw data-icon="inline-start" aria-hidden="true" />
                {copy.retry}
              </Button>
            </AlertAction>
          </Alert>
        ) : !turns.length && segments.isPending && meeting.completedSegments ? (
          <Skeleton className="h-32 w-full" />
        ) : blocks.length ? (
          <div
            role="list"
            aria-label={copy.transcript}
            className="flex flex-col gap-6"
          >
            {blocks.map((block, index) => (
              <TranscriptBlockView
                key={index}
                block={block}
                names={speakerNames}
                labelled={blocks.some((b) => b.speaker !== "unknown")}
                focused={focused?.[0] === index ? focused[1] : null}
                copy={copy}
                onJump={jump}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {tr("meetingNoTranscript")}
          </p>
        )}
        {!turns.length && segments.hasNextPage && (
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            disabled={segments.isFetchingNextPage}
            onClick={() => void segments.fetchNextPage()}
          >
            {segments.isFetchingNextPage && (
              <Spinner data-icon="inline-start" />
            )}
            {copy.moreTranscript}
          </Button>
        )}
      </Section>
    </div>
  );

  return (
    <MenuPage wide fill>
      <PageHeader
        title={meeting.title}
        titleContent={
          <MeetingTitle
            title={meeting.title}
            label={copy.rename}
            onRename={(title) => act(() => session.renameMeeting(id, title))}
          />
        }
        back={{ to: "/meetings", label: copy.back }}
        description={status}
        meta={
          tone && (
            <StatusBadge tone={tone}>
              {tr(`meeting_status_${meeting.status}`)}
            </StatusBadge>
          )
        }
        actions={
          <>
            {meeting.status === "ready" && (
              <Button onClick={ask}>
                <MessageSquare data-icon="inline-start" aria-hidden="true" />
                {copy.ask}
              </Button>
            )}
            {!busy(meeting.status) && (
              <MoreActions label={copy.more}>
                {failed && (
                  <DropdownMenuItem onSelect={() => setConfirm("retry")}>
                    <RotateCcw aria-hidden="true" />
                    {tr("meetingRetry")}
                  </DropdownMenuItem>
                )}
                {analysis && (
                  <DropdownMenuItem onSelect={() => void copyMarkdown()}>
                    <Copy aria-hidden="true" />
                    {copy.copyMarkdown}
                  </DropdownMenuItem>
                )}
                {hasTranscript && (
                  <DropdownMenuItem onSelect={() => void downloadTranscript()}>
                    <Download aria-hidden="true" />
                    {copy.downloadTranscript}
                  </DropdownMenuItem>
                )}
                {(analysis || hasTranscript || failed) && (
                  <DropdownMenuSeparator />
                )}
                {playable(meeting) && (
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => setConfirm("audio")}
                  >
                    <VolumeX aria-hidden="true" />
                    {copy.deleteAudio}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => setConfirm("delete")}
                >
                  <Trash2 aria-hidden="true" />
                  {copy.delete}
                </DropdownMenuItem>
              </MoreActions>
            )}
          </>
        }
      />
      {notice && (
        <p role="status" className="-mt-6 text-xs text-muted-foreground">
          {notice}
        </p>
      )}
      {actionError && (
        <Alert variant="destructive">
          <AlertDescription>
            {meetingErrorText(actionError, copy, language)}
          </AlertDescription>
        </Alert>
      )}
      {failed ? (
        <Alert variant="destructive">
          <AlertTitle>
            {tr(
              meeting.status === "interrupted"
                ? "meeting_status_interrupted"
                : "meetingFailed",
            )}
          </AlertTitle>
          <AlertDescription>
            {meetingErrorText(meeting.failure, copy, language)}
          </AlertDescription>
          <AlertAction>
            <Button
              variant="outline"
              size="sm"
              disabled={acting}
              onClick={() => setConfirm("retry")}
            >
              <RotateCcw data-icon="inline-start" aria-hidden="true" />
              {tr("meetingRetry")}
            </Button>
          </AlertAction>
        </Alert>
      ) : settling(record) || meeting.status === "sealed" ? (
        <Card>
          <CardContent>
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-sm">
                  {meeting.status !== "sealed" && <Spinner />}
                  {tr(`meeting_status_${meeting.status}`)}
                </span>
                {meeting.status === "sealed" ? (
                  <Button
                    size="sm"
                    disabled={acting}
                    onClick={() => void act(() => session.processMeeting(id))}
                  >
                    <Play data-icon="inline-start" aria-hidden="true" />
                    {tr("meetingProcess")}
                  </Button>
                ) : total > 0 ? (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {tr("meetingTranscribedMinutes")
                      .replace("{done}", String(meeting.completedSegments))
                      .replace("{total}", String(total))}
                  </span>
                ) : null}
              </div>
              {total > 0 && (
                <Progress
                  value={Math.round((meeting.completedSegments / total) * 100)}
                  aria-label={copy.processing}
                />
              )}
            </div>
          </CardContent>
        </Card>
      ) : meeting.status === "ready" && !analysis ? (
        <Alert>
          <AlertTitle>{tr("meetingConsolidate")}</AlertTitle>
          <AlertDescription>{tr("meetingConsolidateHint")}</AlertDescription>
          <AlertAction>
            <Button
              variant="outline"
              size="sm"
              disabled={acting || !!meeting.audioDeletedAt}
              onClick={() => void act(() => session.processMeeting(id))}
            >
              <Sparkles data-icon="inline-start" aria-hidden="true" />
              {tr("meetingConsolidate")}
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      {analysis ? (
        <div className="grid gap-8 lg:min-h-96 lg:flex-1 lg:grid-cols-5">
          <div className="flex min-w-0 flex-col gap-6 lg:col-span-2 lg:min-h-0">
            {player}
            {notesColumn}
          </div>
          <div className="flex min-w-0 flex-col lg:col-span-3 lg:min-h-0">
            {transcriptColumn}
          </div>
        </div>
      ) : (
        <div className="flex w-full max-w-3xl min-w-0 flex-col gap-6 lg:min-h-96 lg:flex-1">
          {player}
          {transcriptColumn}
        </div>
      )}

      <AlertDialog
        open={confirm === "retry"}
        onOpenChange={(open) => !open && setConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.retryTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {tr("meetingRetryHint")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{copy.cancel}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirm(null);
                void act(() => session.processMeeting(id, true));
              }}
            >
              {tr("meetingRetry")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ConfirmAction
        open={confirm === "audio"}
        onOpenChange={(open) => setConfirm(open ? "audio" : null)}
        title={copy.deleteAudioTitle}
        description={copy.deleteAudioHint}
        confirmLabel={copy.deleteAudio}
        cancelLabel={copy.cancel}
        onConfirm={() =>
          act(async () => {
            await session.deleteMeetingAudio(id);
            resetPlayer();
          })
        }
      />
      <ConfirmAction
        open={confirm === "delete"}
        onOpenChange={(open) => setConfirm(open ? "delete" : null)}
        title={copy.deleteTitle}
        description={tr("meetingDeleteHint")}
        confirmLabel={tr("meetingDeleteConfirm")}
        cancelLabel={copy.cancel}
        onConfirm={() =>
          act(async () => {
            await session.deleteMeeting(id);
            client.removeQueries({ queryKey: key });
            void client.invalidateQueries({ queryKey: meetingsKey(session) });
            void navigate({ to: "/meetings" });
          })
        }
      />
      {process && (
        <MeetingProcessSheet
          session={session}
          record={record}
          task={process}
          onClose={() => setProcess(null)}
        />
      )}
    </MenuPage>
  );
}

/** A resolved deadline as a short local date (and time when it has one). */
function formatDue(value: string, language: "en" | "cs") {
  const date = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(language, {
    day: "numeric",
    month: "numeric",
    ...(value.length > 10 ? { hour: "numeric", minute: "2-digit" } : {}),
  });
}

function scrollTo(elementId: string) {
  // After the highlighted part renders.
  setTimeout(() => {
    if (typeof document === "undefined") return;
    document
      .getElementById(elementId)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, 0);
}

/** The name in the header; a click turns it into a field, Enter saves. */
function MeetingTitle({
  title,
  label,
  onRename,
}: {
  title: string;
  label: string;
  onRename(title: string): Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const [saving, setSaving] = useState(false);
  if (!editing)
    return (
      <button
        type="button"
        title={label}
        className="min-w-0 cursor-text text-left decoration-dotted underline-offset-4 hover:underline"
        onClick={() => {
          setValue(title);
          setEditing(true);
        }}
      >
        {title}
      </button>
    );
  const save = async () => {
    const next = value.trim();
    if (saving) return;
    if (!next || next === title) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onRename(next);
    } finally {
      setSaving(false);
      setEditing(false);
    }
  };
  return (
    <Input
      autoFocus
      aria-label={label}
      value={value}
      maxLength={160}
      disabled={saving}
      className="max-w-xl"
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => void save()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void save();
        } else if (event.key === "Escape") {
          event.preventDefault();
          setEditing(false);
        }
      }}
    />
  );
}

/** "at 12:34": shows that moment in the transcript and plays it. */
function TimeLink({
  at,
  copy,
  onJump,
}: {
  at: number;
  copy: MeetingsCopy;
  onJump(seconds: number): void;
}) {
  const time = meetingTime(at);
  return (
    <Button
      variant="link"
      size="xs"
      aria-label={`${copy.showInTranscript} ${time}`}
      onClick={() => onJump(at)}
    >
      <span className="tabular-nums">{copy.at(time)}</span>
    </Button>
  );
}

function NoteList({
  items,
  copy,
  onJump,
}: {
  items: readonly MeetingNoteItem[];
  copy: MeetingsCopy;
  onJump(seconds: number): void;
}) {
  return (
    <ul className="flex flex-col gap-2">
      {items.map((item, index) => (
        <li key={index} className="flex items-start gap-2 text-sm">
          <span className="min-w-0 flex-1">{item.text}</span>
          {item.at !== null && (
            <TimeLink at={item.at} copy={copy} onJump={onJump} />
          )}
        </li>
      ))}
    </ul>
  );
}

/** A claim with its quotes behind a count; each quote opens its minute. */
function Claim({
  sources,
  copy,
  onSource,
  children,
}: {
  sources: readonly Source[];
  copy: MeetingsCopy;
  onSource(seconds: number): void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">{children}</div>
        {sources.length > 0 && (
          <Button
            variant="ghost"
            size="xs"
            aria-expanded={open}
            aria-label={`${copy.quotes} ${sources.length}`}
            onClick={() => setOpen(!open)}
          >
            <Quote data-icon="inline-start" aria-hidden="true" />
            {sources.length}
          </Button>
        )}
      </div>
      {open && (
        <ul className="flex flex-col gap-1.5 border-l-2 pl-3">
          {sources.map((source, index) => (
            <li key={index} className="flex flex-col items-start gap-0.5">
              <blockquote className="text-sm text-muted-foreground italic">
                “{source.quote}”
              </blockquote>
              <SourceTime source={source} copy={copy} onSource={onSource} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SourceTime({
  source,
  copy,
  onSource,
}: {
  source: Source;
  copy: MeetingsCopy;
  onSource(seconds: number): void;
}) {
  const time = meetingTime(source.segment * 60);
  return (
    <Button
      variant="link"
      size="xs"
      aria-label={`${copy.showInTranscript} ${time}`}
      onClick={() => onSource(source.segment * 60)}
    >
      <Quote data-icon="inline-start" aria-hidden="true" />
      <span className="tabular-nums">{time}</span>
    </Button>
  );
}

/** The time at the start of a transcript line; a click plays from there. */
function LineTime({
  at,
  copy,
  onJump,
}: {
  at: number;
  copy: MeetingsCopy;
  onJump(seconds: number): void;
}) {
  const time = meetingTime(at);
  return (
    <Button
      variant="link"
      size="xs"
      className="w-12 shrink-0 justify-start"
      aria-label={`${copy.play} ${time}`}
      onClick={() => onJump(at)}
    >
      <span className="font-mono tabular-nums">{time}</span>
    </Button>
  );
}

/**
 * What one speaker says in a row: the name once, then paragraphs, each with
 * the time it starts at in the margin (a click plays from there).
 */
function TranscriptBlockView({
  block,
  names,
  labelled,
  focused,
  copy,
  onJump,
}: {
  block: TranscriptBlock;
  names: SpeakerNames;
  /** Names are shown only when some speaker is known. */
  labelled: boolean;
  focused: number | null;
  copy: MeetingsCopy;
  onJump(seconds: number): void;
}) {
  return (
    <div role="listitem" className="flex flex-col gap-2">
      {labelled && (
        <span
          data-speaker={block.speaker}
          className="pl-15 text-sm font-medium data-[speaker=self]:text-primary data-[speaker=unknown]:text-muted-foreground"
        >
          {names[block.speaker]}
        </span>
      )}
      {block.paragraphs.map((paragraph, index) => (
        <div
          key={index}
          id={focused === index ? "meeting-focus" : undefined}
          data-highlighted={focused === index}
          className="flex scroll-mt-24 items-start gap-3 rounded-md data-[highlighted=true]:bg-muted"
        >
          <LineTime at={paragraph.start} copy={copy} onJump={onJump} />
          <p className="min-w-0 flex-1 text-sm leading-relaxed">
            {paragraph.text}
          </p>
        </div>
      ))}
    </div>
  );
}

/**
 * Minute pieces as turns: a two-track recording names its speaker on each
 * line ("Me: …"); otherwise the speaker is unknown.
 */
function minuteTurns(
  segments: readonly MeetingSegment[],
  meeting: Meeting,
  original: boolean,
): MeetingUtterance[] {
  const labels =
    meeting.speakerChannels === "self-others"
      ? meetingSpeakerLabels(meeting.language)
      : null;
  return segments.flatMap((segment) =>
    segment.text
      .split("\n")
      .filter((line) => line.trim())
      .map((line): MeetingUtterance => {
        const speaker = labels
          ? labels.self && line.startsWith(`${labels.self}: `)
            ? "self"
            : line.startsWith(`${labels.others}: `)
              ? "others"
              : "unknown"
          : "unknown";
        const label =
          speaker === "self"
            ? labels!.self
            : speaker === "others"
              ? labels!.others
              : null;
        const words = label ? line.slice(label.length + 2) : line;
        return {
          start: segment.startSeconds,
          end: segment.startSeconds + 60,
          speaker,
          text: original ? words : cleanTranscriptForReading(words),
        };
      }),
  );
}
