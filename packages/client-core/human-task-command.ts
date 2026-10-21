import { z } from "zod";
import {
  HUMAN_TASK_PROFILE,
  HumanTaskCommandSchema,
  HumanTaskSchema,
  humanTaskTransition,
  type HumanTask,
  type HumanTaskCommand,
} from "../protocol/human-tasks";

const SavedCommand = z.strictObject({
  version: z.literal(1),
  owner: z.string().min(1),
  pending: z
    .strictObject({ task: HumanTaskSchema, command: HumanTaskCommandSchema })
    .nullable(),
  legacyReviewed: z.boolean().default(false),
});
const LegacyPending = z
  .object({
    task: z
      .object({
        id: z.string().min(1).max(160),
        title: z.string().max(1000),
      })
      .passthrough(),
    command: z
      .object({
        decision: z.enum(["accept", "dismiss", "complete"]),
      })
      .passthrough(),
  })
  .passthrough();
const LegacySavedCommand = z
  .object({
    version: z.literal(1),
    owner: z.string().min(1),
    pending: LegacyPending.nullable(),
  })
  .passthrough();
export type HumanTaskAttempt = NonNullable<
  z.infer<typeof SavedCommand>["pending"]
>;
type CommandState = {
  phase: "restoring" | "idle" | "sending" | "uncertain";
  pending: HumanTaskAttempt | null;
  error: string | null;
  legacyPending?: { taskId: string; title: string; decision: string };
};
type CommandPorts = {
  identityKey: string;
  storage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
  };
  uuid(): string;
  owns(task: HumanTask): boolean;
  submit(id: string, command: HumanTaskCommand): Promise<HumanTask>;
  read(id: string): Promise<HumanTask>;
};
type RefreshProjection = (current: HumanTask | null) => Promise<void>;
const definitiveRejections = new Set([
  "human_task_revision_conflict",
  "human_task_transition_invalid",
  "human_task_conflict",
  "human_task_not_found",
]);
// AsyncStorage has no compare-and-set. Serialize each destination's local read/write pair
// across controllers, including a controller completing after its screen unmounted.
const writes = new Map<string, Promise<void>>();
class SavedDecisionChanged extends Error {
  constructor(readonly pending: HumanTaskAttempt) {
    super("human_task_saved_decision_changed");
  }
}
async function serializedWrite(key: string, operation: () => Promise<void>) {
  const previous = writes.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  writes.set(key, next);
  try {
    await next;
  } finally {
    if (writes.get(key) === next) writes.delete(key);
  }
}

