import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { budgetedInferenceTransport } from "../../apps/server-identity/inference-budget";
import {
  budgetTarget,
  budgetSelection,
  budgetSettings,
  openBudget,
} from "./inference-budget";

const directory = process.argv[2]!;
const { store } = openBudget(join(directory, "budget.sqlite"));
store.savePolicy(
  budgetTarget.organizationId,
  budgetTarget.workspaceId,
  0,
  budgetSettings,
);
let providerResponded = false;
const transport = budgetedInferenceTransport(
  async (request) => {
    await request.beforeDispatch!(() => {});
    writeFileSync(
      join(directory, "provider-response.json"),
      JSON.stringify({
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.00002 },
      }),
    );
    providerResponded = true;
    return {
      status: 200,
      headers: {},
      text: '{"usage":{"prompt_tokens":10,"completion_tokens":5,"cost":0.00002}}',
    };
  },
  store,
  "TEST-root",
  budgetTarget,
  budgetSelection,
  "model",
  async (run) => {
    // Kill after a provider response reached the process, before its ledger commit.
    if (providerResponded) process.kill(process.pid, "SIGKILL");
    return run();
  },
  async () => {},
  () => 0,
);
void transport({
  url: "https://provider.example.test/v1/chat/completions",
  body: {},
  beforeDispatch: async (start) => start(),
}).catch((error: unknown) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
