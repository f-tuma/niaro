import { workspacePolicyFromLegacy } from "../../apps/server-identity/model-policy";
import type { ModelPolicyViewValue } from "../../packages/protocol/model-policy";

/**
 * Test fixtures written for the single per-workspace model choice before
 * NIAR-293, saved as the workspace's model policy through the same
 * conversion the stored rows migrate with: the chat model, service models,
 * voice input, meeting transcription, spoken replies and the selector (whose
 * model the checker follows). `planner` and the methods are ignored.
 */
export function routingCommand(routing: {
  revision?: number;
  modelId?: string | null;
  [key: string]: unknown;
}) {
  const { revision = 0, ...legacy } = routing;
  return {
    type: "saveWorkspaceModelPolicy" as const,
    revision,
    policy: workspacePolicyFromLegacy(legacy),
  };
}

/**
 * What a workspace runs on now, in the old single-choice terms the fixtures
 * edit: read it, change a field, save it back with `routingCommand`.
 */
export function currentRouting(view: ModelPolicyViewValue) {
  const roles = view.effective.roles;
  const first = (role: keyof typeof roles) => roles[role]?.models[0] ?? null;
  const voice = first("voice_input");
  return {
    revision: view.workspace.revision,
    modelId: first("chat"),
    voiceModelId: voice,
    voiceMode: voice
      ? "catalog"
      : view.effective.options.serverVoice
        ? "legacy"
        : "disabled",
    meetingTranscriptionModelId: first("meeting_transcription"),
    speech: {
      modelId: first("speech"),
      method: "reader" as "reader" | "speech",
      voice: view.effective.options.speech.voice ?? "alloy",
      zeroDataRetention: view.effective.options.speech.zeroDataRetention,
    },
    decision: {
      enabled: !!first("selector"),
      modelId: first("selector"),
      minConfidence: view.effective.options.selector.minConfidence,
    },
    services: view.workspace.policy.services.map((service) => ({
      serviceId: service.serviceId,
      modelId: service.route.models[0] ?? null,
    })),
  };
}
