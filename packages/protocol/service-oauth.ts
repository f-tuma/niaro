/* eslint-disable @typescript-eslint/no-redeclare -- Each schema deliberately shares its inferred TypeScript type name. */
import { z } from "zod";
import { IdentityId, IdentityName } from "./identity";
import { AuthProviderKindSchema } from "./auth-providers";
import {
  CatalogTarget,
  Revision,
  ServiceIcon,
  ServiceUrl,
} from "./service-catalog";

/** RFC 6749 scope-token: printable ASCII without space, quote or backslash. */
export const OAuthScope = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/);
export const ServiceOAuthSettings = z
  .strictObject({
    requiredFor: z.enum(["none", "writes", "all"]),
    /** service: the service publishes OAuth metadata and its own client.
     * provider: an organization sign-in method supplies endpoints and client. */
    source: z.enum(["service", "provider"]).optional(),
    authProviderId: IdentityId.nullable().optional(),
    /** Requested delegated permissions; defaults to Twenty's api and profile. */
    scopes: z.array(OAuthScope).max(30).optional(),
    /** Accepted only for existing saved configurations; not used as identity proof. */
    signInHint: z.enum(["service", "microsoft"]).optional(),
  })
  .refine((v) => v.source !== "provider" || !!v.authProviderId, {
    message: "A sign-in method is required",
    path: ["authProviderId"],
  });
export type ServiceOAuthSettings = z.infer<typeof ServiceOAuthSettings>;
export const OAuthMetadata = z.strictObject({
  issuer: ServiceUrl,
  authorizationEndpoint: ServiceUrl,
  tokenEndpoint: ServiceUrl,
  registrationEndpoint: ServiceUrl.nullable(),
  scopes: z.array(z.string().min(1).max(100)).max(50),
  tokenEndpointAuthMethods: z
    .array(z.enum(["none", "client_secret_post"]))
    .max(2),
  authorizationResponseIssParameterSupported: z.boolean(),
  /** Who vouches for a foreign issuer: absent means the service origin itself. */
  authority: z.enum(["protected-resource", "provider"]).optional(),
});
export type OAuthMetadata = z.infer<typeof OAuthMetadata>;
export const TwentyOAuthMetadata = OAuthMetadata;
export type TwentyOAuthMetadata = OAuthMetadata;
/** What the last automatic OAuth probe of the service address found. */
export const ServiceOAuthProbe = z.strictObject({
  at: z.number().int().positive(),
  /** configured: metadata and a client; metadata: metadata but no client
   * (no registration endpoint, or registration failed); none: no usable
   * metadata, `reason` says why in one error code. */
  outcome: z.enum(["configured", "metadata", "none"]),
  reason: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .optional(),
});
export type ServiceOAuthProbe = z.infer<typeof ServiceOAuthProbe>;
export const ServiceOAuthConfig = z.strictObject({
  revision: Revision,
  settings: ServiceOAuthSettings,
  hasClientId: z.boolean(),
  hasClientSecret: z.boolean(),
  discovery: OAuthMetadata.nullable(),
  /** The last automatic probe of the current service address, if any. */
  lastProbe: ServiceOAuthProbe.nullable(),
});
export type ServiceOAuthConfig = z.infer<typeof ServiceOAuthConfig>;
export const TwentyOAuthIdentity = z.strictObject({
  userId: IdentityId,
  workspaceId: IdentityId,
  userWorkspaceId: IdentityId,
});
/** OpenID Connect account: sub, the issuer tenant and a display name. */
export const OidcOAuthIdentity = z.strictObject({
  subject: z.string().min(1).max(255),
  tenant: z.string().min(1).max(255).optional(),
  label: z.string().min(1).max(255).optional(),
});
export const ServiceOAuthIdentity = z.union([
  TwentyOAuthIdentity,
  OidcOAuthIdentity,
]);
export type ServiceOAuthIdentity = z.infer<typeof ServiceOAuthIdentity>;
export const ServiceOAuthStatus = z.strictObject({
  config: ServiceOAuthConfig,
  connection: z.strictObject({
    status: z.enum(["disconnected", "connected", "expired"]),
    revision: Revision,
    identity: ServiceOAuthIdentity.nullable(),
    expiresAt: z.number().int().positive().nullable(),
  }),
});
export type ServiceOAuthStatus = z.infer<typeof ServiceOAuthStatus>;
export const ServiceOAuthClientInput = z.strictObject({
  clientId: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .regex(/^[^\r\n]+$/)
    .optional(),
  clientSecret: z
    .string()
    .min(1)
    .max(8192)
    .regex(/^[^\r\n]+$/)
    .optional(),
});
export const ServiceOAuthFinishInput = z.strictObject({
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[^\r\n]+$/),
  iss: ServiceUrl.optional(),
});
export const ServiceConnectionCardSchema = z.strictObject({
  type: z.literal("service.connection"),
  version: z.literal(1),
  serviceId: IdentityId,
  service: z.string().min(1).max(100),
  signInHint: z.enum(["service", "microsoft"]).optional(),
  providerName: z.string().min(1).max(100).optional(),
  resumeText: z.string().min(1).max(2000).optional(),
});
export type ServiceConnectionCard = z.infer<typeof ServiceConnectionCardSchema>;
export const ServiceConnectionRequest = z.strictObject({
  serviceId: IdentityId,
});
export const ServiceConnectionPoll = ServiceConnectionRequest.extend({
  attemptId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional(),
});
export const ServiceConnectionStatus = z.strictObject({
  serviceId: IdentityId,
  status: z.enum(["disconnected", "connected", "expired"]),
  ready: z.boolean(),
  flow: z.enum(["pending", "connected", "cancelled"]).optional(),
});
export const ServiceConnectionStart = z.strictObject({
  attemptId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  serviceId: IdentityId,
  authorizationUrl: z.string().url().max(8192),
  expiresAt: z.number().int().positive(),
});
/** One service the person may use that asks for their own account, with the
 * state of that sign-in. Readable by members; carries no client or token data. */
