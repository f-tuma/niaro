import { z } from "zod";
import { IdentityId, IdentityName, OrganizationRole } from "./identity";

export const ServiceUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ["https:", "http:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        !/[\\\s]/.test(value)
      );
    } catch {
      return false;
    }
  }, "Use an HTTP(S) URL without credentials, query or fragment");
export const JsonObject = z.record(z.string(), z.unknown());
export const Revision = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export const ServiceIcon = z.enum([
  "plug",
  "database",
  "users",
  "calendar",
  "mail",
  "code",
  "folder",
  "search",
]);
export const ApiAuth = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("none") }),
  z.strictObject({ type: z.literal("bearer") }),
  z.strictObject({
    type: z.literal("header"),
    header: z.string().regex(/^x-[a-z0-9-]{1,60}$/i),
  }),
]);
/** A service a person connected for themselves: it serves only its owner,
 * and only once an administrator has approved it where the workspace asks
 * for that. */
export const PersonalServiceStatus = z.enum(["pending", "active", "rejected"]);
export const PersonalOwnership = z.strictObject({
  userId: IdentityId,
  status: PersonalServiceStatus,
  addedAt: z.iso.datetime(),
  /** Why an administrator rejected it, for its owner. */
  reason: z.string().trim().max(500).optional(),
  reviewedBy: IdentityId.optional(),
  reviewedAt: z.iso.datetime().optional(),
});
export type PersonalOwnershipValue = z.infer<typeof PersonalOwnership>;
/** Whether members may connect their own services: not at all, after an
 * administrator's review, or at once. */
export const PersonalServicesPolicy = z.enum(["off", "review", "free"]);
export type PersonalServicesPolicyValue = z.infer<
  typeof PersonalServicesPolicy
>;
/** Who manages the actions of a member's own service: its owner (finds,
 * describes and removes them), or administrators alone. */
export const PersonalServicesManagement = z.enum(["owner", "administrators"]);
export type PersonalServicesManagementValue = z.infer<
  typeof PersonalServicesManagement
>;
/** How many services one person may connect in a workspace. */
export const PERSONAL_SERVICES_LIMIT = 5;
export const ServiceSettings = z.strictObject({
  name: IdentityName,
  /** What the service is for, in the words the assistant routes by. */
  description: z.string().trim().max(500).optional(),
  url: ServiceUrl,
  protocol: z.enum(["openapi", "mcp"]),
  icon: ServiceIcon,
  iconSource: z.enum(["favicon", "custom"]).default("favicon"),
  auth: ApiAuth,
  enabled: z.boolean(),
  /** Set only through the person's own "Add service"; never by saveService. */
  personal: PersonalOwnership.optional(),
  access: z
    .strictObject({
      roles: z.array(OrganizationRole).max(3),
      workspaceRoles: z.array(IdentityId).max(50),
    })
    .optional(),
});
export const ActionBinding = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("http"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z
      .string()
      .max(1024)
      .regex(/^\/(?!\/)[^?#\\]*$/),
    parameters: z
      .array(
        z.strictObject({
          name: z.string().min(1).max(100),
          in: z.enum(["path", "query"]),
          required: z.boolean(),
        }),
      )
      .max(40),
    body: z.boolean(),
  }),
  z
    .strictObject({
      type: z.literal("mcp"),
      name: z.string().min(1).max(128),
      catalogTool: z.string().min(1).max(128).optional(),
    })
    .refine(
      (binding) => !binding.catalogTool || binding.name === "execute_tool",
    ),
]);
/** Whether a Twenty catalog tool reads records, by the name grammar Twenty
 * documents (find_many_, find_one_, group_by_). A hint, never applied alone. */
export function twentyReadTool(name: string) {
  return /^(find_many|find_one|group_by)_[a-z0-9_]+$/.test(name);
}
/** Whether a provider's failure message says it refused the credential or
 * its permissions (HTTP 401/403), not that the request itself was wrong. */
export function providerDenied(message: string | undefined) {
  return (
    !!message &&
    /\b(401|403)\b|forbidden|unauthori[sz]ed|access ?(is )?denied|insufficient (privileges|scope)/i.test(
      message,
    )
  );
}
export const ActionPolicy = z
  .strictObject({
    roles: z.array(OrganizationRole).max(3),
    workspaceRoles: z.array(IdentityId).max(50).optional(),
    users: z
      .array(
        z.strictObject({
          userId: IdentityId,
          access: z.enum(["allow", "deny"]),
        }),
      )
      .max(100),
  })
  .refine((v) => new Set(v.users.map((u) => u.userId)).size === v.users.length);
