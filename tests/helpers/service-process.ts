import {
  ProcessDefinitionSchema,
  type ProcessDefinition,
  type ProcessData,
} from "../../packages/protocol/service-processes";
import { DEFAULT_PROCESS_LIMITS } from "../../apps/server-identity/process-validation";

export function processObject(
  properties: Record<string, ProcessData> = {},
  required = Object.keys(properties),
): Extract<ProcessData, { type: "object" }> {
  return { type: "object", properties, required, additionalProperties: false };
}
/** Synthetic definition only; does not dispatch a model or service. */
export function processWorkflow(
  serviceId: string,
  actionId: string,
): ProcessDefinition {
  return ProcessDefinitionSchema.parse({
    schemaVersion: 1,
    kind: "workflow",
    name: "TEST lookup",
    description: "Offline fixture",
    trigger: "manual",
    inputSchema: processObject({ name: { type: "string" } }),
    outputSchema: processObject({ result: { type: "string" } }),
    limits: { ...DEFAULT_PROCESS_LIMITS, maxModelCalls: 0 },
    entry: "lookup",
    steps: [
      {
        id: "lookup",
        type: "action",
        serviceId,
        actionId,
        input: { name: { source: "input", path: ["name"] } },
        outputSchema: processObject({ value: { type: "string" } }),
        next: "done",
      },
      {
        id: "done",
        type: "return",
        output: {
          result: { source: "step", stepId: "lookup", path: ["value"] },
        },
      },
    ],
  });
}
