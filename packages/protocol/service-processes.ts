import { z } from "zod";
import { IdentityId, IdentityName } from "./identity";
import { CatalogTarget, Revision } from "./service-catalog";

export const PROCESS_PROFILE = "agent-service-processes/1" as const;
/** Process fields can carry a bounded whole-meeting transcript when explicitly configured. */
export const PROCESS_INPUT_STRING_MAX_LENGTH = 60_000;
export const PROCESS_INPUT_JSON_MAX_BYTES = 65_536;
export const ProcessKey = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/)
  .refine((key) => !["constructor", "prototype"].includes(key));
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const scalar = z.union([
  z.string().max(4000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

/** A finite JSON Schema subset; no code, remote refs or expression language. */
export type ProcessData =
  | {
      type: "string";
      minLength?: number;
      maxLength?: number;
      enum?: string[];
    }
  | { type: "number" | "integer"; minimum?: number; maximum?: number }
  | { type: "boolean"; enum?: boolean[] }
  | { type: "null" }
  | { type: "array"; items: ProcessData; minItems?: number; maxItems?: number }
  | {
      type: "object";
      properties: Record<string, ProcessData>;
      required: string[];
      additionalProperties: false;
    };

function dataSchema(depth: number): z.ZodType<ProcessData> {
  const primitives = [
    z
      .strictObject({
        type: z.literal("string"),
        minLength: z
          .number()
          .int()
          .min(0)
          .max(PROCESS_INPUT_STRING_MAX_LENGTH)
          .optional(),
        maxLength: z
          .number()
          .int()
          .min(0)
          .max(PROCESS_INPUT_STRING_MAX_LENGTH)
          .optional(),
        enum: z.array(z.string().max(4000)).min(1).max(100).optional(),
      })
      .refine(
        (v) =>
          (v.minLength ?? 0) <=
          (v.maxLength ?? PROCESS_INPUT_STRING_MAX_LENGTH),
      ),
    z
      .strictObject({
        type: z.enum(["number", "integer"]),
        minimum: z.number().finite().optional(),
        maximum: z.number().finite().optional(),
      })
      .refine((v) => (v.minimum ?? -Infinity) <= (v.maximum ?? Infinity)),
    z.strictObject({
      type: z.literal("boolean"),
      enum: z.array(z.boolean()).min(1).max(2).optional(),
    }),
    z.strictObject({ type: z.literal("null") }),
  ];
  if (!depth) return z.union(primitives);
  const child = dataSchema(depth - 1);
  return z.union([
    ...primitives,
    z
      .strictObject({
        type: z.literal("array"),
        items: child,
        minItems: z.number().int().min(0).max(100).optional(),
        maxItems: z.number().int().min(0).max(100).optional(),
      })
      .refine((v) => (v.minItems ?? 0) <= (v.maxItems ?? 100)),
    z
      .strictObject({
        type: z.literal("object"),
        properties: z.record(ProcessKey, child),
        required: z.array(ProcessKey).max(40).default([]),
        additionalProperties: z.literal(false).default(false),
      })
      .refine(
        (v) =>
          Object.keys(v.properties).length <= 40 &&
          new Set(v.required).size === v.required.length &&
          v.required.every((key) => Object.hasOwn(v.properties, key)),
      ),
  ]);
}
export const ProcessDataSchema = dataSchema(6);
/** Runtime schemas preserve the same bounded, closed JSON subset as the registry. */
export function processValueSchema(schema: ProcessData): z.ZodType {
  switch (schema.type) {
    case "string":
      return z
        .string()
        .min(schema.minLength ?? 0)
        .max(schema.maxLength ?? 4000)
        .refine((v) => !schema.enum || schema.enum.includes(v));
    case "number":
    case "integer": {
      let value = z.number().finite();
      if (schema.type === "integer") value = value.int();
      if (schema.minimum !== undefined) value = value.min(schema.minimum);
      if (schema.maximum !== undefined) value = value.max(schema.maximum);
      return value;
    }
    case "boolean":
      return z.boolean().refine((v) => !schema.enum || schema.enum.includes(v));
    case "null":
      return z.null();
    case "array":
      return z
        .array(processValueSchema(schema.items))
        .min(schema.minItems ?? 0)
        .max(schema.maxItems ?? 100);
    case "object":
      return z.strictObject(
        Object.fromEntries(
          Object.entries(schema.properties).map(([key, value]) => {
            const field = processValueSchema(value);
            return [
              key,
              schema.required.includes(key) ? field : field.optional(),
            ];
          }),
        ),
      );
  }
}

const objectSchema = ProcessDataSchema.refine(
  (value) => value.type === "object",
);
export const ProcessBindingSchema = z.discriminatedUnion("source", [
  z.strictObject({
    source: z.literal("input"),
    path: z.array(ProcessKey).max(6),
  }),
  z.strictObject({
    source: z.literal("step"),
    stepId: ProcessKey,
    path: z.array(ProcessKey).max(6),
  }),
  z.strictObject({ source: z.literal("literal"), value: scalar }),
]);
export type ProcessBinding = z.infer<typeof ProcessBindingSchema>;
const bindings = z
  .record(ProcessKey, ProcessBindingSchema)
  .refine((v) => Object.keys(v).length <= 40);
export const ProcessLimitsSchema = z.strictObject({
  maxSteps: positive.max(128),
  maxModelCalls: z.number().int().min(0).max(128),
  maxTokens: positive.max(1_000_000),
  /** USD millionths; integer arithmetic, no implicit currency conversion. */
  maxCostMicros: positive.max(1_000_000_000),
  maxDurationMs: positive.max(3_600_000),
});
export type ProcessLimits = z.infer<typeof ProcessLimitsSchema>;
const capability = z.strictObject({
  serviceId: IdentityId,
  actionId: IdentityId,
});
const agent = {
  modelId: IdentityId,
  instructions: z.string().trim().min(1).max(4000),
  capabilities: z.array(capability).max(16),
  memory: z.enum(["none", "conversation", "saved"]),
  /** New immutable capability; omission retains historical compiler and qualification. */
  humanInput: z.literal("text").optional(),
};
const step = { id: ProcessKey };
const condition = z.discriminatedUnion("operator", [
  z.strictObject({ operator: z.literal("exists"), left: ProcessBindingSchema }),
  z.strictObject({
    operator: z.literal("equals"),
    left: ProcessBindingSchema,
    right: scalar,
  }),
]);
export const ProcessStepSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...step,
    type: z.literal("action"),
    ...capability.shape,
    input: bindings,
    outputSchema: objectSchema,
    next: ProcessKey,
  }),
  z.strictObject({
    ...step,
    type: z.literal("agent"),
    ...agent,
    inputSchema: objectSchema,
    outputSchema: objectSchema,
    input: bindings,
    next: ProcessKey,
  }),
  z.strictObject({
    ...step,
    type: z.literal("branch"),
    condition,
    whenTrue: ProcessKey,
    whenFalse: ProcessKey,
  }),
  z.strictObject({ ...step, type: z.literal("return"), output: bindings }),
]);
export type ProcessStep = z.infer<typeof ProcessStepSchema>;
const base = {
  schemaVersion: z.literal(1),
  name: IdentityName,
  description: z.string().trim().max(1000),
  trigger: z.literal("manual"),
  inputSchema: objectSchema,
  outputSchema: objectSchema,
  limits: ProcessLimitsSchema,
};
export const ProcessDefinitionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...base, kind: z.literal("agent"), ...agent }),
  z.strictObject({
    ...base,
    kind: z.literal("workflow"),
    entry: ProcessKey,
    steps: z.array(ProcessStepSchema).min(1).max(64),
  }),
]);
export type ProcessDefinition = z.infer<typeof ProcessDefinitionSchema>;
export const ProcessSourceManifestSchema = z.strictObject({
  resources: z
    .array(
      z.strictObject({
        kind: z.enum(["service", "action", "model", "provider"]),
        id: IdentityId,
        revision: Revision,
      }),
    )
    .max(256),
  pluginsDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  limitsDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ProcessSourceManifest = z.infer<typeof ProcessSourceManifestSchema>;
export const ProcessValidationSchema = z.strictObject({
  valid: z.boolean(),
  issues: z
    .array(
      z.strictObject({
        code: z.enum([
          "definition_invalid",
          "limit_exceeded",
          "resource_unavailable",
          "capability_denied",
          "graph_invalid",
          "binding_invalid",
          "binding_type_unproven",
        ]),
        path: z.string().max(300),
      }),
    )
    .max(20),
  sources: ProcessSourceManifestSchema.nullable(),
});
export type ProcessValidation = z.infer<typeof ProcessValidationSchema>;
export const ProcessSummarySchema = z.strictObject({
  id: IdentityId,
  serviceId: IdentityId,
  revision: Revision,
  name: IdentityName,
  kind: z.enum(["agent", "workflow"]),
  latestVersion: z.number().int().nonnegative(),
  activeVersion: positive.nullable(),
  updatedAt: z.iso.datetime(),
  /** Management lists only: the active version is blocked until it is tested
   * again, because a service or model it uses changed or it never qualified. */
  retestNeeded: z.literal(true).optional(),
});
export const ProcessRecordSchema = ProcessSummarySchema.extend({
  draft: ProcessDefinitionSchema,
});
export type ProcessRecord = z.infer<typeof ProcessRecordSchema>;
export const ProcessVersionSchema = z.strictObject({
  processId: IdentityId,
  version: positive,
  definition: ProcessDefinitionSchema,
  sources: ProcessSourceManifestSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
  createdBy: IdentityId,
  /** The immutable definition is separate from server-owned test/activation metadata. */
  testStatus: z.enum(["untested", "passed", "failed"]),
});
export type ProcessVersion = z.infer<typeof ProcessVersionSchema>;
export const ProcessCommandSchema = z.discriminatedUnion("type", [
  CatalogTarget.extend({
    type: z.literal("saveDraft"),
    id: IdentityId.optional(),
    serviceId: IdentityId,
    revision: Revision,
    definition: ProcessDefinitionSchema,
  }),
  CatalogTarget.extend({
    type: z.literal("freezeDraft"),
    id: IdentityId,
    revision: Revision,
  }),
]);
export const ProcessReadQuerySchema = CatalogTarget.extend({
  id: IdentityId.optional(),
  after: IdentityId.optional(),
  version: z.coerce
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
}).refine((v) => (!v.version || !!v.id) && !(v.id && v.after));
export const ProcessValidateRequestSchema = CatalogTarget.extend({
  serviceId: IdentityId,
  definition: z.unknown(),
});
export const ProcessListSchema = CatalogTarget.extend({
  profile: z.literal(PROCESS_PROFILE),
  processes: z.array(ProcessSummarySchema).max(100),
  nextAfter: IdentityId.nullable(),
});

/** Workspace ownership adds no execution privilege; capabilities remain explicit. */
export const WORKSPACE_PROCESS_PROFILE = "agent-service-processes/2" as const;
/** A personal ("Personal") process belongs to one person. It runs only for them,
 * only with services/actions they may use themselves, and only they manage it. */
export const PersonalProcessOwnerSchema = z.strictObject({
  type: z.literal("user"),
  userId: IdentityId,
});
export const ProcessOwnerSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("service"), serviceId: IdentityId }),
  z.strictObject({ type: z.literal("workspace") }),
  PersonalProcessOwnerSchema,
]);
export type ProcessOwner = z.infer<typeof ProcessOwnerSchema>;
/** Owners reported by `/2` rows without a parent service. Workspace rows keep
 * their original `{type: "workspace"}` bytes; personal rows name their owner. */
