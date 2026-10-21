import { z } from "zod";
import { IdentityId } from "./identity";
import { CatalogTarget, Revision } from "./service-catalog";
import {
  ProcessDefinitionSchema,
  ProcessKey,
  ProcessValidationSchema,
  ProcessSourceManifestSchema,
  ProcessLimitsSchema,
  OwnedProcessOwnerSchema,
  ProcessOwnerRequestSchema,
} from "./service-processes";

export const DESIGN_PROFILE = "agent-process-design/1" as const;
export const DesignDigest = z.string().regex(/^[a-f0-9]{64}$/);
export const DesignSchemaUnavailableSchema = z.enum([
  "schema_unsupported",
  "schema_limit",
  "sensitive_fields",
]);
export const DesignCapabilityActionSchema = z.strictObject({
  id: IdentityId,
  revision: Revision,
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  status: z.enum(["configured", "disabled"]),
  effect: z.enum(["read", "write"]),
  approval: z.enum(["always", "never"]),
  inputSchema: z.record(z.string(), z.unknown()).nullable(),
  schemaUnavailable: DesignSchemaUnavailableSchema.nullable(),
});
export const DesignCapabilityServiceSchema = z.strictObject({
  id: IdentityId,
  revision: Revision,
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  actions: z.array(DesignCapabilityActionSchema),
});
export const DesignCapabilityModelSchema = z.strictObject({
  id: IdentityId,
  revision: Revision,
  name: z.string(),
  model: z.string(),
  providerId: IdentityId,
  providerRevision: Revision,
  tools: z.literal(true),
  status: z.literal("configured"),
});
/** Configuration and permission only; never connection or dispatch readiness. */
export const DesignCapabilitiesSchema = CatalogTarget.extend({
  services: z.array(DesignCapabilityServiceSchema),
  models: z.array(DesignCapabilityModelSchema),
  memoryModes: z.array(z.enum(["none", "conversation", "saved"])),
  limits: ProcessLimitsSchema,
  grammar: z.strictObject({
    schemaVersion: z.literal(1),
    trigger: z.literal("manual"),
    kinds: z.tuple([z.literal("agent"), z.literal("workflow")]),
  }),
  fingerprint: DesignDigest,
  nextAfter: z.string().max(1024).nullable(),
  totalItems: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  /** The workspace enforces usage limits and prices at least one listed
   * model, so designer turns and tests can start. Readable by members, who
   * cannot read the budget itself. Not part of the fingerprint. */
  budgetReady: z.boolean().optional(),
});
export type DesignSchemaUnavailable = z.infer<
  typeof DesignSchemaUnavailableSchema
>;
export type DesignCapabilityAction = z.infer<
  typeof DesignCapabilityActionSchema
>;
export type DesignCapabilityService = z.infer<
  typeof DesignCapabilityServiceSchema
>;
export type DesignCapabilityModel = z.infer<typeof DesignCapabilityModelSchema>;
export type DesignCapabilities = z.infer<typeof DesignCapabilitiesSchema>;
const note = z.string().trim().min(1).max(1000);
const namedNote = z.strictObject({ id: ProcessKey, text: note });
export const DesignBriefSchema = z
  .strictObject({
    purpose: z.string().trim().max(4000),
    inputs: z.array(note).max(20),
    outputs: z.array(note).max(20),
    rules: z.array(note).max(20),
    questions: z.array(namedNote).max(20),
    assumptions: z.array(namedNote).max(20),
  })
  .refine((value) =>
    [value.questions, value.assumptions].every(
      (notes) => new Set(notes.map((item) => item.id)).size === notes.length,
    ),
  );
