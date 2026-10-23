import {
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type SetStateAction,
} from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  AtSign,
  ClipboardList,
  CornerDownRight,
  RefreshCw,
  Square,
  SquarePen,
  X,
} from "lucide-react";
import { Button } from "@admin/components/ui/button";
import {
  Alert,
  AlertAction,
  AlertDescription,
} from "@admin/components/ui/alert";
import { Skeleton } from "@admin/components/ui/skeleton";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupTextarea,
} from "@admin/components/ui/input-group";
import { Markdown } from "@admin/components/ui/markdown";
import { StatusBadge } from "@admin/components/console/status";
import {
  ClientSession,
  commandTarget,
  type SessionCommand,
} from "../../../../packages/client-core/session";
import { messageCommand } from "../../../../packages/client-core/commands";
import {
  canRetryPending,
  chatErrorKey,
  isUserMessageRecorded,
  selectPendingChatMessage,
} from "../../../../packages/client-core/chat-view";
import {
  isProcessReply,
  recordedProcessAnswer,
  type ReplyContext,
} from "../../../../packages/client-core/reply-context";
import {
  assertProcessAnswerTarget,
  captureProcessAnswerTarget,
  processAnswerCommand,
} from "../../../../packages/client-core/process-answers";
import {
  captureProcessNoticeOwner,
  isReservedProcessRecoveryCopy,
  processNoticeCopy,
  selectProcessCommandNotice,
} from "../../../../packages/client-core/process-command-notice";
import {
  isTerminalNativeWork,
  selectConversationWork,
  selectPresentedWork,
  selectReplyInput,
  selectWorkMessageAnchors,
} from "../../../../packages/client-core/store";
import { conversationTitle } from "../../../../packages/client-core/conversation-title";
import { en, type TranslationKey } from "../../../../packages/i18n";
import type {
  Conversation,
  ConversationSummary,
  HumanTaskReference,
  NativeQuestion,
  WorkItem,
} from "../../../../packages/protocol";
import { cardDocumentText } from "../../../../packages/protocol/card-document";
import type { MessageMention } from "../../../../packages/protocol/mentions";
import { useApp, useAppSession } from "./context";
import { chatChangeError, useChatCopy } from "./chat-copy";
import { useMessageLink } from "./message-link";
import {
  ContactList,
  ProcessOfferView,
  ProcessProposalView,
  ServiceActionView,
  ServiceConnectionView,
} from "./chat-cards";
import { AnswerRecoveryView, ProgressView, WorkCard } from "./chat-work";
import { GeneratedUi } from "./generative-ui";
import {
  UNSAVED_DRAFT,
  chatHistoryKey,
  draftKey,
  readDraft,
  saveDraft,
} from "./chat-store";
import { handOffProcessOffer } from "./offer-handoff";
import { SkillProposalView } from "./skill-proposal-card";
import { takeHumanTask } from "./task-handoff";
import { useSessionState } from "./menu-page";
import {
  MAX_MESSAGE_LENGTH,
  MentionChips,
  MentionPicker,
  MessageTags,
  filterMentions,
  insertMention,
  isTagged,
  mentionOptionId,
  mentionQuery,
  rememberMentions,
  sentMentions,
  messageMentions,
  removeMention,
  useMentionDirectory,
  type MentionItem,
} from "./chat-composer";
import {
  DaySeparator,
  MessageActions,
  messageDays,
} from "./chat-message-actions";
import { listenForKeys } from "./chat-question";

const newId = () => crypto.randomUUID();
/** A send that owns no composer draft: the composer stays as it is. */
const NO_DRAFT_OWNER = -1;
type ChatMessage = Conversation["messages"][number];
const validConversationId = (id: string) => /^[a-zA-Z0-9._:-]{1,160}$/.test(id);
/** Chat history requests in the web app never fall back to the legacy chat. */
const CHAT_PREFIX = "chat-";

/**
 * The chat at "/chat" (always a new, unsaved chat) and "/chat/$id". A new chat
 * keeps its page when its first message gives it an address; "New chat"
 * after that starts a fresh one.
 */
export function ChatPage() {
  const params: { conversationId?: string } = useParams({ strict: false });
  const conversationId = params.conversationId;
  const session = useAppSession();
  const navigate = useNavigate();
  const [fresh, setFresh] = useState<{
    generation: number;
    savedId: string | null;
    promoted: boolean;
  }>({ generation: 0, savedId: null, promoted: false });
  if (conversationId && conversationId === fresh.savedId && !fresh.promoted)
    setFresh({ ...fresh, promoted: true });
  if (!conversationId && fresh.promoted)
    setFresh({
      generation: fresh.generation + 1,
      savedId: null,
      promoted: false,
    });
  const continuing = !!conversationId && conversationId === fresh.savedId;
  const key =
    !conversationId || continuing
      ? `new:${fresh.generation}`
      : `chat:${conversationId}`;
  const onSaved = useCallback(
    (id: string) => {
      setFresh((current) => ({ ...current, savedId: id }));
      void navigate({
        to: "/chat/$conversationId",
        params: { conversationId: id },
        replace: true,
      });
    },
    [navigate],
  );
  return (
    <ChatConversation
      key={`${session.identityKey}\n${key}`}
      session={session}
      routeId={conversationId}
      onSaved={onSaved}
    />
  );
}

const sendErrorKey = (error: unknown, fallback: TranslationKey) =>
  error instanceof Error &&
  !isReservedProcessRecoveryCopy(error.message) &&
  error.message in en
    ? (error.message as TranslationKey)
    : fallback;

