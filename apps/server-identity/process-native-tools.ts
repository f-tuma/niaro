import {
  PROCESS_NATIVE_TEST_PROFILE,
  NativeTestToolsSchema,
} from "../../packages/protocol/process-native-testing";
import type { ProcessVersion } from "../../packages/protocol/service-processes";
import type { ProcessTestCatalog } from "./process-test-catalog";
import {
  processAgentNodes,
  processAgentToolName,
} from "../server-agent/process-agent-tools";
import { mastraActionToolName, nativeBuiltinToolNames } from "./mastra-domain";
import { memoryToolNames } from "./memory-runtime";

/** The scripted comparison uses domain builtins, read-only memory and no optional plugins. */
export const nativeScriptedInitialToolNames = () => [
  ...nativeBuiltinToolNames(),
  ...memoryToolNames(),
];
export function processNativeTools(
  artifact: ProcessVersion,
  catalog: ProcessTestCatalog,
  genericModelId: string,
) {
  return NativeTestToolsSchema.parse({
    profile: PROCESS_NATIVE_TEST_PROFILE,
    organizationId: catalog.organizationId,
    workspaceId: catalog.workspaceId,
    processId: artifact.processId,
    version: artifact.version,
    artifactDigest: artifact.digest,
    genericModelId,
    configured: processAgentNodes(artifact.definition).map((node) => ({
      nodeId: node.id,
      modelId: node.modelId,
      tools: [
        ...node.capabilities.map((capability, index) => ({
          ...capability,
          name: processAgentToolName(index),
        })),
        ...(node.humanInput === "text" ? [{ name: "ask_user" }] : []),
      ],
    })),
    generic: [
      ...nativeScriptedInitialToolNames().map((name) => ({ name })),
      ...catalog.services.flatMap((service) =>
        service.actions.map((action) => ({
          name: mastraActionToolName(action.id),
          serviceId: service.id,
          actionId: action.id,
        })),
      ),
    ],
  });
}
