import { z } from "zod";
import {
  ATTACHMENT_DEFAULT_LIMITS,
  AttachmentLimitsSchema,
  type AttachmentLimits,
  type AttachmentFailureCode,
} from "../../packages/protocol/attachments";

export type AttachmentConfiguration = {
  enabled: boolean;
  limits: AttachmentLimits;
  invalid: boolean;
};
export function loadAttachmentConfiguration(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AttachmentConfiguration {
  const limits: AttachmentLimits = { ...ATTACHMENT_DEFAULT_LIMITS };
  const names = new Set([
    "NIARO_ATTACHMENTS_ENABLED",
    ...Object.keys(limits).map(
      (key) =>
        `NIARO_ATTACHMENTS_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`,
    ),
  ]);
  let valid =
    env.NIARO_ATTACHMENTS_ENABLED === undefined ||
    /^(true|false)$/.test(env.NIARO_ATTACHMENTS_ENABLED);
  for (const key of Object.keys(limits) as (keyof AttachmentLimits)[]) {
    const name = `NIARO_ATTACHMENTS_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
    const value = env[name];
    if (value === undefined) continue;
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
      valid = false;
    else limits[key] = Number(value);
  }
  valid &&= !Object.keys(env).some(
    (key) =>
      key.startsWith("NIARO_ATTACHMENTS_") &&
      !names.has(key) &&
      env[key] !== undefined,
  );
  const parsed = AttachmentLimitsSchema.safeParse(limits);
  valid &&= parsed.success;
  return {
    enabled: valid && env.NIARO_ATTACHMENTS_ENABLED === "true",
    limits: valid ? limits : { ...ATTACHMENT_DEFAULT_LIMITS },
    invalid: !valid,
  };
}
export class AttachmentError extends Error {
  constructor(
    readonly code: AttachmentFailureCode,
    readonly status = 400,
  ) {
    super(code);
  }
  get body() {
    const retryable =
      ["attachment_busy", "attachment_quota"].includes(this.code) ||
      (this.code === "attachment_unavailable" && this.status === 503);
    return {
      error: this.code,
      retryable,
      retryAfterSeconds: retryable ? 5 : null,
    };
  }
}
export const scopeKey = (scope: {
  connectionId: string;
  serverId: string;
  userId: string;
  workspaceId: string;
}) =>
  JSON.stringify([
    scope.connectionId,
    scope.serverId,
    scope.userId,
    scope.workspaceId,
  ]);
export const ownerKey = (scope: {
  serverId: string;
  userId: string;
  workspaceId: string;
}) => JSON.stringify([scope.serverId, scope.workspaceId, scope.userId]);
export function strictJson<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AttachmentError("attachment_invalid");
  return parsed.data;
}
