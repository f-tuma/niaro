import { z } from "zod";

export const AdminServiceId = z.enum(["model", "voice", "crm", "calendar"]);
export const AdminServiceSchema = z.strictObject({
  id: AdminServiceId,
  provider: z.enum([
    "fixture",
    "openrouter",
    "disabled",
    "whisper.cpp",
    "twenty-test",
    "simulated",
    "caldav",
    "custom",
  ]),
  state: z.enum(["configured", "disabled", "demo", "expired", "unavailable"]),
  model: z.string().max(160).optional(),
  expiresAt: z.iso.datetime().optional(),
  calendarLabel: z.string().max(160).optional(),
});
export const AdminToolSchema = z.strictObject({
  id: z.string().min(1).max(120),
  permission: z.string().max(100),
  effect: z.literal("read"),
  description: z.object({ en: z.string().max(300), cs: z.string().max(300) }),
});
export const AdminOverviewSchema = z.strictObject({
  profile: z.literal("agent-server-admin/2"),
  server: z.strictObject({
    name: z.string().max(100),
    workflowProfile: z.string().max(100),
    startedAt: z.iso.datetime(),
    sessionSeconds: z.number().int().positive(),
  }),
  observedAt: z.iso.datetime(),
  services: z.array(AdminServiceSchema).max(4),
  tools: z.array(AdminToolSchema).max(100),
  authentication: z.strictObject({
    current: z.enum(["admin-key", "better-auth"]),
    identityEnabled: z.boolean(),
    principalId: z.string().min(1).max(80).nullable(),
    /** False for a workspace member: only the personal pages are available. */
    console: z.boolean(),
    oauth: z.literal("not_configured"),
    backupKey: z.literal(true),
    expiresAt: z.iso.datetime(),
  }),
});
export type AdminService = z.infer<typeof AdminServiceSchema>;
export type AdminTool = z.infer<typeof AdminToolSchema>;
export type AdminOverview = z.infer<typeof AdminOverviewSchema>;
