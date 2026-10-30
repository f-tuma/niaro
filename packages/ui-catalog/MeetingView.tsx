import React, { useEffect, useState } from "react";
import {
  Animated,
  Easing,
  FlatList,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import type { Language } from "../protocol";
import type { Meeting } from "../protocol/meetings";
import type { MeetingRecord } from "../protocol/meeting-record";
import { translate, en, type TranslationKey } from "../i18n";
import {
  cleanTranscriptForReading,
  meetingDuration,
  meetingTime,
  transcriptParagraphs,
} from "./meeting-format";
import { tokens as t } from "../design-tokens";
import { nativeMotion, useReducedMotion } from "../ui/motion";
import { Ripple } from "../ui/Ripple";
import {
  Group,
  Icon,
  Notice,
  Row,
  SectionLabel,
  StatusPill,
  Text,
  type IconName,
  type StatusTone,
} from "../ui";
export {
  cleanTranscriptForReading,
  meetingDuration,
  meetingTime,
  transcriptParagraphs,
};

export function MeetingNotice({
  title,
  hint,
  error = false,
}: {
  title: string;
  hint: string;
  error?: boolean;
}) {
  return (
    <View
      accessibilityRole={error ? "alert" : undefined}
      style={[
        styles.notice,
        {
          backgroundColor: error
            ? t.color.statusSoft.error
            : t.color.statusSoft.warning,
        },
      ]}
    >
      <Icon
        name="alert"
        size={18}
        color={error ? t.color.status.error : t.color.status.warning}
      />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text role="label">{title}</Text>
        <Text role="caption">{hint}</Text>
      </View>
    </View>
  );
}
export function failureText(language: Language, failure: string | null) {
  return translate(language)(
    failure && failure in en
      ? (failure as TranslationKey)
      : "meeting_processing_failed",
  );
}
const statusStyle: Record<
  Meeting["status"],
  { tone: StatusTone; icon?: IconName; busy?: boolean } | null
> = {
  uploading: { tone: "running", busy: true },
  sealed: { tone: "needsInput", icon: "upload" },
  transcribing: { tone: "running", busy: true },
  analyzing: { tone: "running", busy: true },
  ready: null,
  failed: { tone: "error", icon: "alert" },
  interrupted: { tone: "warning", icon: "alert" },
};
/** Nothing for Ready: the normal state does not need announcing. */
export function MeetingStatusPill({
  status,
  language,
  compact = false,
}: {
  status: Meeting["status"];
  language: Language;
  compact?: boolean;
}) {
  const style = statusStyle[status];
  if (!style) return null;
  return (
    <StatusPill
      label={translate(language)(`meetingPill_${status}`)}
      tone={style.tone}
      icon={style.icon}
      busy={style.busy}
      compact={compact}
    />
  );
}
function dayParts(iso: string, language: Language) {
  const date = new Date(iso);
  return {
    // Czech writes "8."; a calendar leaf shows the bare number.
    day: new Intl.DateTimeFormat(language, { day: "numeric" })
      .format(date)
      .replace(".", ""),
    month: new Intl.DateTimeFormat(language, { month: "short" })
      .format(date)
      .replace(".", ""),
    time: new Intl.DateTimeFormat(language, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date),
    full: new Intl.DateTimeFormat(language, {
      weekday: "short",
      day: "numeric",
      month: "short",
    }).format(date),
  };
}
/** A calendar leaf: the date is the fastest way to find a meeting again. */
function DateLeaf({ iso, language }: { iso: string; language: Language }) {
  const { day, month } = dayParts(iso, language);
  return (
    <View style={styles.leaf} aria-hidden>
      <Text role="overline" style={styles.leafMonth}>
        {month}
      </Text>
      <Text style={styles.leafDay}>{day}</Text>
    </View>
  );
}
export function MeetingRow({
  meeting,
  language,
  onOpen,
}: {
  meeting: Meeting;
  language: Language;
  onOpen(): void;
}) {
  const tr = translate(language);
  const { fontScale } = useWindowDimensions();
  const largeText = fontScale > 1.3;
  const { time, full } = dayParts(meeting.recordedAt, language);
  const timeAndDuration = [
    time,
    meeting.durationSeconds ? meetingDuration(meeting.durationSeconds) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const meta = largeText ? `${full} · ${timeAndDuration}` : timeAndDuration;
  return (
    <Pressable
      testID={`meeting-${meeting.id}`}
      accessibilityRole="button"
      accessibilityLabel={`${meeting.title}, ${full} ${timeAndDuration}, ${tr(`meeting_status_${meeting.status}`)}`}
      onPress={onOpen}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? t.color.pressed : "transparent" },
      ]}
    >
      {largeText ? null : (
        <DateLeaf iso={meeting.recordedAt} language={language} />
      )}
      <View style={{ flex: 1, minWidth: 0, gap: t.spacing.xs }}>
        <Text role="rowTitle" numberOfLines={largeText ? undefined : 2}>
          {meeting.title}
        </Text>
        <Row style={{ gap: 6, flexWrap: "wrap" }}>
          <Text
            role="meta"
            tone="secondary"
            style={{ fontVariant: ["tabular-nums"], flexShrink: 1 }}
          >
            {meta}
          </Text>
          <MeetingStatusPill
            status={meeting.status}
            language={language}
            compact
          />
        </Row>
      </View>
      <Icon name="chevron" size={18} color={t.color.text.disabled} />
    </Pressable>
  );
}
/** Who and when only: the record's state has its own surface below. */
export function MeetingHero({
  meeting,
  language,
}: {
  meeting: Meeting;
  language: Language;
}) {
  const { time, full } = dayParts(meeting.recordedAt, language);
  return (
    <View style={{ gap: t.spacing.xs }}>
      <Text role="title" accessibilityRole="header" selectable>
        {meeting.title}
      </Text>
      <Text
        role="meta"
        tone="secondary"
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {[
          `${full}, ${time}`,
          meeting.durationSeconds
            ? meetingDuration(meeting.durationSeconds)
            : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </Text>
    </View>
  );
}
const steps = ["upload", "transcribe", "analyze", "done"] as const;
const stepIndex: Partial<Record<Meeting["status"], number>> = {
  uploading: 0,
  sealed: 1,
  transcribing: 1,
  analyzing: 2,
};
/**
 * One loop for "the server is working on this step". It runs only for a step
 * that is really in progress and stays still when the OS asks for less motion.
 */
function useWorking(running: boolean) {
  const reduced = useReducedMotion();
  const [progress] = useState(() => new Animated.Value(0));
  const animate = running && !reduced;
  useEffect(() => {
    progress.stopAnimation();
    progress.setValue(0);
    if (!animate) return;
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: 1600,
        easing: Easing.linear,
        useNativeDriver: nativeMotion,
        isInteraction: false,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [animate, progress]);
  return animate ? progress : null;
}
const streakSteps = Array.from({ length: 13 }, (_, i) => i / 12);
const streakEase = Easing.inOut(Easing.cubic);
/** A soft light travelling along the rail toward the step that comes next. */
function RailStreak({ progress }: { progress: Animated.Value }) {
  const [width, setWidth] = useState(0);
  const streak = Math.max(24, Math.round(width * 0.55));
  return (
    <View
      style={styles.streakTrack}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
    >
      {width ? (
        <Animated.View
          style={{
            width: streak,
            height: 4,
            transform: [
              {
                // The native driver cannot ease an interpolation; sampled
                // points keep the same curve.
                translateX: progress.interpolate({
                  inputRange: streakSteps,
                  outputRange: streakSteps.map(
                    (step) => -streak + (width + streak) * streakEase(step),
                  ),
                }),
              },
            ],
          }}
        >
          <Svg width={streak} height={4} aria-hidden>
            <Defs>
              <LinearGradient id="meetingStreak" x1="0" y1="0" x2="1" y2="0">
                <Stop
                  offset="0"
                  stopColor={t.color.action.primary}
                  stopOpacity={0}
                />
                <Stop
                  offset="0.7"
                  stopColor={t.color.action.primary}
                  stopOpacity={1}
                />
                <Stop
                  offset="1"
                  stopColor={t.color.action.primary}
                  stopOpacity={0}
                />
              </LinearGradient>
            </Defs>
            <Rect width={streak} height={4} rx={2} fill="url(#meetingStreak)" />
          </Svg>
        </Animated.View>
      ) : null}
    </View>
  );
}
/**
 * Server status mapped onto the pipeline while work is in flight. Numbers come
 * only from what the server reports; analysis has no measurable progress.
 */
export function MeetingProgress({
  meeting,
  language,
}: {
  meeting: Meeting;
  language: Language;
}) {
  const tr = translate(language);
  const { status } = meeting;
  const current = stepIndex[status];
  // Sealed waits for the person, so nothing is shown as running.
  const working = useWorking(current !== undefined && status !== "sealed");
  if (current === undefined) return null;
  // Segments are whole minutes of audio (startSeconds = index × 60).
  const minutes = meeting.durationSeconds
    ? Math.max(1, Math.ceil(meeting.durationSeconds / 60))
    : null;
  const detail =
    status === "uploading" && meeting.bytes
      ? `${Math.min(100, Math.round((meeting.offset / meeting.bytes) * 100))} %`
      : status === "transcribing" && minutes
        ? tr("meetingTranscribedMinutes")
            .replace(
              "{done}",
              String(Math.min(meeting.completedSegments, minutes)),
            )
            .replace("{total}", String(minutes))
        : null;
  return (
    <View
      testID="meeting-progress"
      accessibilityRole="progressbar"
      accessibilityLabel={[tr(`meeting_status_${status}`), detail]
        .filter(Boolean)
        .join(", ")}
      style={styles.progress}
    >
      {/* Equal columns keep every label centred under its own step. */}
      <View>
        <View style={styles.railTrack}>
          <View
            style={[
              styles.railFill,
              {
                width: `${(Math.min(current, steps.length - 1) / (steps.length - 1)) * 100}%`,
              },
            ]}
          />
        </View>
        {working && current < steps.length - 1 ? (
          <View
            style={[styles.streakSegment, { left: `${12.5 + current * 25}%` }]}
          >
            <RailStreak progress={working} />
          </View>
        ) : null}
        <Row style={{ gap: 0, alignItems: "flex-start" }}>
          {steps.map((step, index) => {
            const done = index < current;
            const active = index === current && status !== "sealed";
            return (
              <View key={step} style={styles.step}>
                <View style={styles.dotSlot}>
                  <Ripple
                    size={22}
                    color={t.color.action.link}
                    running={active && !!working}
                    period={1600}
                    reach={1.9}
                  />
                  <View
                    style={[
                      styles.dot,
                      done
                        ? { backgroundColor: t.color.action.primary }
                        : {
                            borderWidth: 2,
                            borderColor: active
                              ? t.color.action.primary
                              : t.color.border,
                            backgroundColor: t.color.surfaceRaised,
                          },
                    ]}
                  >
                    {done ? (
                      <Icon
                        name="check"
                        size={13}
                        color={t.color.text.inverse}
                      />
                    ) : active ? (
                      <Animated.View
                        style={[
                          styles.pulse,
                          working
                            ? {
                                transform: [
                                  {
                                    scale: working.interpolate({
                                      inputRange: [0, 0.5, 1],
                                      outputRange: [0.8, 1.2, 0.8],
                                    }),
                                  },
                                ],
                              }
                            : null,
                        ]}
                      />
                    ) : null}
                  </View>
                </View>
                <Text
                  role="caption"
                  tone={index <= current ? "primary" : "secondary"}
                  numberOfLines={1}
                  style={{ fontSize: 12, textAlign: "center" }}
                >
                  {tr(`meetingStep_${step}`)}
                </Text>
              </View>
            );
          })}
        </Row>
      </View>
      <Row style={{ justifyContent: "space-between", paddingTop: 4 }}>
        <Text role="label" style={{ flex: 1 }}>
          {tr(`meeting_status_${status}`)}
        </Text>
        {detail ? (
          <Text
            role="caption"
            tone="secondary"
            style={{ fontVariant: ["tabular-nums"] }}
          >
            {detail}
          </Text>
        ) : null}
      </Row>
    </View>
  );
}
export function TranscriptReader({
  record,
  language,
}: {
  record: MeetingRecord;
  language: Language;
}) {
  const tr = translate(language);
  const [showOriginal, setShowOriginal] = useState(false);
  const transcript = showOriginal
    ? record.transcript
    : cleanTranscriptForReading(record.transcript);
  const paragraphs = transcriptParagraphs(transcript);
  return (
    <FlatList
      testID="meeting-transcript-reader"
      data={paragraphs}
      keyExtractor={(_, index) => String(index)}
      initialNumToRender={8}
      windowSize={7}
      contentContainerStyle={{
        paddingHorizontal: t.spacing.screenGutter,
        paddingBottom: t.spacing.xxl,
        gap: t.spacing.lg,
      }}
      ListHeaderComponent={
        <View style={{ gap: t.spacing.md, paddingBottom: t.spacing.sm }}>
          {record.reviewReasons.length ? (
            <MeetingNotice
              title={tr("meetingTranscriptReview")}
              hint={tr("meetingTranscriptReviewHint")}
            />
          ) : null}
          {!record.transcriptComplete ? (
            <Notice>{tr("meetingIncompleteTranscript")}</Notice>
          ) : null}
          <View style={{ gap: 6 }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                showOriginal
                  ? tr("meetingTranscriptReadable")
                  : tr("meetingTranscriptOriginal")
              }
              onPress={() => setShowOriginal((value) => !value)}
              hitSlop={8}
              style={{ alignSelf: "flex-start" }}
            >
              <Text
                role="caption"
                style={{ color: t.color.action.link, fontWeight: "600" }}
              >
                {showOriginal
                  ? tr("meetingTranscriptReadable")
                  : tr("meetingTranscriptOriginal")}
              </Text>
            </Pressable>
            {!showOriginal ? (
              <Text role="caption" tone="secondary">
                {tr("meetingTranscriptCleanHint")}
              </Text>
            ) : null}
          </View>
        </View>
      }
      ListEmptyComponent={
        <Text tone="secondary">{tr("meetingNoTranscript")}</Text>
      }
      renderItem={({ item }) => (
        <Text selectable style={{ fontSize: 16, lineHeight: 26 }}>
          {item}
        </Text>
      )}
    />
  );
}
/** One scroll: what was decided, what follows from it, then the raw words. */
export function MeetingDetailView({
  record,
  language,
  onSource,
  onTasks,
  selectedProcessTaskId,
  unavailableProcessTaskIds = [],
  onSelectProcessTask,
  onTranscript,
  statusShown = false,
}: {
  record: MeetingRecord;
  language: Language;
  onSource(index: number): void;
  onTasks?(): void;
  selectedProcessTaskId?: string | null;
  unavailableProcessTaskIds?: readonly string[];
  onSelectProcessTask?(index: number): void;
  /** The screen already shows progress or the failure for this record. */
  statusShown?: boolean;
  /** Opens the full reader; without it the transcript is shown in place. */
  onTranscript?(): void;
}) {
  const tr = translate(language);
  const analysis = record.analysis;
  const preview = cleanTranscriptForReading(record.transcript).slice(0, 600);
  return (
    <View style={{ gap: t.spacing.section }}>
      {analysis ? (
        <View style={{ gap: t.spacing.md }}>
          <SectionLabel>{tr("meetingWholeSummary")}</SectionLabel>
          <View style={styles.prose}>
            <SourceEvidence
              testID="meeting-summary-sources"
              sources={analysis.summarySources}
              language={language}
              onSource={onSource}
            >
              <Text selectable>
                {analysis.summary || tr("meetingNoSummary")}
              </Text>
            </SourceEvidence>
            {analysis.points.map((point, index) => (
              <SourceEvidence
                key={index}
                testID={`meeting-point-sources-${index}`}
                sources={point.sources}
                language={language}
                onSource={onSource}
                bullet
              >
                <Text selectable>{point.text}</Text>
              </SourceEvidence>
            ))}
          </View>
        </View>
      ) : record.meeting.status === "ready" || statusShown ? null : (
        <MeetingNotice
          title={tr("meetingPartial")}
          hint={tr("meetingPartialHint")}
        />
      )}
      {analysis ? (
        <View style={{ gap: t.spacing.sm }}>
          <SectionLabel
            trailing={
              onTasks && analysis.tasks.length ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={tr("meetingOpenHumanTasks")}
                  onPress={onTasks}
                  hitSlop={12}
                >
                  <Text
                    role="section"
                    style={{ color: t.color.action.link }}
                  >
                    {tr("meetingOpenHumanTasks")}
                  </Text>
                </Pressable>
              ) : null
            }
          >
            {tr("meetingWholeTasks")}
            {analysis.tasks.length ? ` · ${analysis.tasks.length}` : ""}
          </SectionLabel>
          {analysis.tasks.length ? (
            <Group>
              {analysis.tasks.map((task, index) => {
                const id = record.humanTaskIds[index];
                return (
                  <View key={id ?? index} style={styles.task}>
                    {index ? <View style={styles.separator} /> : null}
                    <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                      <Text role="rowLabel" selectable>
                        {task.text}
                      </Text>
                      <Row style={styles.meta}>
                        {task.assignee ? (
                          <MetaItem
                            icon="person"
                            label={task.assignee}
                            accessibilityLabel={`${tr("meetingAssignee")}: ${task.assignee}`}
                          />
                        ) : null}
                        {task.due ? (
                          <MetaItem
                            icon="clock"
                            label={task.due}
                            accessibilityLabel={`${tr("meetingDue")}: ${task.due}`}
                          />
                        ) : null}
                        {task.sources.map((source, at) => (
                          <SourceLink
                            key={at}
                            segment={source.segment}
                            language={language}
                            onSource={onSource}
                          />
                        ))}
                      </Row>
                    </View>
                    {onSelectProcessTask && id ? (
                      <ProcessTaskButton
                        state={
                          unavailableProcessTaskIds.includes(id)
                            ? "unavailable"
                            : selectedProcessTaskId === id
                              ? "selected"
                              : "idle"
                        }
                        language={language}
                        onPress={() => onSelectProcessTask(index)}
                      />
                    ) : null}
                  </View>
                );
              })}
            </Group>
          ) : (
            <Text role="caption" tone="secondary" style={styles.inset}>
              {tr("meetingNoTasks")}
            </Text>
          )}
        </View>
      ) : null}
      <View style={{ gap: t.spacing.sm }}>
        <SectionLabel>{tr("meetingTranscript")}</SectionLabel>
        {onTranscript ? (
          <>
            {record.reviewReasons.length ? (
              <MeetingNotice
                title={tr("meetingTranscriptReview")}
                hint={tr("meetingTranscriptReviewHint")}
              />
            ) : null}
            <Group>
              <Pressable
                testID="meeting-transcript-preview"
                accessibilityRole="button"
                accessibilityLabel={tr("meetingReadTranscript")}
                onPress={onTranscript}
                style={({ pressed }) => [
                  styles.block,
                  { backgroundColor: pressed ? t.color.pressed : undefined },
                ]}
              >
                <Text
                  tone={record.transcript ? "secondary" : "disabled"}
                  numberOfLines={3}
                >
                  {preview || tr("meetingNoTranscript")}
                </Text>
                <Row>
                  <Text
                    role="label"
                    style={{ color: t.color.action.link, flex: 1 }}
                  >
                    {tr("meetingReadTranscript")}
                  </Text>
                  <Icon
                    name="chevron"
                    size={18}
                    color={t.color.text.disabled}
                  />
                </Row>
              </Pressable>
            </Group>
          </>
        ) : (
          <View style={{ gap: t.spacing.md }}>
            {record.reviewReasons.length ? (
              <MeetingNotice
                title={tr("meetingTranscriptReview")}
                hint={tr("meetingTranscriptReviewHint")}
              />
            ) : null}
            {!record.transcriptComplete ? (
              <Notice>{tr("meetingIncompleteTranscript")}</Notice>
            ) : null}
            <Group>
              <View style={styles.block}>
                <Text selectable style={{ lineHeight: 24 }}>
                  {cleanTranscriptForReading(record.transcript) ||
                    tr("meetingNoTranscript")}
                </Text>
              </View>
            </Group>
          </View>
        )}
      </View>
    </View>
  );
}
/** An icon and a short fact in a meta line, read out with what it is. */
function MetaItem({
  icon,
  label,
  accessibilityLabel,
}: {
  icon: IconName;
  label: string;
  accessibilityLabel: string;
}) {
  return (
    <Row
      accessible
      accessibilityLabel={accessibilityLabel}
      style={{ gap: 4, flexShrink: 1 }}
    >
      <Icon name={icon} size={14} color={t.color.text.secondary} />
      <Text role="meta" tone="secondary" numberOfLines={1}>
        {label}
      </Text>
    </Row>
  );
}
/** Jumps to the transcript minute a claim came from. */
function SourceLink({
  segment,
  language,
  onSource,
}: {
  segment: number;
  language: Language;
  onSource(index: number): void;
}) {
  const time = meetingTime(segment * 60);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${translate(language)("meetingSource")} ${time}`}
      onPress={() => onSource(segment)}
      hitSlop={10}
      style={({ pressed }) => [
        styles.sourceLink,
        { opacity: pressed ? 0.6 : 1 },
      ]}
    >
      <Icon name="quote" size={13} color={t.color.action.link} />
      <Text
        role="meta"
        style={{
          color: t.color.action.link,
          fontWeight: "600",
          fontVariant: ["tabular-nums"],
        }}
      >
        {time}
      </Text>
    </Pressable>
  );
}
/** A row's own action: hand this meeting task to a process. */
function ProcessTaskButton({
  state,
  language,
  onPress,
}: {
  state: "idle" | "selected" | "unavailable";
  language: Language;
  onPress(): void;
}) {
  const tr = translate(language);
  const selected = state === "selected";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={tr(
        state === "unavailable"
          ? "meetingProcessTaskCheck"
          : selected
            ? "meetingProcessTaskSelected"
            : "meetingProcessSelectTask",
      )}
      accessibilityState={{ selected }}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [
        styles.rowAction,
        {
          backgroundColor: selected
            ? pressed
              ? t.color.action.pressed
              : t.color.action.primary
            : pressed
              ? t.color.fillPressed
              : t.color.fill,
        },
      ]}
    >
      <Icon
        name={state === "unavailable" ? "refresh" : selected ? "check" : "play"}
        size={16}
        color={selected ? t.color.text.inverse : t.color.text.primary}
      />
    </Pressable>
  );
}
/**
 * A claim with a small quote count beside it; tapping the count shows the
 * quotes, and each quote opens its place in the transcript.
 */
function SourceEvidence({
  testID,
  sources,
  language,
  onSource,
  bullet = false,
  children,
}: React.PropsWithChildren<{
  testID: string;
  sources: readonly { segment: number; quote: string }[];
  language: Language;
  onSource(index: number): void;
  bullet?: boolean;
}>) {
  const [expanded, setExpanded] = useState(false);
  const tr = translate(language);
  return (
    <View testID={testID} style={{ gap: t.spacing.sm }}>
      <Row style={{ alignItems: "flex-start", gap: 10 }}>
        {bullet ? <View style={styles.bullet} /> : null}
        <View style={{ flex: 1, minWidth: 0 }}>{children}</View>
        {sources.length ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            accessibilityLabel={`${expanded ? tr("meetingHideSources") : tr("meetingShowSources")} · ${sources.length}`}
            onPress={() => setExpanded((value) => !value)}
            hitSlop={10}
            style={({ pressed }) => [
              styles.evidence,
              {
                backgroundColor: expanded
                  ? t.color.accent.softBlue
                  : pressed
                    ? t.color.fillPressed
                    : t.color.fill,
              },
            ]}
          >
            <Icon
              name="quote"
              size={12}
              color={expanded ? t.color.action.primary : t.color.text.secondary}
            />
            <Text
              role="overline"
              style={{
                color: expanded
                  ? t.color.action.primary
                  : t.color.text.secondary,
                fontVariant: ["tabular-nums"],
              }}
            >
              {sources.length}
            </Text>
          </Pressable>
        ) : null}
      </Row>
      {expanded ? (
        <View style={{ gap: t.spacing.sm, paddingLeft: bullet ? 16 : 0 }}>
          {sources.map((source, index) => {
            const time = meetingTime(source.segment * 60);
            return (
              <Pressable
                key={`${source.segment}:${index}`}
                accessibilityRole="button"
                accessibilityLabel={`${tr("meetingSource")} ${time}`}
                onPress={() => onSource(source.segment)}
                style={({ pressed }) => [
                  styles.quote,
                  pressed && { backgroundColor: t.color.pressed },
                ]}
              >
                <Text role="caption" tone="secondary" selectable>
                  “{source.quote}”
                </Text>
                <Row style={{ gap: 4 }}>
                  <Text
                    role="meta"
                    style={{
                      color: t.color.action.link,
                      fontWeight: "600",
                      fontVariant: ["tabular-nums"],
                    }}
                  >
                    {time}
                  </Text>
                  <Icon
                    name="chevron"
                    size={14}
                    color={t.color.action.link}
                  />
                </Row>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}
/** A quiet reason to act when the record cannot proceed by itself. */
export function MeetingActionCard({
  title,
  hint,
  tone = "neutral",
  children,
}: React.PropsWithChildren<{
  title: string;
  hint?: string;
  tone?: "neutral" | "error";
}>) {
  return (
    <View
      accessibilityRole={tone === "error" ? "alert" : undefined}
      style={[
        styles.action,
        tone === "error" ? { backgroundColor: t.color.statusSoft.error } : null,
      ]}
    >
      <Row style={{ alignItems: "flex-start", gap: 10 }}>
        {tone === "error" ? (
          <Icon name="alert" size={18} color={t.color.status.error} />
        ) : null}
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text role="label">{title}</Text>
          {hint ? <Text role="caption">{hint}</Text> : null}
        </View>
      </Row>
      {children}
    </View>
  );
}
const styles = StyleSheet.create({
  notice: {
    padding: t.spacing.md,
    borderRadius: t.radius.control,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  row: {
    minHeight: 68,
    paddingHorizontal: t.spacing.lg,
    paddingVertical: t.spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: t.spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: t.color.hairline,
  },
  leaf: {
    minWidth: 44,
    minHeight: 48,
    flexShrink: 0,
    borderRadius: t.radius.control,
    paddingHorizontal: t.spacing.xs,
    paddingVertical: t.spacing.xs,
    alignItems: "center",
    backgroundColor: t.color.fill,
  },
  leafMonth: {
    alignSelf: "stretch",
    textAlign: "center",
    fontSize: 10,
    lineHeight: 15,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: t.color.text.secondary,
  },
  leafDay: {
    fontSize: 19,
    lineHeight: 22,
    fontWeight: "700",
    color: t.color.text.primary,
    fontVariant: ["tabular-nums"],
  },
  progress: {
    gap: 8,
    padding: t.spacing.lg,
    borderRadius: t.radius.group,
    backgroundColor: t.color.surface,
    borderWidth: 1,
    borderColor: t.color.surfaceRaised,
    ...t.elevation.card,
  },
  step: { flex: 1, alignItems: "center", gap: 6 },
  // From the first column's centre to the last one's (each column is 1/4).
  railTrack: {
    position: "absolute",
    top: 10,
    left: "12.5%",
    right: "12.5%",
    height: 2,
    borderRadius: 1,
    backgroundColor: t.color.border,
  },
  railFill: {
    height: 2,
    borderRadius: 1,
    backgroundColor: t.color.action.primary,
  },
  dotSlot: { width: 22, height: 22 },
  // Exactly the rail between the running step and the next one (a quarter).
  streakSegment: {
    position: "absolute",
    top: 9,
    width: "25%",
    height: 4,
  },
  streakTrack: { flex: 1, overflow: "hidden", borderRadius: 2 },
  dot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  pulse: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: t.color.action.primary,
  },
  block: { padding: t.spacing.lg, gap: t.spacing.md },
  prose: { paddingHorizontal: t.spacing.xs, gap: t.spacing.md },
  bullet: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginTop: 8,
    backgroundColor: t.color.text.secondary,
  },
  evidence: {
    height: 22,
    minWidth: 34,
    paddingHorizontal: 7,
    borderRadius: t.radius.pill,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
  },
  quote: {
    paddingLeft: t.spacing.md,
    paddingVertical: 2,
    gap: 4,
    borderLeftWidth: 2,
    borderLeftColor: t.color.border,
  },
  task: {
    minHeight: t.control.rowTall,
    paddingHorizontal: t.spacing.lg,
    paddingVertical: t.spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: t.spacing.md,
  },
  separator: {
    position: "absolute",
    top: 0,
    left: t.spacing.lg,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: t.color.border,
  },
  meta: { flexWrap: "wrap", columnGap: t.spacing.md, rowGap: 2 },
  sourceLink: { flexDirection: "row", alignItems: "center", gap: 3 },
  rowAction: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  inset: { paddingHorizontal: t.spacing.xs },
  action: {
    padding: t.spacing.lg,
    gap: t.spacing.md,
    borderRadius: t.radius.group,
    backgroundColor: t.color.surface,
    borderWidth: 1,
    borderColor: t.color.surfaceRaised,
  },
});
