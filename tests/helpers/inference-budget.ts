import { DatabaseSync } from "node:sqlite";
import { InferenceBudgetStore } from "../../apps/server-identity/inference-budget";
import {
  ProviderSchema,
  CatalogModelSchema,
} from "../../packages/protocol/service-catalog";
import type { InferenceBudgetSettings } from "../../packages/protocol/inference-budget";

export const budgetTarget = {
  organizationId: "TEST-org",
  workspaceId: "TEST-workspace",
  userId: "TEST-alice",
};
export const budgetSelection = {
  key: "TEST-key",
  provider: ProviderSchema.parse({
    id: "TEST-provider",
    revision: 1,
    name: "TEST provider",
    url: "https://provider.example.test/v1",
    enabled: true,
    dailyRequestLimit: 1000,
    hasCredential: true,
    requestsToday: 0,
  }),
  model: CatalogModelSchema.parse({
    id: "TEST-model",
    revision: 1,
    providerId: "TEST-provider",
    name: "TEST model",
    model: "TEST/model",
    enabled: true,
    tools: true,
  }),
};
export const budgetSettings: InferenceBudgetSettings = {
  mode: "enforce",
  maxTokens: 10000,
  maxCostMicros: 10000,
  prices: [
    {
      modelId: budgetSelection.model.id,
      modelRevision: 1,
      providerRevision: 1,
      maxInputTokens: 2048,
      maxOutputTokens: 100,
      inputMicrosPerMillion: 1000000,
      outputMicrosPerMillion: 2000000,
    },
  ],
};
export function openBudget(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS agent_workspace(id TEXT PRIMARY KEY, organization_id TEXT); INSERT OR IGNORE INTO agent_workspace VALUES('TEST-workspace','TEST-org'),('TEST-other-workspace','TEST-org');",
  );
  return { db, store: new InferenceBudgetStore(db) };
}
