export const OPENROUTER_URL = "https://openrouter.ai/api/v1";
export const JEV_DECISION_MODEL = "typesafe/jev-1.13";

/** Provider-specific API identities, not display-name matching. Router modalities describe forwarding. */
export function normalizeModelCapabilities<
  T extends {
    model: string;
    kind: "chat" | "decision" | "router" | "transcription" | "speech";
    tools: boolean | null;
    audioInput: boolean | null;
    audioOutput?: boolean | null;
  },
>(providerUrl: string, value: T): T {
  let kind = value.kind;
  if (providerUrl.replace(/\/$/, "") === OPENROUTER_URL) {
    if (value.model === "typesafe/jev-router") kind = "router";
    if ([JEV_DECISION_MODEL, "~typesafe/jev-latest"].includes(value.model))
      kind = "decision";
  }
  if (kind === "speech")
    return {
      ...value,
      kind,
      tools: false,
      audioInput: false,
      audioOutput: true,
    };
  if (kind === "decision" || kind === "transcription")
    return {
      ...value,
      kind,
      tools: false,
      audioInput: false,
      audioOutput: false,
    };
  if (kind === "router")
    return { ...value, kind, audioInput: false, audioOutput: false };
  return value;
}
