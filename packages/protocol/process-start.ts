import { z } from "zod";
import { CardResponseCommandSchema, LanguageSchema } from "./index";
import { CardIdSchema } from "./card-document";
import { IdentityId } from "./identity";
import { HumanTaskId } from "./human-tasks";
import {
  PROCESS_INPUT_JSON_MAX_BYTES,
  PROCESS_INPUT_STRING_MAX_LENGTH,
  ProcessDataSchema,
  ProcessKey,
} from "./service-processes";

export const PROCESS_START_PROFILE = "agent-process-start/1" as const;
const commandId = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9._:-]+$/);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const MeetingProcessSourceSchema = z.enum([
  "summary",
  "points",
  "tasks",
  "selectedTask",
  "transcript",
]);
export type MeetingProcessSource = z.infer<typeof MeetingProcessSourceSchema>;
export const ProcessStartOriginSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("card"),
    conversationId: commandId,
    messageId: commandId,
    cardId: CardIdSchema,
    cardRevision: revision,
    actionId: CardIdSchema,
  }),
  z.strictObject({
    type: z.literal("command"),
    conversationId: commandId,
    requestId: commandId,
  }),
  z.strictObject({
    type: z.literal("meeting"),
    conversationId: commandId,
    requestId: commandId,
    meetingId: IdentityId,
    recordDigest: digest,
    /** Explicitly selected, still-open meeting proposal; never an approval to write. */
    selectedTask: z.strictObject({ id: HumanTaskId, revision }).optional(),
    /** Human-selected trusted record fields; values are loaded again server-side. */
    sourceBindings: z
      .record(ProcessKey, MeetingProcessSourceSchema)
      .refine((value) => Object.keys(value).length <= 40),
  }),
]);
export type ProcessStartOrigin = z.infer<typeof ProcessStartOriginSchema>;

export type ProcessInputValue =
  | string
  | number
  | boolean
  | null
  | ProcessInputValue[]
  | { [key: string]: ProcessInputValue };
