import { z } from "zod";
import {
  budgetFailureScenarios,
  runNativeBudgetFailureCase,
} from "./native-budget-failure-http";

async function main() {
  const scenario = z.enum(budgetFailureScenarios).parse(process.argv[2]);
  const language = z.enum(["en", "cs"]).parse(process.argv[3]);
  console.log(
    JSON.stringify(await runNativeBudgetFailureCase(scenario, language)),
  );
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