export const PersonalSignIn = z.strictObject({
  serviceId: IdentityId,
  name: IdentityName,
  icon: ServiceIcon,
  iconSource: z.enum(["favicon", "custom"]),
  requiredFor: z.enum(["writes", "all"]),
  /** An administrator finished the setup, so a sign-in can start. */
  ready: z.boolean(),
  /** The organization sign-in method the account comes from, if any. */
  provider: z
    .strictObject({
      name: IdentityName,
      kind: AuthProviderKindSchema,
    })
    .nullable(),
  status: z.enum(["disconnected", "connected", "expired"]),
  /** A display label of the connected account when the service names one. */
  account: z.string().min(1).max(255).nullable(),
  expiresAt: z.number().int().positive().nullable(),
  /** `revision` for oauth/start. */
  configRevision: Revision,
  /** `connectionRevision` for oauth/disconnect. */
  connectionRevision: Revision,
});
export type PersonalSignIn = z.infer<typeof PersonalSignIn>;
export const PersonalSignInList = CatalogTarget.extend({
  services: z.array(PersonalSignIn).max(1000),
});
export type PersonalSignInList = z.infer<typeof PersonalSignInList>;

/** One action of a personal-sign-in service as the signed-in person set it
 * for their own assistant. Only actions an administrator left on appear. */
export const PersonalActionPermission = z.strictObject({
  id: IdentityId,
  /** For the owner's edits of an own service's action. */
  revision: Revision.optional(),
  name: IdentityName,
  description: z.string().max(2000),
  effect: z.enum(["read", "write"]),
  enabled: z.boolean(),
  /** Writes: "always" asks before each change. Reads never ask. */
  approval: z.enum(["always", "never"]),
});
export type PersonalActionPermission = z.infer<typeof PersonalActionPermission>;
export const PersonalServicePermissions = CatalogTarget.extend({
  serviceId: IdentityId,
  name: IdentityName,
  requiredFor: z.enum(["writes", "all"]),
  /** The person's own revision for this service; `revision` for the save. */
  revision: Revision,
  /** The owner of an own service may find, describe and remove its actions
   * (unless administrators keep that to themselves); `serviceRevision` for those. */
  manage: z.boolean().default(false),
  serviceRevision: Revision.optional(),
  actions: z.array(PersonalActionPermission).max(1000),
});
export type PersonalServicePermissions = z.infer<
  typeof PersonalServicePermissions
>;
export const PersonalPermissionsRequest = CatalogTarget.extend({
  serviceId: IdentityId,
});
export const PersonalPermissionsSave = PersonalPermissionsRequest.extend({
  revision: Revision,
  actions: z
    .array(
      z.strictObject({
        actionId: IdentityId,
        enabled: z.boolean(),
        approval: z.enum(["always", "never"]),
      }),
    )
    .min(1)
    .max(1000)
    .refine(
      (items) =>
        new Set(items.map((item) => item.actionId)).size === items.length,
    ),
});
/** "Don't ask next time" from an approval card: the card's operation names the
 * action; the server finds it in the person's own receipts. */
export const PersonalApprovalRequest = CatalogTarget.extend({
  operationId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
});
export const PersonalApprovalOption = z.strictObject({
  /** The operation is a change under the person's own account that they may
   * stop confirming. */
  available: z.boolean(),
});
