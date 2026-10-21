import { ProcessDefinitionSchema } from "../../packages/protocol/service-processes";
import { DEFAULT_PROCESS_LIMITS } from "../../apps/server-identity/process-validation";
import { processObject } from "./service-process";
import type { fixture } from "./service-process-runtime";

/** Synthetic catalog and model only; no real service, model, or activation. */
export function processAgent(
  h: ReturnType<typeof fixture>,
  memory: "none" | "conversation" | "saved" = "none",
) {
  return ProcessDefinitionSchema.parse({
    schemaVersion: 1,
    kind: "agent",
    name: "TEST custom agent",
    description: "Offline fixture",
    trigger: "manual",
    inputSchema: processObject({ name: { type: "string" } }),
    outputSchema: processObject({ result: { type: "string" } }),
    limits: DEFAULT_PROCESS_LIMITS,
    modelId: h.model(),
    instructions: "TEST return a typed JSON result using the assigned tools.",
    memory,
    capabilities: [
      { serviceId: h.ids.serviceId, actionId: h.ids.writeId },
      { serviceId: h.ids.serviceId, actionId: h.ids.readId },
    ],
  });
}

export const callProcessTool = (index = 0) => ({
  content: null,
  tool_calls: [
    {
      id: "TEST-provider-call",
      type: "function",
      function: {
        name: `action_process_${index}`,
        arguments: '{"name":"TEST-input"}',
      },
    },
  ],
});
