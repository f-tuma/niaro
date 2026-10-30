/** Synthetic controlled-output logic evaluation. No real account, credential or external provider. */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { MemoryStore } from "../apps/server-identity/memory";
import { ProfileCursorStore } from "../apps/server-identity/profile-cursor";
import { ProfileInference } from "../apps/server-identity/profile-inference";
import { ProfileLearner } from "../apps/server-identity/profile-learner";
import { InferenceBudgetStore } from "../apps/server-identity/inference-budget";
import {
  MemorySettingsSchema,
  type ObservationSectionSchema,
} from "../packages/protocol/memory";
import {
  ProviderSchema,
  CatalogModelSchema,
} from "../packages/protocol/service-catalog";
import type { z } from "zod";
import type { ProfileSourceRef } from "../apps/server-identity/profile-material";
const dataset = JSON.parse(
  readFileSync("tests/fixtures/profile-extraction.json", "utf8"),
) as {
  syntheticOnly: boolean;
  fixtures: {
    id: string;
    language: string;
    kind: string;
    text: string;
    section?: z.infer<typeof ObservationSectionSchema>;
    personal?: boolean;
    personalThings?: "keep" | "drop";
    actions?: { service: string; action: string }[];
    expected: string[];
    forbidden: string[];
  }[];
};
if (!dataset.syntheticOnly || process.argv.includes("--live"))
  throw Error("profile_eval_synthetic_only_no_designated_live_model");
async function main() {
  const rows = [];
  for (const item of dataset.fixtures) {
    const db = new DatabaseSync(":memory:");
    db.exec(
      "PRAGMA foreign_keys=ON;CREATE TABLE organization(id TEXT PRIMARY KEY);CREATE TABLE user(id TEXT PRIMARY KEY);CREATE TABLE agent_workspace(id TEXT PRIMARY KEY,organization_id TEXT);INSERT INTO organization VALUES('TEST-org');INSERT INTO user VALUES('TEST-user');INSERT INTO agent_workspace VALUES('TEST-workspace','TEST-org');",
    );
    const actor = {
        organizationId: "TEST-org",
        workspaceId: "TEST-workspace",
        userId: "TEST-user",
        canManageShared: false,
      },
      scope = {
        connectionId: "TEST-account",
        serverId: "TEST-server",
        workspaceId: actor.workspaceId,
        userId: actor.userId,
      };
    const selected = {
      key: "TEST synthetic noncredential",
      provider: ProviderSchema.parse({
        id: "TEST-provider",
        revision: 1,
        name: "TEST synthetic",
        url: "https://synthetic.example.invalid",
        enabled: true,
        hasCredential: true,
        dailyRequestLimit: 1000,
        requestsToday: 0,
      }),
      model: CatalogModelSchema.parse({
        id: "TEST-model",
        revision: 1,
        providerId: "TEST-provider",
        name: "TEST synthetic",
        model: "TEST/synthetic",
        enabled: true,
        tools: true,
      }),
    };
    const ledger = new InferenceBudgetStore(db);
    ledger.savePolicy(actor.organizationId, actor.workspaceId, 0, {
      mode: "enforce",
      maxTokens: 40000,
      maxCostMicros: 100000,
      prices: [
        {
          modelId: selected.model.id,
          modelRevision: 1,
          providerRevision: 1,
          maxInputTokens: 14000,
          maxOutputTokens: 2000,
          inputMicrosPerMillion: 0,
          outputMicrosPerMillion: 0,
        },
      ],
    });
    const cursor = new ProfileCursorStore(db, "TEST synthetic secret"),
      memory = new MemoryStore(db, {
        secret: "TEST synthetic secret",
        onMutation: (owner) => cursor.privacyMutation(owner),
      }),
      settings = MemorySettingsSchema.parse({});
    if (item.personalThings)
      await memory.setPersonalThings(actor, {
        requestId: randomUUID(),
        value: item.personalThings,
      });
    const ref: ProfileSourceRef = {
      type: item.kind.startsWith("meeting") ? "meeting" : "chat",
      sequence: 1,
      sourceId: randomUUID(),
      sourceVersion: 1,
      digest: createHash("sha256").update(item.text).digest("hex"),
      at: new Date().toISOString(),
      ...(item.kind.startsWith("meeting")
        ? { meetingId: randomUUID() }
        : { messageId: "TEST-message" }),
    };
    let calls = 0;
    const inference = new ProfileInference(ledger, cursor, async (request) => {
      await request.beforeDispatch!(() => calls++);
      const output = {
        add: item.expected.map((statement) => ({
          statement,
          section: item.section ?? "work",
          personal: item.personal ?? false,
          evidence: ["e1"],
        })),
        refresh: [],
        update: [],
      };
      return {
        status: 200,
        headers: {},
        text: JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: JSON.stringify(output) },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 100, cost: 0 },
        }),
      };
    });
    const learner = new ProfileLearner(memory, cursor, inference, {
      serial: async (fn) => fn(),
      discover: (type) =>
        type === ref.type ? [{ key: "TEST", actor, sequence: 1 }] : [],
      access: () => ({
        scope,
        settings,
        inference: {
          selected,
          settingsRevision: 0,
          policyVersion: 0,
          budgetRevision: 1,
          retentionDays: 30,
          check: () => {},
          useProvider: () => {},
          serial: async (fn) => fn(),
        },
      }),
      refs: (_scope, type, after) =>
        type === ref.type && after < 1 ? [ref] : [],
      chat: () => ({
        scope,
        ref,
        text: item.text,
        commandId: "TEST-command",
        conversationId: "TEST-chat",
      }),
      meeting: () =>
        item.kind === "meeting-me"
          ? { scope, ref, ownText: [item.text], ownTasks: [] }
          : null,
      valid: () => true,
      usedActions: () => item.actions ?? [],
      log: () => {},
    });
    try {
      await learner.tick();
      const actual = (await memory.observations(actor)).items.map(
        (row) => row.content!,
      );
      const missed = item.expected.filter(
          (expected) => !actual.includes(expected),
        ),
        falsePositives = actual.filter(
          (value) => !item.expected.includes(value),
        );
      const forbidden = item.forbidden.filter((word) =>
        actual.some((value) =>
          value.toLowerCase().includes(word.toLowerCase()),
        ),
      );
      rows.push({
        id: item.id,
        expectedPositives: item.expected.length,
        actualPositives: actual.length,
        missed,
        falsePositives,
        forbidden,
        calls,
      });
    } finally {
      await learner.close();
      await memory.close();
      db.close();
    }
  }
  const failed = rows.filter(
    (row) =>
      row.missed.length || row.falsePositives.length || row.forbidden.length,
  );
  process.stdout.write(
    JSON.stringify(
      {
        syntheticOnly: true,
        mode: "controlled-output logic through actual learner/SDK/ledger",
        live: "not executed: no authorized designated dev model supplied",
        modelQuality: "not measured; controlled output is the fixture oracle",
        fixtures: rows.length,
        failed: failed.length,
        rows,
      },
      null,
      2,
    ) + "\n",
  );
  if (failed.length) process.exitCode = 1;
}
void main().catch((error) => {
  process.stderr.write(
    (error instanceof Error ? error.message : "profile_eval_failed") + "\n",
  );
  process.exitCode = 1;
});
