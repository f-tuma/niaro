import React, {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Animated, AppState, BackHandler, View } from "react-native";
import { randomUUID } from "expo-crypto";
import type { HumanTaskReference, Language } from "../../packages/protocol";
import { ClientSession } from "../../packages/client-core/session";
import type { ProcessNoticeOwner } from "../../packages/client-core/process-command-notice";
import { feedback } from "./feedback";
import { VoiceDraft } from "../../packages/client-core/voice";
import { selectReplyInput } from "../../packages/client-core/store";
import { messageCommand } from "../../packages/client-core/commands";
import { withChatSession } from "./chat-session";
import { VoiceComposer } from "../../packages/ui-catalog/VoiceComposer";
import { useReducedMotion } from "../../packages/ui/motion";
import { voiceVisualMeter } from "../../packages/audio/spectrum";
import { createVoiceCapture } from "./voice-capture";
import {
  assertProcessAnswerTarget,
  processAnswerCommand,
} from "../../packages/client-core/process-answers";
import {
  isProcessReply,
  type ReplyContext,
} from "../../packages/client-core/reply-context";

export {
  isProcessReply,
  type ProcessReplyContext,
} from "../../packages/client-core/reply-context";
export type VoiceReplyContext = ReplyContext;

type Submitted = (
  text: string,
  input: VoiceReplyContext | undefined,
  delivery: Promise<void>,
  commandId: string,
) => void;
/** Created and started by the microphone press, never by rendering or an effect. */
export function createVoiceReply(
  session: ClientSession,
  input: VoiceReplyContext | undefined,
  language: Language,
  onSubmitted: Submitted,
  isCurrent: () => boolean = () => true,
  conversationId = "conversation-1",
  noticeOwner?: ProcessNoticeOwner,
  continueConversation = false,
  /** An open item from Tasks that this new message brings to the chat. */
  humanTask?: HumanTaskReference,
) {
  const capture = createVoiceCapture();
  let interruption = Promise.resolve(true);
  let interruptionConfirmed = true;
  const frozen: VoiceReplyContext | undefined = isProcessReply(input)
    ? Object.freeze({ kind: "process", target: input.target })
    : input
      ? JSON.parse(JSON.stringify(input))
      : undefined;
  const assertCurrent = () => {
    if (!isCurrent()) throw new Error("voice_cancelled");
    if (AppState.currentState !== "active")
      throw new Error("voice_interrupted");
    if (isProcessReply(frozen)) {
      const current = session.getSnapshot();
      if (current.status !== "online" || !current.store)
        throw new Error("process_question_changed");
      assertProcessAnswerTarget(current.store, frozen.target);
    }
  };
  return new VoiceDraft(
    {
      ...capture,
      async start(signal) {
        assertCurrent();
        if (signal.aborted || AppState.currentState !== "active")
          throw new Error("voice_interrupted");
        // Starting capture authorizes interruption only. Capture and server
        // retirement proceed together; the transcript waits for the outcome.
        interruption = session.interruptPending();
        const capabilities = await session.voiceCapabilities(signal);
        if (!capabilities.enabled) throw new Error("voice_unavailable");
        if (signal.aborted || AppState.currentState !== "active")
          throw new Error("voice_interrupted");
        // The cue finishes before the microphone opens, so it is never recorded.
        const cue = feedback("listen");
        if (cue) await new Promise((r) => setTimeout(r, cue * 1000 + 40));
        if (signal.aborted || AppState.currentState !== "active")
          throw new Error("voice_interrupted");
        assertCurrent();
        await capture.start(signal);
      },
    },
    isProcessReply(frozen) ? undefined : frozen,
    language,
    async (request, signal) => {
      assertCurrent();
      const result = await session.transcribe(request, signal);
      interruptionConfirmed = await interruption;
      assertCurrent();
      return result;
    },
    randomUUID,
    (text, automatic) => {
      assertCurrent();
      if (AppState.currentState !== "active")
        throw new Error("voice_interrupted");
      if (automatic && !interruptionConfirmed)
        throw new Error("requestInterruptFailed");
      const current = session.getSnapshot();
      if (current.status !== "online") throw new Error("voice_send_failed");
      if (current.pending) throw new Error("requestInterruptFailed");
      const legacy = isProcessReply(frozen) ? undefined : frozen;
      const question = selectReplyInput(current.store, legacy);
      if (
        legacy &&
        (!question ||
          question.status !== "open" ||
          question.revision !== legacy.revision ||
          question.workItemId !== legacy.workItemId)
      )
        throw new Error("voice_context_changed");
      const id = randomUUID();
      const command = isProcessReply(frozen)
        ? processAnswerCommand(current.store!, frozen.target, {
            commandId: id,
            idempotencyKey: id,
            answer: text,
            language,
          })
        : withChatSession(
            {
              ...messageCommand(text, language, id, legacy),
              ...(legacy ? {} : { conversationId }),
              ...(!legacy && humanTask ? { humanTask } : {}),
            },
            continueConversation,
          );
      const delivery = noticeOwner
        ? session.send(command, false, undefined, noticeOwner)
        : session.send(command);
      if (session.getSnapshot().pending?.commandId !== command.commandId)
        throw new Error("voice_send_failed");
      onSubmitted(text, frozen, delivery, command.commandId);
    },
    isProcessReply(frozen)
      ? {
          context: { conversationId: frozen.target.conversationId },
          preserveText: true,
        }
      : frozen
        ? undefined
        : { context: { conversationId } },
  );
}

