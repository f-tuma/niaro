/**
 * Niaro's agent core on Pi Durable (NIAR-302 onward). Waves 2 and 3 move
 * processes and chat onto it; see openspec/changes/niar-302-agent-core-on-pi
 * and docs/architecture for the decisions.
 */
export {
  ctx,
  PiAgentCore,
  RECOVERY_POLICY_A,
  type PiAgentCoreOptions,
  type ScopedModelCall,
  type ScopedModelHost,
} from "./core";
export {
  BASE_ROUTES,
  failureText,
  NIARO_PI_PROVIDER,
  niaroPiProvider,
  retryableFailure,
  type NiaroPiProvider,
  type PiCallPlan,
  type PiModelCall,
  type PiModelHost,
} from "./provider";
export {
  bindingExtension,
  CallBindings,
  ScopeDoc,
  type CallBinding,
  type NiaroScope,
} from "./scope";
export {
  idempotencyKey,
  idempotentWriteTool,
  interruptibleWriteTool,
} from "./tools";
export { NIARO_PI_API, requestBody, assistantMessage } from "./openai-wire";
export {
  processEngineExtension,
  processWorkflowId,
  ProcessRunDoc,
  type NativeWorkflowInput,
  type NativeWorkflowResult,
} from "./process-engine";
export {
  createPiAgentRuntime,
  NATIVE_MODEL,
  NATIVE_PROVIDER,
  NativeAgentHost,
  NativeConversationDoc,
  NativeThreadDoc,
  projectHistory,
  projectMessages,
  type PiAgentRuntime,
} from "./native-agent";
