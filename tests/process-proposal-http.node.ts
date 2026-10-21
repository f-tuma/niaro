import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  CommandResultSchema,
  CommandSchema,
  type Credential,
} from "../packages/protocol";
import {
  PROCESS_PROPOSAL_PROFILE,
  ProcessProposalResultSchema,
  ProcessProposalStatusSchema,
  type ProcessProposalResult,
  type ProcessProposalStatus,
} from "../packages/protocol/process-proposal";
import { emptyDesignBrief } from "../packages/protocol/process-design";
import { HUB_PROFILE, HubViewSchema } from "../packages/protocol/hub";
import {
  ProcessDefinitionSchema,
  type ProcessDefinition,
} from "../packages/protocol/service-processes";
import { ProcessExecutionInventorySchema } from "../packages/protocol/process-execution";
import { ClientSession } from "../packages/client-core/session";
import { DEFAULT_PROCESS_LIMITS } from "../apps/server-identity/process-validation";
import type { ModelRequest } from "./agent-trust/harness";
import { coordinatorHttpFixture } from "./helpers/process-coordinator-http";
import { processObject } from "./helpers/service-process";
import { seedSyntheticQualification } from "./helpers/process-qualified-fixture";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Fixture = Awaited<ReturnType<typeof coordinatorHttpFixture>>;

