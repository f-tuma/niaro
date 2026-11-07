/**
 * Q1: provider + model from a Niaro runtime config, never hardcoded.
 *  A) Two OpenAI-compatible providers on a local stub (bearer + custom header,
 *     and Azure-style `api-key` header), model chosen per conversation and
 *     switched between runs; a role-picked model called directly from code.
 *  B) One real tool-calling round trip through OpenRouter with the provider
 *     and chat-role model read from the dev identity database.
 */
import { createModels, getModelType } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { AssistantEntry, createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Read-only imports of Niaro's real protocol data: presets and role defaults.
// The repo root is CommonJS, so tsx loads these as CJS: take the named exports off the namespace.
import * as providersModule from "../../../packages/protocol/providers.ts";
import * as policyModule from "../../../packages/protocol/model-policy.ts";
const { PROVIDER_PRESETS } = ((providersModule as any).default ?? providersModule) as typeof providersModule;
const { ROLE_DEFAULTS } = ((policyModule as any).default ?? policyModule) as typeof policyModule;
import { loadDevOpenRouter } from "../src/dev-catalog.ts";
import { check, ctx, printTranscript } from "../src/kit.ts";
import { niaroProvider, type NiaroProviderConfig } from "../src/niaro-provider.ts";
import { startStub } from "../src/stub-server.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const lookupContact = defineTool({
  name: "lookup_contact",
  description: "Look up a contact by name in the CRM",
  parameters: obj({ name: str() }),
  execute: async (args) => ({ output: [{ type: "text", text: `${args.name} Lovelace, ada@example.test` }] }),
});
const Crm = defineExtension({ name: "crm", tools: [lookupContact] });

async function partA() {
  console.log("\n=== Q1-A: arbitrary OpenAI-compatible base URLs, auth styles, custom headers, per-run model ===");
  const stub = await startStub();
  const custom = PROVIDER_PRESETS.find((p) => p.id === "custom")!;
  const azure = PROVIDER_PRESETS.find((p) => p.id === "azure")!;
  const ollama = PROVIDER_PRESETS.find((p) => p.id === "ollama")!;
  // Runtime config objects shaped like Niaro's catalog rows (presets fill auth/dialect; URL is the stub).
  const gateway: NiaroProviderConfig = {
    id: "prov-gateway",
    name: "Gateway (custom preset)",
    url: stub.url("/gateway/v1"),
    auth: custom.auth,
    dialect: custom.dialect,
    key: "sk-fake-gateway",
    headers: { "x-niaro-workspace": "ws-123" },
    models: [{ catalogId: "cat-model-a", model: "vendor/model-a", tools: true, maxTokens: 256 }],
  };
  const azureLike: NiaroProviderConfig = {
    id: "prov-azure",
    name: "Azure-like (azure preset auth)",
    url: stub.url("/azure/openai/v1"),
    auth: azure.auth,
    dialect: azure.dialect,
    key: "fake-azure-key",
    models: [{ catalogId: "cat-model-b", model: "deployment-b", tools: true, maxTokens: 128 }],
  };
  const local: NiaroProviderConfig = {
    id: "prov-local",
    name: "Local (ollama preset)",
    url: stub.url("/local/v1"),
    auth: ollama.auth,
    dialect: ollama.dialect,
    key: "",
    local: true,
    models: [{ catalogId: "cat-model-c", model: "llama-local", tools: true }],
  };
  const models = createModels();
  for (const p of [gateway, azureLike, local]) models.setProvider(niaroProvider(p));

  const registry = createRegistry();
  registry.install(Crm);
  const harness = await Harness.open(new MemoryStorage(), { models, registry, identity: { attribution: null } }, ctx);
  const root = await harness.root(ctx, { agent: { model: { provider: gateway.id, modelId: "cat-model-a" } } });
  const s1 = await (await root.submit({ type: "input", content: "Find Ada" }, ctx)).wait(ctx);
  // Role policy switches the conversation's model for the next run (e.g. a member preset/tier).
  await root.configure({ model: { provider: azureLike.id, modelId: "cat-model-b" } }, ctx);
  const s2 = await (await root.submit({ type: "input", content: "Find Ada again" }, ctx)).wait(ctx);
  await printTranscript(root);
  console.log("  stub saw:");
  for (const r of stub.requests)
    console.log(
      `    ${r.path} model=${r.model} authorization=${r.authorization ? r.authorization.replace(/(Bearer ).*/, "$1<redacted>") : "-"} api-key=${r.apiKeyHeader ? "<set>" : "-"} x-niaro-workspace=${r.customHeader ?? "-"} tools=${r.tools.join(",")} max_tokens=${r.maxTokens}`,
    );
  check("run 1 answered", s1.status === "done");
  check("run 2 answered", s2.status === "done");
  const gw = stub.requests.filter((r) => r.path.startsWith("/gateway/"));
  const az = stub.requests.filter((r) => r.path.startsWith("/azure/"));
  check("gateway: bearer key + custom header + wire model name", gw.length === 2 && gw.every((r) => r.authorization === "Bearer sk-fake-gateway" && r.customHeader === "ws-123" && r.model === "vendor/model-a"));
  check("azure-style: key in api-key header, bearer suppressed", az.length === 2 && az.every((r) => r.apiKeyHeader === "fake-azure-key" && !r.authorization && r.model === "deployment-b"), az.map((r) => `authorization=${r.authorization ? "present" : "absent"}`).join(","));

  // A role call outside the conversation (checker/selector): code resolves the role and calls pi-ai directly.
  const policy = { roles: { chat: { models: ["cat-model-a"] }, selector: { models: ["cat-model-c"] } } } as const;
  const roleModel = (role: string): string | undefined =>
    (policy.roles as any)[role]?.models?.[0] ?? ((ROLE_DEFAULTS as any)[role] ? roleModel((ROLE_DEFAULTS as any)[role]) : undefined);
  const checkerId = roleModel("checker")!; // checker -> selector by Niaro's ROLE_DEFAULTS
  const checker = models.getModel(local.id, checkerId)!;
  const answer = await models.completeSimple(checker, {
    messages: [{ role: "user", content: "check this", timestamp: Date.now() }],
    tools: [lookupContact],
  });
  const lr = stub.requests.at(-1)!;
  console.log(`  checker role -> ${checkerId} (${getModelType(checker)}) path=${lr.path} model=${lr.model} authorization=${lr.authorization ?? "-"} stop=${answer.stopReason}`);
  check("keyless local provider: no Authorization header", lr.path.startsWith("/local/") && !lr.authorization);
  await harness.close(ctx);
  await stub.close();
}

