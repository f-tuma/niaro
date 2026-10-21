import { z } from "zod";
import { IdentityId, IdentityName } from "./identity";

export const AuthProviderKindSchema = z.enum(["google", "microsoft", "github"]);
export const AuthProviderIdSchema = z.string().regex(/^ap_[a-f0-9]{32}$/);
const tenant = z.string().uuid();
const hostedDomain = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/);
export const AuthProviderInputSchema = z
  .strictObject({
    kind: AuthProviderKindSchema,
    name: IdentityName,
    enabled: z.boolean(),
    clientId: z.string().trim().min(1).max(512),
    clientSecret: z.string().min(1).max(4096).optional(),
    tenantId: tenant.nullable().optional(),
    hostedDomain: hostedDomain.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "microsoft" && !value.tenantId)
      ctx.addIssue({
        code: "custom",
        path: ["tenantId"],
        message: "A specific Microsoft tenant is required",
      });
    if (value.kind !== "microsoft" && value.tenantId)
      ctx.addIssue({
        code: "custom",
        path: ["tenantId"],
        message: "Only Microsoft has a tenant",
      });
    if (value.kind !== "google" && value.hostedDomain)
      ctx.addIssue({
        code: "custom",
        path: ["hostedDomain"],
        message: "Only Google has a hosted domain",
      });
  });
export const AuthProviderSchema = z.strictObject({
  id: AuthProviderIdSchema,
  organizationId: IdentityId,
  kind: AuthProviderKindSchema,
  name: IdentityName,
  enabled: z.boolean(),
  revision: z.number().int().positive(),
  clientId: z.string(),
  hasClientSecret: z.boolean(),
  tenantId: tenant.nullable(),
  hostedDomain: hostedDomain.nullable(),
  callbackURL: z.url(),
});
export const AuthProvidersSchema = z.strictObject({
  organizationId: IdentityId,
  canManage: z.boolean(),
  providers: z.array(AuthProviderSchema).max(100),
});
export const AuthProviderDraftSchema = z.strictObject({
  organizationId: IdentityId,
  providerId: AuthProviderIdSchema,
  callbackURL: z.url(),
});
export const SaveAuthProviderSchema = z
  .strictObject({
    organizationId: IdentityId,
    providerId: AuthProviderIdSchema.nullable(),
    creationId: AuthProviderIdSchema.optional(),
    revision: z.number().int().nonnegative(),
    input: AuthProviderInputSchema,
  })
  .refine(
    (value) =>
      !value.creationId || (value.providerId === null && value.revision === 0),
    { path: ["creationId"], message: "A draft ID is only valid for creation" },
  );
export const DeleteAuthProviderSchema = z.strictObject({
  organizationId: IdentityId,
  providerId: AuthProviderIdSchema,
  revision: z.number().int().positive(),
});
export const AuthProviderStartSchema = z.strictObject({
  providerId: AuthProviderIdSchema,
});
export const AuthProviderChoiceSchema = AuthProviderSchema.pick({
  id: true,
  organizationId: true,
  kind: true,
  name: true,
});
export const AuthProviderLinkedStatusSchema = z.strictObject({
  providerId: AuthProviderIdSchema,
  providerRevision: z.number().int().positive(),
  name: IdentityName,
  kind: AuthProviderKindSchema,
  linked: z.boolean(),
});
export type AuthProvider = z.infer<typeof AuthProviderSchema>;
export type AuthProviderInput = z.infer<typeof AuthProviderInputSchema>;
export type AuthProviderKind = z.infer<typeof AuthProviderKindSchema>;
export type AuthProviderLinkedStatus = z.infer<
  typeof AuthProviderLinkedStatusSchema
>;
