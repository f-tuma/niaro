import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  ProcessQuestionSchema,
  type ProcessQuestion,
} from "../../packages/protocol/process-questions";
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { Agent } from "@mastra/core/agent";
import {
  createDurableAgent,
  DurableStepIds,
  type DurableAgent,
} from "@mastra/core/agent/durable";
import { Mastra } from "@mastra/core/mastra";
import { createTool, isValidationError } from "@mastra/core/tools";
import type {
  MessageList,
  MastraDBMessage,
} from "@mastra/core/agent/message-list";
import type {
  Processor,
  ProcessInputStepResult,
} from "@mastra/core/processors";
import type { ChunkType } from "@mastra/core/stream";
import { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import { jsonSchema, type JSONSchema7 } from "ai";
import type {
  LanguageModelV4,
  LanguageModelV4ToolCall,
  LanguageModelV4StreamPart,
} from "./model-types.ts";
import type { ActionFailure } from "../../packages/protocol/action-failure";
import type { ServiceAnswer } from "../server-identity/catalog-runtime";
import type { NiaroModelSelection } from "../server-integrations/mastra-model";
import type { DispatchGuard } from "../server-integrations/transport";
import {
  inspectNativeAgentCheckpoint,
  proveNativeAgentQuestionCheckpoint,
  inspectNativeAgentQuestionRecovery,
  proveNativeAgentQuestionRecovery,
  captureNativeQuestionContinuation,
  retainNativeQuestionContinuation,
  reconcileNativeQuestionRecoverySuspension,
  type NativeQuestionContinuation,
  NativeQuestionAnswerSchema,
  persistNativeAgentCheckpoint,
  recoverNativeAgentRun,
  persistNativeAgentRetirement,
  proveNativeAgentRetirement,
} from "./recovery";
import {
  executeNativeWorkflow,
  proveNativeWorkflowRetirement,
  type NativeWorkflowInput,
} from "./process-runtime";
export { createNativeSavedMemory } from "./saved-memory";
export type {
  NativeWorkflowInput,
  NativeWorkflowResult,
} from "./process-runtime";
export {
  assertWorkflowSupported,
  assertProcessCompilerSupported,
  processValueSchema,
  ProcessAnyResumeSchema,
  ProcessQuestionSchema,
  ProcessQuestionResumeSchema,
  PROCESS_COMPILER_VERSION,
  processCompilerVersion,
} from "./process-workflow";
export {
  proveProcessWorkflowCheckpoint,
  sameProcessCheckpointValue,
} from "./process-checkpoint";
export type { ProcessWorkflowCheckpoint } from "./process-checkpoint";
export type {
  ProcessAnyResume,
  ProcessBoundaryResult,
  ProcessQuestion,
  ProcessQuestionResume,
} from "./process-workflow";

export const NATIVE_AGENT_MAX_STEPS = 12;

const NATIVE_RESERVED_TOOL_INPUT_KEYS = [
  "resumeData",
  "_background",
  "suspendedToolRunId",
  "suspendedToolCallId",
] as const;
const NATIVE_BUSINESS_INPUT_FIELD = "niaroBusinessInput";
const NATIVE_BUSINESS_INPUT_DEFINITION = "niaroBusinessInputSchema";
const NATIVE_TOOL_INPUT_MAX_CHARS = 65536;
const NATIVE_WRAPPED_TOOL_INPUT_MAX_CHARS = NATIVE_TOOL_INPUT_MAX_CHARS + 128;

function schemaDeclaresReservedToolInput(schema: unknown) {
  const root = schema;
  const visited = new Set<object>();
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== "object" || visited.has(value)) return false;
    visited.add(value);
    const node = value as Record<string, unknown>;
    const properties = node.properties;
    if (
      properties &&
      typeof properties === "object" &&
      NATIVE_RESERVED_TOOL_INPUT_KEYS.some((key) =>
        Object.hasOwn(properties, key),
      )
    )
      return true;
    if (
      Array.isArray(node.required) &&
      node.required.some((key) =>
        NATIVE_RESERVED_TOOL_INPUT_KEYS.includes(String(key) as never),
      )
    )
      return true;
    if (typeof node.$ref === "string" && node.$ref.startsWith("#")) {
      let pointer: string;
      try {
        pointer = decodeURIComponent(node.$ref.slice(1));
      } catch {
        pointer = "";
      }
      let target: unknown = root;
      for (const segment of pointer
        .replace(/^\//, "")
        .split("/")
        .filter(Boolean)
        .map((item) => item.replace(/~1/g, "/").replace(/~0/g, "~")))
        target =
          target && typeof target === "object"
            ? (target as Record<string, unknown>)[segment]
            : undefined;
      if (visit(target)) return true;
    }
    return ["allOf", "anyOf", "oneOf"].some(
      (key) => Array.isArray(node[key]) && (node[key] as unknown[]).some(visit),
    );
  };
  return visit(schema);
}

function nativeBusinessInputSchema(parameters: JSONSchema7): JSONSchema7 {
  const rewriteLocalReferences = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewriteLocalReferences);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        if (
          (key === "$ref" ||
            key === "$dynamicRef" ||
            key === "$recursiveRef") &&
          typeof child === "string" &&
          (child === "#" || child.startsWith("#/"))
        ) {
          const path = child.slice(1);
          return [
            key,
            `#/$defs/${NATIVE_BUSINESS_INPUT_DEFINITION}${path ? `${path.startsWith("/") ? "" : "/"}${path}` : ""}`,
          ];
        }
        return [key, rewriteLocalReferences(child)];
      }),
    );
  };
  const businessSchema = rewriteLocalReferences(parameters) as JSONSchema7;
  const businessId = businessSchema.$id;
  delete businessSchema.$id;
  return {
    ...(parameters.$schema ? { $schema: parameters.$schema } : {}),
    ...(businessId ? { $id: businessId } : {}),
    $defs: { [NATIVE_BUSINESS_INPUT_DEFINITION]: businessSchema },
    type: "object",
    properties: {
      [NATIVE_BUSINESS_INPUT_FIELD]: {
        $ref: `#/$defs/${NATIVE_BUSINESS_INPUT_DEFINITION}`,
      },
    },
    required: [NATIVE_BUSINESS_INPUT_FIELD],
    additionalProperties: false,
  };
}

function unwrapNativeBusinessInput(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, NATIVE_BUSINESS_INPUT_FIELD)
  )
    return undefined;
  return (value as Record<string, unknown>)[NATIVE_BUSINESS_INPUT_FIELD];
}