/** "Shrnutí dne": the calendar-style read, an agent summary, no input. */
function overview(h: Fixture, input = processObject({})): ProcessDefinition {
  return ProcessDefinitionSchema.parse({
    schemaVersion: 1,
    kind: "workflow",
    name: "TEST Shrnutí dne",
    description: "Dnešní položky a krátké shrnutí",
    trigger: "manual",
    inputSchema: input,
    outputSchema: processObject({ summary: { type: "string" } }),
    limits: DEFAULT_PROCESS_LIMITS,
    entry: "read",
    steps: [
      {
        id: "read",
        type: "action",
        serviceId: h.serviceId,
        actionId: h.actionId,
        input: { name: { source: "literal", value: "dnes" } },
        outputSchema: processObject({ value: { type: "string" } }),
        next: "summarize",
      },
      {
        id: "summarize",
        type: "agent",
        modelId: h.modelId,
        instructions: "Shrň dnešní položky do jedné věty.",
        capabilities: [],
        memory: "none",
        inputSchema: processObject({ value: { type: "string" } }),
        outputSchema: processObject({ summary: { type: "string" } }),
        input: { value: { source: "step", stepId: "read", path: ["value"] } },
        next: "done",
      },
      {
        id: "done",
        type: "return",
        output: {
          summary: { source: "step", stepId: "summarize", path: ["summary"] },
        },
      },
    ],
  });
}
const call = (name: string, args: object) => ({
  content: null,
  tool_calls: [
    {
      id: randomUUID(),
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});
const has = (body: ModelRequest, tool: string) =>
  !!body.tools?.some((t) => t.function.name === tool);

/**
 * A synthetic chat model that calls process_propose once, and a synthetic
 * designer that proposes `candidate` (with one assumption) and replies.
 */
function script(
  h: Fixture,
  candidate: ProcessDefinition,
  propose: object = {
    request: "Každé ráno mi shrň dnešní položky",
    addToHub: true,
  },
) {
  const seen = { chat: 0, designer: 0 };
  h.onModel((body) => {
    if (has(body, "design_update_proposal"))
      return ++seen.designer === 1
        ? call("design_update_proposal", {
            revision: 1,
            brief: {
              ...emptyDesignBrief(),
              purpose: "TEST shrnutí dne",
              assumptions: [
                { id: "source", text: "TEST položky čtu z testovací služby" },
              ],
            },
            candidate,
          })
        : { content: "TEST návrh je hotový" };
    if (++seen.chat === 1) {
      assert(has(body, "process_propose"), "TEST chat offers process_propose");
      return call("process_propose", propose);
    }
    // Once drafted, the turn has nothing left to propose.
    assert(!has(body, "process_propose"));
    return { content: "" };
  });
  return seen;
}
async function chat(h: Fixture, credential: Credential, text: string) {
  const command = CommandSchema.parse({
    type: "message.send",
    commandId: randomUUID(),
    idempotencyKey: randomUUID(),
    conversationId: "conversation-1",
    text,
    language: "cs",
    timeZone: "UTC",
  });
  // A client that renders the card names it; others get the text alone.
  const response = await h.mobile(
    credential,
    "commands?results=process.proposal%2F1",
    command,
  );
  assert.equal(response.status, 202, JSON.stringify(response.data));
  const reply = CommandResultSchema.parse(response.data)
    .snapshot.conversations.find((c) => c.id === command.conversationId)!
    .messages.at(-1)!;
  assert.equal(reply.role, "assistant");
  assert(reply.result, JSON.stringify(reply));
  return {
    text: reply.text,
    card: ProcessProposalResultSchema.parse(reply.result),
  };
}
/** Chat uses the fixture's priced tool model, with a 40 000-token max input. */
async function routeChat(h: Fixture) {
  const routing = h.identity["catalog"].store.routing(h.target.workspaceId);
  await h.catalog({
    type: "saveRouting",
    routing: { ...routing, modelId: h.modelId },
  });
  const budget = h.identity["catalog"].store.inferenceBudget;
  const policy = budget.policy(h.target.organizationId, h.target.workspaceId);
  budget.savePolicy(
    h.target.organizationId,
    h.target.workspaceId,
    policy.revision,
    {
      ...policy.settings,
      prices: policy.settings.prices.map((price) => ({
        ...price,
        maxInputTokens: 40000,
      })),
    },
  );
}
const accept = (
  h: Fixture,
  credential: Credential,
  card: ProcessProposalResult,
  patch: object = {},
) =>
  h.mobile(credential, "process-proposals?language=cs", {
    profile: PROCESS_PROPOSAL_PROFILE,
    type: "accept",
    sessionId: card.sessionId,
    requestId: randomUUID(),
    revision: card.revision,
    reviewDigest: card.reviewDigest,
    assumptions: card.assumptions.map(({ id, digest }) => ({ id, digest })),
    addToHub: card.addToHub,
    ...patch,
  });
async function settled(
  h: Fixture,
  credential: Credential,
  sessionId: string,
): Promise<ProcessProposalStatus> {
  for (let i = 0; i < 600; i++) {
    const response = await h.mobile(
      credential,
      `process-proposals?sessionId=${sessionId}`,
    );
    assert.equal(response.status, 200, JSON.stringify(response.data));
    const status = ProcessProposalStatusSchema.parse(response.data);
    if (status.state !== "running") return status;
    await sleep(100);
  }
  assert.fail("TEST save did not settle");
}

test(
  "a member drafts a process in chat, nothing is saved, and Save and turn on saves, tests, activates and adds it to the overview",
  { timeout: 180000 },
  async () => {
    const h = await coordinatorHttpFixture({ allowOrdinaryRuntime: true });
    try {
      await routeChat(h);
      const member = await h.pair("member");
      const seen = script(h, overview(h));
      const { text, card } = await chat(
        h,
        member,
        "Přidej mi na přehled shrnutí dne",
      );
      assert.equal(seen.designer, 2);
      assert.equal(card.status, "ready", JSON.stringify(card));
      assert.equal(card.name, "TEST Shrnutí dne");
      assert.equal(card.kind, "workflow");
      assert.deepEqual(
        card.steps.map((step) => step.type),
        ["action", "agent", "return"],
      );
      assert.deepEqual(card.steps[0], {
        type: "action",
        service: "TEST design service",
        action: "TEST lookup",
        effect: "read",
        approval: false,
      });
      assert.deepEqual(card.services, [
        { name: "TEST design service", reads: true, writes: false },
      ]);
      assert.deepEqual(card.inputs, []);
      assert.deepEqual(card.outputs, ["summary"]);
      assert.equal(card.assumptions.length, 1);
      assert.equal(card.hubEligible, true);
      assert.equal(card.addToHub, true);
      assert.match(text, /TEST Shrnutí dne/);

      // Nothing is saved until the person presses the button.
      const inventory = async () =>
        ProcessExecutionInventorySchema.parse(
          (await h.mobile(member, "processes" + h.suffix)).data,
        );
      assert.deepEqual((await inventory()).processes, []);
      const open = await h.mobile(
        member,
        `process-proposals?sessionId=${card.sessionId}`,
      );
      assert.equal(ProcessProposalStatusSchema.parse(open.data).state, "open");

      // Another person cannot read or save it.
      const admin = await h.pair("admin");
      assert.equal(
        (await h.mobile(admin, `process-proposals?sessionId=${card.sessionId}`))
          .status,
        404,
      );
      assert.equal((await accept(h, admin, card)).status, 404);
      // A stale card is refused before anything is saved.
      const requestId = randomUUID();
      const stale = await accept(h, member, card, {
        requestId,
        reviewDigest: "0".repeat(64),
      });
      assert.equal(stale.status, 200);
      const refused = await settled(h, member, card.sessionId!);
      assert.equal(refused.state, "failed");
      assert.equal(refused.failure, "process_proposal_changed");
      assert.deepEqual((await inventory()).processes, []);

      const press = randomUUID();
      const started = await accept(h, member, card, { requestId: press });
      assert.equal(started.status, 200, JSON.stringify(started.data));
      assert.equal(
        ProcessProposalStatusSchema.parse(started.data).state,
        "running",
      );
      const done = await settled(h, member, card.sessionId!);
      assert.equal(done.state, "done", JSON.stringify(done));
      assert.equal(done.hub, "added");
      assert(done.processId && done.version === 1);
      const entry = (await inventory()).processes.find(
        (p) => p.processId === done.processId,
      );
      assert.equal(entry?.availability, "ready", JSON.stringify(entry));
      assert.equal(entry?.version, 1);
      assert.equal(entry?.personal, true);
      const hub = HubViewSchema.parse(
        (await h.mobile(member, "hub?language=cs")).data,
      );
      const item = hub.items.find((i) => i.processId === done.processId);
      assert.equal(item?.refresh, "daily");
      // Not started now; the overview refreshes it when it opens.
      assert.equal(item?.result, null);
      assert.equal(item?.stale, true);

      // The same press, or another one, changes nothing more.
      const again = await accept(h, member, card, { requestId: press });
      assert.equal(ProcessProposalStatusSchema.parse(again.data).state, "done");
      const other = await accept(h, member, card);
      assert.equal(ProcessProposalStatusSchema.parse(other.data).state, "done");
      assert.equal(
        HubViewSchema.parse((await h.mobile(member, "hub?language=cs")).data)
          .items.length,
        hub.items.length,
      );
      // Only the chat and the designer used the model; the test was scripted.
      assert.equal(seen.chat, 2);
      assert.equal(seen.designer, 2);
      // Nothing reached a business service.
      assert.deepEqual(h.dispatches, []);

      // The web app's ClientSession reads the same status and replays a press.
      const session = new ClientSession(
        h.origin + "/v1/" + member.scope.workspaceId,
        { getItem: async () => null, setItem: async () => {} },
        member,
        (url, init) => fetch(url, init),
        undefined,
        undefined,
        false,
        { processOutputs: true },
      );
      try {
        await session.start(false);
        assert.deepEqual(
          await session.readProcessProposal(card.sessionId!),
          done,
        );
        const replay = await session.acceptProcessProposal(
          {
            sessionId: card.sessionId!,
            requestId: press,
            revision: card.revision!,
            reviewDigest: card.reviewDigest!,
            assumptions: card.assumptions.map(({ id, digest }) => ({
              id,
              digest,
            })),
            addToHub: true,
          },
          "cs",
        );
        assert.equal(replay.state, "done");
        await assert.rejects(
          session.readProcessProposal(randomUUID()),
          /process_proposal_not_found/,
        );
      } finally {
        session.stop();
      }
    } finally {
      await h.close();
    }
  },
);

test(
  "an administrator's draft is personal too; needing input keeps it off the overview, a write only a person can test stops, a CRM count is sized to run with a whole-context model, and no budget designs nothing",
  { timeout: 180000 },
  async () => {
    const h = await coordinatorHttpFixture({ allowOrdinaryRuntime: true });
    try {
      await routeChat(h);
      const admin = await h.pair("admin");
      script(h, overview(h, processObject({ day: { type: "string" } })), {
        request: "Vytvoř mi proces se shrnutím dne",
        addToHub: true,
      });
      const { card } = await chat(h, admin, "Vytvoř mi proces se shrnutím dne");
      assert.equal(card.status, "ready");
      assert.deepEqual(card.inputs, [
        { key: "day", type: "string", required: true },
      ]);
      assert.equal(card.hubEligible, false);
      assert.equal(card.addToHub, false);
      // Asking for the overview anyway saves and turns it on, without the item.
      assert.equal(
        (await accept(h, admin, card, { addToHub: true })).status,
        200,
      );
      const done = await settled(h, admin, card.sessionId!);
      assert.equal(done.state, "done", JSON.stringify(done));
      assert.equal(done.hub, "failed");
      assert.equal(done.hubFailure, "hub_process_needs_input");
      const registry = h.identity["processes"];
      const owned = registry.getOwned(
        {
          ...h.target,
          userId: admin.scope.userId,
          role: "admin",
        },
        done.processId!,
      );
      assert.deepEqual("owner" in owned ? owned.owner : null, {
        type: "user",
        userId: admin.scope.userId,
      });
      assert.equal(owned.activeVersion, 1);
      // The member cannot see the administrator's personal proposal.
      const member = await h.pair("member");
      assert.equal(
        (
          await h.mobile(
            member,
            `process-proposals?sessionId=${card.sessionId}`,
          )
        ).status,
        404,
      );
      assert.deepEqual(h.dispatches, []);

      // An agent that can only write through its own tool: its rejection
      // and uncertain-write scenarios need a person's script.
      const writer = ProcessDefinitionSchema.parse({
        schemaVersion: 1,
        kind: "agent",
        name: "TEST zapisovač",
        description: "Zapíše poznámku",
        trigger: "manual",
        inputSchema: processObject({}),
        outputSchema: processObject({ summary: { type: "string" } }),
        limits: DEFAULT_PROCESS_LIMITS,
        modelId: h.modelId,
        instructions: "Zapiš poznámku.",
        memory: "none",
        capabilities: [{ serviceId: h.serviceId, actionId: h.writeId }],
      });
      script(h, writer);
      const { card: written } = await chat(
        h,
        member,
        "Přidej mi na přehled zápis",
      );
      assert.equal(written.status, "ready");
      // A write that waits for approval may still be on the overview.
      assert.equal(written.hubEligible, true);
      assert.deepEqual(written.services, [
        { name: "TEST design service", reads: false, writes: true },
      ]);
      assert.equal((await accept(h, member, written)).status, 200);
      const stopped = await settled(h, member, written.sessionId!);
      assert.equal(stopped.state, "stopped", JSON.stringify(stopped));
      assert.equal(stopped.gap, "scenario_unsupported");
      assert.equal(stopped.version, 1);
      const unqualified = h.identity["processes"].getOwned(
        { ...h.target, userId: member.scope.userId, role: "member" },
        stopped.processId!,
      );
      assert.equal(unqualified.activeVersion, null);
      assert.equal(unqualified.latestVersion, 1);
      assert.equal(
        HubViewSchema.parse((await h.mobile(member, "hub?language=cs")).data)
          .items.length,
        1,
      );

      // The designer's usual shape for a CRM count: one agent with a read
      // and tiny caps, under a price whose max input is the whole context.
      const prices = (maxInputTokens: number, maxTokens?: number) => {
        const budget = h.identity["catalog"].store.inferenceBudget;
        const policy = budget.policy(
          h.target.organizationId,
          h.target.workspaceId,
        );
        budget.savePolicy(
          h.target.organizationId,
          h.target.workspaceId,
          policy.revision,
          {
            ...policy.settings,
            ...(maxTokens ? { maxTokens } : {}),
            prices: policy.settings.prices.map((price) => ({
              ...price,
              maxInputTokens,
              maxOutputTokens: 8000,
              inputMicrosPerMillion: 250000,
              outputMicrosPerMillion: 1500000,
            })),
          },
        );
      };
      prices(200_000);
      script(
        h,
        ProcessDefinitionSchema.parse({
          schemaVersion: 1,
          kind: "agent",
          name: "TEST Počet firem v CRM",
          description: "Celkový počet firem",
          trigger: "manual",
          inputSchema: processObject({}),
          outputSchema: processObject({
            count: { type: "integer", minimum: 0 },
          }),
          limits: {
            maxSteps: 2,
            maxModelCalls: 2,
            maxTokens: 1200,
            maxCostMicros: 100000,
            maxDurationMs: 30000,
          },
          modelId: h.modelId,
          instructions: "Zavolej vyhledání a vrať celkový počet v count.",
          memory: "none",
          capabilities: [{ serviceId: h.serviceId, actionId: h.actionId }],
        }),
        { request: "Přidej mi na přehled počet firem v CRM", addToHub: true },
      );
      const { card: counting } = await chat(
        h,
        member,
        "Přidej mi na přehled počet firem v CRM",
      );
      assert.equal(counting.status, "ready");
      assert.equal(counting.addToHub, true);
      // A workspace run limit below the smallest useful run (two calls at
      // the 2 048-token floor input plus 8 000 output) cannot be sized.
      const runLimit = h.identity["catalog"].store.inferenceBudget.policy(
        h.target.organizationId,
        h.target.workspaceId,
      ).settings.maxTokens;
      prices(200_000, 15_000);
      assert.equal((await accept(h, member, counting)).status, 200);
      const tooLarge = await settled(h, member, counting.sessionId!);
      assert.equal(tooLarge.state, "stopped", JSON.stringify(tooLarge));
      assert.equal(tooLarge.gap, "model_reservation_too_large");
      assert.deepEqual(tooLarge.reservation, {
        tokens: 20_096,
        costMicros: 25_024,
        maxTokens: 15_000,
        maxCostMicros: 10_000_000,
        calls: 2,
      });
      // Nothing was saved: no process could ever call its model.
      assert.equal(tooLarge.processId, undefined);
      // An administrator restores the run limit; the whole-context price
      // stays. The same card's next press sizes the designer's caps within
      // the 100 000-token process ceiling, tests and turns it on: each call
      // reserves only its own request size.
      prices(200_000, runLimit);
      assert.equal((await accept(h, member, counting)).status, 200);
      const counted = await settled(h, member, counting.sessionId!);
      assert.equal(counted.state, "done", JSON.stringify(counted));
      assert.equal(counted.hub, "added");
      const frozen = h.identity["processes"].version(
        { ...h.target, userId: member.scope.userId, role: "member" },
        counted.processId!,
        counted.version!,
      );
      // Sized for an ordinary run: the agent node + 3 tool calls + 4 model
      // calls = 8 steps, 70 s, four typical calls within the 100 000 ceiling.
      const sizedLimits = {
        maxSteps: 8,
        maxModelCalls: 4,
        maxTokens: 100_000,
        maxCostMicros: 100_000,
        maxDurationMs: 70_000,
      };
      assert.deepEqual(frozen.definition.limits, sizedLimits);
      // The activated process can run with that model.
      const runnable = ProcessExecutionInventorySchema.parse(
        (await h.mobile(member, "processes" + h.suffix)).data,
      ).processes.find((entry) => entry.processId === counted.processId);
      assert.equal(runnable?.availability, "ready", JSON.stringify(runnable));

      // The live case: a version turned on before steps were sized (only
      // tokens were) cannot finish a real run that calls its tool.
      const memberActor = {
        ...h.target,
        userId: member.scope.userId,
        role: "member" as const,
      };
      const processes = h.identity["processes"];
      const legacyLimits = { ...sizedLimits, maxSteps: 2, maxModelCalls: 2 };
      const draft = processes.saveWorkspaceDraft(memberActor, {
        id: counted.processId!,
        revision: processes.getOwned(memberActor, counted.processId!).revision,
        definition: { ...frozen.definition, limits: legacyLimits },
        owner: { type: "user" },
      });
      const legacy = processes.freezeDraft(
        memberActor,
        draft.id,
        draft.revision,
      );
      seedSyntheticQualification(h, memberActor, legacy);
      processes.activate(
        memberActor,
        draft.id,
        processes.getOwned(memberActor, draft.id).revision,
        legacy.version,
      );
      // A real overview refresh: the agent searches the CRM, then answers.
      h.onModel((body) =>
        body.messages?.some((message) => message.role === "tool")
          ? { content: '{"count":3}' }
          : call("action_process_0", { name: "Ukázka" }),
      );
      const itemId = HubViewSchema.parse(
        (await h.mobile(member, "hub?language=cs")).data,
      ).items.find((item) => item.processId === counted.processId)!.id;
      const refreshed = async () => {
        await h.mobile(member, "hub?language=cs", {
          profile: HUB_PROFILE,
          type: "refresh",
          itemIds: [itemId],
        });
        for (let i = 0; i < 300; i++) {
          const item = HubViewSchema.parse(
            (await h.mobile(member, "hub?language=cs")).data,
          ).items.find((value) => value.id === itemId)!;
          if (item.result && item.result.status !== "running")
            return item.result;
          await sleep(100);
        }
        assert.fail("TEST refresh did not settle");
      };
      const stepLimited = await refreshed();
      assert.equal(stepLimited.status, "failed", JSON.stringify(stepLimited));
      assert.equal(stepLimited.error, "process_step_limit");
      // The card learns that this proposal outgrew its limits…
      const outgrown = ProcessProposalStatusSchema.parse(
        (
          await h.mobile(
            member,
            `process-proposals?sessionId=${counting.sessionId}`,
          )
        ).data,
      );
      assert.equal(outgrown.state, "done");
      assert.equal(outgrown.resize, true);
      // …and its next press saves, tests and turns on a resized version,
      // keeping the overview item.
      assert.equal((await accept(h, member, counting)).status, 200);
      const resized = await settled(h, member, counting.sessionId!);
      assert.equal(resized.state, "done", JSON.stringify(resized));
      assert.equal(resized.version, legacy.version + 1);
      assert.equal(resized.resize, undefined);
      const active = processes.getOwned(memberActor, counted.processId!);
      assert.equal(active.activeVersion, legacy.version + 1);
      assert.deepEqual(
        processes.version(memberActor, active.id, active.activeVersion!)
          .definition.limits,
        sizedLimits,
      );
      const succeeded = await refreshed();
      assert.equal(succeeded.status, "succeeded", JSON.stringify(succeeded));
      assert.deepEqual(succeeded.output?.fields, [
        { label: "Count", value: "3" },
      ]);
      assert.equal(
        HubViewSchema.parse(
          (await h.mobile(member, "hub?language=cs")).data,
        ).items.filter((item) => item.processId === counted.processId).length,
        1,
      );
      // Only these synthetic CRM reads reached the (test) service.
      assert(h.dispatches.length >= 1);
      h.dispatches.length = 0;
      prices(40_000);

      // Without an enforced budget the designer is not asked at all.
      const budget = h.identity["catalog"].store.inferenceBudget;
      const policy = budget.policy(
        h.target.organizationId,
        h.target.workspaceId,
      );
      const seen = script(h, overview(h));
      const before = seen.designer;
      budget.savePolicy(
        h.target.organizationId,
        h.target.workspaceId,
        policy.revision,
        { ...policy.settings, mode: "observe" },
      );
      // The chat itself still answers; only the designer is not asked.
      const { card: unfunded, text } = await chat(
        h,
        admin,
        "Vytvoř mi proces na shrnutí dne",
      );
      assert.equal(unfunded.status, "budget");
      assert.equal(unfunded.sessionId, null);
      assert.equal(seen.designer, before);
      assert.match(text, /rozpočet/);
      // A card drafted earlier cannot be saved while the budget is missing.
      const refused = await accept(h, member, written);
      assert.equal(refused.status, 409);
      assert.deepEqual(refused.data, {
        error: "process_proposal_budget_not_ready",
      });
      assert.deepEqual(h.dispatches, []);
    } finally {
      await h.close();
    }
  },
);
