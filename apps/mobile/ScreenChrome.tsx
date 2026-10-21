import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  type PropsWithChildren,
} from "react";
import {
  Animated,
  ActivityIndicator,
  Modal,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { tokens as t } from "../../packages/design-tokens";
import { translate, type TranslationKey } from "../../packages/i18n";
import type { Language } from "../../packages/protocol";
import {
  Text,
  ui,
  Row,
  Icon,
  IconTile,
  Button,
  type IconName,
} from "../../packages/ui";
import { VoiceOrb } from "../../packages/ui/VoiceOrb";
import { Tabs } from "../../packages/ui/Tabs";

import {
  Entrance,
  MotionPressable,
  nativeMotion,
  motionEase,
  useReducedMotion,
} from "../../packages/ui/motion";

export type Section = "chat" | "meetings" | "tasks" | "more";
export type TaskTab = "open" | "done";
export const chrome = StyleSheet.create({
  flex: { flex: 1, minHeight: 0 },
  screen: {
    flex: 1,
    minHeight: 0,
    width: "100%",
    maxWidth: 520,
    alignSelf: "center",
  },
  content: {
    paddingHorizontal: t.spacing.screenGutter,
    paddingTop: 8,
    paddingBottom: 24,
    gap: 16,
    flexGrow: 1,
  },
  // The section entrance wraps the content, so it carries the same rhythm.
  section: { gap: 16 },
  topbar: {
    minHeight: 52,
    paddingHorizontal: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  topbarTitle: { flex: 1, minWidth: 0, paddingHorizontal: 6, gap: 1 },
  // Tab roots: a large left-aligned title, actions on its line.
  topbarLarge: {
    minHeight: 60,
    paddingLeft: t.spacing.screenGutter,
    paddingRight: 8,
    paddingTop: 10,
    paddingBottom: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  nav: {
    flexDirection: "row",
    paddingTop: 8,
    paddingBottom: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: t.color.border,
    backgroundColor: t.color.background,
  },
  navItem: {
    flex: 1,
    minHeight: 50,
    alignItems: "center",
    justifyContent: "flex-start",
    gap: 3,
  },
  navIcon: {
    width: 48,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  navBadge: {
    position: "absolute",
    top: -2,
    left: 27,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: t.color.background,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.color.action.primary,
  },
  badge: {
    position: "absolute",
    top: 7,
    right: 5,
    width: 9,
    height: 9,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: t.color.background,
    backgroundColor: t.color.action.primary,
  },
  count: {
    borderRadius: 10,
    minWidth: 20,
    minHeight: 20,
    marginRight: -4,
    paddingHorizontal: 6,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: t.color.action.primary,
  },
  home: {
    flex: 1,
    minHeight: 440,
    justifyContent: "space-between",
    gap: t.spacing.xl,
    paddingTop: t.spacing.lg,
    paddingBottom: t.spacing.sm,
  },
  stage: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: t.spacing.md,
  },
  headline: { alignItems: "center", gap: 8, maxWidth: 320 },
  center: { textAlign: "center" },
  shortcuts: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: t.spacing.sm,
  },
  shortcut: {
    minHeight: 44,
    paddingLeft: 14,
    paddingRight: 16,
    borderRadius: t.radius.pill,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  footer: {
    paddingTop: 6,
    paddingBottom: 8,
    paddingHorizontal: t.spacing.screenGutter,
    gap: 8,
  },
  // 44 + 2 × 4 + 1px edges = 54: the voice composer has the same box, and its
  // Done button sits exactly where the microphone was.
  readOnly: {
    ...ui.composerFrame,
    minHeight: 54,
    paddingLeft: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  composer: {
    ...ui.composerFrame,
    minHeight: 54,
    paddingLeft: 16,
    paddingRight: 4,
    paddingVertical: 4,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 4,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 132,
    paddingHorizontal: 0,
    paddingVertical: 11,
    textAlignVertical: "center",
    includeFontPadding: false,
    color: t.color.text.primary,
    ...t.typography.body,
  },
  composerAction: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  reply: {
    paddingLeft: 12,
    paddingVertical: 2,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderLeftWidth: 2,
    borderLeftColor: t.color.action.primary,
  },
  message: {
    alignSelf: "flex-end",
    maxWidth: "85%",
    gap: 4,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 20,
    borderBottomRightRadius: 6,
    backgroundColor: t.color.accent.softBlue,
  },
  assistant: { alignSelf: "stretch", gap: 10 },
  answer: { paddingHorizontal: 2 },
  empty: {
    flex: 1,
    minHeight: 240,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    paddingVertical: 24,
    gap: 6,
  },
  modal: {
    flex: 1,

    justifyContent: "flex-end",
    alignItems: "center",
  },
  sheet: {
    width: "100%",
    maxWidth: 520,
    maxHeight: "92%",
    backgroundColor: t.color.surface,
    borderTopLeftRadius: t.radius.sheet,
    borderTopRightRadius: t.radius.sheet,
    overflow: "hidden",
    ...t.elevation.sheet,
  },
  grabber: {
    pointerEvents: "none",
    width: 36,
    height: 5,
    borderRadius: 3,
    backgroundColor: t.color.fillPressed,
    alignSelf: "center",
    marginTop: 8,
  },
  sheetHeader: {
    paddingLeft: t.spacing.screenGutter,
    paddingRight: 12,
    paddingTop: 10,
    paddingBottom: 6,
    minHeight: 52,
    gap: 12,
  },
  sheetClose: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  sheetBody: {
    paddingHorizontal: t.spacing.screenGutter,
    paddingTop: 8,
    paddingBottom: t.spacing.screenGutter,
    gap: 12,
  },
  sheetActions: {
    paddingHorizontal: t.spacing.screenGutter,
    paddingTop: 8,
    paddingBottom: 12,
    gap: 4,
  },
});
export function IconButton({
  label,
  icon,
  onPress,
  disabled = false,
  filled = false,
  loading = false,
  badge = false,
}: {
  label: string;
  icon: IconName;
  onPress: () => void;
  disabled?: boolean;
  filled?: boolean;
  loading?: boolean;
  /** A small dot for something waiting behind this button. */
  badge?: boolean;
}) {
  return (
    <MotionPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      disabled={disabled || loading}
      onPress={onPress}
      hitSlop={2}
      style={({ pressed }) => [
        chrome.iconButton,
        {
          backgroundColor: filled
            ? disabled
              ? t.color.text.disabled
              : t.color.action.primary
            : pressed
              ? t.color.pressed
              : "transparent",
          opacity: disabled && !filled ? 0.4 : 1,
        },
      ]}
    >
      {loading ? (
        <ActivityIndicator
          size="small"
          color={filled ? t.color.text.inverse : t.color.action.primary}
        />
      ) : (
        <Entrance key={icon} distance={3} duration={t.motion.feedback}>
          <Icon
            name={icon}
            size={22}
            color={filled ? t.color.text.inverse : t.color.text.primary}
          />
        </Entrance>
      )}
      {badge ? <View testID="icon-badge" style={chrome.badge} /> : null}
    </MotionPressable>
  );
}
/**
 * One bar for every screen: a leading control, a title and up to two actions.
 * Tab roots (no leading control) get a large left-aligned title; nested
 * screens a compact one beside Back.
 */
export function TopBar({
  leading,
  title,
  subtitle,
  trailing,
  large = !leading,
}: {
  /** A Back or Menu control; tab roots have none. */
  leading?: React.ReactNode;
  title: string;
  subtitle?: React.ReactNode;
  trailing?: React.ReactNode;
  large?: boolean;
}) {
  if (large)
    return (
      <View style={chrome.topbarLarge}>
        {leading}
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text role="largeTitle" accessibilityRole="header" numberOfLines={1}>
            {title}
          </Text>
          {subtitle}
        </View>
        {trailing}
      </View>
    );
  return (
    <View style={chrome.topbar}>
      {leading}
      <View style={chrome.topbarTitle}>
        <Text role="cardTitle" accessibilityRole="header" numberOfLines={1}>
          {title}
        </Text>
        {subtitle}
      </View>
      {trailing}
    </View>
  );
}
const destinations = [
  { id: "chat", icon: "chat", label: "chat" },
  { id: "meetings", icon: "calendar", label: "meetings" },
  { id: "tasks", icon: "tasks", label: "tasks" },
  { id: "more", icon: "settings", label: "settingsTitle" },
] as const;
/** The four places of the app, always one tap away; the choice turns blue. */
export function Navigation({
  section,
  onChange,
  language,
  count,
}: {
  section: Section;
  onChange: (section: Section) => void;
  language: Language;
  /** Work waiting in Tasks. */
  count: number;
}) {
  const tr = translate(language);
  return (
    <View
      testID="bottom-navigation"
      accessibilityRole="tablist"
      style={chrome.nav}
    >
      {destinations.map((destination) => {
        const selected = destination.id === section;
        const waiting = destination.id === "tasks" ? count : 0;
        return (
          <MotionPressable
            key={destination.id}
            accessibilityRole="tab"
            accessibilityLabel={tr(destination.label)}
            accessibilityValue={waiting ? { text: String(waiting) } : undefined}
            accessibilityState={{ selected }}
            aria-selected={selected}
            onPress={() => onChange(destination.id)}
            style={chrome.navItem}
          >
            <View style={chrome.navIcon}>
              <Entrance
                key={selected ? "on" : "off"}
                distance={selected ? 2 : 0}
                duration={t.motion.feedback}
              >
                <Icon
                  name={destination.icon}
                  size={24}
                  color={
                    selected ? t.color.action.primary : t.color.text.secondary
                  }
                />
              </Entrance>
              {waiting ? (
                <View style={chrome.navBadge}>
                  <Text
                    role="caption"
                    tone="inverse"
                    style={{ fontSize: 11, lineHeight: 14, fontWeight: "700" }}
                  >
                    {waiting > 9 ? "9+" : waiting}
                  </Text>
                </View>
              ) : null}
            </View>
            <Text
              role="caption"
              numberOfLines={1}
              style={{
                fontSize: 11,
                lineHeight: 14,
                color: selected
                  ? t.color.action.primary
                  : t.color.text.secondary,
                fontWeight: selected ? "600" : "500",
              }}
            >
              {tr(destination.label)}
            </Text>
          </MotionPressable>
        );
      })}
    </View>
  );
}
/** Connection state as a quiet line under the title, never a blocking card. */
export function StatusLine({ label }: { label: string }) {
  return (
    <Row
      style={{ gap: 6 }}
      accessibilityRole="text"
      accessibilityLiveRegion="polite"
    >
      <View
        style={{
          width: 7,
          height: 7,
          borderRadius: 4,
          backgroundColor: t.color.status.warning,
        }}
      />
      <Text
        role="caption"
        tone="secondary"
        numberOfLines={1}
        style={{ flexShrink: 1 }}
      >
        {label}
      </Text>
    </Row>
  );
}
export function MenuItem({
  icon,
  label,
  onPress,
  disabled = false,
  selected = false,
  trailing,
  description,
  count,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  selected?: boolean;
  trailing?: React.ReactNode;
  description?: string;
  /** Read out with the label; the visible badge is in `trailing`. */
  count?: number;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityValue={count ? { text: String(count) } : undefined}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 48,
        marginHorizontal: 8,
        paddingHorizontal: 12,
        borderRadius: 12,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        opacity: disabled ? 0.45 : 1,
        backgroundColor: selected
          ? t.color.accent.softBlue
          : pressed
            ? t.color.pressed
            : "transparent",
      })}
    >
      <Icon name={icon} size={20} color={t.color.text.primary} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1}>{label}</Text>
        {description ? (
          <Text role="caption" tone="secondary" numberOfLines={1}>
            {description}
          </Text>
        ) : null}
      </View>
      {trailing}
    </Pressable>
  );
}
export function TaskTabs({
  tab,
  onChange,
  count,
  language,
}: {
  tab: TaskTab;
  onChange: (v: TaskTab) => void;
  count: number;
  language: Language;
}) {
  const tr = translate(language);
  return (
    <View style={{ marginHorizontal: t.spacing.screenGutter, marginBottom: 8 }}>
      <Tabs
        testID="task-filters"
        indicatorTestID="filter-indicator"
        value={tab}
        onChange={onChange}
        options={[
          { id: "open", label: tr("openTasks"), count },
          { id: "done", label: tr("doneTasks") },
        ]}
      />
    </View>
  );
}
export type VoiceAvailability = "unknown" | "available" | "unavailable";
/**
 * The first screen: one way to talk, one line on how, and the few places
 * worth going. Without a server it introduces the assistant instead.
 */
