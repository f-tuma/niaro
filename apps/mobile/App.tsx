import {
  useMobileComposerMentions,
  MobileMentionSuggestions,
  MobileMentionSheet,
  MobileMentionTray,
} from "./MobileMentions";
import type { MessageMention } from "../../packages/protocol/mentions";
import { VoiceServiceCard } from "../../packages/ui-catalog/VoiceServiceCard";
import type { VoiceCapabilities } from "../../packages/protocol/voice";
import { useHomePetVisibility } from "./home-pet-visibility";
import {
  useMobileAttachments,
  MobileAttachmentDraft,
  MobileAttachmentPreview,
  MobileMessageAttachments,
} from "./AttachmentControls";
import { AttachmentPicker } from "../../packages/ui-catalog/AttachmentPicker";
import { useCompanionFonts } from "./CompanionFonts";
import { CompanionFontContext } from "../../packages/ui/typography";
import { CompanionLibrary } from "./CompanionLibrary";
import { companionCopy } from "./companion-copy";
import { LanguageMenu } from "./LanguageMenu";
import { PetView } from "../../packages/ui/PetView";
import {
  MeetingLibrary,
  MeetingRecordingControls,
  type MeetingRecordingControl,
} from "./MeetingLibrary";
import { HumanTaskLibrary } from "./HumanTaskLibrary";
import { loginProof, authorizeApp } from "./app-login";
import React, {
  useEffect,
  useState,
  useSyncExternalStore,
  useRef,
  useCallback,
  useLayoutEffect,
  useMemo,
} from "react";
import {
  Animated,
  AppState,
  BackHandler,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { randomUUID } from "expo-crypto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  ClientSession,
  commandTarget,
  type SessionCommand,
} from "../../packages/client-core/session";
import {
  captureProcessNoticeOwner,
  processNoticeCopy,
  selectProcessCommandNotice,
  isReservedProcessRecoveryCopy,
} from "../../packages/client-core/process-command-notice";
import { ProcessCommandNoticeView } from "../../packages/ui-catalog/ProcessCommandNoticeView";
import { ConnectionFailureNotice } from "../../packages/ui-catalog/ConnectionFailureNotice";
import {
  assertProcessAnswerTarget,
  captureProcessAnswerTarget,
  processAnswerCommand,
} from "../../packages/client-core/process-answers";
import { followSpokenReply } from "../../packages/client-core/automatic-speech";
import { conversationTitle } from "../../packages/client-core/conversation-title";
import { selectRecentProcessRuns } from "../../packages/client-core/process-run-history";
import {
  Connections,
  type ConnectionState,
} from "../../packages/client-core/connections";
import { useReplySpeech } from "./ReplySpeech";
import { VoiceSettings } from "./VoiceSettings";
import { ArchivedChatsSection } from "./ArchivedChats";
import { chatChangeError } from "../../packages/client-core/conversation-directory";
import { credentialVault } from "./credential-vault";
import { ConnectionCard } from "../../packages/ui-catalog/ConnectionCard";
import {
  loadLanguage,
  saveLanguage,
  loadSpokenReplies,
  saveSpokenReplies,
  loadFeedback,
  saveFeedback,
} from "../../packages/client-core/preferences";
import { FeedbackCard } from "../../packages/ui-catalog/FeedbackCard";
import {
  answerCommand,
  messageCommand,
  proposalDecision,
  reviseProposal,
  reconcileOperation,
} from "../../packages/client-core/commands";
import {
  selectReplyInput,
  selectConversationWork,
  selectWorkMessageAnchors,
  selectPresentedWork,
  isTerminalNativeWork,
} from "../../packages/client-core/store";
import { translate, en, type TranslationKey } from "../../packages/i18n";
import {
  type Language,
  type WorkItem,
  type ConversationSummary,
  type Conversation,
  type HumanTaskReference,
} from "../../packages/protocol";
import type { HumanTask } from "../../packages/protocol/human-tasks";
import { ChatHistory } from "./ChatHistory";
import { ChatSearchScreen } from "./ChatSearch";
import { tokens as t } from "../../packages/design-tokens";
import {
  Text,
  Stack,
  Button,
  Notice,
  ActionToast,
  FadeEdge,
  Group,
  Icon,
  IconTile,
  ListRow,
  Row,
} from "../../packages/ui";
import { MobileWorkItemCard } from "./MobileWorkItemCard";
import { ProcessAnswerRecoveryCard } from "../../packages/ui-catalog/ProcessAnswerRecoveryCard";
import { recordedProcessAnswer } from "../../packages/client-core/reply-context";
import {
  canRetryPending,
  chatErrorKey,
  isUserMessageRecorded,
  selectPendingChatMessage,
} from "../../packages/client-core/chat-view";
import {
  chatBackgrounded,
  chatSessionIsFresh,
  chatResumed,
  useChatGeneration,
  withChatSession,
} from "./chat-session";
import {
  VoiceReply,
  createVoiceReply,
  isProcessReply,
  type VoiceReplyContext,
} from "./VoiceReply";
import { ServiceConnection } from "./ServiceConnection";
import { ProcessLaunch } from "./ProcessLaunch";
import { ProcessDesign } from "./ProcessDesign";
import { ProcessApprovalRecovery } from "./ProcessApprovalRecovery";
import { feedback, setFeedbackEnabled } from "./feedback";
import type { VoiceDraft } from "../../packages/client-core/voice";
import { Entrance, MotionProvider } from "../../packages/ui/motion";
import { WorkItemSummary } from "../../packages/ui-catalog/WorkItemSummary";
import { ServiceActionCard } from "../../packages/ui-catalog/ServiceActionCard";
import { GenerativeUiView } from "../../packages/ui-catalog/GenerativeUiView";
import { cardDocumentText } from "../../packages/protocol/card-document";
import { ProcessOfferCard } from "../../packages/ui-catalog/ProcessOfferCard";
import type { ProcessOfferResult } from "../../packages/protocol/process-offer";
import { processProposalWebUrl } from "../../packages/protocol/process-proposal";
import { MarkdownText } from "../../packages/ui-catalog/MarkdownText";
import { splitDraft } from "../../packages/openui-library/program";

import { CrmContactResults } from "../../packages/ui-catalog/CrmContactCard";
import { RequestProgressCard } from "../../packages/ui-catalog/RequestProgressCard";
import {
  chrome as styles,
  TopBar,
  StatusLine,
  Home,
  TaskTabs,
  Composer,
  ReadOnlyComposer,
  DetailSheet,
  EmptyState,
  IconButton,
  AssistantMessage,
  Navigation,
  type Section,
  type TaskTab,
  type VoiceAvailability,
} from "./ScreenChrome";

import type { MessageResultToken } from "../../packages/protocol/message-delivery";

/** The chat results this app renders (renderMessage); others arrive as text. */
const MOBILE_MESSAGE_RESULTS: readonly MessageResultToken[] = [
  "crm.contacts/1",
  "service.action/1",
  "service.connection/1",
  "card.document/1",
  "process.offer/1",
  "skill.proposal/1",
  "process.proposal/1",
];
const ADDRESS_KEY = "agent-client.address.v1";
const allowHttp =
  __DEV__ && process.env.EXPO_PUBLIC_ALLOW_INSECURE_FIXTURES === "1";
function Settings({
  language,
  changeLanguage,
  spokenReplies,
  changeSpokenReplies,
  feedbackOn,
  changeFeedback,
  address,
  setAddress,
  connect,
  browserSignIn,
  openBrowser,
  disconnect,
  connection,
  error,
}: {
  language: Language;
  changeLanguage: (l: Language) => void;
  spokenReplies: boolean;
  changeSpokenReplies: (enabled: boolean) => void;
  feedbackOn: boolean;
  changeFeedback: (enabled: boolean) => void;
  address: string;
  setAddress: (v: string) => void;
  connect: (code: string) => void;
  browserSignIn: () => void;
  openBrowser: () => void;
  disconnect: () => void;
  connection: ConnectionState;
  error: TranslationKey | null;
}) {
  const tr = translate(language);
  const sessionState = useSyncExternalStore(
    connection.session?.subscribe ?? subscribeEmpty,
    connection.session?.getSnapshot ?? getEmpty,
    connection.session?.getSnapshot ?? getEmpty,
  );
  return (
    <Stack style={{ gap: t.spacing.xl }}>
      <ConnectionCard
        language={language}
        address={address}
        onAddress={setAddress}
        activeAddress={connection.address}
        status={connection.status}
        sessionStatus={sessionState.status}
        identity={connection.identity}
        renewable={connection.renewable}
        error={error}
        development={allowHttp}
        web={Platform.OS === "web"}
        onPair={connect}
        onBrowserSignIn={browserSignIn}
        onOpenBrowser={openBrowser}
        browserLogin={connection.browserLogin}
        onDisconnect={disconnect}
      />
      {connection.session ? (
        <VoiceSettings
          session={connection.session}
          language={language}
          spokenReplies={spokenReplies}
          onSpokenReplies={changeSpokenReplies}
        />
      ) : null}
      <Group title={tr("appSettings")}>
        <FeedbackCard
          language={language}
          enabled={feedbackOn}
          onChange={changeFeedback}
        />
        <LanguageMenu language={language} onChange={changeLanguage} />
      </Group>
    </Stack>
  );
}
const emptySessionState = {
  store: null,
  status: "offline" as const,
  commandStates: {},
  pending: null,
  processPending: null,
  answerAttempts: [],
  answerRecoveryBlocked: false,
  error: null,
  activity: null,
  activityConnection: "waiting" as const,
};
const getEmpty = () => emptySessionState;
const subscribeEmpty = () => () => {};

