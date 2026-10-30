import { createHash } from "node:crypto";
export type OutputVoiceActor = {
  organizationId: string;
  workspaceId: string;
  userId: string;
};
export type SpeechVoiceRoute = {
  provider: { id: string; revision: number; url: string };
  model: { id: string; revision: number; model: string };
  method: "reader" | "speech";
  format: "pcm16" | "mp3";
  zeroDataRetention: boolean;
  voice: string;
};
const MINI_READER = {
  revision: "openrouter-gpt-audio-mini-reader-20261030-1",
  // Accepted upstream-contract inference, not per-model metadata or a live adapter test.
  provenance:
    "upstream-contract inference; OpenAI Chat Completions and OpenRouter audio forwarding (2026-10-30)",
  voices: [
    { voice: "alloy", label: "Alloy" },
    { voice: "echo", label: "Echo" },
    { voice: "shimmer", label: "Shimmer" },
  ],
} as const;
export function reviewedSpeechVoices(route: SpeechVoiceRoute | null) {
  return route &&
    route.provider.url.replace(/\/$/, "") === "https://openrouter.ai/api/v1" &&
    route.model.model === "openai/gpt-audio-mini" &&
    route.method === "reader" &&
    route.format === "pcm16"
    ? MINI_READER
    : null;
}
export const voiceDigest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Default is intentionally excluded: following default and compatibility differ. */
export function speechVoiceCompatibility(route: SpeechVoiceRoute | null) {
  return route
    ? [
        "agent-output-voice-binding/1",
        route.provider.id,
        route.provider.revision,
        route.provider.url.replace(/\/$/, ""),
        route.model.id,
        route.model.revision,
        route.model.model,
        route.method,
        route.format,
        route.zeroDataRetention,
        reviewedSpeechVoices(route)?.revision ?? null,
      ]
    : ["agent-output-voice-binding/1", null];
}
/** IDs are actor-scoped correlations, never authorization or raw provider targets. */
export function outputVoiceCatalogue(
  actor: OutputVoiceActor,
  route: SpeechVoiceRoute | null,
  epoch: number,
) {
  const identity = voiceDigest([
    "agent-output-voice-route/1",
    actor.organizationId,
    actor.workspaceId,
    actor.userId,
    epoch,
    speechVoiceCompatibility(route),
  ]);
  const options = (reviewedSpeechVoices(route)?.voices ?? []).map(
    ({ voice, label }) => ({
      optionId: `ov_${voiceDigest(["agent-output-voice-option/1", identity, voice])}`,
      label,
      voice,
    }),
  );
  const defaultLabel = route
    ? route.voice[0]!.toUpperCase() + route.voice.slice(1)
    : "";
  return {
    identity,
    options,
    defaultLabel,
    catalogueRevision: voiceDigest([
      "agent-output-voice-catalogue/1",
      identity,
      route?.voice ?? null,
      defaultLabel,
      options,
    ]),
  };
}
