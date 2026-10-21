import { PROFILE } from "../protocol";

/** Local persistence only. Network payloads must use the negotiated profile. */
export function migrateStoredWorkflowProfile(raw: unknown): unknown {
  if (
    raw &&
    typeof raw === "object" &&
    "profile" in raw &&
    [
      "agent-client/0.2-fixture",
      "agent-client/0.3-fixture",
      "agent-client/0.4-fixture",
      "agent-client/0.5-fixture",
      "agent-client/0.6-fixture",
      "agent-client/0.7-fixture",
    ].includes(String(raw.profile))
  )
    return { ...raw, profile: PROFILE };
  return raw;
}
