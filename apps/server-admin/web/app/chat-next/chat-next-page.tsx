import {
  useWebAttachments,
  WebAttachmentMenu,
  WebAttachmentDraft,
  WebMessageAttachments,
  type WebAttachments,
} from "./attachment-controls";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
  useExternalStoreRuntime,
  useThreadViewport,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import {
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  AtSign,
  CircleAlert,
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
import { StatusBadge } from "@admin/components/console/status";
import {
  ClientSession,
  commandTarget,
  type SessionCommand,
  type SessionState,
} from "../../../../../packages/client-core/session";
import { messageCommand } from "../../../../../packages/client-core/commands";
import {
  canRetryPending,
  chatErrorKey,
  chatOwnsError,
  isUserMessageRecorded,
  runningChat,
  selectPendingChatMessage,
} from "../../../../../packages/client-core/chat-view";
import {
  isProcessReply,
  recordedProcessAnswer,
  type ReplyContext,
} from "../../../../../packages/client-core/reply-context";
import {
  assertProcessAnswerTarget,
  captureProcessAnswerTarget,
  processAnswerCommand,
  type ProcessAnswerTarget,
} from "../../../../../packages/client-core/process-answers";
import {
  captureProcessNoticeOwner,
  isReservedProcessRecoveryCopy,
  processNoticeCopy,
  selectProcessCommandNotice,
} from "../../../../../packages/client-core/process-command-notice";
import {
  isTerminalNativeWork,
  selectConversationWork,
  selectPresentedWork,
  selectReplyInput,
  selectWorkMessageAnchors,
} from "../../../../../packages/client-core/store";
import { conversationTitle } from "../../../../../packages/client-core/conversation-title";
import { en, type TranslationKey } from "../../../../../packages/i18n";
import type {
  Conversation,
  ConversationSummary,
  HumanTaskReference,
  NativeQuestion,
  WorkItem,
} from "../../../../../packages/protocol";
import { ACTIVITY_DRAFT_MAX } from "../../../../../packages/protocol/activity";
import type { MessageMention } from "../../../../../packages/protocol/mentions";
import type { ProcessOfferResult } from "../../../../../packages/protocol/process-offer";
import { useApp, useAppSession } from "../context";
import {
  AnswerRecoveryView,
  humanizeLabel,
  liveStepService,
  useElapsedSeconds,
} from "../chat-work";
import { loopsCopy } from "../../loops-copy";
import type { AnswerStreamStep } from "../../../../../packages/protocol/answer-stream";
import { chatChangeError, useChatCopy } from "../chat-copy";
import { useMessageLink } from "../message-link";
import {
  UNSAVED_DRAFT,
  chatHistoryKey,
  draftKey,
  readDraft,
  saveDraft,
} from "../chat-store";
import { handOffProcessOffer } from "../offer-handoff";
import { takeHumanTask } from "../task-handoff";
import { useSessionState } from "../menu-page";
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
} from "../chat-composer";
import {
  DaySeparator,
  MessageActions,
  messageDays,
} from "../chat-message-actions";
import { listenForKeys } from "../chat-question";
import {
  NextChatProvider,
  NextWorkCard,
  assistantParts,
  useNextChat,
  userParts,
  type NextChat,
} from "./parts";
import {
  appendedText,
  liveMessage,
  nextMeta,
  pendingMessage,
  storedMessage,
  streamedApproval,
  threadText,
  type ChatMessage,
  TOOL,
} from "./transport";

/**
 * The chat rebuilt on assistant-ui (NIAR-228), next to the classic one. The
 * session is the thread's external store: its stored messages, the person's
 * message on its way and the streamed answer are the thread's messages; the
 * composer, the parts and the viewport are assistant-ui's. Everything the
 * chat sends still goes through the session's commands, so idempotency,
 * retry, offline and the server's authority are as before.
 */
const newId = () => crypto.randomUUID();
const validConversationId = (id: string) => /^[a-zA-Z0-9._:-]{1,160}$/.test(id);
const CHAT_PREFIX = "chat-";
const COUNTER_FROM = 3500;
const sameMessage = (message: ThreadMessageLike) => message;

