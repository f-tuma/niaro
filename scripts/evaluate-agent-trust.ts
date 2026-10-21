import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateTrust } from "../tests/agent-trust/runner";
import { trustScenarios } from "../tests/agent-trust/scenarios";

async function main() {
  const args = process.argv.slice(2);
  const selected = new Set<string>();
  let output: string | undefined,
    allowGaps = false,
    list = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--allow-known-gaps") allowGaps = true;
    else if (arg === "--list") list = true;
    else if (arg === "--json" || arg === "--scenario") {
      const value = args[++i];
      if (!value || value.startsWith("--"))
        throw Error(`Missing value for ${arg}`);
      if (arg === "--json") output = resolve(value);
      else selected.add(value);
    } else if (arg === "--help") {
      console.log(
        "Usage: pnpm eval:trust [--list] [--scenario ID] [--json FILE] [--allow-known-gaps]\nSynthetic inference only. Exit 0 = pass; 1 = failed; 2 = known gaps. --allow-known-gaps permits exit 0 only when there are no failures.",
      );
      return;
    } else throw Error(`Unknown option: ${arg}`);
  }
  for (const id of selected)
    if (!trustScenarios.some((s) => s.id === id))
      throw Error(`Unknown scenario: ${id}`);
  const scenarios = selected.size
    ? trustScenarios.filter((s) => selected.has(s.id))
    : trustScenarios;
  if (list) {
    scenarios.forEach((s) => console.log(`${s.id}: ${s.title}`));
    return;
  }
  console.log(
    "Agent trust evaluation — SCRIPTED MODEL; application mechanics only.",
  );
  const report = await evaluateTrust(scenarios, (result) => {
    console.log(`${result.status.toUpperCase()} ${result.id}: ${result.title}`);
    for (const check of result.checks.filter((c) => c.status !== "passed"))
      console.log(
        `  ${check.status.toUpperCase()} ${check.id}: ${check.description}\n  ${JSON.stringify(check.evidence)}`,
      );
  });
  if (output) {
    writeFileSync(output, JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
    });
    console.log(`Report: ${output}`);
  }
  console.log(
    `${report.verdict.toUpperCase()}: ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.gaps} with gaps; ${report.summary.checks} checks.`,
  );
  report.limitations.forEach((item) => console.log(`Limit: ${item}`));
  process.exitCode = report.summary.failed
    ? 1
    : report.summary.gaps && !allowGaps
      ? 2
      : 0;
}
void main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Trust evaluation failed",
  );
  process.exitCode = 1;
});