export function Home({
  language,
  paired = true,
  connected,
  busy,
  count = 0,
  voice = "unknown",
  voiceBusy = false,
  meetingRecording = false,
  level,
  onTalk,
  onMeeting,
  onRecord,
  onTasks,
  onProcesses,
  onConnect,
}: {
  language: Language;
  /** A server is configured; otherwise this is the introduction. */
  paired?: boolean;
  connected: boolean;
  busy: boolean;
  /** Work waiting for this person. */
  count?: number;
  voice?: VoiceAvailability;
  /** A voice draft is already open below. */
  voiceBusy?: boolean;
  /** The open voice draft's microphone level, 0–1. */
  level?: Animated.Value;
  /** The microphone is held by a meeting recording. */
  meetingRecording?: boolean;
  onTalk?: () => void;
  onMeeting: () => void;
  onRecord?: () => void;
  onTasks: () => void;
  onProcesses?: () => void;
  onConnect: () => void;
}) {
  const tr = translate(language);
  if (!paired)
    return (
      <View testID="home-screen" style={chrome.home}>
        <View style={chrome.stage}>
          <VoiceOrb state="dormant" size={132} />
          <View style={chrome.headline}>
            <Text
              role="screenTitle"
              accessibilityRole="header"
              style={chrome.center}
            >
              {tr("onboardTitle")}
            </Text>
            <Text tone="secondary" style={chrome.center}>
              {tr("onboardIntro")}
            </Text>
          </View>
        </View>
        <View style={{ gap: t.spacing.xl }}>
          <View style={{ gap: t.spacing.lg }}>
            {(
              [
                { icon: "calendar", label: "onboardPlan" },
                { icon: "waveform", label: "onboardRecord" },
                { icon: "check", label: "onboardApprove" },
              ] as const
            ).map((feature) => (
              <Row key={feature.label} style={{ gap: t.spacing.md }}>
                <IconTile icon={feature.icon} size={36} />
                <Text style={{ flex: 1 }}>{tr(feature.label)}</Text>
              </Row>
            ))}
          </View>
          <Button label={tr("connect")} disabled={busy} onPress={onConnect} />
        </View>
      </View>
    );
  const intro: TranslationKey = !connected
    ? "homeOffline"
    : meetingRecording
      ? "homeVoiceRecording"
      : voice === "unavailable"
        ? "homeNoVoice"
        : "homeIntro";
  const talkable =
    connected && !meetingRecording && voice !== "unavailable" && !!onTalk;
  const shortcuts: {
    id: string;
    label: string;
    icon: IconName;
    onPress?: () => void;
    disabled?: boolean;
    count?: number;
  }[] = [
    {
      id: "plan",
      label: tr("quickMeeting"),
      icon: "calendar",
      onPress: onMeeting,
      disabled: !connected || busy,
    },
    // Recording is local first, so it stays available while offline.
    ...(onRecord
      ? [
          {
            id: "record",
            label: tr("homeRecord"),
            icon: "waveform" as const,
            onPress: onRecord,
          },
        ]
      : []),
    // Tasks has its own tab; here it appears only when something waits.
    ...(count
      ? [
          {
            id: "tasks",
            label: tr("homeWaiting"),
            icon: "tasks" as const,
            onPress: onTasks,
            count,
          },
        ]
      : []),
    ...(onProcesses
      ? [
          {
            id: "processes",
            label: tr("processesTitle"),
            icon: "bolt" as const,
            onPress: onProcesses,
            disabled: !connected || busy,
          },
        ]
      : []),
  ];
  // Work waiting for this person leads; otherwise the order teaches the product.
  if (count)
    shortcuts.unshift(
      ...shortcuts.splice(
        shortcuts.findIndex((x) => x.id === "tasks"),
        1,
      ),
    );
  return (
    <View testID="home-screen" style={chrome.home}>
      <View style={chrome.stage}>
        {/* While a voice draft is open below, the orb becomes its live picture. */}
        <VoiceOrb
          testID="home-voice"
          label={tr("talkToAssistant")}
          onPress={voiceBusy ? undefined : onTalk}
          state={voiceBusy ? "live" : talkable ? "ready" : "disabled"}
          level={level}
        />
        <View style={chrome.headline}>
          <Text
            role="screenTitle"
            accessibilityRole="header"
            style={chrome.center}
          >
            {tr("hello")}
          </Text>
          {/* Stays put while voice is open: nothing on the page may jump. */}
          <Text tone="secondary" style={chrome.center}>
            {tr(intro)}
          </Text>
        </View>
      </View>
      <View testID="home-shortcuts" style={chrome.shortcuts}>
        {shortcuts.map((shortcut) => (
          <MotionPressable
            key={shortcut.id}
            accessibilityRole="button"
            accessibilityLabel={
              shortcut.count
                ? `${shortcut.label}: ${shortcut.count}`
                : shortcut.label
            }
            accessibilityState={{ disabled: !!shortcut.disabled }}
            aria-disabled={!!shortcut.disabled}
            disabled={shortcut.disabled}
            onPress={shortcut.onPress}
            style={({ pressed }) => [
              chrome.shortcut,
              {
                opacity: shortcut.disabled ? 0.45 : 1,
                backgroundColor: pressed ? t.color.fillPressed : t.color.fill,
              },
            ]}
          >
            <Icon
              name={shortcut.icon}
              size={18}
              color={t.color.action.primary}
            />
            <Text role="label" numberOfLines={1} style={{ flexShrink: 1 }}>
              {shortcut.label}
            </Text>
            {shortcut.count ? (
              <View style={chrome.count}>
                <Text
                  role="caption"
                  tone="inverse"
                  style={{ fontWeight: "600", fontSize: 12, lineHeight: 16 }}
                >
                  {shortcut.count}
                </Text>
              </View>
            ) : null}
          </MotionPressable>
        ))}
      </View>
    </View>
  );
}
function ComposerAction({
  label,
  icon,
  onPress,
  filled,
  disabled = false,
  loading = false,
}: {
  label: string;
  icon: IconName;
  onPress: () => void;
  filled: boolean;
  disabled?: boolean;
  loading?: boolean;
}) {
  const inactive = disabled || loading;
  return (
    <MotionPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [
        chrome.composerAction,
        {
          backgroundColor: filled
            ? inactive && !loading
              ? t.color.text.disabled
              : pressed
                ? t.color.action.pressed
                : t.color.action.primary
            : pressed
              ? t.color.pressed
              : "transparent",
        },
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={t.color.text.inverse} />
      ) : (
        <Icon
          name={icon}
          size={22}
          color={filled ? t.color.text.inverse : t.color.text.secondary}
        />
      )}
    </MotionPressable>
  );
}
/** Takes the composer's place in an archived chat: say why and offer a way on. */
export function ReadOnlyComposer({
  language,
  onNewChat,
  onRestore,
  error,
}: {
  language: Language;
  onNewChat?: () => void;
  /** Brings the archived chat back to the menu so it can go on. */
  onRestore?: () => void;
  error?: TranslationKey;
}) {
  const tr = translate(language);
  return (
    <View testID="read-only-composer" style={chrome.readOnly}>
      <Icon name="archive" size={16} color={t.color.text.secondary} />
      <Text
        role="caption"
        tone="secondary"
        style={[{ flex: 1 }, error ? { color: t.color.action.danger } : null]}
      >
        {tr(error ?? "chatHistoryReadOnly")}
      </Text>
      {onNewChat ? (
        <Button
          size="small"
          variant="secondary"
          label={tr("newChat")}
          onPress={onNewChat}
        />
      ) : null}
      {onRestore ? (
        <Button size="small" label={tr("restoreChat")} onPress={onRestore} />
      ) : null}
    </View>
  );
}

