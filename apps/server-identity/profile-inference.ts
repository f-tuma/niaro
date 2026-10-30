import {
  createNiaroMastraModel,
  type NiaroModelSelection,
} from "../server-integrations/mastra-model";
import type { IntegrationTransport } from "../server-integrations/transport";
import {
  budgetedInferenceTransport,
  type InferenceBudgetStore,
  type InferenceRunCaps,
} from "./inference-budget";
import type { MemoryActor } from "./memory";
import {
  ProfileCursorStore,
  type ProfileBatch,
  type ProfileCursor,
} from "./profile-cursor";
import {
  extractProfile,
  type ProfileExtraction,
} from "../server-agent/profile-extraction";
export const PROFILE_CAPS: InferenceRunCaps = Object.freeze({
  maxTokens: 40000,
  maxCostMicros: 100000,
  maxModelCalls: 2,
});
export type ProfileInferenceAccess = {
  selected: NiaroModelSelection;
  settingsRevision: number;
  policyVersion: number;
  budgetRevision: number;
  retentionDays: number;
  check: () => void;
  /** Captured material/version freshness; used before spending, not for late response settlement. */
  beforeDispatch?: () => void;
  useProvider: () => void;
  serial: <T>(run: () => Promise<T>) => Promise<T>;
};
/** Adapter over the existing SDK/model/transport and actual inference ledger. No alternate credentials or runtime. */
export class ProfileInference {
  constructor(
    private ledger: InferenceBudgetStore,
    private cursor: ProfileCursorStore,
    private transport: IntegrationTransport,
    private now = Date.now,
  ) {}
  canStart(actor: MemoryActor, access: ProfileInferenceAccess) {
    if (
      this.ledger.policy(actor.organizationId, actor.workspaceId).revision !==
      access.budgetRevision
    )
      return false;
    return this.ledger.canStartModel(
      actor.organizationId,
      actor.workspaceId,
      access.selected,
      PROFILE_CAPS,
    );
  }
  /** New lease, before current reservation: old reserved calls cannot pass their held lease guard. */
  prepareRecovery(actor: MemoryActor, lease: ProfileCursor) {
    return this.cursor.atomic(() => {
      this.cursor.check(actor, lease);
      const batch = this.cursor.pending(actor);
      if (!batch) return null;
      for (const call of this.cursor.calls(batch))
        if (call.state === "reserved") {
          const status = this.ledger.attemptStatus(
            batch.root,
            actor,
            call.attemptId,
          );
          if (status === "reserved") this.ledger.failed(call.attemptId);
          if (status === "reserved" || status === "cancelled")
            this.cursor.unpaid(batch, call.ordinal);
        }
      if (batch.state === "unusable" && this.proveUnpaid(actor, lease, batch))
        return this.cursor.replanUnpaid(actor, lease, batch, () =>
          this.proveUnpaid(actor, lease, batch),
        );
      return this.cursor.pending(actor);
    });
  }
  proveUnpaid(actor: MemoryActor, lease: ProfileCursor, batch: ProfileBatch) {
    this.cursor.check(actor, lease);
    const pending = this.cursor.pending(actor),
      calls = this.cursor.calls(batch);
    if (pending?.id !== batch.id || pending.root !== batch.root) return false;
    for (const call of calls) {
      if (!["unpaid", "reserved"].includes(call.state)) return false;
      try {
        if (
          this.ledger.attemptStatus(batch.root, actor, call.attemptId) !==
          "cancelled"
        )
          return false;
      } catch {
        return false;
      }
    }
    // Empty profile bindings plus an absent ledger run prove reserve never committed,
    // because the actual reserve/binding transaction is indivisible.
    return this.ledger.neverDispatched(batch.root, actor, calls.length === 0);
  }
  async extract(
    actor: MemoryActor,
    lease: ProfileCursor,
    batch: ProfileBatch,
    userPayload: string,
    access: ProfileInferenceAccess,
    signal: AbortSignal,
  ): Promise<ProfileExtraction> {
    for (const ordinal of [1, 2] as const) {
      const initial = await access.serial(async () => {
        access.check();
        this.cursor.check(actor, lease);
        if (!this.canStart(actor, access))
          throw Error("profile_budget_deferred");
        const pending = this.cursor.pending(actor);
        if (!pending || pending.id !== batch.id || pending.state === "unusable")
          throw Error("profile_batch_unusable");
        let call = this.cursor
          .calls(batch)
          .find((call) => call.ordinal === ordinal);
        if (
          call?.state === "reserved" &&
          this.ledger.attemptStatus(batch.root, actor, call.attemptId) ===
            "cancelled"
        ) {
          this.cursor.unpaid(batch, ordinal);
          call = this.cursor
            .calls(batch)
            .find((call) => call.ordinal === ordinal);
        }
        if (call?.state === "invalid") return { skip: true };
        if (call?.state === "received") {
          const response = this.cursor.response(actor, batch, call);
          if (!response) throw Error("profile_response_unavailable");
          return { response };
        }
        if (call && call.state !== "unpaid")
          throw Error("profile_unknown_response");
        if (ordinal === 2 && this.cursor.calls(batch)[0]?.state !== "invalid")
          throw Error("profile_repair_forbidden");
        if (!this.canStart(actor, access))
          throw Error("profile_budget_deferred");
        return {};
      });
      if (initial.skip) continue;
      let network = false;
      const savedCheckpoint = this.cursor.checkpoint(
        actor,
        batch,
        ordinal,
        access.retentionDays * 86400000,
      );
      const checkpoint = {
        ...savedCheckpoint,
        received: (...args: Parameters<typeof savedCheckpoint.received>) => {
          try {
            access.check();
          } catch {
            this.cursor.scrub(actor);
            return;
          }
          savedCheckpoint.received(...args);
        },
      };
      const base = initial.response
        ? async () => initial.response!
        : this.transport;
      const transport: IntegrationTransport = initial.response
        ? base
        : budgetedInferenceTransport(
            base,
            this.ledger,
            batch.root,
            actor,
            access.selected,
            "model",
            access.serial,
            async () => {
              access.check();
              access.beforeDispatch?.();
              this.cursor.check(actor, lease);
              if (!this.canStart(actor, access))
                throw Error("profile_budget_deferred");
            },
            () => 0,
            PROFILE_CAPS,
            checkpoint,
          );
      const bounded: IntegrationTransport = async (request) => {
        if (Buffer.byteLength(JSON.stringify(request.body)) > 24 * 1024)
          throw Error("profile_request_limit");
        const body = { ...(request.body as object), max_tokens: 2000 };
        return transport({
          ...request,
          body,
          maxRequestBytes: 24 * 1024,
          maxResponseBytes: 32768,
          timeoutMs: Math.max(1, Math.min(110000, lease.deadline - this.now())),
        });
      };
      const model = createNiaroMastraModel(
        access.selected,
        bounded,
        async (start) =>
          access.serial(async () => {
            access.check();
            access.beforeDispatch?.();
            this.cursor.check(actor, lease);
            signal.throwIfAborted();
            if (network) throw Error("profile_extra_dispatch");
            if (!initial.response) {
              if (!this.canStart(actor, access))
                throw Error("profile_budget_deferred");
              access.useProvider();
            }
            network = true;
            start();
          }),
        { timeoutMs: 110000, maxRequestBytes: 24 * 1024 },
      );
      let parsed = false;
      try {
        const result = await extractProfile(
          model,
          userPayload,
          signal,
          ordinal === 2,
        );
        parsed = true;
        await access.serial(async () => {
          access.check();
          access.beforeDispatch?.();
          this.cursor.check(actor, lease);
          if (!this.canStart(actor, access))
            throw Error("profile_budget_deferred");
        });
        return result;
      } catch (error) {
        if (parsed) throw error;
        signal.throwIfAborted();
        const received = await access.serial(async () => {
          const call = this.cursor
            .calls(batch)
            .find((call) => call.ordinal === ordinal);
          access.check();
          this.cursor.check(actor, lease);
          if (
            call?.state !== "received" ||
            !this.cursor.response(actor, batch, call)
          )
            return false;
          // A received but schema-invalid completion is positive paid evidence, allowing one same-root repair.
          this.cursor.invalid(batch, ordinal);
          return true;
        });
        if (!received || ordinal === 2) throw error;
      }
    }
    throw Error("profile_schema_exhausted");
  }
}