export function Workspace({
  session,
  language,
  section,
  setSection,
  settings,
  authError,
  spokenReplies,
}: {
  session: ClientSession | null;
  language: Language;
  section: Section;
  setSection: (s: Section) => void;
  settings: React.ReactNode;
  authError: TranslationKey | null;
  spokenReplies: boolean;
}) {
  const sessionOwner = useRef(session);
  useLayoutEffect(() => {
    sessionOwner.current = session;
  }, [session]);
  const state = useSyncExternalStore(
    session?.subscribe ?? subscribeEmpty,
    session?.getSnapshot ?? getEmpty,
    session?.getSnapshot ?? getEmpty,
  );
  const tr = translate(language);
  const scroll = useRef<ScrollView>(null);
  const homePetVisibility = useHomePetVisibility();
  const composerInput = useRef<TextInput>(null);
  const focusWork = useRef<string | undefined>(undefined);
  const [draft, setDraftState] = useState("");
  const draftRef = useRef("");
  const draftRevision = useRef(0);
  const draftVersion = useRef(0);
  const setDraft = useCallback((update: React.SetStateAction<string>) => {
    const next =
      typeof update === "function" ? update(draftRef.current) : update;
    draftRef.current = next;
    // A newer edit can contain identical text; equality does not imply ownership.
    draftRevision.current = ++draftVersion.current;
    setDraftState(next);
  }, []);
  const [context, setContextState] = useState<VoiceReplyContext>();
  const [answerCaption, setAnswerCaption] = useState<{
    context: VoiceReplyContext;
    target: string;
    text: string;
    command: SessionCommand;
  }>();
  const contextRef = useRef<VoiceReplyContext | undefined>(undefined);
  // An open item from Tasks waits in the composer of the chat it was brought
  // to, and rides on that chat's next message.
  const [attachedTask, setAttachedTask] = useState<{
    conversationId: string;
    task: HumanTaskReference;
  }>();
  const contextGeneration = useRef(0);
  const invalidateAnswerCallbacks = useCallback(() => {
    contextGeneration.current++;
  }, []);
  const [replyError, setReplyError] = useState<TranslationKey | null>(null);
  const setContext = useCallback(
    (next: VoiceReplyContext | undefined) => {
      if (next === contextRef.current) return;
      if (
        isProcessReply(contextRef.current) &&
        next &&
        (!isProcessReply(next) ||
          JSON.stringify(next.target) !==
            JSON.stringify(contextRef.current.target))
      )
        setDraft("");
      invalidateAnswerCallbacks();
      contextRef.current = next;
      setContextState(next);
      setAnswerCaption(undefined);
      setReplyError(null);
    },
    [setDraft, invalidateAnswerCallbacks],
  );
  const [conversationId, setConversationId] = useState("conversation-1");
  const conversationRef = useRef(conversationId);
  const [composerActive, setComposerActive] = useState(
    AppState.currentState !== "background" &&
      AppState.currentState !== "inactive",
  );
  const composerOwner = useMemo(
    () => ({ session, conversationId, section, composerActive }),
    [session, conversationId, section, composerActive],
  );
  const composerOwnerRef = useRef(composerOwner);
  const [composerFocus, setComposerFocus] = useState<
    typeof composerOwner | null
  >(null);
  useLayoutEffect(() => {
    composerOwnerRef.current = composerOwner;
  }, [composerOwner]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      setComposerActive(state === "active");
      if (state !== "active") setComposerFocus(null);
    });
    return () => subscription.remove();
  }, []);
  const petOccupied =
    composerActive &&
    section === "chat" &&
    (draft.length > 0 || composerFocus === composerOwner);
  const setOwnedComposerFocus = (focused: boolean) => {
    if (composerOwnerRef.current !== composerOwner || !composerActive) return;
    setComposerFocus(focused ? composerOwner : null);
  };

  const [continuedConversations, setContinuedConversations] = useState<
    Record<string, true>
  >({});
  const continueConversation =
    conversationId !== "conversation-1" ||
    !!continuedConversations[conversationId];
  const drafts = useRef(
    new Map<
      string,
      { text: string; context?: VoiceReplyContext; revision: number }
    >(),
  );
  const [historyOpen, setHistoryOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState(false);
  // Search in chats, a screen of its own over everything (from the menu).
  const [searchOpen, setSearchOpen] = useState(false);
  const [historySelection, setHistorySelection] =
    useState<ConversationSummary>();
  const historySelectionRef = useRef<ConversationSummary | undefined>(
    undefined,
  );
  const [historyMessages, setHistoryMessages] = useState<
    Conversation["messages"]
  >([]);
  const [historyAfter, setHistoryAfter] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const historyRead = useRef<AbortController | undefined>(undefined);
  const historyReadGeneration = useRef(0);
  const historySilent = useRef(false);
  const [tab, setTab] = useState<TaskTab>("open");
  const [humanTaskRefresh, setHumanTaskRefresh] = useState(0);
  const [humanTaskCounts, setHumanTaskCounts] = useState<{
    owner: string;
    open: number;
    done: number;
  }>();
  const updateHumanTaskCounts = useCallback(
    (owner: string, counts: { open: number; done: number }) => {
      setHumanTaskCounts((previous) =>
        previous?.owner === owner &&
        previous.open === counts.open &&
        previous.done === counts.done
          ? previous
          : { owner, ...counts },
      );
    },
    [],
  );
  const [processOpen, setProcessOpen] = useState(false);
  /** The process the assistant offered, opened from its chat card. */
  const [processOffer, setProcessOffer] = useState<ProcessOfferResult | null>(
    null,
  );
  const [processDesignerOpen, setProcessDesignerOpen] = useState(false);
  const [processDesignerServiceId, setProcessDesignerServiceId] = useState<
    string | null
  >(null);
  const [selectedProcessRunId, setSelectedProcessRunId] = useState<
    string | null
  >(null);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  useEffect(() => {
    const shown = Keyboard.addListener("keyboardDidShow", () =>
      setKeyboardOpen(true),
    );
    const hidden = Keyboard.addListener("keyboardDidHide", () =>
      setKeyboardOpen(false),
    );
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);
  // An open meeting record is a screen of its own inside Meetings.
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [meetingRefresh, setMeetingRefresh] = useState(0);
  const [meetingRecording, setMeetingRecording] = useState(false);
  const [meetingRecordingControl, setMeetingRecordingControl] =
    useState<MeetingRecordingControl | null>(null);
  const meetingOpen = section === "meetings" && !!meetingId;
  // Back closes overlays first, then nested records, then returns to the chat.
  useEffect(() => {
    if (
      (!historyOpen && !processOpen && section === "chat") ||
      Platform.OS === "web"
    )
      return;
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        if (historyOpen) setHistoryOpen(false);
        else if (processOpen && processDesignerOpen)
          setProcessDesignerOpen(false);
        else if (processOpen && selectedProcessRunId)
          setSelectedProcessRunId(null);
        else if (processOpen) setProcessOpen(false);
        else if (meetingOpen) setMeetingId(null);
        else if (section === "meetings" || section === "more")
          setSection("library");
        else setSection("chat");
        return true;
      },
    );
    return () => subscription.remove();
  }, [
    historyOpen,
    processOpen,
    processDesignerOpen,
    selectedProcessRunId,
    section,
    setSection,
    meetingOpen,
  ]);
  const [voice, setVoice] = useState<VoiceDraft>();
  // Shared by every voice visual; written by the recorder, never by rendering.
  const [voiceLevel] = useState(() => new Animated.Value(0));
  const voiceRef = useRef<VoiceDraft | undefined>(undefined);
  const voiceGeneration = useRef(0);
  const nativeSubmission = useRef<
    | {
        commandId: string;
        target: string;
        text: string;
        context: VoiceReplyContext;
        generation: number;
        draftRevision: number;
        command: SessionCommand;
        deliveryFailed?: boolean;
      }
    | undefined
  >(undefined);
  // A spoken reply appears together with its audio, not seconds before it.
  const [heldReply, setHeldReply] = useState<string>();
  const releaseHeldReply = useRef<(() => void) | undefined>(undefined);
  const closeVoice = useCallback(() => {
    voiceGeneration.current++;
    void voiceRef.current?.cancel();
    voiceRef.current = undefined;
    setVoice(undefined);
  }, []);
  const nearBottom = useRef(true);
  // Only the person's own drag can leave the end of the chat; growing content cannot.
  const dragging = useRef(false);
  useEffect(() => {
    if (focusWork.current) return;
    scroll.current?.scrollTo({ y: 0, animated: false });
    nearBottom.current = true;
  }, [section, meetingId]);
  const store = state.store;
  const online = state.status === "online";
  // Known before the first tap, so no screen offers voice the server lacks.
  const [voiceSettingsOwner, setVoiceSettingsOwner] =
    useState<ClientSession | null>(null);
  const voiceSettingsOpen = !!session && voiceSettingsOwner === session;
  const [voiceSupport, setVoiceSupport] = useState<{
    session: ClientSession;
    value: VoiceAvailability;
    capabilities: VoiceCapabilities | null;
  }>();
  useEffect(() => {
    if (!session || !online || typeof session.voiceCapabilities !== "function")
      return;
    let controller: AbortController | undefined,
      generation = 0;
    const identity = session.identityKey;
    const refresh = () => {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal,
        request = ++generation;
      void session.voiceCapabilities(signal).then(
        (value) => {
          if (
            !signal.aborted &&
            request === generation &&
            sessionOwner.current === session &&
            identity === session.identityKey
          )
            setVoiceSupport({
              session,
              value: value.enabled ? "available" : "unavailable",
              capabilities: value,
            });
        },
        () => {
          if (
            !signal.aborted &&
            request === generation &&
            sessionOwner.current === session
          )
            setVoiceSupport({ session, value: "unknown", capabilities: null });
        },
      );
    };
    refresh();
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") refresh();
      else controller?.abort();
    });
    return () => {
      controller?.abort();
      subscription.remove();
      setVoiceSettingsOwner(null);
    };
  }, [session, online]);
  const voiceAvailability: VoiceAvailability =
    voiceSupport?.session === session ? voiceSupport.value : "unknown";
  // Where this device's chat session begins: set once the first snapshot is
  // known, and again after long inactivity (see chat-session.ts).
  const chatGeneration = useChatGeneration();
  const attachmentGeneration =
    store?.conversations[conversationId]?.attachmentGeneration ??
    historySelection?.attachmentGeneration ??
    null;
  const attachmentScope = session?.attachments?.getSnapshot();
  const attachments = useMobileAttachments(
    session,
    {
      conversationId,
      expectedGeneration: attachmentGeneration,
      mode:
        attachmentScope?.entries.length &&
        attachmentScope.target?.conversationId === conversationId &&
        attachmentScope.target.expectedGeneration === attachmentGeneration
          ? attachmentScope.target.mode
          : !continueConversation &&
              !context &&
              chatSessionIsFresh() &&
              attachmentGeneration
            ? "new"
            : "current",
    },
    chatGeneration,
    language,
  );
  const noticeOwner = session
    ? captureProcessNoticeOwner(session, {
        conversationId,
        chatGeneration,
        language,
      })
    : undefined;
  const [chatStart, setChatStart] = useState<{
    conversationId: string;
    generation: number;
    afterMessageId: string | null;
    earlierWork: ReadonlySet<string>;
  }>();
  if (
    store &&
    (chatStart?.generation !== chatGeneration ||
      chatStart.conversationId !== conversationId)
  )
    setChatStart({
      conversationId,
      generation: chatGeneration,
      afterMessageId:
        store.conversations[conversationId]?.messages.at(-1)?.id ?? null,
      earlierWork: new Set(Object.keys(store.workItems)),
    });
  const [openedWork, setOpenedWork] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const busy = !!state.pending || !!state.answerRecoveryBlocked;
  const mentions = useMobileComposerMentions({
    session,
    online,
    conversationId,
    context,
    enabled:
      !!session &&
      online &&
      !busy &&
      !context &&
      !historySelection?.readOnly &&
      !historyLoading,
    read: () => ({
      identityKey: sessionOwner.current?.identityKey ?? "",
      conversationId: conversationRef.current,
      revision: draftRevision.current,
      text: draftRef.current,
    }),
    onChange: (text) => {
      speech.player.stop();
      setDraft(text);
    },
    onFocus: () => composerInput.current?.focus(),
  });

  // Projection can arrive after delivery or an explicit retry has already settled.
  useEffect(() => {
    const submitted = nativeSubmission.current;
    if (!submitted) return;
    if (
      submitted.generation !== contextGeneration.current ||
      contextRef.current !== submitted.context
    ) {
      nativeSubmission.current = undefined;
      setAnswerCaption(undefined);
      return;
    }
    if (
      !recordedProcessAnswer(state.store, submitted.context, submitted.command)
    )
      return;
    nativeSubmission.current = undefined;
    setAnswerCaption(undefined);
    if (draftRevision.current === submitted.draftRevision) {
      setDraft("");
      setContext(undefined);
    }
  }, [state.store, context, setContext, setDraft]);
  const speech = useReplySpeech(session, online, spokenReplies);
  const switchConversation = useCallback(
    (id: string) => {
      invalidateAnswerCallbacks();
      if (id !== conversationRef.current) {
        drafts.current.set(conversationRef.current, {
          text: draftRef.current,
          context: contextRef.current,
          revision: draftRevision.current,
        });
        const saved = drafts.current.get(id);
        setContext(saved?.context);
        draftRef.current = saved?.text ?? "";
        draftRevision.current = saved?.revision ?? ++draftVersion.current;
        setDraftState(draftRef.current);
      }
      closeVoice();
      speech.player.stop();
      releaseHeldReply.current?.();
      setHeldReply(undefined);
      setAnswerCaption(undefined);
      focusWork.current = undefined;
      historyRead.current?.abort();
      historyReadGeneration.current++;
      historySelectionRef.current = undefined;
      setHistorySelection(undefined);
      setHistoryMessages([]);
      setHistoryAfter(null);
      setHistoryError(false);
      setHistoryLoading(false);
      conversationRef.current = id;
      setConversationId(id);
      session?.selectConversation?.(id);
      nearBottom.current = true;
      setHistoryOpen(false);
      setSection("chat");
    },
    [
      invalidateAnswerCallbacks,
      setContext,
      closeVoice,
      speech.player,
      session,
      setSection,
    ],
  );
  const readHistory = useCallback(
    async (selected: ConversationSummary, older = false, silent = true) => {
      if (!session) return;
      historyRead.current?.abort();
      const controller = new AbortController();
      historyRead.current = controller;
      const owner = ++historyReadGeneration.current;
      setHistoryLoading(true);
      setHistoryError(false);
      try {
        const page = await session.readConversation(
          selected.id,
          older ? historyAfter : undefined,
          older ? selected.revision : undefined,
          controller.signal,
        );
        if (
          owner !== historyReadGeneration.current ||
          conversationRef.current !== selected.id
        )
          return;
        historySelectionRef.current = page.conversation;
        historySilent.current = silent;
        setHistorySelection(page.conversation);
        setHistoryMessages((current) =>
          older ? [...page.messages, ...current] : page.messages,
        );
        setHistoryAfter(page.nextAfter);
      } catch {
        if (owner === historyReadGeneration.current) setHistoryError(true);
      } finally {
        if (owner === historyReadGeneration.current) setHistoryLoading(false);
      }
    },
    [session, historyAfter],
  );
  const openHistoryConversation = (selected: ConversationSummary) => {
    switchConversation(selected.id);
    setContinuedConversations((current) => ({
      ...current,
      [selected.id]: true,
    }));
    historySelectionRef.current = selected;
    setHistorySelection(selected);
    void readHistory(selected);
    if (!selected.readOnly) void session?.refresh();
  };
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<TranslationKey>();
  /** The archived chat open here returns to the menu and can go on. */
  const restoreOpenChat = () => {
    const selected = historySelectionRef.current;
    if (!session || !selected?.readOnly || restoring) return;
    setRestoring(true);
    setRestoreError(undefined);
    void session
      .restoreConversation(selected.id, randomUUID())
      .then(async () => {
        if (conversationRef.current !== selected.id) return;
        await readHistory({ ...selected, readOnly: false });
        void session.refresh();
      })
      .catch((e: unknown) => {
        if (conversationRef.current === selected.id)
          setRestoreError(chatChangeError(e));
      })
      .finally(() => setRestoring(false));
  };
  // A new chat lives only on this device until its first message, so
  // tapping New chat never leaves empty chats in the history.
  const [unsavedChat, setUnsavedChat] = useState<string | null>(null);
  const unsavedChatRef = useRef<string | null>(null);
  const createConversation = async () => {
    if (!session || !online || busy) return;
    if (conversationRef.current === unsavedChatRef.current) {
      setHistoryOpen(false);
      setSection("chat");
      return;
    }
    const id = `chat-${randomUUID()}`;
    switchConversation(id);
    unsavedChatRef.current = id;
    setUnsavedChat(id);
  };
  const savingChat = useRef<
    | {
        session: ClientSession;
        conversationId: string;
        promise: Promise<boolean>;
      }
    | undefined
  >(undefined);
  /** Creates the local chat on the server right before its first message. */
  const saveChat = (id: string): Promise<boolean> => {
    if (!session) return Promise.reject(new Error("connection_failed"));
    const existing = savingChat.current;
    if (existing?.session === session && existing.conversationId === id)
      return existing.promise;
    const owner = session;
    const promise = (async () => {
      // The chat's own key makes a retried creation the same command.
      const key = id.slice("chat-".length);
      const command: SessionCommand = {
        type: "conversation.create",
        conversationId: id,
        commandId: key,
        idempotencyKey: key,
      };
      await owner.send(command);
      if (
        owner.getSnapshot().commandStates[commandTarget(command)] !== "accepted"
      )
        throw new Error("connection_failed");
      if (unsavedChatRef.current === id) {
        unsavedChatRef.current = null;
        setUnsavedChat(null);
      }
      if (conversationRef.current !== id) return false;
      const now = new Date().toISOString();
      const selected: ConversationSummary = {
        id,
        revision: 1,
        title: "",
        createdAt: now,
        updatedAt: now,
        readOnly: false,
        messageCount: 0,
      };
      setContinuedConversations((current) => ({ ...current, [id]: true }));
      historySelectionRef.current = selected;
      setHistorySelection(selected);
      void readHistory(selected);
      return true;
    })();
    const flight = { session: owner, conversationId: id, promise };
    savingChat.current = flight;
    const clear = () => {
      if (savingChat.current === flight) savingChat.current = undefined;
    };
    void promise.then(clear, clear);
    return promise;
  };
  const historyLiveRevision = store?.conversations[conversationId]?.revision;
  useEffect(() => {
    const selected = historySelectionRef.current;
    if (
      selected &&
      !selected.readOnly &&
      historyLiveRevision &&
      historyLiveRevision > selected.revision
    )
      void readHistory(selected, false, false);
  }, [historyLiveRevision, readHistory]);
  useEffect(
    () => () => {
      historyRead.current?.abort();
      historyReadGeneration.current++;
      contextGeneration.current++;
    },
    [],
  );
  useEffect(() => {
    if (!online || !spokenReplies || section !== "chat")
      releaseHeldReply.current?.();
    return () => releaseHeldReply.current?.();
  }, [session, online, spokenReplies, section]);
  const speechOptions = useRef({
    automatic: spokenReplies,
    enabled: speech.enabled,
  });
  useEffect(() => {
    speechOptions.current = {
      automatic: spokenReplies,
      enabled: speech.enabled,
    };
  }, [spokenReplies, speech.enabled]);
  useEffect(
    () =>
      session?.subscribe(() => {
        const current = session.getSnapshot();
        let invalid = false;
        if (isProcessReply(context)) {
          try {
            if (!current.store) throw new Error("process_question_changed");
            assertProcessAnswerTarget(current.store, context.target);
          } catch {
            invalid = true;
          }
        } else if (context) {
          const question = selectReplyInput(current.store, context);
          invalid =
            !question ||
            question.status !== "open" ||
            question.revision !== context.revision;
        }
        if (current.status !== "online" || invalid) closeVoice();
      }),
    [session, context, closeVoice],
  );
  const count =
    humanTaskCounts?.owner === session?.identityKey
      ? (humanTaskCounts?.open ?? 0)
      : 0;
  useEffect(() => {
    if (!session) return;
    void session.start();
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") {
        chatResumed();
        void session.refresh();
      } else {
        closeVoice();
        chatBackgrounded();
      }
    });
    return () => {
      invalidateAnswerCallbacks();
      closeVoice();
      subscription.remove();
      session.stop();
    };
  }, [session, closeVoice, invalidateAnswerCallbacks]);
  const submitMessage = (
    value = draft,
    replyContext: VoiceReplyContext | null | undefined = context,
    draftOwnerRevision = draftRevision.current,
    options: { withoutProcess?: true; mentions?: MessageMention[] } = {},
  ) => {
    const attachmentEntries = session?.attachments?.getSnapshot().entries ?? [];
    const attachmentReady = !!session?.attachments?.ready;
    if (
      !session ||
      sessionOwner.current !== session ||
      (!value.trim() && !attachmentReady) ||
      (attachmentEntries.length > 0 && (!attachmentReady || !!replyContext)) ||
      busy ||
      !online ||
      historySelection?.readOnly
    )
      return;
    const selectedMentions = replyContext
      ? []
      : (options.mentions ?? mentions.payload(value));
    // The first message first saves a chat that so far existed only here.
    if (!replyContext && conversationRef.current === unsavedChatRef.current) {
      void saveChat(conversationRef.current)
        .then((current) => {
          if (current)
            submitMessage(value, null, draftOwnerRevision, {
              ...options,
              mentions: selectedMentions,
            });
        })
        .catch(() => setReplyError("requestRejected"));
      return;
    }
    nearBottom.current = true;
    const generation = contextGeneration.current;
    const submittedDraftRevision = draftOwnerRevision;
    const task =
      !replyContext && attachedTask?.conversationId === conversationId
        ? attachedTask.task
        : undefined;
    let command;
    try {
      const id = randomUUID();
      command = isProcessReply(replyContext)
        ? processAnswerCommand(
            session.getSnapshot().store!,
            replyContext.target,
            {
              commandId: id,
              idempotencyKey: id,
              answer: value,
              language,
            },
          )
        : withChatSession(
            {
              ...messageCommand(
                value.trim(),
                language,
                id,
                replyContext ?? undefined,
                attachmentEntries.length
                  ? session.attachments.takeForSend()
                  : undefined,
              ),
              ...(replyContext ? {} : { conversationId }),
              ...(task ? { humanTask: task } : {}),
              ...(selectedMentions.length
                ? { mentions: selectedMentions }
                : {}),
              ...(!replyContext && options.withoutProcess
                ? { withoutProcess: true as const }
                : {}),
            },
            continueConversation,
          );
      if (
        command.type === "message.send" &&
        command.attachments &&
        session.attachments.getSnapshot().target?.mode === "new"
      )
        command = { ...command, session: "new" as const };
    } catch {
      setReplyError("process_question_changed");
      return;
    }
    if (isProcessReply(replyContext)) {
      setAnswerCaption({
        context: replyContext,
        target: commandTarget(command),
        text: value,
        command,
      });
      nativeSubmission.current = {
        commandId: command.commandId,
        target: commandTarget(command),
        text: value,
        context: replyContext,
        generation,
        draftRevision: draftRevision.current,
        command,
      };
    }
    void session
      .send(command, false, undefined, noticeOwner)
      .then(() => {
        const current = session.getSnapshot();
        const recorded = isUserMessageRecorded(current.store, command);
        // Once sent, the item belongs to the chat; the server keeps it there.
        if (
          task &&
          (recorded ||
            current.commandStates[commandTarget(command)] === "accepted")
        )
          setAttachedTask((attached) =>
            attached?.conversationId === command.conversationId &&
            attached.task.id === task.id
              ? undefined
              : attached,
          );
        if (
          contextGeneration.current !== generation ||
          contextRef.current !== (replyContext ?? undefined)
        ) {
          const saved = drafts.current.get(command.conversationId);
          const consumed = isProcessReply(replyContext)
            ? recordedProcessAnswer(current.store, replyContext, command)
            : recorded;
          if (
            consumed &&
            conversationRef.current === command.conversationId &&
            draftRevision.current === submittedDraftRevision &&
            contextRef.current === (replyContext ?? undefined)
          ) {
            setDraft("");
            setContext(undefined);
          }
          if (
            consumed &&
            conversationRef.current !== command.conversationId &&
            saved?.revision === submittedDraftRevision
          )
            drafts.current.set(command.conversationId, {
              text: "",
              revision: saved.revision + 1,
            });
          return;
        }
        const target = commandTarget(command);
        if (
          isProcessReply(replyContext)
            ? !recordedProcessAnswer(current.store, replyContext, command)
            : current.commandStates[target] !== "accepted" && !recorded
        ) {
          if (nativeSubmission.current?.commandId === command.commandId)
            nativeSubmission.current.deliveryFailed = true;
          return;
        }
        if (isProcessReply(replyContext)) {
          if (
            draftRevision.current === nativeSubmission.current?.draftRevision
          ) {
            setDraft("");
            setContext(undefined);
          }
        } else {
          if (
            draftRevision.current === submittedDraftRevision &&
            conversationRef.current === command.conversationId
          ) {
            setDraft("");
            setContext(undefined);
          }
        }
      })
      .catch((error: unknown) => {
        if (
          contextGeneration.current !== generation ||
          contextRef.current !== (replyContext ?? undefined)
        )
          return;
        setReplyError(
          error instanceof Error &&
            !isReservedProcessRecoveryCopy(error.message) &&
            error.message in en
            ? (error.message as TranslationKey)
            : isProcessReply(replyContext)
              ? "process_question_rejected"
              : "requestRejected",
        );
      });
  };
  const conversation = store?.conversations[conversationId];
  // Earlier sessions stay on the server; the chat shows only this session.
  // Once the server archives them, the boundary message is gone and every
  // remaining message is current.
  const allMessages = useMemo(
    () =>
      historySelection
        ? historyMessages.map(
            (message) =>
              (!historySelection.readOnly && online
                ? conversation?.messages.find((m) => m.id === message.id)
                : undefined) ?? message,
          )
        : (conversation?.messages ?? []),
    [conversation, historyMessages, historySelection, online],
  );
  const boundary = chatStart?.afterMessageId
    ? allMessages.findIndex((m) => m.id === chatStart.afterMessageId)
    : -1;
  const messages = historySelection
    ? allMessages
    : chatStart
      ? allMessages.slice(boundary + 1)
      : [];
  // A sound for what arrives while the chat is open; history loaded at start is silent.
  const heard = useRef<Map<string, string> | undefined>(undefined);
  useEffect(() => {
    const status = (m: (typeof allMessages)[number]) =>
      m.result?.type === "service.action" ? m.result.status : "message";
    if (historySilent.current || !heard.current) {
      historySilent.current = false;
      if (store)
        heard.current = new Map(allMessages.map((m) => [m.id, status(m)]));
      return;
    }
    let cue: "reply" | "done" | undefined;
    for (const m of allMessages) {
      if (m.role !== "assistant") continue;
      const now = status(m),
        before = heard.current.get(m.id);
      if (before === now) continue;
      heard.current.set(m.id, now);
      // An approved write that completed is the strongest confirmation.
      if (now === "succeeded" && before === "awaiting_approval") cue = "done";
      else if (before === undefined) cue ??= "reply";
    }
    if (cue) feedback(cue);
  }, [allMessages, store, historySelection]);
  const failure = state.error;
  useEffect(() => {
    if (failure) feedback("error");
  }, [failure]);
  const work = store
    ? section === "chat"
      ? selectConversationWork(store, conversationId).filter(
          (w) =>
            !!historySelection ||
            !chatStart?.earlierWork.has(w.id) ||
            openedWork.has(w.id),
        )
      : []
    : [];
  const openWork = useCallback(
    (id: string) => {
      closeVoice();
      const selected = state.store?.workItems[id];
      if (
        session &&
        selected?.native &&
        !selected.native.process &&
        ["waiting_input", "waiting_approval"].includes(selected.status)
      ) {
        const commandId = randomUUID();
        void session.send({
          type: "task.open",
          commandId,
          idempotencyKey: commandId,
          conversationId: selected.conversationId,
          workItemId: selected.id,
          expectedWorkRevision: selected.revision,
          language,
        });
      }
      if (selected) switchConversation(selected.conversationId);
      focusWork.current = id;
      // Work from an earlier session appears in chat only when opened here.
      setOpenedWork((current) => new Set(current).add(id));
      nearBottom.current = false;
      setSection("chat");
    },
    [
      closeVoice,
      setSection,
      session,
      state.store,
      language,
      switchConversation,
    ],
  );
  const locateWork = (id: string, y: number) => {
    if (focusWork.current !== id) return;
    requestAnimationFrame(() => {
      scroll.current?.scrollTo({ y: Math.max(0, y - 8), animated: false });
      focusWork.current = undefined;
    });
  };
  const renderWork = (w: WorkItem, ownerConversationId = conversationId) => {
    const input = store?.inputRequests[w.inputRequestIds[0] ?? ""];
    const replyInput = w.native?.question ?? input;
    const processQuestion = w.native?.process?.question;
    const proposal = store?.actionProposals[w.actionProposalIds[0] ?? ""];
    return (
      <MobileWorkItemCard
        key={w.id}
        session={session}
        conversationId={ownerConversationId}
        chatGeneration={chatGeneration}
        compact
        onExpand={() => {
          nearBottom.current = false;
        }}
        work={w}
        input={input}
        onNativeDecision={(approved) => {
          if (!session || !w.native?.action || w.native.process) return;
          const id = randomUUID();
          void session.send({
            type: "service.resolve",
            commandId: id,
            idempotencyKey: id,
            conversationId: w.conversationId,
            operationId: w.native.action.operationId,
            workItemId: w.id,
            expectedWorkRevision: w.revision,
            approved,
            language,
          });
        }}
        language={language}
        stale={!online || store?.stale || store?.needsSnapshot}
        blocked={busy}
        proposal={proposal}
        operations={w.operationIds.flatMap((id) =>
          store?.operations[id] ? [store.operations[id]] : [],
        )}
        approvalState={
          proposal
            ? (state.commandStates[proposal.approval?.operationId ?? ""] ??
              state.commandStates[proposal.id])
            : w.native?.action
              ? state.commandStates[w.native.action.operationId]
              : w.native?.process?.approval
                ? state.commandStates[
                    w.native.process.approval.result.operationId
                  ]
                : undefined
        }
        source={store?.connectionKey ?? ""}
        workspace={store?.scope.workspaceId}
        onReconcile={(operation) => {
          if (session) {
            void session.send(reconcileOperation(operation, randomUUID()));
          }
        }}
        onDecision={(decision, revision) => {
          if (session && proposal) {
            void session.send(
              proposalDecision(
                { ...proposal, revision },
                decision,
                randomUUID(),
              ),
            );
          }
        }}
        onRevise={(participantId, startsAt, revision) => {
          if (session && proposal) {
            void session.send(
              reviseProposal(
                { ...proposal, revision },
                participantId,
                startsAt,
                randomUUID(),
              ),
            );
          }
        }}
        formState={input ? state.commandStates[input.id] : undefined}
        onAnswerQuestion={
          w.native?.question?.options
            ? (answer) =>
                // An offered answer goes straight to the question; whatever
                // is in the composer stays there (-1 owns no draft).
                submitMessage(answer, { ...w.native!.question! }, -1)
            : undefined
        }
        onAnswer={(contact, revision) => {
          if (session && input) {
            void session.send(
              answerCommand({ ...input, revision }, contact, randomUUID()),
            );
          }
        }}
        onReply={
          processQuestion || replyInput
            ? () => {
                closeVoice();
                setProcessOpen(false);
                setSelectedProcessRunId(null);
                switchConversation(w.conversationId);
                try {
                  if (processQuestion) {
                    const current = session?.getSnapshot();
                    if (!current?.store || current.status !== "online")
                      throw new Error("process_question_changed");
                    setContext({
                      kind: "process",
                      target: captureProcessAnswerTarget(
                        current.store,
                        w.id,
                        w.conversationId,
                      ),
                    });
                  } else setContext({ ...replyInput! });
                } catch {
                  setReplyError("process_question_changed");
                  return;
                }
                setSection("chat");
                requestAnimationFrame(() => composerInput.current?.focus());
              }
            : undefined
        }
      />
    );
  };
  const summary = (w: NonNullable<typeof store>["workItems"][string]) => (
    <WorkItemSummary
      key={w.id}
      work={w}
      input={store?.inputRequests[w.inputRequestIds[0] ?? ""]}
      proposal={store?.actionProposals[w.actionProposalIds[0] ?? ""]}
      language={language}
      onOpen={openWork}
      openLabel={tr("openInChat")}
    />
  );
  const cards = work.map(
    section === "chat" ? (item) => renderWork(item) : summary,
  );
  const processAnnouncement = selectProcessCommandNotice(state, noticeOwner);
  const errorKey = chatErrorKey(
    replyError,
    processAnnouncement,
    state.error,
    isProcessReply(context),
  );
  const cardsById = new Map(work.map((w, i) => [w.id, cards[i]]));
  const referencedWork = store
    ? selectPresentedWork(store, conversationId, messages)
    : new Set<string>();
  const workMessageAnchors = store
    ? selectWorkMessageAnchors(store, conversationId, messages)
    : new Map<string, string>();
  /** An answer's text, then its generated UI; system cards follow it. */
  const answer = (m: (typeof messages)[number], text = true) => (
    <>
      {text && m.text ? (
        <View style={styles.answer}>
          <MarkdownText text={m.text} />
        </View>
      ) : null}
      {m.role === "assistant" && m.ui ? (
        <GenerativeUiView
          program={m.ui.program}
          language={language}
          disabled={!!historySelection?.readOnly}
          onFollowUp={(followUp) => {
            // A follow-up is a new message the person reviews and sends.
            setContext(undefined);
            setDraft(followUp);
            requestAnimationFrame(() => composerInput.current?.focus());
          }}
        />
      ) : null}
    </>
  );
  const reuseAttachmentMessage = (
    message: (typeof messages)[number],
    send: boolean,
  ) => {
    if (
      !session ||
      busy ||
      !online ||
      historySelection?.readOnly ||
      context ||
      attachments.state.entries.length ||
      !message.attachments?.length
    )
      return;
    setDraft(message.text);
    const ownerDraftRevision = draftRevision.current;
    const ownerGeneration = contextGeneration.current;
    void session.attachments
      .reuse({
        conversationId,
        messageId: message.id,
        files: message.attachments,
      })
      .then(() => {
        if (
          conversationRef.current !== conversationId ||
          sessionOwner.current !== session ||
          contextGeneration.current !== ownerGeneration ||
          draftRevision.current !== ownerDraftRevision
        )
          return;
        if (send) submitMessage(message.text, null);
        else {
          requestAnimationFrame(() => {
            if (
              conversationRef.current === conversationId &&
              sessionOwner.current === session &&
              contextGeneration.current === ownerGeneration &&
              draftRevision.current === ownerDraftRevision
            )
              composerInput.current?.focus();
          });
        }
      })
      .catch(() => {
        if (
          conversationRef.current === conversationId &&
          sessionOwner.current === session &&
          contextGeneration.current === ownerGeneration &&
          draftRevision.current === ownerDraftRevision
        ) {
          // Failed pins already show their error and recovery action in the tray.
          const represented = session.attachments
            .getSnapshot()
            .entries.some((entry) => entry.state === "failed" && !!entry.error);
          if (!represented) setReplyError("requestRejected");
        }
      });
  };
  const transcript = messages.map((m) => {
    if (
      heldReply &&
      m.role === "assistant" &&
      m.replyToCommandId === heldReply
    ) {
      if (m.workItemId) referencedWork.add(m.workItemId);
      if (m.result?.type === "service.action") {
        const operationId = m.result.operationId;
        for (const item of work)
          if (item.native?.action?.operationId === operationId)
            referencedWork.add(item.id);
      }
      return null;
    }
    if (m.role === "user")
      return (
        <View
          key={m.id}
          style={[
            styles.message,
            m.attachments?.length ? { width: "85%" } : null,
          ]}
        >
          {m.humanTask ? (
            <Row
              accessible
              accessibilityLabel={`${tr("humanTaskAttached")}: ${m.humanTask.title}`}
              style={{ gap: 6 }}
            >
              <Icon name="tasks" size={14} color={t.color.text.secondary} />
              <Text
                role="caption"
                tone="secondary"
                numberOfLines={1}
                style={{ flexShrink: 1 }}
              >
                {m.humanTask.title}
              </Text>
            </Row>
          ) : null}
          {m.text ? <Text selectable>{m.text}</Text> : null}
          {session && m.attachments?.length ? (
            <MobileMessageAttachments
              session={session}
              language={language}
              files={m.attachments}
              processing={m.processing}
              onEdit={
                !historySelection?.readOnly && !busy && online
                  ? () => reuseAttachmentMessage(m, false)
                  : undefined
              }
              onAgain={
                !historySelection?.readOnly && !busy && online
                  ? () => reuseAttachmentMessage(m, true)
                  : undefined
              }
            />
          ) : null}
        </View>
      );
    if (m.result?.type === "service.connection") {
      return (
        <AssistantMessage key={m.id}>
          {answer(m)}
          {session ? (
            <ServiceConnection
              key={`${session.identityKey}:${m.result.serviceId}:${m.id}`}
              session={session}
              result={m.result}
              language={language}
              disabled={busy || !online}
              online={online}
              onContinue={(text) => submitMessage(text, null)}
            />
          ) : null}
        </AssistantMessage>
      );
    }
    if (m.result?.type === "process.offer") {
      const offer = m.result;
      const index = messages.indexOf(m);
      const request = messages
        .slice(0, index)
        .reverse()
        .find((message) => message.role === "user");
      const current = messages.at(-1)?.id === m.id;
      return (
        <AssistantMessage key={m.id}>
          {answer(m)}
          <ProcessOfferCard
            offer={offer}
            language={language}
            disabled={
              busy || !online || !current || !!historySelection?.readOnly
            }
            onReview={() => openProcesses(offer)}
            onDecline={() =>
              request?.text &&
              submitMessage(request.text, null, undefined, {
                withoutProcess: true,
              })
            }
          />
        </AssistantMessage>
      );
    }
    // A process drafted in chat is reviewed and saved in the web app.
    if (m.result?.type === "process.proposal") {
      const web = session
        ? processProposalWebUrl(session.address, m.result)
        : null;
      return (
        <AssistantMessage key={m.id}>
          {answer(m)}
          <Text role="caption" tone="secondary">
            {`${tr("processProposalTitle")}: ${m.result.name}`}
          </Text>
          {web ? (
            <Button
              label={tr("processProposalOpenWeb")}
              variant="secondary"
              size="small"
              onPress={() => void Linking.openURL(web).catch(() => {})}
            />
          ) : null}
        </AssistantMessage>
      );
    }
    // A skill drafted in chat is saved in the web app; here it is only named.
    if (m.result?.type === "skill.proposal")
      return (
        <AssistantMessage key={m.id}>
          {answer(m)}
          <Text role="caption" tone="secondary">
            {`${tr("skillProposalTitle")}: ${m.result.name}. ${tr("skillProposalMobile")}`}
          </Text>
        </AssistantMessage>
      );
    // Answers no longer compose cards; a stored one reads as its text.
    if (m.result?.type === "card.document")
      return (
        <AssistantMessage key={m.id}>
          {answer(m)}
          <Text selectable>{cardDocumentText(m.result.document)}</Text>
        </AssistantMessage>
      );
    // Only a write waiting for the person's decision is a card; anything
    // else an action did, the answer tells in words, like any AI chat.
    if (
      m.result?.type === "service.action" &&
      m.result.status !== "awaiting_approval"
    )
      return m.text.trim() || m.ui ? (
        <AssistantMessage key={m.id}>{answer(m)}</AssistantMessage>
      ) : null;
    if (m.result?.type === "service.action") {
      const result = m.result;
      return (
        <AssistantMessage key={m.id}>
          {answer(m)}
          <ServiceActionCard
            result={result}
            language={language}
            disabled={busy || !online || !!historySelection?.readOnly}
            onDecide={(approved) => {
              if (!session || !conversation) return;
              const id = randomUUID();
              void session.send({
                type: "service.resolve",
                commandId: id,
                idempotencyKey: id,
                conversationId: conversation.id,
                operationId: result.operationId,
                approved,
                language,
              });
            }}
          />
        </AssistantMessage>
      );
    }
    if (m.result?.type === "crm.contacts")
      return (
        <AssistantMessage key={m.id}>
          {answer(m, false)}
          <CrmContactResults result={m.result} language={language} />
        </AssistantMessage>
      );
    if (
      m.workItemId &&
      cardsById.has(m.workItemId) &&
      workMessageAnchors.get(m.workItemId) === m.id
    ) {
      referencedWork.add(m.workItemId);
      const anchored = work.find((w) => w.id === m.workItemId);
      // A finished action needs no card: the answer says what happened.
      if (
        anchored?.native?.action &&
        !anchored.native.process &&
        isTerminalNativeWork(anchored)
      )
        return m.text.trim() || m.ui ? (
          <AssistantMessage key={m.id}>{answer(m)}</AssistantMessage>
        ) : null;
      return (
        <View
          key={m.id}
          onLayout={(e) => locateWork(m.workItemId!, e.nativeEvent.layout.y)}
        >
          <AssistantMessage>
            {answer(m, false)}
            {cardsById.get(m.workItemId)}
          </AssistantMessage>
        </View>
      );
    }
    return <AssistantMessage key={m.id}>{answer(m)}</AssistantMessage>;
  });
  const hasConversation = messages.length > 0 || work.length > 0;
  const pendingMessage = selectPendingChatMessage(state, conversationId);
  let validContext = false;
  if (isProcessReply(context)) {
    try {
      if (store) {
        assertProcessAnswerTarget(store, context.target);
        validContext = true;
      }
    } catch {
      /* Keep the original question visible until explicitly cleared. */
    }
  } else if (context) {
    const current = selectReplyInput(store, context);
    validContext =
      current?.status === "open" && current.revision === context.revision;
  }
  const waitingForProcessAnswer =
    isProcessReply(context) &&
    answerCaption?.context === context &&
    state.commandStates[answerCaption.target] === "accepted" &&
    !state.error &&
    !recordedProcessAnswer(state.store, context, answerCaption.command);
  const openVoice = () => {
    if (historySelection?.readOnly) return;
    if (!online || !session) {
      changeSection("more");
      return;
    }
    if (voiceAvailability !== "available") {
      Keyboard.dismiss();
      setVoiceSettingsOwner(session);
      return;
    }
    // Talking is the first message: transcription already names this chat.
    if (conversationRef.current === unsavedChatRef.current) {
      const requestedConversation = conversationRef.current;
      const requestedVoiceGeneration = voiceGeneration.current;
      const requestedContextGeneration = contextGeneration.current;
      const requestedContext = contextRef.current;
      const ownsRequest = () =>
        sessionOwner.current === session &&
        conversationRef.current === requestedConversation &&
        voiceGeneration.current === requestedVoiceGeneration &&
        contextGeneration.current === requestedContextGeneration &&
        contextRef.current === requestedContext &&
        AppState.currentState === "active";
      void saveChat(requestedConversation)
        .then((current) => {
          if (current && ownsRequest()) openVoice();
        })
        .catch(() => {
          if (ownsRequest()) setReplyError("requestRejected");
        });
      return;
    }
    // Recording is a local draft; only submission waits for the current command.
    if (
      voiceRef.current ||
      state.answerRecoveryBlocked ||
      (context && !validContext)
    )
      return;
    speech.player.stop();
    Keyboard.dismiss();
    setSection("chat");
    nearBottom.current = true;
    const generation = contextGeneration.current;
    const owner = ++voiceGeneration.current;
    const voiceTask =
      !context && attachedTask?.conversationId === conversationId
        ? attachedTask.task
        : undefined;
    const next: VoiceDraft = createVoiceReply(
      session,
      context,
      language,
      (text, answered, delivery, commandId) => {
        if (voiceRef.current !== next || voiceGeneration.current !== owner)
          return;
        const native = isProcessReply(answered);
        const pending = session.getSnapshot().pending;
        if (!pending || pending.commandId !== commandId) return;
        const target = commandTarget(pending);
        const speak =
          speechOptions.current.automatic && speechOptions.current.enabled
            ? speech.player.waitForReply(commandId, language, randomUUID())
            : undefined;
        const release = () =>
          setHeldReply((current) =>
            current === commandId ? undefined : current,
          );
        if (speak) {
          releaseHeldReply.current?.();
          setHeldReply(commandId);
          releaseHeldReply.current = native
            ? release
            : followSpokenReply(
                session,
                commandId,
                target,
                (conversation) =>
                  AppState.currentState === "active"
                    ? speak(conversation)
                    : Promise.resolve(),
                release,
                pending.conversationId,
              );
        }
        if (native) {
          setDraft(text);
          setAnswerCaption({
            context: contextRef.current!,
            target,
            text,
            command: pending,
          });
          nativeSubmission.current = {
            commandId,
            target,
            text,
            context: contextRef.current!,
            generation,
            draftRevision: draftRevision.current,
            command: pending,
          };
        } else if (
          answered &&
          contextRef.current &&
          !isProcessReply(contextRef.current) &&
          contextRef.current.id === answered.id &&
          contextRef.current.revision === answered.revision
        )
          setContext(undefined);
        const deliveryGeneration = contextGeneration.current;
        closeVoice();
        void delivery
          .then(() => {
            if (
              contextGeneration.current !== deliveryGeneration ||
              (native &&
                (generation !== deliveryGeneration ||
                  !isProcessReply(contextRef.current) ||
                  contextRef.current.target !== answered.target))
            ) {
              release();
              return;
            }
            const current = session.getSnapshot();
            const recorded = session
              .getSnapshot()
              .store?.conversations[
                pending.conversationId
              ]?.messages.some((message) => message.role === "user" && message.id.startsWith(`message-${commandId}-`));
            if (
              native
                ? !recordedProcessAnswer(current.store, answered, pending)
                : current.commandStates[target] !== "accepted" && !recorded
            ) {
              release();
              if (nativeSubmission.current?.commandId === commandId)
                nativeSubmission.current.deliveryFailed = true;
              if (!native) setDraft((current) => current || text);
            } else {
              if (voiceTask)
                setAttachedTask((attached) =>
                  attached?.conversationId === pending.conversationId &&
                  attached.task.id === voiceTask.id
                    ? undefined
                    : attached,
                );
              if (native) {
                if (
                  draftRevision.current ===
                  nativeSubmission.current?.draftRevision
                ) {
                  setDraft("");
                  setContext(undefined);
                }
                if (speak && AppState.currentState === "active")
                  void speak(
                    current.store?.conversations[pending.conversationId],
                  )
                    .catch(() => {})
                    .finally(release);
                else release();
              } else if (!speak) release();
            }
          })
          .catch((error: unknown) => {
            release();
            if (contextGeneration.current !== deliveryGeneration) return;
            setReplyError(
              error instanceof Error &&
                !isReservedProcessRecoveryCopy(error.message) &&
                error.message in en
                ? (error.message as TranslationKey)
                : native
                  ? "process_question_rejected"
                  : "voice_send_failed",
            );
          });
      },
      () =>
        voiceRef.current === next &&
        voiceGeneration.current === owner &&
        contextGeneration.current === generation,
      conversationId,
      noticeOwner,
      continueConversation,
      voiceTask,
    );
    voiceRef.current = next;
    setVoice(next);
    void next.start();
  };
  const changeSection = (next: Section) => {
    speech.player.stop();
    focusWork.current = undefined;
    closeVoice();
    setMeetingId(null);
    setContextMenu(false);
    setSection(next);
  };
  const openMeetingRecovery = () => {
    setHistoryOpen(false);
    setProcessOpen(false);
    changeSection("meetings");
  };
  const openProcesses = (offer: ProcessOfferResult | null = null) => {
    closeVoice();
    speech.player.stop();
    setSelectedProcessRunId(null);
    setProcessDesignerOpen(false);
    setProcessOffer(offer);
    setProcessOpen(true);
  };
  const processesLabel = tr(
    state.pending?.type === "process.start"
      ? "processesOpenSaved"
      : "processesTitle",
  );
  const openMenu = () => {
    closeVoice();
    speech.player.stop();
    Keyboard.dismiss();
    setHistoryOpen(true);
  };
  const startNewChat = () => {
    closeVoice();
    speech.player.stop();
    Keyboard.dismiss();
    void createConversation().catch(() => setReplyError("requestRejected"));
  };
  /** Talks an open item through with the assistant in a fresh chat. */
  const resolveTask = (task: HumanTask) => {
    if (!session || !online || busy) return;
    closeVoice();
    speech.player.stop();
    void createConversation()
      .then(() => {
        setAttachedTask({
          conversationId: conversationRef.current,
          task: { id: task.id, title: task.title },
        });
        nearBottom.current = true;
        setSection("chat");
      })
      .catch(() => setReplyError("requestRejected"));
  };
  const statusLine =
    session && !online ? (
      <StatusLine
        label={tr(state.status === "online" ? "connected" : state.status)}
      />
    ) : null;
  const meetings = store
    ? Object.values(store.workItems).filter((w) =>
        w.operationIds.some(
          (id) =>
            store.operations[id]?.status === "succeeded" &&
            store.operations[id]?.result?.kind === "calendar",
        ),
      )
    : [];
  const processRuns = store
    ? selectRecentProcessRuns(Object.values(store.workItems))
    : [];
  const selectedProcessRun = processRuns.find(
    (work) => work.id === selectedProcessRunId,
  );
  return (
    <View style={styles.flex}>
      <View
        style={[
          styles.flex,
          // Settings is a grouped screen: white groups on a light grey canvas.
          section === "more" && { backgroundColor: t.color.grouped },
        ]}
        accessibilityElementsHidden={processOpen || historyOpen}
        importantForAccessibility={
          processOpen || historyOpen ? "no-hide-descendants" : "auto"
        }
        // The web reads only aria-hidden; the menu and Processes cover this.
        aria-hidden={processOpen || historyOpen}
      >
        <View testID="screen-header">
          {/* Before pairing, the introduction stands alone. */}
          {section === "chat" && !session ? null : section === "chat" ? (
            <TopBar
              leading={
                <IconButton
                  icon="menu"
                  label={tr("menu")}
                  badge={count > 0}
                  onPress={openMenu}
                />
              }
              title={
                conversationTitle(historySelection?.title ?? "") || "Niaro"
              }
              subtitle={statusLine}
              emblem={
                hasConversation && !voice ? (
                  <PetView
                    occupied={petOccupied}
                    visible={
                      !historyOpen &&
                      !processOpen &&
                      !processDesignerOpen &&
                      !contextMenu &&
                      !voiceSettingsOpen &&
                      !mentions.sheet
                    }
                    size={44}
                    state={
                      speech.state.phase === "playing"
                        ? "speaking"
                        : busy
                          ? "working"
                          : "idle"
                    }
                    label={companionCopy(language).pet}
                  />
                ) : undefined
              }
              trailing={
                session ? (
                  <IconButton
                    icon="compose"
                    label={tr("newChat")}
                    disabled={!online || busy || conversationId === unsavedChat}
                    onPress={startNewChat}
                  />
                ) : null
              }
            />
          ) : (
            <TopBar
              // Tabs are peers; only an open meeting record has a way back.
              leading={
                meetingOpen || section === "meetings" || section === "more" ? (
                  <IconButton
                    icon="back"
                    label={tr("back")}
                    onPress={() =>
                      meetingOpen
                        ? setMeetingId(null)
                        : changeSection("library")
                    }
                  />
                ) : undefined
              }
              title={
                section === "library"
                  ? companionCopy(language).library
                  : section === "tasks"
                    ? companionCopy(language).work
                    : tr(section === "more" ? "settingsTitle" : section)
              }
              subtitle={statusLine}
              trailing={
                session && section === "tasks" ? (
                  <IconButton
                    icon="refresh"
                    label={tr("refresh")}
                    onPress={() => {
                      setHumanTaskRefresh((version) => version + 1);
                      void session.refresh();
                    }}
                  />
                ) : session && section === "meetings" && !meetingOpen ? (
                  <IconButton
                    icon="refresh"
                    label={tr("refresh")}
                    onPress={() => setMeetingRefresh((version) => version + 1)}
                  />
                ) : null
              }
            />
          )}
          {section === "tasks" ? (
            <TaskTabs
              tab={tab}
              onChange={setTab}
              language={language}
              count={count}
            />
          ) : null}
        </View>
        <Entrance style={styles.flex} testID="screen-transition">
          <ScrollView
            testID="screen-scroll"
            ref={scroll}
            onLayout={(event) =>
              homePetVisibility.onViewport(event.nativeEvent.layout.height)
            }
            style={styles.flex}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === "web" ? "none" : "on-drag"}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.content}
            onScrollBeginDrag={() => {
              dragging.current = true;
            }}
            onScrollEndDrag={() => {
              dragging.current = false;
            }}
            onScroll={(event) => {
              const { layoutMeasurement, contentOffset, contentSize } =
                event.nativeEvent;
              homePetVisibility.onScroll(
                contentOffset.y,
                layoutMeasurement.height,
              );
              const atEnd =
                contentSize.height -
                  layoutMeasurement.height -
                  contentOffset.y <
                100;
              // Returning to the end resumes following; only a drag may stop it.
              if (atEnd || dragging.current) nearBottom.current = atEnd;
            }}
            scrollEventThrottle={100}
            onContentSizeChange={() => {
              if (
                section === "chat" &&
                (hasConversation || busy) &&
                nearBottom.current
              )
                // After layout settles: cards measure themselves a frame later.
                requestAnimationFrame(() =>
                  scroll.current?.scrollToEnd({ animated: true }),
                );
            }}
          >
            {processAnnouncement.notice &&
            section !== "chat" &&
            section !== "more" ? (
              <ProcessCommandNoticeView
                language={language}
                notice={processAnnouncement.notice}
              />
            ) : null}
            {errorKey && section !== "chat" ? (
              errorKey === "connection_failed" && state.connectionDiagnostic ? (
                <ConnectionFailureNotice
                  language={language}
                  diagnostic={state.connectionDiagnostic}
                />
              ) : (
                <Notice error>{tr(errorKey)}</Notice>
              )
            ) : null}
            {state.answerRecoveryBlocked && section !== "more" ? (
              <Stack>
                <Notice error>{tr("savedProcessAnswerStorageBlocked")}</Notice>
                <Button
                  label={tr("refresh")}
                  onPress={() => {
                    void session?.refresh();
                  }}
                />
              </Stack>
            ) : null}
            {authError === "auth_expired" && section !== "more" ? (
              <ActionToast
                message={tr("sessionExpiredShort")}
                description={tr(authError)}
                actionLabel={tr("signIn")}
                onAction={() => changeSection("more")}
              />
            ) : authError && section !== "more" ? (
              <Stack>
                <Notice error>{tr(authError)}</Notice>
                <Button
                  label={tr("signIn")}
                  onPress={() => changeSection("more")}
                />
              </Stack>
            ) : null}
            {section === "chat" && historySelection ? (
              <Stack>
                {historyError ? (
                  <Notice error>{tr("chatHistoryLoadFailed")}</Notice>
                ) : null}
                {historyLoading ? (
                  <Text role="caption">{tr("loading")}</Text>
                ) : null}
                {historyAfter ? (
                  <Button
                    variant="secondary"
                    label={tr("earlierChatMessages")}
                    disabled={historyLoading || !online}
                    onPress={() => {
                      nearBottom.current = false;
                      void readHistory(historySelection, true);
                    }}
                  />
                ) : null}
              </Stack>
            ) : null}
            {session && (section === "chat" || section === "tasks") ? (
              <ProcessApprovalRecovery
                session={session}
                language={language}
                conversationId={conversationId}
                chatGeneration={chatGeneration}
              />
            ) : null}
            {state.pending &&
            state.pending.type !== "process.start" &&
            !(
              state.pending.type === "service.resolve" &&
              "profile" in state.pending
            ) &&
            !(state.answerAttempts ?? []).some(
              (attempt) =>
                attempt.command.commandId === state.pending?.commandId,
            ) &&
            !(section === "chat" && state.pending.type === "message.send") &&
            canRetryPending(state) ? (
              <Button
                label={tr("retry")}
                disabled={!online}
                onPress={() => {
                  void session?.retry(noticeOwner);
                }}
              />
            ) : null}
            {section === "chat" || section === "tasks"
              ? (state.answerAttempts ?? []).map((attempt) => {
                  let canReview = false;
                  if (
                    online &&
                    store &&
                    !busy &&
                    attempt.outcome !== "unknown"
                  ) {
                    try {
                      assertProcessAnswerTarget(store, attempt.target);
                      canReview = true;
                    } catch {
                      // A retained answer cannot silently move to a later question.
                    }
                  }
                  const canRetry =
                    !state.answerRecoveryBlocked &&
                    online &&
                    state.pending?.commandId === attempt.command.commandId &&
                    state.commandStates[commandTarget(attempt.command)] !==
                      "sending";
                  return (
                    <ProcessAnswerRecoveryCard
                      key={attempt.command.commandId}
                      language={language}
                      question={attempt.target.question.question}
                      answer={attempt.command.answer}
                      outcome={attempt.outcome}
                      explanation={
                        state.processNotice?.notice.commandId ===
                        attempt.command.commandId
                          ? (() => {
                              if (
                                state.processNotice.errorSource.kind === "local"
                              )
                                return tr(state.processNotice.errorSource.code);
                              const copy = processNoticeCopy(
                                state.processNotice.notice,
                              );
                              return copy
                                ? tr(copy.key) +
                                    (copy.detailKey
                                      ? ` ${tr(copy.detailKey)}`
                                      : "")
                                : undefined;
                            })()
                          : attempt.outcome === "accepted"
                            ? tr("processResultUnavailable")
                            : attempt.error
                              ? tr(
                                  !isReservedProcessRecoveryCopy(
                                    attempt.error,
                                  ) && attempt.error in en
                                    ? (attempt.error as TranslationKey)
                                    : "process_question_rejected",
                                )
                              : undefined
                      }
                      canReview={canReview}
                      canRetry={canRetry}
                      canDiscard={!state.answerRecoveryBlocked}
                      onRetry={() => {
                        void session?.retry(noticeOwner);
                      }}
                      onReview={() => {
                        const current = session?.getSnapshot();
                        if (
                          !current?.store ||
                          current.answerRecoveryBlocked ||
                          current.status !== "online" ||
                          current.pending
                        )
                          return;
                        try {
                          assertProcessAnswerTarget(
                            current.store,
                            attempt.target,
                          );
                        } catch {
                          setReplyError("process_question_changed");
                          return;
                        }
                        closeVoice();
                        switchConversation(attempt.target.conversationId);
                        setContext(
                          Object.freeze({
                            kind: "process",
                            target: attempt.target,
                          }),
                        );
                        setDraft(attempt.command.answer);
                        setSection("chat");
                        composerInput.current?.focus();
                      }}
                      onDiscard={() => {
                        void session?.discardProcessAnswerAttempt(
                          attempt.command.commandId,
                        );
                      }}
                    />
                  );
                })
              : null}
            {session ? (
              <MeetingLibrary
                key={`meeting/${session.identityKey}`}
                session={session}
                language={language}
                visible={section === "meetings"}
                selectedId={meetingId}
                onSelect={setMeetingId}
                conversationId={conversationId}
                chatGeneration={chatGeneration}
                scheduled={
                  section === "meetings" && meetings.length
                    ? meetings.map(summary)
                    : null
                }
                refreshVersion={meetingRefresh}
                onRecording={setMeetingRecording}
                onRecordingControls={setMeetingRecordingControl}
                onStartRecording={() => {
                  return session.getSnapshot().pending
                    ? session.interruptPending()
                    : true;
                }}
                onTasks={() => {
                  setTab("open");
                  changeSection("tasks");
                }}
              />
            ) : null}
            {session ? (
              <HumanTaskLibrary
                key={`human-tasks/${session.identityKey}`}
                session={session}
                language={language}
                visible={section === "tasks"}
                tab={tab}
                refreshVersion={humanTaskRefresh}
                leading={[]}
                onCounts={updateHumanTaskCounts}
                resolveDisabled={busy || !!historySelection?.readOnly}
                onResolve={resolveTask}
                onOpenMeeting={(id) => {
                  changeSection("meetings");
                  setMeetingId(id);
                }}
              />
            ) : null}
            <Entrance
              key={section}
              style={[
                styles.section,
                section === "chat" &&
                  !hasConversation &&
                  !busy && { flexGrow: 1 },
              ]}
            >
              {section === "library" ? (
                <CompanionLibrary
                  language={language}
                  connected={!!session}
                  onMeetings={() => changeSection("meetings")}
                  onHistory={openMenu}
                  onProcesses={() => openProcesses()}
                  onSettings={() => changeSection("more")}
                />
              ) : section === "more" ? (
                <>
                  {settings}
                  {session ? (
                    <ArchivedChatsSection
                      session={session}
                      language={language}
                      online={online}
                      onOpen={openHistoryConversation}
                    />
                  ) : null}
                </>
              ) : section === "meetings" ? (
                <>
                  {!session ? (
                    <EmptyState
                      icon="calendar"
                      title={tr("connectFirst")}
                      hint={tr("meetingsListHint")}
                    />
                  ) : null}
                </>
              ) : section === "tasks" ? (
                <>
                  {!session ? (
                    <EmptyState icon="tasks" title={tr("connectFirst")} />
                  ) : null}
                  {!session ? (
                    <Button
                      label={tr("connect")}
                      onPress={() => changeSection("more")}
                    />
                  ) : null}
                </>
              ) : !hasConversation && !busy ? (
                <Home
                  language={language}
                  paired={!!session}
                  connected={online}
                  busy={busy}
                  count={count}
                  voice={voiceAvailability}
                  voiceBusy={!!voice}
                  petState={
                    speech.state.phase === "playing"
                      ? "speaking"
                      : meetingRecording
                        ? "listening"
                        : "idle"
                  }
                  compact={keyboardOpen}
                  petOccupied={petOccupied}
                  petVisible={
                    homePetVisibility.visible &&
                    !historyOpen &&
                    !processOpen &&
                    !processDesignerOpen &&
                    !contextMenu &&
                    !voiceSettingsOpen &&
                    !mentions.sheet
                  }
                  onPetBounds={homePetVisibility.onBounds}
                  level={voiceLevel}
                  meetingRecording={meetingRecording}
                  onTalk={openVoice}
                  onMeeting={() => startRequest(true)}
                  // Recording needs the native app; on web the shortcut would dead-end.
                  onRecord={
                    session && Platform.OS !== "web"
                      ? () => changeSection("meetings")
                      : undefined
                  }
                  onTasks={() => changeSection("tasks")}
                  onProcesses={session ? () => openProcesses() : undefined}
                  onConnect={() => changeSection("more")}
                />
              ) : (
                <>
                  {transcript}
                  {pendingMessage ? (
                    <View testID="pending-message" style={styles.message}>
                      {pendingMessage.kind === "answer" ? (
                        <Text role="caption" tone="secondary">
                          {tr("process_question_pending")}
                        </Text>
                      ) : null}
                      <Text selectable>{pendingMessage.text}</Text>
                    </View>
                  ) : null}
                  {work
                    .filter(
                      (w) =>
                        !referencedWork.has(w.id) &&
                        (!!w.native?.process ||
                          !isTerminalNativeWork(w) ||
                          openedWork.has(w.id)),
                    )
                    .map((w) => (
                      <View
                        key={w.id}
                        onLayout={(e) =>
                          locateWork(w.id, e.nativeEvent.layout.y)
                        }
                      >
                        <AssistantMessage>{renderWork(w)}</AssistantMessage>
                      </View>
                    ))}
                  {heldReply && !state.pending ? (
                    <AssistantMessage key={`voice-${heldReply}`}>
                      <RequestProgressCard
                        language={language}
                        activity={state.activity}
                        voice
                      />
                    </AssistantMessage>
                  ) : null}
                  {state.pending?.type === "message.send" &&
                  state.pending.conversationId === conversationId ? (
                    <AssistantMessage
                      key={`activity-${state.pending.commandId}`}
                    >
                      <RequestProgressCard
                        language={language}
                        activity={state.activity}
                        connection={state.activityConnection}
                        failed={!!state.error?.startsWith("model_")}
                        interruptAvailable={!!state.pending}
                        onInterrupt={() => {
                          void session?.interruptPending();
                        }}
                        interruptLabel={
                          state.error === "requestInterruptFailed"
                            ? tr("progressInterruptRetry")
                            : tr("progressInterrupt")
                        }
                        interruptDisabled={!online}
                        onRetry={
                          canRetryPending(state)
                            ? () => {
                                void session?.retry(noticeOwner);
                              }
                            : undefined
                        }
                        retryDisabled={!online}
                        interrupted={
                          !online ||
                          Object.values(state.commandStates).includes(
                            "network_error",
                          )
                        }
                      />
                      {state.activity?.draft ? (
                        <AnswerDraft
                          draft={state.activity.draft}
                          language={language}
                        />
                      ) : null}
                    </AssistantMessage>
                  ) : null}
                </>
              )}
            </Entrance>
          </ScrollView>
        </Entrance>
        {/* Without a server there is nobody to write to; the intro offers Connect. */}
        {section === "chat" && session ? (
          <View testID="screen-footer" style={styles.footer}>
            <FadeEdge />
            {processAnnouncement.notice ? (
              <ProcessCommandNoticeView
                language={language}
                notice={processAnnouncement.notice}
              />
            ) : null}
            {errorKey ? (
              <View style={{ gap: t.spacing.sm }}>
                {errorKey === "connection_failed" &&
                state.connectionDiagnostic ? (
                  <ConnectionFailureNotice
                    language={language}
                    diagnostic={state.connectionDiagnostic}
                  />
                ) : (
                  <Notice error>{tr(errorKey)}</Notice>
                )}
              </View>
            ) : null}
            {speech.state.phase === "playing" ? (
              <Row style={{ justifyContent: "space-between" }}>
                <Text role="caption" tone="secondary">
                  {companionCopy(language).speaking}
                </Text>
                <IconButton
                  icon="stop"
                  label={companionCopy(language).stopSpeech}
                  onPress={speech.player.stop}
                />
              </Row>
            ) : null}
            {speech.state.phase === "error" ? (
              <ActionToast
                message={tr("spoken_replies_failed")}
                description={tr(
                  speech.state.error === "speech_privacy_unavailable"
                    ? "speech_privacy_unavailable"
                    : "spoken_replies_failed",
                )}
                actionLabel={tr("close")}
                onAction={speech.player.stop}
              />
            ) : null}
            {context ? (
              <View style={styles.reply}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text role="caption" tone="secondary">
                    {tr(
                      waitingForProcessAnswer
                        ? "process_question_pending"
                        : validContext
                          ? "replyTo"
                          : "inputContextChanged",
                    )}
                  </Text>
                  <Text role="caption" numberOfLines={2}>
                    {isProcessReply(context)
                      ? context.target.question.question
                      : context.question}
                  </Text>
                </View>
                <IconButton
                  icon="close"
                  label={tr("clearContext")}
                  onPress={() => {
                    closeVoice();
                    if (isProcessReply(context)) setDraft("");
                    setContext(undefined);
                  }}
                />
              </View>
            ) : attachedTask?.conversationId === conversationId ? (
              <View testID="composer-task" style={styles.reply}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text role="caption" tone="secondary">
                    {tr("humanTaskAttached")}
                  </Text>
                  <Text role="caption" numberOfLines={2}>
                    {attachedTask.task.title}
                  </Text>
                </View>
                <IconButton
                  icon="close"
                  label={tr("humanTaskDetach")}
                  onPress={() => setAttachedTask(undefined)}
                />
              </View>
            ) : null}
            {voice && online && (!context || validContext) ? (
              <VoiceReply
                draft={voice}
                language={language}
                blocked={busy}
                onClose={closeVoice}
                level={voiceLevel}
              />
            ) : historySelection?.readOnly ? (
              <ReadOnlyComposer
                language={language}
                onNewChat={online && !busy ? startNewChat : undefined}
                onRestore={
                  online && !busy && !restoring ? restoreOpenChat : undefined
                }
                error={restoreError}
              />
            ) : (
              <View>
                <MobileAttachmentDraft value={attachments} />
                <MobileMentionSuggestions
                  items={mentions.items}
                  language={language}
                  onPick={mentions.pick}
                />
                <Composer
                  inputRef={composerInput}
                  language={language}
                  value={draft}
                  onChange={mentions.type}
                  onSelectionChange={mentions.select}
                  selection={mentions.selection}
                  onFocus={() => setOwnedComposerFocus(true)}
                  onBlur={() => {
                    setOwnedComposerFocus(false);
                    mentions.blur();
                  }}
                  references={
                    <MobileMentionTray
                      selected={mentions.selected}
                      language={language}
                    />
                  }
                  hasAttachments={attachments.state.entries.length > 0}
                  sendBlocked={
                    attachments.state.entries.length > 0 && !attachments.ready
                  }
                  onSend={() => submitMessage()}
                  onVoice={openVoice}
                  onAttach={() => {
                    Keyboard.dismiss();
                    setContextMenu(true);
                  }}
                  disabled={
                    !online ||
                    busy ||
                    !!historySelection?.readOnly ||
                    historyLoading ||
                    (!!context && !validContext)
                  }
                  sending={Object.values(state.commandStates).includes(
                    "sending",
                  )}
                  voice={
                    meetingRecording || attachments.state.entries.length > 0
                      ? "disabled"
                      : voiceAvailability === "available"
                        ? "ready"
                        : "settings"
                  }
                />
              </View>
            )}
          </View>
        ) : null}
        {/* While typing, the keyboard needs the room more than the tabs do. */}
        {keyboardOpen ||
        voice ||
        (section === "chat" && hasConversation) ? null : (
          <Navigation
            section={section}
            onChange={changeSection}
            language={language}
            count={count}
          />
        )}
      </View>
      {mentions.sheet ? (
        <MobileMentionSheet
          items={mentions.directory}
          language={language}
          onPick={mentions.pick}
          onClose={mentions.close}
        />
      ) : null}
      {voiceSettingsOpen && session ? (
        <DetailSheet
          title={tr("voiceSettings")}
          language={language}
          onClose={() => setVoiceSettingsOwner(null)}
        >
          <VoiceServiceCard
            language={language}
            capabilities={
              voiceSupport?.session === session
                ? voiceSupport.capabilities
                : undefined
            }
          />
        </DetailSheet>
      ) : null}
      {contextMenu ? (
        <DetailSheet
          title={companionCopy(language).context}
          language={language}
          onClose={() => setContextMenu(false)}
        >
          <AttachmentPicker
            language={language}
            references={
              mentions.available
                ? {
                    onPress: () => {
                      setContextMenu(false);
                      mentions.open();
                    },
                  }
                : undefined
            }
            choices={{
              task: {
                onPress: () => {
                  setContextMenu(false);
                  changeSection("tasks");
                },
              },
              ...(attachments.available && !context && !busy && online
                ? Object.fromEntries(
                    (["camera", "photos", "file"] as const).map((kind) => [
                      kind,
                      {
                        onPress: () => {
                          setContextMenu(false);
                          attachments.choose(kind);
                        },
                        disabled:
                          attachments.state.busy || attachments.selection.busy,
                      },
                    ]),
                  )
                : {}),
            }}
          />
        </DetailSheet>
      ) : null}
      <MobileAttachmentPreview value={attachments} />
      <ChatHistory
        session={session}
        language={language}
        open={historyOpen}
        selectedId={conversationId}
        busy={busy}
        online={online}
        recordingControls={
          meetingRecordingControl &&
          meetingRecordingControl.owner === session?.identityKey ? (
            <MeetingRecordingControls
              control={meetingRecordingControl}
              language={language}
              withPause
              onOpenMeetings={openMeetingRecovery}
            />
          ) : null
        }
        onClose={() => setHistoryOpen(false)}
        onSelect={openHistoryConversation}
        onNew={createConversation}
        onDeleted={(id) => {
          // The open chat is gone: back to the main chat, freshly read.
          if (id !== conversationRef.current) return;
          switchConversation("conversation-1");
          void session?.refresh();
        }}
        onNavigate={(target) => {
          setHistoryOpen(false);
          if (target === "search") setSearchOpen(true);
          else if (target === "tasks" || target === "library")
            changeSection(target);
          else openProcesses();
        }}
        processesLabel={processesLabel}
        processesDisabled={false}
      />
      {session && searchOpen ? (
        <ChatSearchScreen
          session={session}
          language={language}
          online={online}
          onClose={() => setSearchOpen(false)}
          onOpen={(conversation) => {
            setSearchOpen(false);
            openHistoryConversation(conversation);
          }}
        />
      ) : null}
      {session ? (
        <View
          testID="process-launch-panel"
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: t.color.background,
              display: processOpen ? "flex" : "none",
            },
          ]}
          accessibilityViewIsModal={processOpen}
          accessibilityElementsHidden={!processOpen}
          importantForAccessibility={
            processOpen ? "auto" : "no-hide-descendants"
          }
        >
          {selectedProcessRun || processDesignerOpen ? (
            <TopBar
              leading={
                <IconButton
                  icon="back"
                  label={tr("back")}
                  onPress={() => {
                    if (processDesignerOpen) setProcessDesignerOpen(false);
                    else setSelectedProcessRunId(null);
                  }}
                />
              }
              title={
                processDesignerOpen
                  ? tr("processDesignTitle")
                  : (selectedProcessRun?.title ?? tr("processesTitle"))
              }
            />
          ) : (
            // The list root: a large title, closed from the top right.
            <TopBar
              large
              title={tr("processesTitle")}
              trailing={
                <IconButton
                  icon="close"
                  label={tr("close")}
                  onPress={() => {
                    setSelectedProcessRunId(null);
                    setProcessOpen(false);
                  }}
                />
              }
            />
          )}
          {meetingRecordingControl &&
          meetingRecordingControl.owner === session.identityKey ? (
            <View
              style={{
                paddingHorizontal: t.spacing.lg,
                paddingBottom: t.spacing.md,
              }}
            >
              <MeetingRecordingControls
                control={meetingRecordingControl}
                language={language}
                withPause
                onOpenMeetings={openMeetingRecovery}
              />
            </View>
          ) : null}
          {processDesignerOpen ? (
            <ProcessDesign
              key={`${session.identityKey}:${processDesignerServiceId ?? "workspace"}`}
              session={session}
              language={language}
              serviceId={processDesignerServiceId}
              onServiceChange={setProcessDesignerServiceId}
            />
          ) : (
            <ScrollView
              style={styles.flex}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.content}
            >
              {selectedProcessRun ? (
                <View testID="process-run-history-detail">
                  {renderWork(
                    selectedProcessRun,
                    selectedProcessRun.conversationId,
                  )}
                </View>
              ) : (
                <View style={{ gap: t.spacing.section }}>
                  {historySelection?.readOnly ? null : (
                    <Group>
                      <ListRow
                        leading={<IconTile icon="sparkle" size={38} />}
                        label={tr("processDesignOpen")}
                        description={tr("processDesignIntro")}
                        onPress={() => setProcessDesignerOpen(true)}
                        testID="open-process-designer"
                      />
                    </Group>
                  )}
                  {historySelection?.readOnly ? null : (
                    <ProcessLaunch
                      session={session}
                      language={language}
                      conversationId={conversationId}
                      chatGeneration={chatGeneration}
                      offer={(processOpen && processOffer) || undefined}
                      showTitle={false}
                      onDone={() => setProcessOpen(false)}
                    />
                  )}
                  {/* Recent runs only once there are any. */}
                  {processRuns.length ? (
                    <Group title={tr("processRunHistory")}>
                      {processRuns.map((work) => (
                        <ListRow
                          key={work.id}
                          icon="bolt"
                          label={work.title}
                          description={tr(work.status as TranslationKey)}
                          accessibilityLabel={`${work.title}, ${tr(work.status as TranslationKey)}`}
                          onPress={() => setSelectedProcessRunId(work.id)}
                          testID={`process-run-history-${work.id}`}
                        />
                      ))}
                    </Group>
                  ) : null}
                </View>
              )}
            </ScrollView>
          )}
        </View>
      ) : null}
    </View>
  );
  function startRequest(meeting = false) {
    if (!session || !online) {
      changeSection("more");
      return;
    }
    closeVoice();
    if (isProcessReply(contextRef.current)) setDraft("");
    setContext(undefined);
    setSection("chat");
    if (meeting) setDraft((current) => current || tr("meetingStarter"));
    nearBottom.current = true;
    requestAnimationFrame(() => {
      scroll.current?.scrollToEnd({ animated: false });
      composerInput.current?.focus();
    });
  }
}

