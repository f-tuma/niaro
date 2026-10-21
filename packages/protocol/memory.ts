import { z } from "zod";
import { WorkspaceTarget } from "./connections";
import { IdentityId } from "./identity";
import { MessageSchema } from "./index";

export const MEMORY_DEFAULTS = {
  retentionDays: 365,
  maxContextChars: 4000,
  maxItems: 8,
  allowShared: false,
} as const;
export const MemorySettingsSchema = z.strictObject({
  retentionDays: z
    .number()
    .int()
    .min(1)
    .max(3650)
    .default(MEMORY_DEFAULTS.retentionDays),
  maxContextChars: z
    .number()
    .int()
    .min(500)
    .max(12000)
    .default(MEMORY_DEFAULTS.maxContextChars),
  maxItems: z.number().int().min(1).max(20).default(MEMORY_DEFAULTS.maxItems),
  allowShared: z.boolean().default(MEMORY_DEFAULTS.allowShared),
});
export type MemorySettings = z.infer<typeof MemorySettingsSchema>;
export const MemoryKindSchema = z.enum(["preference", "fact", "note"]);
export const MemoryScopeSchema = z.enum(["private", "workspace"]);
export const MemoryStatusSchema = z.enum([
  "candidate",
  "active",
  "superseded",
  "deleted",
]);
export const MemoryContentSchema = z.string().trim().min(1).max(4000);
export const MemorySourceSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("user_note"),
  }),
  z.strictObject({
    type: z.literal("user_message"),
    commandId: MessageSchema.shape.id,
    conversationId: MessageSchema.shape.id.optional(),
  }),
  z.strictObject({
    type: z.literal("verified_operation"),
    operationId: IdentityId,
    serviceId: IdentityId,
    verifiedAt: z.iso.datetime(),
  }),
]);
export type MemorySource = z.infer<typeof MemorySourceSchema>;
export const MemoryItemSchema = z.strictObject({
  id: IdentityId,
  scope: MemoryScopeSchema,
  kind: MemoryKindSchema,
  status: MemoryStatusSchema,
  revision: z.number().int().positive(),
  content: MemoryContentSchema.nullable(),
  source: MemorySourceSchema.nullable(),
  trust: z
    .enum(["user_assertion", "verified_result", "model_inference"])
    .nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
  supersedesId: IdentityId.nullable(),
});
export type MemoryItem = z.infer<typeof MemoryItemSchema>;
export const MemoryViewSchema = WorkspaceTarget.extend({
  profile: z.literal("agent-memory/1"),
  version: z.number().int().nonnegative(),
  enabled: z.boolean(),
  canManageShared: z.boolean(),
  optOut: z.boolean(),
  items: z.array(MemoryItemSchema).max(200),
});
export type MemoryView = z.infer<typeof MemoryViewSchema>;
const command = WorkspaceTarget.extend({ requestId: IdentityId });
const expectedRevision = z.number().int().positive();
/** Source provenance, trust and the authenticated user are always established by the server. */
export const MemoryCommandSchema = z.discriminatedUnion("type", [
  command.extend({
    type: z.literal("remember"),
    content: MemoryContentSchema,
    kind: MemoryKindSchema,
    scope: MemoryScopeSchema.default("private"),
  }),
  command.extend({
    type: z.literal("revise"),
    id: IdentityId,
    revision: expectedRevision,
    content: MemoryContentSchema,
  }),
  command.extend({
    type: z.literal("forget"),
    id: IdentityId,
    revision: expectedRevision,
  }),
  command.extend({
    type: z.literal("preference"),
    optOut: z.boolean(),
  }),
]);
export type MemoryCommand = z.infer<typeof MemoryCommandSchema>;
