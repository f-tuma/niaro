import type { Conversation, Language } from "../protocol";
import {
  SPEECH_PROFILE,
  SPEECH_TEXT_LENGTH,
  type SpeechAudio,
  type SpeechRequest,
} from "../protocol/speech";
export type SpeechPlayback = {
  /** Resolves when playback actually begins, rather than when it is requested. */
  start(
    audio: SpeechAudio,
    signal: AbortSignal,
    ended: () => void,
    failed: () => void,
  ): Promise<void>;
  stop(): void;
};
type SpeechState = {
  messageId?: string;
  phase: "idle" | "loading" | "playing" | "error";
  error?: string;
};
export const AUTOMATIC_SPEECH_START_MS = 8000;
/** A single explicit playback owner; a late response can never restart a stopped reply. */
export class ReplySpeech {
  private state: SpeechState = { phase: "idle" };
  private listeners = new Set<() => void>();
  private controller?: AbortController;
  private generation = 0;
  private source?: { conversationId: string; messageId: string; text: string };
  constructor(
    private synthesize: (
      input: SpeechRequest,
      signal: AbortSignal,
    ) => Promise<SpeechAudio>,
    private playback: SpeechPlayback,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(value: SpeechState) {
    this.state = value;
    for (const fn of this.listeners) fn();
  }
  stop = () => {
    this.generation++;
    this.source = undefined;
    this.controller?.abort();
    this.controller = undefined;
    this.playback.stop();
    this.set({ phase: "idle" });
  };
  /** One foreground voice command, never history or another device's response. */
  waitForReply(commandId: string, language: Language, requestId: string) {
    this.stop();
    const generation = this.generation;
    return async (conversation?: Conversation) => {
      if (generation !== this.generation) return;
      this.generation++;
      const message = conversation?.messages.findLast(
        (m) => m.role === "assistant" && m.replyToCommandId === commandId,
      );
      if (
        !conversation ||
        !message?.text.trim() ||
        message.text.length > SPEECH_TEXT_LENGTH
      )
        return;
      await this.play(
        conversation.id,
        message.id,
        language,
        requestId,
        message.text,
        AUTOMATIC_SPEECH_START_MS,
      );
    };
  }
  reconcile(conversations: Record<string, Conversation> | undefined) {
    if (!this.source) return;
    const { conversationId, messageId, text } = this.source;
    if (
      conversations?.[conversationId]?.messages.find((m) => m.id === messageId)
        ?.text !== text
    )
      this.stop();
  }
  async play(
    conversationId: string,
    messageId: string,
    language: Language,
    requestId: string,
    sourceText?: string,
    maxStartMs?: number,
  ) {
    this.stop();
    if (sourceText !== undefined)
      this.source = { conversationId, messageId, text: sourceText };
    const controller = new AbortController();
    this.controller = controller;
    this.set({ messageId, phase: "loading" });
    if (controller.signal.aborted) return;
    const failed = (error = "speech_playback_failed") => {
      if (this.controller !== controller || controller.signal.aborted) return;
      this.stop();
      this.set({ messageId, phase: "error", error });
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelled = new Promise<void>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
    try {
      // A slow synthesis must not speak unexpectedly after its text fallback.
      if (maxStartMs !== undefined)
        timer = setTimeout(() => failed("speech_start_timeout"), maxStartMs);
      await Promise.race([
        (async () => {
          const audio = await this.synthesize(
            {
              profile: SPEECH_PROFILE,
              requestId,
              conversationId,
              messageId,
              language,
            },
            controller.signal,
          );
          if (controller.signal.aborted) return;
          await this.playback.start(
            audio,
            controller.signal,
            () => {
              if (this.controller === controller) this.stop();
            },
            () => failed(),
          );
          if (this.controller === controller && !controller.signal.aborted)
            this.set({ messageId, phase: "playing" });
        })(),
        cancelled,
      ]);
    } catch (error) {
      failed(error instanceof Error ? error.message : "speech_unavailable");
    } finally {
      clearTimeout(timer);
    }
  }
}
