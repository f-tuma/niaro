import type { InferenceBudgetSettings } from "../../packages/protocol/inference-budget";
import type {
  ProcessDefinition,
  ProcessLimits,
} from "../../packages/protocol/service-processes";
import { callReservation } from "./inference-budget";

type Model = { id: string; revision: number; providerRevision: number };
export type ReservationGap = {
  gap: "model_reservation_too_large";
  /** What the smallest useful run needs: its model calls at their smallest
   * reservation (floor input + full output; an agent that may use a tool
   * needs two calls: the call, the answer). */
  reservation: { tokens: number; costMicros: number; calls: number };
  /** The most a process may hold here (registry ceiling and workspace budget). */
  allowed: { tokens: number; costMicros: number };
};

/**
 * The input a sized process plans per model call: a prompt with its tool
 * definitions and an earlier tool result. Each call still reserves only its
 * own request size, so this sets headroom, not a per-call limit.
 */
export const TYPICAL_CALL_INPUT = 32_768;

/** Tool calls planned for an agent step that can use services. */
export const AGENT_TOOL_CALLS = 3;
/** Planned wall time: a model call takes about 1–6 s, a service call less. */
const RUN_BASE_MS = 15_000,
  MODEL_CALL_MS = 10_000,
  SERVICE_CALL_MS = 5_000;

/**
 * What one ordinary run of this shape uses, as the runtime counts it. Every
 * entered node is a step (an agent process's synthetic return is not); inside
 * an agent step every model call ("model:n") and every tool call
 * ("tool:<id>", including a question) is a step too, in the same ledger
 * (`service-process-runtime.ts` `charge`). An agent that can use services
 * plans AGENT_TOOL_CALLS tool calls and answers once more after them, so it
 * needs tool calls + 1 model calls. The duration runs from the start to the
 * end of the whole run and includes every model and service call.
 */
export function processLimitNeeds(definition: ProcessDefinition) {
  const agents =
    definition.kind === "agent"
      ? [definition]
      : definition.steps.filter((step) => step.type === "agent");
  const nodes = definition.kind === "agent" ? 1 : definition.steps.length;
  const actions =
    definition.kind === "agent"
      ? 0
      : definition.steps.filter((step) => step.type === "action").length;
  let calls = 0,
    tools = 0,
    serviceCalls = actions;
  for (const agent of agents) {
    const used = agent.capabilities.length ? AGENT_TOOL_CALLS : 0;
    const asks = agent.humanInput === "text" ? 1 : 0;
    tools += used + asks;
    serviceCalls += used;
    calls += used + asks + 1;
  }
  return {
    maxSteps: nodes + calls + tools,
    maxModelCalls: calls,
    maxDurationMs:
      RUN_BASE_MS + calls * MODEL_CALL_MS + serviceCalls * SERVICE_CALL_MS,
  };
}

/**
 * Every model call reserves its own request size (at least the floor input)
 * plus the model's priced output ceiling within the process's own caps
 * before it is sent, in tests and in real runs alike. A designer that writes
 * small caps (1 200 tokens for one CRM count) makes a process that can never
 * call its model. This sizes the token and cost caps for the declared number
 * of model calls at a typical input each, never lowering what the designer
 * wrote and never above the registry ceiling or the workspace budget. When
 * even the smallest useful run (its calls at the floor input) does not fit,
 * it says how much is missing.
 */
export function fitProcessLimits(
  definition: ProcessDefinition,
  input: {
    budget: Pick<
      InferenceBudgetSettings,
      "prices" | "maxTokens" | "maxCostMicros"
    >;
    ceiling: ProcessLimits;
    /** The current catalog revisions of a model, or undefined when unusable. */
    model: (id: string) => Model | undefined;
  },
): { limits: ProcessLimits; changed: boolean } | ReservationGap {
  // Steps, model calls and time an ordinary run needs, never lowered and
  // never above the registry ceiling.
  const needs = processLimitNeeds(definition);
  const shaped = {
    ...definition.limits,
    maxSteps: Math.max(
      definition.limits.maxSteps,
      Math.min(input.ceiling.maxSteps, needs.maxSteps),
    ),
    maxModelCalls: Math.max(
      definition.limits.maxModelCalls,
      Math.min(input.ceiling.maxModelCalls, needs.maxModelCalls),
    ),
    maxDurationMs: Math.max(
      definition.limits.maxDurationMs,
      Math.min(input.ceiling.maxDurationMs, needs.maxDurationMs),
    ),
  };
  const limits = shaped;
  const ids = new Set(
    definition.kind === "agent"
      ? [definition.modelId]
      : definition.steps.flatMap((step) =>
          step.type === "agent" ? [step.modelId] : [],
        ),
  );
  const floor = { tokens: 0, cost: 0 },
    typical = { tokens: 0, cost: 0 };
  for (const id of ids) {
    const model = input.model(id);
    const price = model
      ? input.budget.prices.find(
          (p) =>
            p.modelId === model.id &&
            p.modelRevision === model.revision &&
            p.providerRevision === model.providerRevision,
        )
      : undefined;
    // An unpriced model is refused by the test with its own reason.
    if (!price) continue;
    const least = callReservation(price);
    const usual = callReservation(price, TYPICAL_CALL_INPUT);
    floor.tokens = Math.max(floor.tokens, least.tokens);
    floor.cost = Math.max(floor.cost, least.cost);
    typical.tokens = Math.max(typical.tokens, usual.tokens);
    typical.cost = Math.max(typical.cost, usual.cost);
  }
  const reshaped =
    shaped.maxSteps !== definition.limits.maxSteps ||
    shaped.maxModelCalls !== definition.limits.maxModelCalls ||
    shaped.maxDurationMs !== definition.limits.maxDurationMs;
  if (!floor.tokens) return { limits, changed: reshaped };
  const agents =
    definition.kind === "agent"
      ? [definition]
      : definition.steps.filter((step) => step.type === "agent");
  // Calls run one after another; each reserves on top of what earlier calls used.
  const needed = Math.min(
    Math.max(1, limits.maxModelCalls),
    agents.reduce((sum, agent) => sum + (agent.capabilities.length ? 2 : 1), 0),
  );
  const allowed = {
    tokens: Math.min(input.ceiling.maxTokens, input.budget.maxTokens),
    costMicros: Math.min(
      input.ceiling.maxCostMicros,
      input.budget.maxCostMicros,
    ),
  };
  if (
    needed * floor.tokens > allowed.tokens ||
    needed * floor.cost > allowed.costMicros
  )
    return {
      gap: "model_reservation_too_large",
      reservation: {
        tokens: needed * floor.tokens,
        costMicros: needed * floor.cost,
        calls: needed,
      },
      allowed,
    };
  const calls = Math.max(1, limits.maxModelCalls);
  const fitted = {
    ...limits,
    maxTokens: Math.max(
      limits.maxTokens,
      Math.min(allowed.tokens, calls * typical.tokens),
    ),
    maxCostMicros: Math.max(
      limits.maxCostMicros,
      Math.min(allowed.costMicros, calls * typical.cost),
    ),
  };
  return {
    limits: fitted,
    changed:
      reshaped ||
      fitted.maxTokens !== limits.maxTokens ||
      fitted.maxCostMicros !== limits.maxCostMicros,
  };
}
