/**
 * The native agent contract both runtimes implement (Mastra in `runtime.ts`,
 * Pi in `pi/native-agent.ts`): the domain session, tool definitions and
 * events, and the pure prompt helpers they share. Loads no agent framework.
 */
import type { ProcessQuestion } from "../../packages/protocol/process-questions";
import type { ActionFailure } from "../../packages/protocol/action-failure";
import type { ServiceAnswer } from "../server-identity/catalog-runtime";
import type {
  ModelTextObserver,
  NiaroModelSelection,
} from "../server-integrations/mastra-model";
import type { DispatchGuard } from "../server-integrations/transport";
import { privateInternalTool } from "../server-plugins/registry";
import type { LanguageModelV4 } from "./model-types";

export const NATIVE_AGENT_MAX_STEPS = 12;
/**
 * The last steps of a run may not call tools: the model answers with what it
 * has verified and says what it could not get, instead of the run ending
 * without an answer. Two, so a checker repair still fits.
 */
export const NATIVE_ANSWER_STEPS = 2;
export const FINAL_STEP_NOTE =
  "[Server] You have used the steps available for this request: no more tools can be called. Answer now from the tool results you already have. Say plainly which parts of the request you could not get or verify and why (for example a service that refused, a result that was too large, or data that no connected service holds), and what the person can do about it. Never guess the missing parts.";

export type NativeAgentEvent =
  | {
      type: "model-start";
      model?: string;
      /** The catalog model's id, for the answer's receipt (NIAR-296). */
      modelId?: string;
      /** The model's role and why it serves this step. */
      role?: string;
      reason?: string;
      /** The preset the person picked for this message, by name. */
      preset?: string;
    }
  | { type: "model-end"; failed?: true }
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
    /**
     * What changes per turn or step (time, goal, receipts, memory). It is sent
     * after the conversation so tools, instructions and history stay one
     * stable, cacheable prefix.
     */
    context?: string;
    /** Explicit domain provenance; unmarked legacy context is treated as private. */
    privateContext?: boolean;
  }>;
  /**
   * Which earlier runs of this thread may keep their answers in the model's
   * history, checked on every model call (NIAR-263): an answer whose run is
   * left out is withheld. Without it, an earlier answer built on private
   * context is withheld.
   */
  visibleRuns?(runIds: string[]): Promise<ReadonlySet<string>>;
  allowance(
    providerId: string,
    revision: number,
    start: () => void,
  ): Promise<void>;
  /**
   * The role's next model after a call that provably never reached its
   * provider, when the role allows fallback; undefined otherwise.
   */
  fallback?(
    selected: NiaroModelSelection,
    error: unknown,
  ): Promise<NiaroModelSelection | undefined>;
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
  /** The service an action tool belongs to, for the person's view of a step. */
  service?: string;
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
  /**
   * Send service actions to the provider through one call_action tool with
   * their schemas as text (the chat, whose actions are loaded mid-run).
   */
  actionDispatch?: boolean;
  session: NativeAgentSession;
  createModel(
    selected: NiaroModelSelection,
    beforeDispatch: DispatchGuard,
    observer?: ModelTextObserver,
  ): LanguageModelV4;
  onEvent?(event: NativeAgentEvent): Promise<void> | void;
  /**
   * The answer while it is written: the raw text of the model step that can
   * still become the reply, or null when there is none (the step called a
   * tool, the checker sent the reply back, the answer is a system answer).
   * Presentation only: it is never stored and decides nothing.
   */
  onDraft?(draft: string | null): void;
  /** Model steps for this run; NATIVE_AGENT_MAX_STEPS when not given. */
  maxSteps?: number;
};
export type NativeAgentResult = {
  runId: string;
  finishReason: string;
  text: string;
  suspended: boolean;
  answer?: ServiceAnswer;
};

/** The one tool service actions reach the provider through. */
export const CALL_ACTION_TOOL = "call_action";
export const guardedTool = (name: string) =>
  name === CALL_ACTION_TOOL ||
  name.startsWith("action_") ||
  name.startsWith("design_") ||
  name.startsWith("memory_") ||
  name.startsWith("human_task_") ||
  name.startsWith("hub_") ||
  name.startsWith("skill_") ||
  // Meeting notes and transcripts are private like service reads.
  name.startsWith("meeting_") ||
  // So are web pages and search results; only pure plugins' values are not.
  privateInternalTool(name) ||
  name === "ask_user";

/** Retain call identity, but never reuse source data from a historical transcript. */
export function historicalResult(value: unknown) {
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

/**
 * The note that replaces an earlier turn's tool calls in the prompt. History
 * keeps no tool arguments (privacy), and a call shown with empty arguments
 * is one the model copies, so earlier calls are named, never replayed.
 */
/** Arguments longer than this (a whole process proposal) are not repeated in
 * later steps: the request would outgrow its budget. A named marker, unlike
 * `{}`, is no call shape to copy. */
export const PROMPT_INPUT_MAX_CHARS = 4000;
export function promptInput(input: unknown) {
  const size = JSON.stringify(input)?.length ?? 0;
  return size <= PROMPT_INPUT_MAX_CHARS
    ? input
    : {
        niaroOmitted: `The arguments of this earlier call (${size} characters) are not repeated. Send complete arguments when you call a tool.`,
      };
}
export const EARLIER_CALLS_NOTE = (calls: string[]) =>
  `[Earlier tool calls, not kept in history: ${[...new Set(calls)].join(", ")}. Their arguments and results are gone; call a tool again with complete arguments when you need its result.]`;
