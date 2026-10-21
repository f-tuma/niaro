import { VoiceError } from "./voice-media";

/** Who is waiting: a person dictating in chat, or a meeting being processed. */
export type SpeechPriority = "chat" | "background";
type Waiter = {
  priority: SpeechPriority;
  start: () => void;
};
/**
 * A fair semaphore in front of speech recognition. Work waits for a free
 * slot instead of failing as busy. Chat voice always goes first, and
 * background work (meeting chunks) may hold at most `backgroundSlots` of the
 * `slots`, so a long meeting never starves someone dictating a message.
 */
export class SpeechQueue {
  private active = 0;
  private activeBackground = 0;
  private waiting: Waiter[] = [];
  constructor(
    readonly slots = 4,
    readonly backgroundSlots = 3,
    /** Chat requests waiting beyond this are refused as busy. */
    readonly maxChatWaiting = 16,
  ) {
    if (slots < 1 || backgroundSlots < 1 || backgroundSlots > slots)
      throw new Error("speech_queue_invalid");
  }
  get stats() {
    return {
      active: this.active,
      activeBackground: this.activeBackground,
      waitingChat: this.waiting.filter((w) => w.priority === "chat").length,
      waitingBackground: this.waiting.filter((w) => w.priority === "background")
        .length,
    };
  }
  private admissible(priority: SpeechPriority) {
    return (
      this.active < this.slots &&
      (priority === "chat" || this.activeBackground < this.backgroundSlots)
    );
  }
  private next() {
    for (;;) {
      // Chat first, each kind in arrival order.
      const index = [
        this.waiting.findIndex((w) => w.priority === "chat"),
        this.waiting.findIndex((w) => w.priority === "background"),
      ].find((i) => i >= 0 && this.admissible(this.waiting[i]!.priority));
      if (index === undefined) return;
      const [waiter] = this.waiting.splice(index, 1);
      waiter!.start();
    }
  }
  async run<T>(
    priority: SpeechPriority,
    fn: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    if (
      priority === "chat" &&
      !this.admissible(priority) &&
      this.waiting.filter((w) => w.priority === "chat").length >=
        this.maxChatWaiting
    )
      throw new VoiceError("voice_busy", 429);
    await new Promise<void>((resolve, reject) => {
      const take = () => {
        this.active++;
        if (priority === "background") this.activeBackground++;
      };
      if (
        this.admissible(priority) &&
        !this.waiting.some(
          (w) => w.priority === "chat" || w.priority === priority,
        )
      ) {
        take();
        resolve();
        return;
      }
      const onAbort = () => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(signal!.reason);
      };
      const waiter: Waiter = {
        priority,
        start: () => {
          signal?.removeEventListener("abort", onAbort);
          take();
          resolve();
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(waiter);
    });
    try {
      return await fn();
    } finally {
      this.active--;
      if (priority === "background") this.activeBackground--;
      this.next();
    }
  }
}