async function partB() {
  console.log("\n=== Q1-B: real OpenRouter tool-calling round trip from the dev identity DB ===");
  let choice;
  try {
    choice = loadDevOpenRouter(repoRoot);
  } catch (error) {
    console.log(`SKIP real OpenRouter: ${(error as Error).message}`);
    return;
  }
  const p = choice.provider;
  // Prices: Niaro's price table is the source of truth; for the spike we take pi-ai's OpenRouter catalog price.
  const catalog = openrouterProvider().getModels();
  for (const m of p.models) {
    const known = catalog.find((c) => c.id === m.model);
    if (known) m.cost = known.cost as any;
  }
  const chat = p.models.find((m) => m.catalogId === choice.chatCatalogId)!;
  console.log(`  provider: ${p.name} url=${p.url} dialect=${p.dialect} auth=${p.auth.type} key=${p.key ? "<loaded, " + p.key.length + " chars>" : "<missing>"}`);
  console.log(`  chat model: catalog ${chat.catalogId} -> ${chat.model} (${choice.notes.join("; ")}) price/Mtok in=${chat.cost?.input} out=${chat.cost?.output}`);
  const models = createModels();
  models.setProvider(niaroProvider(p));
  let calls = 0;
  const weather = defineTool({
    name: "get_weather",
    description: "Current weather for a city",
    parameters: obj({ city: str() }),
    execute: async (args) => {
      calls++;
      return { output: [{ type: "text", text: `${args.city}: 12 °C, cloudy` }] };
    },
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "weather", tools: [weather] }));
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry, identity: { attribution: { name: "niaro-spike", url: "https://aa.f-tuma.dev" } }, settings: { retry: { maxRetries: 0 } } },
    ctx,
  );
  const root = await harness.root(ctx, { agent: { model: { provider: p.id, modelId: chat.catalogId }, maxTurns: 3 } });
  const started = Date.now();
  const settled = await (
    await root.submit({ type: "input", content: "Call get_weather for Prague, then answer in one short sentence." }, ctx)
  ).wait(ctx);
  console.log(`  settled: ${settled.status} in ${Date.now() - started} ms${settled.status === "unanswered" ? " reason=" + (settled as any).reason : ""}`);
  await printTranscript(root);
  const usage = await harness.usage(ctx);
  for (const [k, u] of Object.entries(usage.models))
    console.log(`  pi.usage ${k}: input=${u.input} output=${u.output} cacheRead=${u.cacheRead} cost.total=$${u.cost.total.toFixed(6)}`);
  check("real OpenRouter run answered", settled.status === "done");
  check("tool executed exactly once", calls === 1, `calls=${calls}`);
  await harness.close(ctx);
}

await partA();
if (process.env.SKIP_REAL) console.log("\nSKIP Q1-B (SKIP_REAL set)");
else await partB();
