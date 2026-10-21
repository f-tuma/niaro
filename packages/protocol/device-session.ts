import { z } from "zod";
import { DEVICE_SESSION_PROFILE, RefreshCredentialSchema } from "./index";
export const RefreshRequestSchema = z.strictObject({
  profile: z.literal(DEVICE_SESSION_PROFILE),
  refreshToken: RefreshCredentialSchema.shape.token,
  requestId: z
    .string()
    .min(16)
    .max(100)
    .regex(/^[a-zA-Z0-9._:-]+$/),
});
export const RevokeDeviceSchema = RefreshRequestSchema.omit({
  requestId: true,
});
export function persistentSessionPath(path: string) {
  return `${path}?session=${encodeURIComponent(DEVICE_SESSION_PROFILE)}`;
}