export function Composer({
  language,
  value,
  onChange,
  onSend,
  onVoice,
  disabled,
  sending = false,
  inputRef,
  voice = "ready",
}: {
  language: Language;
  value: string;
  onChange: (s: string) => void;
  onSend: () => void;
  onVoice: () => void;
  disabled: boolean;
  sending?: boolean;
  inputRef?: React.Ref<TextInput>;
  /** Hidden where another control starts voice or the server has none. */
  voice?: "ready" | "disabled" | "hidden";
}) {
  const tr = translate(language);
  const [inputHeight, setInputHeight] = useState(44);
  const [focused, setFocused] = useState(false);
  const typed = !!value.trim();
  return (
    <View
      testID="message-composer"
      style={[
        chrome.composer,
        focused && { borderColor: t.color.text.disabled },
      ]}
    >
      <TextInput
        ref={inputRef}
        accessibilityLabel={tr("composer")}
        placeholder={tr("composer")}
        placeholderTextColor={t.color.text.secondary}
        value={value}
        onChangeText={onChange}
        multiline
        maxLength={4000}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onContentSizeChange={(e) =>
          setInputHeight(
            Math.min(132, Math.max(44, e.nativeEvent.contentSize.height)),
          )
        }
        numberOfLines={1}
        style={[
          chrome.input,
          { height: value ? inputHeight : 44 },
          Platform.OS === "web" && { outlineStyle: "solid", outlineWidth: 0 },
        ]}
      />
      {/* Voice stays one tap away; with text it steps back for Send. */}
      {voice !== "hidden" ? (
        <ComposerAction
          filled={!typed}
          icon="mic"
          label={tr("voice_reply")}
          disabled={voice === "disabled"}
          onPress={onVoice}
        />
      ) : null}
      {typed ? (
        <ComposerAction
          filled
          icon="arrow"
          label={tr("send")}
          loading={sending}
          disabled={disabled}
          onPress={onSend}
        />
      ) : null}
    </View>
  );
}
/**
 * A bottom sheet: grabber, a bold left-aligned title with Close, scrolling
 * content and an optional bottom action area (one primary Button, perhaps a
 * quiet one under it).
 */
