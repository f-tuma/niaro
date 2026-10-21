import { z } from "zod";

/** Things a person can tag in a chat message with "@". */
export const MentionKindSchema = z.enum([
  "service",
  "process",
  "skill",
  "meeting",
]);
export type MentionKind = z.infer<typeof MentionKindSchema>;

/** A tag inside a sent message: the server re-checks access to it. */
export const MessageMentionSchema = z.strictObject({
  kind: MentionKindSchema,
  id: z.string().min(1).max(200),
});
export type MessageMention = z.infer<typeof MessageMentionSchema>;

export const MENTIONS_PROFILE = "agent-mentions/1" as const;
/** `GET /v1/:workspace/mentions`: what this person can tag right now. */
export const MentionDirectorySchema = z.strictObject({
  profile: z.literal(MENTIONS_PROFILE),
  items: z
    .array(
      z.strictObject({
        kind: MentionKindSchema,
        id: z.string().min(1).max(200),
        name: z.string().min(1).max(120),
        description: z.string().max(300).optional(),
        /** Personal (the person's own) vs company/workspace-wide. */
        personal: z.boolean().optional(),
      }),
    )
    .max(300),
});
export type MentionDirectory = z.infer<typeof MentionDirectorySchema>;
