import { AdminOverviewSchema } from "../../../../packages/protocol/admin";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(String(status));
  }
}
async function request(path: string, body?: unknown, signal?: AbortSignal) {
  const pathname = path.split("?")[0];
  const response = await fetch(`/admin/${path}`, {
    credentials: "same-origin",
    signal: AbortSignal.any([
      AbortSignal.timeout(
        pathname === "api/identity/catalog/processes/design/turns" &&
          body !== undefined
          ? 305_000
          : pathname === "api/identity/catalog/discover" ||
              (pathname === "api/identity/catalog/processes/tests/native" &&
                body !== undefined)
            ? 125_000
            : path.includes("catalog/")
              ? 50_000
              : 10_000,
      ),
      ...(signal ? [signal] : []),
    ]),
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Agent-Admin": "1" },
          body: JSON.stringify(body),
        }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new ApiError(
      response.status,
      typeof error?.error === "string" ? error.error : undefined,
    );
  }
  return response.json() as Promise<unknown>;
}
export const api = (path: string, body?: unknown, signal?: AbortSignal) =>
  request(`api/${path}`, body, signal);
export const authApi = (
  path:
    | "sign-in/email"
    | "sign-out"
    | "mcp/oauth/consent-info"
    | "mcp/oauth/consent",
  body: unknown,
  signal?: AbortSignal,
) => request(`auth/${path}`, body, signal);

/** Only the official MCP consent page can resume an OAuth email sign-in. */
export function mcpLoginRedirect(
  value: unknown,
  origin: string,
): string | null {
  if (
    !value ||
    typeof value !== "object" ||
    !("ok" in value) ||
    value.ok !== true
  )
    throw new ApiError(422);
  if (!("redirect" in value) || value.redirect === undefined) return null;
  if (
    typeof value.redirect !== "string" ||
    value.redirect.length > 20_480 ||
    /[\r\n\\]/.test(value.redirect)
  )
    throw new ApiError(422);
  let target: URL;
  try {
    target = new URL(value.redirect, origin);
  } catch {
    throw new ApiError(422);
  }
  if (
    target.origin !== origin ||
    target.pathname !== "/admin/mcp/consent" ||
    target.username ||
    target.password ||
    target.hash
  )
    throw new ApiError(422);
  return target.href;
}
export async function loadOverview(signal: AbortSignal) {
  try {
    const result = AdminOverviewSchema.safeParse(
      await api("overview", undefined, signal),
    );
    if (!result.success) throw new ApiError(422);
    return result.data;
  } catch (error) {
    // A revoked session replaces cached inventory, even after a successful read.
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}
export const overviewKey = ["admin", "overview"] as const;
export function errorMessage(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 401) return "authError";
    if (error.status === 429) return "rateError";
    if (error.status === 422) return "invalidError";
  }
  return "networkError";
}
