// Offline child-process fixture. Never imported by the production application.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runProductionDomainCrash } from "./mastra-domain-crash";

const directory = process.argv[2];
const mode = process.argv[3];
if (!directory || !mode)
  throw new Error("TEST crash fixture arguments missing");

function report(value: unknown) {
  writeFileSync(join(directory!, "outcome.json"), JSON.stringify(value));
}

// Native offline execution can wait on promises without a referenced socket.
// Keep the fixture alive until it settles, so a silent event-loop exit cannot
// masquerade as a successful process recovery.
const keepAlive = setInterval(() => {}, 1000);
runProductionDomainCrash(directory, mode)
  .then(report)
  .catch((error: unknown) => {
    report({ error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  })
  .finally(() => clearInterval(keepAlive));
