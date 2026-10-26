import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { IntegrationTransport } from "../../apps/server-integrations/transport";
import { createLiveTrustBudget, type LiveTrustBudgetCaps } from "./live-budget";
import { evaluateTrust, type TrustReport } from "./runner";
import { trustScenarios } from "./scenarios";
import {
  trustQualityScenarios,
  validateBalancedQualitySelection,
  type TrustQualityScenario,
} from "./quality-scenarios";
import { trustUiScenarios } from "./ui-scenarios";
import { trustRobustnessScenarios } from "./robustness-scenarios";

export const LIVE_TRUST_PROVIDER_URL = "https://openrouter.ai/api/v1";
/** A live turn makes several model calls; the scripted 15 s deadline is too short. */
export const LIVE_TRUST_SCENARIO_TIMEOUT_MS = 180_000;

export type LiveTrustOptions = {
  modelId: string;
  apiKey: string;
  selectedIds: string[];
  repeat: number;
  caps: LiveTrustBudgetCaps;
  output: string;
};

const availableScenarios = [
  ...trustScenarios,
  ...trustQualityScenarios,
  ...trustUiScenarios,
  ...trustRobustnessScenarios,
];
const valuedFlags = new Set([
  "--model",
  "--scenario",
  "--max-requests",
  "--max-input-tokens",
  "--max-output-tokens",
  "--max-output-tokens-per-request",
  "--max-cost-usd",
  "--input-usd-per-million",
  "--output-usd-per-million",
  "--json",
  "--repeat",
]);

function positiveInteger(value: string, flag: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function nonnegativeNumber(value: string, flag: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error(`${flag} must be a non-negative number`);
  return parsed;
}

export function scrubLiveTrustSecrets(
  value: unknown,
  secrets: string[],
): unknown {
  if (typeof value === "string")
    return secrets
      .filter(Boolean)
      .reduce(
        (result, secret) => result.split(secret).join("[REDACTED]"),
        value,
      );
  if (Array.isArray(value))
    return value.map((entry) => scrubLiveTrustSecrets(entry, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        scrubLiveTrustSecrets(key, secrets),
        scrubLiveTrustSecrets(entry, secrets),
      ]),
    );
  return value;
}

