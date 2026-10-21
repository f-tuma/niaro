import { z } from "zod";
import { WorkspaceTarget } from "./connections";
import { IdentityId, IdentityName, OrganizationRole } from "./identity";

// Exact operator-approved collections, never a client-selected discovery URL.
export const CalendarCollectionUrl = z
  .url()
  .max(1000)
  .refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    return (
      url.href === value &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname.endsWith("/") &&
      /^\/[A-Za-z0-9_~@./-]*$/.test(url.pathname) &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  });
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const roles = z
  .array(OrganizationRole)
  .max(3)
  .refine((v) => new Set(v).size === v.length);
const credentials = {
  username: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-zA-Z0-9_-]+$/),
  password: z.string().min(16).max(512),
};
export const CalendarCommand = z.discriminatedUnion("type", [
  WorkspaceTarget.extend({
    type: z.literal("create"),
    name: IdentityName,
    collectionUrl: CalendarCollectionUrl,
    ...credentials,
  }),
  WorkspaceTarget.extend({
    type: z.literal("configure"),
    calendarId: IdentityId,
    revision,
    enabled: z.boolean(),
    roles,
  }),
  WorkspaceTarget.extend({
    type: z.literal("rotate"),
    calendarId: IdentityId,
    revision,
    ...credentials,
  }),
  WorkspaceTarget.extend({
    type: z.literal("remove"),
    calendarId: IdentityId,
    revision,
  }),
]);
export const WorkspaceCalendarSchema = WorkspaceTarget.extend({
  profile: z.literal("agent-workspace-calendar/1"),
  canManage: z.boolean(),
  allowedCollections: z.array(CalendarCollectionUrl).max(20),
  calendar: z
    .strictObject({
      id: IdentityId,
      name: IdentityName,
      collectionUrl: CalendarCollectionUrl,
      revision,
      enabled: z.boolean(),
      roles,
      state: z.enum(["configured", "disabled", "unavailable"]),
      canCreate: z.boolean(),
    })
    .nullable(),
});
export type WorkspaceCalendar = z.infer<typeof WorkspaceCalendarSchema>;
