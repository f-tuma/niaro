import type {
  ProcessDefinition,
  ProcessStep,
} from "../../packages/protocol/service-processes";

/** Native compiler and metadata projections share these exact agent/tool identities. */
export const PROCESS_ROOT_AGENT_NODE_ID = "agent";
export const processAgentToolName = (index: number) =>
  `action_process_${index}`;
export function processAgentNodes(
  definition: ProcessDefinition,
): Pick<
  Extract<ProcessStep, { type: "agent" }>,
  "id" | "modelId" | "capabilities" | "humanInput"
>[] {
  return definition.kind === "agent"
    ? [
        {
          id: PROCESS_ROOT_AGENT_NODE_ID,
          modelId: definition.modelId,
          capabilities: definition.capabilities,
          ...(definition.humanInput === "text"
            ? { humanInput: definition.humanInput }
            : {}),
        },
      ]
    : definition.steps.filter((step) => step.type === "agent");
}
