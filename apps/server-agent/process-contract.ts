import type { ProcessDefinition } from "../../packages/protocol/service-processes";

export const PROCESS_COMPILER_VERSION = "niaro-native-workflow/1";
export function processCompilerVersion(definition: ProcessDefinition) {
  if (
    definition.kind === "agent"
      ? definition.humanInput === "text"
      : definition.steps.some(
          (s) => s.type === "agent" && s.humanInput === "text",
        )
  )
    return "niaro-native-workflow/3";
  return definition.kind === "agent" ||
    definition.steps.some((s) => s.type === "agent")
    ? "niaro-native-workflow/2"
    : PROCESS_COMPILER_VERSION;
}