/** The next chat at "/chat" and "/chat/$id", with the classic page's rules. */
export function ChatNextPage() {
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
    <ChatNextConversation
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
const chatWording: Partial<Record<TranslationKey, TranslationKey>> = {
  requestRejected: "chatRequestFailed",
  connection_failed: "chatServerUnreachable",
  storage_error: "chatSendFailed",
  network_error: "chatConnectionLost",
};

export function ChatNextConversation({
  session,
  routeId,
  onSaved,
}: {
  session: ClientSession;
  /** Absent for a new chat that exists only on this page. */
  routeId?: string;
  onSaved: (id: string) => void;
}) {
  const { language, workspace } = useApp();
  const { copy, tr } = useChatCopy();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const state = useSessionState(session);
  const [id] = useState(
    () => routeId ?? `${CHAT_PREFIX}${crypto.randomUUID()}`,
  );
  const valid = validConversationId(id);
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
      task: handed ?? saved?.task,
      mentions: saved?.mentions ?? [],
    };
  });
  // The text lives in assistant-ui's composer; this mirror serves the page's
  // own needs (the saved draft, putting a refused message back).
  const draftRef = useRef(initial.text);
  const draftRevision = useRef(0);
  // Whether the composer holds text: a refused message offers "Try again".
  const [hasDraft, setHasDraft] = useState(!!initial.text.trim());
  const noteDraft = useCallback((text: string) => {
    draftRevision.current++;
    draftRef.current = text;
    setHasDraft(!!text.trim());
  }, []);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [context, setContextState] = useState<ReplyContext | undefined>(
    initial.context,
  );
  const contextRef = useRef<ReplyContext | undefined>(initial.context);
  // A typed answer to a process question that the server accepted but has
  // not recorded yet: the question stays above the composer until it does.
  const [answerCaption, setAnswerCaption] = useState<{
    context: ReplyContext;
    target: string;
    command: SessionCommand;
  }>();
  const [replyError, setReplyError] = useState<TranslationKey | null>(null);
  const setContext = useCallback((next: ReplyContext | undefined) => {
    contextRef.current = next;
    setContextState(next);
    setAnswerCaption(undefined);
    setReplyError(null);
  }, []);
  const [attachedTask, setAttachedTask] = useState<
    HumanTaskReference | undefined
  >(initial.task ?? undefined);
  const attachedTaskRef = useRef(attachedTask);
  useLayoutEffect(() => {
    attachedTaskRef.current = attachedTask;
  }, [attachedTask]);
  const directory = useMentionDirectory(session);
  const [picked, setPicked] = useState<MentionItem[]>(initial.mentions);
  const pickedRef = useRef(picked);
  useLayoutEffect(() => {
    pickedRef.current = picked;
  }, [picked]);

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
  const contentRef = useRef<HTMLDivElement>(null);

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
    const reads = historyReadGeneration;
    return () => {
      historyRead.current?.abort();
      reads.current++;
      saveDraft(
        draftKey(session.identityKey, unsavedRef.current ? UNSAVED_DRAFT : id),
        {
          text: draftRef.current,
          context: contextRef.current,
          revision: 0,
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
  const attachmentGeneration =
    state.store?.conversations[id]?.attachmentGeneration ??
    historySelection?.attachmentGeneration ??
    null;
  const attachments = useWebAttachments(
    session,
    id,
    attachmentGeneration,
    language,
  );
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

  const runtimeRef = useRef<ReturnType<typeof useExternalStoreRuntime>>(null);
  const setComposerText = (text: string) => {
    noteDraft(text);
    runtimeRef.current?.thread.composer.setText(text);
  };
  /**
   * Sends a message. The composer's own text has left it already (assistant-ui
   * resets it on send); a send the server does not accept puts the text
   * back unless something new was typed meanwhile.
   */
  const submitMessage = (
    value: string,
    replyContext: ReplyContext | null | undefined = contextRef.current,
    options: {
      withoutProcess?: true;
      mentions?: MessageMention[];
      /** From a card or an action, not the composer: nothing is put back. */
      detached?: true;
      withAttachments?: true;
    } = {},
  ): void => {
    const text = value.trim();
    const attachmentEntries = session.attachments?.getSnapshot().entries ?? [];
    const attachmentReady = !!session.attachments?.ready;
    if (
      (!text && !attachmentReady) ||
      (attachmentEntries.length > 0 &&
        (!attachmentReady ||
          !!replyContext ||
          (!!options.detached && !options.withAttachments))) ||
      text.length > MAX_MESSAGE_LENGTH ||
      busy ||
      !online ||
      readOnly ||
      !valid ||
      (historyLoading && !options.detached)
    ) {
      if (!options.detached && !draftRef.current.trim()) setComposerText(value);
      return;
    }
    setReplyError(null);
    const mentions = options.mentions ?? messageMentions(value, picked);
    if (!replyContext && unsavedRef.current) {
      void saveChat()
        .then((saved) => {
          if (saved) submitMessage(value, null, { ...options, mentions });
        })
        .catch(() => {
          if (alive.current) {
            if (!options.detached && !draftRef.current.trim())
              setComposerText(value);
            setReplyError("chatSendFailed");
          }
        });
      return;
    }
    const task =
      !replyContext && !options.detached ? attachedTaskRef.current : undefined;
    const commandId = newId();
    const processReply = isProcessReply(replyContext);
    let command: SessionCommand;
    try {
      command = isProcessReply(replyContext)
        ? // A typed answer to a process question goes to that question's
          // exact revision; the target was captured when the reply started.
          processAnswerCommand(
            session.getSnapshot().store!,
            replyContext.target,
            {
              commandId,
              idempotencyKey: commandId,
              answer: text,
              language,
            },
          )
        : {
            ...messageCommand(
              text,
              language,
              commandId,
              replyContext ?? undefined,
              attachmentEntries.length
                ? session.attachments.takeForSend()
                : undefined,
            ),
            ...(replyContext ? {} : { conversationId: id }),
            ...(task ? { humanTask: task } : {}),
            ...(!replyContext && options.withoutProcess
              ? { withoutProcess: true as const }
              : {}),
            ...(mentions.length ? { mentions } : {}),
          };
    } catch {
      if (!options.detached && !draftRef.current.trim()) setComposerText(value);
      setReplyError("process_question_changed");
      return;
    }
    if (!processReply)
      rememberMentions(
        value,
        [...picked, ...sentMentions(value, directory)],
        mentions,
      );
    const restore = () => {
      if (!options.detached && !draftRef.current.trim()) setComposerText(value);
    };
    const attachmentCaptionRevision = options.withAttachments
      ? draftRevision.current
      : undefined;
    void session
      .send(command, false, undefined, noticeOwner)
      .then(() => {
        const current = session.getSnapshot();
        const accepted =
          current.commandStates[commandTarget(command)] === "accepted";
        if (processReply) {
          if (!accepted) {
            restore();
            return;
          }
          // The question stays shown until the run records the answer.
          if (contextRef.current === replyContext)
            setAnswerCaption({
              context: replyContext!,
              target: commandTarget(command),
              command,
            });
          return;
        }
        const recorded = isUserMessageRecorded(current.store, command);
        if (task && (recorded || accepted))
          setAttachedTask((attached) =>
            attached?.id === task.id ? undefined : attached,
          );
        if (!accepted && !recorded) {
          restore();
          return;
        }
        if (
          attachmentCaptionRevision !== undefined &&
          alive.current &&
          draftRevision.current === attachmentCaptionRevision
        )
          setComposerText("");
        if (contextRef.current === (replyContext ?? undefined))
          setContext(undefined);
      })
      .catch((error: unknown) => {
        restore();
        setReplyError(
          sendErrorKey(
            error,
            processReply ? "process_question_rejected" : "chatSendFailed",
          ),
        );
      });
  };
  // The accepted process answer retires its question once the run records
  // it exactly; a lost or refused one is offered for review below the thread.
  useEffect(() => {
    if (!answerCaption || contextRef.current !== answerCaption.context) return;
    if (
      !recordedProcessAnswer(
        state.store,
        answerCaption.context,
        answerCaption.command,
      )
    )
      return;
    // After this render, so the record and the cleared question do not
    // cascade in one commit.
    const clear = setTimeout(() => {
      if (alive.current && contextRef.current === answerCaption.context)
        setContext(undefined);
    }, 0);
    return () => clearTimeout(clear);
  }, [state.store, answerCaption, setContext]);

  const live = historySelection && !historySelection.readOnly && online;
  const conversationMessages = conversation?.messages;
  // Memoised on their real inputs: the session publishes on every streamed
  // chunk, and assistant-ui caches converted messages by object identity.
  const messages: ChatMessage[] = useMemo(() => {
    const liveMessages = conversationMessages ?? [];
    const lastRead = historyMessages.at(-1)?.id;
    const lastReadAt = liveMessages.findIndex((m) => m.id === lastRead);
    const newer =
      live && (lastReadAt >= 0 || !historyMessages.length)
        ? liveMessages.slice(lastReadAt + 1)
        : [];
    return historySelection
      ? [
          ...historyMessages.map(
            (message) =>
              (live
                ? liveMessages.find((m) => m.id === message.id)
                : undefined) ?? message,
          ),
          ...newer,
        ]
      : liveMessages;
  }, [historySelection, historyMessages, conversationMessages, live]);
  const work = useMemo(
    () => (store ? selectConversationWork(store, id) : []),
    [store, id],
  );
  const stale = !online || !!store?.stale || !!store?.needsSnapshot;
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
    // The viewport follows the end only while the person is there, so a
    // linked message scrolled into view stays put on its own.
    onFound: () => {},
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
      else return;
    } catch {
      setReplyError("process_question_changed");
      return;
    }
    requestAnimationFrame(() => composerRef.current?.focus());
  };
  const answerQuestion = (question: NativeQuestion, answer: string) => {
    const current = contextRef.current;
    if (current && !isProcessReply(current) && current.id === question.id)
      setContext(undefined);
    submitMessage(answer, { ...question }, { detached: true, mentions: [] });
  };
  const shortcutQuestion = [...work]
    .reverse()
    .find((w) => w.native?.question?.options)?.id;
  const lastFollowUp = useRef("");
  const followUp = (text: string) => {
    setContext(undefined);
    const current = draftRef.current.trim();
    const next =
      !current || current === lastFollowUp.current
        ? text
        : `${draftRef.current.trimEnd()}\n\n${text}`;
    lastFollowUp.current = text;
    setComposerText(next);
    requestAnimationFrame(() => {
      const composer = composerRef.current;
      composer?.focus();
      composer?.setSelectionRange(next.length, next.length);
    });
  };
  const reuseMessage = async (text: string, sourceMessageId?: string) => {
    const source = sourceMessageId
      ? messages.find(
          (message) =>
            message.id === sourceMessageId && message.role === "user",
        )
      : undefined;
    if (session.attachments?.getSnapshot().entries.length) {
      setReplyError("chatSendFailed");
      throw new Error("attachment_stale");
    }
    if (source?.attachments?.length) {
      if (contextRef.current || readOnly || !online || busy) {
        setReplyError("chatSendFailed");
        throw new Error("attachment_stale");
      }
      // Own the full source intent before a pin can fail. File Retry never sends.
      setContext(undefined);
      setComposerText(text);
      setPicked(sentMentions(text, directory));
      const revision = draftRevision.current;
      const target = session.attachments.getSnapshot().target;
      const current = () =>
        alive.current &&
        draftRevision.current === revision &&
        !contextRef.current &&
        session.attachments.getSnapshot().target === target;
      try {
        await session.attachments.reuse({
          conversationId: id,
          messageId: source.id,
          files: source.attachments,
        });
      } catch (error) {
        if (current()) setReplyError("chatSendFailed");
        throw error;
      }
      return { withAttachments: true, current };
    }
    return { withAttachments: false, current: () => alive.current };
  };
  const again = (requestText: string, sourceMessageId?: string) => {
    void reuseMessage(requestText, sourceMessageId)
      .then(({ withAttachments, current }) => {
        if (!current()) return;
        submitMessage(requestText, null, {
          detached: true,
          ...(withAttachments ? { withAttachments: true as const } : {}),
          mentions: messageMentions(
            requestText,
            sentMentions(requestText, directory),
          ),
        });
      })
      .catch(() => {});
  };
  const editMessage = (text: string, sourceMessageId?: string) => {
    void reuseMessage(text, sourceMessageId)
      .then(({ withAttachments, current }) => {
        if (!current()) return;
        if (!withAttachments) {
          setContext(undefined);
          setComposerText(text);
          setPicked(sentMentions(text, directory));
        }
        requestAnimationFrame(() => {
          if (!current() && withAttachments) return;
          const composer = composerRef.current;
          composer?.focus();
          composer?.setSelectionRange(text.length, text.length);
        });
      })
      .catch(() => {});
  };
  const decide = async (operationId: string, approved: boolean) => {
    if (!conversation) return false;
    const commandId = newId();
    await session.send({
      type: "service.resolve",
      commandId,
      idempotencyKey: commandId,
      conversationId: conversation.id,
      operationId,
      approved,
      language,
    });
    return session.getSnapshot().commandStates[operationId] === "accepted";
  };

  // The thread: stored messages with the day they start, the message on its
  // way and the answer being written.
  const pending = selectPendingChatMessage(state, id);
  // The run continues after an approval: its draft and steps are shown the
  // same way as the message's own run.
  const progressCommand =
    (state.pending?.type === "message.send" ||
      state.pending?.type === "service.resolve") &&
    state.pending.conversationId === id
      ? state.pending
      : null;
  const retryable = canRetryPending(state, id);
  const modelFailed = !!progressCommand && !!state.error?.startsWith("model_");
  const requestInterrupted =
    !!progressCommand &&
    (!online ||
      state.commandStates[commandTarget(progressCommand)] === "network_error");
  const progressHint =
    modelFailed && state.error! in en
      ? tr(state.error as TranslationKey)
      : requestInterrupted && retryable
        ? tr("chatConnectionLost")
        : undefined;
  const approval =
    state.activityApproval &&
    state.activity?.conversationId === id &&
    !messages.some(
      (m) =>
        m.result?.type === "service.action" &&
        m.result.operationId === state.activityApproval!.operationId,
    )
      ? streamedApproval(state.activityApproval)
      : undefined;
  const { threadMessages, trailingWork } = useMemo(() => {
    const anchors = store
      ? selectWorkMessageAnchors(store, id, messages)
      : new Map<string, string>();
    const referenced = store
      ? selectPresentedWork(store, id, messages)
      : new Set<string>();
    const days = messageDays(messages);
    let lastUser = -1;
    messages.forEach((m, index) => {
      if (m.role === "user") lastUser = index;
    });
    const thread: ThreadMessageLike[] = [];
    messages.forEach((m, index) => {
      const anchored = m.workItemId
        ? work.find((w) => w.id === m.workItemId)
        : undefined;
      const anchorsHere = !!anchored && anchors.get(anchored.id) === m.id;
      if (anchorsHere) referenced.add(anchored.id);
      const request =
        m.role === "assistant"
          ? messages
              .slice(0, index)
              .reverse()
              .find((message) => message.role === "user")
          : undefined;
      const converted = storedMessage(m, {
        day: days[index],
        tags: m.role === "user" ? sentMentions(m.text, directory) : undefined,
        anchored: anchorsHere ? anchored : undefined,
        requestText:
          request &&
          (index === messages.length - 1 || m.result?.type === "process.offer")
            ? request.text
            : undefined,
        requestMessageId: request?.id,
        editable: m.role === "user" && index === lastUser && !readOnly,
      });
      if (converted) thread.push(converted);
    });
    if (pending?.kind === "message" && state.pending)
      thread.push(pendingMessage(state.pending.commandId, pending.text));
    if (progressCommand)
      thread.push(
        liveMessage({
          commandId: progressCommand.commandId,
          activity: state.activity,
          steps: state.activitySteps ?? [],
          approval,
          stopped:
            requestInterrupted ||
            modelFailed ||
            state.activity?.status === "failed",
          failed: modelFailed || state.activity?.status === "failed",
          hint: progressHint,
        }),
      );
    return {
      threadMessages: thread,
      // The run of the message being answered is the Thinking line, not a
      // card saying "Waiting for server" beneath it.
      trailingWork: work.filter(
        (w) =>
          !referenced.has(w.id) &&
          (!!w.native?.process || !isTerminalNativeWork(w)) &&
          !(
            !!progressCommand &&
            !w.native?.process &&
            ["queued", "running", "waiting_system"].includes(w.status)
          ),
      ),
    };
    // The session's state object changes with every update it carries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    messages,
    store,
    work,
    directory,
    readOnly,
    pending,
    progressCommand,
    state.activity,
    state.activitySteps,
    approval,
    requestInterrupted,
    modelFailed,
    progressHint,
    id,
  ]);
  const isRunning = !!progressCommand;
  const stoppable =
    isRunning ||
    (state.pending?.type === "process.answer" &&
      state.pending.conversationId === id);
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: threadMessages,
    convertMessage: sameMessage,
    isRunning,
    isDisabled: readOnly,
    onNew: async (message) => {
      submitMessage(appendedText(message));
    },
    onCancel: async () => {
      await session.interruptPending();
    },
    onReload: async () => {
      const request = [...messages].reverse().find((m) => m.role === "user");
      if (request) again(request.text);
    },
  });
  useLayoutEffect(() => {
    runtimeRef.current = runtime;
  }, [runtime]);

  const processAnnouncement = selectProcessCommandNotice(state, noticeOwner);
  const sharedErrorKey = chatErrorKey(
    replyError,
    processAnnouncement,
    chatOwnsError(state, id) &&
      !(progressHint && (modelFailed || state.error === "network_error"))
      ? state.error
      : null,
    false,
  );
  const errorKey =
    sharedErrorKey && (chatWording[sharedErrorKey] ?? sharedErrorKey);
  const otherChat =
    state.pending &&
    state.pending.conversationId !== id &&
    !state.pending.type.startsWith("conversation.")
      ? state.pending
      : null;
  const otherChatRunning =
    !!otherChat && runningChat(state) === otherChat.conversationId;
  let validContext = false;
  if (isProcessReply(context)) {
    try {
      if (store) {
        assertProcessAnswerTarget(store, context.target);
        validContext = true;
      }
    } catch {
      /* The question stays visible until it is cleared. */
    }
  } else if (context) {
    const currentContext = selectReplyInput(store, context);
    validContext =
      currentContext?.status === "open" &&
      currentContext.revision === context.revision;
  }
  const waitingForProcessAnswer =
    isProcessReply(context) &&
    answerCaption?.context === context &&
    state.commandStates[answerCaption.target] === "accepted" &&
    !state.error &&
    !recordedProcessAnswer(state.store, context, answerCaption.command);
  const hasConversation =
    messages.length > 0 || trailingWork.length > 0 || !!pending;
  const inputDisabled = !valid || (!!context && !validContext);
  const title = conversationTitle(historySelection?.title ?? "");
  const showHome =
    !(historyLoading && !historySelection) &&
    !hasConversation &&
    !busy &&
    unsaved;
  const onWindowKey = useEffectEvent((event: KeyboardEvent) => {
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
  useEffect(() => {
    if (!routeId && window.matchMedia?.("(pointer: fine)").matches)
      composerRef.current?.focus();
  }, [routeId]);

  const chat: NextChat = {
    session,
    state,
    conversationId: id,
    online,
    busy,
    readOnly,
    stale,
    rememberTarget: workspace && {
      organizationId: workspace.organizationId,
      workspaceId: workspace.workspaceId,
    },
    decide,
    followUp,
    continueWith: (text) => submitMessage(text, null, { detached: true }),
    declineOffer: (requestText) => {
      if (requestText)
        submitMessage(requestText, null, {
          withoutProcess: true,
          detached: true,
          mentions: messageMentions(
            requestText,
            sentMentions(requestText, directory),
          ),
        });
    },
    reviewOffer: (offer: ProcessOfferResult) => {
      handOffProcessOffer(offer);
      void navigate({ to: "/processes" });
    },
    work: (workId) => work.find((w) => w.id === workId),
    replyToWork,
    answerQuestion,
    shortcutQuestion,
    again,
    edit: editMessage,
    retry: retryable ? () => void session.retry(noticeOwner) : undefined,
  };

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
    <AssistantRuntimeProvider runtime={runtime}>
      <NextChatProvider value={chat}>
        <ThreadPrimitive.Root
          data-testid="chat-next"
          className="flex min-h-0 flex-1 flex-col"
        >
          <h1 className="sr-only">{title || copy.newChat}</h1>
          <ThreadPrimitive.Viewport
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
                <Welcome
                  onSuggestion={(text) => {
                    setComposerText(text);
                    requestAnimationFrame(() => composerRef.current?.focus());
                  }}
                />
              ) : (
                <div role="log" className="flex flex-col gap-6">
                  <ThreadPrimitive.Messages components={messageComponents} />
                  {trailingWork.map((w) => (
                    <article
                      key={w.id}
                      aria-label={copy.assistant}
                      className="flex min-w-0 flex-col gap-3"
                    >
                      <NextWorkCard work={w} />
                    </article>
                  ))}
                  {(state.answerAttempts ?? []).map((attempt) => (
                    <AnswerRecovery
                      key={attempt.command.commandId}
                      attempt={attempt}
                      chatId={id}
                      session={session}
                      state={state}
                      noticeOwner={noticeOwner}
                      onReview={(target, answer) => {
                        setContext(Object.freeze({ kind: "process", target }));
                        setComposerText(answer);
                        composerRef.current?.focus();
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          </ThreadPrimitive.Viewport>
          <div className="relative bg-background">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-full mx-auto h-10 max-w-4xl bg-linear-to-t from-background to-transparent"
            />
            {hasConversation && !showHome && <JumpToEnd />}
            <div className="mx-auto flex w-full max-w-4xl flex-col gap-2 px-4 pb-4 md:px-6 md:pb-6">
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
              {otherChat && !readOnly && (
                <div
                  role="status"
                  data-testid="other-chat-busy"
                  className="flex flex-wrap items-center justify-center gap-x-1 text-xs text-muted-foreground"
                >
                  <span>
                    {otherChatRunning
                      ? copy.otherChatRunning
                      : copy.otherChatWaiting}
                  </span>
                  <Button variant="link" size="xs" asChild>
                    <Link
                      to="/chat/$conversationId"
                      params={{ conversationId: otherChat.conversationId }}
                    >
                      {copy.open}
                    </Link>
                  </Button>
                  {otherChatRunning &&
                    (otherChat.type === "message.send" ||
                      otherChat.type === "process.answer") && (
                      <Button
                        variant="ghost"
                        size="xs"
                        disabled={!online}
                        onClick={() => void session.interruptPending()}
                      >
                        {copy.stop}
                      </Button>
                    )}
                </div>
              )}
              {errorKey && (
                <Alert variant="destructive" data-testid="chat-error">
                  <AlertDescription>{tr(errorKey)}</AlertDescription>
                  {!isRunning &&
                    (retryable || (hasDraft && !busy && online)) && (
                      <AlertAction>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!online}
                          onClick={() =>
                            retryable
                              ? void session.retry(noticeOwner)
                              : runtime.thread.composer.send()
                          }
                        >
                          <RefreshCw
                            data-icon="inline-start"
                            aria-hidden="true"
                          />
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
                    <ArchiveRestore
                      data-icon="inline-start"
                      aria-hidden="true"
                    />
                    {tr("restoreChat")}
                  </Button>
                </div>
              ) : (
                <Composer
                  composerRef={composerRef}
                  initialText={initial.text}
                  onDraft={noteDraft}
                  directory={directory}
                  picked={picked}
                  setPicked={setPicked}
                  attachedTask={attachedTask}
                  onDetachTask={() => setAttachedTask(undefined)}
                  context={context}
                  validContext={validContext}
                  waitingForAnswer={waitingForProcessAnswer}
                  onClearContext={() => setContext(undefined)}
                  disabled={inputDisabled}
                  attachments={attachments}
                  onFileOnly={() => submitMessage("")}
                  sendBlocked={
                    !online ||
                    busy ||
                    historyLoading ||
                    (attachments.state.entries.length > 0 && !attachments.ready)
                  }
                  stoppable={stoppable}
                  stopLabel={
                    state.error === "requestInterruptFailed"
                      ? copy.stopRetry
                      : copy.stop
                  }
                />
              )}
            </div>
          </div>
        </ThreadPrimitive.Root>
      </NextChatProvider>
    </AssistantRuntimeProvider>
  );
}

/** Back to the end of a long chat, shown once the person scrolled up. */
function JumpToEnd() {
  const { copy } = useChatCopy();
  const atBottom = useThreadViewport((s) => s.isAtBottom);
  if (atBottom) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-full flex justify-center pb-3">
      <ThreadPrimitive.ScrollToBottom asChild>
        <Button
          variant="outline"
          size="icon-sm"
          className="pointer-events-auto"
          aria-label={copy.scrollToBottom}
        >
          <ArrowDown aria-hidden="true" />
        </Button>
      </ThreadPrimitive.ScrollToBottom>
    </div>
  );
}

function Welcome({ onSuggestion }: { onSuggestion: (text: string) => void }) {
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

const messageClass =
  "group/message flex min-w-0 flex-col gap-1 rounded-xl transition-shadow duration-500 data-[highlighted=true]:ring-2 data-[highlighted=true]:ring-ring/50 data-[highlighted=true]:ring-offset-4 data-[highlighted=true]:ring-offset-background";

/** The person's message: its bubble, the item it brought and its tags. */
function UserMessage() {
  const message = useAuiState((s) => s.message);
  const chat = useNextChat();
  const { copy, language } = useChatCopy();
  const meta = nextMeta(message);
  const pending = meta.kind === "pending";
  const text = threadText(message);
  return (
    <>
      {meta.day !== undefined && <DaySeparator day={meta.day} />}
      <MessagePrimitive.Root
        data-message-id={pending ? undefined : message.id}
        className={messageClass}
      >
        <article
          aria-label={copy.you}
          data-testid={pending ? "pending-message" : undefined}
          className="flex flex-col items-end gap-1 pl-10 sm:pl-16"
        >
          {meta.task && (
            <span className="flex max-w-full items-center gap-1.5 text-xs text-muted-foreground">
              <ClipboardList aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="truncate">{meta.task}</span>
            </span>
          )}
          <MessageTags items={meta.tags ?? []} />
          {meta.attachments?.length ? (
            <WebMessageAttachments
              session={chat.session}
              language={language}
              files={meta.attachments}
              processing={meta.processing}
            />
          ) : null}
          {text.trim() ? (
            <div
              data-pending={pending}
              className="max-w-full rounded-2xl bg-muted px-4 py-2.5 text-sm break-words whitespace-pre-wrap data-[pending=true]:opacity-60"
            >
              <MessagePrimitive.Parts components={userParts} />
            </div>
          ) : null}
        </article>
        {!pending && !!text.trim() && (
          <MessageActions
            text={text}
            align="end"
            createdAt={meta.createdAt}
            disabled={chat.busy || !chat.online || chat.readOnly}
            onEdit={
              meta.editable ? () => chat.edit(text, message.id) : undefined
            }
          />
        )}
        {!pending && !text.trim() && meta.editable ? (
          <Button
            variant="ghost"
            size="icon-xs"
            className="self-end"
            aria-label={copy.editMessage}
            disabled={chat.busy || !chat.online || chat.readOnly}
            onClick={() => chat.edit(text, message.id)}
          >
            <SquarePen aria-hidden="true" />
          </Button>
        ) : null}
      </MessagePrimitive.Root>
    </>
  );
}

/**
 * An answer: its text, its generated part and the system's own views; while
 * it is written, "Thinking" until the first word, with the streamed steps.
 */
function AssistantMessage() {
  const message = useAuiState((s) => s.message);
  const chat = useNextChat();
  const { copy, tr } = useChatCopy();
  const meta = nextMeta(message);
  const live = meta.kind === "live" || !!message.metadata.isOptimistic;
  const text = threadText(message);
  const stopped = live && message.status?.type === "incomplete";
  const failed = stopped && message.status?.reason === "error";
  const thinking = live && !stopped && !text;
  // "Thinking" becomes "Reading Twenty CRM" while a service answers.
  const reading = thinking
    ? message.content.find(
        (part): part is Extract<typeof part, { type: "tool-call" }> =>
          part.type === "tool-call" &&
          part.toolName === TOOL.step &&
          (part.args as { step?: AnswerStreamStep }).step?.status === "running",
      )
    : undefined;
  const readingStep = (reading?.args as { step?: AnswerStreamStep } | undefined)
    ?.step;
  const loops = loopsCopy[useApp().language];
  const elapsed = useElapsedSeconds(thinking);
  return (
    <>
      {meta.day !== undefined && <DaySeparator day={meta.day} />}
      <MessagePrimitive.Root
        data-message-id={live ? undefined : message.id}
        className={messageClass}
      >
        <article
          aria-label={copy.assistant}
          className="flex min-w-0 flex-col gap-3"
        >
          {(thinking || stopped) && (
            <div
              data-testid="request-progress"
              role="status"
              aria-live="polite"
              className="flex flex-col gap-1.5 text-sm text-muted-foreground"
            >
              <div className="flex items-center gap-1.5">
                {stopped && (
                  <CircleAlert aria-hidden="true" className="size-4" />
                )}
                <span data-thinking={stopped ? undefined : ""}>
                  {failed
                    ? tr("progressFailed")
                    : stopped
                      ? tr("progressUnknown")
                      : readingStep
                        ? tr("progressReading").replace(
                            "{service}",
                            liveStepService(readingStep) ??
                              humanizeLabel(readingStep.label, loops),
                          )
                        : tr("progressThinking")}
                </span>
                {elapsed !== null && (
                  <span className="text-xs tabular-nums">· {elapsed} s</span>
                )}
              </div>
              {stopped && (
                <p className="text-xs">
                  {meta.hint ??
                    tr(failed ? "progressFailedHint" : "progressUnavailable")}
                </p>
              )}
              {stopped && chat.retry && (
                <Button
                  variant="outline"
                  size="sm"
                  className="self-start"
                  disabled={!chat.online}
                  onClick={chat.retry}
                >
                  <RefreshCw data-icon="inline-start" aria-hidden="true" />
                  {copy.retry}
                </Button>
              )}
            </div>
          )}
          <div
            data-stopped={stopped}
            className="flex min-w-0 flex-col gap-3 data-[stopped=true]:opacity-50"
          >
            <MessagePrimitive.Parts components={assistantParts} />
          </div>
          {stopped && !!text && (
            <p className="text-xs text-muted-foreground">{copy.interrupted}</p>
          )}
          {live && !stopped && text.length >= ACTIVITY_DRAFT_MAX && (
            <p data-thinking="" className="text-xs text-muted-foreground">
              {copy.stillWriting}
            </p>
          )}
        </article>
        {!live && !!text.trim() && (
          <MessageActions
            text={text}
            align="start"
            createdAt={meta.createdAt}
            disabled={chat.busy || !chat.online || chat.readOnly}
            onAgain={
              meta.requestText !== undefined && message.isLast
                ? () => chat.again(meta.requestText!, meta.requestMessageId)
                : undefined
            }
          />
        )}
      </MessagePrimitive.Root>
    </>
  );
}
const messageComponents = { UserMessage, AssistantMessage };

/**
 * The composer: assistant-ui's composer text in the app's field, with the
 * "@" picker, the attached item, the reply context, the counter and IME-safe
 * keys. Enter sends through the thread's runtime.
 */
function Composer({
  composerRef,
  initialText,
  onDraft,
  directory,
  picked,
  setPicked,
  attachedTask,
  onDetachTask,
  context,
  validContext,
  waitingForAnswer,
  onClearContext,
  disabled,
  sendBlocked,
  stoppable,
  stopLabel,
  attachments,
  onFileOnly,
}: {
  composerRef: RefObject<HTMLTextAreaElement | null>;
  initialText: string;
  onDraft: (text: string) => void;
  directory: readonly MentionItem[];
  picked: MentionItem[];
  setPicked: (update: (current: MentionItem[]) => MentionItem[]) => void;
  attachedTask?: HumanTaskReference;
  onDetachTask: () => void;
  context?: ReplyContext;
  validContext: boolean;
  waitingForAnswer: boolean;
  onClearContext: () => void;
  disabled: boolean;
  sendBlocked: boolean;
  stoppable: boolean;
  stopLabel: string;
  attachments: WebAttachments;
  onFileOnly: () => void;
}) {
  const aui = useAui();
  const chat = useNextChat();
  const { copy, tr, language } = useChatCopy();
  const draft = useAuiState((s) => s.composer.text);
  const setDraft = (text: string) => {
    onDraft(text);
    aui.composer.setText(text);
  };
  // The saved draft comes back when the page opens.
  useEffect(() => {
    if (initialText) {
      onDraft(initialText);
      aui.composer.setText(initialText);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
  const pendingCaret = useRef<number | null>(null);
  const pickMention = (item: MentionItem) => {
    if (!picker) return;
    const next = insertMention(draft, picker, item);
    setDraft(next.text);
    setPicked((current) =>
      current.some((c) => c.kind === item.kind && c.id === item.id)
        ? current
        : [...current, item],
    );
    setPicker(null);
    pendingCaret.current = next.caret;
  };
  const chips = picked.filter((item) => isTagged(draft, item));
  const startMention = () => {
    const caret = composerRef.current?.selectionStart ?? draft.length;
    const before = draft.slice(0, caret);
    const prefix = before && !/\s$/.test(before) ? " @" : "@";
    const next = before + prefix + draft.slice(caret);
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
  }, [draft, composerRef]);
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
  }, [draft, composerRef]);
  const length = draft.trim().length;
  const tooLong = length > MAX_MESSAGE_LENGTH;
  const count = new Intl.NumberFormat(language);
  const canSend =
    (!!draft.trim() || attachments.ready) &&
    !tooLong &&
    !sendBlocked &&
    !disabled &&
    !chat.readOnly;
  const submit = () => {
    if (!canSend) return;
    // The text leaves the composer with the send; a refused send puts it
    // back only while nothing new was typed, so the mirror empties first.
    onDraft("");
    if (!draft.trim() && attachments.ready) onFileOnly();
    else aui.composer.send();
    composerRef.current?.focus();
  };
  return (
    <form
      className="relative"
      onDragOver={(event) => {
        if (attachments.available && event.dataTransfer.types.includes("Files"))
          event.preventDefault();
      }}
      onDrop={attachments.drop}
      onPaste={attachments.paste}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
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
      <WebAttachmentDraft value={attachments} fallbackFocusRef={composerRef} />
      <InputGroup>
        {context ? (
          <InputGroupAddon align="block-start">
            <CornerDownRight aria-hidden="true" />
            <InputGroupText>
              <span className="line-clamp-2 min-w-0 font-normal">
                <span className="text-muted-foreground">
                  {tr(
                    waitingForAnswer
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
              onClick={onClearContext}
            >
              <X aria-hidden="true" />
            </InputGroupButton>
          </InputGroupAddon>
        ) : attachedTask ? (
          <InputGroupAddon align="block-start" data-testid="composer-task">
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
              onClick={onDetachTask}
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
                setDraft(removeMention(draft, item));
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
          disabled={disabled}
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
            // While an IME composes, Enter and Tab pick its words.
            const composing =
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229;
            if (pickerOpen && !composing) {
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
            if (event.key === "Enter" && !event.shiftKey && !composing) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <InputGroupAddon align="block-end">
          <WebAttachmentMenu
            value={attachments}
            disabled={disabled || chat.readOnly || !!context}
          />
          {directory.length > 0 && (
            <InputGroupButton
              type="button"
              size="icon-sm"
              aria-label={copy.mentionPicker}
              disabled={disabled || chat.readOnly}
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
              aria-label={stopLabel}
              disabled={!chat.online}
              onClick={() => void chat.session.interruptPending()}
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
              aria-disabled={!canSend}
            >
              <ArrowUp aria-hidden="true" />
            </InputGroupButton>
          )}
        </InputGroupAddon>
      </InputGroup>
      {length > COUNTER_FROM && (
        <div className="flex gap-2 pt-1 text-xs">
          {tooLong && (
            <p role="alert" className="text-destructive">
              {copy.tooLong}
            </p>
          )}
          <span
            data-testid="composer-count"
            data-over={tooLong}
            className="ml-auto text-muted-foreground tabular-nums data-[over=true]:text-destructive"
          >
            {count.format(length)} / {count.format(MAX_MESSAGE_LENGTH)}
          </span>
        </div>
      )}
    </form>
  );
}

/**
 * A typed process answer the server accepted but the run did not record, or
 * refused: review it in the composer, send it again or discard it.
 */
function AnswerRecovery({
  attempt,
  chatId,
  session,
  state,
  noticeOwner,
  onReview,
}: {
  attempt: NonNullable<SessionState["answerAttempts"]>[number];
  chatId: string;
  session: ClientSession;
  state: SessionState;
  noticeOwner: ReturnType<typeof captureProcessNoticeOwner>;
  onReview: (target: ProcessAnswerTarget, answer: string) => void;
}) {
  const navigate = useNavigate();
  const { tr } = useChatCopy();
  const store = state.store;
  const online = state.status === "online";
  const busy = !!state.pending || !!state.answerRecoveryBlocked;
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
    state.processNotice?.notice.commandId === attempt.command.commandId
      ? state.processNotice
      : undefined;
  const explanation = notice
    ? notice.errorSource.kind === "local"
      ? tr(notice.errorSource.code)
      : (() => {
          const selected = processNoticeCopy(notice.notice);
          return selected
            ? tr(selected.key) +
                (selected.detailKey ? ` ${tr(selected.detailKey)}` : "")
            : undefined;
        })()
    : attempt.outcome === "accepted"
      ? tr("processResultUnavailable")
      : attempt.error
        ? tr(
            sendErrorKey(new Error(attempt.error), "process_question_rejected"),
          )
        : undefined;
  return (
    <AnswerRecoveryView
      question={attempt.target.question.question}
      answer={attempt.command.answer}
      outcome={attempt.outcome}
      explanation={explanation}
      canReview={canReview}
      canRetry={
        !state.answerRecoveryBlocked &&
        online &&
        state.pending?.commandId === attempt.command.commandId &&
        state.commandStates[commandTarget(attempt.command)] !== "sending"
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
          return;
        }
        if (attempt.target.conversationId !== chatId) {
          void navigate({
            to: "/chat/$conversationId",
            params: { conversationId: attempt.target.conversationId },
          });
          return;
        }
        onReview(attempt.target, attempt.command.answer);
      }}
      onDiscard={() =>
        void session.discardProcessAnswerAttempt(attempt.command.commandId)
      }
    />
  );
}