/** Only this small composer rerenders as microphone samples arrive. */
export function VoiceReply({
  draft,
  language,
  blocked,
  onClose,
  level,
}: {
  draft: VoiceDraft;
  language: Language;
  blocked: boolean;
  onClose: () => void;
  /** Mirrors the live level for other voice visuals, such as the home orb. */
  level?: Animated.Value;
}) {
  const state = useSyncExternalStore(
    draft.subscribe,
    draft.getSnapshot,
    draft.getSnapshot,
  );
  const reduced = useReducedMotion();
  const [petLevel] = useState(() => new Animated.Value(0));
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    if (state.stage !== "recording") return;
    const started = Date.now();
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [draft, state.stage]);
  // Sent when capture ends, an error when it fails for a reason the person should hear.
  const previous = useRef(state.stage);
  useEffect(() => {
    if (
      previous.current === "recording" &&
      ["stopping", "recorded", "transcribing"].includes(state.stage)
    )
      feedback("sent");
    previous.current = state.stage;
  }, [state.stage]);
  useEffect(() => {
    if (
      state.error &&
      !["voice_cancelled", "voice_interrupted", "voice_empty"].includes(
        state.error,
      )
    )
      feedback("error");
  }, [state.error]);
  const [meter, setMeter] = useState<{
    level: number;
    bands?: readonly [number, number, number];
    spectrum?: readonly number[];
  }>({ level: 0 });
  useEffect(() => {
    if (state.stage !== "recording") {
      level?.setValue(0);
      petLevel.setValue(0);
      return;
    }
    const timer = setInterval(
      () => {
        const next = voiceVisualMeter(
          draft.level(),
          draft.bands(),
          draft.spectrum(),
        );
        setMeter(next);
        level?.setValue(next.level);
        petLevel.setValue(next.level);
      },
      reduced ? 250 : 80,
    );
    return () => {
      clearInterval(timer);
      level?.setValue(0);
      petLevel.setValue(0);
    };
  }, [draft, state.stage, reduced, level, petLevel]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next !== "active") void draft.cancel("voice_interrupted");
    });
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      void draft.cancel();
      onClose();
      return true;
    });
    return () => {
      subscription.remove();
      back.remove();
      void draft.cancel();
    };
  }, [draft, onClose]);
  return (
    <View>
      <VoiceComposer
        language={language}
        stage={state.stage}
        text={state.text}
        error={state.error}
        reviewReasons={state.reviewReasons}
        blocked={blocked && state.stage === "review"}
        level={meter.level}
        petLevel={petLevel}
        elapsedSeconds={elapsedSeconds}
        bands={meter.bands}
        spectrum={meter.spectrum}
        onStart={() => {
          setMeter({ level: 0 });
          setElapsedSeconds(0);
          void draft.start();
        }}
        onStop={() => {
          void draft.stop();
        }}
        onUpload={() => {
          void draft.upload();
        }}
        onEdit={(text) => draft.edit(text)}
        onSend={() => {
          if (!blocked) draft.submit();
        }}
        onCancel={() => {
          void draft.cancel();
          onClose();
        }}
      />
    </View>
  );
}