export const ActionSettings = z.strictObject({
  name: IdentityName,
  description: z.string().trim().max(2000),
  inputSchema: JsonObject,
  binding: ActionBinding,
  effect: z.enum(["read", "write"]),
  approval: z.enum(["always", "never"]),
  enabled: z.boolean(),
  policy: ActionPolicy,
});
export const ServiceActionSchema = ActionSettings.extend({
  id: IdentityId,
  revision: Revision,
  sourceKey: z.string().max(1200).nullable(),
});
export const ServiceSchema = ServiceSettings.extend({
  id: IdentityId,
  revision: Revision,
  hasCredential: z.boolean(),
  modelId: IdentityId.nullable(),
  actions: z.array(ServiceActionSchema).max(1000),
});
export const ProviderSettings = z.strictObject({
  name: IdentityName,
  url: ServiceUrl,
  enabled: z.boolean(),
  dailyRequestLimit: z.number().int().min(1).max(100000),
});
export const ProviderSchema = ProviderSettings.extend({
  id: IdentityId,
  revision: Revision,
  hasCredential: z.boolean(),
  requestsToday: z.number().int().nonnegative(),
});
export const CatalogModelSettings = z.strictObject({
  providerId: IdentityId,
  name: IdentityName,
  model: z.string().trim().min(1).max(200),
  enabled: z.boolean(),
  tools: z.boolean(),
  audioInput: z.boolean().default(false),
  audioOutput: z.boolean().default(false),
  kind: z
    .enum(["chat", "decision", "router", "transcription", "speech"])
    .default("chat"),
});
export const CatalogModelSchema = CatalogModelSettings.extend({
  id: IdentityId,
  revision: Revision,
});
export const DiscoveredModelSchema = z.strictObject({
  model: z.string().trim().min(1).max(200),
  name: IdentityName,
  tools: z.boolean().nullable(),
  audioInput: z.boolean().nullable().default(null),
  audioOutput: z.boolean().nullable().default(null),
  contextLength: z.number().int().positive().nullable(),
  kind: z
    .enum(["chat", "decision", "router", "transcription", "speech"])
    .default("chat"),
  /** Provider-published list price in USD millionths per million tokens. */
  pricing: z
    .strictObject({
      inputMicrosPerMillion: z.number().int().nonnegative().max(1_000_000_000),
      outputMicrosPerMillion: z.number().int().nonnegative().max(1_000_000_000),
    })
    .nullable()
    .default(null),
});
export const ModelDiscoveryResponse = z.strictObject({
  models: z.array(DiscoveredModelSchema).max(5000),
});
export type DiscoveredModel = z.infer<typeof DiscoveredModelSchema>;
export const Routing = z.strictObject({
  revision: Revision,
  modelId: IdentityId.nullable(),
  voiceModelId: IdentityId.nullable().default(null),
  voiceMode: z.enum(["legacy", "disabled", "catalog"]).default("legacy"),
  voiceMethod: z.enum(["interpreter", "transcription"]).default("interpreter"),
  /**
   * A speech-to-text model for meetings when the voice model is not one
   * (for example openai/gpt-4o-transcribe). Null: the voice model, if it is
   * speech-to-text, else minute-by-minute recognition through voice.
   */
  meetingTranscriptionModelId: IdentityId.nullable().default(null),
  speech: z
    .strictObject({
      modelId: IdentityId.nullable(),
      method: z.enum(["reader", "speech"]),
      zeroDataRetention: z.boolean().default(true),
      voice: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .regex(/^[a-zA-Z0-9._:/-]+$/),
    })
    .default({
      modelId: null,
      method: "reader",
      voice: "alloy",
      zeroDataRetention: true,
    }),
  decision: z
    .strictObject({
      enabled: z.boolean(),
      modelId: IdentityId.nullable(),
      minConfidence: z.number().min(0.5).max(1),
    })
    .default({ enabled: false, modelId: null, minConfidence: 0.8 }),
  /** Who leads a task: Jev steps through service → action → inputs, or the chat model
   * plans and acts while Jev chooses services and actions and checks its work. */
  planner: z.enum(["jev", "model"]).default("jev"),
  services: z
    .array(
      z.strictObject({ serviceId: IdentityId, modelId: IdentityId.nullable() }),
    )
    .max(100),
});
export const CatalogSchema = z.strictObject({
  organizationId: IdentityId,
  workspaceId: IdentityId,
  canManage: z.boolean(),
  voiceAvailable: z.boolean().default(false),
  legacyVoiceAvailable: z.boolean().default(false),
  services: z.array(ServiceSchema).max(100),
  providers: z.array(ProviderSchema).max(50),
  models: z.array(CatalogModelSchema).max(500),
  routing: Routing,
  /** For managers: the services people sign in to themselves, and how many
   * have a working sign-in. */
  signIn: z
    .array(
      z.strictObject({
        serviceId: IdentityId,
        requiredFor: z.enum(["writes", "all"]),
        connected: z.number().int().min(0),
      }),
    )
    .max(100)
    .default([]),
  /** For managers: whether members may connect their own services. */
  personalServices: PersonalServicesPolicy.default("review"),
  /** For managers: who manages the actions of members' own services. */
  personalManagement: PersonalServicesManagement.default("owner"),
});
export const CatalogTarget = z.strictObject({
  organizationId: IdentityId,
  workspaceId: IdentityId,
});
const target = CatalogTarget.shape;
const credential = z
  .string()
  .min(1)
  .max(8192)
  .refine((v) => !/[\r\n]/.test(v))
  .optional();
