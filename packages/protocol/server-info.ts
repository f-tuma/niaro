import { z } from "zod";
import { PROFILE, ScopeSchema } from "./index";

/** Optional authenticated discovery. Configuration describes support, never grants permission. */
export const SERVER_INFO_PROFILE = "agent-server-info/2" as const;
export const ServerInfoSchema = z.strictObject({
  profile: z.literal(SERVER_INFO_PROFILE),
  name: z.string().trim().min(1).max(100),
  scope: ScopeSchema,
  workflowProfile: z.literal(PROFILE),
  componentCatalog: z.strictObject({
    "workflow.progress": z.literal(1),
    "input.choice": z.literal(1),
    "action.approval": z.literal(1),
    "crm.contacts": z.literal(1),
    "service.action": z.literal(2).optional(),
    "service.connection": z.literal(1).optional(),
    "card.document": z.literal(1).optional(),
  }),
  configuredServices: z.strictObject({
    interpretation: z.enum(["demo-phrases", "model", "disabled"]),
    voice: z.boolean(),
    contacts: z.enum(["disabled", "test-read-only"]),
    calendar: z.enum(["simulated", "caldav-test"]),
  }),
});
export type ServerInfo = z.infer<typeof ServerInfoSchema>;
