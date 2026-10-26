import { z } from "zod";
import { LanguageSchema, ScopeSchema } from "./index";
import { IdentityId, IdentityName } from "./identity";
import { ProcessDataSchema } from "./service-processes";
import {
  ProcessStartIntentSchema,
  ProcessStartOriginSchema,
} from "./process-start";

export const PROCESS_EXECUTION_PROFILE = "agent-process-execution/1" as const;
export const PROCESS_INPUT_PROFILE = "agent-process-input/1" as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const inputSchema = ProcessDataSchema.refine((v) => v.type === "object");
const summary = {
  processId: IdentityId,
  name: IdentityName,
  description: z.string().max(1000),
  kind: z.enum(["agent", "workflow"]),
  version,
  artifactDigest: digest,
};
/** Present only on the owner's personal ("Personal") entries; workspace entries
 * keep their original bytes and inventory fingerprints. */
const personal = { personal: z.literal(true).optional() };
export const ProcessExecutionEntrySchema = z.discriminatedUnion(
  "availability",
  [
    z.strictObject({
      ...summary,
      ...personal,
      availability: z.literal("ready"),
      inputSchema,
    }),
    z.strictObject({
      ...summary,
      ...personal,
      availability: z.literal("blocked"),
      reason: z.enum([
        "service_unavailable",
        "model_unavailable",
        "source_changed",
        "connection_required",
        "qualification_required",
        "budget_unavailable",
      ]),
    }),
  ],
);
export type ProcessExecutionEntry = z.infer<typeof ProcessExecutionEntrySchema>;
export const ProcessExecutionQuerySchema = z
  .strictObject({
    after: IdentityId.optional(),
    fingerprint: digest.optional(),
  })
  .refine((v) => !v.after || !!v.fingerprint);
export const ProcessExecutionInventorySchema = z.strictObject({
  profile: z.literal(PROCESS_EXECUTION_PROFILE),
  scope: ScopeSchema,
  fingerprint: digest,
  processes: z.array(ProcessExecutionEntrySchema).max(100),
  nextAfter: IdentityId.nullable(),
});
export type ProcessExecutionInventory = z.infer<
  typeof ProcessExecutionInventorySchema
>;
export const ProcessInputRequestSchema = z.strictObject({
  processId: IdentityId,
  version,
  artifactDigest: digest,
  language: LanguageSchema,
  origin: ProcessStartOriginSchema,
});
export type ProcessInputRequest = z.infer<typeof ProcessInputRequestSchema>;
/** Server-built semantic controls. No remote UI, scripts, prompts or source credentials. */
export const ProcessInputFormSchema = z.strictObject({
  profile: z.literal(PROCESS_INPUT_PROFILE),
  scope: ScopeSchema,
  language: LanguageSchema,
  ...summary,
  inputSchema,
  origin: ProcessStartOriginSchema,
});
export type ProcessInputForm = z.infer<typeof ProcessInputFormSchema>;
export const ProcessInputCardSchema = z
  .strictObject({
    form: ProcessInputFormSchema,
    formDigest: digest,
    intent: ProcessStartIntentSchema,
  })
  .refine(
    ({ form, formDigest, intent }) =>
      form.processId === intent.processId &&
      form.version === intent.version &&
      form.artifactDigest === intent.artifactDigest &&
      formDigest === intent.formDigest &&
      JSON.stringify(form.origin) === JSON.stringify(intent.origin) &&
      JSON.stringify(form.inputSchema) === JSON.stringify(intent.inputSchema) &&
      Object.keys(intent.fields).length === 0,
  );
export type ProcessInputCard = z.infer<typeof ProcessInputCardSchema>;
