import type { ReplyInput, Language } from "../protocol";
import {
  VOICE_PROFILE,
  VOICE_SECONDS,
  VoiceTranscriptSchema,
  type VoiceAudio,
  type VoiceContext,
  type VoiceRequest,
  type VoiceTranscript,
} from "../protocol/voice";
import { VoiceActivity } from "../audio/voice-activity";
import type { VoiceFrame } from "../audio/analysis";
export interface VoiceCapture {
  supported(): boolean;
  start(signal: AbortSignal): Promise<void>;
  stop(): Promise<VoiceAudio>;
  discard(): Promise<void>;
  /** Current microphone level in dBFS; null when metering is unavailable. */
  level?(): number | null;
  /** Low / mid / high speech-band power, dBFS; absent when the recorder exposes RMS only. */
  bands?(): readonly [number, number, number] | null;
  /** The latest analysed frame: level, 24-band spectrum and voicing; raw-sample recorders only. */
  frame?(): VoiceFrame | null;
}
export type VoiceStage =
  | "idle"
  | "starting"
  | "recording"
  | "stopping"
  | "recorded"
  | "transcribing"
  | "review"
  | "submitted"
  | "cancelling";
export type VoiceState = {
  stage: VoiceStage;
  text: string;
  error: string | null;
  reviewReasons: VoiceTranscript["reviewReasons"];
};
/** Owns capture through transcription. Handoff carries free text, never consent. */
export class VoiceDraft {
  private state: VoiceState = {
    stage: "idle",
    text: "",
    error: null,
    reviewReasons: [],
  };
  private listeners = new Set<() => void>();
  private controller = new AbortController();
  private task: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private monitor?: ReturnType<typeof setInterval>;
  private currentLevel: number | null = null;
  private currentFrame: VoiceFrame | null = null;
  private cancellation?: Promise<void>;
  private audio?: VoiceAudio;
  private stopReason: "user" | "silence" | "limit" = "user";
  readonly input?: ReplyInput;
  readonly context: VoiceContext;
  constructor(
    private capture: VoiceCapture,
    input: ReplyInput | undefined,
    private language: Language,
    private transcribe: (
      request: VoiceRequest,
      signal: AbortSignal,
    ) => Promise<VoiceTranscript>,
    private newId: () => string,
    private deliver: (text: string, automatic: boolean) => void,
    private options: { context?: VoiceContext; preserveText?: boolean } = {},
  ) {
    this.input = input
      ? (JSON.parse(JSON.stringify(input)) as ReplyInput)
      : undefined;
    this.context =
      options.context ??
      (this.input
        ? {
            conversationId: this.input.conversationId,
            workItemId: this.input.workItemId,
            inputRequestId: this.input.id,
            expectedInputRevision: this.input.revision,
          }
        : { conversationId: "conversation-1" });
  }
  getSnapshot = () => this.state;
  level = () => (this.state.stage === "recording" ? this.currentLevel : null);
  private readLevel() {
    try {
      this.currentFrame = this.capture.frame?.() ?? null;
      return this.currentFrame?.level ?? this.capture.level?.() ?? null;
    } catch {
      this.currentFrame = null;
      return null;
    }
  }
  /** 24-band spectrum of the latest frame, dBFS; null for RMS-only recorders. */
  spectrum = () =>
    this.state.stage === "recording"
      ? (this.currentFrame?.spectrum ?? null)
      : null;
  bands = () => {
    if (this.state.stage !== "recording") return null;
    try {
      return this.capture.bands?.() ?? null;
    } catch {
      return null;
    }
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(value: Partial<VoiceState>) {
    this.state = { ...this.state, ...value };
    this.listeners.forEach((listener) => listener());
  }
  edit(text: string) {
    if (this.state.stage === "review") this.publish({ text, error: null });
  }
  submit(automatic = false) {
    if (
      this.state.stage !== "review" ||
      this.controller.signal.aborted ||
      !this.state.text.trim()
    )
      return;
    const text = this.options.preserveText
      ? this.state.text
      : this.state.text.trim();
    this.publish({ stage: "submitted", error: null });
    try {
      this.deliver(text, automatic);
    } catch (error) {
      this.publish({
        stage: "review",
        error: error instanceof Error ? error.message : "voice_send_failed",
      });
    }
  }
  start() {
    if (this.state.stage !== "idle") return this.task;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.publish({
      stage: "starting",
      error: null,
      text: "",
      reviewReasons: [],
    });
    this.task = (async () => {
      try {
        if (!this.capture.supported())
          throw new Error("voice_device_unavailable");
        await this.capture.start(signal);
        if (signal.aborted) throw new Error("voice_cancelled");
        this.currentLevel = this.readLevel();
        const activity = new VoiceActivity(Date.now());
        this.publish({ stage: "recording" });
        this.monitor = setInterval(() => {
          this.currentLevel = this.readLevel();
          const outcome = activity.sample(
            this.currentLevel,
            Date.now(),
            this.currentFrame?.voiced,
          );
          if (outcome === "silence") void this.stop("silence");
          else if (outcome === "empty") void this.cancel("voice_empty");
        }, 100);
        this.timer = setTimeout(() => {
          void this.stop("limit");
        }, VOICE_SECONDS * 1000);
      } catch (error) {
        try {
          await this.capture.discard();
        } catch {
          error = new Error("voice_capture_failed");
        }
        const code =
          error instanceof Error ? error.message : "voice_capture_failed";
        if (!signal.aborted) this.publish({ stage: "idle", error: code });
        else if (
          code === "voice_permission" ||
          code === "voice_permission_ready"
        )
          this.publish({ error: code });
      }
    })();
    return this.task;
  }
  stop(reason: "user" | "silence" | "limit" = "user") {
    if (this.state.stage !== "recording") return this.task;
    clearTimeout(this.timer);
    clearInterval(this.monitor);
    this.stopReason = reason;
    const signal = this.controller.signal;
    this.publish({ stage: "stopping" });
    this.task = (async () => {
      try {
        const audio = await this.capture.stop();
        await this.capture.discard();
        if (signal.aborted) return;
        this.audio = audio;
      } catch {
        if (!signal.aborted)
          this.publish({ stage: "idle", error: "voice_capture_failed" });
        try {
          await this.capture.discard();
        } catch {
          /* The capture already reported its failure. */
        }
        return;
      }
      await this.processAudio(signal);
    })();
    return this.task;
  }
  /** Explicit retry only after transcription fails; normal stop uploads automatically. */
  upload() {
    if (this.state.stage !== "recorded" || !this.audio) return this.task;
    this.task = this.processAudio(this.controller.signal);
    return this.task;
  }
  private async processAudio(signal: AbortSignal) {
    if (signal.aborted || !this.audio) return;
    const request: VoiceRequest = {
      profile: VOICE_PROFILE,
      requestId: this.newId(),
      language: this.language,
      context: this.context,
      audio: this.audio,
      stopReason: this.stopReason,
    };
    this.publish({ stage: "transcribing", error: null });
    try {
      const result = VoiceTranscriptSchema.parse(
        await this.transcribe(request, signal),
      );
      if (signal.aborted) return;
      this.audio = undefined;
      const reviewReasons = [...result.reviewReasons];
      if (this.stopReason === "limit" && !reviewReasons.includes("limit"))
        reviewReasons.push("limit");
      this.publish({ stage: "review", text: result.text, reviewReasons });
      if (!reviewReasons.length) this.submit(true);
    } catch (error) {
      if (!signal.aborted)
        this.publish({
          stage: "recorded",
          error:
            error instanceof Error ? error.message : "voice_processing_failed",
        });
    }
  }
  cancel(error: string | null = null): Promise<void> {
    if (this.cancellation) return this.cancellation;
    clearTimeout(this.timer);
    clearInterval(this.monitor);
    this.controller.abort();
    this.publish({ stage: "cancelling", text: "" });
    this.cancellation = (async () => {
      try {
        await this.task;
        await this.capture.discard();
      } catch {
        error = "voice_capture_failed";
      } finally {
        this.audio = undefined;
        if (
          this.state.error === "voice_permission" ||
          this.state.error === "voice_permission_ready"
        )
          error = this.state.error;
        this.publish({ stage: "idle", text: "", error, reviewReasons: [] });
        this.cancellation = undefined;
      }
    })();
    return this.cancellation;
  }
}
