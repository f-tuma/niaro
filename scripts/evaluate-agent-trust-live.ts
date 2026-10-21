import { createTransport } from "../apps/server-integrations/transport";
import {
  parseLiveTrustArguments,
  runLiveTrustEvaluation,
  scrubLiveTrustSecrets,
} from "../tests/agent-trust/live-cli";

async function main() {
  try {
    const options = parseLiveTrustArguments(process.argv.slice(2), process.env);
    if (options === "help") {
      console.log(
        "Usage: pnpm eval:trust:live -- --confirm-live --model MODEL --scenario ID [--scenario ID] --max-requests N --max-input-tokens N --max-output-tokens N --max-output-tokens-per-request N --max-cost-usd USD --input-usd-per-million USD --output-usd-per-million USD --json FILE [--repeat N]\nRequires NIARO_TRUST_MODEL_API_KEY. Currently supports OpenRouter only; the selected chat model is paid while decisions and business services stay synthetic. No defaults are provided for model, budget or scenarios. Input token counts use a local byte estimate; output uses requested max_tokens. Costs use caller-supplied rates/provider-reported usage. These local reservations are not provider-side hard limits. Select both EN and CS IDs for every quality case; quality scores are deterministic checks against synthetic records, with no LLM judge.",
      );
      return;
    }
    console.log(
      `Agent trust evaluation — LIVE chat model ${options.modelId}; scenarios ${options.selectedIds.join(", ")}; repetitions ${options.repeat}. Local request/token/cost reservations run before dispatch; provider-side charges may differ from supplied prices.`,
    );
    const result = await runLiveTrustEvaluation(
      options,
      createTransport(),
      (line) => console.log(line),
    );
    console.log(`Report: ${options.output}`);
    console.log(
      `${result.verdict.toUpperCase()}: ${result.report.summary.passed} passed, ${result.report.summary.failed} failed, ${result.report.summary.gaps} with gaps; ${result.report.summary.checks} checks.`,
    );
    console.log(
      `Observed ${result.usage.requests} model calls; provider-reported cost $${result.usage.providerReportedCostUsd.toFixed(6)}; rate-based estimate $${result.usage.rateEstimatedCostUsd.toFixed(6)}; usage uncertain: ${result.usage.uncertain}.`,
    );
    process.exitCode = result.exitCode;
  } catch (error) {
    const key = process.env.NIARO_TRUST_MODEL_API_KEY;
    const message =
      error instanceof Error ? error.message : "Trust evaluation failed";
    console.error(key ? scrubLiveTrustSecrets(message, [key]) : message);
    process.exitCode = 1;
  }
}

void main();
