import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  InferenceBudgetPolicySchema,
  InferenceBudgetSettingsSchema,
  InferenceBudgetUsageSchema,
  type InferenceBudgetSettings,
  type InferencePrice,
  type InferenceUsage,
} from "../../packages/protocol/inference-budget";
import type { CatalogTarget } from "../../packages/protocol/service-catalog";
import type { NiaroModelSelection } from "../server-integrations/mastra-model";
import type { IntegrationTransport } from "../server-integrations/transport";
import { IdentityError } from "./error";
import { isInferenceBudgetFailureCode } from "./inference-budget-failure";
import { operatorLog } from "../fixture-server/operator-log";
import { processDigest } from "./process-validation";

type Target = z.infer<typeof CatalogTarget> & { userId: string };
type Kind = "model" | "decision";
/** Trusted frozen process caps, shared by all child agents under one root. */
export type InferenceRunCaps = {
  maxTokens: number;
  maxCostMicros: number;
  maxModelCalls: number;
};
const defaultSettings: InferenceBudgetSettings = {
  mode: "observe",
  maxTokens: 1_000_000,
  maxCostMicros: 10_000_000,
  prices: [],
};
const safeCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
/**
 * The smallest input a priced call reserves, and what static feasibility
 * checks (designer sizing, process readiness, native test verdicts) assume
 * each planned call needs. It is also the protocol minimum of a price's
 * `maxInputTokens`, so it always fits a valid tariff.
 */
export const MIN_INPUT_ALLOWANCE = 2048;
/** Local admission margin added to the serialized request size. */
export const INPUT_ESTIMATE_MARGIN = 1024;
/**
 * Conservative local input estimate: serialized UTF-8 bytes plus a margin.
 * Not a provider tokenizer; null when the body is not a JSON object.
 */
export function estimatedInputTokens(body: unknown): number | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return (
    Buffer.byteLength(JSON.stringify(body), "utf8") + INPUT_ESTIMATE_MARGIN
  );
}
/**
 * What one priced call reserves for a given input: at least the floor, at
 * most the price's input ceiling, plus the full output ceiling (output is
 * clamped to it with `max_tokens`).
 */
export function callReservation(price: InferencePrice, inputTokens = 0) {
  const input = Math.min(
    price.maxInputTokens,
    Math.max(MIN_INPUT_ALLOWANCE, inputTokens),
  );
  return {
    inputTokens: input,
    tokens: input + price.maxOutputTokens,
    cost: tariffMicros(input, price.maxOutputTokens, price),
  };
}
export function tariffMicros(
  input: number,
  output: number,
  price: InferencePrice,
): number {
  const value =
    (BigInt(input) * BigInt(price.inputMicrosPerMillion) +
      BigInt(output) * BigInt(price.outputMicrosPerMillion) +
      999999n) /
    1000000n;
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new IdentityError(429, "catalog_budget_overrun");
  return Number(value);
}
/** Preserve USD decimals without multiplying binary floating-point prices. */
function usdMicros(value: unknown): number | null {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "number" && (!Number.isFinite(value) || value < 0))
  )
    return null;
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(String(value));
  if (!match) return null;
  const exponent = Number(match[3] ?? 0);
  if (
    !Number.isSafeInteger(exponent) ||
    Math.abs(exponent) > 20 ||
    String(value).length > 100
  )
    return null;
  const fraction = match[2] ?? "";
  const units = BigInt(match[1]! + fraction);
  const power = 6 + exponent - fraction.length;
  const micros =
    power >= 0
      ? units * 10n ** BigInt(power)
      : (units + 10n ** BigInt(-power) - 1n) / 10n ** BigInt(-power);
  return micros <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(micros) : null;
}
export function inferenceUsage(
  raw: unknown,
  kind: Kind,
  price?: InferencePrice,
): InferenceUsage {
  const usage =
    raw && typeof raw === "object" && "usage" in raw ? raw.usage : undefined;
  const fields =
    usage && typeof usage === "object"
      ? (usage as Record<string, unknown>)
      : {};
  let inputTokens = safeCount(
    kind === "decision" ? fields.input_tokens : fields.prompt_tokens,
  );
  let outputTokens = safeCount(
    kind === "decision" ? fields.output_tokens : fields.completion_tokens,
  );
  if (
    inputTokens !== null &&
    outputTokens !== null &&
    (!Number.isSafeInteger(inputTokens + outputTokens) ||
      (fields.total_tokens !== undefined &&
        safeCount(fields.total_tokens) !== inputTokens + outputTokens))
  ) {
    inputTokens = null;
    outputTokens = null;
  }
  const reported = usdMicros(fields.cost);
  // An explicit malformed price is not silently replaced with a tariff.
  const cost =
    fields.cost !== undefined
      ? reported
      : price && inputTokens !== null && outputTokens !== null
        ? tariffMicros(inputTokens, outputTokens, price)
        : null;
  return {
    inputTokens,
    outputTokens,
    costMicros: cost,
    costSource:
      cost === null ? "unknown" : reported !== null ? "provider" : "tariff",
  };
}

