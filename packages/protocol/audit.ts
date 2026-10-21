import { z } from "zod";
import { IdentityId, IdentityName, OrganizationRole } from "./identity";
import { ConnectionToolId } from "./connections";
import { AIProfileId } from "./workspace-ai";

export const AUDIT_PROFILE = "agent-audit/1" as const;
export const AuditAction = z.enum([
  "mcp.access_issued",
  "mcp.access_revoked",
  "auth.provider_changed",
  "hosted.server_changed",
  "server.settings_changed",
  "server.settings_imported",
  "catalog.ai_changed",
  "catalog.routing_changed",
  "catalog.service_changed",
  "catalog.process_changed",
  "catalog.actions_discovered",
  "catalog.action_invoked",
  /** A person changed what their own assistant may do with a personal-sign-in service. */
  "catalog.personal_policy_changed",
  "organization.created",
  "account.created",
  "workspace.created",
  "member.role_changed",
  "member.removed",
  "workspace.member_changed",
  "workspace.role_changed",
  "workspace.ai_changed",
  "workspace.plugins_changed",
  "memory.changed",
  "memory.preference_changed",
  "calendar.created",
  "calendar.configured",
  "calendar.key_rotated",
  "calendar.removed",
  "calendar.executed",
  "connection.created",
  "connection.configured",
  "connection.key_rotated",
  "connection.removed",
  "connection.chat_selected",
  "tool.invoked",
  "invitation.created",
  "invitation.revoked",
  "password.reset_issued",
  "password.reset_used",
  "password.changed",
  "session.revoked",
  "skill.changed",
  /** The person stopped their own waiting work (question, approval, process). */
  "work.cancelled",
]);
export const AuditOutcome = z.enum([
  "succeeded",
  "running",
  "failed",
  "denied",
  "cancelled",
  "interrupted",
  "unknown",
]);
export const AuditReason = z.enum([
  "access_changed",
  "invalid_input",
  "provider_failed",
  "cancelled",
  "server_stopped",
]);
export const AuditDetails = z.strictObject({
  previousRole: OrganizationRole.optional(),
  role: OrganizationRole.optional(),
  enabled: z.boolean().optional(),
  allowed: z.boolean().optional(),
  revision: z.number().int().nonnegative().optional(),
  previousRevision: z.number().int().nonnegative().optional(),
  processEvent: z
    .enum([
      "draft_saved",
      "version_frozen",
      "version_tested",
      "version_activated",
      "native_version_activated",
      "native_version_rolled_back",
      "contract_test_started",
      "contract_test_completed",
      "contract_test_interrupted",
      "native_test_started",
      "native_test_completed",
      "native_test_interrupted",
      "native_test_qualified",
      "native_test_qualification_failed",
      "archived",
    ])
    .optional(),
  skillEvent: z
    .enum(["created", "updated", "enabled", "disabled", "archived"])
    .optional(),
  skillOwner: z.enum(["personal", "workspace"]).optional(),
  processVersion: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  calendarRoles: z.array(OrganizationRole).max(3).optional(),
  modelId: AIProfileId.nullable().optional(),
  voiceId: AIProfileId.nullable().optional(),
  previousModelId: AIProfileId.nullable().optional(),
  previousVoiceId: AIProfileId.nullable().optional(),
  expiresAt: z.iso.datetime().optional(),
  grants: z
    .array(
      z.strictObject({
        toolId: ConnectionToolId,
        roles: z.array(OrganizationRole).max(3),
      }),
    )
    .max(2)
    .optional(),
  toolId: ConnectionToolId.optional(),
  durationMs: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  reason: AuditReason.optional(),
  /** Result of an automatic OAuth probe of a service address. */
  oauthProbe: z.enum(["configured", "metadata", "none"]).optional(),
});
export const AuditRecordSchema = z.strictObject({
  organizationId: IdentityId,
  workspaceId: IdentityId.nullable(),
  actorId: IdentityId.nullable(),
  source: z.enum(["console", "chat", "recovery", "mcp"]),
  action: AuditAction,
  targetId: IdentityId.nullable(),
  outcome: AuditOutcome,
  details: AuditDetails,
});
export type AuditRecord = z.infer<typeof AuditRecordSchema>;
export const AuditEntrySchema = AuditRecordSchema.extend({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  actorName: IdentityName.nullable(),
  workspaceName: IdentityName.nullable(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;
export const AuditQuery = z.strictObject({
  organizationId: IdentityId,
  workspaceId: IdentityId.optional(),
  category: z.enum(["changes", "tools"]).optional(),
  outcome: AuditOutcome.optional(),
  before: z
    .string()
    .regex(/^[1-9][0-9]{0,15}$/)
    .transform(Number)
    .refine(Number.isSafeInteger)
    .optional(),
});
export const AuditPage = z.strictObject({
  profile: z.literal(AUDIT_PROFILE),
  organizationId: IdentityId,
  entries: z.array(AuditEntrySchema).max(50),
  nextBefore: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable(),
});
