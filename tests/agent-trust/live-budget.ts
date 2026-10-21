import type { LiveTrustModel, ModelRequest } from "./harness";
import type {
  IntegrationTransport,
  TransportResponse,
} from "../../apps/server-integrations/transport";

export type LiveTrustBudgetCaps = {
  maxRequests: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostUsd: number;
  maxOutputTokensPerRequest: number;
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
};

type Reservation = {
  estimatedInputTokens: number;
  requestedOutputTokens: number;
  estimatedCostUsd: number;
};

const finitePositive = (value: number) => Number.isFinite(value) && value > 0;

function validateCaps(caps: LiveTrustBudgetCaps) {
  for (const [name, value] of Object.entries(caps)) {
    if (
      !Number.isFinite(value) ||
      (name.endsWith("UsdPerMillionTokens")
        ? value < 0
        : !finitePositive(value))
    )
      throw new Error(`Invalid live eval cap: ${name}`);
  }
  if (!Number.isInteger(caps.maxRequests))
    throw new Error("Invalid live eval cap: maxRequests");
  if (!Number.isInteger(caps.maxInputTokens))
    throw new Error("Invalid live eval cap: maxInputTokens");
  if (!Number.isInteger(caps.maxOutputTokens))
    throw new Error("Invalid live eval cap: maxOutputTokens");
  if (!Number.isInteger(caps.maxOutputTokensPerRequest))
    throw new Error("Invalid live eval cap: maxOutputTokensPerRequest");
  if (
    caps.inputUsdPerMillionTokens === 0 &&
    caps.outputUsdPerMillionTokens === 0
  )
    throw new Error("At least one live eval token price must be non-zero");
}

/**
 * Local heuristic from serialized request bytes, not a tokenizer-backed upper
 * bound. Actual provider usage is checked after dispatch; any overrun blocks the
 * rest of the run but cannot undo charges for the request already sent.
 */
export function estimateInputTokenReservation(request: ModelRequest) {
  const serialized = JSON.stringify(request);
  const bytes = Buffer.byteLength(serialized, "utf8");
  return bytes + (request.messages?.length ?? 0) * 16 + 64;
}

function readUsage(response: TransportResponse) {
  let payload: unknown;
  try {
    payload = JSON.parse(response.text);
  } catch {
    throw new Error("Live model response did not include readable usage");
  }
  if (!payload || typeof payload !== "object")
    throw new Error("Live model response did not include readable usage");
  const root = payload as Record<string, unknown>;
  if (typeof root.model !== "string" || !root.model)
    throw new Error("Live model response did not identify the provider model");
  const usage = root.usage;
  if (!usage || typeof usage !== "object")
    throw new Error(
      "Live model response did not include usage; budget is uncertain",
    );
  const values = usage as Record<string, unknown>;
  const inputTokens = values.prompt_tokens ?? values.input_tokens;
  const outputTokens = values.completion_tokens ?? values.output_tokens;
  if (
    !Number.isSafeInteger(inputTokens) ||
    !Number.isSafeInteger(outputTokens) ||
    (inputTokens as number) < 0 ||
    (outputTokens as number) < 0
  )
    throw new Error("Live model usage is incomplete; budget is uncertain");
  const providerCost = values.cost ?? root.cost;
  if (
    providerCost !== undefined &&
    (typeof providerCost !== "number" ||
      !Number.isFinite(providerCost) ||
      providerCost < 0)
  )
    throw new Error("Live model cost receipt is invalid; budget is uncertain");
  return {
    actualModelId: root.model,
    inputTokens: inputTokens as number,
    outputTokens: outputTokens as number,
    providerCostUsd: providerCost as number | undefined,
  };
}

