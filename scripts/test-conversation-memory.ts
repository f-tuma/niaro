/** Opt-in paid synthetic conversation test. No calendar or CRM adapter, maximum 14 calls. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { FixtureStorage } from "../apps/fixture-server/storage";
import { ModelService } from "../apps/fixture-server/model-service";
import {
  OpenRouterModel,
  loadOpenRouterConfig,
  reserveModelRequest,
  limitedJson,
} from "../apps/fixture-server/openrouter";
import { messageCommand } from "../packages/client-core/commands";
import { scopeFor } from "../packages/test-fixtures";
import { localParts } from "../apps/fixture-server/conversation-memory";
import type { Language } from "../packages/protocol";

async function main() {
  const directory = mkdtempSync(join(tmpdir(), "context-live-"));
  const scope = { ...scopeFor(), userId: "memory-synthetic" };
  const now = Date.now();
  const configFile = resolve(
    process.env.FIXTURE_MODEL_CONFIG ?? ".openrouter/config.json",
  );
  const config = loadOpenRouterConfig(configFile);
  const model = new OpenRouterModel(
    config,
    () =>
      reserveModelRequest(join(dirname(configFile), "budget.sqlite"), config),
    async (url, init) => {
      const response = await fetch(url, init);
      if (response.ok) {
        const diagnostic = (await limitedJson(response.clone())) as {
          choices?: {
            finish_reason?: string;
            message?: { content?: string };
          }[];
        };
        console.log(
          JSON.stringify({
            syntheticModelOutput: diagnostic.choices?.[0]?.message?.content,
            finish: diagnostic.choices?.[0]?.finish_reason,
          }),
        );
      }
      return response;
    },
  );
  let calls = 0;
  const costs: (number | null)[] = [];
  const router = {
    timeZone: model.timeZone,
    decide: async (...args: Parameters<typeof model.decide>) => {
      assert(calls < 14, "Synthetic test call cap reached");
      calls++;
      const decision = await model.decide(...args);
      costs.push(model.lastUsage?.cost ?? null);
      console.log(
        JSON.stringify({
          interpretation: decision.kind,
          patch: decision.patch ?? null,
        }),
      );
      return decision;
    },
  };
  let store = new FixtureStorage(directory, scope.serverId, () => now);
  let service = new ModelService(store, router, () => now);
  let sequence = 0;
  const day = (offset: number) =>
    localParts(new Date(now + offset * 86400000).toISOString(), model.timeZone)
      .localDate;
  const send = async (text: string, language: Language = "cs") => {
    const result = await service.execute(
      scope,
      messageCommand(text, language, `memory-${++sequence}`),
      () => {},
      new AbortController().signal,
    );
    assert.equal(result.status, "accepted");
    assert.equal(result.snapshot.operations.length, 0);
    console.log(
      JSON.stringify({
        text,
        response: result.snapshot.conversations[0]!.messages.at(-1)!.text,
        proposalCount: result.snapshot.actionProposals.length,
        context: store.modelState(scope, model.timeZone).activeMeeting,
      }),
    );
    return result.snapshot;
  };
  const slots = () =>
    store.modelState(scope, model.timeZone).activeMeeting!.slots;
  try {
    let snapshot = await send("Připrav schůzku s Peterem Svobodou.");
    assert.equal(snapshot.workItems.length, 0);
    assert.equal(slots().contactId, "peter-svoboda");
    await send("Zítra.");
    assert.equal(slots().localDate, day(1));
    assert.equal(slots().localTime, null);
    // Same private storage, fresh service simulates backend restart between clarification turns.
    store.close();
    store = new FixtureStorage(directory, scope.serverId, () => now);
    service = new ModelService(store, router, () => now);
    snapshot = await send("V jedenáct třicet na čtyřicet pět minut.");
    assert.equal(snapshot.workItems.length, 1);
    assert.equal(slots().localTime, "11:30");
    assert.equal(slots().durationMinutes, 45);
    assert.equal(slots().contactId, "peter-svoboda");
    const proposalId = snapshot.actionProposals[0]!.id;
    snapshot = await send("Posuň to o hodinu později.");
    assert.equal(snapshot.actionProposals.length, 1);
    assert.equal(snapshot.actionProposals[0]!.id, proposalId);
    assert.equal(slots().localTime, "12:30");
    assert.equal(slots().durationMinutes, 45);
    await send("Radši pozítří.");
    assert.equal(slots().localDate, day(2));
    assert.equal(slots().localTime, "12:30");
    await send(
      "Ne na čtyřicet pět minut, jen na půl hodiny. Nic zatím neodesílej.",
    );
    assert.equal(slots().durationMinutes, 30);
    await send("A radši s Peterem Novákem.");
    assert.equal(slots().contactId, "peter-novak");
    assert.equal(slots().localTime, "12:30");
    snapshot = await send("Nová schůzka s Peterem zítra v deset.");
    assert.equal(snapshot.workItems.length, 2);
    assert.equal(slots().localTime, "10:00");
    assert.equal(slots().contactId, null);
    snapshot = await send("S tím druhým.");
    assert.equal(snapshot.workItems.length, 2);
    assert.equal(slots().contactId, "peter-svoboda");
    assert.equal(slots().localTime, "10:00");
    await send("To teď nechme, nové téma.");
    assert.equal(store.modelState(scope, model.timeZone).activeMeeting, null);
    snapshot = await send("O hodinu později.");
    assert.equal(snapshot.workItems.length, 2);
    assert.equal(store.modelState(scope, model.timeZone).activeMeeting, null);
    snapshot = await send(
      "New meeting with Peter Novak tomorrow at eleven PM for forty five minutes.",
      "en",
    );
    assert.equal(snapshot.workItems.length, 3);
    assert.equal(slots().localTime, "23:00");
    assert.equal(slots().durationMinutes, 45);
    snapshot = await send("Make it two hours later.", "en");
    assert.equal(snapshot.workItems.length, 3);
    assert.equal(slots().localDate, day(2));
    assert.equal(slots().localTime, "01:00");
    assert.equal(slots().durationMinutes, 45);
    const before = calls;
    await service.execute(
      scope,
      messageCommand("Make it two hours later.", "en", `memory-${sequence}`),
      () => {},
      new AbortController().signal,
    );
    assert.equal(calls, before);
    console.log(
      JSON.stringify({
        result: "PASS",
        paidCalls: calls,
        costUsd: costs.every((c) => c !== null)
          ? costs.reduce<number>((sum, c) => sum + c!, 0)
          : null,
        externalOperations: 0,
        restartPreservedContext: true,
        replayWithoutInference: true,
      }),
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
void main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Conversation test failed",
  );
  process.exitCode = 1;
});
