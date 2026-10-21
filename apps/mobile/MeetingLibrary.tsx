import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ActivityIndicator,
  AppState,
  Modal,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { randomUUID } from "expo-crypto";
import type { ClientSession } from "../../packages/client-core/session";
import type { Language } from "../../packages/protocol";
import type { Meeting, MeetingSegment } from "../../packages/protocol/meetings";
import type { MeetingRecord } from "../../packages/protocol/meeting-record";
import type { HumanTask } from "../../packages/protocol/human-tasks";
import { en, translate, type TranslationKey } from "../../packages/i18n";
import { tokens as t } from "../../packages/design-tokens";
import {
  Button,
  Group,
  Icon,
  IconTile,
  ListRow,
  Notice,
  Row,
  SectionLabel,
  Stack,
  Text,
  ui,
} from "../../packages/ui";
import { useReducedMotion } from "../../packages/ui/motion";
import { VoiceOrb } from "../../packages/ui/VoiceOrb";
import {
  MeetingActionCard,
  MeetingDetailView,
  MeetingHero,
  MeetingProgress,
  MeetingRow,
  TranscriptReader,
  failureText,
  meetingTime,
} from "../../packages/ui-catalog/MeetingView";
import { useMeetingDevice } from "./meeting-device";
import { useMeetingNotification } from "./meeting-notification";
import { DetailSheet, EmptyState, IconButton, TopBar } from "./ScreenChrome";
import { ProcessLaunch } from "./ProcessLaunch";
const empty = {
  phase: "idle" as const,
  entries: [],
  error: null,
  uploadOffset: 0,
};
const emptySnapshot = () => empty;
const emptySubscribe = () => () => {};
function errorKey(value: unknown): TranslationKey {
  return value instanceof Error && value.message in en
    ? (value.message as TranslationKey)
    : "meeting_processing_failed";
}
export type MeetingRecordingControl = {
  owner: string;
  recording: boolean;
  paused: boolean;
  busy: boolean;
  error: TranslationKey | null;
  onStop(): void;
  onTogglePause(): void;
};
/** Shared by record readers and overlays while the original recorder stays mounted. */
export function MeetingRecordingControls({
  control,
  language,
  clock,
  withPause = false,
  onOpenMeetings,
}: {
  control: MeetingRecordingControl;
  language: Language;
  clock?: string;
  withPause?: boolean;
  onOpenMeetings?(): void;
}) {
  const tr = translate(language);
  return (
    <Stack>
      {control.error ? <Notice error>{tr(control.error)}</Notice> : null}
      {control.recording ? (
        <Row testID="meeting-recording-banner" style={styles.banner}>
          {control.paused ? (
            <Icon name="pause" size={16} color={t.color.text.secondary} />
          ) : (
            <View style={styles.liveDot} />
          )}
          <Text
            role="label"
            style={{ flex: 1, fontVariant: ["tabular-nums"] }}
            accessibilityLiveRegion="polite"
          >
            {tr(control.paused ? "meetingPaused" : "meetingRecording")}
            {clock ? ` · ${clock}` : ""}
          </Text>
          <Button
            label={tr("meetingStop")}
            onPress={control.onStop}
            disabled={control.busy}
            style={styles.bannerButton}
          />
        </Row>
      ) : onOpenMeetings ? (
        <Button
          variant="secondary"
          label={tr("meetings")}
          onPress={onOpenMeetings}
        />
      ) : null}
      {control.recording && withPause ? (
        <Button
          variant="secondary"
          icon={control.paused ? "play" : "pause"}
          label={tr(control.paused ? "meetingResume" : "meetingPause")}
          disabled={control.busy}
          onPress={control.onTogglePause}
          style={{ alignSelf: "flex-start" }}
        />
      ) : null}
    </Stack>
  );
}
/** Remains mounted across sections so navigation cannot discard the active recorder. Keyed by immutable destination. */
export function MeetingLibrary({
  session,
  language,
  visible,
  onTasks,
  selectedId: controlledId,
  onSelect,
  conversationId,
  chatGeneration,
  refreshVersion = 0,
  onRecording,
  onRecordingControls,
  onStartRecording,
  scheduled,
}: {
  session: ClientSession;
  language: Language;
  visible: boolean;
  onTasks?(): void;
  /** The open record; owned by the screen so Back can close it. */
  selectedId?: string | null;
  onSelect?(id: string | null): void;
  /** Current chat identity anchors the existing process command path. */
  conversationId?: string;
  chatGeneration?: number;
  refreshVersion?: number;
  /** Live capture holds the microphone; voice entry points step aside. */
  onRecording?(recording: boolean): void;
  /** Allows another screen to control this recorder without mounting another one. */
  onRecordingControls?(control: MeetingRecordingControl | null): void;
  /** Called as soon as the person starts recording, before the microphone starts. */
  onStartRecording?(): boolean | Promise<boolean>;
  /** Calendar meetings the assistant created; listed, never part of a record. */
  scheduled?: React.ReactNode;
}) {
  const tr = translate(language);
  const reduced = useReducedMotion();
  const { capture, durationMillis, elapsed, pickAudio } = useMeetingDevice(
    session.identityKey,
  );
  // The server names the meeting from its summary once it is processed.
  const automaticTitle = () =>
    `${tr("meetingDefaultTitle")} · ${new Date().toLocaleString(language, {
      dateStyle: "medium",
      timeStyle: "short",
    })}`;
  const local = useSyncExternalStore(
    capture?.subscribe ?? emptySubscribe,
    capture?.getSnapshot ?? emptySnapshot,
    emptySnapshot,
  );
  const [ownId, setOwnId] = useState<string | null>(null);
  const selectedId = onSelect ? (controlledId ?? null) : ownId;
  const select = useCallback(
    (id: string | null) => (onSelect ? onSelect(id) : setOwnId(id)),
    [onSelect],
  );
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [record, setRecord] = useState<MeetingRecord>();
  const recordUpdatedAt = useRef<string | undefined>(undefined);
  const [error, setError] = useState<TranslationKey>();
  const [loadError, setLoadError] = useState<TranslationKey>();
  const [busy, setBusy] = useState(false);
  const [startingRecording, setStartingRecording] = useState(false);
  const [stopFailedLive, setStopFailedLive] = useState(false);
  const [localDelete, setLocalDelete] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"retry" | "delete" | null>(null);
  const [source, setSource] = useState<MeetingSegment>();
  const [reader, setReader] = useState(false);
  const [processOpen, setProcessOpen] = useState(false);
  const [selectedProcessTask, setSelectedProcessTask] = useState<Pick<
    HumanTask,
    "id" | "revision"
  > | null>(null);
  const [unavailableProcessTaskIds, setUnavailableProcessTaskIds] = useState<
    string[]
  >([]);
  const alive = useRef(true);
  const generation = useRef(0);
  const processTaskSelection = useRef(0);
  const inFlight = useRef(false);
  const recordingStartPending = useRef(false);
  const recordingVisibilityGeneration = useRef(0);
  const wasVisible = useRef(visible);
  useLayoutEffect(() => {
    if (wasVisible.current && !visible) {
      recordingVisibilityGeneration.current++;
      if (capture?.getSnapshot().phase === "preparing")
        capture.cancelPreparing();
    }
    wasVisible.current = visible;
  }, [visible, capture]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") recordingVisibilityGeneration.current++;
    });
    return () => subscription.remove();
  }, []);
  const invalidate = useCallback(() => {
    generation.current++;
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      invalidate();
    };
  }, [invalidate]);
  // A paused meeting is still open: the file and microphone stay held.
  const paused = local.phase === "paused";
  const recording = local.phase === "recording" || paused;
  useEffect(() => {
    onRecording?.(recording);
  }, [recording, onRecording]);
  // A different record starts clean: no stale sheet, confirmation or reader.
  const [shownId, setShownId] = useState(selectedId);
  if (shownId !== selectedId) {
    setShownId(selectedId);
    setRecord(undefined);
    setConfirm(null);
    setSource(undefined);
    setReader(false);
    setProcessOpen(false);
    setSelectedProcessTask(null);
    setUnavailableProcessTaskIds([]);
  }
  useEffect(() => {
    processTaskSelection.current++;
    recordUpdatedAt.current = undefined;
  }, [selectedId]);
  const load = useCallback(
    async (includeSelected = true) => {
      if (inFlight.current) return;
      inFlight.current = true;
      const ticket = generation.current;
      try {
        const list = await session.readMeetings();
        if (!alive.current || ticket !== generation.current) return;
        setMeetings(list.meetings);
        setLoaded(true);
        setLoadError(undefined);
        const current = selectedId
          ? list.meetings.find((m) => m.id === selectedId)
          : undefined;
        if (includeSelected && selectedId && !current) {
          // Deleted elsewhere: its sources and transcript must not linger.
          setRecord(undefined);
          setSource(undefined);
          setConfirm(null);
          setReader(false);
          recordUpdatedAt.current = undefined;
          select(null);
          return;
        }
        const detail =
          includeSelected &&
          selectedId &&
          current?.updatedAt !== recordUpdatedAt.current
            ? await session.readMeetingRecord(selectedId)
            : undefined;
        if (!alive.current || ticket !== generation.current) return;
        if (detail) {
          setRecord(detail);
          recordUpdatedAt.current = detail.meeting.updatedAt;
        }
      } catch (failure) {
        if (alive.current && ticket === generation.current)
          setLoadError(errorKey(failure));
      } finally {
        inFlight.current = false;
      }
    },
    [session, selectedId, select],
  );
  useEffect(() => {
    if (!visible) return;
    const initial = setTimeout(() => {
      void load();
    }, 0);
    const timer = setInterval(() => {
      void load();
    }, 5000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
      invalidate();
    };
  }, [visible, load, invalidate, refreshVersion]);
  async function action(fn: () => Promise<unknown>, includeSelected = true) {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      if (alive.current) {
        setConfirm(null);
        await load(includeSelected);
      }
    } catch (failure) {
      if (alive.current) setError(errorKey(failure));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function selectProcessTask(index: number) {
    const taskId = record?.humanTaskIds[index];
    if (!record || !taskId || !record.recordDigest || !selected) return;
    const ticket = generation.current;
    const selection = ++processTaskSelection.current;
    try {
      const task = await session.readHumanTask(taskId);
      if (
        !alive.current ||
        ticket !== generation.current ||
        selection !== processTaskSelection.current ||
        task.status !== "open" ||
        task.origin.kind !== "meeting" ||
        task.origin.meetingId !== record.meeting.id ||
        task.origin.recordDigest !== record.recordDigest
      ) {
        if (
          alive.current &&
          ticket === generation.current &&
          selection === processTaskSelection.current
        ) {
          setSelectedProcessTask(null);
          setUnavailableProcessTaskIds((ids) =>
            ids.includes(taskId) ? ids : [...ids, taskId],
          );
          setProcessOpen(false);
          setError("meeting_process_record_changed");
        }
        return;
      }
      setUnavailableProcessTaskIds((ids) => ids.filter((id) => id !== taskId));
      setSelectedProcessTask({ id: task.id, revision: task.revision });
      setError(undefined);
      setProcessOpen(true);
    } catch (failure) {
      if (
        alive.current &&
        ticket === generation.current &&
        selection === processTaskSelection.current
      ) {
        const missing =
          failure instanceof Error &&
          failure.message === "human_task_not_found";
        if (missing) {
          setSelectedProcessTask(null);
          setUnavailableProcessTaskIds((ids) =>
            ids.includes(taskId) ? ids : [...ids, taskId],
          );
          setProcessOpen(false);
          setError("meeting_process_record_changed");
        } else setError(errorKey(failure));
      }
    }
  }
  async function stop() {
    if (!capture) return;
    setStopFailedLive(false);
    await capture.stop();
    const stopped = capture.getSnapshot();
    if (stopped.phase === "recording" || stopped.phase === "paused") {
      setStopFailedLive(true);
      return;
    }
    const saved = capture
      .getSnapshot()
      .entries.find((entry) => entry.state === "captured" && !entry.uploaded);
    if (saved && !capture.getSnapshot().error)
      await capture.upload(saved.id, session);
    await load();
  }
  useMeetingNotification({
    phase: local.phase,
    title:
      local.entries.find((entry) => entry.state === "pending")?.title ?? "",
    elapsedMillis: () => elapsed?.() ?? durationMillis,
    language,
    onPause: () => capture?.pause(),
    onResume: () => capture?.resume(),
    onStop: () => {
      void action(stop);
    },
  });
  const clock = meetingTime(durationMillis / 1000);
  const localAudioBlocked = busy || startingRecording || local.phase !== "idle";
  const captureError: TranslationKey | null =
    stopFailedLive && recording
      ? "meeting_stop_failed_live"
      : local.error
        ? local.error in en
          ? (local.error as TranslationKey)
          : "meeting_processing_failed"
        : null;
  const captureRecovery =
    !recording &&
    !!captureError &&
    local.phase === "idle" &&
    local.entries.length > 0;
  const showCaptureControls = recording || captureRecovery;
  const recordingActions = useRef({
    onStop: () => {},
    onTogglePause: () => {},
  });
  useLayoutEffect(() => {
    recordingActions.current = {
      onStop: () => {
        const phase = capture?.getSnapshot().phase;
        if (alive.current && (phase === "recording" || phase === "paused"))
          void action(stop);
      },
      onTogglePause: () => {
        if (!alive.current) return;
        if (capture?.getSnapshot().phase === "paused") capture.resume();
        else capture?.pause();
      },
    };
  });
  const stopRecording = useCallback(() => {
    recordingActions.current.onStop();
  }, []);
  const toggleRecordingPause = useCallback(() => {
    recordingActions.current.onTogglePause();
  }, []);
  const recordingControl = useMemo<MeetingRecordingControl | null>(
    () =>
      showCaptureControls
        ? {
            owner: session.identityKey,
            recording,
            paused,
            busy,
            error: captureError,
            onStop: stopRecording,
            onTogglePause: toggleRecordingPause,
          }
        : null,
    [
      recording,
      showCaptureControls,
      captureError,
      session.identityKey,
      paused,
      busy,
      stopRecording,
      toggleRecordingPause,
    ],
  );
  useEffect(() => {
    onRecordingControls?.(recordingControl);
    return () => onRecordingControls?.(null);
  }, [onRecordingControls, recordingControl]);
  const stopPlayback =
    local.phase === "playback" ? (
      <Row style={styles.banner}>
        <Icon name="speaker" size={18} color={t.color.action.primary} />
        <Text role="label" style={{ flex: 1 }}>
          {tr("meetingPlaying")}
        </Text>
        <Button
          variant="secondary"
          icon="stop"
          label={tr("meetingStopPlayback")}
          onPress={() => capture?.stopPlayback()}
          style={styles.bannerButton}
        />
      </Row>
    ) : null;
  // A live recording stays visible when reading another record or changing tabs.
  const openMeetingRecovery = () => {
    setReader(false);
    setSource(undefined);
    select(null);
  };
  const recordingBanner = showCaptureControls ? (
    <MeetingRecordingControls
      control={recordingControl!}
      language={language}
      clock={clock}
      onOpenMeetings={visible ? openMeetingRecovery : undefined}
    />
  ) : null;
  const recordingControls = showCaptureControls ? (
    <MeetingRecordingControls
      control={recordingControl!}
      language={language}
      clock={clock}
      withPause
      onOpenMeetings={openMeetingRecovery}
    />
  ) : null;
  if (!visible) return recordingBanner ?? stopPlayback;
  const selected = selectedId
    ? ((record?.meeting.id === selectedId ? record.meeting : undefined) ??
      meetings.find((m) => m.id === selectedId))
    : undefined;
  const problem =
    error ??
    loadError ??
    (local.error
      ? local.error in en
        ? (local.error as TranslationKey)
        : "meeting_processing_failed"
      : undefined);
  // An action that failed is not a failed meeting; say only what happened.
  const notice = problem ? <Notice error>{tr(problem)}</Notice> : null;
  const startRecording = async () => {
    if (recordingStartPending.current || busy) return;
    const visibilityGeneration = recordingVisibilityGeneration.current;
    recordingStartPending.current = true;
    setStartingRecording(true);
    setStopFailedLive(false);
    setError(undefined);
    try {
      if (onStartRecording) {
        let interrupted = false;
        try {
          interrupted = await onStartRecording();
        } catch {
          interrupted = false;
        }
        if (!interrupted) {
          if (alive.current) setError("meeting_interrupt_failed");
          return;
        }
      }
      if (
        alive.current &&
        visible &&
        visibilityGeneration === recordingVisibilityGeneration.current
      )
        await capture?.start(randomUUID(), automaticTitle(), language);
    } catch (failure) {
      if (alive.current) setError(errorKey(failure));
    } finally {
      recordingStartPending.current = false;
      if (alive.current) setStartingRecording(false);
    }
  };
  if (selectedId)
    return (
      <Stack testID="meeting-detail" style={{ gap: t.spacing.xl }}>
        {recordingControls}
        {selected ? (
          <MeetingHero meeting={selected} language={language} />
        ) : null}
        {stopPlayback}
        {notice}
        {selected?.failure ||
        (selected && ["failed", "interrupted"].includes(selected.status)) ? (
          <MeetingActionCard
            tone="error"
            title={tr(
              selected.status === "interrupted"
                ? "meeting_status_interrupted"
                : "meetingFailed",
            )}
            hint={
              selected.failure
                ? failureText(language, selected.failure)
                : undefined
            }
          >
            {["failed", "interrupted"].includes(selected.status) ? (
              confirm === "retry" ? (
                <View style={{ gap: t.spacing.sm }}>
                  <Text role="caption">{tr("meetingRetryHint")}</Text>
                  <Row>
                    <Button
                      label={tr("meetingRetry")}
                      disabled={busy}
                      loading={busy}
                      style={{ flex: 1 }}
                      onPress={() => {
                        void action(() =>
                          session.processMeeting(selected.id, true),
                        );
                      }}
                    />
                    <Button
                      variant="quiet"
                      label={tr("cancel")}
                      disabled={busy}
                      onPress={() => setConfirm(null)}
                    />
                  </Row>
                </View>
              ) : (
                <Button
                  icon="refresh"
                  label={tr("meetingRetry")}
                  disabled={busy}
                  onPress={() => setConfirm("retry")}
                />
              )
            ) : null}
          </MeetingActionCard>
        ) : null}
        {selected ? (
          <MeetingProgress meeting={selected} language={language} />
        ) : null}
        {selected?.status === "sealed" ? (
          <Button
            icon="upload"
            label={tr("meetingProcess")}
            disabled={busy}
            loading={busy}
            onPress={() => {
              void action(() => session.processMeeting(selected.id));
            }}
          />
        ) : null}
        {selected?.status === "ready" && record && !record.analysis ? (
          <MeetingActionCard
            title={tr("meetingConsolidate")}
            hint={tr("meetingConsolidateHint")}
          >
            <Button
              icon="sparkle"
              label={tr("meetingConsolidate")}
              disabled={busy}
              loading={busy}
              onPress={() => {
                void action(() => session.processMeeting(selected.id));
              }}
            />
          </MeetingActionCard>
        ) : null}
        {record && selected ? (
          <MeetingDetailView
            record={record}
            language={language}
            onTasks={onTasks}
            selectedProcessTaskId={selectedProcessTask?.id}
            unavailableProcessTaskIds={unavailableProcessTaskIds}
            onSelectProcessTask={(index) => void selectProcessTask(index)}
            onTranscript={() => setReader(true)}
            statusShown
            onSource={(index) => {
              const ticket = generation.current;
              void session
                .readMeeting(selected.id, index)
                .then((detail) => {
                  if (alive.current && ticket === generation.current)
                    setSource(detail.segments.find((s) => s.index === index));
                })
                .catch((failure) => {
                  if (alive.current && ticket === generation.current)
                    setError(errorKey(failure));
                });
            }}
          />
        ) : !problem ? (
          <View style={styles.loading}>
            <ActivityIndicator color={t.color.action.primary} />
          </View>
        ) : null}
        {record &&
        selected?.status === "ready" &&
        record.analysis &&
        record.transcriptComplete &&
        record.recordDigest &&
        selectedProcessTask &&
        record.humanTaskIds.includes(selectedProcessTask.id) &&
        conversationId ? (
          <View style={{ gap: t.spacing.sm }}>
            <SectionLabel
              trailing={
                processOpen ? (
                  <Button
                    variant="quiet"
                    size="small"
                    label={tr("meetingProcessHide")}
                    disabled={busy}
                    onPress={() => setProcessOpen(false)}
                    style={{ minHeight: 28, paddingHorizontal: 4 }}
                  />
                ) : null
              }
            >
              {tr("meetingProcessRunTitle")}
            </SectionLabel>
            {processOpen ? (
              <ProcessLaunch
                key={`${selected.id}/${record.recordDigest}`}
                session={session}
                language={language}
                conversationId={conversationId}
                chatGeneration={chatGeneration ?? 0}
                meetingRecord={record}
                selectedTask={selectedProcessTask}
                showTitle={false}
              />
            ) : (
              <Button
                variant="secondary"
                icon="play"
                label={tr("meetingProcessRunButton")}
                disabled={busy}
                onPress={() => setProcessOpen(true)}
              />
            )}
          </View>
        ) : null}
        {selected &&
        !["transcribing", "analyzing"].includes(selected.status) ? (
          <View>
            {confirm === "delete" ? (
              <View style={styles.confirm}>
                <Text role="caption" tone="secondary">
                  {tr("meetingDeleteHint")}
                </Text>
                <Row>
                  <Button
                    variant="danger"
                    icon="trash"
                    label={tr("meetingDeleteConfirm")}
                    disabled={localAudioBlocked}
                    style={{ flex: 1 }}
                    onPress={() => {
                      void action(async () => {
                        await session.deleteMeeting(selected.id);
                        await capture?.remove(selected.id);
                        invalidate();
                        setRecord(undefined);
                        recordUpdatedAt.current = undefined;
                        setLoadError(undefined);
                        select(null);
                      }, false);
                    }}
                  />
                  <Button
                    variant="quiet"
                    label={tr("cancel")}
                    disabled={busy}
                    onPress={() => setConfirm(null)}
                  />
                </Row>
              </View>
            ) : (
              <ListRow
                icon="trash"
                label={tr("meetingDelete")}
                danger
                disabled={busy}
                onPress={() => setConfirm("delete")}
              />
            )}
          </View>
        ) : null}
        {source ? (
          <DetailSheet
            title={`${tr("meetingSource")} · ${meetingTime(source.startSeconds)}`}
            language={language}
            onClose={() => setSource(undefined)}
          >
            {recordingControls}
            <View style={styles.quote}>
              <Text selectable style={{ fontSize: 16, lineHeight: 26 }}>
                {source.text}
              </Text>
            </View>
          </DetailSheet>
        ) : null}
        {reader && record ? (
          <Modal
            visible
            animationType={reduced ? "none" : "slide"}
            onRequestClose={() => setReader(false)}
          >
            <SafeAreaView style={styles.reader}>
              <TopBar
                leading={
                  <IconButton
                    icon="close"
                    label={tr("close")}
                    onPress={() => setReader(false)}
                  />
                }
                title={tr("meetingTranscript")}
              />
              {recordingControls ? (
                <View style={{ padding: t.spacing.lg }}>
                  {recordingControls}
                </View>
              ) : null}
              <TranscriptReader record={record} language={language} />
            </SafeAreaView>
          </Modal>
        ) : null}
      </Stack>
    );
  const uploading = local.phase === "uploading";
  const pendingLocal = local.entries.filter(
    (entry) =>
      !meetings.some((m) => m.id === entry.id && m.status !== "uploading"),
  );
  const listed = meetings.filter(
    (meeting) =>
      meeting.status !== "uploading" ||
      !local.entries.some((entry) => entry.id === meeting.id),
  );
  return (
    <Stack testID="meeting-library" style={{ gap: t.spacing.xl }}>
      {stopPlayback}
      {notice}
      {loadError ? (
        <Button
          variant="quiet"
          icon="refresh"
          label={tr("refresh")}
          disabled={busy}
          onPress={() => {
            void load();
          }}
        />
      ) : null}
      {capture ? (
        // One card, one control: the same lens as voice, warm because it records.
        <View
          testID="meeting-recorder"
          style={[styles.recorder, recording && styles.recorderLive]}
        >
          <VoiceOrb
            tone="record"
            size={128}
            glyph={recording ? "stop" : "record"}
            state={
              recording
                ? paused
                  ? "ready"
                  : "live"
                : busy || startingRecording || local.phase !== "idle"
                  ? "disabled"
                  : "ready"
            }
            label={tr(
              recording
                ? "meetingStop"
                : startingRecording
                  ? "meetingStarting"
                  : "meetingRecord",
            )}
            onPress={() => {
              if (recording) {
                if (!busy) void action(stop);
                return;
              }
              void startRecording();
            }}
          />
          {recording ? (
            <View style={styles.recorderText}>
              <Text
                accessibilityLiveRegion="polite"
                accessibilityLabel={`${tr(paused ? "meetingPaused" : "meetingRecording")} ${clock}`}
                style={styles.timer}
              >
                {clock}
              </Text>
              {paused ? (
                <Text role="label" tone="secondary">
                  {tr("meetingPaused")}
                </Text>
              ) : (
                <Row style={{ gap: 6 }}>
                  <View style={styles.liveDot} />
                  <Text role="label" style={{ color: t.color.record }}>
                    {tr("meetingRecording")}
                  </Text>
                </Row>
              )}
              <Button
                variant="secondary"
                icon={paused ? "play" : "pause"}
                label={tr(paused ? "meetingResume" : "meetingPause")}
                disabled={busy}
                onPress={() => (paused ? capture.resume() : capture.pause())}
                style={styles.pauseButton}
              />
            </View>
          ) : uploading ? (
            <View style={styles.recorderText}>
              <Text role="cardTitle">{tr("meeting_status_uploading")}</Text>
              <Row style={{ gap: 6 }}>
                <ActivityIndicator
                  size="small"
                  color={t.color.action.primary}
                />
                <Text
                  role="caption"
                  tone="secondary"
                  style={{ fontVariant: ["tabular-nums"] }}
                >
                  {Math.round(local.uploadOffset / 1024)} KiB
                </Text>
              </Row>
            </View>
          ) : (
            <View style={styles.recorderText}>
              <Text role="cardTitle" style={{ textAlign: "center" }}>
                {tr("meetingRecord")}
              </Text>
              <Text
                role="caption"
                tone="secondary"
                style={{ textAlign: "center" }}
              >
                {tr("meetingRecordHint")}
              </Text>
              {/* A recording made elsewhere is processed like one made here. */}
              <Button
                variant="secondary"
                icon="upload"
                label={tr("meetingImport")}
                loading={local.phase === "importing"}
                disabled={localAudioBlocked}
                onPress={() => {
                  if (recordingStartPending.current) return;
                  void action(async () => {
                    const picked = await pickAudio();
                    if (!picked) return;
                    const id = await capture.importFile(
                      picked,
                      randomUUID(),
                      automaticTitle(),
                      language,
                    );
                    if (id) await capture.upload(id, session);
                  });
                }}
                style={styles.importButton}
              />
            </View>
          )}
        </View>
      ) : null}
      {scheduled ? (
        <View style={{ gap: t.spacing.sm }}>
          <SectionLabel>{tr("meetingsScheduled")}</SectionLabel>
          {scheduled}
        </View>
      ) : null}
      {pendingLocal.length ? (
        <View style={{ gap: t.spacing.sm }}>
          <SectionLabel>{tr("meetingLocal")}</SectionLabel>
          <Group>
            {pendingLocal.map((entry) => (
              <View key={entry.id} style={[ui.listItem, styles.localRow]}>
                <Row style={{ gap: t.spacing.md }}>
                  <IconTile
                    icon={entry.interrupted ? "alert" : "device"}
                    tone={entry.interrupted ? "amber" : "blue"}
                    size={36}
                  />
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <Text role="label" numberOfLines={1}>
                      {entry.title}
                    </Text>
                    <Text
                      role="caption"
                      tone="secondary"
                      numberOfLines={2}
                      style={{ fontVariant: ["tabular-nums"] }}
                    >
                      {meetingTime(entry.durationMillis / 1000)} ·{" "}
                      {tr(
                        entry.state === "pending"
                          ? "meeting_recovery_failed"
                          : entry.interrupted
                            ? "meetingInterrupted"
                            : "meetingNotUploaded",
                      )}
                    </Text>
                  </View>
                  {entry.state === "captured" ? (
                    <IconButton
                      icon="play"
                      label={tr("meetingPlay")}
                      disabled={localAudioBlocked}
                      onPress={() => {
                        if (recordingStartPending.current) return;
                        void capture?.play(entry.id);
                      }}
                    />
                  ) : null}
                  <IconButton
                    icon="trash"
                    label={tr("meetingDelete")}
                    disabled={localAudioBlocked}
                    onPress={() =>
                      setLocalDelete(localDelete === entry.id ? null : entry.id)
                    }
                  />
                </Row>
                {localDelete === entry.id ? (
                  <Button
                    variant="danger"
                    icon="trash"
                    label={tr("meetingDeleteConfirm")}
                    disabled={localAudioBlocked}
                    onPress={() => {
                      void action(async () => {
                        await capture?.remove(entry.id);
                        setLocalDelete(null);
                      });
                    }}
                  />
                ) : entry.state === "pending" ? (
                  <Button
                    variant="secondary"
                    label={tr("meetingRecover")}
                    disabled={localAudioBlocked}
                    onPress={() => {
                      void action(async () => {
                        await capture?.recover(entry.id);
                      });
                    }}
                  />
                ) : (
                  <Button
                    variant="secondary"
                    icon="upload"
                    label={tr("meetingUpload")}
                    disabled={localAudioBlocked || entry.state !== "captured"}
                    onPress={() => {
                      void action(async () => {
                        await capture?.upload(entry.id, session);
                      });
                    }}
                  />
                )}
              </View>
            ))}
          </Group>
        </View>
      ) : null}
      {listed.length ? (
        <View style={{ gap: t.spacing.sm }}>
          <SectionLabel>{tr("meetingsRecent")}</SectionLabel>
          <Group>
            {listed.map((meeting) => (
              <MeetingRow
                key={meeting.id}
                meeting={meeting}
                language={language}
                onOpen={() => select(meeting.id)}
              />
            ))}
          </Group>
        </View>
      ) : loaded && !pendingLocal.length && !scheduled ? (
        <EmptyState
          icon="waveform"
          title={tr("meetingsEmptyTitle")}
          hint={tr("meetingsEmptyHint")}
        />
      ) : null}
      {capture ? null : (
        <Row style={styles.nativeOnly}>
          <Icon name="device" size={14} color={t.color.text.secondary} />
          <Text role="meta" tone="secondary" style={{ flexShrink: 1 }}>
            {tr("meetingNativeHint")}
          </Text>
        </Row>
      )}
    </Stack>
  );
}
const styles = StyleSheet.create({
  banner: {
    minHeight: 56,
    paddingLeft: t.spacing.lg,
    paddingRight: 6,
    borderRadius: t.radius.group,
    backgroundColor: t.color.surface,
    borderWidth: 1,
    borderColor: t.color.surfaceRaised,
    ...t.elevation.card,
  },
  bannerButton: { minHeight: 40, paddingVertical: 8 },
  liveDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: t.color.record,
  },
  recorder: {
    padding: t.spacing.lg,
    paddingTop: t.spacing.md,
    gap: t.spacing.md,
    // The orb is the centre of the card; only the name field spans it.
    alignItems: "center",
    borderRadius: t.radius.card,
    backgroundColor: t.color.surface,
    borderWidth: 1,
    borderColor: t.color.surfaceRaised,
    ...t.elevation.card,
  },
  recorderLive: { borderColor: t.color.statusSoft.error },
  recorderText: { alignItems: "center", gap: 4 },
  pauseButton: { marginTop: 8 },
  importButton: { marginTop: 12 },
  timer: {
    fontSize: 48,
    lineHeight: 54,
    fontWeight: "300",
    color: t.color.text.primary,
    fontVariant: ["tabular-nums"],
  },
  nativeOnly: { justifyContent: "center", gap: 6 },
  localRow: { padding: t.spacing.lg, gap: t.spacing.md },
  loading: { paddingVertical: t.spacing.xxl, alignItems: "center" },
  confirm: { paddingHorizontal: t.spacing.xs, gap: t.spacing.md },
  quote: {
    paddingLeft: t.spacing.lg,
    borderLeftWidth: 3,
    borderLeftColor: t.color.tile.violet.background,
  },
  reader: { flex: 1, backgroundColor: t.color.background },
});
