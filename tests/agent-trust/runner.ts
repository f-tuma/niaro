import { performance } from "node:perf_hooks";
import type { ProbeResult, TrustScenario, TrustRuntimeProfile } from "./types";
import { withLiveTrustModel, type LiveTrustModel } from "./harness";

export type ScenarioResult = {
  id: string;
  title: string;
  status: "passed" | "failed" | "gap";
  durationMs: number;
  checks: ProbeResult[];
  observations: Record<string, unknown>;
};
export type TrustReport = {
  profile: "agent-trust/1";
  mode: "scripted-model" | "live-model";
  runtimeProfile: TrustRuntimeProfile;
  verdict: "passed" | "failed" | "incomplete";
  generatedAt: string;
  summary: {
    scenarios: number;
    passed: number;
    failed: number;
    gaps: number;
    checks: number;
  };
  limitations: string[];
  scenarios: ScenarioResult[];
};
const message = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 4000);

/** A broken scenario cannot suppress the remaining independent scenarios. */
export async function evaluateTrust(
  scenarios: TrustScenario[],
  onResult?: (result: ScenarioResult) => void,
  options: { timeoutMs?: number; liveModel?: LiveTrustModel } = {},
): Promise<TrustReport> {
  const timeoutMs = options.timeoutMs ?? 15000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1)
    throw Error("Invalid scenario timeout");
  if (!scenarios.length) throw Error("No scenarios selected");
  if (new Set(scenarios.map((s) => s.id)).size !== scenarios.length)
    throw Error("Duplicate scenario IDs");
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    const started = performance.now();
    const checks: ProbeResult[] = [];
    const observations: Record<string, unknown> = {};
    const cleanup: (() => void | Promise<void>)[] = [];
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const known = new Set<string>();
    const record = (result: ProbeResult) => {
      if (known.has(result.id)) throw Error(`Duplicate check ID: ${result.id}`);
      known.add(result.id);
      checks.push(result);
    };
    try {
      const execution = withLiveTrustModel(options.liveModel, () =>
        scenario.run({
          signal: abort.signal,
          defer: (fn) => {
            cleanup.push(fn);
          },
          check: async (id, description, assertion) => {
            try {
              await assertion();
            } catch (error) {
              record({
                id,
                description,
                status: "failed",
                evidence: message(error),
              });
              throw error;
            }
            record({ id, description, status: "passed" });
          },
          observe: (key, value) => {
            if (Object.hasOwn(observations, key))
              throw Error(`Duplicate observation: ${key}`);
            observations[key] = value;
          },
          gap: (id, description, evidence) =>
            record({ id, description, status: "gap", evidence }),
        }),
      );
      // This referenced timer keeps Node alive when a broken scenario awaits
      // a promise without I/O handles. A hang must never look like PASS.
      await Promise.race([
        execution,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = Error(`Scenario deadline exceeded (${timeoutMs} ms)`);
            abort.abort(error);
            reject(error);
          }, timeoutMs);
        }),
      ]);
      if (!checks.length)
        throw Error("Scenario completed without checking any behavior");
    } catch (error) {
      if (!checks.some((c) => c.status === "failed"))
        checks.push({
          id: "scenario_execution",
          description: "Scenario setup, execution and cleanup complete",
          status: "failed",
          evidence: message(error),
        });
    } finally {
      clearTimeout(timer);
      abort.abort();
      for (const close of cleanup.reverse()) {
        try {
          await close();
        } catch (error) {
          checks.push({
            id: "scenario_cleanup",
            description: "Scenario resources are released",
            status: "failed",
            evidence: message(error),
          });
        }
      }
    }
    const status = checks.some((c) => c.status === "failed")
      ? "failed"
      : checks.some((c) => c.status === "gap")
        ? "gap"
        : "passed";
    const result: ScenarioResult = {
      id: scenario.id,
      title: scenario.title,
      status,
      durationMs: Math.round(performance.now() - started),
      checks,
      observations,
    };
    results.push(result);
    onResult?.(result);
  }
  const summary = {
    scenarios: results.length,
    passed: results.filter((r) => r.status === "passed").length,
    failed: results.filter((r) => r.status === "failed").length,
    gaps: results.filter((r) => r.status === "gap").length,
    checks: results.reduce((n, r) => n + r.checks.length, 0),
  };
  return {
    profile: "agent-trust/1",
    mode: options.liveModel ? "live-model" : "scripted-model",
    runtimeProfile: "mastra-1",
    verdict: summary.failed ? "failed" : summary.gaps ? "incomplete" : "passed",
    generatedAt: new Date().toISOString(),
    summary,
    limitations: [
      options.liveModel
        ? "The selected chat model is measured against synthetic services and scripted decision checks. This does not measure live CRM/calendar behavior, and does not prove generalized truthfulness or safety outside these scenarios."
        : "Native Mastra loop with a scripted provider and decision checker: no measurement of a real model's reasoning, truthfulness, memory recall or generated UI quality.",
      options.liveModel
        ? "Real public CatalogRuntime, Mastra Agent/Memory/checkpoints, Niaro catalog/controller, scoped memory and file-backed workflow stores. Only the selected chat model is live and paid; decision checks and business service responses remain synthetic, so no real CRM/calendar effect occurs."
        : "Real public CatalogRuntime, Mastra Agent/Memory/checkpoints, Niaro catalog/controller, scoped memory and file-backed workflow stores; authenticated actors and all model/service transport responses are synthetic. No real business effect or paid inference.",
      "Direct command boundary: HTTP authentication, UI rendering, physical devices and operating-system process crashes are outside this runner. Restart closes and reopens durable stores; interruption is injected at recorded execution boundaries.",
      "The memory retention clock is advanced in probes; native conversation state and catalog receipt clocks use wall time. This runner does not measure retention expiry or latency of the native conversation store.",
    ],
    scenarios: results,
  };
}
