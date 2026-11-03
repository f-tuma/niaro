import { fetch as expoFetch } from "expo/fetch";
import { ensureMicrophone } from "./voice-capture";
import {
  loadMicrophoneHint,
  microphoneAllowed,
  microphoneGranted,
  recheckMicrophone,
} from "./microphone-permission";
import { pairingLink } from "./pairing-link";
import {
  PetProfile,
  PetTopBarActions,
  petScreenTitle,
  usePetScreen,
} from "./PetProfile";
import { useNativePetProfile, nativePetAppearance } from "./pet-profile-model";
import {
  useMobileComposerMentions,
  MobileMentionSheet,
} from "./MobileMentions";
import type { MessageMention } from "../../packages/protocol/mentions";
import {
  mentionsInText,
  messageMentions,
} from "../../packages/client-core/mentions";
import { VoiceServiceCard } from "../../packages/ui-catalog/VoiceServiceCard";
import type { VoiceCapabilities } from "../../packages/protocol/voice";
import {
  useHomePetVisibility,
  type HomePetBounds,
} from "./home-pet-visibility";
import {
  useMobileAttachments,
  MobileAttachmentPreview,
} from "./AttachmentControls";
import { AttachmentPicker } from "../../packages/ui-catalog/AttachmentPicker";
import { useCompanionFonts } from "./CompanionFonts";
import { CompanionFontContext } from "../../packages/ui/typography";
import { CompanionLibrary } from "./CompanionLibrary";
import { companionCopy } from "./companion-copy";
import { LanguageMenu } from "./LanguageMenu";
import {
  usePetClip,
  PetSlot,
  PetStage,
  usePetStageLook,
} from "../../packages/ui/PetStage";
import type { PetAppearance } from "../../packages/ui/pet-motion";
import { loadPetLook, savePetLook } from "./pet-look-memory";
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
  AccessibilityInfo,
  Alert,
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
import { ChatHistory, useChatChanges } from "./ChatHistory";
import { ChatOptions } from "./ChatOptions";
import { OpenWorkNotice } from "./OpenWorkNotice";
import { ChatSearchScreen } from "./ChatSearch";
import { tokens as t } from "../../packages/design-tokens";
import {
  Text,
  Stack,
  Button,
  Notice,
  ActionToast,
  Group,
  ListRow,
} from "../../packages/ui";
import { MobileWorkItemCard } from "./MobileWorkItemCard";
import { MemberServices } from "./ServiceConnection";
import { ProcessAnswerRecoveryCard } from "../../packages/ui-catalog/ProcessAnswerRecoveryCard";
import { recordedProcessAnswer } from "../../packages/client-core/reply-context";
import {
  canRetryPending,
  chatRequestFailed,
  chatErrorKey,
  isUserMessageRecorded,
  processAnswerCardShown,
  runningChat,
  selectFailedMessages,
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
  createVoiceReply,
  isProcessReply,
  type VoiceReplyContext,
} from "./VoiceReply";
import { ProcessLaunch } from "./ProcessLaunch";
import { ProcessApprovalRecovery } from "./ProcessApprovalRecovery";
import { feedback, setFeedbackEnabled } from "./feedback";
import type { VoiceDraft } from "../../packages/client-core/voice";
import { Entrance, MotionProvider } from "../../packages/ui/motion";
import { WorkItemSummary } from "../../packages/ui-catalog/WorkItemSummary";
import type { ProcessOfferResult } from "../../packages/protocol/process-offer";

import { ChatThread } from "./chat/ChatThread";
import { OtherChatNotice } from "./chat/OtherChatNotice";
import { answerAnnouncement } from "./chat/announce";
import { ChatFooter } from "./chat/composer";
import { MobileChatProvider, type MobileChat } from "./chat/parts";
import { projectThread, trailingWork, visibleMessages } from "./chat/thread";
import {
  chrome as styles,
  TopBar,
  StatusLine,
  Home,
  TaskTabs,
  DetailSheet,
  EmptyState,
  IconButton,
  Navigation,
  type Section,
  type TaskTab,
  type VoiceAvailability,
} from "./ScreenChrome";

