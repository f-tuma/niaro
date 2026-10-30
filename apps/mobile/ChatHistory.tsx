import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { randomUUID } from "expo-crypto";
import { SafeAreaView } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ClientSession } from "../../packages/client-core/session";
import {
  loadConversationPins,
  saveConversationPins,
} from "../../packages/client-core/conversation-preferences";
import {
  archivableConversation,
  type ConversationSummary,
  type Language,
} from "../../packages/protocol";
import { conversationTitle } from "../../packages/client-core/conversation-title";
import { translate, type TranslationKey } from "../../packages/i18n";
import {
  chatChangeError,
  ConversationOpenWorkError,
} from "../../packages/client-core/conversation-directory";
import { useCompanionTypography } from "../../packages/ui/typography";
import { tokens as t } from "../../packages/design-tokens";
import { Button, Icon, Notice, Row, Text } from "../../packages/ui";
import {
  motionEase,
  nativeMotion,
  useReducedMotion,
} from "../../packages/ui/motion";
import * as cues from "./feedback";
import { MenuItem } from "./ScreenChrome";
import { companionCopy } from "./companion-copy";
import { OpenWorkNotice, type OpenWorkRefusal } from "./OpenWorkNotice";

export type MenuTarget = "processes" | "search" | "tasks" | "library";

type DrawerProps = {
  session: ClientSession | null;
  language: Language;
  selectedId: string;
  busy: boolean;
  online: boolean;
  onClose: () => void;
  onSelect: (conversation: ConversationSummary) => void;
  onNew: () => Promise<void>;
  /** A chat was deleted or archived here; the app leaves it if it is open. */
  onDeleted?: (id: string) => void;
  /** Shows destinations; the drawer slides away before navigating. */
  onNavigate?: (target: MenuTarget) => void;
  processesLabel?: string;
  processesDisabled?: boolean;
  recordingControls?: React.ReactNode;
};
/**
 * The app menu: a left drawer with a new chat, destinations, history and the
 * account. Opening, sorting, pinning and selecting history never dispatch
 * native work.
 */