export const CatalogCommand = z.discriminatedUnion("type", [
  z.strictObject({
    ...target,
    type: z.literal("saveService"),
    id: IdentityId.optional(),
    revision: Revision,
    settings: ServiceSettings.omit({ personal: true }),
    apiKey: credential,
  }),
  /** An administrator's decision on a service a member connected. */
  z.strictObject({
    ...target,
    type: z.literal("reviewPersonalService"),
    id: IdentityId,
    revision: Revision,
    decision: z.enum(["approve", "reject"]),
    reason: z.string().trim().max(500).optional(),
  }),
  z.strictObject({
    ...target,
    type: z.literal("savePersonalServicesPolicy"),
    policy: PersonalServicesPolicy.optional(),
    management: PersonalServicesManagement.optional(),
  }),
  z.strictObject({
    ...target,
    type: z.literal("removeService"),
    id: IdentityId,
    revision: Revision,
  }),
  z.strictObject({
    ...target,
    type: z.literal("saveAction"),
    serviceId: IdentityId,
    serviceRevision: Revision,
    id: IdentityId.optional(),
    revision: Revision,
    settings: ActionSettings,
  }),
  z.strictObject({
    ...target,
    type: z.literal("updateActions"),
    serviceId: IdentityId,
    serviceRevision: Revision,
    actions: z
      .array(z.strictObject({ id: IdentityId, revision: Revision }))
      .min(1)
      .max(1000)
      .refine(
        (items) => new Set(items.map((item) => item.id)).size === items.length,
      ),
    patch: z
      .strictObject({
        enabled: z.boolean().optional(),
        approval: z.enum(["always", "never"]).optional(),
        effect: z.enum(["read", "write"]).optional(),
        roles: z
          .array(OrganizationRole)
          .max(3)
          .refine((roles) => new Set(roles).size === roles.length)
          .optional(),
        workspaceRoles: z.array(IdentityId).max(50).optional(),
      })
      .refine((patch) =>
        Object.values(patch).some((value) => value !== undefined),
      ),
  }),
  z.strictObject({
    ...target,
    type: z.literal("removeAction"),
    serviceId: IdentityId,
    serviceRevision: Revision,
    id: IdentityId,
    revision: Revision,
  }),
  z.strictObject({
    ...target,
    type: z.literal("saveProvider"),
    id: IdentityId.optional(),
    revision: Revision,
    settings: ProviderSettings,
    apiKey: credential,
  }),
  z.strictObject({
    ...target,
    type: z.literal("removeProvider"),
    id: IdentityId,
    revision: Revision,
  }),
  z.strictObject({
    ...target,
    type: z.literal("saveModel"),
    id: IdentityId.optional(),
    revision: Revision,
    settings: CatalogModelSettings,
  }),
  z.strictObject({
    ...target,
    type: z.literal("importModels"),
    providerId: IdentityId,
    providerRevision: Revision,
    models: z
      .array(
        z.strictObject({
          name: IdentityName,
          model: z.string().trim().min(1).max(200),
          tools: z.boolean(),
          audioInput: z.boolean().default(false),
          audioOutput: z.boolean().default(false),
          kind: z
            .enum(["chat", "decision", "router", "transcription", "speech"])
            .default("chat"),
        }),
      )
      .min(1)
      .max(50)
      .refine(
        (models) => new Set(models.map((m) => m.model)).size === models.length,
      ),
  }),
  z.strictObject({
    ...target,
    type: z.literal("removeModel"),
    id: IdentityId,
    revision: Revision,
  }),
  z.strictObject({
    ...target,
    type: z.literal("saveRouting"),
    routing: Routing,
  }),
]);
export const DiscoveryChoice = z.strictObject({
  name: z.string().min(1).max(128),
  description: z.string().max(2000),
  category: z.string().max(100),
  sourceKey: z.string().max(1200),
  existing: z.boolean(),
});
export const DiscoveryContinuation = z.strictObject({
  toolNames: z.array(z.string().min(1).max(128)).min(1).max(1000),
  revision: Revision,
  policyRevision: Revision,
});
export const DiscoveryIssueReason = z.enum([
  "schema_invalid",
  "object_required",
  "schema_limit",
  "keyword_unsupported",
  "reference_unsupported",
  "pattern_unsupported",
  "metadata_missing",
  "operation_unsupported",
]);
export const DiscoveryIssue = z.strictObject({
  action: z.string().max(200),
  reason: DiscoveryIssueReason,
  path: z.string().max(300).optional(),
  keyword: z.string().max(64).optional(),
});
export const ActionDiscoveryResponse = z.strictObject({
  added: z.number().int().nonnegative(),
  existing: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
  issues: z.array(DiscoveryIssue).max(1000).optional(),
  enriched: z.boolean(),
  choices: z.array(DiscoveryChoice).max(1000).optional(),
  next: DiscoveryContinuation.optional(),
  /** Saved write actions whose MCP tool the server labels read-only. A hint
   * from the server, never applied on its own; an administrator may mark them. */
  readOnly: z.array(IdentityId).max(1000).optional(),
});
export const DiscoveryRequest = CatalogTarget.extend({
  serviceId: IdentityId,
  revision: Revision,
  documentUrl: ServiceUrl.optional(),
  enrich: z.boolean().default(false),
  policyRevision: Revision.optional(),
  toolNames: z
    .array(z.string().min(1).max(128))
    .min(1)
    .max(1000)
    .refine((names) => new Set(names).size === names.length)
    .optional(),
  /** MCP: describe and import at most this many new actions now; the rest
   * come back as `next`, so the console can show progress between requests. */
  limit: z.number().int().min(1).max(1000).optional(),
});
/** Whether the service's address answers, with its shared credential. */
export const ServiceProbeRequest = CatalogTarget.extend({
  serviceId: IdentityId,
});
export const ServiceProbeResponse = z.strictObject({
  /** ok: it answered; sign_in: it answered and wants a person's account;
   * failed: it did not answer, `error` says why in one code. */
  status: z.enum(["ok", "sign_in", "failed"]),
  error: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,63}$/)
    .optional(),
});
export const ModelDiscoveryRequest = CatalogTarget.extend({
  providerId: IdentityId,
  revision: Revision,
});
export const ServiceIconRequest = z.union([
  CatalogTarget.extend({ serviceId: IdentityId }),
  CatalogTarget.extend({ url: ServiceUrl }),
]);
export const ServiceIconResponse = z.strictObject({
  dataUrl: z
    .string()
    .max(180000)
    .regex(/^data:image\/(?:png|x-icon|gif);base64,[A-Za-z0-9+/=]+$/)
    .nullable(),
});
export const ActionInvokeRequest = CatalogTarget.extend({
  serviceId: IdentityId,
  actionId: IdentityId,
  revision: Revision,
  serviceRevision: Revision,
  input: JsonObject,
  requestId: IdentityId,
  approve: z.boolean().default(false),
});
export type Service = z.infer<typeof ServiceSchema>;
export type ServiceAction = z.infer<typeof ServiceActionSchema>;
export type Provider = z.infer<typeof ProviderSchema>;
export type CatalogModel = z.infer<typeof CatalogModelSchema>;
export type Catalog = z.infer<typeof CatalogSchema>;

