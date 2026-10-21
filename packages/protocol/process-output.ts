import { z } from "zod";
import { CardIdSchema } from "./card-document";

export const PROCESS_OUTPUT_PROFILE = "agent-process-output/1" as const;
export const PROCESS_OUTPUT_REDACTION_VERSION =
  "process-output-redaction/1" as const;
export const PROCESS_OUTPUT_WORK_PROFILE = "agent-process-work/4" as const;
export const PROCESS_OUTPUT_MAX_PAGE_BYTES = 65536;
export const PROCESS_OUTPUT_MAX_PAGE_CHILDREN = 16;
export const PROCESS_OUTPUT_MAX_REQUEST_BYTES = 20480;
export const PROCESS_OUTPUT_MAX_VALUE_BYTES = 8 * 1024 * 1024;
export const PROCESS_OUTPUT_MAX_VALUE_NODES = 131072;
export const PROCESS_OUTPUT_MAX_PATH = 24;
export const PROCESS_OUTPUT_MAX_STRING_LENGTH = 4000;
const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9._:-]+$/);
// WorkItem imports this module. Keep its scope shape independent of index's
// eager WorkItem schema, so either public import order is safe.
const scope = z.strictObject({
  connectionId: id,
  serverId: id,
  userId: id,
  workspaceId: id,
});
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const ProcessOutputProvenanceSchema = z.strictObject({
  runId: id,
  processId: id,
  version: revision,
  artifactDigest: digest,
  actorId: id,
  conversationId: id.optional(),
  commandId: id.optional(),
  admissionId: id.optional(),
});
// Kept independent of process-start's command union to avoid a WorkItem import cycle.
export const ProcessOutputOriginSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("card"),
    conversationId: id,
    messageId: id,
    cardId: CardIdSchema,
    cardRevision: revision,
    actionId: CardIdSchema,
  }),
  z.strictObject({
    type: z.literal("command"),
    conversationId: id,
    requestId: id,
  }),
]);
export const ProcessOutputReferenceSchema = z
  .strictObject({
    profile: z.literal(PROCESS_OUTPUT_PROFILE),
    scope,
    parentRunId: id,
    nativeRevision: revision,
    provenance: ProcessOutputProvenanceSchema,
    origin: ProcessOutputOriginSchema,
    outputDigest: digest,
    redactionVersion: z.literal(PROCESS_OUTPUT_REDACTION_VERSION),
  })
  .refine(
    (v) =>
      v.provenance.actorId === v.scope.userId &&
      v.provenance.conversationId === v.origin.conversationId &&
      !!v.provenance.commandId &&
      !!v.provenance.admissionId,
  );
export type ProcessOutputReference = z.infer<
  typeof ProcessOutputReferenceSchema
>;
export const ProcessOutputPathSchema = z
  .array(
    z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("property"),
        index: z.number().int().min(0).max(39),
      }),
      z.strictObject({
        kind: z.literal("item"),
        index: z.number().int().min(0).max(99),
      }),
    ]),
  )
  .max(PROCESS_OUTPUT_MAX_PATH);
export type ProcessOutputPath = z.infer<typeof ProcessOutputPathSchema>;
const cursor = z
  .string()
  .max(96)
  .regex(/^(0|[1-9][0-9]{0,15})\.[a-f0-9]{64}$/);
export const ProcessOutputRequestSchema = z.strictObject({
  reference: ProcessOutputReferenceSchema,
  path: ProcessOutputPathSchema,
  cursor: cursor.nullable(),
});
export type ProcessOutputRequest = z.infer<typeof ProcessOutputRequestSchema>;
export const ProcessOutputNodeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("object"), childCount: count.max(40) }),
  z.strictObject({ kind: z.literal("array"), childCount: count.max(100) }),
  z.strictObject({
    kind: z.literal("string"),
    value: z.string().max(PROCESS_OUTPUT_MAX_STRING_LENGTH),
  }),
  z.strictObject({ kind: z.literal("number"), value: z.number().finite() }),
  z.strictObject({ kind: z.literal("boolean"), value: z.boolean() }),
  z.strictObject({ kind: z.literal("null"), value: z.null() }),
  z.strictObject({ kind: z.literal("redacted") }),
]);
export type ProcessOutputNode = z.infer<typeof ProcessOutputNodeSchema>;
export const ProcessOutputChildSchema = z.strictObject({
  index: count.max(99),
  label: z.string().max(160).optional(),
  node: ProcessOutputNodeSchema,
});
export const ProcessOutputPageSchema = z
  .strictObject({
    profile: z.literal(PROCESS_OUTPUT_PROFILE),
    ...ProcessOutputRequestSchema.shape,
    offset: count,
    total: count.max(100),
    node: ProcessOutputNodeSchema,
    children: z
      .array(ProcessOutputChildSchema)
      .max(PROCESS_OUTPUT_MAX_PAGE_CHILDREN),
    nextCursor: cursor.nullable(),
  })
  .refine((page) => {
    if (page.node.kind !== "object" && page.node.kind !== "array")
      return (
        page.offset === 0 &&
        page.total === 0 &&
        page.children.length === 0 &&
        page.cursor === null &&
        page.nextCursor === null
      );
    return (
      page.node.childCount === page.total &&
      page.offset <= page.total &&
      page.offset + page.children.length <= page.total &&
      page.children.every(
        (child, i) =>
          child.index === page.offset + i &&
          (page.node.kind === "object"
            ? child.label !== undefined
            : child.label === undefined),
      ) &&
      (page.offset + page.children.length < page.total
        ? page.children.length > 0 && page.nextCursor !== null
        : page.nextCursor === null)
    );
  });
export type ProcessOutputPage = z.infer<typeof ProcessOutputPageSchema>;
export const ProcessOutputCapabilitiesSchema = z.strictObject({
  profile: z.literal(PROCESS_OUTPUT_PROFILE),
  scope,
  available: z.literal(true),
  readProfile: z.literal(PROCESS_OUTPUT_PROFILE),
  workProfile: z.literal(PROCESS_OUTPUT_WORK_PROFILE),
});
export type ProcessOutputCapabilities = z.infer<
  typeof ProcessOutputCapabilitiesSchema
>;
