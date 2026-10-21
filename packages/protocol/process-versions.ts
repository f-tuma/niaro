import { z } from "zod";
import { IdentityId } from "./identity";
import { CatalogTarget, Revision } from "./service-catalog";
import { ProcessVersionSchema } from "./service-processes";

export const PROCESS_VERSION_PROFILE = "agent-process-versions/1" as const;
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const target = CatalogTarget.extend({
  profile: z.literal(PROCESS_VERSION_PROFILE),
});

export const ProcessFreezeCommandSchema = target.extend({
  requestId: IdentityId,
  processId: IdentityId,
  revision: Revision,
});
export type ProcessFreezeCommand = z.infer<typeof ProcessFreezeCommandSchema>;
export const ProcessFreezeReceiptSchema = ProcessFreezeCommandSchema.extend({
  receiptId: IdentityId,
  serverId: IdentityId,
  version,
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
  resultingRevision: Revision,
  createdAt: z.iso.datetime(),
}).refine((v) => v.resultingRevision >= v.revision);
export type ProcessFreezeReceipt = z.infer<typeof ProcessFreezeReceiptSchema>;
export const ProcessFreezeReadQuerySchema = target.extend({
  requestId: IdentityId,
});
export const ProcessVersionListQuerySchema = target.extend({
  processId: IdentityId,
  before: z.coerce
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  limit: z.coerce.number().int().min(1).max(20).default(20),
});
export type ProcessVersionListQuery = z.infer<
  typeof ProcessVersionListQuerySchema
>;
export const ProcessVersionListSchema = target.extend({
  processId: IdentityId,
  versions: z.array(ProcessVersionSchema).max(20),
  nextBefore: version.nullable(),
});
export type ProcessVersionList = z.infer<typeof ProcessVersionListSchema>;
