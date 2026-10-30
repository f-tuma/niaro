import { z } from "zod";

export const ATTACHMENT_PROFILE = "agent-attachments/1" as const;
export const AttachmentIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9._:-]+$/);
export const AttachmentUuidSchema = z.uuid().regex(/^[0-9a-f-]+$/);
export const AttachmentShaSchema = z.string().regex(/^[0-9a-f]{64}$/);
const integer = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const AttachmentFilenameSchema = z
  .string()
  .min(1)
  .refine(
    (s) =>
      s === s.normalize("NFC") &&
      new TextEncoder().encode(s).length <= 255 &&
      !/[\/\\\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(
        s,
      ) &&
      s !== "." &&
      s !== "..",
  );
export const AttachmentMediaTypeSchema = z
  .string()
  .max(127)
  .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/);
const profile = z.literal(ATTACHMENT_PROFILE);
const mutation = { profile, requestId: AttachmentUuidSchema };
export const AttachmentTargetSchema = z.strictObject({
  conversationId: AttachmentIdSchema,
  expectedGeneration: AttachmentUuidSchema.nullable(),
  mode: z.enum(["current", "new"]),
});
export const AttachmentDraftCreateSchema = z.strictObject({
  ...mutation,
  target: AttachmentTargetSchema,
});
export const AttachmentUploadCreateSchema = z.strictObject({
  ...mutation,
  expectedRevision: integer,
  filename: AttachmentFilenameSchema,
  mediaType: AttachmentMediaTypeSchema,
  size: integer,
  sha256: AttachmentShaSchema,
});
export const AttachmentReferenceAddSchema = z.strictObject({
  ...mutation,
  expectedRevision: integer,
  source: z.strictObject({
    conversationId: AttachmentIdSchema,
    messageId: AttachmentIdSchema,
    contentId: AttachmentUuidSchema,
  }),
});
export const AttachmentRemoveSchema = z.strictObject({
  ...mutation,
  expectedRevision: integer,
});
export const AttachmentRetryLocalSchema = z.strictObject({
  ...mutation,
  expectedAttempt: integer,
  expectedVersion: integer,
});
export const AttachmentRefSchema = z.strictObject({
  contentId: AttachmentUuidSchema,
  sha256: AttachmentShaSchema,
});
export const AttachmentSendSchema = z.strictObject({
  profile,
  draftId: AttachmentUuidSchema,
  draftRevision: integer,
  generation: AttachmentUuidSchema,
  items: z
    .array(AttachmentRefSchema)
    .min(1)
    .max(10)
    .refine((a) => new Set(a.map((i) => i.contentId)).size === a.length),
});
export type AttachmentSend = z.infer<typeof AttachmentSendSchema>;
export const AttachmentPublicFileSchema = z.strictObject({
  contentId: AttachmentUuidSchema,
  filename: AttachmentFilenameSchema,
  mediaType: AttachmentMediaTypeSchema,
  size: integer,
  sha256: AttachmentShaSchema,
  availability: z.enum(["available", "unavailable"]),
});
export const AttachmentFailureCodeSchema = z.enum([
  "attachment_disabled",
  "attachment_invalid",
  "attachment_conflict",
  "attachment_stale",
  "attachment_unavailable",
  "attachment_type_unsupported",
  "attachment_too_large",
  "attachment_quota",
  "attachment_busy",
  "attachment_uncertain",
  "attachment_processing_unavailable",
  "attachment_retry_required",
  "attachment_integrity",
]);
export type AttachmentFailureCode = z.infer<typeof AttachmentFailureCodeSchema>;
export const AttachmentFailureSchema = z.strictObject({
  error: AttachmentFailureCodeSchema,
  retryable: z.boolean(),
  retryAfterSeconds: integer.max(3600).nullable(),
});
export const AttachmentProcessingSchema = z.strictObject({
  ingestionId: AttachmentUuidSchema,
  attempt: integer,
  version: integer,
  state: z.enum([
    "blocked_capability",
    "queued",
    "preparing",
    "waiting_retry",
    "handoff_started",
    "awaiting_publication",
    "published",
    "failed",
    "unknown",
    "cancelled",
  ]),
  failure: AttachmentFailureCodeSchema.nullable(),
});
export type AttachmentProcessing = z.infer<typeof AttachmentProcessingSchema>;
export const AttachmentDraftSchema = z.strictObject({
  profile,
  draftId: AttachmentUuidSchema,
  target: AttachmentTargetSchema,
  generation: AttachmentUuidSchema,
  revision: integer,
  state: z.enum(["open", "consumed", "removed", "expired"]),
  expiresAt: z.iso.datetime(),
  items: z.array(AttachmentPublicFileSchema).max(10),
});
export type AttachmentDraft = z.infer<typeof AttachmentDraftSchema>;
export const AttachmentUploadSchema = z
  .strictObject({
    profile,
    uploadId: AttachmentUuidSchema,
    contentId: AttachmentUuidSchema,
    state: z.enum([
      "created",
      "receiving",
      "putting",
      "unverified",
      "complete",
      "retryable_failure",
      "quarantined",
      "removed",
      "expired",
    ]),
    size: integer,
    sha256: AttachmentShaSchema,
    receivedBytes: z.number().int().nonnegative(),
    expiresAt: z.iso.datetime(),
    failure: AttachmentFailureCodeSchema.nullable(),
  })
  .refine((u) => u.receivedBytes <= u.size);
