import { z } from "zod";
import {
  BROWSER_LOGIN_PROFILE,
  BrowserLoginChallenge,
  BrowserLoginPoll,
} from "../protocol/browser-login";
import { normalizeAddress } from "./connection";
import { isAccountScope } from "../protocol/mobile-access";
import { AuthenticationError } from "./auth";
import { persistentSessionPath } from "../protocol/device-session";

export function loginOrigin(raw: string, allowHttp: boolean) {
  const url = new URL(normalizeAddress(raw, allowHttp));
  if (url.pathname !== "/" && !/^\/v1\/[A-Za-z0-9-]+\/?$/.test(url.pathname))
    throw Error("addressError");
  return url.origin;
}
export async function browserLoginRequest(
  origin: string,
  action: "start" | "poll" | "cancel",
  request: typeof fetch,
  deviceCode?: string,
  signal?: AbortSignal,
  persistent = false,
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 8000);
  try {
    // React Native's AbortSignal polyfill has no throwIfAborted method.
    if (signal?.aborted) {
      abort();
      const error = new Error("The request was aborted");
      error.name = "AbortError";
      throw error;
    }
    const path = `/v1/auth/browser/${action}`;
    const response = await request(
      `${origin}${persistent && action === "start" ? persistentSessionPath(path) : path}`,
      {
        method: "POST",
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile: BROWSER_LOGIN_PROFILE,
          ...(deviceCode ? { deviceCode } : {}),
        }),
      },
    );
    const text = await response.text();
    if (text.length > 16384) throw Error("connection_failed");
    const value: unknown = JSON.parse(text);
    if (!response.ok) {
      const code = z.object({ error: z.string() }).safeParse(value);
      const known = [
        "browser_login_expired",
        "browser_login_denied",
        "browser_login_slow_down",
        "pairing_rate_limited",
      ];
      throw new AuthenticationError(
        code.success && known.includes(code.data.error)
          ? code.data.error
          : "connection_failed",
      );
    }
    return value;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}
export function validateLoginChallenge(value: unknown, origin: string) {
  const challenge = BrowserLoginChallenge.parse(value);
  const expected = `${origin}/admin/device#${challenge.userCode}`;
  if (
    challenge.verificationUri !== expected ||
    Date.parse(challenge.expiresAt) <= Date.now() ||
    Date.parse(challenge.expiresAt) > Date.now() + 310_000
  )
    throw Error("connection_failed");
  return challenge;
}
export function validateLoginPoll(
  value: unknown,
  origin: string,
  serverId: string,
) {
  const result = BrowserLoginPoll.parse(value);
  if (
    result.status === "approved" &&
    (result.address !== `${origin}/v1/${result.credential.scope.workspaceId}` ||
      result.credential.scope.serverId !== serverId ||
      !isAccountScope(result.credential.scope) ||
      Date.parse(result.credential.expiresAt) <= Date.now())
  )
    throw Error("auth_scope_mismatch");
  return result;
}
