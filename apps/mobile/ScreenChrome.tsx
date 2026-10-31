import type { PetAppearance } from "../../packages/ui/pet-motion";
import type { HomePetBounds } from "./home-pet-visibility";
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
  useWindowDimensions,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
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
import { useCompanionTypography } from "../../packages/ui/typography";
import { PetView, type PetState } from "../../packages/ui/PetView";
import { companionCopy } from "./companion-copy";
import { Tabs } from "../../packages/ui/Tabs";

import {
  Entrance,
  MotionPressable,
  nativeMotion,
  motionEase,
  useReducedMotion,
} from "../../packages/ui/motion";

export type Section = "chat" | "meetings" | "tasks" | "library" | "more";
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
    minHeight: 64,
    paddingHorizontal: 12,
    paddingVertical: 6,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  topbarTitle: { flex: 1, minWidth: 0, gap: 2 },
  // Root titles align to content; nested titles follow a 44-point control.
  topbarLarge: { paddingLeft: t.spacing.screenGutter },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: t.radius.action,
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
    minHeight: 380,
    justifyContent: "space-between",
    gap: t.spacing.xl,
    paddingTop: t.spacing.sm,
    paddingBottom: t.spacing.sm,
  },
  stage: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: t.spacing.md,
  },
  headline: { alignItems: "center", alignSelf: "stretch", gap: 8 },
  center: { textAlign: "center" },
  shortcuts: { gap: 0 },
  shortcut: {
    minHeight: 62,
    paddingHorizontal: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: t.color.border,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  footer: {
    paddingTop: 6,
    paddingBottom: 8,
    paddingHorizontal: t.spacing.screenGutter,
    gap: 8,
  },
  // Text and inset actions share the vertical centre of the continuous bar.
  readOnly: {
    ...ui.composerFrame,
    minHeight: 62,
    paddingLeft: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  composer: {
    ...ui.composerFrame,
    minHeight: 62,
    paddingLeft: 6,
    paddingRight: 6,
    paddingVertical: 6,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 132,
    paddingHorizontal: 0,
    paddingVertical: 10,
    textAlignVertical: "center",
    includeFontPadding: false,
    color: t.color.text.primary,
    ...t.typography.body,
  },
  composerAction: {
    width: 44,
    height: 44,
    borderRadius: t.radius.action,
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
    backgroundColor: t.color.fill,
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
    paddingHorizontal: t.spacing.screenGutter,
    paddingTop: 10,
    paddingBottom: 6,
    minHeight: 52,
    gap: 12,
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
 * Root and nested titles share a type scale; only the leading inset changes.
 */
export function TopBar({
  leading,
  title,
  subtitle,
  trailing,
  large = !leading,
  emblem,
}: {
  /** A Back or Menu control; tab roots have none. */
  leading?: React.ReactNode;
  title: string;
  subtitle?: React.ReactNode;
  trailing?: React.ReactNode;
  large?: boolean;
  emblem?: React.ReactNode;
}) {
  return (
    <View style={[chrome.topbar, large && chrome.topbarLarge]}>
      {leading}
      {emblem}
      <View style={chrome.topbarTitle}>
        <Text role="headerTitle" accessibilityRole="header" numberOfLines={2}>
          {title}
        </Text>
        {subtitle}
      </View>
      {trailing}
    </View>
  );
}
const destinations = [
  { id: "chat", icon: "chat" },
  { id: "tasks", icon: "briefcase" },
  { id: "library", icon: "library" },
] as const;
/** Three destinations; meetings and settings remain inside Library. */
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
        const selected =
          destination.id ===
          (section === "meetings" || section === "more" ? "library" : section);
        const label =
          destination.id === "chat"
            ? tr("chat")
            : companionCopy(language)[
                destination.id === "tasks" ? "work" : "library"
              ];
        const waiting = destination.id === "tasks" ? count : 0;
        return (
          <MotionPressable
            key={destination.id}
            accessibilityRole="tab"
            accessibilityLabel={label}
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
                    selected ? t.color.action.link : t.color.text.secondary
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
                color: selected ? t.color.action.link : t.color.text.secondary,
                fontWeight: selected ? "600" : "500",
              }}
            >
              {label}
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
  voiceBusy = false,
  meetingRecording = false,
  level,
  onMeeting,
  onRecord,
  onTasks,
  onProcesses,
  onConnect,
  compact = false,
  petVisible = true,
  showPet = true,
  petAppearance,
  petAnimate = true,
  petOccupied = false,
  onPetBounds,
  petState = busy ? "working" : meetingRecording ? "listening" : "idle",
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
  compact?: boolean;
  petVisible?: boolean;
  showPet?: boolean;
  petAppearance?: PetAppearance;
  petAnimate?: boolean;
  petOccupied?: boolean;
  onPetBounds?: (bounds: HomePetBounds | null) => void;
  petState?: PetState;
}) {
  const tr = translate(language);
  const homeY = useRef(0),
    stageY = useRef(0),
    petBox = useRef<{ y: number; height: number } | null>(null);
  const publishBounds = useCallback(() => {
    if (petBox.current)
      onPetBounds?.({
        top: homeY.current + stageY.current + petBox.current.y,
        height: petBox.current.height,
      });
  }, [onPetBounds]);
  useEffect(() => {
    if (compact || voiceBusy) onPetBounds?.(null);
    else publishBounds();
    return () => onPetBounds?.(null);
  }, [compact, voiceBusy, onPetBounds, publishBounds]);
  const onHomeLayout = (event: LayoutChangeEvent) => {
    homeY.current = event.nativeEvent.layout.y;
    publishBounds();
  };
  const onStageLayout = (event: LayoutChangeEvent) => {
    stageY.current = event.nativeEvent.layout.y;
    publishBounds();
  };
  const onPetLayout = (event: LayoutChangeEvent) => {
    petBox.current = event.nativeEvent.layout;
    publishBounds();
  };
  if (!paired)
    return (
      <View testID="home-screen" onLayout={onHomeLayout} style={chrome.home}>
        <View
          testID="home-pet-stage"
          onLayout={onStageLayout}
          style={chrome.stage}
        >
          <View testID="home-pet-bounds" onLayout={onPetLayout}>
            <PetView
              visible={petVisible}
              occupied={petOccupied}
              state="idle"
              size={200}
              label={companionCopy(language).pet}
            />
          </View>
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
  const intro: TranslationKey | null = !connected
    ? "homeOffline"
    : meetingRecording
      ? "homeVoiceRecording"
      : null;
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
    <View
      testID="home-screen"
      onLayout={onHomeLayout}
      style={[chrome.home, (voiceBusy || compact) && { minHeight: 0, flex: 0 }]}
    >
      {!voiceBusy && !compact ? (
        <View
          testID="home-pet-stage"
          onLayout={onStageLayout}
          style={chrome.stage}
        >
          {showPet && (
            <View testID="home-pet-bounds" onLayout={onPetLayout}>
              <PetView
                visible={petVisible}
                occupied={petOccupied}
                appearance={petAppearance}
                animate={petAnimate}
                testID="home-pet"
                label={companionCopy(language).petTouch}
                interactive
                disabled={busy || meetingRecording}
                state={petState}
                size={220}
                level={level}
              />
            </View>
          )}
          <View style={chrome.headline}>
            <Text
              role="screenTitle"
              accessibilityRole="header"
              style={chrome.center}
            >
              {tr("hello")}
            </Text>
            {intro ? (
              <Text tone="secondary" style={chrome.center}>
                {tr(intro)}
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}
      {!voiceBusy && !compact ? (
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
                  backgroundColor: pressed
                    ? t.color.fillPressed
                    : "transparent",
                },
              ]}
            >
              <Icon
                name={shortcut.icon}
                size={18}
                color={t.color.action.link}
              />
              <Text role="body" numberOfLines={2} style={{ flex: 1 }}>
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
              <Icon name="chevron" size={18} color={t.color.text.secondary} />
            </MotionPressable>
          ))}
        </View>
      ) : null}
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
  onAttach,
  selection,
  onSelectionChange,
  onBlur,
  onFocus,
  references,
  hasAttachments = false,
  sendBlocked = false,
}: {
  language: Language;
  value: string;
  onChange: (s: string) => void;
  onSend: () => void;
  onVoice: () => void;
  disabled: boolean;
  sending?: boolean;
  inputRef?: React.Ref<TextInput>;
  /** An unavailable server keeps voice settings discoverable without recording. */
  voice?: "ready" | "disabled" | "hidden" | "settings";
  onAttach?: () => void;
  selection?: { start: number; end: number };
  onSelectionChange?: (selection: { start: number; end: number }) => void;
  onBlur?: () => void;
  onFocus?: () => void;
  references?: React.ReactNode;
  /** Presentation only; the parent still decides disabled/send eligibility. */
  hasAttachments?: boolean;
  /** Transfer readiness gates Send while draft text remains editable. */
  sendBlocked?: boolean;
}) {
  const tr = translate(language);
  const [inputHeight, setInputHeight] = useState(44);
  const [focused, setFocused] = useState(false);
  const typed = !!value.trim() || hasAttachments;
  const { fontScale, width: windowWidth } = useWindowDimensions();
  const [rowWidth, setRowWidth] = useState<number | null>(null);
  const actionCount =
    Number(!!onAttach) + Number(voice !== "hidden") + Number(typed);
  const availableWidth =
    rowWidth ?? Math.max(0, windowWidth - 2 * t.spacing.screenGutter - 14);
  const stacked =
    availableWidth - actionCount * 48 <
    Math.max(120, t.typography.body.fontSize * fontScale * 6);
  const minimumInputHeight = Math.max(
    44,
    t.typography.body.lineHeight * fontScale + 20,
  );
  const font = useCompanionTypography(chrome.input);
  const leftActions = onAttach ? (
    <View
      key="left"
      style={{
        flexDirection: "row",
        alignItems: "center",
        flexGrow: stacked ? 1 : 0,
      }}
    >
      <ComposerAction
        filled={false}
        icon="paperclip"
        label={companionCopy(language).context}
        onPress={onAttach}
      />
    </View>
  ) : null;
  const input = (
    <TextInput
      key="input"
      ref={inputRef}
      accessibilityLabel={tr("composer")}
      placeholder={
        fontScale > 1.3
          ? companionCopy(language).composerLargeText
          : companionCopy(language).composer
      }
      placeholderTextColor={t.color.text.secondary}
      value={value}
      onChangeText={onChange}
      selection={selection}
      onSelectionChange={(event) =>
        onSelectionChange?.(event.nativeEvent.selection)
      }
      multiline
      maxLength={4000}
      onFocus={() => {
        setFocused(true);
        onFocus?.();
      }}
      onBlur={() => {
        setFocused(false);
        onBlur?.();
      }}
      onContentSizeChange={(e) =>
        setInputHeight(
          Math.min(
            Math.max(132, minimumInputHeight),
            Math.max(minimumInputHeight, e.nativeEvent.contentSize.height),
          ),
        )
      }
      numberOfLines={1}
      style={[
        chrome.input,
        font,
        {
          flex: stacked ? 0 : 1,
          flexBasis: stacked ? "100%" : "auto",
          minWidth: 0,
          minHeight: minimumInputHeight,
          maxHeight: Math.max(132, minimumInputHeight),
          height: value
            ? Math.max(inputHeight, minimumInputHeight)
            : minimumInputHeight,
        },
        Platform.OS === "web" && { outlineStyle: "solid", outlineWidth: 0 },
      ]}
    />
  );
  const rightActions =
    voice !== "hidden" || typed ? (
      <View
        key="right"
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 4,
          marginLeft: stacked && !leftActions ? "auto" : 0,
        }}
      >
        {/* Voice stays one tap away; with text it steps back for Send. */}
        {voice !== "hidden" ? (
          <ComposerAction
            filled={!typed && voice === "ready"}
            icon="mic"
            label={tr(
              voice === "settings" ? "voiceSettingsAction" : "voice_reply",
            )}
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
            disabled={disabled || sendBlocked}
            onPress={() => {
              if (!disabled && !sendBlocked && !sending) onSend();
            }}
          />
        ) : null}
      </View>
    ) : null;

  return (
    <View
      testID="message-composer"
      style={[
        chrome.composer,
        { flexDirection: "column", alignItems: "stretch" },
        focused && { borderColor: t.color.text.disabled },
      ]}
    >
      {references}
      <View
        testID="composer-input-row"
        onLayout={(event) => {
          const width = event.nativeEvent.layout.width;
          if (Number.isFinite(width) && width > 0)
            setRowWidth((current) => (current === width ? current : width));
        }}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          flexWrap: stacked ? "wrap" : "nowrap",
        }}
      >
        {stacked
          ? [input, leftActions, rightActions]
          : [leftActions, input, rightActions]}
      </View>
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
  onShown,
  onDismissRequested,
}: PropsWithChildren<{
  title: string;
  language: Language;
  onClose: () => void;
  /** Once, after native Modal show and completed entrance; never after dismissal. */
  onShown?: () => void;
  /** Once at user dismissal start, before exit; onClose still follows exit. */
  onDismissRequested?: () => void;
  /** Pinned under the content, e.g. the sheet's one primary Button. */
  actions?: React.ReactNode;
  fullHeight?: boolean;
  scrollRef?: React.RefObject<ScrollView | null>;
}>) {
  const reduced = useReducedMotion();
  const [progress] = useState(() => new Animated.Value(reduced ? 1 : 0));
  const [dragOffset] = useState(() => new Animated.Value(0));
  const closing = useRef(false);
  const ready = useRef({
    alive: true,
    modal: false,
    entered: false,
    notified: false,
  });
  const onShownRef = useRef(onShown);
  const notifyShown = useCallback(() => {
    const current = ready.current;
    if (
      current.alive &&
      current.modal &&
      current.entered &&
      !current.notified &&
      !closing.current
    ) {
      current.notified = true;
      onShownRef.current?.();
    }
  }, []);
  useEffect(() => {
    const owner = ready.current;
    owner.alive = true;
    return () => {
      owner.alive = false;
    };
  }, []);
  const onCloseRef = useRef(onClose);
  const onDismissRequestedRef = useRef(onDismissRequested);
  useEffect(() => {
    onCloseRef.current = onClose;
    onShownRef.current = onShown;
    onDismissRequestedRef.current = onDismissRequested;
  }, [onClose, onShown, onDismissRequested]);
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
      ready.current.entered = true;
      notifyShown();
      return;
    }
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: t.motion.sheetEnter,
      easing: motionEase,
      useNativeDriver: nativeMotion,
      isInteraction: false,
    });
    animation.start(({ finished }) => {
      if (finished) {
        ready.current.entered = true;
        notifyShown();
      }
    });
    return () => animation.stop();
  }, [progress, reduced, finishDismiss, notifyShown]);
  useEffect(
    () => () => {
      progress.stopAnimation();
      dragOffset.stopAnimation();
    },
    [progress, dragOffset],
  );
  const dismiss = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    onDismissRequestedRef.current?.();
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
  const drag = useRef<{
    x: number;
    y: number;
    lastY: number;
    time: number;
    velocity: number;
  } | null>(null);
  const point = (event: GestureResponderEvent) => {
    const native = event.nativeEvent;
    const touch = native.touches?.[0] ?? native.changedTouches?.[0] ?? native;
    return { x: touch.pageX, y: touch.pageY, time: native.timestamp };
  };
  const resetDrag = () => {
    drag.current = null;
    if (reduced) dragOffset.setValue(0);
    else
      Animated.spring(dragOffset, {
        toValue: 0,
        useNativeDriver: nativeMotion,
        isInteraction: false,
      }).start();
  };
  const swipe = {
    onStartShouldSetResponderCapture(event: GestureResponderEvent) {
      const p = point(event);
      drag.current =
        event.nativeEvent.touches.length === 1
          ? { ...p, lastY: p.y, velocity: 0 }
          : null;
      return false;
    },
    onMoveShouldSetResponderCapture(event: GestureResponderEvent) {
      const start = drag.current,
        p = point(event);
      return (
        !!start &&
        event.nativeEvent.touches.length === 1 &&
        p.y - start.y > 8 &&
        p.y - start.y > Math.abs(p.x - start.x) * 1.5
      );
    },
    onResponderMove(event: GestureResponderEvent) {
      const start = drag.current;
      if (!start || event.nativeEvent.touches.length !== 1) {
        resetDrag();
        return;
      }
      const p = point(event),
        dy = p.y - start.y;
      start.velocity = (p.y - start.lastY) / Math.max(1, p.time - start.time);
      start.lastY = p.y;
      start.time = p.time;
      if (!reduced) dragOffset.setValue(Math.max(0, dy));
    },
    onResponderRelease(event: GestureResponderEvent) {
      const start = drag.current,
        p = point(event);
      drag.current = null;
      if (
        start &&
        (p.y - start.y > 72 || (p.y - start.y > 16 && start.velocity > 0.7))
      )
        dismiss();
      else resetDrag();
    },
    onResponderTerminate: resetDrag,
    onResponderTerminationRequest: () => true,
  };
  return (
    <Modal
      transparent
      animationType="none"
      visible
      onRequestClose={dismiss}
      onShow={() => {
        ready.current.modal = true;
        notifyShown();
      }}
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
        <SafeAreaView edges={["top"]} style={chrome.modal}>
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
            testID="detail-sheet-scrim"
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
                    translateY: Animated.add(
                      dragOffset,
                      progress.interpolate({
                        inputRange: [0, 1],
                        outputRange: [32, 0],
                      }),
                    ),
                  },
                ],
              },
            ]}
            testID="detail-sheet"
            accessibilityViewIsModal
            onAccessibilityEscape={dismiss}
          >
            <SafeAreaView
              edges={["bottom"]}
              style={[
                { maxHeight: "100%" },
                fullHeight && { flex: 1, minHeight: 0 },
              ]}
            >
              <View testID="detail-sheet-header" {...swipe}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={translate(language)("close")}
                  onPress={dismiss}
                  hitSlop={8}
                  style={{ minHeight: 24 }}
                >
                  <View style={chrome.grabber} />
                </Pressable>
                <Row style={chrome.sheetHeader}>
                  <Text
                    role="headerTitle"
                    accessibilityRole="header"
                    style={{ flex: 1, minWidth: 0 }}
                  >
                    {title}
                  </Text>
                </Row>
              </View>
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
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
  );
}
/** One centred sentence. Recovery actions remain explicit below it. */
export function EmptyState({
  title,
  action,
}: {
  icon: IconName;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <View style={chrome.empty}>
      <Text tone="secondary" style={{ textAlign: "center" }}>
        {title}
      </Text>
      {action ? <View style={{ marginTop: 14 }}>{action}</View> : null}
    </View>
  );
}
/** Assistant output reads as the page itself: full width, no avatar or bubble. */
export function AssistantMessage({ children }: PropsWithChildren) {
  return <View style={chrome.assistant}>{children}</View>;
}