export function parseLiveTrustArguments(
  rawArgs: string[],
  env: Record<string, string | undefined>,
): LiveTrustOptions | "help" {
  const args = [...rawArgs];
  if (args[0] === "--") args.shift();
  const values = new Map<string, string[]>();
  let confirms = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--help") {
      if (args.length !== 1)
        throw new Error("--help cannot be combined with other arguments");
      return "help";
    }
    if (arg === "--confirm-live") {
      confirms += 1;
      continue;
    }
    if (!valuedFlags.has(arg)) throw new Error(`Unknown argument: ${arg}`);
    const value = args[++index];
    if (!value || value.startsWith("--"))
      throw new Error(`Missing value for ${arg}`);
    values.set(arg, [...(values.get(arg) ?? []), value]);
  }

  const one = (flag: string) => {
    const entries = values.get(flag) ?? [];
    if (entries.length !== 1)
      throw new Error(`${flag} must be specified exactly once`);
    return entries[0]!;
  };
  if (confirms !== 1)
    throw new Error(
      "Pass --confirm-live exactly once to enable paid inference",
    );
  const selectedIds = values.get("--scenario") ?? [];
  if (!selectedIds.length)
    throw new Error(
      "Select one or more scenarios with --scenario; none run by default",
    );
  if (new Set(selectedIds).size !== selectedIds.length)
    throw new Error("Each --scenario must be selected only once");
  for (const id of selectedIds)
    if (!availableScenarios.some((scenario) => scenario.id === id))
      throw new Error(`Unknown scenario: ${id}`);
  for (const matrix of [
    trustQualityScenarios,
    trustUiScenarios,
    trustRobustnessScenarios,
  ])
    validateBalancedQualitySelection(
      matrix.filter((scenario) => selectedIds.includes(scenario.id)),
    );

  const modelId = one("--model").trim();
  if (!modelId || /\s/.test(modelId))
    throw new Error("--model must name one exact provider model ID");
  const apiKey = env.NIARO_TRUST_MODEL_API_KEY?.trim();
  if (!apiKey)
    throw new Error("NIARO_TRUST_MODEL_API_KEY must be set in the environment");
  const caps = {
    maxRequests: positiveInteger(one("--max-requests"), "--max-requests"),
    maxInputTokens: positiveInteger(
      one("--max-input-tokens"),
      "--max-input-tokens",
    ),
    maxOutputTokens: positiveInteger(
      one("--max-output-tokens"),
      "--max-output-tokens",
    ),
    maxOutputTokensPerRequest: positiveInteger(
      one("--max-output-tokens-per-request"),
      "--max-output-tokens-per-request",
    ),
    maxCostUsd: nonnegativeNumber(one("--max-cost-usd"), "--max-cost-usd"),
    inputUsdPerMillionTokens: nonnegativeNumber(
      one("--input-usd-per-million"),
      "--input-usd-per-million",
    ),
    outputUsdPerMillionTokens: nonnegativeNumber(
      one("--output-usd-per-million"),
      "--output-usd-per-million",
    ),
  };
  if (caps.maxCostUsd <= 0)
    throw new Error("--max-cost-usd must be greater than zero");
  if (caps.maxOutputTokensPerRequest > caps.maxOutputTokens)
    throw new Error(
      "--max-output-tokens-per-request cannot exceed --max-output-tokens",
    );
  if (
    caps.inputUsdPerMillionTokens === 0 &&
    caps.outputUsdPerMillionTokens === 0
  )
    throw new Error("At least one live eval token price must be non-zero");
  const repeat = values.has("--repeat")
    ? positiveInteger(one("--repeat"), "--repeat")
    : 1;
  return {
    modelId,
    apiKey,
    selectedIds,
    repeat,
    caps,
    output: resolve(one("--json")),
  };
}

function qualitySummary(
  report: TrustReport,
  selectedIds: string[],
  matrix: TrustQualityScenario[] = trustQualityScenarios,
  prefix = "quality",
) {
  const selectedQuality = matrix.filter((scenario) =>
    selectedIds.includes(scenario.id),
  );
  const qualityRuns = report.scenarios.flatMap((scenario) => {
    const baseId = scenario.id.replace(/\.repeat-\d+$/, "");
    const definition = selectedQuality.find(
      (candidate) => candidate.id === baseId,
    );
    if (!definition) return [];
    const observed = scenario.observations.quality;
    const quality =
      observed && typeof observed === "object"
        ? (observed as { caseId: string; language: string })
        : definition.quality;
    return [{ scenario, quality }];
  });
  if (!qualityRuns.length) return undefined;
  const languages = [
    ...new Set(qualityRuns.map((run) => run.quality.language)),
  ].sort();
  const byLanguage = Object.fromEntries(
    languages.map((language) => {
      const rows = qualityRuns.filter(
        (run) => run.quality.language === language,
      );
      return [
        language,
        {
          cases: rows.length,
          passed: rows.filter((run) => run.scenario.status === "passed").length,
          failed: rows.filter((run) => run.scenario.status === "failed").length,
          incomplete: rows.filter((run) => run.scenario.status === "gap")
            .length,
        },
      ];
    }),
  );
  const dimensions = Object.fromEntries(
    [
      ...new Set(
        qualityRuns.flatMap((run) =>
          run.scenario.checks.map((check) =>
            check.id.startsWith(`${prefix}.`)
              ? check.id.split(".")[1]!
              : undefined,
          ),
        ),
      ),
    ]
      .filter((dimension): dimension is string => !!dimension)
      .map((dimension) => {
        const checks = qualityRuns.flatMap((run) =>
          run.scenario.checks.filter((check) =>
            check.id.startsWith(`${prefix}.${dimension}.`),
          ),
        );
        return [
          dimension,
          {
            checks: checks.length,
            passed: checks.filter((check) => check.status === "passed").length,
            failed: checks.filter((check) => check.status === "failed").length,
            incomplete: checks.filter((check) => check.status === "gap").length,
          },
        ];
      }),
  );
  const incompleteWithoutDimension = qualityRuns
    .filter(
      ({ scenario }) =>
        scenario.status !== "passed" &&
        !scenario.checks.some((check) => check.id.startsWith(`${prefix}.`)),
    )
    .map(({ scenario, quality }) => ({
      scenarioId: scenario.id,
      caseId: quality.caseId,
      language: quality.language,
      status: scenario.status,
    }));
  return {
    runs: qualityRuns.length,
    byLanguage,
    dimensions,
    incompleteWithoutDimension,
    interpretation:
      "Deterministic assertions against fixture-owned synthetic ground truth; no LLM judge. Each selected case contributes one fixed sample per language; this pass rate is not a statistical estimate or general fluency measure. Failed checks are not averaged away across languages. Dimension totals include recorded checks; early failures without checks are listed separately.",
  };
}

