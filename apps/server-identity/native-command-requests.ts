import type { Scope } from "../../packages/protocol";
import { processDigest } from "./process-validation";
import { IdentityError } from "./error";

export const nativeRequestKey = (scope: Scope, id: string) =>
  JSON.stringify([
    scope.connectionId,
    scope.serverId,
    scope.workspaceId,
    scope.userId,
    id,
  ]);
/**
 * One person's run lane in a workspace. It is the same for every credential
 * they hold (web chat, app), so one person never occupies more than one slot
 * per lane of MAX_ACTIVE_RUNS by signing in twice.
 */
export const personLane = (
  scope: Pick<Scope, "workspaceId" | "userId">,
  lane?: "hub",
) =>
  JSON.stringify(
    lane
      ? [scope.workspaceId, scope.userId, lane]
      : [scope.workspaceId, scope.userId],
  );
export type NativeTrackedRequest = {
  scope: Scope;
  profile: "workflow" | "process";
  command: { commandId: string; idempotencyKey: string };
  controller: AbortController;
  promise: Promise<unknown>;
  unsettled: boolean;
  parentRunId?: string;
  /** Adapter-owned passive proof; never recovery or dispatch. */
  retire?: () => Promise<boolean>;
};
/** Shared request ownership only. Adapters retain native retirement proof and publication. */
/**
 * Native runs (chat turns, process runs) the server executes at once, across
 * everyone. Each person still has one run per lane at a time. Size it to the
 * provider's rate limits and the machine (`NIARO_MAX_CONCURRENT_RUNS`).
 */
export const MAX_ACTIVE_RUNS = Math.max(
  1,
  Math.min(64, Number(process.env.NIARO_MAX_CONCURRENT_RUNS) || 8),
);

export class NativeCommandRequests {
  readonly activeScopes = new Set<string>();
  private permits = new Map<string, NativeTrackedRequest | undefined>();
  private commands = new Map<string, NativeTrackedRequest>();
  private idempotency = new Map<string, NativeTrackedRequest>();
  find<T extends NativeTrackedRequest>(
    scope: Scope,
    command: T["command"],
    profile: T["profile"],
  ): T | undefined {
    const byId = this.commands.get(nativeRequestKey(scope, command.commandId));
    const byKey = this.idempotency.get(
      nativeRequestKey(scope, command.idempotencyKey),
    );
    if (byId && byKey && byId !== byKey)
      throw new IdentityError(409, "idempotency_conflict");
    const previous = byId ?? byKey;
    if (
      previous &&
      (previous.profile !== profile ||
        processDigest(previous.command) !== processDigest(command))
    )
      throw new IdentityError(409, "idempotency_conflict");
    return previous as T | undefined;
  }
  register(entry: NativeTrackedRequest) {
    if (this.find(entry.scope, entry.command, entry.profile))
      throw new IdentityError(429, "catalog_busy");
    if (this.commands.size >= 512) throw new IdentityError(429, "catalog_busy");
    this.commands.set(
      nativeRequestKey(entry.scope, entry.command.commandId),
      entry,
    );
    this.idempotency.set(
      nativeRequestKey(entry.scope, entry.command.idempotencyKey),
      entry,
    );
  }
  values(): Iterable<NativeTrackedRequest> {
    return this.commands.values();
  }
  acquireScope(key: string, owner: NativeTrackedRequest | undefined) {
    if (this.activeScopes.has(key))
      throw new IdentityError(429, "catalog_busy");
    this.permits.set(key, owner);
    this.activeScopes.add(key);
  }
  releaseScope(key: string, owner: NativeTrackedRequest | undefined) {
    if (this.permits.has(key) && this.permits.get(key) === owner) {
      this.permits.delete(key);
      this.activeScopes.delete(key);
    }
  }
  /** Releases every lane the request holds, whatever key it was acquired under. */
  releaseOwner(owner: NativeTrackedRequest) {
    for (const [key, held] of this.permits)
      if (held === owner) {
        this.permits.delete(key);
        this.activeScopes.delete(key);
      }
  }
  release(entry: NativeTrackedRequest) {
    if (entry.unsettled) return;
    const id = nativeRequestKey(entry.scope, entry.command.commandId),
      key = nativeRequestKey(entry.scope, entry.command.idempotencyKey);
    if (this.commands.get(id) === entry) this.commands.delete(id);
    if (this.idempotency.get(key) === entry) this.idempotency.delete(key);
  }
  abortAll() {
    for (const entry of this.commands.values()) entry.controller.abort();
  }
  /** Retry only adapter-owned passive cleanup for abandoned scopes; no caller data is returned. */
  async retireOwned() {
    for (const entry of this.commands.values()) {
      if (!entry.unsettled || !entry.retire) continue;
      let proved = false;
      try {
        proved = await entry.retire();
      } catch {
        /* Proof gaps retain ownership. */
      }
      if (proved && entry.unsettled) {
        entry.unsettled = false;
        this.releaseOwner(entry);
        this.release(entry);
      }
    }
  }
  async retireScope(
    scope: Scope,
    proof: (entry: NativeTrackedRequest) => Promise<boolean>,
  ) {
    const key = JSON.stringify(scope);
    for (const entry of this.commands.values()) {
      if (!entry.unsettled || JSON.stringify(entry.scope) !== key) continue;
      let proved = false;
      try {
        proved = await proof(entry);
      } catch {
        /* Unavailable proof retains ownership. */
      }
      if (proved && entry.unsettled) {
        entry.unsettled = false;
        this.releaseOwner(entry);
        this.release(entry);
      }
    }
  }
}