export function ChatHistory(
  props: {
    open: boolean;
  } & DrawerProps,
) {
  if (!props.open) return null;
  return (
    <OpenChatHistory
      key={props.session?.identityKey ?? "signed-out"}
      {...props}
    />
  );
}
function OpenChatHistory({
  session,
  language,
  selectedId,
  busy,
  online,
  onClose,
  onSelect,
  onNew,
  onDeleted,
  onNavigate,
  processesLabel,
  processesDisabled,
  recordingControls,
}: DrawerProps) {
  const tr = translate(language);
  const [rows, setRows] = useState<ConversationSummary[]>([]);
  const [pins, setPins] = useState<string[]>([]);
  const [pinsReady, setPinsReady] = useState(false);
  const [loading, setLoading] = useState(!!session);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const lifecycle = useRef<{ active: boolean }>({ active: true });
  const pinRevision = useRef(0);
  useEffect(() => {
    const owner = { active: true };
    lifecycle.current = owner;
    if (!session)
      return () => {
        owner.active = false;
      };
    const controller = new AbortController();
    void loadConversationPins(AsyncStorage, session.identityKey)
      .then((ids) => {
        if (!owner.active) return;
        setPins(ids);
        setPinsReady(true);
      })
      .catch(() => {
        if (owner.active) setError("storage_error");
      });
    void (async () => {
      let after: string | null = null;
      const cursors = new Set<string>();
      const seen = new Set<string>();
      do {
        // Archived chats live in Settings, not here.
        const page = await session.readConversations(
          after,
          controller.signal,
          "active",
        );
        if (!owner.active) return;
        if (page.conversations.some((c) => seen.has(c.id)))
          throw new Error("conversation_changed");
        for (const c of page.conversations) seen.add(c.id);
        setRows((current) => [
          ...current,
          ...page.conversations.filter((c) => !c.readOnly),
        ]);
        after = page.nextAfter;
        if (after && cursors.has(after))
          throw new Error("conversation_changed");
        if (after) cursors.add(after);
      } while (after);
    })()
      .catch((e: unknown) => {
        if (owner.active)
          setError(e instanceof Error ? e.message : "connection_failed");
      })
      .finally(() => {
        if (owner.active) setLoading(false);
      });
    return () => {
      owner.active = false;
      controller.abort();
    };
  }, [session, attempt]);
  const togglePin = (id: string) => {
    if (!pinsReady || !session) return;
    const previous = pins;
    const next = pins.includes(id)
      ? pins.filter((v) => v !== id)
      : [...pins, id];
    const owner = lifecycle.current,
      revision = ++pinRevision.current;
    setPins(next);
    void saveConversationPins(AsyncStorage, session.identityKey, next).catch(
      () => {
        if (!owner.active || revision !== pinRevision.current) return;
        setPins(previous);
        setError("storage_error");
      },
    );
  };
  const [actionError, setActionError] = useState<TranslationKey>();
  /** Work still waits in the chat: the drawer names it and offers to cancel it. */
  const [refusal, setRefusal] = useState<OpenWorkRefusal>();
  const failed =
    (owner: { active: boolean }, refused?: Omit<OpenWorkRefusal, "openWork">) =>
    (e: unknown) => {
      if (!owner.active) return;
      if (refused && e instanceof ConversationOpenWorkError)
        setRefusal({ ...refused, openWork: e.openWork });
      else setActionError(chatChangeError(e));
    };
  /** Names the chat for every device; empty brings back the server's title. */
  const rename = async (conversation: ConversationSummary, title: string) => {
    if (!session) return;
    const owner = lifecycle.current;
    setActionError(undefined);
    try {
      await session.renameConversation(conversation.id, title, randomUUID());
      if (!owner.active) return;
      if (title.trim())
        setRows((current) =>
          current.map((row) =>
            row.id === conversation.id ? { ...row, title: title.trim() } : row,
          ),
        );
      // The server's own title comes back with the list.
      else {
        setRows([]);
        setLoading(true);
        setAttempt((value) => value + 1);
      }
    } catch (e) {
      failed(owner)(e);
    }
  };
  const [cancelling, setCancelling] = useState(false);
  /** `cancelOpenWork`: the server first cancels what waits in the chat. */
  const remove = async (
    conversation: Pick<ConversationSummary, "id">,
    cancelOpenWork = false,
  ) => {
    if (!session) return;
    const owner = lifecycle.current;
    setActionError(undefined);
    setRefusal(undefined);
    try {
      if (cancelOpenWork)
        await session.deleteConversation(conversation.id, randomUUID(), {
          cancelOpenWork,
        });
      else await session.deleteConversation(conversation.id, randomUUID());
      if (!owner.active) return;
      setRows((current) => current.filter((row) => row.id !== conversation.id));
      if (pins.includes(conversation.id)) togglePin(conversation.id);
      onDeleted?.(conversation.id);
    } catch (e) {
      failed(owner, { conversationId: conversation.id, action: "delete" })(e);
    }
  };
  /** Moves the chat into the archive (Settings); it leaves this list. */
  const archive = async (
    conversation: Pick<ConversationSummary, "id">,
    cancelOpenWork = false,
  ) => {
    if (!session) return;
    const owner = lifecycle.current;
    setActionError(undefined);
    setRefusal(undefined);
    try {
      if (cancelOpenWork)
        await session.archiveConversation(conversation.id, randomUUID(), {
          cancelOpenWork,
        });
      else await session.archiveConversation(conversation.id, randomUUID());
      if (!owner.active) return;
      setRows((current) => current.filter((row) => row.id !== conversation.id));
      onDeleted?.(conversation.id);
    } catch (e) {
      failed(owner, { conversationId: conversation.id, action: "archive" })(e);
    }
  };
  const cancelAndContinue = async (refused: OpenWorkRefusal) => {
    setCancelling(true);
    try {
      await (refused.action === "delete" ? remove : archive)(
        { id: refused.conversationId },
        true,
      );
    } finally {
      if (lifecycle.current.active) setCancelling(false);
    }
  };
  const ordered = [...rows].sort(
    (a, b) =>
      b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
  );
  const pinned = ordered.filter((c) => pins.includes(c.id));
  const recent = ordered.filter((c) => !pins.includes(c.id));
  const [menu, setMenu] = useState<{
    conversation: ConversationSummary;
    frame?: Frame;
  }>();
  const openMenu = (
    conversation: ConversationSummary,
    measure: (report: (frame: Frame) => void) => void,
  ) => {
    // Optional: test doubles of this module stub only the sound cues.
    cues.touch?.();
    setMenu({ conversation });
    measure((frame) =>
      setMenu((current) =>
        current?.conversation.id === conversation.id
          ? { conversation, frame }
          : current,
      ),
    );
  };
  const reduced = useReducedMotion();
  const [progress] = useState(() => new Animated.Value(reduced ? 1 : 0));
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (reduced) {
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
  }, [progress, reduced]);
  // The drawer slides away first; the chosen destination follows.
  const close = useCallback(
    (then: () => void = onClose) => {
      if (leaving) return;
      setLeaving(true);
      if (reduced) {
        then();
        return;
      }
      progress.stopAnimation();
      Animated.timing(progress, {
        toValue: 0,
        duration: t.motion.sheetExit,
        easing: motionEase,
        useNativeDriver: nativeMotion,
        isInteraction: false,
      }).start(() => then());
    },
    [leaving, onClose, progress, reduced],
  );
  const go = (target: MenuTarget) => close(() => onNavigate?.(target));
  const dismiss = useCallback(() => close(), [close]);
  return (
    <Modal
      visible
      transparent
      animationType="none"
      // Back and Escape close an open chat menu before the drawer.
      onRequestClose={menu ? () => setMenu(undefined) : dismiss}
    >
      <View
        testID="chat-history-panel"
        style={{
          flex: 1,
          flexDirection: "row",
          justifyContent: "flex-start",
        }}
      >
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
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={tr("closeMenu")}
          onPress={dismiss}
          style={StyleSheet.absoluteFill}
        />
        <Animated.View
          // An open chat menu becomes the modal layer; the drawer must not hide it.
          accessibilityViewIsModal={!menu}
          onAccessibilityEscape={menu ? () => setMenu(undefined) : dismiss}
          style={{
            width: "86%",
            maxWidth: 340,
            height: "100%",
            backgroundColor: t.color.surface,
            borderTopRightRadius: 20,
            borderBottomRightRadius: 20,
            overflow: "hidden",
            ...t.elevation.drawer,
            transform: [
              {
                translateX: progress.interpolate({
                  inputRange: [0, 1],
                  outputRange: [-360, 0],
                }),
              },
            ],
          }}
        >
          <SafeAreaView
            edges={["top", "bottom", "left"]}
            style={{ flex: 1, minHeight: 0 }}
          >
            <Row
              style={{
                minHeight: 64,
                paddingHorizontal: 20,
              }}
            >
              <Text role="headerTitle" accessibilityRole="header">
                Niaro
              </Text>
            </Row>
            {recordingControls ? (
              <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
                {recordingControls}
              </View>
            ) : null}
            <View style={{ gap: 2, paddingBottom: 8 }}>
              {session ? (
                <MenuItem
                  icon="compose"
                  label={tr("newChat")}
                  disabled={
                    error === "conversation_history_unavailable" ||
                    !online ||
                    busy ||
                    creating
                  }
                  onPress={() => {
                    const owner = lifecycle.current;
                    setCreating(true);
                    setError(undefined);
                    void onNew()
                      .catch((e: unknown) => {
                        if (owner.active)
                          setError(
                            e instanceof Error
                              ? e.message
                              : "connection_failed",
                          );
                      })
                      .finally(() => {
                        if (owner.active) setCreating(false);
                      });
                  }}
                />
              ) : null}
              {onNavigate && session ? (
                <MenuItem
                  icon="search"
                  label={language === "cs" ? "Hledat" : "Search"}
                  onPress={() => go("search")}
                />
              ) : null}
              {onNavigate ? (
                <>
                  <MenuItem
                    icon="briefcase"
                    label={companionCopy(language).work}
                    onPress={() => go("tasks")}
                  />
                  <MenuItem
                    icon="library"
                    label={companionCopy(language).library}
                    onPress={() => go("library")}
                  />
                </>
              ) : null}
              {onNavigate && session ? (
                <MenuItem
                  icon="bolt"
                  label={processesLabel ?? tr("processesTitle")}
                  disabled={processesDisabled}
                  onPress={() => go("processes")}
                />
              ) : null}
            </View>
            {session ? (
              <View
                style={{
                  height: StyleSheet.hairlineWidth,
                  marginHorizontal: 20,
                  backgroundColor: t.color.hairline,
                }}
              />
            ) : null}
            <ScrollView
              style={{ flex: 1, minHeight: 0 }}
              contentContainerStyle={{
                paddingHorizontal: 8,
                paddingBottom: 16,
                gap: 2,
              }}
            >
              {pinned.length ? (
                <>
                  <SectionHeader>{tr("pinnedChats")}</SectionHeader>
                  {pinned.map((conversation) => (
                    <HistoryRow
                      key={conversation.id}
                      language={language}
                      conversation={conversation}
                      selected={conversation.id === selectedId}
                      pinned={pins.includes(conversation.id)}
                      onPress={() => close(() => onSelect(conversation))}
                      onMenu={(measure) => openMenu(conversation, measure)}
                      onTogglePin={() => togglePin(conversation.id)}
                    />
                  ))}
                </>
              ) : null}
              {session && (!recent.length || error) && !pinned.length ? (
                <SectionHeader>{tr("recentChats")}</SectionHeader>
              ) : null}
              {actionError ? (
                <View style={{ paddingHorizontal: 8, paddingVertical: 8 }}>
                  <Notice error>{tr(actionError)}</Notice>
                </View>
              ) : null}
              {refusal ? (
                <View style={{ paddingHorizontal: 8, paddingVertical: 8 }}>
                  <OpenWorkNotice
                    language={language}
                    refusal={refusal}
                    disabled={!online || cancelling}
                    onKeep={() => setRefusal(undefined)}
                    onCancelAndContinue={() => void cancelAndContinue(refusal)}
                  />
                </View>
              ) : null}
              {error ? (
                <View style={{ paddingHorizontal: 8, paddingBottom: 8 }}>
                  <Notice error>
                    {tr(
                      error === "conversation_history_unavailable"
                        ? "chatHistoryUpdateRequired"
                        : error === "storage_error"
                          ? "storage_error"
                          : "chatHistoryLoadFailed",
                    )}
                  </Notice>
                  {error !== "conversation_history_unavailable" ? (
                    <Button
                      variant="quiet"
                      size="small"
                      label={tr("refresh")}
                      disabled={!online || loading}
                      onPress={() => {
                        setRows([]);
                        setError(undefined);
                        setLoading(true);
                        setAttempt((value) => value + 1);
                      }}
                    />
                  ) : null}
                </View>
              ) : null}
              {loading && !rows.length ? (
                <Text
                  role="caption"
                  tone="secondary"
                  style={{ paddingHorizontal: 12, paddingVertical: 8 }}
                >
                  {tr("loading")}
                </Text>
              ) : null}
              {groupByDay(recent, language).map((group) => (
                <React.Fragment key={group.label}>
                  <SectionHeader>{group.label}</SectionHeader>
                  {group.conversations.map((conversation) => (
                    <HistoryRow
                      key={conversation.id}
                      language={language}
                      conversation={conversation}
                      selected={conversation.id === selectedId}
                      pinned={pins.includes(conversation.id)}
                      onPress={() => close(() => onSelect(conversation))}
                      onMenu={(measure) => openMenu(conversation, measure)}
                      onTogglePin={() => togglePin(conversation.id)}
                    />
                  ))}
                </React.Fragment>
              ))}
              {session && !loading && !error && !rows.length ? (
                <Text
                  role="caption"
                  tone="secondary"
                  style={{ paddingHorizontal: 12, paddingVertical: 8 }}
                >
                  {tr("noChatHistory")}
                </Text>
              ) : null}
            </ScrollView>
          </SafeAreaView>
        </Animated.View>
        {menu ? (
          <RowMenu
            language={language}
            conversation={menu.conversation}
            frame={menu.frame}
            pinned={pins.includes(menu.conversation.id)}
            pinsReady={pinsReady}
            online={online}
            onPin={() => togglePin(menu.conversation.id)}
            onRename={(title) => rename(menu.conversation, title)}
            onArchive={
              archivableConversation(menu.conversation.id)
                ? () => archive(menu.conversation)
                : undefined
            }
            onDelete={() => remove(menu.conversation)}
            onClose={() => setMenu(undefined)}
          />
        ) : null}
      </View>
    </Modal>
  );
}
type Frame = { x: number; y: number; width: number; height: number };
function HistoryRow({
  language,
  conversation,
  selected,
  pinned,
  onPress,
  onMenu,
  onTogglePin,
}: {
  language: Language;
  conversation: ConversationSummary;
  selected: boolean;
  pinned: boolean;
  onPress: () => void;
  /** Held press: opens the menu and says where this row is on screen. */
  onMenu: (measure: (report: (frame: Frame) => void) => void) => void;
  onTogglePin: () => void;
}) {
  const tr = translate(language);
  const ref = useRef<View>(null);
  const title = conversationTitle(conversation.title) || tr("untitledChat");
  const openMenu = () =>
    onMenu((report) =>
      ref.current?.measureInWindow((x, y, width, height) =>
        report({ x, y, width, height }),
      ),
    );
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ selected }}
      // Screen readers get pinning directly; holding is hard to perform there.
      accessibilityActions={[
        { name: "togglePin", label: tr(pinned ? "unpinChat" : "pinChat") },
        { name: "longpress", label: tr("chatOptions") },
      ]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === "togglePin") onTogglePin();
        if (event.nativeEvent.actionName === "longpress") openMenu();
      }}
      onPress={onPress}
      onLongPress={openMenu}
      delayLongPress={350}
      style={({ pressed }) => ({
        minHeight: 44,
        paddingVertical: 8,
        paddingHorizontal: 12,
        justifyContent: "center",
        borderRadius: 10,
        backgroundColor: selected
          ? t.color.fill
          : pressed
            ? t.color.pressed
            : "transparent",
      })}
    >
      <Text
        numberOfLines={1}
        style={selected ? { fontWeight: "600" } : undefined}
      >
        {title}
      </Text>
      {conversation.readOnly ? (
        <Text role="meta" tone="secondary" numberOfLines={1}>
          {tr("archivedChat")}
        </Text>
      ) : null}
    </Pressable>
  );
}
function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <Text
      role="section"
      tone="secondary"
      accessibilityRole="header"
      style={{ paddingHorizontal: 12, paddingTop: 16, paddingBottom: 4 }}
    >
      {children}
    </Text>
  );
}
/** The day a chat was last active, or "Archived". */
function chatDate(conversation: ConversationSummary, language: Language) {
  return conversation.readOnly
    ? translate(language)("archivedChat")
    : new Date(conversation.updatedAt).toLocaleDateString(
        language === "cs" ? "cs-CZ" : "en-GB",
        { day: "numeric", month: "short" },
      );
}
/** Today, Yesterday, Previous 7 days, then by month; input stays newest first. */
function groupByDay(
  conversations: ConversationSummary[],
  language: Language,
): { label: string; conversations: ConversationSummary[] }[] {
  const tr = translate(language);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  const groups: { label: string; conversations: ConversationSummary[] }[] = [];
  for (const conversation of conversations) {
    const at = new Date(conversation.updatedAt);
    const age = startOfToday.getTime() - at.getTime();
    const label =
      age <= 0
        ? tr("chatsToday")
        : age <= day
          ? tr("chatsYesterday")
          : age <= 7 * day
            ? tr("chatsLastWeek")
            : at.toLocaleDateString(language === "cs" ? "cs-CZ" : "en-GB", {
                month: "long",
                ...(at.getFullYear() === startOfToday.getFullYear()
                  ? {}
                  : { year: "numeric" }),
              });
    const last = groups.at(-1);
    if (last?.label === label) last.conversations.push(conversation);
    else groups.push({ label, conversations: [conversation] });
  }
  return groups;
}
/**
 * The long-press menu: the chat lifts above a dimmed menu and its actions
 * appear right under it (above it near the bottom edge).
 */
