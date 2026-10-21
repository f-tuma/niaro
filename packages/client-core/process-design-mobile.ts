import { z } from "zod";
import type { DesignTurn } from "../protocol/process-design";
import type { Scope } from "../protocol";
import { ProcessDesignApiError } from "./session";

export const MobileDesignPendingSchema = z.strictObject({
  version: z.literal(1),
  workspaceId: z.string().min(1).max(160),
  /** Optional for compatibility with commands saved before service design. */
  serviceId: z.string().min(1).max(160).optional(),
  sessionId: z.string().min(1).max(160).nullable(),
  command: z.strictObject({
    action: z.enum(["start", "turn", "acknowledge", "accept"]),
    query: z.record(z.string(), z.string()),
    payload: z.record(z.string(), z.unknown()),
  }),
});
export type MobileDesignPending = z.infer<typeof MobileDesignPendingSchema>;

/**
 * These responses confirm that the server rejected a command. Timeouts and
 * throttling can happen after admission, so preserve the exact outbox entry.
 */
export function isRejectedMobileDesignCommand(cause: unknown): boolean {
  return (
    cause instanceof ProcessDesignApiError &&
    cause.status >= 400 &&
    cause.status < 500 &&
    cause.status !== 408 &&
    cause.status !== 425 &&
    cause.status !== 429
  );
}

/** Bind a recovered turn to all request data the server echoes immutably. */
export function mobileDesignTurnMatchesPending(
  pending: MobileDesignPending,
  turn: DesignTurn,
  binding: { organizationId: string; workspaceId: string },
): boolean {
  if (pending.command.action !== "turn" || !pending.sessionId) return false;
  const payload = pending.command.payload;
  return (
    turn.requestId === payload.requestId &&
    turn.sessionId === pending.sessionId &&
    turn.requestRevision === payload.revision &&
    turn.workspaceId === binding.workspaceId &&
    turn.organizationId === binding.organizationId &&
    turn.userText === payload.text &&
    turn.language === payload.language &&
    turn.model.id === payload.modelId
  );
}

export type AsyncDesignStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

/** Scope the tiny command journal to this exact authenticated destination. */
export function mobileDesignRecoveryKey(
  identityKey: string,
  scope: Scope,
  serviceId?: string | null,
) {
  const parts = [
    "niaro.process-design.mobile.v1",
    identityKey,
    scope.connectionId,
    scope.serverId,
    scope.userId,
    scope.workspaceId,
  ];
  if (serviceId) parts.push("service", serviceId);
  return parts.map(encodeURIComponent).join(":");
}

/** A command is never dispatched unless its immutable bytes are durable. */
export async function saveMobileDesignPending(
  storage: AsyncDesignStorage,
  key: string,
  pending: MobileDesignPending,
) {
  const safe = MobileDesignPendingSchema.parse(pending);
  await storage.setItem(key, JSON.stringify(safe));
  return safe;
}

export async function dispatchMobileDesignCommand<T>(
  storage: AsyncDesignStorage,
  key: string,
  pending: MobileDesignPending,
  send: (saved: MobileDesignPending) => Promise<T>,
  onSaved?: (saved: MobileDesignPending) => void,
): Promise<T> {
  const saved = await saveMobileDesignPending(storage, key, pending);
  onSaved?.(saved);
  return send(saved);
}

export async function loadMobileDesignPending(
  storage: AsyncDesignStorage,
  key: string,
  workspaceId: string,
): Promise<MobileDesignPending | null> {
  const raw = await storage.getItem(key);
  if (raw === null) return null;
  const pending = MobileDesignPendingSchema.parse(JSON.parse(raw));
  if (pending.workspaceId !== workspaceId)
    throw new Error("process_design_scope_changed");
  return pending;
}
