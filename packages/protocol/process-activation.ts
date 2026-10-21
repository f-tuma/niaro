import { z } from "zod";
import { IdentityId } from "./identity";
import { CatalogTarget, Revision } from "./service-catalog";
import { NativeQualificationSummarySchema } from "./process-native-qualification";

export const PROCESS_ACTIVATION_PROFILE = "agent-process-activation/1" as const;
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const target = CatalogTarget.extend({
  profile: z.literal(PROCESS_ACTIVATION_PROFILE),
});

/** Only a human account command can acknowledge the limited test scope. */
export const ProcessActivationCommandSchema = target.extend({
  requestId: IdentityId,
  type: z.enum(["activate", "rollback"]),
  processId: IdentityId,
  revision: Revision,
  expectedActiveVersion: version.nullable(),
  version,
  artifactDigest: digest,
  testId: IdentityId,
  qualificationDigest: digest,
  acknowledgement: z.literal("controlled_native_test_only"),
});
export type ProcessActivationCommand = z.infer<
  typeof ProcessActivationCommandSchema
>;

export const ProcessActivationReceiptSchema =
  ProcessActivationCommandSchema.extend({
    receiptId: IdentityId,
    serverId: IdentityId,
    activeVersion: version,
    resultingRevision: Revision,
    qualification: NativeQualificationSummarySchema,
    createdAt: z.iso.datetime(),
  }).refine(
    (v) =>
      v.activeVersion === v.version &&
      v.resultingRevision >= v.revision &&
      v.qualification.status === "qualified" &&
      v.qualification.qualificationDigest === v.qualificationDigest,
  );
export type ProcessActivationReceipt = z.infer<
  typeof ProcessActivationReceiptSchema
>;

export const ProcessActivationReadQuerySchema = target.extend({
  requestId: IdentityId,
});
export const ProcessActivationReviewQuerySchema = target.extend({
  processId: IdentityId,
  version: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  testId: IdentityId,
});
export type ProcessActivationReviewQuery = z.infer<
  typeof ProcessActivationReviewQuerySchema
>;
export const ProcessActivationReviewSchema = target.extend({
  processId: IdentityId,
  revision: Revision,
  activeVersion: version.nullable(),
  version,
  artifactDigest: digest,
  testId: IdentityId,
  qualification: NativeQualificationSummarySchema,
  canActivate: z.boolean(),
  canRollback: z.boolean(),
});