type UiObservation = {
  expected: boolean;
  present: boolean;
  repairs: number;
  components: string[];
  programChars: number;
};
/** How often generated UI appears where it helps, where it does not, and how often it needed repair. */
function uiSummary(report: TrustReport, selectedIds: string[]) {
  const score = qualitySummary(report, selectedIds, trustUiScenarios, "ui");
  if (!score) return undefined;
  const runs = report.scenarios.flatMap((scenario) => {
    const ui = scenario.observations.ui as UiObservation | undefined;
    return ui && scenario.id.startsWith("ui.") ? [ui] : [];
  });
  const helpful = runs.filter((run) => run.expected);
  const simple = runs.filter((run) => !run.expected);
  const withUi = runs.filter((run) => run.present);
  const components = new Map<string, number>();
  for (const run of withUi)
    for (const name of run.components)
      components.set(name, (components.get(name) ?? 0) + 1);
  return {
    ...score,
    usage: {
      helpfulCases: helpful.length,
      uiWhereHelpful: helpful.filter((run) => run.present).length,
      simpleCases: simple.length,
      needlessUi: simple.filter((run) => run.present).length,
      programs: withUi.length,
      programsRepaired: runs.filter((run) => run.repairs > 0).length,
      averageProgramChars: withUi.length
        ? Math.round(
            withUi.reduce((total, run) => total + run.programChars, 0) /
              withUi.length,
          )
        : 0,
      components: Object.fromEntries(
        [...components].sort((a, b) => b[1] - a[1]),
      ),
    },
    interpretation:
      "Deterministic checks of generated UI against synthetic records: whether UI appears where a visual helps and not for a simple answer, whether the server admitted it without repair, whether text and UI carry only facts from the data, text brevity and UI language. The consistency checker is scripted to accept, so its judgment is not measured here. One fixed sample per case and language; not a statistical estimate.",
  };
}

function timingSummary(durations: readonly number[]) {
  const sorted = [...durations].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted.length
      ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
      : 0;
  return {
    runs: sorted.length,
    medianMs: at(0.5),
    p90Ms: at(0.9),
    maxMs: sorted.at(-1) ?? 0,
  };
}