/** The person's own services: added with an address and a key, reviewed
 * where the workspace asks for it, and managed by their owner alone. */
export const PersonalServiceCommand = z.discriminatedUnion("type", [
  z.strictObject({
    ...target,
    type: z.literal("add"),
    url: ServiceUrl,
    apiKey: credential.optional(),
    name: IdentityName.optional(),
  }),
  z.strictObject({
    ...target,
    type: z.literal("rename"),
    id: IdentityId,
    revision: Revision,
    name: IdentityName,
  }),
  z.strictObject({
    ...target,
    type: z.literal("remove"),
    id: IdentityId,
    revision: Revision,
  }),
  /** Reads the service's tools again and adds the new ones. */
  z.strictObject({
    ...target,
    type: z.literal("rediscover"),
    id: IdentityId,
    revision: Revision,
  }),
  /** Where the owner manages the service: every tool it offers, to choose from. */
  z.strictObject({
    ...target,
    type: z.literal("findActions"),
    id: IdentityId,
    revision: Revision,
  }),
  /** Adds the chosen tools (their `key` from findActions) as actions. */
  z.strictObject({
    ...target,
    type: z.literal("addActions"),
    id: IdentityId,
    revision: Revision,
    keys: z
      .array(z.string().min(1).max(1200))
      .min(1)
      .max(200)
      .refine((keys) => new Set(keys).size === keys.length),
  }),
  /** How the assistant sees one action: its name, what it is for, and
   * whether it only reads or changes something. */
  z.strictObject({
    ...target,
    type: z.literal("editAction"),
    id: IdentityId,
    revision: Revision,
    actionId: IdentityId,
    actionRevision: Revision,
    name: IdentityName,
    description: z.string().trim().max(2000),
    effect: z.enum(["read", "write"]),
  }),
  z.strictObject({
    ...target,
    type: z.literal("removeAction"),
    id: IdentityId,
    revision: Revision,
    actionId: IdentityId,
    actionRevision: Revision,
  }),
]);
/** One tool an own service offers, for its owner to add or leave out. */
export const PersonalActionChoice = z.strictObject({
  key: z.string().min(1).max(1200),
  name: z.string().min(1).max(200),
  description: z.string().max(2000),
  /** The service's own hint; the owner decides when adding. */
  effect: z.enum(["read", "write"]),
  added: z.boolean(),
});
export const PersonalActionChoices = z.strictObject({
  id: IdentityId,
  revision: Revision,
  choices: z.array(PersonalActionChoice).max(1000),
});
export type PersonalActionChoicesValue = z.infer<typeof PersonalActionChoices>;
export type PersonalServiceCommandValue = z.infer<
  typeof PersonalServiceCommand
