/* eslint-disable @typescript-eslint/no-redeclare -- Each schema deliberately shares its inferred TypeScript type name. */
import { z } from "zod";
import { IdentityId } from "./identity";

export const MCP_ADMIN_PROFILE = "agent-mcp-admin/1" as const;

/** Whether members may connect external AI apps to a workspace. Owners and
 * administrators are never subject to it. */
export const McpPolicy = z.enum(["off", "review", "free"]);
export type McpPolicy = z.infer<typeof McpPolicy>;
export const McpGrantStatus = z.enum(["active", "pending", "rejected"]);
export type McpGrantStatus = z.infer<typeof McpGrantStatus>;
/** An OAuth app's approval in one workspace; null: nobody decided yet. */
export const McpAppState = z.enum(["approved", "pending", "rejected"]);
export type McpAppState = z.infer<typeof McpAppState>;
/** What linking an app into a workspace means for the person on consent. */
export const McpAvailability = z.enum([
  "available",
  "request",
  "pending",
  "rejected",
  "off",
]);
export type McpAvailability = z.infer<typeof McpAvailability>;
/** A CIMD client's ID is the URL of its metadata document. */
export const McpClientId = z.string().min(1).max(2048);
const Person = z.strictObject({
  name: z.string().max(200),
  email: z.string().max(320),
});

/** A member's grant as administrators see it; never its token or digest. */
export const McpAdminGrant = z.strictObject({
  id: IdentityId,
  person: Person,
  label: z.string().min(1).max(120),
  scopes: z.array(z.string()).min(1).max(3),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  status: McpGrantStatus,
  revision: z.number().int().nonnegative(),
  kind: z.enum(["manual", "oauth"]),
  /** The OAuth app the grant was linked through. */
  appName: z.string().max(100).nullable(),
});
export type McpAdminGrant = z.infer<typeof McpAdminGrant>;

export const McpAdminApp = z.strictObject({
  clientId: McpClientId,
  name: z.string().min(1).max(100),
  /** Host of a CIMD client's ID; null for an app registered on this server. */
  host: z.string().max(255).nullable(),
  redirectUris: z.array(z.string().max(2048)).max(10),
  state: McpAppState.nullable(),
  revision: z.number().int().nonnegative(),
  requestedBy: Person.nullable(),
  requestedAt: z.iso.datetime().nullable(),
});
export type McpAdminApp = z.infer<typeof McpAdminApp>;

export const McpAdminState = z.strictObject({
  profile: z.literal(MCP_ADMIN_PROFILE),
  policy: McpPolicy,
  revision: z.number().int().nonnegative(),
  requests: z.strictObject({
    grants: z.array(McpAdminGrant).max(1000),
    apps: z.array(McpAdminApp).max(1000),
  }),
  /** Members' active grants, manual and OAuth. */
  access: z.array(McpAdminGrant).max(1000),
  apps: z.array(McpAdminApp).max(1000),
});
export type McpAdminState = z.infer<typeof McpAdminState>;

export const McpAdminScope = z.strictObject({
  organizationId: IdentityId,
  workspaceId: IdentityId,
});
export const McpPolicyRequest = McpAdminScope.extend({
  policy: McpPolicy,
  revision: z.number().int().nonnegative(),
});
const Reason = z.string().trim().max(500).optional();
export const McpReviewRequest = z.discriminatedUnion("kind", [
  McpAdminScope.extend({
    kind: z.literal("grant"),
    id: IdentityId,
    revision: z.number().int().nonnegative(),
    decision: z.enum(["approve", "reject"]),
    reason: Reason,
  }),
  McpAdminScope.extend({
    kind: z.literal("app"),
    clientId: McpClientId,
    revision: z.number().int().nonnegative(),
    decision: z.enum(["approve", "reject", "withdraw"]),
    reason: Reason,
  }),
]);
export type McpReviewRequest = z.infer<typeof McpReviewRequest>;
export const McpAdminRevokeRequest = McpAdminScope.extend({
  grantId: IdentityId,
});
