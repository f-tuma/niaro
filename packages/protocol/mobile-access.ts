import { z } from "zod";
import { IdentityId } from "./identity";
import { ScopeSchema } from "./index";

export const AccountWorkspaceId = z.uuid();
export const MobilePairingTarget = z.strictObject({
  organizationId: IdentityId,
  workspaceId: AccountWorkspaceId,
});
export const MobilePairingResult = MobilePairingTarget.extend({
  code: z.string().regex(/^[a-f0-9]{32}$/),
  address: z.url(),
  expiresAt: z.iso.datetime(),
  sessionExpiresAt: z.iso.datetime(),
});
export const MobileWorkspaceStatus = MobilePairingTarget.extend({
  activeDevices: z.number().int().nonnegative().max(8),
  availableDeviceSlots: z.number().int().min(0).max(8),
  modelEnabled: z.boolean(),
  voiceEnabled: z.boolean(),
});
/** A separate namespace: account scopes never alias the legacy demo a/b accounts. */
export function isAccountScope(scope: z.infer<typeof ScopeSchema>) {
  return (
    AccountWorkspaceId.safeParse(scope.workspaceId).success &&
    IdentityId.safeParse(scope.userId).success &&
    scope.connectionId === `account-${scope.workspaceId}`
  );
}
