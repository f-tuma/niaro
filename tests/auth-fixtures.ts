import { AUTH_PROFILE, PROFILE, type Credential } from "../packages/protocol";
import { scopeFor } from "../packages/test-fixtures";
export const credential = (workspace = "a"): Credential => ({
  authProfile: AUTH_PROFILE,
  profile: PROFILE,
  scope: scopeFor(workspace),
  expiresAt: "2099-01-01T00:00:00.000Z",
  permissions: ["workflow.read", "workflow.write"],
  accessToken: "A".repeat(43), // deliberately fake; only the injected transport accepts it
});
export const authInfo = (c = credential()) => ({
  authProfile: c.authProfile,
  profile: c.profile,
  scope: c.scope,
  expiresAt: c.expiresAt,
  permissions: c.permissions,
});
