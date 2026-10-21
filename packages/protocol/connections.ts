import { z } from "zod";
import { AdminToolSchema } from "./admin";
import { IdentityId, IdentityName, OrganizationRole } from "./identity";
import { CrmContactSchema } from "./index";

export const ConnectionResultSchema = z.strictObject({
  contacts: z.array(CrmContactSchema.extend({ id: z.uuid() })).max(20),
  complete: z.boolean(),
});

export const ConnectionOrigin = z
  .url()
  .max(300)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  });
export const WorkspaceTarget = z.strictObject({
  organizationId: IdentityId,
  workspaceId: IdentityId,
});
export const ConnectionToolId = z.enum([
  "crm.contacts.list",
  "crm.contacts.search",
]);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const credentials = {
  apiKey: z
    .string()
    .min(20)
    .max(4096)
    .regex(/^[\x21-\x7E]+$/),
  expiresAt: z.iso.datetime(),
};
export const ConnectionCommandSchema = z.discriminatedUnion("type", [
  WorkspaceTarget.extend({
    type: z.literal("selectAgentConnection"),
    connectionId: IdentityId.nullable(),
    bindingRevision: z.number().int().nonnegative(),
  }),
  WorkspaceTarget.extend({
    type: z.literal("create"),
    name: IdentityName,
    provider: z.literal("twenty-test"),
    origin: ConnectionOrigin,
    ...credentials,
  }),
  WorkspaceTarget.extend({
    type: z.literal("configure"),
    connectionId: IdentityId,
    revision,
    enabled: z.boolean(),
    grants: z
      .array(
        z.strictObject({
          toolId: ConnectionToolId,
          roles: z.array(OrganizationRole).max(3),
        }),
      )
      .length(2)
      .refine((v) => new Set(v.map((g) => g.toolId)).size === 2),
  }),
  WorkspaceTarget.extend({
    type: z.literal("rotate"),
    connectionId: IdentityId,
    revision,
    ...credentials,
  }),
  WorkspaceTarget.extend({
    type: z.literal("remove"),
    connectionId: IdentityId,
    revision,
  }),
]);
export const ConnectionInvokeSchema = WorkspaceTarget.extend({
  connectionId: IdentityId,
  revision,
  toolId: ConnectionToolId,
  input: z.unknown(),
});
export const WorkspaceConnectionsSchema = WorkspaceTarget.extend({
  agentConnectionId: IdentityId.nullable(),
  bindingRevision: z.number().int().nonnegative(),
  canManage: z.boolean(),
  allowedOrigins: z.array(ConnectionOrigin).max(20),
  connections: z
    .array(
      z.strictObject({
        id: IdentityId,
        name: IdentityName,
        provider: z.literal("twenty-test"),
        origin: ConnectionOrigin,
        expiresAt: z.iso.datetime(),
        revision,
        enabled: z.boolean(),
        state: z.enum(["configured", "disabled", "expired", "unavailable"]),
        tools: z
          .array(
            AdminToolSchema.extend({
              id: ConnectionToolId,
              roles: z.array(OrganizationRole).max(3),
              canInvoke: z.boolean(),
            }),
          )
          .max(2),
      }),
    )
    .max(50),
});
export type WorkspaceConnections = z.infer<typeof WorkspaceConnectionsSchema>;
export type WorkspaceConnection = WorkspaceConnections["connections"][number];
