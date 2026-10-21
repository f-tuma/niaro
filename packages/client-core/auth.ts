import {
  AUTH_PROFILE,
  PROFILE,
  AuthSessionSchema,
  CredentialSchema,
  sameScope,
  type Credential,
} from "../protocol";
import {
  persistentSessionPath,
  RefreshRequestSchema,
  RevokeDeviceSchema,
} from "../protocol/device-session";
export class AuthenticationError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
  }
}
export async function authRequest(
  address: string,
  path: "pair" | "session",
  request: typeof fetch,
  credential?: Credential,
  code?: string,
  revoke = false,
  persistent = false,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const deviceRevoke = revoke && credential?.refresh;
    const endpoint = deviceRevoke
      ? "auth/refresh"
      : persistent && code !== undefined
        ? persistentSessionPath(`auth/${path}`)
        : `auth/${path}`;
    const response = await request(`${address}/${endpoint}`, {
      method: revoke ? "DELETE" : code !== undefined ? "POST" : "GET",
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
      headers: {
        ...(credential
          ? { Authorization: `Bearer ${credential.accessToken}` }
          : {}),
        ...(code !== undefined || deviceRevoke
          ? { "Content-Type": "application/json" }
          : {}),
      },
      ...(deviceRevoke
        ? {
            body: JSON.stringify(
              RevokeDeviceSchema.parse({
                profile: deviceRevoke.profile,
                refreshToken: deviceRevoke.token,
              }),
            ),
          }
        : code !== undefined
          ? {
              body: JSON.stringify({
                authProfile: AUTH_PROFILE,
                profile: PROFILE,
                code,
              }),
            }
          : {}),
    });
    if (!response.ok)
      throw new AuthenticationError(
        response.status === 429
          ? "pairing_rate_limited"
          : response.status === 401 || response.status === 403
            ? code !== undefined
              ? "pairing_invalid"
              : "auth_expired"
            : "connection_failed",
        response.status,
      );
    if (revoke) return null;
    const raw = await response.text();
    if (raw.length > 16_384) throw Error("Invalid auth response");
    const value: unknown = JSON.parse(raw);
    if (code !== undefined) return CredentialSchema.parse(value);
    const session = AuthSessionSchema.parse(value);
    if (
      !credential ||
      !sameScope(session.scope, credential.scope) ||
      session.expiresAt !== credential.expiresAt
    )
      throw new AuthenticationError("auth_scope_mismatch");
    return credential;
  } finally {
    clearTimeout(timer);
  }
}
export async function refreshCredential(
  address: string,
  credential: Credential,
  requestId: string,
  request: typeof fetch,
) {
  if (!credential.refresh) throw new AuthenticationError("auth_expired");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await request(`${address}/auth/refresh`, {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        RefreshRequestSchema.parse({
          profile: credential.refresh.profile,
          refreshToken: credential.refresh.token,
          requestId,
        }),
      ),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403)
        throw new AuthenticationError("auth_expired", response.status);
      throw new AuthenticationError("connection_failed", response.status);
    }
    const raw = await response.text();
    if (raw.length > 16384) throw new Error("connection_failed");
    const next = CredentialSchema.parse(JSON.parse(raw));
    if (
      !next.refresh ||
      !sameScope(next.scope, credential.scope) ||
      JSON.stringify(next.permissions) !==
        JSON.stringify(credential.permissions)
    )
      throw new AuthenticationError("auth_scope_mismatch");
    return next;
  } finally {
    clearTimeout(timer);
  }
}