export function ChatConversation({
  session,
  routeId,
  onSaved,
  home,
}: {
  session: ClientSession;
  /** Absent for a new chat that exists only on this page. */
  routeId?: string;
  onSaved: (id: string) => void;
  /** What a new, still empty chat shows above the composer. */
  home?: ComponentType<{
    session: ClientSession;
    onSuggestion: (text: string) => void;
  }>;
}) {
  const { language, workspace } = useApp();
  const { copy, tr } = useChatCopy();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const Home = home ?? Welcome;
  // Starts the session's sync once; every page shares it.
  const state = useSessionState(session);
  const [id] = useState(
    () => routeId ?? `${CHAT_PREFIX}${crypto.randomUUID()}`,
  );
  const valid = validConversationId(id);
  // A new chat lives only on this page until its first message, so opening
  // New chat never leaves empty chats in the history.
  const [unsaved, setUnsaved] = useState(!routeId);
  const unsavedRef = useRef(!routeId);
  const [initial] = useState(() => {
    const saved = readDraft(
      draftKey(session.identityKey, routeId ?? UNSAVED_DRAFT),
    );
    const handed = routeId ? null : takeHumanTask();
    return {
      text: saved?.text ?? "",
      context: saved?.context,
      revision: saved?.revision ?? 0,
      task: handed ?? saved?.task,
      mentions: saved?.mentions ?? [],
    };
  });

  const [draft, setDraftState] = useState(initial.text);
  const draftRef = useRef(initial.text);
  const draftVersion = useRef(initial.revision);
  const draftRevision = useRef(initial.revision);
  const setDraft = useCallback((update: SetStateAction<string>) => {
    const next =
      typeof update === "function" ? update(draftRef.current) : update;
    draftRef.current = next;
    // A newer edit can contain identical text; equality does not imply ownership.
    draftRevision.current = ++draftVersion.current;
    setDraftState(next);
  }, []);
  const [context, setContextState] = useState<ReplyContext | undefined>(
    initial.context,
  );
  const contextRef = useRef<ReplyContext | undefined>(initial.context);
  const contextGeneration = useRef(0);
  const [answerCaption, setAnswerCaption] = useState<{
    context: ReplyContext;
    target: string;
    command: SessionCommand;
  }>();
  const nativeSubmission = useRef<
    | {
        commandId: string;
        context: ReplyContext;
        generation: number;
        draftRevision: number;
        command: SessionCommand;
      }
    | undefined
  >(undefined);
  const [replyError, setReplyError] = useState<TranslationKey | null>(null);
  const setContext = useCallback(
    (next: ReplyContext | undefined) => {
      if (next === contextRef.current) return;
      if (
        isProcessReply(contextRef.current) &&
        next &&
        (!isProcessReply(next) ||
          JSON.stringify(next.target) !==
            JSON.stringify(contextRef.current.target))
      )
        setDraft("");
      contextGeneration.current++;
      contextRef.current = next;
      setContextState(next);
      setAnswerCaption(undefined);
      setReplyError(null);
    },
    [setDraft],
  );
  const [attachedTask, setAttachedTask] = useState<
    HumanTaskReference | undefined
  >(initial.task ?? undefined);
  const attachedTaskRef = useRef(attachedTask);
  useLayoutEffect(() => {
    attachedTaskRef.current = attachedTask;
  }, [attachedTask]);

  // "@" tags: the directory, the ones picked for this draft and the picker.
  const directory = useMentionDirectory(session);
  const [picked, setPicked] = useState<MentionItem[]>(initial.mentions);
  const pickedRef = useRef(picked);
  useLayoutEffect(() => {
    pickedRef.current = picked;
  }, [picked]);
  const [picker, setPicker] = useState<{
    start: number;
    query: string;
    active: number;
  } | null>(null);
  const pickerId = useId();
  const pickerItems = picker ? filterMentions(directory, picker.query) : [];
  const pickerOpen = pickerItems.length > 0;
  const pickerActive = picker
    ? Math.min(picker.active, pickerItems.length - 1)
    : 0;
  const trackMention = (text: string, caret: number) => {
    const found = directory.length ? mentionQuery(text, caret) : null;
    setPicker((current) =>
      found
        ? {
            ...found,
            active: current?.start === found.start ? current.active : 0,
          }
        : null,
    );
  };
  const pickMention = (item: MentionItem) => {
    if (!picker) return;
    const next = insertMention(draftRef.current, picker, item);
    setDraft(next.text);
    setPicked((current) =>
      current.some((c) => c.kind === item.kind && c.id === item.id)
        ? current
        : [...current, item],
    );
    setPicker(null);
    // Placed as the new text commits, before anything else is typed.
    pendingCaret.current = next.caret;
  };
  const chips = picked.filter((item) => isTagged(draft, item));
  const pendingCaret = useRef<number | null>(null);
  /** The "@" button: starts a tag at the caret and opens the picker. */
  const startMention = () => {
    const text = draftRef.current;
    const caret = composerRef.current?.selectionStart ?? text.length;
    const before = text.slice(0, caret);
    const prefix = before && !/\s$/.test(before) ? " @" : "@";
    const next = before + prefix + text.slice(caret);
    setDraft(next);
    pendingCaret.current = caret + prefix.length;
    trackMention(next, caret + prefix.length);
  };
  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    const composer = composerRef.current;
    if (caret === null || !composer) return;
    pendingCaret.current = null;
    composer.focus();
    composer.setSelectionRange(caret, caret);
  }, [draft]);

  const [historySelection, setHistorySelection] =
    useState<ConversationSummary>();
  const historySelectionRef = useRef<ConversationSummary | undefined>(
    undefined,
  );
  const [historyMessages, setHistoryMessages] = useState<
    Conversation["messages"]
  >([]);
  const [historyAfter, setHistoryAfter] = useState<string | null>(null);
  const historyAfterRef = useRef<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(!!routeId && valid);
  const [historyError, setHistoryError] = useState(false);
  const historyRead = useRef<AbortController | undefined>(undefined);
  const historyReadGeneration = useRef(0);
  const readHistory = useCallback(
    async (selected: { id: string; revision: number }, older = false) => {
      historyRead.current?.abort();
      const controller = new AbortController();
      historyRead.current = controller;
      const owner = ++historyReadGeneration.current;
      try {
        const page = await session.readConversation(
          selected.id,
          older ? historyAfterRef.current : undefined,
          older ? selected.revision : undefined,
          controller.signal,
        );
        if (owner !== historyReadGeneration.current) return;
        historySelectionRef.current = page.conversation;
        historyAfterRef.current = page.nextAfter;
        setHistorySelection(page.conversation);
        setHistoryMessages((current) =>
          older ? [...page.messages, ...current] : page.messages,
        );
        setHistoryAfter(page.nextAfter);
        setHistoryError(false);
      } catch {
        if (owner === historyReadGeneration.current) setHistoryError(true);
      } finally {
        if (owner === historyReadGeneration.current) setHistoryLoading(false);
      }
    },
    [session],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // Growing content follows the end only while the person is there.
  const following = useRef(true);
  const [atEnd, setAtEnd] = useState(true);
  // The home page above a new chat reads from the top.
  const homeShown = useRef(false);
  // Content the person opened by hand grows in place: following the end
  // would pull what they clicked away from under the pointer.
  const holdScroll = useRef(false);
  const holdScrollOnce = () => {
    holdScroll.current = true;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        holdScroll.current = false;
      }),
    );
  };
  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (holdScroll.current) {
        holdScroll.current = false;
        return;
      }
      if (following.current && !homeShown.current)
        scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  // Only this chat's view: never selects, resumes or sends anything.
  useEffect(() => {
    if (valid) session.selectConversation(id);
  }, [session, id, valid]);
  useEffect(() => {
    if (unsavedRef.current || !valid) return;
    void readHistory({ id, revision: 0 }).then(() => {
      const selected = historySelectionRef.current;
      if (selected && !selected.readOnly) void session.refresh();
    });
  }, [session, id, valid, readHistory]);
  useEffect(() => {
    const generation = contextGeneration;
    const reads = historyReadGeneration;
    return () => {
      historyRead.current?.abort();
      reads.current++;
      generation.current++;
      saveDraft(
        draftKey(session.identityKey, unsavedRef.current ? UNSAVED_DRAFT : id),
        {
          text: draftRef.current,
          context: contextRef.current,
          revision: draftRevision.current,
          task: attachedTaskRef.current,
          mentions: pickedRef.current.filter((item) =>
            isTagged(draftRef.current, item),
          ),
        },
      );
    };
  }, [session, id]);

  const store = state.store;
  const online = state.status === "online";
  const busy = !!state.pending || !!state.answerRecoveryBlocked;
  const readOnly = !!historySelection?.readOnly;
  const conversation = store?.conversations[id];
  const historyLiveRevision = conversation?.revision;
  useEffect(() => {
    const selected = historySelectionRef.current;
    if (
      selected &&
      !selected.readOnly &&
      historyLiveRevision &&
      historyLiveRevision > selected.revision
    ) {
      void readHistory(selected);
      // The server may have named the chat after its first message.
      void queryClient.invalidateQueries({
        queryKey: chatHistoryKey(session.identityKey),
      });
    }
  }, [historyLiveRevision, readHistory, queryClient, session]);

  const noticeOwner = captureProcessNoticeOwner(session, {
    conversationId: id,
    chatGeneration: 0,
    language,
  });

  // A process answer retires its draft only once the run records it exactly.
  useEffect(() => {
    const submitted = nativeSubmission.current;
    if (!submitted) return;
    if (
      submitted.generation !== contextGeneration.current ||
      contextRef.current !== submitted.context
    ) {
      nativeSubmission.current = undefined;
      return;
    }
    if (
      !recordedProcessAnswer(state.store, submitted.context, submitted.command)
    )
      return;
    nativeSubmission.current = undefined;
    if (draftRevision.current === submitted.draftRevision) {
      setDraft("");
      setContext(undefined);
    }
  }, [state.store, context, setContext, setDraft]);

  const savingChat = useRef<Promise<boolean> | undefined>(undefined);
  const alive = useRef(true);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<TranslationKey | null>(null);
  /** An archived chat opened by its address returns to the list and goes on. */
  const restoreChat = async () => {
    if (restoring) return;
    setRestoring(true);
    setRestoreError(null);
    try {
      await session.restoreConversation(id, newId());
      if (!alive.current) return;
      await readHistory({ id, revision: 0 });
      void session.refresh();
      void queryClient.invalidateQueries({
        queryKey: chatHistoryKey(session.identityKey),
      });
    } catch (error) {
      if (alive.current) setRestoreError(chatChangeError(error));
    } finally {
      if (alive.current) setRestoring(false);
    }
  };
  /** Creates the local chat on the server right before its first message. */
  const saveChat = (): Promise<boolean> => {
    if (savingChat.current) return savingChat.current;
    const promise = (async () => {
      // The chat's own key makes a retried creation the same command.
      const key = id.slice(CHAT_PREFIX.length);
      const command: SessionCommand = {
        type: "conversation.create",
        conversationId: id,
        commandId: key,
        idempotencyKey: key,
      };
      await session.send(command);
      if (
        session.getSnapshot().commandStates[commandTarget(command)] !==
        "accepted"
      )
        throw new Error("connection_failed");
      if (unsavedRef.current)
        // The new chat's draft became this chat; the next new chat starts empty.
        saveDraft(draftKey(session.identityKey, UNSAVED_DRAFT), {
          text: "",
          revision: 0,
        });
      unsavedRef.current = false;
      if (!alive.current) return false;
      setUnsaved(false);
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
      historySelectionRef.current = selected;
      setHistorySelection(selected);
      void readHistory(selected);
      onSaved(id);
      void queryClient.invalidateQueries({
        queryKey: chatHistoryKey(session.identityKey),
      });
      return true;
    })();
    savingChat.current = promise;
    const clear = () => {
      if (savingChat.current === promise) savingChat.current = undefined;
    };
    void promise.then(clear, clear);
    return promise;
  };

  const submitMessage = (
    value = draft,
    replyContext: ReplyContext | null | undefined = context,
    draftOwnerRevision = draftRevision.current,
    options: {
      withoutProcess?: true;
      /** The tags this message carries; by default the composer's picks. */
      mentions?: MessageMention[];
      /** Sent from a message or question, not the composer: no open item
       * rides along and a failure is reported even without a draft. */
      detached?: true;
    } = {},
  ): void => {
    if (
      !value.trim() ||
      value.trim().length > MAX_MESSAGE_LENGTH ||
      busy ||
      !online ||
      readOnly ||
      !valid
    )
      return;
    setReplyError(null);
    const mentions =
      options.mentions ??
      (isProcessReply(replyContext) ? [] : messageMentions(value, picked));
    // The first message first saves a chat that so far existed only here.
    if (!replyContext && unsavedRef.current) {
      void saveChat()
        .then((saved) => {
          if (saved)
            submitMessage(value, null, draftOwnerRevision, {
              ...options,
              mentions,
            });
        })
        .catch(() => {
          if (alive.current) setReplyError("requestRejected");
        });
      return;
    }
    following.current = true;
    const generation = contextGeneration.current;
    const task =
      !replyContext && !options.detached ? attachedTaskRef.current : undefined;
    let command: SessionCommand;
    try {
      const commandId = newId();
      command = isProcessReply(replyContext)
        ? processAnswerCommand(
            session.getSnapshot().store!,
            replyContext.target,
            {
              commandId,
              idempotencyKey: commandId,
              answer: value,
              language,
            },
          )
        : {
            ...messageCommand(
              value.trim(),
              language,
              commandId,
              replyContext ?? undefined,
            ),
            ...(replyContext ? {} : { conversationId: id }),
            ...(task ? { humanTask: task } : {}),
            ...(!replyContext && options.withoutProcess
              ? { withoutProcess: true as const }
              : {}),
            ...(mentions.length ? { mentions } : {}),
          };
    } catch {
      setReplyError("process_question_changed");
      return;
    }
    if (!isProcessReply(replyContext))
      rememberMentions(
        value,
        [...picked, ...sentMentions(value, directory)],
        mentions,
      );
    if (isProcessReply(replyContext)) {
      setAnswerCaption({
        context: replyContext,
        target: commandTarget(command),
        command,
      });
      nativeSubmission.current = {
        commandId: command.commandId,
        context: replyContext,
        generation,
        draftRevision: draftRevision.current,
        command,
      };
    }
    // A message leaves the composer as soon as it is sent, so its text isn't
    // shown twice while the assistant works; a send that is not accepted puts
    // it back unless the person has typed something new meanwhile.
    const optimistic =
      !isProcessReply(replyContext) &&
      draftRevision.current === draftOwnerRevision;
    if (optimistic) setDraft("");
    const clearedRevision = draftRevision.current;
    const restore = () => {
      if (optimistic && draftRevision.current === clearedRevision)
        setDraft(value);
    };
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
            attached?.id === task.id ? undefined : attached,
          );
        if (
          contextGeneration.current !== generation ||
          contextRef.current !== (replyContext ?? undefined)
        ) {
          const consumed = isProcessReply(replyContext)
            ? recordedProcessAnswer(current.store, replyContext, command)
            : recorded;
          if (
            consumed &&
            draftRevision.current === draftOwnerRevision &&
            contextRef.current === (replyContext ?? undefined)
          ) {
            setDraft("");
            setContext(undefined);
          }
          return;
        }
        if (
          isProcessReply(replyContext)
            ? !recordedProcessAnswer(current.store, replyContext, command)
            : current.commandStates[commandTarget(command)] !== "accepted" &&
              !recorded
        ) {
          restore();
          return;
        }
        if (
          isProcessReply(replyContext)
            ? draftRevision.current === nativeSubmission.current?.draftRevision
            : draftRevision.current === draftOwnerRevision
        ) {
          setDraft("");
          setContext(undefined);
        }
      })
      .catch((error: unknown) => {
        if (
          !options.detached &&
          (contextGeneration.current !== generation ||
            contextRef.current !== (replyContext ?? undefined))
        )
          return;
        restore();
        setReplyError(
          sendErrorKey(
            error,
            isProcessReply(replyContext)
              ? "process_question_rejected"
              : "requestRejected",
          ),
        );
      });
  };

  // Earlier sessions stay on the server; live messages carry the cards.
  const messages = historySelection
    ? historyMessages.map(
        (message) =>
          (!historySelection.readOnly && online
            ? conversation?.messages.find((m) => m.id === message.id)
            : undefined) ?? message,
      )
    : (conversation?.messages ?? []);
  const work = store ? selectConversationWork(store, id) : [];
  const referencedWork = store
    ? selectPresentedWork(store, id, messages)
    : new Set<string>();
  const anchors = store
    ? selectWorkMessageAnchors(store, id, messages)
    : new Map<string, string>();
  const stale = !online || !!store?.stale || !!store?.needsSnapshot;
  // A search result opens the chat at its message (`?m=`).
  useMessageLink({
    container: contentRef,
    ready: !!historySelection && !historyLoading,
    messageIds: messages.map((m) => m.id),
    hasOlder: !!historyAfter,
    loadOlder: () => {
      const selected = historySelectionRef.current;
      if (!selected) return;
      setHistoryLoading(true);
      void readHistory(selected, true);
    },
    onFound: () => {
      following.current = false;
      setAtEnd(false);
    },
  });

  const replyToWork = (w: WorkItem) => {
    const replyInput =
      w.native?.question ?? store?.inputRequests[w.inputRequestIds[0] ?? ""];
    try {
      if (w.native?.process?.question) {
        const current = session.getSnapshot();
        if (!current.store || current.status !== "online")
          throw new Error("process_question_changed");
        setContext({
          kind: "process",
          target: captureProcessAnswerTarget(
            current.store,
            w.id,
            w.conversationId,
          ),
        });
      } else if (replyInput) setContext({ ...replyInput });
    } catch {
      setReplyError("process_question_changed");
      return;
    }
    requestAnimationFrame(() => composerRef.current?.focus());
  };
  /** An offered answer goes to its question; the composer stays as it is. */
  const answerQuestion = (question: NativeQuestion, answer: string) => {
    const current = contextRef.current;
    if (current && !isProcessReply(current) && current.id === question.id)
      setContext(undefined);
    submitMessage(answer, { ...question }, NO_DRAFT_OWNER, {
      detached: true,
      mentions: [],
    });
  };
  // The newest open question with offered answers takes the digit keys.
  const shortcutQuestion = [...work]
    .reverse()
    .find((w) => w.native?.question?.options)?.id;
  const renderWork = (w: WorkItem) => (
    <WorkCard
      key={`${w.id}:${language}`}
      session={session}
      state={state}
      work={w}
      conversationId={id}
      stale={stale}
      blocked={busy}
      onReply={
        w.native?.process?.question ||
        w.native?.question ||
        store?.inputRequests[w.inputRequestIds[0] ?? ""]
          ? () => replyToWork(w)
          : undefined
      }
      onAnswerQuestion={
        w.native?.question?.options
          ? (answer) => answerQuestion(w.native!.question!, answer)
          : undefined
      }
      questionShortcuts={w.id === shortcutQuestion && !readOnly}
    />
  );

  // A follow-up from a generated answer is put in the composer, never sent;
  // it replaces only an earlier follow-up the person hasn't changed.
  const lastFollowUp = useRef("");
  const followUp = (text: string) => {
    setContext(undefined);
    const current = draftRef.current.trim();
    const next =
      !current || current === lastFollowUp.current
        ? text
        : `${draftRef.current.trimEnd()}\n\n${text}`;
    lastFollowUp.current = text;
    setDraft(next);
    requestAnimationFrame(() => {
      const composer = composerRef.current;
      composer?.focus();
      composer?.setSelectionRange(next.length, next.length);
    });
  };
  /** An answer: its text, its generated part, then the system's own view. */
  const answer = (m: ChatMessage, system?: ReactNode, withText = true) => (
    <AssistantMessage key={m.id} label={copy.assistant}>
      {withText && <Markdown text={m.text} />}
      {m.ui && (
        <GeneratedUi
          program={m.ui.program}
          disabled={readOnly}
          onFollowUp={followUp}
        />
      )}
      {system}
    </AssistantMessage>
  );
  const renderMessage = (m: ChatMessage, index: number) => {
    if (m.role === "user")
      return (
        <UserMessage
          key={m.id}
          label={copy.you}
          task={m.humanTask?.title}
          tags={sentMentions(m.text, directory)}
        >
          {m.text}
        </UserMessage>
      );
    const current = messages.at(-1)?.id === m.id;
    const result = m.result;
    if (result?.type === "service.connection")
      return answer(
        m,
        <ServiceConnectionView
          key={`${result.serviceId}:${m.id}`}
          session={session}
          result={result}
          disabled={busy || !online || readOnly}
          online={online}
          onContinue={(text) => submitMessage(text, null)}
        />,
      );
    if (result?.type === "process.offer") {
      const request = messages
        .slice(0, index)
        .reverse()
        .find((message) => message.role === "user");
      return answer(
        m,
        <ProcessOfferView
          offer={result}
          disabled={busy || !online || !current || readOnly}
          onReview={() => {
            handOffProcessOffer(result);
            void navigate({ to: "/processes" });
          }}
          onDecline={() => {
            if (request?.text)
              submitMessage(request.text, null, undefined, {
                withoutProcess: true,
                mentions: messageMentions(
                  request.text,
                  sentMentions(request.text, directory),
                ),
              });
          }}
        />,
      );
    }
    if (result?.type === "skill.proposal")
      return answer(
        m,
        <SkillProposalView
          session={session}
          proposal={result}
          disabled={!online || readOnly}
        />,
      );
    if (result?.type === "process.proposal")
      return answer(
        m,
        <ProcessProposalView
          key={`${result.sessionId ?? "budget"}:${m.id}`}
          session={session}
          proposal={result}
          disabled={!online || readOnly}
        />,
      );
    // A card composed by an earlier model: its words only, nothing to answer.
    if (result?.type === "card.document")
      return answer(
        m,
        <p className="break-words whitespace-pre-wrap">
          {cardDocumentText(result.document)}
        </p>,
      );
    // Only a write waiting for the person's decision is a card; anything
    // else an action did, the answer tells in words, like any AI chat.
    if (
      result?.type === "service.action" &&
      result.status !== "awaiting_approval"
    )
      return m.text.trim() || m.ui ? answer(m) : null;
    if (result?.type === "service.action")
      return answer(
        m,
        <ServiceActionView
          result={result}
          disabled={busy || !online || readOnly}
          rememberTarget={
            workspace && {
              organizationId: workspace.organizationId,
              workspaceId: workspace.workspaceId,
            }
          }
          onDecide={(approved) => {
            if (!conversation) return;
            const commandId = newId();
            void session.send({
              type: "service.resolve",
              commandId,
              idempotencyKey: commandId,
              conversationId: conversation.id,
              operationId: result.operationId,
              approved,
              language,
            });
          }}
        />,
      );
    if (result?.type === "crm.contacts")
      return answer(
        m,
        <ContactList contacts={result.contacts} hasMore={result.hasMore} />,
        false,
      );
    const anchored = m.workItemId
      ? work.find((w) => w.id === m.workItemId)
      : undefined;
    if (anchored && anchors.get(anchored.id) === m.id) {
      referencedWork.add(anchored.id);
      // A finished action needs no card: the answer says what happened.
      if (
        anchored.native?.action &&
        !anchored.native.process &&
        isTerminalNativeWork(anchored)
      )
        return m.text.trim() || m.ui ? answer(m) : null;
      return answer(m, renderWork(anchored), false);
    }
    return answer(m);
  };
  /** "Again" asks the previous request once more, as a new message. */
  const again = (request: ChatMessage) =>
    submitMessage(request.text, null, NO_DRAFT_OWNER, {
      detached: true,
      mentions: messageMentions(
        request.text,
        sentMentions(request.text, directory),
      ),
    });
  /** "Edit" brings the text back to the composer; history stays as it was. */
  const editMessage = (message: ChatMessage) => {
    setContext(undefined);
    setDraft(message.text);
    setPicked(sentMentions(message.text, directory));
    requestAnimationFrame(() => {
      const composer = composerRef.current;
      composer?.focus();
      composer?.setSelectionRange(message.text.length, message.text.length);
    });
  };
  let lastUser = -1;
  messages.forEach((m, index) => {
    if (m.role === "user") lastUser = index;
  });
  function transcriptEntry(m: ChatMessage, index: number) {
    const body = renderMessage(m, index);
    const workAnchor = !!m.workItemId && anchors.get(m.workItemId) === m.id;
    if (!m.text.trim() || workAnchor || m.result?.type === "crm.contacts")
      return body;
    const request =
      m.role === "assistant" && index === messages.length - 1
        ? messages[lastUser]
        : undefined;
    return (
      <div
        key={m.id}
        data-message-id={m.id}
        className="group/message flex min-w-0 flex-col gap-1 rounded-xl transition-shadow duration-500 data-[highlighted=true]:ring-2 data-[highlighted=true]:ring-ring/50 data-[highlighted=true]:ring-offset-4 data-[highlighted=true]:ring-offset-background"
      >
        {body}
        <MessageActions
          text={m.text}
          align={m.role === "user" ? "end" : "start"}
          createdAt={m.createdAt}
          disabled={busy || !online || readOnly}
          onAgain={request ? () => again(request) : undefined}
          onEdit={
            m.role === "user" && index === lastUser && !readOnly
              ? () => editMessage(m)
              : undefined
          }
        />
      </div>
    );
  }
  // A quiet day divider where the day changes; untimed messages start none.
  const days = messageDays(messages);
  const transcript = messages.flatMap((m, index) => {
    const day = days[index];
    return day === undefined
      ? [transcriptEntry(m, index)]
      : [
          <DaySeparator key={`day:${m.id}`} day={day} />,
          transcriptEntry(m, index),
        ];
  });
  const trailingWork = work.filter(
    (w) =>
      !referencedWork.has(w.id) &&
      (!!w.native?.process || !isTerminalNativeWork(w)),
  );
  const pendingMessage = selectPendingChatMessage(state, id);
  const progressVisible =
    state.pending?.type === "message.send" &&
    state.pending.conversationId === id;
  const retryable = canRetryPending(state);
  const processAnnouncement = selectProcessCommandNotice(state, noticeOwner);
  const errorKey = chatErrorKey(
    replyError,
    processAnnouncement,
    state.error,
    isProcessReply(context),
  );
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
  const hasConversation =
    messages.length > 0 || trailingWork.length > 0 || !!pendingMessage;
  const composerDisabled =
    !online || !valid || historyLoading || (!!context && !validContext);
  const tooLong = draft.trim().length > MAX_MESSAGE_LENGTH;
  const canSend =
    !!draft.trim() && !tooLong && !busy && !composerDisabled && !readOnly;
  const stoppable = progressVisible || state.pending?.type === "process.answer";
  const title = conversationTitle(historySelection?.title ?? "");
  const showHome =
    !(historyLoading && !historySelection) &&
    !hasConversation &&
    !busy &&
    unsaved;
  useLayoutEffect(() => {
    homeShown.current = showHome;
  }, [showHome]);
  // Esc stops a running answer, wherever the focus is outside a menu.
  const onWindowKey = useEffectEvent((event: KeyboardEvent) => {
    // Ctrl/Cmd+Shift+O (a new chat, from the shell) on a new chat just
    // focuses it.
    if (
      (event.metaKey || event.ctrlKey) &&
      event.shiftKey &&
      event.key.toLowerCase() === "o" &&
      unsaved
    ) {
      composerRef.current?.focus();
      return;
    }
    if (
      event.key !== "Escape" ||
      event.defaultPrevented ||
      !stoppable ||
      !online ||
      (event.target as Partial<Element> | null)?.closest?.(
        "[role=dialog],[role=menu],[role=listbox]",
      )
    )
      return;
    event.preventDefault();
    void session.interruptPending();
  });
  useEffect(() => listenForKeys((event) => onWindowKey(event)), []);
  // A new chat on a desktop is ready to type into.
  useEffect(() => {
    if (!routeId && window.matchMedia?.("(pointer: fine)").matches)
      composerRef.current?.focus();
  }, [routeId]);
  // Browsers without field-sizing still grow the field with its text.
  useLayoutEffect(() => {
    const composer = composerRef.current;
    if (
      !composer ||
      typeof CSS === "undefined" ||
      CSS.supports?.("field-sizing", "content")
    )
      return;
    composer.style.setProperty("height", "auto");
    composer.style.setProperty("height", `${composer.scrollHeight}px`);
  }, [draft]);

  if (!valid)
    return (
      <div className="mx-auto w-full max-w-4xl p-4 md:p-8">
        <Alert variant="destructive">
          <AlertDescription>{copy.chatUnavailable}</AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" asChild>
              <Link to="/chat">{copy.newChat}</Link>
            </Button>
          </AlertAction>
        </Alert>
      </div>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <h1 className="sr-only">{title || copy.newChat}</h1>
      <div
        ref={scrollRef}
        onScroll={(event) => {
          const target = event.currentTarget;
          following.current =
            target.scrollHeight - target.clientHeight - target.scrollTop < 80;
          setAtEnd(following.current);
        }}
        // Both edges keep the gutter, so the column centres like the composer.
        data-chat-scroller
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div
          ref={contentRef}
          className="mx-auto flex min-h-full w-full max-w-4xl flex-col gap-6 px-4 py-6 md:px-6 md:py-10"
        >
          {readOnly && (
            <div className="flex justify-center">
              <StatusBadge tone="neutral">{tr("archivedChat")}</StatusBadge>
            </div>
          )}
          {historyAfter && (
            <Button
              variant="ghost"
              size="sm"
              className="self-center"
              disabled={historyLoading || !online}
              onClick={() => {
                following.current = false;
                const selected = historySelectionRef.current;
                if (!selected) return;
                setHistoryLoading(true);
                void readHistory(selected, true);
              }}
            >
              {tr("earlierChatMessages")}
            </Button>
          )}
          {historyError && (
            <Alert variant="destructive">
              <AlertDescription>{copy.chatUnavailable}</AlertDescription>
              <AlertAction>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!online}
                  onClick={() => {
                    setHistoryLoading(true);
                    setHistoryError(false);
                    void readHistory(
                      historySelectionRef.current ?? { id, revision: 0 },
                    );
                  }}
                >
                  <RefreshCw data-icon="inline-start" aria-hidden="true" />
                  {copy.retry}
                </Button>
              </AlertAction>
            </Alert>
          )}
          {historyLoading && !historySelection ? (
            <div
              role="status"
              aria-label={copy.loadingChat}
              className="flex flex-col gap-6"
            >
              <Skeleton className="ml-auto h-10 w-2/3 max-w-sm" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-10 w-1/2" />
            </div>
          ) : showHome ? (
            <Home
              session={session}
              onSuggestion={(text) => {
                setDraft(text);
                requestAnimationFrame(() => composerRef.current?.focus());
              }}
            />
          ) : (
            <div role="log" className="flex flex-col gap-6">
              {transcript}
              {pendingMessage && (
                <UserMessage label={copy.you} pending>
                  {pendingMessage.kind === "answer" && (
                    <span className="block text-xs text-muted-foreground">
                      {tr("process_question_pending")}
                    </span>
                  )}
                  {pendingMessage.text}
                </UserMessage>
              )}
              {trailingWork.map((w) => (
                <AssistantMessage key={w.id} label={copy.assistant}>
                  {renderWork(w)}
                </AssistantMessage>
              ))}
              {progressVisible && (
                <AssistantMessage label={copy.assistant}>
                  <ProgressView
                    onToggle={holdScrollOnce}
                    activity={state.activity}
                    connection={state.activityConnection}
                    failed={!!state.error?.startsWith("model_")}
                    interrupted={
                      !online ||
                      Object.values(state.commandStates).includes(
                        "network_error",
                      )
                    }
                    onRetry={
                      retryable
                        ? () => void session.retry(noticeOwner)
                        : undefined
                    }
                    retryDisabled={!online}
                  />
                </AssistantMessage>
              )}
            </div>
          )}
          {(state.answerAttempts ?? []).map((attempt) => {
            let canReview = false;
            if (online && store && !busy && attempt.outcome !== "unknown") {
              try {
                assertProcessAnswerTarget(store, attempt.target);
                canReview = true;
              } catch {
                // A retained answer cannot silently move to a later question.
              }
            }
            const notice =
              state.processNotice?.notice.commandId ===
              attempt.command.commandId
                ? state.processNotice
                : undefined;
            const noticeCopy = notice
              ? notice.errorSource.kind === "local"
                ? tr(notice.errorSource.code)
                : (() => {
                    const selected = processNoticeCopy(notice.notice);
                    return selected
                      ? tr(selected.key) +
                          (selected.detailKey
                            ? ` ${tr(selected.detailKey)}`
                            : "")
                      : undefined;
                  })()
              : attempt.outcome === "accepted"
                ? tr("processResultUnavailable")
                : attempt.error
                  ? tr(
                      sendErrorKey(
                        new Error(attempt.error),
                        "process_question_rejected",
                      ),
                    )
                  : undefined;
            return (
              <AnswerRecoveryView
                key={attempt.command.commandId}
                question={attempt.target.question.question}
                answer={attempt.command.answer}
                outcome={attempt.outcome}
                explanation={noticeCopy}
                canReview={canReview}
                canRetry={
                  !state.answerRecoveryBlocked &&
                  online &&
                  state.pending?.commandId === attempt.command.commandId &&
                  state.commandStates[commandTarget(attempt.command)] !==
                    "sending"
                }
                canDiscard={!state.answerRecoveryBlocked}
                onRetry={() => void session.retry(noticeOwner)}
                onReview={() => {
                  const current = session.getSnapshot();
                  if (
                    !current.store ||
                    current.answerRecoveryBlocked ||
                    current.status !== "online" ||
                    current.pending
                  )
                    return;
                  try {
                    assertProcessAnswerTarget(current.store, attempt.target);
                  } catch {
                    setReplyError("process_question_changed");
                    return;
                  }
                  if (attempt.target.conversationId !== id) {
                    void navigate({
                      to: "/chat/$conversationId",
                      params: { conversationId: attempt.target.conversationId },
                    });
                    return;
                  }
                  setContext(
                    Object.freeze({ kind: "process", target: attempt.target }),
                  );
                  setDraft(attempt.command.answer);
                  composerRef.current?.focus();
                }}
                onDiscard={() =>
                  void session.discardProcessAnswerAttempt(
                    attempt.command.commandId,
                  )
                }
              />
            );
          })}
        </div>
      </div>
      <div className="relative bg-background">
        {/* The transcript fades out behind the composer as it scrolls. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-full mx-auto h-10 max-w-4xl bg-linear-to-t from-background to-transparent"
        />
        {!atEnd && hasConversation && !showHome && (
          <div className="pointer-events-none absolute inset-x-0 bottom-full flex justify-center pb-3">
            <Button
              variant="outline"
              size="icon-sm"
              className="pointer-events-auto"
              aria-label={copy.scrollToBottom}
              onClick={() => {
                const scroller = scrollRef.current;
                if (!scroller) return;
                following.current = true;
                scroller.scrollTo({
                  top: scroller.scrollHeight,
                  behavior: "smooth",
                });
              }}
            >
              <ArrowDown aria-hidden="true" />
            </Button>
          </div>
        )}
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-2 px-4 pb-4 md:px-6 md:pb-6">
          {state.answerRecoveryBlocked && (
            <Alert variant="destructive">
              <AlertDescription>
                {tr("savedProcessAnswerStorageBlocked")}
              </AlertDescription>
              <AlertAction>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void session.refresh()}
                >
                  {tr("refresh")}
                </Button>
              </AlertAction>
            </Alert>
          )}
          {processAnnouncement.notice && (
            <Alert
              variant={
                processAnnouncement.notice.error ? "destructive" : "default"
              }
              data-testid="process-command-notice"
            >
              <AlertDescription>
                {tr(processAnnouncement.notice.key)}
                {processAnnouncement.notice.detailKey
                  ? ` ${tr(processAnnouncement.notice.detailKey)}`
                  : ""}
              </AlertDescription>
            </Alert>
          )}
          {errorKey && (
            <Alert variant="destructive" data-testid="chat-error">
              <AlertDescription>{tr(errorKey)}</AlertDescription>
              {!progressVisible &&
                (retryable || (!!draft.trim() && !busy && online)) && (
                  <AlertAction>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!online}
                      onClick={() =>
                        retryable
                          ? void session.retry(noticeOwner)
                          : submitMessage()
                      }
                    >
                      <RefreshCw data-icon="inline-start" aria-hidden="true" />
                      {copy.retry}
                    </Button>
                  </AlertAction>
                )}
            </Alert>
          )}
          {state.status !== "online" && (
            <p
              role="status"
              className="text-center text-xs text-muted-foreground"
            >
              {copy.offline}
            </p>
          )}
          {readOnly ? (
            <div
              data-testid="read-only-composer"
              className="flex flex-wrap items-center justify-center gap-3 rounded-lg border px-4 py-3 text-sm text-muted-foreground"
            >
              <span>{restoreError ? tr(restoreError) : copy.readOnly}</span>
              <Button size="sm" variant="outline" asChild>
                <Link to="/chat">
                  <SquarePen data-icon="inline-start" aria-hidden="true" />
                  {copy.newChat}
                </Link>
              </Button>
              <Button
                size="sm"
                disabled={!online || restoring}
                onClick={() => void restoreChat()}
              >
                <ArchiveRestore data-icon="inline-start" aria-hidden="true" />
                {tr("restoreChat")}
              </Button>
            </div>
          ) : (
            <form
              className="relative"
              onSubmit={(event) => {
                event.preventDefault();
                submitMessage();
                // The send button keeps nothing; the next message goes on.
                composerRef.current?.focus();
              }}
            >
              {pickerOpen && (
                <MentionPicker
                  id={pickerId}
                  items={pickerItems}
                  active={pickerActive}
                  onPick={pickMention}
                  onHover={(index) =>
                    setPicker((current) =>
                      current ? { ...current, active: index } : current,
                    )
                  }
                />
              )}
              <InputGroup>
                {context ? (
                  <InputGroupAddon align="block-start">
                    <CornerDownRight aria-hidden="true" />
                    <InputGroupText>
                      <span className="line-clamp-2 min-w-0 font-normal">
                        <span className="text-muted-foreground">
                          {tr(
                            waitingForProcessAnswer
                              ? "process_question_pending"
                              : validContext
                                ? "replyTo"
                                : "inputContextChanged",
                          )}
                          {": "}
                        </span>
                        {isProcessReply(context)
                          ? context.target.question.question
                          : context.question}
                      </span>
                    </InputGroupText>
                    <InputGroupButton
                      size="icon-xs"
                      className="ml-auto"
                      aria-label={tr("clearContext")}
                      onClick={() => {
                        if (isProcessReply(context)) setDraft("");
                        setContext(undefined);
                      }}
                    >
                      <X aria-hidden="true" />
                    </InputGroupButton>
                  </InputGroupAddon>
                ) : attachedTask ? (
                  <InputGroupAddon
                    align="block-start"
                    data-testid="composer-task"
                  >
                    <ClipboardList aria-hidden="true" />
                    <InputGroupText>
                      <span className="line-clamp-1 min-w-0 font-normal">
                        <span className="text-muted-foreground">
                          {tr("humanTaskAttached")}
                          {": "}
                        </span>
                        {attachedTask.title}
                      </span>
                    </InputGroupText>
                    <InputGroupButton
                      size="icon-xs"
                      className="ml-auto"
                      aria-label={tr("humanTaskDetach")}
                      onClick={() => setAttachedTask(undefined)}
                    >
                      <X aria-hidden="true" />
                    </InputGroupButton>
                  </InputGroupAddon>
                ) : null}
                {chips.length > 0 && (
                  <InputGroupAddon align="block-start">
                    <MentionChips
                      items={chips}
                      onRemove={(item) => {
                        setDraft(removeMention(draftRef.current, item));
                        setPicked((current) =>
                          current.filter(
                            (c) => c.kind !== item.kind || c.id !== item.id,
                          ),
                        );
                        composerRef.current?.focus();
                      }}
                    />
                  </InputGroupAddon>
                )}
                <InputGroupTextarea
                  ref={composerRef}
                  aria-label={copy.placeholder}
                  placeholder={copy.placeholder}
                  rows={1}
                  value={draft}
                  disabled={composerDisabled}
                  className="max-h-48"
                  aria-invalid={tooLong || undefined}
                  {...(directory.length
                    ? {
                        role: "combobox",
                        "aria-autocomplete": "list" as const,
                        "aria-expanded": pickerOpen,
                        "aria-controls": pickerOpen ? pickerId : undefined,
                        "aria-activedescendant": pickerOpen
                          ? mentionOptionId(pickerId, pickerActive)
                          : undefined,
                      }
                    : {})}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    trackMention(
                      event.target.value,
                      event.target.selectionStart ?? event.target.value.length,
                    );
                  }}
                  onSelect={(event) => {
                    const target = event.currentTarget;
                    if (picker || target.value.includes("@"))
                      trackMention(
                        target.value,
                        target.selectionStart ?? target.value.length,
                      );
                  }}
                  onBlur={() => setPicker(null)}
                  onKeyDown={(event) => {
                    if (pickerOpen) {
                      const move =
                        event.key === "ArrowDown"
                          ? 1
                          : event.key === "ArrowUp"
                            ? -1
                            : 0;
                      if (move) {
                        event.preventDefault();
                        setPicker((current) =>
                          current
                            ? {
                                ...current,
                                active:
                                  (pickerActive + move + pickerItems.length) %
                                  pickerItems.length,
                              }
                            : current,
                        );
                        return;
                      }
                      if (
                        (event.key === "Enter" && !event.shiftKey) ||
                        event.key === "Tab"
                      ) {
                        event.preventDefault();
                        pickMention(pickerItems[pickerActive]!);
                        return;
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setPicker(null);
                        return;
                      }
                    }
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      submitMessage();
                    }
                  }}
                />
                {/* Tagging on the left, send on the right, under the text. */}
                <InputGroupAddon align="block-end">
                  {directory.length > 0 && (
                    <InputGroupButton
                      type="button"
                      size="icon-sm"
                      aria-label={copy.mentionPicker}
                      disabled={composerDisabled || readOnly}
                      // The textarea keeps the focus and the caret.
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={startMention}
                    >
                      <AtSign aria-hidden="true" />
                    </InputGroupButton>
                  )}
                  {stoppable ? (
                    <InputGroupButton
                      type="button"
                      variant="default"
                      size="icon-sm"
                      className="ml-auto"
                      aria-label={
                        state.error === "requestInterruptFailed"
                          ? copy.stopRetry
                          : copy.stop
                      }
                      disabled={!online}
                      onClick={() => void session.interruptPending()}
                    >
                      <Square aria-hidden="true" />
                    </InputGroupButton>
                  ) : (
                    <InputGroupButton
                      type="submit"
                      variant={canSend ? "default" : "secondary"}
                      size="icon-sm"
                      className="ml-auto"
                      aria-label={copy.send}
                      // Not `disabled`: a disabled control greys the whole field.
                      aria-disabled={!canSend}
                    >
                      <ArrowUp aria-hidden="true" />
                    </InputGroupButton>
                  )}
                </InputGroupAddon>
              </InputGroup>
              {tooLong && (
                <p role="alert" className="pt-1 text-xs text-destructive">
                  {copy.tooLong}
                </p>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

function Welcome({
  onSuggestion,
}: {
  session: ClientSession;
  onSuggestion: (text: string) => void;
}) {
  const { copy } = useChatCopy();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 py-12 text-center">
      <p className="text-2xl font-semibold tracking-tight">{copy.greeting}</p>
      <div className="flex flex-wrap justify-center gap-2">
        {copy.suggestions.map((suggestion) => (
          <Button
            key={suggestion}
            variant="outline"
            size="sm"
            onClick={() => onSuggestion(suggestion)}
          >
            {suggestion}
          </Button>
        ))}
      </div>
    </div>
  );
}

function UserMessage({
  label,
  task,
  tags = [],
  pending = false,
  children,
}: {
  label: string;
  task?: string;
  /** What the message tagged with "@". */
  tags?: readonly MentionItem[];
  pending?: boolean;
  children: ReactNode;
}) {
  return (
    <article
      aria-label={label}
      data-testid={pending ? "pending-message" : undefined}
      className="flex flex-col items-end gap-1 pl-10 sm:pl-16"
    >
      {task && (
        <span className="flex max-w-full items-center gap-1.5 text-xs text-muted-foreground">
          <ClipboardList aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate">{task}</span>
        </span>
      )}
      <MessageTags items={tags} />
      <div
        data-pending={pending}
        className="max-w-full rounded-2xl bg-muted px-4 py-2.5 text-sm break-words whitespace-pre-wrap data-[pending=true]:opacity-60"
      >
        {children}
      </div>
    </article>
  );
}

function AssistantMessage({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <article aria-label={label} className="flex min-w-0 flex-col gap-3">
      {children}
    </article>
  );
}