export default function App() {
  const fonts = useCompanionFonts();
  const [language, setLanguage] = useState<Language>("en");
  const [spokenReplies, setSpokenReplies] = useState(true);
  const [feedbackOn, setFeedbackOn] = useState(true);
  const [ready, setReady] = useState(false);
  const [section, setSection] = useState<Section>("chat");
  const [address, setAddress] = useState(
    allowHttp ? "http://localhost:8787/v1/a" : "",
  );
  const [connections] = useState(
    () =>
      new Connections(
        AsyncStorage,
        credentialVault,
        allowHttp,
        undefined,
        randomUUID,
        {
          processOutputs: true,
          attachments: true,
          attachmentId: randomUUID,
          messageResults: MOBILE_MESSAGE_RESULTS,
          generativeUi: true,
        },
      ),
  );
  const connection = useSyncExternalStore(
    connections.subscribe,
    connections.getSnapshot,
    connections.getSnapshot,
  );
  const session = connection.session;
  const [error, setError] = useState<TranslationKey | null>(null);
  // Saving a local setting can fail without touching the connection.
  const [settingsError, setSettingsError] = useState(false);
  const saved = <T,>(write: Promise<T>) =>
    write.then(
      () => setSettingsError(false),
      () => setSettingsError(true),
    );
  useEffect(() => {
    let active = true;
    void Promise.allSettled([
      loadLanguage(AsyncStorage),
      AsyncStorage.getItem(ADDRESS_KEY),
      loadSpokenReplies(AsyncStorage),
      loadFeedback(AsyncStorage),
    ])
      .then(async ([locale, endpoint, speech, sounds]) => {
        if (active && sounds.status === "fulfilled") {
          setFeedbackOn(sounds.value);
          setFeedbackEnabled(sounds.value);
        }
        if (!active) return;
        if (locale.status === "fulfilled") setLanguage(locale.value);
        else setSettingsError(true);
        if (endpoint.status === "fulfilled" && endpoint.value)
          setAddress(endpoint.value);
        else if (endpoint.status === "rejected") setSettingsError(true);
        if (speech.status === "fulfilled") setSpokenReplies(speech.value);
        else setSettingsError(true);
        await connections.restore();
        if (active && connections.getSnapshot().address)
          setAddress(connections.getSnapshot().address!);
      })
      .catch(() => {
        if (active) setSettingsError(true);
      })
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
      connections.dispose();
    };
  }, [connections]);
  const connect = (code: string) => {
    setError(null);
    void connections.pair(address, code).then((paired) => {
      if (!paired) return;
      const current = connections.getSnapshot();
      if (current.status !== "connected" || !current.address) return;
      void saved(AsyncStorage.setItem(ADDRESS_KEY, current.address));
      setSection("chat");
    });
  };
  const browserSignIn = () => {
    setError(null);
    const popup =
      Platform.OS === "web"
        ? window.open(
            "about:blank",
            "agent-login",
            "popup,width=480,height=720",
          )
        : null;
    void loginProof()
      .then((proof) =>
        connections.signInWithApp(address, proof, (url, signal) =>
          authorizeApp(url, proof.state, signal, popup),
        ),
      )
      .then((signedIn) => {
        if (!signedIn) {
          popup?.close();
          return;
        }
        const current = connections.getSnapshot();
        if (!current.address || current.status !== "connected") return;
        setAddress(current.address);
        void saved(AsyncStorage.setItem(ADDRESS_KEY, current.address));
        setSection("chat");
      })
      .catch(() => {
        popup?.close();
        setError("connection_failed");
      });
  };
  const openBrowser = () => {
    const uri = connections.getSnapshot().browserLogin?.verificationUri;
    if (uri)
      void Linking.openURL(uri).catch(() => setError("connection_failed"));
  };
  const disconnect = () => {
    void connections.disconnect();
  };
  const connectionError =
    error ??
    (connection.error &&
    !isReservedProcessRecoveryCopy(connection.error) &&
    connection.error in en
      ? (connection.error as TranslationKey)
      : null);
  const changeLanguage = (l: Language) => {
    void saved(saveLanguage(AsyncStorage, l).then(() => setLanguage(l)));
  };
  const changeFeedback = (enabled: boolean) => {
    setFeedbackOn(enabled);
    setFeedbackEnabled(enabled);
    void saved(saveFeedback(AsyncStorage, enabled));
  };
  const changeSpokenReplies = (enabled: boolean) => {
    setSpokenReplies(enabled);
    void saved(saveSpokenReplies(AsyncStorage, enabled));
  };
  return (
    <CompanionFontContext.Provider value={fonts.loaded}>
      <MotionProvider>
        <SafeAreaProvider>
          <View style={[styles.flex, { backgroundColor: t.color.background }]}>
            <StatusBar style="light" />
            <SafeAreaView style={styles.screen}>
              <KeyboardAvoidingView
                style={styles.flex}
                behavior={
                  Platform.OS === "ios"
                    ? "padding"
                    : Platform.OS === "android"
                      ? "height"
                      : undefined
                }
              >
                {ready && fonts.ready ? (
                  <Workspace
                    key={connection.generation}
                    session={session}
                    language={language}
                    spokenReplies={spokenReplies}
                    section={section}
                    setSection={setSection}
                    authError={connectionError}
                    settings={
                      <Settings
                        language={language}
                        changeLanguage={changeLanguage}
                        spokenReplies={spokenReplies}
                        changeSpokenReplies={changeSpokenReplies}
                        feedbackOn={feedbackOn}
                        changeFeedback={changeFeedback}
                        address={address}
                        setAddress={setAddress}
                        connect={connect}
                        browserSignIn={browserSignIn}
                        openBrowser={openBrowser}
                        disconnect={disconnect}
                        connection={connection}
                        error={
                          settingsError ? "storage_error" : connectionError
                        }
                      />
                    }
                  />
                ) : (
                  <Text>{translate(language)("loading")}</Text>
                )}
              </KeyboardAvoidingView>
            </SafeAreaView>
          </View>
        </SafeAreaProvider>
      </MotionProvider>
    </CompanionFontContext.Provider>
  );
}

/**
 * The answer while it is written. It is not the answer yet: the stored
 * message replaces it, and nothing in it can be acted on.
 */
function AnswerDraft({
  draft,
  language,
}: {
  draft: string;
  language: Language;
}) {
  const { text, program } = splitDraft(draft);
  return (
    <View testID="answer-draft">
      {text ? (
        <View style={styles.answer}>
          <MarkdownText text={text} />
        </View>
      ) : null}
      {program ? (
        <GenerativeUiView
          program={program}
          streaming
          disabled
          language={language}
          onFollowUp={noFollowUp}
        />
      ) : null}
    </View>
  );
}
const noFollowUp = () => {};