/** Single identity-server owner; all methods run under its queue. No remote I/O. */
export class InferenceBudgetStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_inference_policy(workspace_id TEXT PRIMARY KEY REFERENCES agent_workspace(id) ON DELETE CASCADE,organization_id TEXT NOT NULL,revision INTEGER NOT NULL,settings TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS agent_inference_run(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,workspace_id TEXT NOT NULL REFERENCES agent_workspace(id) ON DELETE CASCADE,user_id TEXT NOT NULL,policy_revision INTEGER NOT NULL,policy_digest TEXT NOT NULL,settings TEXT NOT NULL,historical_unknown INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS agent_inference_attempt(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES agent_inference_run(id) ON DELETE CASCADE,kind TEXT NOT NULL,model_id TEXT NOT NULL,model_revision INTEGER NOT NULL,provider_revision INTEGER NOT NULL,status TEXT NOT NULL,reserved_tokens INTEGER,reserved_cost INTEGER,input_tokens INTEGER,output_tokens INTEGER,cost_micros INTEGER,cost_source TEXT NOT NULL,price TEXT,overrun INTEGER NOT NULL DEFAULT 0) STRICT;
      CREATE INDEX IF NOT EXISTS agent_inference_attempt_run ON agent_inference_attempt(run_id);
      CREATE TRIGGER IF NOT EXISTS agent_inference_run_immutable BEFORE UPDATE ON agent_inference_run BEGIN SELECT RAISE(ABORT,'inference_run_immutable'); END;
    `);
    // The identity process lock excludes a previous live owner.
    db.exec(
      "UPDATE agent_inference_attempt SET status='unknown' WHERE status='dispatched'; UPDATE agent_inference_attempt SET status='cancelled' WHERE status='reserved';",
    );
  }
  policy(organizationId: string, workspaceId: string) {
    if (
      !this.db
        .prepare(
          "SELECT id FROM agent_workspace WHERE id=? AND organization_id=?",
        )
        .get(workspaceId, organizationId)
    )
      throw new IdentityError(403, "identity_forbidden");
    const row = this.db
      .prepare(
        "SELECT * FROM agent_inference_policy WHERE workspace_id=? AND organization_id=?",
      )
      .get(workspaceId, organizationId);
    return InferenceBudgetPolicySchema.parse({
      organizationId,
      workspaceId,
      revision: Number(row?.revision ?? 0),
      settings: row ? JSON.parse(String(row.settings)) : defaultSettings,
    });
  }
  /** Passive first-call readiness; never opens a run or reserves an attempt. */
  canStartModel(
    organizationId: string,
    workspaceId: string,
    selected: {
      model: { id: string; revision: number };
      provider: { revision: number };
    },
    caps: InferenceRunCaps,
  ) {
    const { settings } = this.policy(organizationId, workspaceId);
    const price = settings.prices.find(
      (p) =>
        p.modelId === selected.model.id &&
        p.modelRevision === selected.model.revision &&
        p.providerRevision === selected.provider.revision,
    );
    if (settings.mode !== "enforce" || !price || caps.maxModelCalls < 1)
      return false;
    try {
      // A call reserves its own request size, so a run is feasible when the
      // smallest call (floor input + full output) fits the caps.
      const floor = callReservation(price);
      return (
        floor.tokens <= Math.min(settings.maxTokens, caps.maxTokens) &&
        floor.cost <= Math.min(settings.maxCostMicros, caps.maxCostMicros)
      );
    } catch {
      return false;
    }
  }
  savePolicy(
    organizationId: string,
    workspaceId: string,
    revision: number,
    raw: InferenceBudgetSettings,
  ) {
    const settings = InferenceBudgetSettingsSchema.parse(raw);
    if (this.policy(organizationId, workspaceId).revision !== revision)
      throw new IdentityError(409, "catalog_conflict");
    const saved = this.db
      .prepare(
        "INSERT INTO agent_inference_policy VALUES(?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET revision=excluded.revision,settings=excluded.settings WHERE organization_id=excluded.organization_id AND revision=?",
      )
      .run(
        workspaceId,
        organizationId,
        revision + 1,
        JSON.stringify(settings),
        revision,
      );
    if (saved.changes !== 1) throw new IdentityError(409, "catalog_conflict");
    return this.policy(organizationId, workspaceId);
  }
  open(
    runId: string,
    target: Target,
    priorInference = 0,
    caps?: InferenceRunCaps,
  ) {
    if (safeCount(priorInference) === null)
      throw new IdentityError(409, "catalog_conflict");
    const current = this.policy(target.organizationId, target.workspaceId);
    const settings = caps
      ? InferenceBudgetSettingsSchema.parse({
          ...current.settings,
          maxTokens: Math.min(current.settings.maxTokens, caps.maxTokens),
          maxCostMicros: Math.min(
            current.settings.maxCostMicros,
            caps.maxCostMicros,
          ),
        })
      : current.settings;
    if (caps && safeCount(caps.maxModelCalls) === null)
      throw new IdentityError(409, "catalog_conflict");
    const digest = processDigest(
      caps ? { settings: current.settings, caps } : current.settings,
    );
    this.db
      .prepare(
        "INSERT INTO agent_inference_run VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
      )
      .run(
        runId,
        target.organizationId,
        target.workspaceId,
        target.userId,
        current.revision,
        digest,
        JSON.stringify(settings),
        priorInference,
      );
    const row = this.db
      .prepare("SELECT * FROM agent_inference_run WHERE id=?")
      .get(runId)!;
    if (
      row.organization_id !== target.organizationId ||
      row.workspace_id !== target.workspaceId ||
      row.user_id !== target.userId
    )
      throw new IdentityError(403, "identity_forbidden");
    if (
      row.policy_revision !== current.revision ||
      row.policy_digest !== digest
    )
      throw new IdentityError(409, "catalog_budget_policy_changed");
    return {
      settings: InferenceBudgetSettingsSchema.parse(
        JSON.parse(String(row.settings)),
      ),
      historicalUnknown: Number(row.historical_unknown),
    };
  }
  summary(runId: string) {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS calls,
      COALESCE(SUM(CASE WHEN status='cancelled' THEN 0 WHEN input_tokens IS NOT NULL AND output_tokens IS NOT NULL THEN input_tokens+output_tokens ELSE COALESCE(reserved_tokens,0) END),0) AS tokens,
      COALESCE(SUM(CASE WHEN status='cancelled' THEN 0 ELSE COALESCE(cost_micros,reserved_cost,0) END),0) AS cost,
      COALESCE(SUM(CASE WHEN status='unknown' THEN 1 ELSE 0 END),0) AS unknowns,
      COALESCE(MAX(overrun),0) AS overrun
      FROM agent_inference_attempt WHERE run_id=?`,
      )
      .get(runId)!;
    const history = this.db
      .prepare("SELECT historical_unknown FROM agent_inference_run WHERE id=?")
      .get(runId);
    return {
      calls: Number(row.calls),
      accountedTokens: Math.min(Number.MAX_SAFE_INTEGER, Number(row.tokens)),
      accountedCostMicros: Math.min(Number.MAX_SAFE_INTEGER, Number(row.cost)),
      unknownCalls:
        Number(row.unknowns) + Number(history?.historical_unknown ?? 0),
      overrun: Boolean(row.overrun),
    };
  }
  assertReady(
    runId: string,
    target: Target,
    priorInference = 0,
    caps?: InferenceRunCaps,
  ) {
    const policy = this.open(runId, target, priorInference, caps);
    const totals = this.summary(runId);
    if (policy.settings.mode === "enforce") {
      if (totals.overrun)
        throw new IdentityError(429, "catalog_budget_overrun");
      // An unknown attempt keeps its full reservation in the totals, which is
      // its upper bound, so the run may continue within its caps. Inference
      // that predates the ledger has no reservation and cannot be bounded.
      if (policy.historicalUnknown)
        throw new IdentityError(429, "catalog_budget_usage_unknown");
    }
    return { ...policy, ...totals };
  }
  /**
   * Check the next priced call under the identity queue without reserving an
   * attempt. `inputTokens` is the request's estimated input (null when it
   * cannot be measured); omitted, the check asks whether a call of the floor
   * size could still start.
   */
  assertCanReserve(
    runId: string,
    target: Target,
    selected: {
      model: { id: string; revision: number };
      provider: { revision: number };
    },
    priorInference = 0,
    caps?: InferenceRunCaps,
    inputTokens?: number | null,
  ) {
    const current = this.assertReady(runId, target, priorInference, caps);
    if (caps && current.calls >= caps.maxModelCalls)
      throw new IdentityError(429, "catalog_budget_exhausted");
    const price = current.settings.prices.find(
      (p) =>
        p.modelId === selected.model.id &&
        p.modelRevision === selected.model.revision &&
        p.providerRevision === selected.provider.revision,
    );
    const enforce = current.settings.mode === "enforce";
    if (enforce && !price)
      throw new IdentityError(409, "catalog_budget_price_required");
    // Larger than the model's priced input ceiling: no budget could admit it.
    if (
      enforce &&
      inputTokens !== undefined &&
      (inputTokens === null || inputTokens > price!.maxInputTokens)
    )
      throw new IdentityError(429, "catalog_budget_request_too_large");
    // The reservation is this request's own estimate (never below the floor,
    // never above the price ceiling) plus the full output ceiling. It stays
    // the call's upper bound: the request fits it and output is clamped.
    const reservation = price
      ? callReservation(price, inputTokens ?? 0)
      : undefined;
    if (
      enforce &&
      (current.accountedTokens + reservation!.tokens >
        current.settings.maxTokens ||
        current.accountedCostMicros + reservation!.cost >
          current.settings.maxCostMicros)
    )
      throw new IdentityError(429, "catalog_budget_exhausted");
    return {
      price,
      inputTokens: reservation?.inputTokens ?? null,
      tokens: reservation?.tokens ?? null,
      cost: reservation?.cost ?? null,
      enforce,
    };
  }
  reserve(
    runId: string,
    target: Target,
    selected: NiaroModelSelection,
    kind: Kind,
    priorInference = 0,
    caps?: InferenceRunCaps,
    inputTokens?: number | null,
  ) {
    const { price, tokens, cost, enforce } = this.assertCanReserve(
      runId,
      target,
      selected,
      priorInference,
      caps,
      inputTokens,
    );
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO agent_inference_attempt(id,run_id,kind,model_id,model_revision,provider_revision,status,reserved_tokens,reserved_cost,cost_source,price) VALUES(?,?,?,?,?,?,'reserved',?,?,'unknown',?)",
      )
      .run(
        id,
        runId,
        kind,
        selected.model.id,
        selected.model.revision,
        selected.provider.revision,
        tokens,
        cost,
        price ? JSON.stringify(price) : null,
      );
    return { id, price, enforce, tokens, cost };
  }
  dispatch(id: string) {
    if (
      !this.db
        .prepare(
          "UPDATE agent_inference_attempt SET status='dispatched' WHERE id=? AND status='reserved'",
        )
        .run(id).changes
    )
      throw new IdentityError(409, "catalog_conflict");
  }
  settle(id: string, usage: InferenceUsage) {
    usage = InferenceBudgetUsageSchema.parse(usage);
    const row = this.db
      .prepare("SELECT * FROM agent_inference_attempt WHERE id=?")
      .get(id);
    if (!row || row.status !== "dispatched")
      throw new IdentityError(409, "catalog_conflict");
    const known =
      usage.inputTokens !== null &&
      usage.outputTokens !== null &&
      usage.costMicros !== null;
    const overrun =
      (row.reserved_tokens !== null &&
        usage.inputTokens !== null &&
        usage.outputTokens !== null &&
        usage.inputTokens + usage.outputTokens > Number(row.reserved_tokens)) ||
      (row.reserved_cost !== null &&
        usage.costMicros !== null &&
        usage.costMicros > Number(row.reserved_cost));
    this.db
      .prepare(
        "UPDATE agent_inference_attempt SET status=?,input_tokens=?,output_tokens=?,cost_micros=?,cost_source=?,overrun=? WHERE id=? AND status='dispatched'",
      )
      .run(
        known ? "settled" : "unknown",
        usage.inputTokens,
        usage.outputTokens,
        usage.costMicros,
        usage.costSource,
        Number(overrun),
        id,
      );
  }
  failed(id: string) {
    this.db
      .prepare(
        "UPDATE agent_inference_attempt SET status=CASE WHEN status='reserved' THEN 'cancelled' ELSE 'unknown' END WHERE id=? AND status IN ('reserved','dispatched')",
      )
      .run(id);
  }
}

