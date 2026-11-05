export const OPENROUTER_URL = "https://openrouter.ai/api/v1";

/**
 * A model's kind decides its capabilities: decision and transcription models
 * have no tools or audio, speech models only audio output, routers no audio.
 * Kinds come from discovery or from the administrator; no model is
 * recognized by its ID. Reviewed voices stay only on models that speak.
 */
export function normalizeModelCapabilities<
  T extends {
    model: string;
    kind: "chat" | "decision" | "router" | "transcription" | "speech";
    tools: boolean | null;
    audioInput: boolean | null;
    audioOutput?: boolean | null;
    voices?: { voice: string; label: string }[];
  },
>(value: T): T {
  const kind = value.kind;
  const speaks = kind === "speech" || (kind === "chat" && !!value.audioOutput);
  const voiced =
    value.voices && !speaks ? { ...value, voices: [] } : { ...value };
  if (kind === "speech")
    return {
      ...voiced,
      kind,
      tools: false,
      audioInput: false,
      audioOutput: true,
    };
  if (kind === "decision" || kind === "transcription")
    return {
      ...voiced,
      kind,
      tools: false,
      audioInput: false,
      audioOutput: false,
    };
  if (kind === "router")
    return { ...voiced, kind, audioInput: false, audioOutput: false };
  return voiced;
}
