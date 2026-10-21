import { z } from "zod";
import { WorkspaceTarget } from "./connections";
import { IdentityName } from "./identity";

export const AIProfileId = z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/);
export const AISelectionSchema = z.strictObject({
  modelId: AIProfileId.nullable(),
  voiceId: AIProfileId.nullable(),
});
export const AIProfileSchema = z.strictObject({
  id: AIProfileId,
  label: IdentityName,
  provider: z.string().min(1).max(80),
  model: z.string().min(1).max(160).optional(),
  expiresAt: z.iso.datetime().optional(),
  available: z.boolean(),
});
export const WorkspaceAISchema = WorkspaceTarget.extend({
  profile: z.literal("agent-workspace-ai/1"),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  selection: AISelectionSchema,
  models: z.array(AIProfileSchema).max(13),
  voices: z.array(AIProfileSchema).max(13),
});
export const UpdateWorkspaceAISchema = WorkspaceTarget.extend({
  revision: WorkspaceAISchema.shape.revision,
  selection: AISelectionSchema,
});
export type WorkspaceAI = z.infer<typeof WorkspaceAISchema>;
export type AISelection = z.infer<typeof AISelectionSchema>;