export type NativeAgentEvent =
  | { type: "model-start" | "model-end"; model?: string }
  | { type: "tool-start"; name: string; toolCallId: string; args?: unknown }
  | {
      type: "tool-end";
      name: string;
      toolCallId: string;
      output?: unknown;
      error?: unknown;
      unavailable?: true;
      invalidArguments?: true;
    };
export type NativeAgentSession = {
  activeTools(): string[];
  authorize?(): Promise<void>;
  prepareModel(): Promise<{
    selected: NiaroModelSelection;
    instructions: string;
    /** Explicit domain provenance; unmarked legacy context is treated as private. */
    privateContext?: boolean;
  }>;
  allowance(
    providerId: string,
    revision: number,
    start: () => void,
  ): Promise<void>;
  invoke(
    name: string,
    args: unknown,
    metadata: { toolCallId: string; runId: string },
  ): Promise<unknown>;
  /** Trusted opt-in question consumer; returns the validated canonical answer. */
  consumeQuestionAnswer?(
    metadata: { toolCallId: string; runId: string },
    resumeData: unknown,
  ): Promise<string>;
  finalize(reply: string): Promise<ServiceAnswer | { repair: string }>;
  state: {
    pending?: {
      kind: "approval" | "question";
      toolCallId: string;
      operationId?: string;
      question?: string;
      /** Full trusted proof only for explicitly opted-in saved process agents. */
      questionProof?: ProcessQuestion;
    };
    answer?: unknown;
  };
  save(validate?: boolean): Promise<void>;
};
export type NativeAgentDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Trusted domain compiler; validates without mutating or coercing supplied JSON. */
  validate(
    input: unknown,
  ): { valid: true } | { valid: false; fields: ActionFailure["fields"] };
};
export type NativeAgentInput = {
  runId: string;
  threadId: string;
  resourceId: string;
  /** None disables conversation recall; execution checkpoints remain durable. */
  memoryMode?: "none" | "conversation";
  text?: string;
  resume?: { toolCallId: string; data: unknown };
  signal: AbortSignal;
  definitions: NativeAgentDefinition[];
  session: NativeAgentSession;
  createModel(
    selected: NiaroModelSelection,
    beforeDispatch: DispatchGuard,
  ): LanguageModelV4;
  onEvent?(event: NativeAgentEvent): Promise<void> | void;
};
export type NativeAgentResult = {
  runId: string;
  finishReason: string;
  text: string;
  suspended: boolean;
  answer?: ServiceAnswer;
};

type Owner = {
  storage: LibSQLStore;
  memory: Memory;
  mastra: Mastra;
  ready: Promise<void>;
  references: number;
  active: Map<string, Promise<unknown>>;
  cleanup: Map<string, { dispose(): void; settled: boolean }>;
};
const owners = new Map<string, Owner>();
const agentId = (runId: string) =>
  "niaro-native-" + createHash("sha256").update(runId).digest("hex");
const guardedTool = (name: string) =>
  name.startsWith("action_") ||
  name.startsWith("design_") ||
  name.startsWith("memory_") ||
  name.startsWith("human_task_") ||
  name.startsWith("hub_") ||
  name.startsWith("skill_") ||
  // Meeting notes and transcripts are private like service reads.
  name.startsWith("meeting_") ||
  name === "ask_user";
type NativePrompt = Parameters<
  NonNullable<Processor["processLLMRequest"]>
>[0]["prompt"];

function opaqueTranscriptInputs(
  messages: MastraDBMessage[],
): MastraDBMessage[] {
  return messages.map((message) => {
    const metadata = { ...message.content.metadata };
    for (const key of ["suspendedTools", "pendingToolApprovals"]) {
      const states = metadata[key];
      if (states && typeof states === "object")
        metadata[key] = Object.fromEntries(
          Object.entries(states).map(([id, state]) => [
            id,
            state && typeof state === "object"
              ? {
                  ...state,
                  args: {},
                  ...("parentArgs" in state ? { parentArgs: {} } : {}),
                }
              : state,
          ]),
        );
    }
    return {
      ...message,
      content: {
        ...message.content,
        parts: message.content.parts.map((part) =>
          part.type === "tool-invocation"
            ? {
                ...part,
                toolInvocation: {
                  ...part.toolInvocation,
                  args: {},
                  rawInput: undefined,
                },
              }
            : part,
        ),
        ...(message.content.toolInvocations
          ? {
              toolInvocations: message.content.toolInvocations.map(
                (invocation) => ({
                  ...invocation,
                  args: {},
                  rawInput: undefined,
                }),
              ),
            }
          : {}),
        ...(message.content.metadata ? { metadata } : {}),
      },
    };
  });
}

/** Retain call identity, but never reuse source data from a historical transcript. */
function historicalResult(value: unknown) {
  if (!value || typeof value !== "object") return { toolResult: true };
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.operationId === "string" &&
    /^[a-f0-9]{64}$/.test(record.operationId)
      ? { operationId: record.operationId }
      : {}),
    ...(typeof record.status === "string" &&
    [
      "succeeded",
      "failed",
      "unknown",
      "rejected",
      "awaiting_approval",
    ].includes(record.status)
      ? { status: record.status }
      : {}),
    ...(record.effect === "read" || record.effect === "write"
      ? { effect: record.effect }
      : {}),
    ...(record.observed === true ? { observed: true } : {}),
    toolResult: true,
  };
}