export function DetailSheet({
  title,
  language,
  onClose,
  children,
  actions,
  fullHeight = false,
  scrollRef,
}: PropsWithChildren<{
  title: string;
  language: Language;
  onClose: () => void;
  /** Pinned under the content, e.g. the sheet's one primary Button. */
  actions?: React.ReactNode;
  fullHeight?: boolean;
  scrollRef?: React.RefObject<ScrollView | null>;
}>) {
  const reduced = useReducedMotion();
  const [progress] = useState(() => new Animated.Value(reduced ? 1 : 0));
  const closing = useRef(false);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const [dismissed, setDismissed] = useState(false);
  const notified = useRef(false);
  const finishDismiss = useCallback(() => {
    if (!notified.current) {
      notified.current = true;
      onCloseRef.current();
    }
  }, []);
  useEffect(() => {
    if (closing.current) {
      if (reduced) {
        progress.stopAnimation();
        finishDismiss();
      }
      return;
    }
    if (reduced) {
      progress.stopAnimation();
      progress.setValue(1);
      return;
    }
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: t.motion.sheetEnter,
      easing: motionEase,
      useNativeDriver: nativeMotion,
      isInteraction: false,
    });
    animation.start();
    return () => animation.stop();
  }, [progress, reduced, finishDismiss]);
  useEffect(() => () => progress.stopAnimation(), [progress]);
  const dismiss = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    if (reduced) {
      finishDismiss();
      return;
    }
    setDismissed(true);
    progress.stopAnimation();
    Animated.timing(progress, {
      toValue: 0,
      duration: t.motion.sheetExit,
      easing: motionEase,
      useNativeDriver: nativeMotion,
      isInteraction: false,
    }).start(({ finished }) => {
      if (finished) finishDismiss();
    });
  }, [progress, reduced, finishDismiss]);
  return (
    <Modal
      transparent
      animationType="none"
      visible
      onRequestClose={dismiss}
      statusBarTranslucent
    >
      <KeyboardAvoidingView
        style={chrome.flex}
        behavior={
          Platform.OS === "ios"
            ? "padding"
            : Platform.OS === "android"
              ? "height"
              : undefined
        }
      >
        <View style={chrome.modal}>
          <Animated.View
            style={[
              StyleSheet.absoluteFill,
              {
                backgroundColor: t.color.scrim,
                opacity: progress,
                pointerEvents: "none",
              },
            ]}
          />
          <View
            accessible={false}
            onStartShouldSetResponder={() => true}
            onResponderRelease={dismiss}
            style={StyleSheet.absoluteFill}
          />
          <Animated.View
            style={[
              chrome.sheet,
              fullHeight && { height: "92%" },
              {
                pointerEvents: dismissed ? "none" : "auto",
                opacity: progress,
                transform: [
                  {
                    translateY: progress.interpolate({
                      inputRange: [0, 1],
                      outputRange: [32, 0],
                    }),
                  },
                ],
              },
            ]}
            testID="detail-sheet"
            accessibilityViewIsModal
          >
            <SafeAreaView
              edges={["bottom"]}
              style={[
                { maxHeight: "100%" },
                fullHeight && { flex: 1, minHeight: 0 },
              ]}
            >
              <View style={chrome.grabber} />
              <Row style={chrome.sheetHeader}>
                <Text
                  role="sheetTitle"
                  accessibilityRole="header"
                  style={{ flex: 1, minWidth: 0 }}
                >
                  {title}
                </Text>
                <MotionPressable
                  accessibilityRole="button"
                  accessibilityLabel={translate(language)("close")}
                  onPress={dismiss}
                  hitSlop={8}
                  style={({ pressed }) => [
                    chrome.sheetClose,
                    {
                      backgroundColor: pressed
                        ? t.color.fillPressed
                        : t.color.fill,
                    },
                  ]}
                >
                  <Icon name="close" size={18} color={t.color.text.secondary} />
                </MotionPressable>
              </Row>
              <ScrollView
                ref={scrollRef}
                style={fullHeight ? { flex: 1, minHeight: 0 } : undefined}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={chrome.sheetBody}
              >
                {children}
              </ScrollView>
              {actions ? (
                <View style={chrome.sheetActions}>{actions}</View>
              ) : null}
            </SafeAreaView>
          </Animated.View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
/** The one empty state: icon well, a short title, at most one line of hint. */
export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon: IconName;
  title: string;
  hint?: string;
  /** One small Button, e.g. "Refresh". */
  action?: React.ReactNode;
}) {
  return (
    <View style={chrome.empty}>
      <View
        style={{
          width: 64,
          height: 64,
          borderRadius: 32,
          marginBottom: 10,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: t.color.fill,
        }}
      >
        <Icon name={icon} size={28} color={t.color.text.secondary} />
      </View>
      <Text role="cardTitle" style={{ textAlign: "center" }}>
        {title}
      </Text>
      {hint ? (
        <Text tone="secondary" style={{ textAlign: "center", maxWidth: 280 }}>
          {hint}
        </Text>
      ) : null}
      {action ? <View style={{ marginTop: 14 }}>{action}</View> : null}
    </View>
  );
}
/** Assistant output reads as the page itself: full width, no avatar or bubble. */
export function AssistantMessage({ children }: PropsWithChildren) {
  return <View style={chrome.assistant}>{children}</View>;
}
