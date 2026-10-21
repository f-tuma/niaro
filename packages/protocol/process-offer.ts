import { z } from "zod";
import { IdentityId, IdentityName } from "./identity";
import { ProcessKey } from "./service-processes";

const json: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string().max(4000),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(json).max(100),
    z.record(ProcessKey, json),
  ]),
);
/** A saved process the assistant suggests for a chat request. It is passive:
 * the person reviews the suggested inputs and starts the process through the
 * explicit process flow. An offer never prepares, admits or runs work. */
export const ProcessOfferResultSchema = z.strictObject({
  type: z.literal("process.offer"),
  version: z.literal(1),
  processId: IdentityId,
  processVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
  name: IdentityName,
  description: z.string().max(1000),
  kind: z.enum(["agent", "workflow"]),
  /** Why the assistant thinks the process fits, in the person's language. */
  reason: z.string().trim().max(500),
  /** Suggested top-level input values; only a starting draft for review. */
  input: z
    .record(ProcessKey, json)
    .refine(
      (value) =>
        Object.keys(value).length <= 40 &&
        JSON.stringify(value).length <= 16_384,
    ),
});
export type ProcessOfferResult = z.infer<typeof ProcessOfferResultSchema>;