export function createLiveTrustBudget(input: {
  providerUrl: string;
  modelId: string;
  apiKey: string;
  caps: LiveTrustBudgetCaps;
  transport: IntegrationTransport;
}) {
  validateCaps(input.caps);
  if (!input.modelId.trim() || !input.apiKey.trim())
    throw new Error("Live eval requires an exact model and API key");
  const caps = input.caps;
  const pending = new Map<ModelRequest, Reservation>();
  let requests = 0;
  let actualInputTokens = 0;
  let actualOutputTokens = 0;
  let providerReportedCostUsd = 0;
  let rateEstimatedCostUsd = 0;
  let totalLatencyMs = 0;
  let responsesObserved = 0;
  const actualModelIds = new Set<string>();
  let reservedInputTokens = 0;
  let reservedOutputTokens = 0;
  let reservedCostUsd = 0;
  let budgetUncertain = false;
  let uncertaintyReason: string | undefined;
  let lastObservedAnomaly:
    | {
        actualModelId: string;
        inputTokens: number;
        outputTokens: number;
        costUsd: number;
        costSource: "provider-reported" | "caller-rate-estimate";
        reason: string;
      }
    | undefined;

  const reserve = async (request: ModelRequest) => {
    if (budgetUncertain)
      throw new Error("Live eval stopped because usage is uncertain");
    if (pending.size)
      throw new Error("Previous live eval request is not reconciled");
    if (request.model !== input.modelId)
      throw new Error("Live eval model changed after budget approval");
    if (pending.has(request))
      throw new Error("Duplicate live eval reservation");
    if (requests + 1 > caps.maxRequests)
      throw new Error("Live eval request cap reached before dispatch");
    const outputTokens = request.max_tokens;
    if (
      !Number.isInteger(outputTokens) ||
      (outputTokens as number) < 1 ||
      (outputTokens as number) > caps.maxOutputTokensPerRequest
    )
      throw new Error("Live eval output token cap is invalid");
    const estimatedInputTokens = estimateInputTokenReservation(request);
    const estimatedCostUsd =
      (estimatedInputTokens * caps.inputUsdPerMillionTokens +
        (outputTokens as number) * caps.outputUsdPerMillionTokens) /
      1_000_000;
    if (
      actualInputTokens + reservedInputTokens + estimatedInputTokens >
      caps.maxInputTokens
    )
      throw new Error("Live eval input token cap reached before dispatch");
    if (
      actualOutputTokens + reservedOutputTokens + (outputTokens as number) >
      caps.maxOutputTokens
    )
      throw new Error("Live eval output token cap reached before dispatch");
    if (
      providerReportedCostUsd +
        rateEstimatedCostUsd +
        reservedCostUsd +
        estimatedCostUsd >
      caps.maxCostUsd
    )
      throw new Error("Live eval cost cap reached before dispatch");
    const reservation = {
      estimatedInputTokens,
      requestedOutputTokens: outputTokens as number,
      estimatedCostUsd,
    };
    pending.set(request, reservation);
    requests += 1;
    reservedInputTokens += reservation.estimatedInputTokens;
    reservedOutputTokens += reservation.requestedOutputTokens;
    reservedCostUsd += reservation.estimatedCostUsd;
  };

  const observe = async (
    request: ModelRequest,
    response: TransportResponse,
    elapsedMs = 0,
  ) => {
    const reservation = pending.get(request);
    if (!reservation)
      throw new Error("Live model response has no matching budget reservation");
    let usage: ReturnType<typeof readUsage>;
    try {
      usage = readUsage(response);
    } catch (error) {
      budgetUncertain = true;
      uncertaintyReason = "provider usage receipt was missing or invalid";
      throw error;
    }
    const costUsd =
      usage.providerCostUsd ??
      (usage.inputTokens * caps.inputUsdPerMillionTokens +
        usage.outputTokens * caps.outputUsdPerMillionTokens) /
        1_000_000;
    const costSource =
      usage.providerCostUsd !== undefined
        ? "provider-reported"
        : "caller-rate-estimate";
    actualInputTokens += usage.inputTokens;
    actualOutputTokens += usage.outputTokens;
    if (usage.providerCostUsd !== undefined)
      providerReportedCostUsd += usage.providerCostUsd;
    else rateEstimatedCostUsd += costUsd;
    actualModelIds.add(usage.actualModelId);
    responsesObserved += 1;
    if (Number.isFinite(elapsedMs) && elapsedMs >= 0)
      totalLatencyMs += elapsedMs;
    if (usage.actualModelId !== input.modelId) {
      budgetUncertain = true;
      uncertaintyReason =
        "provider returned a model different from the requested model";
      lastObservedAnomaly = {
        actualModelId: usage.actualModelId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd,
        costSource,
        reason: uncertaintyReason,
      };
      throw new Error(
        "Provider returned a different model than requested; evaluation is uncertain",
      );
    }
    if (
      usage.inputTokens > reservation.estimatedInputTokens ||
      usage.outputTokens > reservation.requestedOutputTokens ||
      costUsd > reservation.estimatedCostUsd
    ) {
      budgetUncertain = true;
      uncertaintyReason = "provider usage exceeded the local reservation";
      lastObservedAnomaly = {
        actualModelId: usage.actualModelId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd,
        costSource,
        reason: uncertaintyReason,
      };
      throw new Error(
        "Live model exceeded its reserved budget; results are uncertain",
      );
    }
    pending.delete(request);
    reservedInputTokens -= reservation.estimatedInputTokens;
    reservedOutputTokens -= reservation.requestedOutputTokens;
    reservedCostUsd -= reservation.estimatedCostUsd;
    return { ...usage, costUsd, costSource };
  };

  const fail = (request: ModelRequest, _error: unknown) => {
    if (pending.has(request)) {
      budgetUncertain = true;
      uncertaintyReason =
        "dispatched request did not produce a reconciled response";
    }
  };

  const model: LiveTrustModel = {
    providerUrl: input.providerUrl,
    modelId: input.modelId,
    apiKey: input.apiKey,
    maxOutputTokensPerRequest: caps.maxOutputTokensPerRequest,
    reserve,
    fail,
    transport: input.transport,
    observe: async (request, response, elapsedMs) => {
      await observe(request, response, elapsedMs);
    },
  };

  return {
    model,
    reserve,
    fail,
    observe,
    snapshot: () => ({
      requests,
      actualInputTokens,
      actualOutputTokens,
      providerReportedCostUsd,
      rateEstimatedCostUsd,
      actualModelIds: [...actualModelIds],
      totalLatencyMs,
      averageLatencyMs: responsesObserved
        ? totalLatencyMs / responsesObserved
        : 0,
      responsesObserved,
      reservedInputTokens,
      reservedOutputTokens,
      reservedCostUsd,
      inputTokenCountMeaning:
        "provider-reported input tokens; pre-dispatch values are byte-based local estimates, not a hard tokenizer ceiling",
      outputTokenCountMeaning:
        "provider-reported output tokens; max_tokens is a requested provider limit and overruns are detected after dispatch",
      costMeaning:
        "provider-reported cost when supplied, otherwise an estimate from caller-provided rates; neither is an invoice guarantee",
      uncertain: budgetUncertain || pending.size > 0,
      uncertaintyReason,
      lastObservedAnomaly,
    }),
  };
}
