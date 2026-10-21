import { z } from "zod";
import { IdentityId, OrganizationRole } from "../../packages/protocol/identity";
import {
  ActionSettings,
  CatalogModelSchema,
  Revision,
  ServiceSettings,
} from "../../packages/protocol/service-catalog";
import { InferenceBudgetSettingsSchema } from "../../packages/protocol/inference-budget";

/** No endpoint, auth configuration, credential, binding secret or production data. */
export const ProcessTestCatalogSchema = z.strictObject({
  organizationId: IdentityId,
  workspaceId: IdentityId,
  userId: IdentityId,
  role: OrganizationRole,
  workspaceRoles: z.array(IdentityId).max(50),
  services: z
    .array(
      z.strictObject({
        id: IdentityId,
        revision: Revision,
        name: ServiceSettings.shape.name,
        enabled: z.boolean(),
        protocol: z.enum(["openapi", "mcp"]),
        access: ServiceSettings.shape.access,
        actions: z
          .array(ActionSettings.extend({ id: IdentityId, revision: Revision }))
          .max(64),
      }),
    )
    .max(64),
  models: z.array(CatalogModelSchema).max(32),
  providers: z
    .array(
      z.strictObject({
        id: IdentityId,
        revision: Revision,
        enabled: z.boolean(),
        dailyRequestLimit: z.number().int().positive().max(100000),
      }),
    )
    .max(32),
  budget: InferenceBudgetSettingsSchema,
  budgetRevision: Revision,
});
export type ProcessTestCatalog = z.infer<typeof ProcessTestCatalogSchema>;