function RowMenu({
  language,
  conversation,
  frame,
  pinned,
  pinsReady,
  online,
  onPin,
  onRename,
  onArchive,
  onDelete,
  onClose,
}: {
  language: Language;
  conversation: ConversationSummary;
  /** Where the row is on screen; until measured the menu sits centred. */
  frame?: Frame;
  pinned: boolean;
  pinsReady: boolean;
  online: boolean;
  onPin: () => void;
  onRename: (title: string) => Promise<void>;
  /** Absent for a hub item's chat, which is never archived. */
  onArchive?: () => Promise<void>;
  onDelete: () => Promise<void>;
  onClose: () => void;
}) {
  const tr = translate(language);
  const inputFont = useCompanionTypography(t.typography.body);
  const title = conversationTitle(conversation.title) || tr("untitledChat");
  // Renaming and deleting stay inside the menu: a field, or one confirmation.
  const [step, setStep] = useState<"menu" | "rename" | "delete">("menu");
  const [name, setName] = useState(conversationTitle(conversation.title));
  const window = useWindowDimensions();
  const reduced = useReducedMotion();
  const [progress] = useState(() => new Animated.Value(reduced ? 1 : 0));
  const leaving = useRef(false);
  useEffect(() => {
    if (reduced) return;
    const enter = Animated.timing(progress, {
      toValue: 1,
      duration: t.motion.stateTransition,
      easing: motionEase,
      useNativeDriver: nativeMotion,
      isInteraction: false,
    });
    enter.start();
    return () => enter.stop();
  }, [progress, reduced]);
  // Leaving reverses the entrance, so the page brightens as gently as it dimmed.
  const leave = (then: () => void) => {
    if (leaving.current) return;
    leaving.current = true;
    if (reduced) {
      then();
      return;
    }
    progress.stopAnimation();
    Animated.timing(progress, {
      toValue: 0,
      duration: t.motion.sheetExit,
      easing: motionEase,
      useNativeDriver: nativeMotion,
      isInteraction: false,
    }).start(() => then());
  };
  const menuHeight = step === "menu" ? (onArchive ? 224 : 172) : 152;
  const below =
    !frame || frame.y + frame.height + 8 + menuHeight < window.height - 16;
  const width = frame ? Math.max(frame.width, 240) : 280;
  const left = frame
    ? Math.min(frame.x, window.width - width - 12)
    : (window.width - width) / 2;
  const top = frame ? frame.y : window.height / 2 - 60;
  return (
    <View
      testID="chat-row-menu"
      accessibilityViewIsModal
      style={StyleSheet.absoluteFill}
    >
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: t.color.scrimSoft, opacity: progress },
        ]}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={tr("close")}
        onPress={() => leave(onClose)}
        style={StyleSheet.absoluteFill}
      />
      {/* The held row lifts slightly in place; nothing jumps to a new spot. */}
      <Animated.View
        style={[
          styles.lifted,
          {
            top,
            left,
            width: frame ? frame.width : width,
            transform: [
              {
                scale: progress.interpolate({
                  inputRange: [0, 1],
                  outputRange: [1, 1.02],
                }),
              },
            ],
          },
        ]}
      >
        <Text numberOfLines={1}>{title}</Text>
        <Text role="caption" tone="secondary" numberOfLines={1}>
          {chatDate(conversation, language)}
        </Text>
      </Animated.View>
      <Animated.View
        accessibilityRole="menu"
        style={[
          styles.menu,
          { left, width },
          below
            ? { top: top + (frame?.height ?? 56) + 8 }
            : { top: top - 8 - menuHeight },
          {
            opacity: progress,
            transform: [
              {
                translateY: progress.interpolate({
                  inputRange: [0, 1],
                  outputRange: [below ? -6 : 6, 0],
                }),
              },
              {
                scale: progress.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0.96, 1],
                }),
              },
            ],
          },
        ]}
      >
        {step === "rename" ? (
          <View style={styles.step}>
            <TextInput
              autoFocus
              accessibilityLabel={tr("chatName")}
              value={name}
              placeholder={title}
              placeholderTextColor={t.color.text.secondary}
              maxLength={160}
              returnKeyType="done"
              onChangeText={setName}
              onSubmitEditing={() => {
                void onRename(name);
                leave(onClose);
              }}
              style={[styles.input, inputFont]}
            />
            <Row style={{ justifyContent: "flex-end", gap: 8 }}>
              <Button
                variant="quiet"
                size="small"
                label={tr("cancel")}
                onPress={() => leave(onClose)}
              />
              <Button
                size="small"
                label={tr("renameChat")}
                disabled={!online}
                onPress={() => {
                  void onRename(name);
                  leave(onClose);
                }}
              />
            </Row>
          </View>
        ) : step === "delete" ? (
          <View style={styles.step}>
            <Text>{tr("deleteChatTitle")}</Text>
            <Text role="caption" tone="secondary">
              {tr("deleteChatHint")}
            </Text>
            <Row style={{ justifyContent: "flex-end", gap: 8 }}>
              <Button
                variant="quiet"
                size="small"
                label={tr("cancel")}
                onPress={() => leave(onClose)}
              />
              <Button
                variant="danger"
                size="small"
                label={tr("deleteChat")}
                disabled={!online}
                onPress={() => {
                  void onDelete();
                  leave(onClose);
                }}
              />
            </Row>
          </View>
        ) : (
          <>
            <Pressable
              accessibilityRole="menuitem"
              accessibilityLabel={tr(pinned ? "unpinChat" : "pinChat")}
              accessibilityState={{ disabled: !pinsReady }}
              disabled={!pinsReady}
              onPress={() => {
                onPin();
                leave(onClose);
              }}
              style={({ pressed }) => [
                styles.menuItem,
                {
                  opacity: pinsReady ? 1 : 0.45,
                  backgroundColor: pressed ? t.color.pressed : "transparent",
                },
              ]}
            >
              <Icon name="pin" size={20} color={t.color.text.primary} />
              <Text style={{ flex: 1 }}>
                {tr(pinned ? "unpinChat" : "pinChat")}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="menuitem"
              accessibilityLabel={tr("renameChat")}
              accessibilityState={{ disabled: !online }}
              disabled={!online}
              onPress={() => setStep("rename")}
              style={({ pressed }) => [
                styles.menuItem,
                {
                  opacity: online ? 1 : 0.45,
                  backgroundColor: pressed ? t.color.pressed : "transparent",
                },
              ]}
            >
              <Icon name="edit" size={20} color={t.color.text.primary} />
              <Text style={{ flex: 1 }}>{tr("renameChat")}</Text>
            </Pressable>
            {onArchive ? (
              <Pressable
                accessibilityRole="menuitem"
                accessibilityLabel={tr("archiveChat")}
                accessibilityState={{ disabled: !online }}
                disabled={!online}
                onPress={() => {
                  void onArchive();
                  leave(onClose);
                }}
                style={({ pressed }) => [
                  styles.menuItem,
                  {
                    opacity: online ? 1 : 0.45,
                    backgroundColor: pressed ? t.color.pressed : "transparent",
                  },
                ]}
              >
                <Icon name="archive" size={20} color={t.color.text.primary} />
                <Text style={{ flex: 1 }}>{tr("archiveChat")}</Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="menuitem"
              accessibilityLabel={tr("deleteChat")}
              accessibilityState={{ disabled: !online }}
              disabled={!online}
              onPress={() => setStep("delete")}
              style={({ pressed }) => [
                styles.menuItem,
                {
                  opacity: online ? 1 : 0.45,
                  backgroundColor: pressed ? t.color.pressed : "transparent",
                },
              ]}
            >
              <Icon name="trash" size={20} color={t.color.action.danger} />
              <Text style={{ flex: 1, color: t.color.action.danger }}>
                {tr("deleteChat")}
              </Text>
            </Pressable>
          </>
        )}
      </Animated.View>
    </View>
  );
}
const styles = StyleSheet.create({
  lifted: {
    position: "absolute",
    minHeight: 52,
    paddingVertical: 8,
    paddingHorizontal: 12,
    justifyContent: "center",
    borderRadius: 12,
    backgroundColor: t.color.surfaceRaised,
    ...t.elevation.card,
  },
  menu: {
    position: "absolute",
    padding: 4,
    borderRadius: t.radius.control,
    backgroundColor: t.color.surfaceRaised,
    ...t.elevation.drawer,
  },
  step: { padding: 12, gap: 10 },
  input: {
    minHeight: 44,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: t.color.hairline,
    color: t.color.text.primary,
    ...t.typography.body,
  },
  menuItem: {
    minHeight: 52,
    paddingHorizontal: 12,
    borderRadius: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
});
