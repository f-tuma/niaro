import type { HarnessSettings } from "@earendil-works/pi-durable";

/** Policy A as Pi settings. A host may tighten them, never drop them. */
export const RECOVERY_POLICY_A = {
  retry: {
    enabled: true,
    maxRetries: 2,
    baseDelayMs: 2_000,
    maxAgentDelayMs: 30_000,
  },
  restartLimit: 3,
} as const satisfies HarnessSettings;
