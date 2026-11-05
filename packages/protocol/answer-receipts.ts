import { z } from "zod";
import { TierId } from "./model-policy";

const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9._:-]+$/);
const label = z.string().trim().min(1).max(160);

/**
 * One thing an answer read, changed or had in its context, as the person
 * may open it now. `title` is what the line shows; `detail` names where it
 * lives (the service of an action, for instance).
 */
export const ReceiptItemSchema = z.strictObject({
  kind: z.enum(["service", "memory", "task", "skill", "meeting", "file"]),
  id: z.string().min(1).max(200),
  title: label,
  detail: label.optional(),
});
export type ReceiptItem = z.infer<typeof ReceiptItemSchema>;

/**
 * What one answer was built from (NIAR-296), only from what the server
 * recorded while it ran, never from the model's words: the service reads it
 * made, what it changed, the memories, skills, meetings and files in its
 * context, and the model that wrote it. The model shows by the
 * administrator's name for it; `reason` says when it was not the first
 * choice (a fallback before dispatch, or an escalation after a check). An
 * item the person can no longer open is left out.
 */
export const AnswerReceiptSchema = z.strictObject({
  /** The request the answer replies to (the message's `replyToCommandId`). */
  commandId: id,
  read: z.array(ReceiptItemSchema).max(20),
  changed: z.array(ReceiptItemSchema).max(20),
  memories: z.array(ReceiptItemSchema).max(20),
  skills: z.array(ReceiptItemSchema).max(10),
  meetings: z.array(ReceiptItemSchema).max(10),
  files: z.array(ReceiptItemSchema).max(10),
  model: z
    .strictObject({
      name: z.string().trim().min(1).max(160),
      reason: z.enum(["fallback", "escalation"]).optional(),
    })
    .optional(),
  /** The preset the person picked for this request, by its name. */
  preset: z
    .strictObject({ id: TierId, name: z.string().trim().min(1).max(40) })
    .optional(),
});
export type AnswerReceipt = z.infer<typeof AnswerReceiptSchema>;

export const ANSWER_RECEIPTS_PROFILE = "agent-answer-receipts/1" as const;
/** `GET /v1/:workspace/receipts?conversationId=`: the chat's latest answers' receipts. */
export const AnswerReceiptPageSchema = z.strictObject({
  profile: z.literal(ANSWER_RECEIPTS_PROFILE),
  conversationId: id,
  receipts: z.array(AnswerReceiptSchema).max(40),
});
export type AnswerReceiptPage = z.infer<typeof AnswerReceiptPageSchema>;
