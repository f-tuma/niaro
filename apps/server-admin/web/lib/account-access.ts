import { z } from "zod";

/** The person's own sign-ins as `identity/account/access` lists them. */
export const AccessSchema = z.object({
  hasPassword: z.boolean(),
  limit: z.number(),
  used: z.number(),
  devices: z.array(
    z.object({
      id: z.string(),
      workspaceName: z.string().nullable(),
      createdAt: z.number().nullable(),
      lastActiveAt: z.number(),
    }),
  ),
  sessions: z.array(
    z.object({
      id: z.string(),
      workspaceName: z.string().nullable(),
      expiresAt: z.number(),
    }),
  ),
  browsers: z.array(
    z.object({
      id: z.string(),
      current: z.boolean(),
      createdAt: z.number(),
      expiresAt: z.number(),
      userAgent: z.string().nullable(),
      chats: z.array(z.string()),
    }),
  ),
  /** Active MCP access tokens (manual and OAuth); they end with sign-out everywhere. */
  mcp: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        workspaceName: z.string().nullable(),
        scopes: z.array(z.string()),
        createdAt: z.number(),
        expiresAt: z.number(),
        lastUsedAt: z.number().nullable(),
      }),
    )
    .default([]),
});
export type Access = z.infer<typeof AccessSchema>;

/** "Firefox · Linux" from a user agent; never shown raw. */
export function browserLabel(userAgent: string | null, fallback: string) {
  if (!userAgent) return fallback;
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /OPR\//.test(userAgent)
      ? "Opera"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Chrome\//.test(userAgent)
          ? "Chrome"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : fallback;
  const system = /iPhone|iPad/.test(userAgent)
    ? "iOS"
    : /Android/.test(userAgent)
      ? "Android"
      : /Windows/.test(userAgent)
        ? "Windows"
        : /Mac OS X|Macintosh/.test(userAgent)
          ? "macOS"
          : /Linux/.test(userAgent)
            ? "Linux"
            : null;
  return system ? `${browser} · ${system}` : browser;
}