function inputValue(depth: number): z.ZodType<ProcessInputValue> {
  const scalar = z.union([
    z.string().max(PROCESS_INPUT_STRING_MAX_LENGTH),
    z.number().finite(),
    z.boolean(),
    z.null(),
  ]);
  if (!depth) return scalar;
  const child = inputValue(depth - 1);
  return z.union([
    scalar,
    z.array(child).max(100),
    z.record(ProcessKey, child).refine((v) => Object.keys(v).length <= 40),
  ]);
}
/** UTF-8 size is portable to the mobile client; no Node dependency. */
function inputBytes(value: unknown) {
  let bytes = 0;
  for (const char of JSON.stringify(value)) {
    const code = char.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}
/** Validate raw JSON before Zod's record parser can discard reserved object keys. */
function closedJson(raw: unknown) {
  let nodes = 0,
    characters = 0;
  const visit = (value: unknown, depth: number): boolean => {
    if (++nodes > 32768 || depth > 7) return false;
    if (value === null || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value === "string") {
      characters += value.length;
      return (
        value.length <= PROCESS_INPUT_STRING_MAX_LENGTH &&
        characters <= PROCESS_INPUT_JSON_MAX_BYTES
      );
    }
    if (
      !value ||
      typeof value !== "object" ||
      Object.getOwnPropertySymbols(value).length
    )
      return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some((entry) => !("value" in entry)))
      return false;
    if (Array.isArray(value)) {
      return (
        value.length <= 100 &&
        Object.keys(descriptors).length === value.length + 1 &&
        Array.from(
          { length: value.length },
          (_, i) =>
            Object.hasOwn(value, i) && visit(descriptors[i]!.value, depth + 1),
        ).every(Boolean)
      );
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      return false;
    const keys = Object.keys(descriptors);
    if (keys.length > 40) return false;
    return keys.every((key) => {
      characters += key.length;
      return (
        characters <= PROCESS_INPUT_JSON_MAX_BYTES &&
        descriptors[key]!.enumerable === true &&
        ProcessKey.safeParse(key).success &&
        visit(descriptors[key]!.value, depth + 1)
      );
    });
  };
  return visit(raw, 0);
}
export const ProcessStartInputSchema = z.preprocess(
  (raw, ctx) => {
    if (!closedJson(raw)) {
      ctx.addIssue({
        code: "custom",
        message: "Expected bounded plain JSON input",
      });
      return z.NEVER;
    }
    return raw;
  },
  z
    .record(ProcessKey, inputValue(6))
    .refine(
      (v) =>
        Object.keys(v).length <= 40 &&
        inputBytes(v) <= PROCESS_INPUT_JSON_MAX_BYTES,
    ),
);
/** Internal contract. Public CommandSchema does not admit execution yet (NIAR-92). */
export const ProcessStartCommandSchema = z.strictObject({
  profile: z.literal(PROCESS_START_PROFILE),
  type: z.literal("process.start"),
  commandId,
  idempotencyKey: commandId,
  intentId: IdentityId,
  conversationId: commandId,
  language: LanguageSchema,
  input: ProcessStartInputSchema,
});
export type ProcessStartCommand = z.infer<typeof ProcessStartCommandSchema>;
export const ProcessStartOriginalCommandSchema = z.union([
  ProcessStartCommandSchema,
  CardResponseCommandSchema,
]);
export type ProcessStartOriginalCommand = z.infer<
  typeof ProcessStartOriginalCommandSchema
>;
/** Scalar card fields can bind closed object paths. Array/structured UI follows in NIAR-91. */
export const ProcessStartFieldsSchema = z
  .record(CardIdSchema, z.array(ProcessKey).min(1).max(6))
  .refine((fields) => {
    const paths = Object.values(fields);
    return (
      paths.length <= 12 &&
      !paths.some((path, i) =>
        paths.some(
          (other, j) =>
            i !== j &&
            path.length <= other.length &&
            path.every((part, k) => part === other[k]),
        ),
      )
    );
  });
export const ProcessStartIntentSchema = z.strictObject({
  intentId: IdentityId,
  origin: ProcessStartOriginSchema,
  processId: IdentityId,
  version: revision,
  artifactDigest: digest,
  formDigest: digest,
  inputSchema: ProcessDataSchema.refine((v) => v.type === "object"),
  fields: ProcessStartFieldsSchema,
  createdAt: z.iso.datetime(),
});
export type ProcessStartIntent = z.infer<typeof ProcessStartIntentSchema>;
/** Admission acknowledges an immutable handoff, never a successful execution. */
export const ProcessStartAdmissionSchema = z.strictObject({
  profile: z.literal(PROCESS_START_PROFILE),
  status: z.literal("admitted"),
  receiptId: IdentityId,
  intentId: IdentityId,
  commandId,
  idempotencyKey: commandId,
  commandDigest: digest,
  origin: ProcessStartOriginSchema,
  processId: IdentityId,
  version: revision,
  artifactDigest: digest,
  formDigest: digest,
  input: ProcessStartInputSchema,
  inputDigest: digest,
  compilerVersion: z.string().min(1).max(160),
  /** Stable internal alias; public command IDs may exceed the native 80-character limit. */
  runId: IdentityId,
  parentRunId: IdentityId,
  createdAt: z.iso.datetime(),
});
export type ProcessStartAdmission = z.infer<typeof ProcessStartAdmissionSchema>;
export const PROCESS_START_REJECTIONS = [
  "process_input_invalid",
  "process_origin_changed",
  "process_active_version_changed",
  "process_not_active",
  "process_sources_changed",
  "process_test_required",
  "process_qualification_required",
  "process_qualification_unavailable",
  "process_qualification_authority_changed",
  "process_start_conflict",
  "process_definition_invalid",
  // Deterministic gate refusals: retrying the same start cannot succeed until
  // an administrator retests, reactivates or repairs the process.
  "process_qualification_stale",
  "process_test_conflict",
  "process_execution_unavailable",
  // Not listed on purpose: process_test_superseded, process_test_not_found and
  // process_not_found also mean the durable proof is missing (for example after
  // a partial restore). They stay errors that reserve nothing, so restoring
  // the exact proof lets the same start proceed.
] as const;
export const ProcessStartRejectionSchema = ProcessStartAdmissionSchema.pick({
  profile: true,
  receiptId: true,
  intentId: true,
  commandId: true,
  idempotencyKey: true,
  commandDigest: true,
  origin: true,
  processId: true,
  version: true,
  artifactDigest: true,
  formDigest: true,
  createdAt: true,
}).extend({
  status: z.literal("rejected"),
  reason: z.enum(PROCESS_START_REJECTIONS),
});
export const ProcessStartReceiptSchema = z.discriminatedUnion("status", [
  ProcessStartAdmissionSchema,
  ProcessStartRejectionSchema,
]);
export type ProcessStartReceipt = z.infer<typeof ProcessStartReceiptSchema>;