/** On-read projection also covers pre-migration memory rows and restored checkpoint history. */
function projectProviderHistory(
  prompt: NativePrompt,
  messageList?: MessageList,
): NativePrompt {
  const privateSegments = new Set<number>();
  let segment = -1;
  for (const message of messageList?.get.all.db() ?? []) {
    if (message.role === "user") segment++;
    if (message.role !== "assistant") continue;
    const stamp = message.content.metadata?.niaroNativePrivacy;
    if (
      !stamp ||
      typeof stamp !== "object" ||
      !("version" in stamp) ||
      stamp.version !== 1 ||
      !("privateContext" in stamp) ||
      stamp.privateContext !== false ||
      message.content.parts.some(
        (part) =>
          part.type === "tool-invocation" &&
          guardedTool(part.toolInvocation.toolName),
      )
    )
      privateSegments.add(segment);
  }
  segment = -1;
  const segments = prompt.map((message) => {
    if (message.role === "user") segment++;
    return segment;
  });
  const latestSegment = segment;
  for (const [index, message] of prompt.entries()) {
    if (
      message.role === "assistant" &&
      message.content.some(
        (part) => part.type === "tool-call" && guardedTool(part.toolName),
      )
    )
      privateSegments.add(segments[index]!);
  }
  return prompt.map((message, index) => {
    const historicalPrivate =
      segments[index]! < latestSegment &&
      (!messageList || privateSegments.has(segments[index]!));
    if (message.role === "assistant")
      return {
        ...message,
        content: message.content.map((part) => {
          if (part.type === "tool-call") return { ...part, input: {} };
          if (
            historicalPrivate &&
            (part.type === "text" || part.type === "reasoning")
          )
            return { ...part, text: "[Prior private response withheld]" };
          return part;
        }),
      };
    if (message.role === "tool" && historicalPrivate)
      return {
        ...message,
        content: message.content.map((part) => ({
          ...part,
          output: {
            type: "json" as const,
            value: historicalResult(
              part.output.type === "json" ? part.output.value : undefined,
            ),
          },
        })),
      };
    return message;
  });
}
function newOwner(storageUrl: string): Owner {
  const storage = new LibSQLStore({
    id: "niaro-native-store",
    url: storageUrl,
  });
  const memory = new Memory({
    storage,
    options: {
      lastMessages: 40,
      semanticRecall: false,
      generateTitle: false,
      workingMemory: { enabled: false },
      observationalMemory: false,
    },
  });
  const mastra = new Mastra({ storage, logger: false });
  const ready = storage.init().then(() => {
    if (storageUrl.startsWith("file:"))
      chmodSync(fileURLToPath(storageUrl), 0o600);
  });
  return {
    storage,
    memory,
    mastra,
    ready,
    references: 0,
    active: new Map(),
    cleanup: new Map(),
  };
}

function validatePendingQuestion(
  input: NativeAgentInput,
  toolName: string,
  toolCallId: string,
  supplied: unknown,
) {
  const pending = input.session.state.pending;
  if (!pending || !Object.hasOwn(pending, "questionProof")) return undefined;
  const question = ProcessQuestionSchema.parse(pending.questionProof);
  if (
    pending.kind !== "question" ||
    toolName !== "ask_user" ||
    pending.operationId !== undefined ||
    pending.toolCallId !== toolCallId ||
    question.toolCallId !== toolCallId ||
    question.childRunId !== input.runId ||
    question.childThreadId !== input.threadId ||
    question.resourceId !== input.resourceId ||
    pending.question !== question.question ||
    !supplied ||
    typeof supplied !== "object" ||
    !("question" in supplied) ||
    supplied.question !== question.question ||
    question.questionDigest !==
      createHash("sha256")
        .update(JSON.stringify(question.question))
        .digest("hex")
  )
    throw new Error("niaro_native_question_proof_invalid");
  return question;
}

/** Public snapshot reads bound the final persistence tail without driving the agent. */
async function settledSnapshot(
  owner: Owner,
  agent: DurableAgent,
  input: NativeAgentInput,
  suspended: boolean,
  observed: () => boolean,
) {
  const workflows = await owner.storage.getStore("workflows");
  if (!workflows) throw new Error("niaro_native_storage_required");
  const deadline = Date.now() + 5000;
  let checkpointSeen = observed();
  do {
    if (suspended) {
      const pending = input.session.state.pending;
      if (pending?.questionProof) {
        const binding = {
          agentId: agent.id,
          runId: input.runId,
          threadId: input.threadId,
          resourceId: input.resourceId,
          toolCallId: pending.toolCallId,
        };
        const checkpoint = await inspectNativeAgentCheckpoint(
          owner.storage,
          binding,
        );
        if (
          proveNativeAgentQuestionCheckpoint(
            checkpoint,
            binding,
            pending.questionProof,
          )
        )
          return true;
      } else {
        const discovery = await agent.listSuspendedRuns({
          threadId: input.threadId,
          resourceId: input.resourceId,
        });
        if (
          pending &&
          discovery.runs.some(
            (run) =>
              run.runId === input.runId &&
              run.toolCalls.some(
                (tool) => tool.toolCallId === pending.toolCallId,
              ),
          )
        )
          return true;
      }
    } else {
      const rows = await Promise.all([
        workflows.getWorkflowRunById({
          workflowName: DurableStepIds.AGENTIC_LOOP,
          runId: input.runId,
        }),
        workflows.getWorkflowRunById({
          workflowName: DurableStepIds.AGENTIC_EXECUTION,
          runId: input.runId,
        }),
      ]);
      checkpointSeen ||= rows.some((row) => !!row) || observed();
      if (checkpointSeen && rows.every((row) => !row)) return true;
    }
    await wait(20);
  } while (Date.now() < deadline);
  return false;
}