export const OwnedProcessOwnerSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("workspace") }),
  PersonalProcessOwnerSchema,
]);
export type OwnedProcessOwner = z.infer<typeof OwnedProcessOwnerSchema>;
/** Request form. The server binds a personal owner to the authenticated person;
 * a supplied `userId` must be that person, it never selects someone else. */
export const ProcessOwnerRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("workspace") }),
  z.strictObject({ type: z.literal("user"), userId: IdentityId.optional() }),
]);
export type ProcessOwnerRequest = z.infer<typeof ProcessOwnerRequestSchema>;
export const WorkspaceProcessSummarySchema = ProcessSummarySchema.omit({
  serviceId: true,
}).extend({
  owner: OwnedProcessOwnerSchema,
  serviceId: z.never().optional(),
});
export const WorkspaceProcessRecordSchema =
  WorkspaceProcessSummarySchema.extend({ draft: ProcessDefinitionSchema });
export const OwnedProcessSummarySchema = z.union([
  ProcessSummarySchema,
  WorkspaceProcessSummarySchema,
]);
export const OwnedProcessRecordSchema = z.union([
  ProcessRecordSchema,
  WorkspaceProcessRecordSchema,
]);
export type OwnedProcessRecord = z.infer<typeof OwnedProcessRecordSchema>;
export const WorkspaceProcessListSchema = CatalogTarget.extend({
  profile: z.literal(WORKSPACE_PROCESS_PROFILE),
  processes: z.array(OwnedProcessSummarySchema).max(100),
  nextAfter: IdentityId.nullable(),
});
export const WorkspaceProcessReadQuerySchema = CatalogTarget.extend({
  profile: z.literal(WORKSPACE_PROCESS_PROFILE),
  id: IdentityId.optional(),
  after: IdentityId.optional(),
  version: z.coerce
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
}).refine((v) => (!v.version || !!v.id) && !(v.id && v.after));
export const WorkspaceProcessSaveSchema = CatalogTarget.extend({
  profile: z.literal(WORKSPACE_PROCESS_PROFILE),
  type: z.literal("saveDraft"),
  owner: ProcessOwnerRequestSchema,
  id: IdentityId.optional(),
  revision: Revision,
  definition: ProcessDefinitionSchema,
});
/** The owner deletes (archives) their own personal process. */
export const WorkspaceProcessArchiveSchema = CatalogTarget.extend({
  profile: z.literal(WORKSPACE_PROCESS_PROFILE),
  type: z.literal("archive"),
  id: IdentityId,
  revision: Revision,
});
export const WorkspaceProcessArchiveResultSchema = z.strictObject({
  profile: z.literal(WORKSPACE_PROCESS_PROFILE),
  id: IdentityId,
  archivedAt: z.iso.datetime(),
});
export const WorkspaceProcessValidateSchema = CatalogTarget.extend({
  profile: z.literal(WORKSPACE_PROCESS_PROFILE),
  owner: ProcessOwnerRequestSchema,
  definition: z.unknown(),
});