export function buildLiveTrustReport(
  report: TrustReport,
  options: LiveTrustOptions,
  usage: ReturnType<ReturnType<typeof createLiveTrustBudget>["snapshot"]>,
) {
  const qualityScore = qualitySummary(report, options.selectedIds);
  const uiScore = uiSummary(report, options.selectedIds);
  const verdict = report.summary.failed
    ? "failed"
    : report.summary.gaps || usage.uncertain
      ? "incomplete"
      : "passed";
  const selectedQuality = [
    ...trustQualityScenarios,
    ...trustUiScenarios,
  ].filter((scenario) => options.selectedIds.includes(scenario.id));
  return {
    ...report,
    verdict,
    live: {
      provider: LIVE_TRUST_PROVIDER_URL,
      modelId: options.modelId,
      verifiedModelIds: usage.actualModelIds,
      selection: {
        scenarioIds: options.selectedIds,
        qualityCases: [
          ...new Set(
            selectedQuality.map((scenario) => scenario.quality.caseId),
          ),
        ],
        languages: [
          ...new Set(
            selectedQuality.map((scenario) => scenario.quality.language),
          ),
        ].sort(),
        repetitionCount: options.repeat,
        scenarioRuns: report.scenarios.map((scenario) => ({
          id: scenario.id,
          durationMs: scenario.durationMs,
        })),
      },
      // How long an answer takes end to end, so a loop change can be judged
      // on time as well as on outcome.
      timing: timingSummary(report.scenarios.map((s) => s.durationMs)),
      pricingBasis:
        "caller-supplied per-million-token rates; verify against provider before run; local pre-dispatch reservation is not a provider-side spending guarantee",
      caps: options.caps,
      usage,
      ...(qualityScore ? { qualityScore } : {}),
      ...(uiScore ? { uiScore } : {}),
    },
  };
}

function preparePrivateLiveTrustReport(path: string) {
  const target = resolve(path);
  try {
    if (statSync(target).isDirectory())
      throw new Error("Live report path must name a file, not a directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = join(
    dirname(target),
    `.${basename(target)}.${randomUUID()}.tmp`,
  );
  const reservation = openSync(temporary, "wx", 0o600);
  closeSync(reservation);
  return {
    commit(report: unknown, apiKey: string) {
      const fd = openSync(temporary, "w", 0o600);
      try {
        writeFileSync(
          fd,
          JSON.stringify(scrubLiveTrustSecrets(report, [apiKey]), null, 2) +
            "\n",
        );
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      chmodSync(temporary, 0o600);
      renameSync(temporary, target);
    },
    cleanup() {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}

export function writePrivateLiveTrustReport(
  path: string,
  report: unknown,
  apiKey: string,
) {
  const target = preparePrivateLiveTrustReport(path);
  try {
    target.commit(report, apiKey);
  } finally {
    target.cleanup();
  }
}

export async function runLiveTrustEvaluation(
  options: LiveTrustOptions,
  transport: IntegrationTransport,
  onResult?: (line: string) => void,
) {
  const output = preparePrivateLiveTrustReport(options.output);
  try {
    const scenarios = Array.from({ length: options.repeat }, (_, repetition) =>
      availableScenarios
        .filter((scenario) => options.selectedIds.includes(scenario.id))
        .map((scenario) => ({
          ...scenario,
          id:
            options.repeat === 1
              ? scenario.id
              : `${scenario.id}.repeat-${repetition + 1}`,
          title:
            options.repeat === 1
              ? scenario.title
              : `${scenario.title} (repetition ${repetition + 1})`,
        })),
    ).flat();
    const budget = createLiveTrustBudget({
      providerUrl: LIVE_TRUST_PROVIDER_URL,
      modelId: options.modelId,
      apiKey: options.apiKey,
      caps: options.caps,
      transport,
    });
    const report = await evaluateTrust(
      scenarios,
      (result) => {
        onResult?.(
          `${result.status.toUpperCase()} ${result.id}: ${result.title}`,
        );
        for (const check of result.checks.filter(
          (entry) => entry.status !== "passed",
        ))
          onResult?.(
            `  ${check.status.toUpperCase()} ${check.id}: ${check.description}\n  ${JSON.stringify(scrubLiveTrustSecrets(check.evidence, [options.apiKey]))}`,
          );
      },
      { liveModel: budget.model, timeoutMs: LIVE_TRUST_SCENARIO_TIMEOUT_MS },
    );
    const usage = budget.snapshot();
    const liveReport = buildLiveTrustReport(report, options, usage);
    output.commit(liveReport, options.apiKey);
    const verdict = liveReport.verdict;
    const exitCode =
      report.summary.failed || usage.uncertain
        ? 1
        : report.summary.gaps
          ? 2
          : 0;
    return { report: liveReport, usage, verdict, exitCode };
  } finally {
    output.cleanup();
  }
}