/** A gateway timeout may hide a completion the upstream model already generated. */
const gatewayTimeouts = new Set([408, 504, 524]);
/** One wrapper serves SDK chat and raw decision responses before their parsers/abort checks. */
export function budgetedInferenceTransport(
  transport: IntegrationTransport,
  store: InferenceBudgetStore,
  runId: string,
  target: Target,
  selected: NiaroModelSelection,
  kind: Kind,
  serial: <T>(run: () => Promise<T>) => Promise<T>,
  authorizeHeld: () => Promise<unknown>,
  priorInference: () => number,
  caps?: InferenceRunCaps,
): IntegrationTransport {
  return async (request) => {
    const started = performance.now();
    // The body is known here, so the call reserves its own estimated input
    // (within the price ceiling and the run's remaining headroom) rather than
    // the priced maximum. A request larger than that is refused before dispatch.
    const inputTokens = estimatedInputTokens(request.body);
    const logFailure = (error: unknown) =>
      operatorLog(
        "model_call",
        {
          kind,
          model: selected.model.id,
          workspace: target.workspaceId,
          error:
            error instanceof IdentityError
              ? error.code
              : error instanceof Error
                ? error.name.slice(0, 60)
                : "unknown",
          ms: Math.round(performance.now() - started),
        },
        "warn",
      );
    const reservation = await serial(async () => {
      await authorizeHeld();
      return store.reserve(
        runId,
        target,
        selected,
        kind,
        priorInference(),
        caps,
        inputTokens,
      );
    }).catch((error: unknown) => {
      // A budget refusal before dispatch; authorization failures stay quiet.
      if (
        error instanceof IdentityError &&
        isInferenceBudgetFailureCode(error.code)
      )
        logFailure(error);
      throw error;
    });
    try {
      let body = request.body;
      if (reservation.enforce && reservation.price && kind === "model") {
        const previous = (body as Record<string, unknown>).max_tokens;
        body = {
          ...(body as Record<string, unknown>),
          max_tokens: Math.min(
            safeCount(previous) ?? reservation.price.maxOutputTokens,
            reservation.price.maxOutputTokens,
          ),
        };
      }
      const response = await transport({
        ...request,
        body,
        beforeDispatch: async (start) => {
          if (!request.beforeDispatch)
            throw new IdentityError(403, "identity_forbidden");
          // The native domain guard holds the identity queue while calling start.
          // Re-entering serial here would deadlock that guard.
          await request.beforeDispatch(() => {
            store.dispatch(reservation.id);
            start();
          });
        },
      });
      let raw: unknown;
      try {
        raw = JSON.parse(response.text);
      } catch {
        raw = undefined;
      }
      let usage = inferenceUsage(raw, kind, reservation.price);
      if (
        (response.status < 200 || response.status >= 300) &&
        !gatewayTimeouts.has(response.status) &&
        usage.inputTokens === null &&
        usage.outputTokens === null &&
        usage.costMicros === null
      )
        // The provider rejected the request without a completion (for example
        // 429 or 5xx): nothing was generated, so it is settled as zero.
        usage = {
          inputTokens: 0,
          outputTokens: 0,
          costMicros: 0,
          costSource: "provider",
        };
      await serial(async () => {
        store.settle(reservation.id, usage);
      });
      // Counts and status only; the request, response and key never reach the log.
      operatorLog("model_call", {
        kind,
        model: selected.model.id,
        workspace: target.workspaceId,
        status: response.status,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ms: Math.round(performance.now() - started),
      });
      return response;
    } catch (error) {
      await serial(async () => {
        store.failed(reservation.id);
      });
      logFailure(error);
      throw error;
    }
  };
}