import type { MessageResultToken } from "../../packages/protocol/message-delivery";
import { followConnections } from "../../packages/client-core/list-cache";
import { phoneLists } from "./list-cache";

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
/** The longest the first screen waits for the pet's still to be decoded. */
const PET_WAIT_MS = 400;
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
        <MemberServices session={connection.session} language={language} />
      ) : null}
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
  // The pets of Home and the pet profile are drawn only inside the scrolling area.
  const petClip = usePetClip();
  const scrollRef = useCallback(
    (node: ScrollView | null) => {
      scroll.current = node;
      petClip(node);
    },
    [petClip],
  );
  const homePetVisibility = useHomePetVisibility();
  const profilePetVisibility = useHomePetVisibility();
  const { onBounds: publishProfileBounds } = profilePetVisibility;
  const profileContentTop = useRef(0);
  const profilePetBounds = useRef<HomePetBounds | null>(null);
  const onProfilePetBounds = useCallback(
    (bounds: HomePetBounds | null) => {
      profilePetBounds.current = bounds;
      publishProfileBounds(
        bounds
          ? { ...bounds, top: profileContentTop.current + bounds.top }
          : null,
      );
    },
    [publishProfileBounds],
  );
  const petProfile = useNativePetProfile(session, AsyncStorage);
  const petScreen = usePetScreen();
  const [petScreenOwner, setPetScreenOwner] = useState<ClientSession | null>(
    null,
  );
  const petOpen = !!session && petScreenOwner === session;
  const [petAppearanceOpen, setPetAppearanceOpen] = useState(false);
  const [petManageOpen, setPetManageOpen] = useState(false);
  const setPetOpen = useCallback(
    (open: boolean) => {
      setPetScreenOwner(open ? session : null);
      if (!open) {
        petScreen.reset();
        setPetManageOpen(false);
      }
    },
    [session, petScreen],
  );
  // Until the profile is back, the look remembered from the last run: the pet appears in its own
  // look at once instead of the default one first (NIAR-277).
  const rememberedLook = usePetStageLook();
  const profileLook = useMemo(
    () =>
      petProfile.profile ? nativePetAppearance(petProfile.profile) : undefined,
    [petProfile.profile],
  );
  const petLook =
    profileLook ?? (session ? (rememberedLook ?? undefined) : undefined);
  useEffect(() => {
    if (profileLook) savePetLook(AsyncStorage, profileLook);
  }, [profileLook]);
  const { read: readPetProfile } = petProfile;
  useEffect(() => {
    // Opening the pet shows what the web may have changed meanwhile.
    if (petOpen) void readPetProfile();
  }, [petOpen, readPetProfile]);

  const composerInput = useRef<TextInput>(null);
  const focusWork = useRef<string | undefined>(undefined);
  const [draft, setDraftState] = useState("");
  const draftRef = useRef("");
  // Dismiss of a failed request waits for the server's answer.
  const [dismissing, setDismissing] = useState(false);
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
  /** The message a search result opens: read until shown, then outlined. */
  const messageTarget = useRef<
    { conversationId: string; messageId: string; pages: number } | undefined
  >(undefined);
  const scrollToMessage = useRef<string | undefined>(undefined);
  const [highlight, setHighlight] = useState<string>();
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
  // A screen opened from the chat (its pet, a recording) goes back there.
  const [returnTo, setReturnTo] = useState<Section | null>(null);
  const leaveTo = (fallback: Section) => {
    setReturnTo(null);
    setSection(returnTo ?? fallback);
  };
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
        const leaveTo = (fallback: Section) => {
          setReturnTo(null);
          setSection(returnTo ?? fallback);
        };
        if (historyOpen) setHistoryOpen(false);
        else if (processOpen && selectedProcessRunId)
          setSelectedProcessRunId(null);
        else if (processOpen) setProcessOpen(false);
        else if (petOpen && petAppearanceOpen) setPetAppearanceOpen(false);
        else if (petOpen && petScreen.nested) petScreen.back();
        else if (petOpen) {
          setPetOpen(false);
          if (returnTo) leaveTo("library");
        } else if (meetingOpen) setMeetingId(null);
        else if (section === "more") leaveTo("library");
        else setSection("chat");
        return true;
      },
    );
    return () => subscription.remove();
  }, [
    historyOpen,
    processOpen,
    selectedProcessRunId,
    petOpen,
    petAppearanceOpen,
    petScreen,
    setPetOpen,
    section,
    setSection,
    meetingOpen,
    returnTo,
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
        // A failure belongs to the chat it happened in.
        setReplyError(null);
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
      messageTarget.current = undefined;
      scrollToMessage.current = undefined;
      setHighlight(undefined);
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
  /** The open chat was deleted or archived: back to the main chat, freshly read. */
  const leaveGoneChat = (id: string) => {
    if (id !== conversationRef.current) return;
    switchConversation("conversation-1");
    void session?.refresh();
  };
  /** Names given here, shown in the top bar until the chat is read again. */
  const [renamed, setRenamed] = useState<Record<string, string>>({});
  /** The top bar's `…`: the same changes as a held row in the menu. */
  const chatChanges = useChatChanges(session, {
    onRenamed: (conversation, title) =>
      setRenamed((current) => ({ ...current, [conversation.id]: title })),
    onGone: (id) => leaveGoneChat(id),
  });
  const openHistoryConversation = (
    selected: ConversationSummary,
    messageId?: string,
  ) => {
    switchConversation(selected.id);
    // Read again, the chat's name is the server's.
    setRenamed((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([id]) => id !== selected.id),
      ),
    );
    if (messageId) {
      // Older pages are read until the message is there (see below).
      messageTarget.current = {
        conversationId: selected.id,
        messageId,
        pages: 0,
      };
      nearBottom.current = false;
    }
    setContinuedConversations((current) => ({
      ...current,
      [selected.id]: true,
    }));
    historySelectionRef.current = selected;
    setHistorySelection(selected);
    void readHistory(selected);
    if (!selected.readOnly) void session?.refresh();
  };
  useEffect(() => {
    const target = messageTarget.current;
    if (
      !target ||
      historyLoading ||
      !historySelection ||
      target.conversationId !== historySelection.id ||
      target.conversationId !== conversationRef.current
    )
      return;
    if (historyMessages.some((message) => message.id === target.messageId)) {
      messageTarget.current = undefined;
      scrollToMessage.current = target.messageId;
      setHighlight(target.messageId);
      return;
    }
    if (historyError || !historyAfter || target.pages >= 25) {
      messageTarget.current = undefined;
      return;
    }
    target.pages++;
    void readHistory(historySelection, true);
  }, [
    historyMessages,
    historyAfter,
    historyLoading,
    historyError,
    historySelection,
    readHistory,
  ]);
  useEffect(() => {
    if (!highlight) return;
    const timer = setTimeout(() => setHighlight(undefined), 2500);
    return () => clearTimeout(timer);
  }, [highlight]);
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
      // No polling in the background; coming back syncs at once.
      session.setActive?.(next === "active");
      if (next === "active") {
        chatResumed();
        void session.refresh();
        // Back from the system settings, maybe: check access without asking.
        if (microphoneGranted()) void recheckMicrophone();
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
    options: {
      withoutProcess?: true;
      mentions?: MessageMention[];
      /** Again: the composer's draft and attached task stay where they are. */
      detached?: true;
    } = {},
  ) => {
    // A new attempt replaces the previous failure; a new one is set below.
    setReplyError(null);
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
      !replyContext &&
      !options.detached &&
      attachedTask?.conversationId === conversationId
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
    // As on the web, the text leaves the composer on send and never comes
    // back: a message the session took is in the chat (still working, failed
    // with Try again, or answered). Only a send the session did not take at
    // all stays in the composer.
    let clearedRevision: number | undefined;
    if (
      !isProcessReply(replyContext) &&
      draftRevision.current === submittedDraftRevision &&
      conversationRef.current === command.conversationId
    ) {
      setDraft("");
      clearedRevision = draftRevision.current;
    }
    const ownsDraft = () =>
      draftRevision.current === submittedDraftRevision ||
      (clearedRevision !== undefined &&
        draftRevision.current === clearedRevision);
    const delivery = session.send(command, false, undefined, noticeOwner);
    if (
      session.getSnapshot().pending?.commandId !== command.commandId &&
      clearedRevision !== undefined &&
      draftRevision.current === clearedRevision &&
      conversationRef.current === command.conversationId
    )
      setDraft(value);
    void delivery
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
            ownsDraft() &&
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
            ownsDraft() &&
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
  const messages = visibleMessages(allMessages, historySelection, chatStart);
  // A sound for what arrives while the chat is open; history loaded at start is silent.
  const heard = useRef<Map<string, string> | undefined>(undefined);
  /** What the announcement below needs to know without re-running. */
  const announcing = useRef({
    heldReply,
    chat: section === "chat",
    language,
    speaking: speech.state,
  });
  useEffect(() => {
    announcing.current = {
      heldReply,
      chat: section === "chat",
      language,
      speaking: speech.state,
    };
  }, [heldReply, section, language, speech.state]);
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
    let stored: (typeof allMessages)[number] | undefined;
    for (const m of allMessages) {
      if (m.role !== "assistant") continue;
      const now = status(m),
        before = heard.current.get(m.id);
      if (before === now) continue;
      heard.current.set(m.id, now);
      // An approved write that completed is the strongest confirmation.
      if (now === "succeeded" && before === "awaiting_approval") cue = "done";
      else if (before === undefined) {
        cue ??= "reply";
        stored = m;
      }
    }
    if (cue) feedback(cue);
    // A stored answer is said once to a screen reader, never while it is
    // read aloud (a spoken reply is held until its sound starts).
    const {
      heldReply: spoken,
      chat,
      language: said,
      speaking,
    } = announcing.current;
    if (
      stored?.text.trim() &&
      chat &&
      !(spoken && stored.replyToCommandId === spoken) &&
      !(speaking.messageId === stored.id && speaking.phase !== "idle")
    )
      AccessibilityInfo.announceForAccessibility(
        answerAnnouncement(translate(said)("answerReady"), stored.text),
      );
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
  const processAnnouncement = selectProcessCommandNotice(state, noticeOwner);
  const errorKey = chatErrorKey(
    replyError,
    processAnnouncement,
    state.error,
    isProcessReply(context),
  );
  // A failed message is kept in its chat with Retry and Dismiss; Stop is only
  // for a request that still runs. One whose outcome the session is still
  // checking by itself is neither: it shows as still working.
  const failedMessage =
    state.pending?.type === "message.send" &&
    state.pending.conversationId === conversationId &&
    chatRequestFailed(state, conversationId)
      ? state.pending
      : null;
  // Another chat holds the one request at a time: this chat says so and
  // leads there, as on the web.
  const otherChat =
    state.pending &&
    state.pending.conversationId !== conversationId &&
    !state.pending.type.startsWith("conversation.")
      ? state.pending
      : null;
  const otherChatRunning =
    !!otherChat && runningChat(state) === otherChat.conversationId;
  const openOtherChat = (id: string) => {
    if (!session) return;
    void session.readConversation(id).then(
      (page) => openHistoryConversation(page.conversation),
      () => switchConversation(id),
    );
  };
  const dismissFailed = () => {
    const failed = failedMessage;
    if (!session || !failed || dismissing) return;
    setDismissing(true);
    // Dismiss only lets the message go; its words never go to the composer.
    void session.discardPending().finally(() => setDismissing(false));
  };
  const referencedWork = store
    ? selectPresentedWork(store, conversationId, messages)
    : new Set<string>();
  const workMessageAnchors = store
    ? selectWorkMessageAnchors(store, conversationId, messages)
    : new Map<string, string>();
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
  const threadEntries = projectThread({
    messages,
    work,
    heldReply,
    anchors: workMessageAnchors,
    referencedWork,
    readOnly: !!historySelection?.readOnly,
  });
  const trailing = trailingWork({
    work,
    referencedWork,
    openedWork,
    pending: state.pending,
    conversationId,
  });
  const chat: MobileChat = {
    session,
    language,
    busy,
    online,
    readOnly: !!historySelection?.readOnly,
    followUp: (followUp) => {
      // A follow-up is a new message the person reviews and sends.
      setContext(undefined);
      setDraft(followUp);
      requestAnimationFrame(() => composerInput.current?.focus());
    },
    continueWith: (text) => submitMessage(text, null),
    reviewOffer: (offer) => openProcesses(offer),
    declineOffer: (text) =>
      submitMessage(text, null, undefined, { withoutProcess: true }),
    reuseAttachments: reuseAttachmentMessage,
    decide: (operationId, approved) => {
      if (!session || !conversation) return;
      const id = randomUUID();
      void session.send({
        type: "service.resolve",
        commandId: id,
        idempotencyKey: id,
        conversationId: conversation.id,
        operationId,
        approved,
        language,
      });
    },
    renderWork: (w) => renderWork(w),
    work: (id) => work.find((w) => w.id === id),
    locateWork,
    edit: (message) => {
      if (!session || busy || !online || historySelection?.readOnly) return;
      if (message.attachments?.length) {
        reuseAttachmentMessage(message, false);
        return;
      }
      closeVoice();
      // Edit makes a new message; the one in the chat stays as it was.
      setContext(undefined);
      setDraft(message.text);
      requestAnimationFrame(() => composerInput.current?.focus());
    },
    again: (request) => {
      if (
        !session ||
        busy ||
        !online ||
        historySelection?.readOnly ||
        attachments.state.entries.length
      )
        return;
      if (request.attachments?.length) {
        reuseAttachmentMessage(request, true);
        return;
      }
      // -1 owns no draft: whatever the person is typing stays.
      submitMessage(request.text, null, -1, {
        detached: true,
        mentions: messageMentions(
          request.text,
          mentionsInText(request.text, mentions.directory),
        ),
      });
    },
    againBlocked: attachments.state.entries.length > 0,
    highlight,
    locateMessage: (id, y) => {
      if (scrollToMessage.current !== id) return;
      scrollToMessage.current = undefined;
      requestAnimationFrame(() =>
        scroll.current?.scrollTo({
          y: Math.max(0, profileContentTop.current + y - 8),
          animated: false,
        }),
      );
    },
  };
  const failedMessages = selectFailedMessages(state, conversationId);
  // A failed message keeps its chat open, even as the chat's first message.
  const hasConversation =
    messages.length > 0 || work.length > 0 || failedMessages.length > 0;
  // A screen the app's one pet stands on fades in without sliding: the pet is drawn over it by
  // the stage, which sees where a native-driven slide ends only once it has ended (NIAR-276).
  const petStage = petOpen || (section === "chat" && !hasConversation && !busy);
  const chatTitle = conversationTitle(
    renamed[conversationId] ?? historySelection?.title ?? "",
  );
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
    // The microphone is asked for before the composer opens: its system
    // dialog backgrounds the app and would otherwise cancel the recording.
    // Once granted it is remembered, so later taps open the composer at once.
    if (!microphoneGranted()) {
      const requestedSession = session;
      void ensureMicrophone()
        .then((granted) => {
          if (sessionOwner.current !== requestedSession) return;
          if (!granted) {
            setReplyError("voice_permission");
            return;
          }
          microphoneAllowed();
          // Allowed now: an earlier "blocked" no longer holds.
          setReplyError((current) =>
            current === "voice_permission" ? null : current,
          );
          // The app is in front again after the dialog; continue the tap.
          const resume = () => {
            if (
              AppState.currentState !== "background" &&
              AppState.currentState !== "inactive"
            )
              openVoice();
            else {
              const subscription = AppState.addEventListener(
                "change",
                (next) => {
                  if (next !== "active") return;
                  subscription.remove();
                  openVoice();
                },
              );
            }
          };
          resume();
        })
        .catch(() => setReplyError("voice_permission"));
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
              // A spoken message that failed stays in the chat as failed
              // with Try again; its words never go into the composer.
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
    setReturnTo(null);
    setPetOpen(false);
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
    setProcessOffer(offer);
    setProcessOpen(true);
  };
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
                <IconButton icon="menu" label={tr("menu")} onPress={openMenu} />
              }
              title={chatTitle || "Niaro"}
              lines={1}
              subtitle={statusLine}
              emblem={
                hasConversation &&
                !voice &&
                petProfile.profile?.settings.showInChat !== false ? (
                  <PetSlot
                    appearance={petLook}
                    // Still, the small pet looked broken; it moves like the
                    // big one unless motion is off in its settings.
                    animate={petProfile.profile?.settings.animate ?? true}
                    onPress={() => {
                      changeSection("library");
                      setPetOpen(true);
                      setReturnTo("chat");
                    }}
                    occupied={petOccupied}
                    visible={
                      !historyOpen &&
                      !processOpen &&
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
              // New chat lives in the menu; the chat's own actions take its place.
              trailing={
                session ? (
                  <ChatOptions
                    session={session}
                    language={language}
                    online={online}
                    conversation={
                      conversationId === unsavedChat ||
                      historySelection?.readOnly
                        ? undefined
                        : { id: conversationId, title: chatTitle }
                    }
                    changes={chatChanges}
                  />
                ) : null
              }
            />
          ) : (
            <TopBar
              // Tabs are peers; only an open meeting record has a way back.
              leading={
                petOpen || meetingOpen || section === "more" ? (
                  <IconButton
                    icon="back"
                    label={tr("back")}
                    onPress={() => {
                      if (petOpen && petAppearanceOpen)
                        setPetAppearanceOpen(false);
                      else if (petOpen && petScreen.nested) petScreen.back();
                      else if (petOpen) {
                        setPetOpen(false);
                        if (returnTo) leaveTo("library");
                      } else if (meetingOpen) setMeetingId(null);
                      else leaveTo("library");
                    }}
                  />
                ) : undefined
              }
              title={
                petOpen
                  ? petScreenTitle(petScreen, language)
                  : section === "library"
                    ? companionCopy(language).library
                    : section === "tasks"
                      ? companionCopy(language).tasks
                      : tr(section === "more" ? "settingsTitle" : section)
              }
              subtitle={statusLine}
              trailing={
                petOpen ? (
                  <PetTopBarActions screen={petScreen} language={language} />
                ) : session && section === "tasks" ? (
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
          {section === "chat" && chatChanges.actionError ? (
            <View style={{ paddingHorizontal: t.spacing.screenGutter }}>
              <Notice error>{tr(chatChanges.actionError)}</Notice>
            </View>
          ) : null}
          {section === "chat" && chatChanges.refusal ? (
            <View style={{ paddingHorizontal: t.spacing.screenGutter }}>
              <OpenWorkNotice
                language={language}
                refusal={chatChanges.refusal}
                disabled={!online || chatChanges.cancelling}
                onKeep={() => chatChanges.setRefusal(undefined)}
                onCancelAndContinue={() =>
                  void chatChanges.cancelAndContinue(chatChanges.refusal!)
                }
              />
            </View>
          ) : null}
          {section === "tasks" ? (
            <TaskTabs
              tab={tab}
              onChange={setTab}
              language={language}
              count={count}
            />
          ) : null}
        </View>
        <Entrance
          style={styles.flex}
          testID="screen-transition"
          distance={petStage ? 0 : undefined}
        >
          <ScrollView
            testID="screen-scroll"
            ref={scrollRef}
            onLayout={(event) => {
              homePetVisibility.onViewport(event.nativeEvent.layout.height);
              profilePetVisibility.onViewport(event.nativeEvent.layout.height);
            }}
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
              profilePetVisibility.onScroll(
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
                  <Notice error>{tr("chatLoadFailed")}</Notice>
                ) : null}
                {historyError ? (
                  <Button
                    variant="secondary"
                    label={tr("chatLoadRetry")}
                    disabled={historyLoading || !online}
                    onPress={() => void readHistory(historySelection)}
                  />
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
            // A message's request is retried or dismissed in its own chat.
            state.pending.type !== "message.send" &&
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
                  // An answer on its way or being checked shows as the
                  // person's message in its chat, with no card (NIAR-284).
                  if (!processAnswerCardShown(state, attempt)) return null;
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
                  // Only a running request is stopped first; a failed one
                  // stays in its chat with Retry and Dismiss.
                  const current = session.getSnapshot();
                  return current.pending &&
                    current.commandStates[commandTarget(current.pending)] ===
                      "sending"
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
              distance={petStage ? 0 : undefined}
              onLayout={(event) => {
                profileContentTop.current = event.nativeEvent.layout.y;
                onProfilePetBounds(profilePetBounds.current);
              }}
              style={[
                styles.section,
                section === "chat" &&
                  !hasConversation &&
                  !busy && { flexGrow: 1 },
              ]}
            >
              {petOpen && session ? (
                <PetProfile
                  key={session.identityKey}
                  session={session}
                  language={language}
                  profile={petProfile.profile}
                  profileError={petProfile.error}
                  petVisible={profilePetVisibility.visible}
                  onPetBounds={onProfilePetBounds}
                  onSave={petProfile.save}
                  onRefresh={petProfile.read}
                  changes={petProfile.changes}
                  appearance={petAppearanceOpen}
                  onAppearance={setPetAppearanceOpen}
                  screen={petScreen}
                  manage={petManageOpen}
                  onManage={setPetManageOpen}
                  onOpenSource={(href) => {
                    const [kind, id] = href.slice(1).split("/");
                    if (!id) return;
                    if (kind === "chat") {
                      changeSection("chat");
                      // Open it like the history does, with its messages read.
                      void session.readConversation(id).then(
                        (page) => openHistoryConversation(page.conversation),
                        () => switchConversation(id),
                      );
                    } else if (kind === "meetings") {
                      changeSection("meetings");
                      setMeetingId(id);
                    }
                  }}
                />
              ) : section === "library" ? (
                <CompanionLibrary
                  language={language}
                  connected={!!session}
                  onPet={() => setPetOpen(true)}
                  onProcesses={() => openProcesses()}
                  onSettings={() => changeSection("more")}
                />
              ) : section === "more" ? (
                // Archived chats are found in Search, under Archived.
                settings
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
                  showPet={petProfile.profile?.settings.showInChat !== false}
                  petAppearance={petLook}
                  petAnimate={petProfile.profile?.settings.animate ?? true}
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
                  petTyped={draft.length}
                  petVisible={
                    homePetVisibility.visible &&
                    !historyOpen &&
                    !processOpen &&
                    !contextMenu &&
                    !voiceSettingsOpen &&
                    !mentions.sheet
                  }
                  onPetBounds={homePetVisibility.onBounds}
                  level={voiceLevel}
                  meetingRecording={meetingRecording}
                  onTalk={openVoice}
                  onMeeting={() => startRequest(true)}
                  onTasks={() => changeSection("tasks")}
                  onConnect={() => changeSection("more")}
                />
              ) : (
                <MobileChatProvider value={chat}>
                  <ChatThread
                    entries={threadEntries}
                    failedMessages={failedMessages}
                    onRetryFailed={
                      session && online && !busy && !historySelection?.readOnly
                        ? (commandId) => {
                            nearBottom.current = true;
                            void session
                              .retryFailedMessage(commandId, randomUUID())
                              .catch(() => {});
                          }
                        : undefined
                    }
                    onDismissFailed={
                      session
                        ? (commandId) => session.dismissFailedMessage(commandId)
                        : undefined
                    }
                    pendingMessage={pendingMessage}
                    trailing={trailing}
                    heldReply={heldReply}
                    state={state}
                    conversationId={conversationId}
                    onRetry={
                      canRetryPending(state)
                        ? () => {
                            void session?.retry(noticeOwner);
                          }
                        : undefined
                    }
                    onDismiss={failedMessage ? dismissFailed : undefined}
                    actionsDisabled={dismissing}
                  />
                </MobileChatProvider>
              )}
            </Entrance>
          </ScrollView>
        </Entrance>
        {/* Without a server there is nobody to write to; the intro offers Connect. */}
        {section === "chat" && session ? (
          <ChatFooter
            language={language}
            notice={processAnnouncement.notice ?? undefined}
            otherChat={
              otherChat && !historySelection?.readOnly ? (
                <OtherChatNotice
                  language={language}
                  running={otherChatRunning}
                  onOpen={() => openOtherChat(otherChat.conversationId)}
                  onStop={
                    otherChat.type === "message.send" ||
                    otherChat.type === "process.answer"
                      ? () => {
                          void session.interruptPending();
                        }
                      : undefined
                  }
                  disabled={!online}
                />
              ) : undefined
            }
            errorKey={errorKey}
            diagnostic={state.connectionDiagnostic}
            speech={speech}
            context={context}
            validContext={validContext}
            waitingForProcessAnswer={waitingForProcessAnswer}
            onClearContext={() => {
              closeVoice();
              if (isProcessReply(context)) setDraft("");
              setContext(undefined);
            }}
            attachedTask={
              attachedTask?.conversationId === conversationId
                ? attachedTask.task
                : undefined
            }
            onDetachTask={() => setAttachedTask(undefined)}
            voice={voice}
            voiceOpen={!!voice && online && (!context || validContext)}
            voiceBlocked={busy}
            onCloseVoice={closeVoice}
            voiceLevel={voiceLevel}
            petAppearance={petLook}
            petAnimate={petProfile.profile?.settings.animate ?? true}
            readOnly={!!historySelection?.readOnly}
            onNewChat={online && !busy ? startNewChat : undefined}
            onRestore={
              online && !busy && !restoring ? restoreOpenChat : undefined
            }
            restoreError={restoreError}
            attachments={attachments}
            mentions={mentions}
            inputRef={composerInput}
            draft={draft}
            onFocus={() => setOwnedComposerFocus(true)}
            onBlur={() => {
              setOwnedComposerFocus(false);
              mentions.blur();
            }}
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
            onStop={
              // Offline nothing can be stopped; a background check is not running.
              online &&
              state.pending?.type === "message.send" &&
              runningChat(state) === conversationId
                ? () => {
                    void session?.interruptPending();
                  }
                : undefined
            }
            stopLabel={
              state.error === "requestInterruptFailed"
                ? tr("progressInterruptRetry")
                : tr("progressInterrupt")
            }
            stopDisabled={!online}
            voiceMode={
              meetingRecording || attachments.state.entries.length > 0
                ? "disabled"
                : voiceAvailability === "available"
                  ? "ready"
                  : "settings"
            }
          />
        ) : null}
        {/* While typing, the keyboard needs the room more than the tabs do. */}
        {/* The tabs are the one way between sections, in a chat as well. */}
        {keyboardOpen || voice ? null : (
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
        onDeleted={leaveGoneChat}
        onNavigate={() => {
          setHistoryOpen(false);
          setSearchOpen(true);
        }}
      />
      {session && searchOpen ? (
        <ChatSearchScreen
          session={session}
          language={language}
          online={online}
          onClose={() => setSearchOpen(false)}
          onOpen={(conversation, messageId) => {
            setSearchOpen(false);
            openHistoryConversation(conversation, messageId);
          }}
          onOpenMeeting={(id) => {
            setSearchOpen(false);
            changeSection("meetings");
            setMeetingId(id);
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
          {selectedProcessRun ? (
            <TopBar
              leading={
                <IconButton
                  icon="back"
                  label={tr("back")}
                  onPress={() => setSelectedProcessRunId(null)}
                />
              }
              title={selectedProcessRun?.title ?? tr("processesTitle")}
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
          {
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
                    <ProcessLaunch
                      session={session}
                      language={language}
                      conversationId={conversationId}
                      chatGeneration={chatGeneration}
                      offer={(processOpen && processOffer) || undefined}
                      showTitle={false}
                      // "Back to chat" means it, also when opened from Library.
                      onDone={() => {
                        setProcessOpen(false);
                        changeSection("chat");
                      }}
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
          }
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
  // Read first and alone: the app's one pet starts (GL context, shader) while the rest loads.
  const [petLook, setPetLook] = useState<PetAppearance | null>();
  useEffect(() => {
    void loadPetLook(AsyncStorage).then(setPetLook);
    // A microphone granted on an earlier launch opens at once on the first tap.
    void loadMicrophoneHint(AsyncStorage);
  }, []);
  // The first screen waits for the pet's still to be decoded, so its first frame has the pet; a
  // slow decode never holds it for long (the vector drawing stands in meanwhile).
  const [petReady, setPetReady] = useState(false);
  const onPetReady = useCallback(() => setPetReady(true), []);
  useEffect(() => {
    const timer = setTimeout(onPetReady, PET_WAIT_MS);
    return () => clearTimeout(timer);
  }, [onPetReady]);
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
          messageTimes: true,
          generativeUi: true,
          // Expo's fetch streams the body; the pet follows the web live.
          streamRequest: expoFetch as unknown as typeof fetch,
        },
      ),
  );
  // Remembered lists belong to the signed-in identity only.
  useEffect(() => followConnections(connections, phoneLists), [connections]);
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
  const connect = (code: string, target = address) => {
    setError(null);
    void connections.pair(target, code).then((paired) => {
      if (!paired) return;
      const current = connections.getSnapshot();
      if (current.status !== "connected" || !current.address) return;
      void saved(AsyncStorage.setItem(ADDRESS_KEY, current.address));
      setSection("chat");
    });
  };
  // A QR code from the web account page opens the app with a one-time code;
  // the person confirms the server before anything changes.
  const connectRef = useRef(connect);
  useLayoutEffect(() => {
    connectRef.current = connect;
  });
  useEffect(() => {
    if (!ready) return;
    const tr = translate(language);
    const handle = (url: string | null) => {
      const link = pairingLink(url);
      if (!link) return;
      Alert.alert(
        tr("pairLinkTitle"),
        tr("pairLinkConfirm").replace("{host}", link.host),
        [
          { text: tr("cancel"), style: "cancel" },
          {
            text: tr("pairLinkConnect"),
            onPress: () => {
              setAddress(link.address);
              connectRef.current(link.code, link.address);
            },
          },
        ],
      );
    };
    void Linking.getInitialURL()
      .then(handle)
      .catch(() => {});
    const subscription = Linking.addEventListener("url", ({ url }) =>
      handle(url),
    );
    return () => subscription.remove();
  }, [ready, language]);
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
            <PetStage look={petLook} onReady={onPetReady}>
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
                  {ready && fonts.ready && petReady ? (
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
            </PetStage>
          </View>
        </SafeAreaProvider>
      </MotionProvider>
    </CompanionFontContext.Provider>
  );
}