>;
export const PersonalServiceSummary = z.strictObject({
  id: IdentityId,
  revision: Revision,
  name: IdentityName,
  url: ServiceUrl,
  protocol: z.enum(["openapi", "mcp"]),
  icon: ServiceIcon,
  iconSource: z.enum(["favicon", "custom"]),
  status: PersonalServiceStatus,
  reason: z.string().max(500).optional(),
  addedAt: z.iso.datetime(),
  /** How many of its actions read and how many change something. */
  reads: z.number().int().min(0),
  writes: z.number().int().min(0),
  /** "none": the service uses the key it was added with; otherwise the owner
   * signs in with their own account ("needed" until they have). */
  signIn: z.enum(["none", "needed", "connected"]).default("none"),
  /** For the sign-in commands: the sign-in settings' and the connection's revision. */
  signInRevision: Revision.optional(),
  connectionRevision: Revision.optional(),
});
export type PersonalServiceSummaryValue = z.infer<
  typeof PersonalServiceSummary
>;
export const PersonalServiceList = CatalogTarget.extend({
  policy: PersonalServicesPolicy,
  management: PersonalServicesManagement.default("owner"),
  limit: z.number().int().positive(),
  services: z.array(PersonalServiceSummary).max(100),
});
export type PersonalServiceListValue = z.infer<typeof PersonalServiceList>;