export type DesignBrief = z.infer<typeof DesignBriefSchema>;
export const emptyDesignBrief = (): DesignBrief => ({
  purpose: "",
  inputs: [],
  outputs: [],
  rules: [],
  questions: [],
  assumptions: [],
});
/** Human expectations are separate from model-editable proposal content. */
export const DesignConfirmationSchema = z.enum([
  "catalog",
  "every_write",
  "grouped",
]);
export type DesignConfirmation = z.infer<typeof DesignConfirmationSchema>;
export const DesignStartSchema = CatalogTarget.extend({
  requestId: IdentityId,
  serviceId: IdentityId,
  processId: IdentityId.optional(),
  baselineVersion: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  confirmation: DesignConfirmationSchema.default("catalog"),
}).refine((value) => !value.baselineVersion || !!value.processId);
export const DesignUpdateSchema = CatalogTarget.extend({
  sessionId: IdentityId,
  requestId: IdentityId,
  revision: Revision,
  brief: DesignBriefSchema,
  /** Incomplete briefing is valid here. The registry only receives complete, valid definitions. */
  candidate: ProcessDefinitionSchema.nullable(),
});
export const DesignAcknowledgeSchema = CatalogTarget.extend({
  sessionId: IdentityId,
  requestId: IdentityId,
  revision: Revision,
  assumptions: z
    .array(z.strictObject({ id: ProcessKey, digest: DesignDigest }))
    .max(20),
  confirmation: DesignConfirmationSchema.optional(),
}).refine(
  (value) =>
    new Set(value.assumptions.map((item) => item.id)).size ===
    value.assumptions.length,
);
export const DesignAcceptSchema = CatalogTarget.extend({
  sessionId: IdentityId,
  requestId: IdentityId,
  revision: Revision,
  reviewDigest: DesignDigest,
});
export const DesignReadSchema = CatalogTarget.extend({ sessionId: IdentityId });
export const DesignBaselineSchema = z.strictObject({
  processId: IdentityId,
  registryRevision: Revision,
  version: z.number().int().positive().nullable(),
  definition: ProcessDefinitionSchema,
});
export const DesignChangeSchema = z.strictObject({
  path: z.string().max(300),
  kind: z.enum(["added", "removed", "changed"]),
  before: z.string().max(2000).nullable(),
  after: z.string().max(2000).nullable(),
});
export const DesignReviewSchema = CatalogTarget.extend({
  profile: z.literal(DESIGN_PROFILE),
  id: IdentityId,
  serviceId: IdentityId,
  revision: Revision,
  brief: DesignBriefSchema,
  candidate: ProcessDefinitionSchema.nullable(),
  baseline: DesignBaselineSchema.nullable(),
  baselineSources: ProcessSourceManifestSchema.nullable(),
  dependencyComparison: z.enum(["new", "recorded", "unavailable"]),
  dependencyChanges: z
    .array(
      z.strictObject({
        kind: z.enum(["service", "action", "model", "provider"]),
        id: IdentityId,
        beforeRevision: Revision.nullable(),
        afterRevision: Revision.nullable(),
      }),
    )
    .max(512),
  confirmation: DesignConfirmationSchema,
  assumptions: z
    .array(
      z.strictObject({
        id: ProcessKey,
        digest: DesignDigest,
        acknowledged: z.boolean(),
      }),
    )
    .max(20),
  validation: ProcessValidationSchema,
  blockers: z
    .array(
      z.enum([
        "purpose_missing",
        "candidate_missing",
        "questions_unresolved",
        "assumptions_unacknowledged",
        "confirmation_unsupported",
        "confirmation_mismatch",
        "registry_changed",
        "capability_unavailable",
        "capability_schema_unavailable",
      ]),
    )
    .max(9),
  changes: z.array(DesignChangeSchema).max(200),
  changesTruncated: z.boolean(),
  capabilityFingerprint: DesignDigest,
  reviewDigest: DesignDigest,
  acceptedProcessId: IdentityId.nullable(),
  updatedAt: z.iso.datetime(),
});
export type DesignReview = z.infer<typeof DesignReviewSchema>;
/** Mutation replay returns this immutable receipt; reads separately refresh validation. */
export const DesignReceiptSchema = CatalogTarget.extend({
  profile: z.literal(DESIGN_PROFILE),
  sessionId: IdentityId,
  requestId: IdentityId,
  revision: Revision,
  kind: z.enum(["started", "updated", "acknowledged", "accepted"]),
  processId: IdentityId.nullable(),
});
export type DesignReceipt = z.infer<typeof DesignReceiptSchema>;

