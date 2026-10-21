import { z } from "zod";
import { CredentialSchema } from "./index";
import { MobilePairingTarget } from "./mobile-access";

export const BROWSER_LOGIN_PROFILE = "agent-browser-login/1" as const;
export const BrowserLoginCode = z.string().regex(/^[A-F0-9]{12}$/);
export const BrowserLoginStart = z.strictObject({
  profile: z.literal(BROWSER_LOGIN_PROFILE),
});
export const BrowserLoginSecret = BrowserLoginStart.extend({
  deviceCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export const BrowserLoginChallenge = BrowserLoginSecret.extend({
  userCode: BrowserLoginCode,
  serverId: z.string().min(1).max(100),
  verificationUri: z.url(),
  expiresAt: z.iso.datetime(),
  interval: z.number().int().min(5).max(30),
});
export const BrowserLoginPoll = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("pending"),
    interval: z.number().int().min(5).max(30),
  }),
  z.strictObject({
    status: z.literal("approved"),
    address: z.url(),
    credential: CredentialSchema,
  }),
]);
export const BrowserLoginInspect = z.strictObject({
  userCode: BrowserLoginCode,
});
export const BrowserLoginConsent = z.discriminatedUnion("approve", [
  MobilePairingTarget.extend({
    userCode: BrowserLoginCode,
    approve: z.literal(true),
  }),
  z.strictObject({ userCode: BrowserLoginCode, approve: z.literal(false) }),
]);
export const BrowserLoginDetails = z.strictObject({
  persistent: z.boolean().optional(),
  userCode: BrowserLoginCode,
  expiresAt: z.iso.datetime(),
  status: z.enum(["pending", "approved", "denied"]),
});