/** Domain receipts remain authoritative; this package owns only native execution and memory. */
export function createNativeAgentRuntime(storageUrl: string) {
  const share = storageUrl.startsWith("file:");
  const owner = share
    ? (owners.get(storageUrl) ?? newOwner(storageUrl))
    : newOwner(storageUrl);
  if (share) owners.set(storageUrl, owner);
  owner.references++;
  let closed = false;
  // A rejected output promise is not evidence that a durable workflow stopped.
  // Retain this proof across calls, including the persistence/cleanup tail.
  const settlement = new Map<string, boolean>();
  const ready = async () => {
    if (closed) throw new Error("niaro_native_runtime_closed");
    await owner.ready;
  };

  async function run(input: NativeAgentInput): Promise<NativeAgentResult> {
    await ready();
    input.signal.throwIfAborted();
    if (
      !input.runId ||
      !input.threadId ||
      !input.resourceId ||
      (!input.resume && input.text === undefined)
    )
      throw new Error("niaro_native_input_invalid");
    const { session } = input;
    const id = agentId(input.runId);
    const previous = owner.cleanup.get(input.runId);
    if (previous && !previous.settled)
      throw new Error("niaro_native_checkpoint_settlement_timeout");
    previous?.dispose();
    owner.cleanup.delete(input.runId);
    owner.mastra.removeWorkflow(`${id}-input-processor`);
    owner.mastra.removeWorkflow(`${id}-output-processor`);
    let fatal: Error | undefined;
    let finalized: ServiceAnswer | undefined;
    let checkpointObserved = false;
    const observeCheckpoint = async () => {
      if (checkpointObserved) return;
      const workflows = await owner.storage.getStore("workflows");
      const row = await workflows?.getWorkflowRunById({
        workflowName: DurableStepIds.AGENTIC_LOOP,
        runId: input.runId,
      });
      checkpointObserved = !!row;
      if (checkpointObserved)
        await persistNativeAgentRetirement(owner.storage, {
          version: 1,
          agentId: id,
          runId: input.runId,
          threadId: input.threadId,
          resourceId: input.resourceId,
          checkpointSeen: true,
          retired: false,
        });
    };
    let firstStep = true;
    const initial = await session.prepareModel();
    let privateContext = initial.privateContext !== false;
    // Rejections may be falsy; retain the first Error without arbitrary payloads.
    const fail = (error: unknown) => {
      const rejection =
        error instanceof Error
          ? error
          : new Error("niaro_native_execution_rejected");
      fatal ??= rejection;
      return fatal;
    };
    // Mastra strips reserved input keys, spreads arrays into objects and rejects
    // null before tool.execute. Retain the supplied JSON before those adaptations.
    const suppliedInputs = new Map<string, { name: string; input: unknown }>();
    const suppliedCallIds = new Set<string>();
    const definitionsByName = new Map(
      input.definitions.map((tool) => [tool.name, tool]),
    );
    let unavailableToolName = "niaro_unavailable_tool";
    while (definitionsByName.has(unavailableToolName))
      unavailableToolName += "_";
    const reservedInputKeys = NATIVE_RESERVED_TOOL_INPUT_KEYS;
    const envelopedToolInputs = new Set(
      input.definitions
        .filter((definition) =>
          schemaDeclaresReservedToolInput(definition.parameters),
        )
        .map((definition) => definition.name),
    );
    const lossyInput = (value: unknown) =>
      value && typeof value === "object"
        ? reservedInputKeys.find((key) => Object.hasOwn(value, key))
        : undefined;
    const invalidCarrierKey = (toolCallId: string) =>
      "__niaro_invalid_" +
      createHash("sha256")
        .update(JSON.stringify([input.runId, toolCallId]))
        .digest("hex");
    const isInvalidCarrier = (value: unknown, toolCallId: string) =>
      !!value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 1 &&
      Object.hasOwn(value, invalidCarrierKey(toolCallId)) &&
      ((value as Record<string, unknown>)[invalidCarrierKey(toolCallId)] ===
        true ||
        reservedInputKeys.includes(
          String(
            (value as Record<string, unknown>)[invalidCarrierKey(toolCallId)],
          ) as (typeof reservedInputKeys)[number],
        ));
    const captureToolCall = (call: LanguageModelV4ToolCall) => {
      if (suppliedCallIds.has(call.toolCallId) || suppliedCallIds.size >= 64)
        throw new Error("niaro_native_tool_call_identity_invalid");
      suppliedCallIds.add(call.toolCallId);
      let original: unknown;
      try {
        const maxChars = envelopedToolInputs.has(call.toolName)
          ? NATIVE_WRAPPED_TOOL_INPUT_MAX_CHARS
          : NATIVE_TOOL_INPUT_MAX_CHARS;
        original =
          call.input.length <= maxChars ? JSON.parse(call.input) : undefined;
      } catch {
        throw new Error("niaro_native_tool_input_json_invalid");
      }
      const definition = definitionsByName.get(call.toolName);
      suppliedInputs.set(call.toolCallId, {
        name: definition ? call.toolName : unavailableToolName,
        input: original,
      });
      const enveloped =
        !!definition && envelopedToolInputs.has(definition.name);
      const businessInput = enveloped
        ? unwrapNativeBusinessInput(original)
        : original;
      const validation = definition?.validate(businessInput);
      let businessInputWithinLimit = true;
      if (enveloped && businessInput !== undefined) {
        try {
          businessInputWithinLimit =
            JSON.stringify(businessInput).length <= NATIVE_TOOL_INPUT_MAX_CHARS;
        } catch {
          businessInputWithinLimit = false;
        }
      }
      const invalid =
        !definition ||
        !session.activeTools().includes(call.toolName) ||
        !businessInputWithinLimit ||
        (enveloped
          ? businessInput === undefined
          : lossyInput(original) ||
            !original ||
            typeof original !== "object" ||
            Array.isArray(original)) ||
        validation?.valid === false;
      // A durable rejection marker survives a crash before execute without
      // storing malformed inputs or accepting cleaned empty arguments on replay.
      const safeCall = definition
        ? call
        : { ...call, toolName: unavailableToolName };
      return invalid
        ? {
            ...safeCall,
            input: JSON.stringify({
              [invalidCarrierKey(call.toolCallId)]:
                lossyInput(original) ?? true,
            }),
          }
        : safeCall;
    };
    const model = (selected: NiaroModelSelection): LanguageModelV4 => {
      const native = input.createModel(selected, (start) =>
        session.allowance(
          selected.provider.id,
          selected.provider.revision,
          start,
        ),
      );
      const invoke = async <T>(operation: () => PromiseLike<T>) => {
        if (fatal) throw fatal;
        try {
          input.signal.throwIfAborted();
          await observeCheckpoint();
          await input.onEvent?.({
            type: "model-start",
            model: selected.model.model,
          });
          const output = await operation();
          input.signal.throwIfAborted();
          await input.onEvent?.({ type: "model-end" });
          return output;
        } catch (error) {
          throw fail(error);
        }
      };
      const signal = (sdkSignal?: AbortSignal) =>
        sdkSignal ? AbortSignal.any([input.signal, sdkSignal]) : input.signal;
      return {
        specificationVersion: native.specificationVersion,
        provider: native.provider,
        modelId: native.modelId,
        supportedUrls: native.supportedUrls,
        doGenerate: (options) =>
          invoke(async () => {
            const result = await native.doGenerate({
              ...options,
              abortSignal: signal(options.abortSignal),
            });
            return {
              ...result,
              content: result.content.map((part) =>
                part.type === "tool-call" ? captureToolCall(part) : part,
              ),
            };
          }),
        doStream: (options) =>
          invoke(async () => {
            const result = await native.doStream({
              ...options,
              abortSignal: signal(options.abortSignal),
            });
            return {
              ...result,
              stream: result.stream.pipeThrough(
                new TransformStream<
                  LanguageModelV4StreamPart,
                  LanguageModelV4StreamPart
                >({
                  transform(part, controller) {
                    controller.enqueue(
                      part.type === "tool-call" ? captureToolCall(part) : part,
                    );
                  },
                }),
              ),
            };
          }),
      };
    };
    let resumedQuestion: ProcessQuestion | undefined;
    let questionContinuation: NativeQuestionContinuation | undefined;
    const tools = Object.fromEntries(
      input.definitions.map((definition) => [
        definition.name,
        createTool({
          id: definition.name,
          description: envelopedToolInputs.has(definition.name)
            ? `${definition.description} Put the complete business argument object inside the required niaroBusinessInput property.`
            : definition.description,
          // Provider compatibility must not turn optional service fields
          // into required nullable fields. The domain validates the original
          // schema and supplied JSON before any invocation or effect.
          strict: false,
          inputSchema: jsonSchema<Record<string, unknown>>(
            envelopedToolInputs.has(definition.name)
              ? nativeBusinessInputSchema(definition.parameters as JSONSchema7)
              : (definition.parameters as JSONSchema7),
          ),
          onInputAvailable: ({ toolCallId, input: args }) => {
            // Restored durable calls do not pass through the current model wrapper.
            if (!suppliedInputs.has(toolCallId))
              suppliedInputs.set(toolCallId, {
                name: definition.name,
                input: args,
              });
          },
          transform: {
            transcript: {
              // This changes only transcript payloads, never the executable call input.
              input: () => ({}),
              inputDelta: () => "",
              output: ({ output }) => {
                if (
                  output &&
                  typeof output === "object" &&
                  "error" in output &&
                  output.error === "invalid_arguments"
                )
                  return output;
                if (definition.name.startsWith("memory_"))
                  return { toolResult: true };
                if (definition.name === "ask_user") {
                  if (
                    output &&
                    typeof output === "object" &&
                    "answered" in output &&
                    output.answered === true
                  )
                    return {
                      answered: true,
                      ...("answer" in output &&
                      typeof output.answer === "string"
                        ? { answer: output.answer }
                        : {}),
                    };
                  return { asked: true };
                }
                // Service actions already return opaque domain receipt envelopes.
                return output;
              },
              error: () => ({ error: "tool_failed" }),
              approval: () => ({}),
              suspend: ({ suspendPayload }) => suspendPayload ?? {},
              resume: () => ({}),
            },
          },
          execute: async (args, context) => {
            const toolCallId = context.agent?.toolCallId;
            if (!context.agent || !toolCallId)
              throw fail(new Error("niaro_native_tool_context_required"));
            if (fatal) throw fatal;
            let consumingQuestionAnswer = false;
            try {
              input.signal.throwIfAborted();
              await observeCheckpoint();
              const captured = suppliedInputs.get(toolCallId);
              if (captured && captured.name !== definition.name)
                throw new Error("niaro_native_tool_call_identity_invalid");
              const encodedInput = captured ? captured.input : args;
              suppliedInputs.delete(toolCallId);
              const carrier = isInvalidCarrier(encodedInput, toolCallId);
              const enveloped = envelopedToolInputs.has(definition.name);
              const supplied =
                enveloped && !carrier
                  ? unwrapNativeBusinessInput(encodedInput)
                  : encodedInput;
              const reserved =
                (enveloped
                  ? unwrapNativeBusinessInput(encodedInput) === undefined
                    ? lossyInput(encodedInput)
                    : undefined
                  : lossyInput(supplied)) ??
                (carrier
                  ? reservedInputKeys.find(
                      (key) =>
                        (encodedInput as Record<string, unknown>)[
                          invalidCarrierKey(toolCallId)
                        ] === key,
                    )
                  : undefined);
              const validation = reserved
                ? {
                    valid: false as const,
                    fields: [
                      {
                        path: "/" + reserved,
                        issue:
                          "This argument field is reserved for native execution.",
                      },
                    ],
                  }
                : carrier
                  ? {
                      valid: false as const,
                      fields: [
                        {
                          path: "/",
                          issue:
                            "Arguments do not match the supported input schema.",
                        },
                      ],
                    }
                  : definition.validate(supplied);
              if (!validation.valid) {
                const declaredReserved =
                  reserved &&
                  ((definition.parameters.properties &&
                    typeof definition.parameters.properties === "object" &&
                    Object.hasOwn(
                      definition.parameters.properties,
                      reserved,
                    )) ||
                    (Array.isArray(definition.parameters.required) &&
                      definition.parameters.required.includes(reserved)));
                const failure: ActionFailure = {
                  code: "invalid_arguments",
                  kind: "validation",
                  stage: "validation",
                  retry: declaredReserved ? "none" : "correct_input",
                  ...(declaredReserved
                    ? {
                        message:
                          "This tool declares an argument field reserved by native execution. Ask an administrator to update the action schema; do not repeat this call.",
                      }
                    : {}),
                  fields: validation.fields,
                };
                const output = { error: "invalid_arguments", failure };
                await input.onEvent?.({
                  type: "tool-start",
                  name: definition.name,
                  toolCallId,
                });
                await input.onEvent?.({
                  type: "tool-end",
                  name: definition.name,
                  toolCallId,
                  invalidArguments: true,
                  output,
                });
                return output;
              }
              await input.onEvent?.({
                type: "tool-start",
                name: definition.name,
                toolCallId,
                args: supplied,
              });
              const resume = input.resume;
              const data = context.agent.resumeData;
              if (
                definition.name === "ask_user" &&
                resume?.toolCallId === toolCallId &&
                data &&
                typeof data === "object" &&
                "answer" in data &&
                typeof data.answer === "string"
              ) {
                let answer = data.answer;
                if (
                  resumedQuestion &&
                  (!session.consumeQuestionAnswer ||
                    !supplied ||
                    typeof supplied !== "object" ||
                    !("question" in supplied) ||
                    supplied.question !== resumedQuestion.question)
                )
                  throw new Error("niaro_native_question_proof_invalid");
                if (session.consumeQuestionAnswer) {
                  consumingQuestionAnswer = true;
                  if (resumedQuestion)
                    await retainNativeQuestionContinuation(
                      owner.storage,
                      {
                        agentId: id,
                        runId: input.runId,
                        threadId: input.threadId,
                        resourceId: input.resourceId,
                        toolCallId,
                      },
                      resumedQuestion,
                      data,
                      questionContinuation,
                    );
                  answer = await session.consumeQuestionAnswer(
                    { toolCallId, runId: input.runId },
                    data,
                  );
                  if (
                    typeof answer !== "string" ||
                    (resumedQuestion &&
                      (answer.length > 4000 || answer.trim().length === 0))
                  )
                    throw new Error("niaro_native_question_answer_invalid");
                  consumingQuestionAnswer = false;
                }
                const output = { answered: true, answer };
                await input.onEvent?.({
                  type: "tool-end",
                  name: definition.name,
                  toolCallId,
                  output,
                });
                return output;
              }
              const output = await session.invoke(definition.name, supplied, {
                toolCallId,
                runId: input.runId,
              });
              const questionProof = validatePendingQuestion(
                input,
                definition.name,
                toolCallId,
                supplied,
              );
              await input.onEvent?.({
                type: "tool-end",
                name: definition.name,
                toolCallId,
                output,
              });
              const pending = session.state.pending;
              if (pending) {
                if (pending.toolCallId !== toolCallId)
                  throw new Error("niaro_native_pending_tool_mismatch");
                await session.save(false);
                await context.agent.suspend({
                  kind: pending.kind,
                  toolCallId,
                  ...(questionProof
                    ? { toolName: "ask_user", questionProof }
                    : {}),
                  ...(pending.operationId
                    ? { operationId: pending.operationId }
                    : {}),
                });
                return;
              }
              return output;
            } catch (error) {
              const rejection = fail(
                consumingQuestionAnswer && !(error instanceof Error)
                  ? new Error("niaro_native_question_answer_rejected")
                  : error,
              );
              // Rejected trusted consumption has no completed tool boundary to publish.
              if (!consumingQuestionAnswer) {
                try {
                  await input.onEvent?.({
                    type: "tool-end",
                    name: definition.name,
                    toolCallId,
                    error: rejection,
                  });
                } catch (error) {
                  throw fail(error);
                }
              }
              throw rejection;
            }
          },
        }),
      ]),
    );
    const authority = {
      id: "niaro-step-authority",
      async processInputStep({ messages }) {
        try {
          if (fatal) throw fatal;
          input.signal.throwIfAborted();
          // On resume the suspended tool executes before the first model step.
          // Its receipt must be projected again instead of reusing pre-resume context.
          const prepared =
            firstStep && !input.resume ? initial : await session.prepareModel();
          firstStep = false;
          privateContext ||= prepared.privateContext !== false;
          // 1.74's processor type expects normalized streaming models; the runtime normalizes raw V4 models.
          return {
            model: model(
              prepared.selected,
            ) as unknown as ProcessInputStepResult["model"],
            activeTools: session.activeTools(),
            messages: opaqueTranscriptInputs(messages),
            systemMessages: [
              { role: "system" as const, content: prepared.instructions },
            ],
            modelSettings: { maxRetries: 0 },
          };
        } catch (error) {
          throw fail(error);
        }
      },
      processLLMRequest({ prompt, messageList }) {
        return { prompt: projectProviderHistory(prompt, messageList) };
      },
    } satisfies Processor;
    const verification = {
      id: "niaro-receipt-finalization",
      async processOutputStep({
        messages,
        messageList,
        text,
        toolCalls,
        abort,
      }) {
        if (fatal) throw fatal;
        privateContext ||= !!toolCalls?.some((call) =>
          guardedTool(call.toolName),
        );
        const responseIds = messageList.makeMessageSourceChecker().output;
        // Normalize the live transcript too: durable serialization uses MessageList directly.
        // The native tool execution payload is a separate object and retains original args.
        const transcript = opaqueTranscriptInputs(
          messageList.transformMessagesForTranscript(messages),
        );
        const stamped = transcript.map((message) =>
          message.role === "assistant" && responseIds.has(message.id)
            ? {
                ...message,
                content: {
                  ...message.content,
                  metadata: {
                    ...message.content.metadata,
                    niaroNativePrivacy: { version: 1, privateContext },
                  },
                },
              }
            : message,
        );
        if (session.state.pending || toolCalls?.length) return stamped;
        const answer = await session.finalize(text ?? "").catch((error) => {
          throw fail(error);
        });
        if ("repair" in answer) {
          messageList.clearSystemMessages("niaro-checker-repair");
          messageList.addSystem(
            `[Checker] ${answer.repair.slice(0, 6000)}`,
            "niaro-checker-repair",
          );
          return abort(answer.repair, { retry: true });
        }
        messageList.clearSystemMessages("niaro-checker-repair");
        finalized = answer;
        return stamped;
      },
    } satisfies Processor;
    const wrappedAgent = new Agent({
      id,
      name: "Niaro native agent",
      instructions: initial.instructions,
      model: model(initial.selected),
      ...(input.memoryMode === "none" ? {} : { memory: owner.memory }),
      tools,
      inputProcessors: [authority],
      outputProcessors: [verification],
      errorProcessors: [],
      errorProcessorDefaults: false,
      maxProcessorRetries: 2,
    });
    const agent = createDurableAgent({
      agent: wrappedAgent,
      cache: false,
      maxSteps: NATIVE_AGENT_MAX_STEPS,
      shouldPersistSnapshot: persistNativeAgentCheckpoint,
    });
    owner.mastra.addAgent(agent, id);
    try {
      const options = {
        runId: input.runId,
        memory: { thread: input.threadId, resource: input.resourceId },
        abortSignal: input.signal,
        maxSteps: NATIVE_AGENT_MAX_STEPS,
        toolCallConcurrency: 1,
        eagerToolExecution: false,
        maxProcessorRetries: 2,
        modelSettings: { maxRetries: 0 },
        tracingOptions: { hideInput: true, hideOutput: true },
        onError: ({ error }: { error: Error | string }) => {
          fail(error);
        },
        onChunk: async (chunk: ChunkType) => {
          if (
            chunk.type === "tool-result" &&
            isValidationError(chunk.payload.result)
          ) {
            try {
              const name =
                input.definitions.find(
                  (tool) => tool.name === chunk.payload.toolName,
                )?.name ?? "Unavailable tool";
              await input.onEvent?.({
                type: "tool-start",
                name,
                toolCallId: chunk.payload.toolCallId,
              });
              await input.onEvent?.({
                type: "tool-end",
                name,
                toolCallId: chunk.payload.toolCallId,
                invalidArguments: true,
                error: new Error("niaro_native_tool_input_invalid"),
              });
            } catch (error) {
              throw fail(error);
            }
            return;
          }
          if (chunk.type !== "tool-error") return;
          const error = chunk.payload.error;
          if (
            !error ||
            typeof error !== "object" ||
            !("name" in error) ||
            error.name !== "ToolNotFoundError"
          )
            return;
          try {
            const toolCallId = chunk.payload.toolCallId;
            await input.onEvent?.({
              type: "tool-start",
              name: "Unavailable tool",
              toolCallId,
            });
            await input.onEvent?.({
              type: "tool-end",
              name: "Unavailable tool",
              toolCallId,
              unavailable: true,
              error: new Error("niaro_native_tool_unavailable"),
            });
          } catch (error) {
            throw fail(error);
          }
        },
      };
      const binding = {
        agentId: id,
        runId: input.runId,
        threadId: input.threadId,
        resourceId: input.resourceId,
      };
      const checkpoint = await inspectNativeAgentCheckpoint(
        owner.storage,
        binding,
      );
      let recoveringQuestion = false;
      if (input.resume && checkpoint?.status === "running") {
        resumedQuestion = await inspectNativeAgentQuestionRecovery(
          owner.storage,
          { ...binding, toolCallId: input.resume.toolCallId },
          input.resume.data,
        );
        if (
          !resumedQuestion ||
          !session.consumeQuestionAnswer ||
          (session.state.pending?.questionProof &&
            !isDeepStrictEqual(
              session.state.pending.questionProof,
              resumedQuestion,
            ))
        )
          throw new Error("niaro_native_question_proof_invalid");
        questionContinuation = await captureNativeQuestionContinuation(
          owner.storage,
          { ...binding, toolCallId: input.resume.toolCallId },
          resumedQuestion,
          input.resume.data,
        );
        recoveringQuestion = true;
      }
      if ((!input.resume || recoveringQuestion) && checkpoint) {
        settlement.set(input.runId, false);
        await recoverNativeAgentRun({
          agent,
          storage: owner.storage,
          binding,
          authorize: async () => {
            input.signal.throwIfAborted();
            if (session.authorize) await session.authorize();
            else await session.prepareModel();
          },
          options: { abortSignal: input.signal },
        });
        const nextQuestion = session.state.pending?.questionProof;
        if (questionContinuation && nextQuestion)
          await reconcileNativeQuestionRecoverySuspension(
            owner.storage,
            { ...binding, toolCallId: nextQuestion.toolCallId },
            nextQuestion,
          );
        const settled = await settledSnapshot(
          owner,
          agent,
          input,
          !!session.state.pending,
          () => true,
        );
        settlement.set(input.runId, settled);
        if (!settled)
          throw new Error("niaro_native_checkpoint_settlement_timeout");
        if (fatal) throw fatal;
        if (!session.state.pending && !finalized)
          throw new Error("niaro_native_finalization_failed");
        return {
          runId: input.runId,
          finishReason: session.state.pending ? "suspended" : "stop",
          text: finalized?.reply ?? "",
          suspended: !!session.state.pending,
          ...(finalized ? { answer: finalized } : {}),
        };
      }
      if (input.resume) {
        if (checkpoint && !checkpoint.questionProofsValid)
          throw new Error("niaro_native_question_proof_invalid");
        if (
          checkpoint?.questionSuspensions.length ||
          session.state.pending?.questionProof
        ) {
          resumedQuestion =
            session.state.pending?.questionProof ??
            checkpoint?.questionSuspensions[0]?.questionProof;
          const checked = NativeQuestionAnswerSchema.safeParse(
            input.resume.data,
          );
          if (
            !resumedQuestion ||
            !checked.success ||
            !session.consumeQuestionAnswer ||
            checked.data.questionId !== resumedQuestion.questionId ||
            checked.data.questionRevision !==
              resumedQuestion.questionRevision ||
            !proveNativeAgentQuestionCheckpoint(
              checkpoint,
              { ...binding, toolCallId: input.resume.toolCallId },
              resumedQuestion,
            )
          )
            throw new Error("niaro_native_question_proof_invalid");
          questionContinuation = await captureNativeQuestionContinuation(
            owner.storage,
            { ...binding, toolCallId: input.resume.toolCallId },
            resumedQuestion,
          );
        }
        const pending = await agent.listSuspendedRuns({
          threadId: input.threadId,
          resourceId: input.resourceId,
        });
        const snapshot = pending.runs.find((run) => run.runId === input.runId);
        if (
          !snapshot?.toolCalls.some(
            (tool) => tool.toolCallId === input.resume!.toolCallId,
          )
        )
          throw new Error("niaro_native_pending_run_not_found");
        checkpointObserved = true;
      }
      settlement.set(input.runId, false);
      const execution = input.resume
        ? await agent.resume(input.runId, input.resume.data, {
            ...options,
            closeOnSuspend: true,
            toolCallId: input.resume.toolCallId,
          })
        : await agent.stream(input.text!, { ...options, closeOnSuspend: true });
      const retirement = { dispose: execution.cleanup, settled: false };
      owner.cleanup.set(input.runId, retirement);
      const output = await execution.output.getFullOutput();
      const suspended = output.finishReason === "suspended";
      const settled = await settledSnapshot(
        owner,
        agent,
        input,
        suspended,
        () => checkpointObserved,
      );
      retirement.settled = settled;
      settlement.set(input.runId, settled);
      if (!suspended && settled) {
        execution.cleanup();
        owner.cleanup.delete(input.runId);
      }
      if (!settled)
        throw fatal ?? new Error("niaro_native_checkpoint_settlement_timeout");
      if (fatal) throw fatal;
      if (output.error)
        throw new Error("niaro_native_model_failed", { cause: output.error });
      input.signal.throwIfAborted();
      if (output.finishReason === "error")
        throw new Error("niaro_native_model_failed");
      if (!session.state.pending && !finalized) {
        const code =
          output.steps.length >= 12
            ? "niaro_native_step_budget_exhausted"
            : "niaro_native_finalization_failed";
        throw Object.assign(new Error(code), {
          code,
          nativeDiagnostics: {
            finishReason: String(output.finishReason),
            steps: output.steps.length,
            workflows: Object.keys(owner.mastra.listWorkflows()),
            lastTools: output.steps
              .at(-1)
              ?.toolCalls.map((call) =>
                input.definitions.some(
                  (tool) => tool.name === call.payload.toolName,
                )
                  ? call.payload.toolName
                  : "[unknown]",
              ),
          },
        });
      }
      return {
        runId: input.runId,
        finishReason: String(output.finishReason),
        text: output.text,
        suspended: output.finishReason === "suspended",
        ...(finalized ? { answer: finalized } : {}),
      };
    } catch (error) {
      if (
        settlement.get(input.runId) === false &&
        owner.cleanup.has(input.runId)
      ) {
        // getFullOutput can reject before the durable loop's final checkpoint
        // disappears. Verify its tail passively; a deadline never means success.
        const retired = await settledSnapshot(
          owner,
          agent,
          input,
          false,
          () => checkpointObserved,
        );
        settlement.set(input.runId, retired);
        const cleanup = owner.cleanup.get(input.runId);
        if (cleanup && retired) {
          cleanup.settled = true;
          cleanup.dispose();
          owner.cleanup.delete(input.runId);
        }
      }
      throw fatal ?? error;
    } finally {
      suppliedInputs.clear();
      suppliedCallIds.clear();
      try {
        await owner.memory.settled();
      } catch (error) {
        settlement.set(input.runId, false);
        throw error;
      } finally {
        owner.mastra.removeAgent(id);
        owner.mastra.removeWorkflow(`${id}-input-processor`);
        owner.mastra.removeWorkflow(`${id}-output-processor`);
      }
    }
  }

  return {
    /** Passive proof only; never infer, recover, resume or dispatch. */
    isSettled(runId: string) {
      return (
        !owner.active.has(runId) &&
        settlement.get(runId) !== false &&
        owner.cleanup.get(runId)?.settled !== false
      );
    },
    async proveRetired(binding: {
      runId: string;
      threadId: string;
      resourceId: string;
    }) {
      await ready();
      if (owner.active.has(binding.runId)) return false;
      const proof = Promise.resolve().then(async () => {
        await owner.memory.settled();
        return proveNativeAgentRetirement(owner.storage, {
          ...binding,
          agentId: agentId(binding.runId),
        });
      });
      owner.active.set(binding.runId, proof);
      try {
        const proved = await proof;
        if (proved) {
          settlement.set(binding.runId, true);
          const cleanup = owner.cleanup.get(binding.runId);
          cleanup?.dispose();
          owner.cleanup.delete(binding.runId);
        }
        return proved;
      } finally {
        if (owner.active.get(binding.runId) === proof)
          owner.active.delete(binding.runId);
      }
    },
    async proveSuspended(binding: {
      runId: string;
      threadId: string;
      resourceId: string;
      toolCallId: string;
      question?: ProcessQuestion;
    }) {
      await ready();
      if (Object.hasOwn(binding, "question"))
        settlement.set(binding.runId, false);
      if (owner.active.has(binding.runId)) return false;
      await owner.memory.settled();
      const checkpoint = await inspectNativeAgentCheckpoint(owner.storage, {
        agentId: agentId(binding.runId),
        runId: binding.runId,
        threadId: binding.threadId,
        resourceId: binding.resourceId,
      });
      const proved =
        !owner.active.has(binding.runId) &&
        (Object.hasOwn(binding, "question")
          ? proveNativeAgentQuestionCheckpoint(
              checkpoint,
              { ...binding, agentId: agentId(binding.runId) },
              binding.question!,
            )
          : checkpoint?.status === "suspended" &&
            checkpoint.suspendedToolCallIds.includes(binding.toolCallId));
      if (Object.hasOwn(binding, "question"))
        settlement.set(binding.runId, proved);
      if (proved) {
        settlement.set(binding.runId, true);
        const cleanup = owner.cleanup.get(binding.runId);
        if (cleanup) cleanup.settled = true;
      }
      return proved;
    },
    async proveQuestionRecovery(binding: {
      runId: string;
      threadId: string;
      resourceId: string;
      toolCallId: string;
      question: ProcessQuestion;
      resumeData: unknown;
    }) {
      await ready();
      if (owner.active.has(binding.runId)) return false;
      await owner.memory.settled();
      const proved = await proveNativeAgentQuestionRecovery(
        owner.storage,
        { ...binding, agentId: agentId(binding.runId) },
        binding.question,
        binding.resumeData,
      );
      return proved && !owner.active.has(binding.runId);
    },
    async executeWorkflow(input: NativeWorkflowInput) {
      await ready();
      if (owner.active.has(input.runId))
        throw new Error("niaro_native_run_busy");
      const execution = executeNativeWorkflow(
        owner.mastra,
        owner.storage,
        input,
      );
      owner.active.set(input.runId, execution);
      try {
        return await execution;
      } finally {
        owner.active.delete(input.runId);
      }
    },
    async proveWorkflowRetired(
      input: Parameters<typeof proveNativeWorkflowRetirement>[1],
    ) {
      await ready();
      if (owner.active.has(input.runId)) return false;
      const proved = await proveNativeWorkflowRetirement(owner.storage, input);
      return proved && !owner.active.has(input.runId);
    },
    async execute(input: NativeAgentInput) {
      await ready();
      if (owner.active.has(input.runId))
        throw new Error("niaro_native_run_busy");
      const execution = Promise.resolve().then(async () => {
        await persistNativeAgentRetirement(owner.storage, {
          version: 1,
          agentId: agentId(input.runId),
          runId: input.runId,
          threadId: input.threadId,
          resourceId: input.resourceId,
          checkpointSeen: false,
          retired: false,
        });
        return run(input);
      });
      owner.active.set(input.runId, execution);
      try {
        return await execution;
      } finally {
        // run() also awaits memory persistence. A settled promise with no active
        // native checkpoint has a durable proof, including pre-dispatch failure.
        try {
          if (
            settlement.get(input.runId) !== false &&
            !input.session.state.pending
          )
            await persistNativeAgentRetirement(owner.storage, {
              version: 1,
              agentId: agentId(input.runId),
              runId: input.runId,
              threadId: input.threadId,
              resourceId: input.resourceId,
              checkpointSeen: true,
              retired: true,
            });
        } finally {
          if (owner.active.get(input.runId) === execution)
            owner.active.delete(input.runId);
        }
      }
    },
    async inspect({
      threadId,
      resourceId,
    }: {
      threadId: string;
      resourceId: string;
    }) {
      await ready();
      const thread = await owner.memory.getThreadById({ threadId, resourceId });
      if (!thread) return { messages: [] };
      if (thread.resourceId !== resourceId)
        throw new Error("niaro_native_resource_mismatch");
      return owner.memory.recall({
        threadId,
        resourceId,
        perPage: 40,
        page: 0,
      });
    },
    /**
     * Deletes a deleted chat's threads: their messages and thread-scoped
     * memory. Threads of another resource are left alone. Callers hold the
     * chat's turn lock, so no run of these threads is in flight.
     */
    async forgetThreads({
      threadIds,
      resourceId,
    }: {
      threadIds: readonly string[];
      resourceId: string;
    }) {
      await ready();
      let forgotten = 0;
      for (const threadId of new Set(threadIds)) {
        const thread = await owner.memory.getThreadById({ threadId });
        if (!thread || thread.resourceId !== resourceId) continue;
        await owner.memory.deleteThread(threadId);
        forgotten++;
      }
      await owner.memory.settled();
      return forgotten;
    },
    async close() {
      if (closed) return;
      closed = true;
      if (--owner.references > 0) return;
      if (share && owners.get(storageUrl) === owner) owners.delete(storageUrl);
      await Promise.allSettled(owner.active.values());
      await owner.ready;
      await owner.memory.settled();
      await owner.mastra.shutdown({ drainTimeout: 5000 });
      for (const cleanup of owner.cleanup.values()) cleanup.dispose();
      owner.cleanup.clear();
      await owner.storage.close();
    },
  };
}

export {
  analyzeMeetingSegment,
  consolidateMeeting,
  nameMeeting,
} from "./meeting-analysis";
