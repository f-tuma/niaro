import { z } from "zod";
import {
  historicalModes,
  historicalOutcomes,
  runHistoricalHttpCase,
} from "./legacy-catalog-http";

async function main() {
  const mode = z.enum(historicalModes).parse(process.argv[2]);
  const outcome = z.enum(historicalOutcomes).parse(process.argv[3]);
  const result = await runHistoricalHttpCase(mode, outcome);
  console.log(JSON.stringify(result));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
