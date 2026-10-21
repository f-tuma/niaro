import { z } from "zod";
import { PassiveCardDocumentSchema, type CardNode } from "./card-document";
import { ServicePresentationSchema } from "./service-presentation";
export const ServiceResultSchema = z.strictObject({
  type: z.literal("service.action"),
  version: z.literal(1),
  operationId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  title: z.string().min(1).max(100),
  service: z.string().min(1).max(100),
  status: z.enum([
    "awaiting_approval",
    "running",
    "succeeded",
    "failed",
    "unknown",
    "rejected",
  ]),
  effect: z.enum(["read", "write"]),
  fields: z
    .array(
      z.strictObject({
        label: z.string().max(100),
        value: z.string().max(1000),
      }),
    )
    .max(20),
  inputJson: z.string().max(131072),
  reviewTruncated: z.boolean(),
  summary: z.string().max(2000),
  presentation: ServicePresentationSchema.optional(),
  card: PassiveCardDocumentSchema.optional(),
});
export type ServiceResult = z.infer<typeof ServiceResultSchema>;

/** Passive generated-card labels, never authority to approve or execute. */
export const SERVICE_CARD_STATES: Record<
  ServiceResult["status"],
  { en: string; cs: string; tone: Extract<CardNode, { type: "badge" }>["tone"] }
> = {
  awaiting_approval: {
    en: "Awaiting your confirmation",
    cs: "Čeká na tvoje potvrzení",
    tone: "info",
  },
  running: { en: "In progress", cs: "Probíhá", tone: "info" },
  succeeded: { en: "Completed", cs: "Dokončeno", tone: "success" },
  failed: { en: "Failed", cs: "Selhalo", tone: "danger" },
  unknown: {
    en: "Result not verified",
    cs: "Výsledek není ověřený",
    tone: "warning",
  },
  rejected: { en: "Cancelled", cs: "Zrušeno", tone: "neutral" },
};
