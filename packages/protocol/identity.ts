import { z } from "zod";

export const IdentityId = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
export const OrganizationRole = z.enum(["owner", "admin", "member"]);
export const IdentityName = z.string().trim().min(1).max(100);
export const WorkspaceRoleSchema = z.strictObject({
  id: IdentityId,
  name: IdentityName,
  revision: z.number().int().nonnegative(),
  memberIds: z.array(IdentityId).max(100),
});
export const NewAccountSchema = z.strictObject({
  name: IdentityName,
  email: z
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
  password: z.string().min(12).max(128),
});
export const BootstrapIdentitySchema = NewAccountSchema.extend({
  organizationName: IdentityName,
});
export const IdentityStateSchema = z.strictObject({
  profile: z.literal("agent-identity/1"),
  enabled: z.boolean(),
  needsSetup: z.boolean(),
  user: z
    .strictObject({ id: IdentityId, name: IdentityName, email: z.email() })
    .nullable(),
  organizations: z
    .array(
      z.strictObject({
        id: IdentityId,
        name: IdentityName,
        role: OrganizationRole,
      }),
    )
    .max(100),
});
export const MemberSchema = z.strictObject({
  id: IdentityId,
  userId: IdentityId,
  name: IdentityName,
  email: z.email(),
  role: OrganizationRole,
});
export const OrganizationDetailSchema = z.strictObject({
  organizationId: IdentityId,
  canManageMembers: z.boolean(),
  canManageWorkspaces: z.boolean(),
  members: z.array(MemberSchema).max(100),
  workspaces: z
    .array(
      z.strictObject({
        id: IdentityId,
        name: IdentityName,
        members: z.array(IdentityId).max(100),
        roles: z.array(WorkspaceRoleSchema).max(50).optional(),
        // No connector is inherited from the instance's legacy fixture profile.
        connectionCount: z.number().int().nonnegative().max(51),
        toolCount: z.number().int().nonnegative().max(101),
      }),
    )
    .max(100),
});
export const IdentityCommandSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("saveWorkspaceRole"),
    organizationId: IdentityId,
    workspaceId: IdentityId,
    id: IdentityId.optional(),
    revision: z.number().int().nonnegative(),
    name: IdentityName,
    memberIds: z
      .array(IdentityId)
      .max(100)
      .refine((v) => new Set(v).size === v.length),
  }),
  z.strictObject({
    type: z.literal("removeWorkspaceRole"),
    organizationId: IdentityId,
    workspaceId: IdentityId,
    id: IdentityId,
    revision: z.number().int().nonnegative(),
  }),
  NewAccountSchema.extend({
    type: z.literal("createAccount"),
    organizationId: IdentityId,
    role: z.enum(["admin", "member"]),
  }),
  z.strictObject({
    type: z.literal("changeRole"),
    organizationId: IdentityId,
    memberId: IdentityId,
    role: OrganizationRole,
  }),
  z.strictObject({
    type: z.literal("removeMember"),
    organizationId: IdentityId,
    memberId: IdentityId,
  }),
  z.strictObject({
    type: z.literal("createWorkspace"),
    organizationId: IdentityId,
    name: IdentityName,
  }),
  z.strictObject({
    type: z.literal("setWorkspaceMember"),
    organizationId: IdentityId,
    workspaceId: IdentityId,
    memberId: IdentityId,
    allowed: z.boolean(),
  }),
]);
export type IdentityState = z.infer<typeof IdentityStateSchema>;
export type OrganizationDetail = z.infer<typeof OrganizationDetailSchema>;