/** The designer model is selected by a human; proposal execution models are separate. */
export const DesignTurnStartSchema = CatalogTarget.extend({
  sessionId: IdentityId,
  requestId: IdentityId,
  revision: Revision,
  modelId: IdentityId,
  text: z
    .string()
    .min(1)
    .max(4000)
    .refine((value) => value.trim().length > 0),
  language: z.enum(["en", "cs"]).default("en"),
});
export const DesignTurnReadSchema = DesignReadSchema.extend({
  requestId: IdentityId,
});
export const DesignToolNameSchema = z.enum([
  "design_list_capabilities",
  "design_get_capability",
  "design_read_proposal",
  "design_update_proposal",
  "design_validate_proposal",
]);
export const DesignToolReceiptSchema = z.strictObject({
  toolCallId: IdentityId,
  name: DesignToolNameSchema,
  revision: Revision,
});
/** The original human selection, projected from the server's conversation binding. */
export const DesignTurnModelSchema = z.strictObject({
  id: IdentityId,
  revision: Revision,
  providerId: IdentityId,
  providerRevision: Revision,
});
export const DesignTurnSchema = CatalogTarget.extend({
  profile: z.literal(DESIGN_PROFILE),
  sessionId: IdentityId,
  requestId: IdentityId,
  turnId: DesignDigest,
  /** Immutable client revision captured when this command was admitted. */
  requestRevision: Revision.optional(),
  /** True only after the native model run is proved settled or has ended safely. */
  nativeSettled: z.boolean().optional(),
  model: DesignTurnModelSchema,
  status: z.enum(["running", "completed", "failed", "interrupted"]),
  userText: z.string().max(4000),
  language: z.enum(["en", "cs"]),
  reply: z.string().max(8000).nullable(),
  /** A safe diagnostic code, never raw provider errors or credentials. */
  failure: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,100}$/)
    .nullable(),
  revision: Revision,
  toolReceipts: z.array(DesignToolReceiptSchema).max(24),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type DesignTurn = z.infer<typeof DesignTurnSchema>;

/** Passive, actor-scoped index for reopening a service design conversation. */
export const DesignSessionSummarySchema = z.strictObject({
  id: IdentityId,
  serviceId: IdentityId,
  revision: Revision,
  purpose: z.string().max(4000),
  acceptedProcessId: IdentityId.nullable(),
  updatedAt: z.iso.datetime(),
});
export const DesignSessionListSchema = CatalogTarget.extend({
  profile: z.literal(DESIGN_PROFILE),
  serviceId: IdentityId,
  sessions: z.array(DesignSessionSummarySchema).max(100),
  nextAfter: IdentityId.nullable(),
});
export type DesignSessionSummary = z.infer<typeof DesignSessionSummarySchema>;

/** Draft metadata only; this is never execution inventory or authority. */
export const DesignServiceDraftSchema = z.strictObject({
  id: IdentityId,
  serviceId: IdentityId,
  revision: Revision,
  name: z.string(),
  kind: z.enum(["agent", "workflow"]),
  latestVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  activeVersion: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable(),
  updatedAt: z.iso.datetime(),
});
export const DesignServiceDraftListSchema = CatalogTarget.extend({
  profile: z.literal(DESIGN_PROFILE),
  serviceId: IdentityId,
  drafts: z.array(DesignServiceDraftSchema).max(100),
  nextAfter: IdentityId.nullable(),
});
export type DesignServiceDraft = z.infer<typeof DesignServiceDraftSchema>;

/** The /1 designer remains service-only, including its saved command bytes. */
export const WORKSPACE_DESIGN_PROFILE = "agent-process-design/2" as const;
export const WorkspaceDesignStartSchema = CatalogTarget.extend({
  profile: z.literal(WORKSPACE_DESIGN_PROFILE),
  requestId: IdentityId,
  /** A member's workspace request is recorded as personal: members never own
   * workspace processes. The review reports the owner actually bound. */
  owner: ProcessOwnerRequestSchema,
  processId: IdentityId.optional(),
  baselineVersion: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  confirmation: DesignConfirmationSchema.default("catalog"),
}).refine((v) => !v.baselineVersion || !!v.processId);
export const WorkspaceDesignReviewSchema = DesignReviewSchema.omit({
  serviceId: true,
  profile: true,
}).extend({
  profile: z.literal(WORKSPACE_DESIGN_PROFILE),
  owner: OwnedProcessOwnerSchema,
  serviceId: z.never().optional(),
});
export const OwnedDesignReviewSchema = z.union([
  DesignReviewSchema,
  WorkspaceDesignReviewSchema,
]);
export type OwnedDesignReview = z.infer<typeof OwnedDesignReviewSchema>;
