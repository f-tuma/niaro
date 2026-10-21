import { z } from "zod";
import { IdentityId } from "./identity";
import { CatalogTarget, Revision } from "./service-catalog";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const InferencePriceSchema = z.strictObject({
  modelId: IdentityId,
  modelRevision: Revision,
  providerRevision: Revision,
  maxInputTokens: z.number().int().min(2048).max(1_000_000),
  maxOutputTokens: z.number().int().positive().max(128_000),
  /** USD millionths per million tokens. Explicit zero is valid for a free model. */
  inputMicrosPerMillion: count.max(1_000_000_000),
  outputMicrosPerMillion: count.max(1_000_000_000),
});
export const InferenceBudgetSettingsSchema = z.strictObject({
  mode: z.enum(["observe", "enforce"]),
  maxTokens: z.number().int().positive().max(10_000_000),
  maxCostMicros: z.number().int().positive().max(1_000_000_000),
  prices: z
    .array(InferencePriceSchema)
    .max(500)
    .refine(
      (values) => new Set(values.map((v) => v.modelId)).size === values.length,
    ),
});
export const InferenceBudgetPolicySchema = CatalogTarget.extend({
  revision: Revision,
  settings: InferenceBudgetSettingsSchema,
});
export const InferenceBudgetCommandSchema = InferenceBudgetPolicySchema;
export const InferenceBudgetUsageSchema = z.strictObject({
  inputTokens: count.nullable(),
  outputTokens: count.nullable(),
  costMicros: count.nullable(),
  costSource: z.enum(["provider", "tariff", "unknown"]),
});
export type InferenceBudgetSettings = z.infer<
  typeof InferenceBudgetSettingsSchema
>;
export type InferencePrice = z.infer<typeof InferencePriceSchema>;
export type InferenceUsage = z.infer<typeof InferenceBudgetUsageSchema>;
export type InferenceBudgetPolicy = z.infer<typeof InferenceBudgetPolicySchema>;