/** One durable decision per authenticated destination. Retrying never revises its payload. */
export class HumanTaskCommandQueue {
  readonly key: string;
  readonly legacyKey: string;
  private state: CommandState = {
    phase: "restoring",
    pending: null,
    error: null,
  };
  private listeners = new Set<() => void>();
  private ready: Promise<void> | undefined;
  private sending = false;
  private storageBlocked = false;
  private legacyReviewed = false;
  constructor(private readonly ports: CommandPorts) {
    // The v1 queue has a different task meaning; its decisions are never replayed.
    this.key = `agent-client.human-task-command.v2:${ports.identityKey}`;
    this.legacyKey = `agent-client.human-task-command.v1:${ports.identityKey}`;
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(next: CommandState) {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
  restore() {
    return (this.ready ??= this.load());
  }
  private async load() {
    try {
      const raw = await this.ports.storage.getItem(this.key);
      const saved = raw ? SavedCommand.parse(JSON.parse(raw)) : null;
      if (saved && saved.owner !== this.ports.identityKey)
        throw new Error("human_task_scope_changed");
      this.legacyReviewed = saved?.legacyReviewed ?? false;
      if (!this.legacyReviewed) {
        const legacyRaw = await this.ports.storage.getItem(this.legacyKey);
        if (legacyRaw) {
          const legacy = LegacySavedCommand.parse(JSON.parse(legacyRaw));
          if (legacy.owner === this.ports.identityKey && legacy.pending) {
            this.publish({
              phase: "uncertain",
              pending: saved?.pending ?? null,
              error: "human_task_legacy_decision",
              legacyPending: {
                taskId: legacy.pending.task.id,
                title: legacy.pending.task.title,
                decision: legacy.pending.command.decision,
              },
            });
            return;
          }
        }
      }
      this.publish({
        phase: saved?.pending ? "uncertain" : "idle",
        pending: saved?.pending ?? null,
        error: null,
      });
    } catch {
      this.storageBlocked = true;
      this.publish({
        phase: "uncertain",
        pending: null,
        error: "human_task_storage_failed",
      });
    }
  }
  private async save(
    pending: HumanTaskAttempt | null,
    expected?: HumanTaskAttempt,
  ) {
    try {
      await serializedWrite(this.key, async () => {
        const raw = await this.ports.storage.getItem(this.key);
        const saved = raw ? SavedCommand.parse(JSON.parse(raw)) : null;
        if (saved && saved.owner !== this.ports.identityKey)
          throw new Error("human_task_scope_changed");
        if (!pending) {
          if (!saved?.pending) return;
          // Another mounted controller may have finished this command and saved a newer one.
          if (
            saved.owner !== this.ports.identityKey ||
            JSON.stringify(saved.pending) !== JSON.stringify(expected)
          )
            return;
        } else if (
          saved?.pending &&
          JSON.stringify(saved.pending) !== JSON.stringify(pending)
        ) {
          throw new SavedDecisionChanged(saved.pending);
        }
        await this.ports.storage.setItem(
          this.key,
          JSON.stringify({
            version: 1,
            owner: this.ports.identityKey,
            pending,
            legacyReviewed: saved?.legacyReviewed ?? this.legacyReviewed,
          }),
        );
      });
    } catch (error) {
      if (error instanceof SavedDecisionChanged) throw error;
      throw new Error("human_task_storage_failed");
    }
  }
  /** A person has reviewed the previous task and will choose from current Tasks actions. */
  async acknowledgeLegacyDecision() {
    await this.restore();
    const legacyPending = this.state.legacyPending;
    if (!legacyPending || this.sending || this.storageBlocked) return;
    try {
      await serializedWrite(this.key, async () => {
        const raw = await this.ports.storage.getItem(this.key);
        const saved = raw ? SavedCommand.parse(JSON.parse(raw)) : null;
        if (saved && saved.owner !== this.ports.identityKey)
          throw new Error("human_task_scope_changed");
        if (saved?.pending)
          throw new Error("human_task_saved_decision_changed");
        await this.ports.storage.setItem(
          this.key,
          JSON.stringify({
            version: 1,
            owner: this.ports.identityKey,
            pending: null,
            legacyReviewed: true,
          }),
        );
        const legacyRaw = await this.ports.storage.getItem(this.legacyKey);
        if (legacyRaw) {
          const legacy = LegacySavedCommand.parse(JSON.parse(legacyRaw));
          if (legacy.owner === this.ports.identityKey)
            await this.ports.storage.setItem(
              this.legacyKey,
              JSON.stringify({
                version: 1,
                owner: this.ports.identityKey,
                pending: null,
              }),
            );
        }
      });
      this.legacyReviewed = true;
      this.publish({ phase: "idle", pending: null, error: null });
    } catch {
      this.storageBlocked = true;
      this.publish({
        phase: "uncertain",
        pending: null,
        error: "human_task_storage_failed",
        legacyPending,
      });
    }
  }
  async decide(
    task: HumanTask,
    decision: HumanTaskCommand["decision"],
    refresh: RefreshProjection,
  ) {
    await this.restore();
    if (
      this.sending ||
      this.storageBlocked ||
      this.state.pending ||
      this.state.legacyPending
    )
      return;
    const parsed = HumanTaskSchema.parse(task);
    if (!this.ports.owns(parsed)) throw new Error("human_task_scope_changed");
    if (!humanTaskTransition(task.status, decision)) return;
    const id = this.ports.uuid();
    const pending = {
      task: parsed,
      command: HumanTaskCommandSchema.parse({
        profile: HUMAN_TASK_PROFILE,
        commandId: id,
        idempotencyKey: id,
        expectedRevision: task.revision,
        decision,
      }),
    };
    this.publish({ phase: "uncertain", pending, error: null });
    await this.deliver(refresh);
  }
  async retry(refresh: RefreshProjection) {
    await this.restore();
    if (!this.sending && !this.storageBlocked && this.state.pending)
      await this.deliver(refresh);
  }
  private async reconcileRejection(
    attempt: HumanTaskAttempt,
    refresh: RefreshProjection,
  ) {
    let current: HumanTask | null;
    try {
      current = HumanTaskSchema.parse(await this.ports.read(attempt.task.id));
      if (current.id !== attempt.task.id || !this.ports.owns(current))
        throw new Error("human_task_receipt_invalid");
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "human_task_not_found")
        throw error;
      current = null;
    }
    await refresh(current);
    await this.save(null, attempt);
    this.publish({
      phase: "idle",
      pending: null,
      error: current ? "human_task_changed" : "human_task_removed",
    });
  }
  private async deliver(refresh: RefreshProjection) {
    const attempt = this.state.pending;
    if (!attempt) return;
    this.sending = true;
    this.publish({ phase: "sending", pending: attempt, error: null });
    try {
      if (!this.ports.owns(attempt.task))
        throw new Error("human_task_scope_changed");
      // Persist before transport; a failed write never sends a decision.
      await this.save(attempt);
      const receipt = HumanTaskSchema.parse(
        await this.ports.submit(attempt.task.id, attempt.command),
      );
      const expected = humanTaskTransition(
        attempt.task.status,
        attempt.command.decision,
      );
      if (
        receipt.id !== attempt.task.id ||
        !this.ports.owns(receipt) ||
        receipt.revision !== attempt.command.expectedRevision + 1 ||
        receipt.status !== expected
      )
        throw new Error("human_task_receipt_invalid");
      const current = HumanTaskSchema.parse(
        await this.ports.read(attempt.task.id),
      );
      if (
        current.id !== receipt.id ||
        !this.ports.owns(current) ||
        current.revision < receipt.revision
      )
        throw new Error("human_task_receipt_invalid");
      await refresh(current);
      // A receipt and fresh projection are both required before clearing recovery.
      await this.save(null, attempt);
      this.publish({ phase: "idle", pending: null, error: null });
    } catch (error) {
      if (error instanceof SavedDecisionChanged) {
        this.publish({
          phase: "uncertain",
          pending: error.pending,
          error: error.message,
        });
        return;
      }
      if (error instanceof Error && definitiveRejections.has(error.message)) {
        try {
          // A confirmed rejection cannot be replayed into a new command. Reconcile it first.
          await this.reconcileRejection(attempt, refresh);
          return;
        } catch (failure) {
          error = failure;
        }
      }
      this.publish({
        phase: "uncertain",
        pending: attempt,
        error:
          error instanceof Error && /^human_task_[a-z_]+$/.test(error.message)
            ? error.message
            : "human_task_delivery_uncertain",
      });
    } finally {
      this.sending = false;
    }
  }
}
