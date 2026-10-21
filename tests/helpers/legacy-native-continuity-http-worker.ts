import { z } from "zod";
import {
  historicalModes,
  continuityCases,
  runLegacyContinuityHttpCase,
} from "./legacy-native-continuity-http";
runLegacyContinuityHttpCase(
  z.enum(historicalModes).parse(process.argv[2]),
  z.enum(continuityCases).parse(process.argv[3] ?? "direct"),
)
  .then((result) => console.log(JSON.stringify(result)))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