export type AttachmentUpload = z.infer<typeof AttachmentUploadSchema>;
export const ATTACHMENT_DEFAULT_LIMITS = Object.freeze({
  maxFileBytes: 25 * 1024 * 1024,
  maxMessageBytes: 50 * 1024 * 1024,
  maxMessageFiles: 10,
  maxDraftsPerOwner: 4,
  maxDraftsGlobal: 100,
  maxStagedFilesPerOwner: 20,
  maxStagedFilesGlobal: 200,
  maxStagedBytesPerOwner: 100 * 1024 * 1024,
  maxStagedBytesGlobal: 1024 * 1024 * 1024,
  maxRetainedFilesPerOwner: 500,
  maxRetainedFilesGlobal: 5000,
  maxRetainedBytesPerOwner: 1024 * 1024 * 1024,
  maxRetainedBytesGlobal: 10 * 1024 * 1024 * 1024,
  maxInboundUploads: 1,
  maxDownloads: 1,
  maxPendingPerOwner: 4,
  maxPendingGlobal: 64,
  draftTtlSeconds: 86400,
  uploadDeadlineSeconds: 120,
});
export type AttachmentLimits = {
  -readonly [K in keyof typeof ATTACHMENT_DEFAULT_LIMITS]: number;
};
const limitFields = Object.fromEntries(
  Object.entries(ATTACHMENT_DEFAULT_LIMITS).map(([key, max]) => [
    key,
    integer.max(max),
  ]),
) as { [K in keyof AttachmentLimits]: z.ZodNumber };
export const AttachmentLimitsSchema = z
  .strictObject(limitFields)
  .refine(
    (l) =>
      l.maxFileBytes <= l.maxMessageBytes &&
      l.maxMessageBytes <= l.maxMessageFiles * l.maxFileBytes &&
      l.maxDraftsPerOwner <= l.maxDraftsGlobal &&
      l.maxStagedFilesPerOwner <= l.maxStagedFilesGlobal &&
      l.maxStagedBytesPerOwner <= l.maxStagedBytesGlobal &&
      l.maxRetainedFilesPerOwner <= l.maxRetainedFilesGlobal &&
      l.maxRetainedBytesPerOwner <= l.maxRetainedBytesGlobal &&
      l.maxPendingPerOwner <= l.maxPendingGlobal &&
      l.maxStagedFilesPerOwner >= l.maxMessageFiles &&
      l.maxStagedBytesPerOwner >= l.maxMessageBytes &&
      l.maxRetainedFilesPerOwner >= l.maxStagedFilesPerOwner &&
      l.maxRetainedFilesGlobal >= l.maxStagedFilesGlobal &&
      l.maxRetainedBytesPerOwner >= l.maxStagedBytesPerOwner &&
      l.maxRetainedBytesGlobal >= l.maxStagedBytesGlobal &&
      l.draftTtlSeconds >= 3600 &&
      l.uploadDeadlineSeconds >= 15,
  );
/** New routes have a closed, single-value query contract. */
export function attachmentRouteProfile(params: URLSearchParams) {
  return (
    [...params.keys()].length === 1 &&
    params.getAll("profile").length === 1 &&
    params.get("profile") === ATTACHMENT_PROFILE
  );
}

export type AttachmentPublicFile = z.infer<typeof AttachmentPublicFileSchema>;
export const AttachmentCapabilitiesSchema = z.strictObject({
  profile,
  scope: z.strictObject({
    connectionId: AttachmentIdSchema,
    serverId: AttachmentIdSchema,
    userId: AttachmentIdSchema,
    workspaceId: AttachmentIdSchema,
  }),
  enabled: z.boolean(),
  storageAvailable: z.boolean(),
  processingAvailable: z.boolean(),
  reuseWithinGeneration: z.literal(true),
  crossGenerationCopy: z.literal("upload"),
  limits: AttachmentLimitsSchema,
});
export type AttachmentCapabilities = z.infer<
  typeof AttachmentCapabilitiesSchema
>;
export const AttachmentUploadCreatedSchema = z.strictObject({
  profile,
  draft: AttachmentDraftSchema,
  upload: AttachmentUploadSchema,
});
export const AttachmentProcessingResponseSchema = z.strictObject({
  profile,
  processing: AttachmentProcessingSchema,
});
