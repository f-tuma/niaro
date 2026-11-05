import { createHash } from "node:crypto";
export type OutputVoiceActor = {
  organizationId: string;
  workspaceId: string;
  userId: string;
};
export type SpeechVoiceRoute = {
  provider: { id: string; revision: number; url: string };
  model: {
    id: string;
    revision: number;
    model: string;
    /** The voices an administrator reviewed for this model, in order. */
    voices: readonly { voice: string; label: string }[];
  };
  method: "reader" | "speech";
  format: "pcm16" | "mp3";
  zeroDataRetention: boolean;
  voice: string;
};
/**
 * The voices members may choose for spoken replies: the ones an
 * administrator listed on the speech model in the catalog. Their revision
 * follows the list, so editing it retires earlier choices.
 */
export function reviewedSpeechVoices(route: SpeechVoiceRoute | null) {
  return route?.model.voices.length
    ? {
        revision: voiceDigest([
          "agent-output-voice-reviewed/1",
          route.model.id,
          route.model.voices,
        ]),
        voices: route.model.voices,
      }
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
    ? (route.model.voices.find((item) => item.voice === route.voice)?.label ??
      route.voice[0]!.toUpperCase() + route.voice.slice(1))
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
