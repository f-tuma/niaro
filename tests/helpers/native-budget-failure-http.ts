import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { z } from "zod";
import {
  ClientSession,
  commandTarget,
} from "../../packages/client-core/session";
import { toSnapshot } from "../../packages/client-core/store";
import { translate } from "../../packages/i18n";
import {
  CommandSchema,
  CommandResultSchema,
  type Language,
  type Command,
  type CommandResult,
} from "../../packages/protocol";
import { DomainCommandSchema } from "../../apps/server-identity/mastra-domain";
import { createServiceAnswer } from "../../apps/server-identity/service-answer";
import type { CatalogContext } from "../../apps/server-identity/catalog-controller";
import type { StoredInvocation } from "../../apps/server-identity/service-catalog";
import type { ServiceResult } from "../../packages/protocol/service-result";
import { coordinatorHttpFixture } from "./process-coordinator-http";

export const budgetFailureScenarios = [
  "tools-unpriced",
  "decision-unpriced",
  "write-succeeded",
  "write-unknown",
  "exhausted",
  "continuity-preflight",
] as const;
export type BudgetFailureScenario = (typeof budgetFailureScenarios)[number];
const DecisionBody = z.object({
  questions: z.object({
    route: z.object({ criteria: z.record(z.string(), z.string()) }),
  }),
});
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Actual auth, native execution and ClientSession; only remote responses are scripted. */
export async function runNativeBudgetFailureCase(
  scenario: BudgetFailureScenario,
  language: Language,
) {
  const h = await coordinatorHttpFixture({ allowOrdinaryRuntime: true });
  let session: ClientSession | undefined;
  const decisions: string[] = [];
  const posts: {
    url: string;
    body: string;
    status: number;
    result: CommandResult;
  }[] = [];
  let beforeFailure:
    | { receipt: StoredInvocation; card: ServiceResult }
    | undefined;
  try {
    const isWrite =
      scenario === "write-succeeded" || scenario === "write-unknown";
    const credential = await h.pair("owner"),
      scope = credential.scope;
    const providerId = await h.catalog({
      type: "saveProvider",
      revision: 0,
      apiKey: "TEST-budget-decision-key",
      settings: {
        name: "TEST budget decision provider",
        url: "https://openrouter.ai/api/v1",
        enabled: true,
        dailyRequestLimit: 100,
      },
    });
    const decisionId = await h.catalog({
      type: "saveModel",
      revision: 0,
      settings: {
        providerId,
        name: "TEST budget decision",
        model: "typesafe/jev-1.13",
        tools: false,
        enabled: true,
        kind: "decision",
      },
    });
    await h.catalog({
      type: "saveRouting",
      routing: {
        revision: 0,
        planner: "model",
        modelId: h.modelId,
        decision: { enabled: true, modelId: decisionId, minConfidence: 0.8 },
        services: [{ serviceId: h.serviceId, modelId: h.modelId }],
      },
    });
    const policy = await h.request(
      "owner",
      "api/identity/catalog/budget?" + h.query,
    );
    assert.equal(policy.status, 200);
    const price = h.budgetSettings.prices[0]!;
    // A call reserves its own request estimate plus its price's full output.
    // The decision model's 100,000-token output makes every decision hold
    // larger than 102,000 tokens, independent of the request sizes.
    const decisionPrice = {
      ...price,
      modelId: decisionId,
      maxOutputTokens: 100_000,
    };
    const prices =
      scenario === "tools-unpriced"
        ? [decisionPrice]
        : scenario === "exhausted" || isWrite
          ? [price, decisionPrice]
          : [price];
    const configured = await h.request("owner", "api/identity/catalog/budget", {
      ...h.target,
      revision: h.record(policy.data).revision,
      settings: {
        ...h.budgetSettings,
        prices,
        // Exhausted: a model call fits 100,000 tokens, the first decision
        // after it does not. A write consumes two model calls and the
        // mandatory parameter verification, which settles 20,010 tokens
        // (within its own hold), then the write and a third model call: the
        // final decision no longer fits 115,000 tokens.
        ...(scenario === "exhausted"
          ? { maxTokens: 100_000 }
          : isWrite
            ? { maxTokens: 115_000 }
            : {}),
      },
    });
    assert.equal(configured.status, 200, JSON.stringify(configured.data));
    const baseTransport = h.identity["catalog"].transport;
    const install = () =>
      Object.defineProperty(h.identity["catalog"], "transport", {
        value: async (request: Parameters<typeof baseTransport>[0]) => {
          if (!new URL(request.url).pathname.endsWith("/decisions"))
            return baseTransport(request);
          assert.equal(new URL(request.url).origin, "https://openrouter.ai");
          assert(request.beforeDispatch);
          await request.beforeDispatch(() => {
            decisions.push(request.method ?? "GET");
          });
          const criteria = DecisionBody.parse(request.body).questions.route
            .criteria;
          const choice = ["complete", "matches", "continue_work"].find(
            (key) => key in criteria,
          );
          assert(
            choice,
            "TEST provider supports only genuine verification/continuation routes",
          );
          return {
            status: 200,
            headers: {},
            text: JSON.stringify({
              answers: {
                route: {
                  type: "choice",
                  choice,
                  confidence: 1,
                  probabilities: Object.fromEntries(
                    Object.keys(criteria).map((key) => [
                      key,
                      key === choice ? 1 : 0,
                    ]),
                  ),
                },
              },
              usage: {
                input_tokens: 10,
                // The verification's long answer uses headroom (see above).
                output_tokens: isWrite && decisions.length === 1 ? 20_000 : 5,
                cost: 0.00002,
              },
            }),
          };
        },
      });
    install();
    h.onService(async () => {
      if (scenario === "write-unknown")
        throw new DOMException(
          "TEST lost response after dispatched write",
          "TimeoutError",
        );
      return {
        status: 200,
        headers: {},
        text: JSON.stringify({ value: "TEST confirmed budget write" }),
      };
    });
    const input = { name: "TEST original budget input č. 19" };
    let modelStep = 0;
    const call = (name: string, args: object) => ({
      content: null,
      tool_calls: [
        {
          id: "TEST-budget-tool-" + modelStep,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    });
    const command = CommandSchema.parse({
      type: "message.send",
      commandId: "TEST-budget-" + scenario + "-" + language,
      idempotencyKey: "TEST-budget-" + scenario + "-" + language,
      conversationId: "conversation-1",
      text: "TEST submitted request žluťoučký " + scenario,
      language,
      timeZone: "UTC",
    });
    assert(command.type === "message.send");
    const key = hash([
      scope.serverId,
      scope.workspaceId,
      scope.userId,
      command.commandId,
    ]);
    const domain = () =>
      DomainCommandSchema.parse(
        h.identity["catalog"].store.turn(key, scope.workspaceId, scope.userId),
      );
    const passiveContext = (): CatalogContext => {
      const identity = h.identity;
      return {
        serial: identity["serial"].bind(identity),
        actor: async (target) => {
          assert.equal(target.organizationId, h.target.organizationId);
          assert.equal(target.workspaceId, scope.workspaceId);
          const auth = identity["mobile"].authenticate(
            "Bearer " + credential.accessToken,
            scope.workspaceId,
            scope.serverId,
          );
          return { userId: auth.session.scope.userId, role: auth.role };
        },
        epoch: (org) => identity["connections"].policyVersion(org),
        change: (org) => identity["connections"].changePolicy(org),
        audit: (record) => identity["audit"].append(record),
        finish: (...args) => identity["audit"].finish(...args),
        transaction: identity["transaction"].bind(identity),
      };
    };
    h.onModel(async (body) => {
      modelStep++;
      if (scenario === "continuity-preflight")
        return call("ask_user", { question: "TEST which budget item Q19?" });
      if (!isWrite) return { content: "TEST plain synthetic reply" };
      if (modelStep === 1)
        return call("find_actions", {
          service: "TEST design service",
          need: "TEST confirmed write",
        });
      const action = "action_" + h.writeId.replaceAll("-", "_");
      if (modelStep === 2) {
        assert(body.tools?.some((tool) => tool.function.name === action));
        return call(action, input);
      }
      assert.equal(modelStep, 3);
      const state = domain();
      assert.equal(state.operations.length, 1);
      const receipt = structuredClone(
        h.identity["catalog"].store.invocation(
          state.operations[0]!,
          scope.workspaceId,
          scope.userId,
        ),
      );
      assert(receipt);
      assert.equal(
        receipt.status,
        scenario === "write-unknown" ? "unknown" : "succeeded",
      );
      const answer = await createServiceAnswer(
        h.identity["catalog"],
        passiveContext(),
        scope,
        h.target.organizationId,
      )(receipt.id, language);
      assert(answer.result);
      beforeFailure = { receipt, card: structuredClone(answer.result) };
      return { content: "TEST final synthetic reply after recorded write" };
    });
    const values = new Map<string, string>();
    const storage = {
      getItem: async (key: string) => values.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const transport: typeof fetch = async (url, init) => {
      const response = await fetch(url, init);
      if (
        init?.method === "POST" &&
        new URL(String(url)).pathname.endsWith("/commands")
      ) {
        const result = CommandResultSchema.parse(await response.clone().json());
        posts.push({
          url: String(url),
          body: String(init.body),
          status: response.status,
          result,
        });
      }
      return response;
    };
    session = new ClientSession(
      h.origin + "/v1/" + scope.workspaceId,
      storage,
      credential,
      transport,
    );
    await session.start(false);
    assert.equal(session.getSnapshot().status, "online");
    await session.send(command);
    assert.equal(posts.length, 1);
    assert.deepEqual(JSON.parse(posts[0]!.body), command);
    const delivered: Command[] = [command];
    let failureCommand = command;
    if (isWrite) {
      assert.equal(posts[0]!.status, 202, JSON.stringify(posts[0]!.result));
      await session.refresh();
      const pending = Object.values(
        session.getSnapshot().store!.workItems,
      ).find((work) => work.native?.action?.status === "awaiting_approval");
      assert(
        pending?.native?.action,
        JSON.stringify({
          result: posts[0]!.result,
          modelCount: h.modelCount(),
          decisions,
          state: domain(),
        }),
      );
      assert.equal(pending.status, "waiting_approval");
      assert.equal(h.modelCount(), 2);
      assert.deepEqual(
        decisions,
        ["POST"],
        "TEST mandatory write parameter verification succeeds before approval",
      );
      assert.deepEqual(h.dispatches, []);
      assert.equal(
        h.identity["catalog"].store.service(scope.workspaceId, h.serviceId)
          .actions.length,
        2,
      );
      const resolve = CommandSchema.parse({
        type: "service.resolve",
        commandId: command.commandId + "-approve",
        idempotencyKey: command.commandId + "-approve",
        conversationId: command.conversationId,
        workItemId: pending.id,
        expectedWorkRevision: pending.revision,
        operationId: pending.native.action.operationId,
        approved: true,
        language,
      });
      await session.send(resolve);
      delivered.push(resolve);
    } else if (scenario === "continuity-preflight") {
      assert.equal(posts[0]!.status, 202);
      await session.refresh();
      assert(
        Object.values(session.getSnapshot().store!.workItems).some(
          (work) => work.status === "waiting_input",
        ),
      );
      const followup = CommandSchema.parse({
        ...command,
        commandId: command.commandId + "-answer",
        idempotencyKey: command.commandId + "-answer",
        text: "TEST supplied budget choice Q19",
      });
      assert(followup.type === "message.send");
      failureCommand = followup;
      await session.send(failureCommand);
      delivered.push(failureCommand);
    }
    await session.refresh();
    assert.equal(session.getSnapshot().status, "online");
    assert.equal(session.getSnapshot().pending, null);
    const last = posts.at(-1)!;
    const reason =
      scenario === "exhausted" || isWrite
        ? "catalog_budget_exhausted"
        : "catalog_budget_price_required";
    const explanation = translate(language)(reason);
    const snapshot = toSnapshot(session.getSnapshot().store!);
    const messages = snapshot.conversations[0]!.messages;
    assert(
      messages.some(
        (message) =>
          message.role === "user" && message.text === failureCommand.text,
      ),
    );
    const reply = messages.findLast((message) => message.role === "assistant")!;
    assert(reply.text.includes(explanation), JSON.stringify(reply));
    assert.doesNotMatch(reply.text, /step limit|limit kroků/);
    if (language === "en")
      assert.match(
        explanation,
        scenario === "exhausted" || isWrite
          ? /configured limit/
          : /pricing is missing/,
      );
    else
      assert.match(
        explanation,
        scenario === "exhausted" || isWrite
          ? /nastaveného limitu/
          : /chybí nastavená cena/,
      );
    if (scenario === "continuity-preflight") {
      assert.equal(last.status, 422, JSON.stringify(last.result));
      assert.equal(last.result.status, "rejected");
      assert.equal(last.result.code, "integration_unavailable");
      assert.equal(session.getSnapshot().error, "integration_unavailable");
      assert.equal(
        session.getSnapshot().commandStates[commandTarget(failureCommand)],
        "rejected",
      );
      const banner = translate(language)("integration_unavailable");
      assert.doesNotMatch(banner, /calendar|kalendář/i);
      assert.match(
        banner,
        language === "en"
          ? /server.*request.*reply.*administrator/i
          : /Server.*požadavek.*odpovědi.*správce/,
      );
      assert.equal(domain().terminalCandidate, undefined);
      assert.equal(h.modelCount(), 1);
    } else {
      assert.equal(last.status, 202, JSON.stringify(last.result));
      assert.equal(last.result.status, "accepted");
      assert.equal(last.result.code, "accepted");
      assert.equal(session.getSnapshot().error, null);
      const state = domain();
      assert.equal(state.kind, "mastra-1");
      assert.equal(state.terminalCandidate, reason);
      assert(state.answer);
      assert.equal(state.pending, undefined);
      const work = snapshot.workItems.find((item) => item.id === state.runId);
      assert(work, JSON.stringify(snapshot));
      assert.equal(
        work.status,
        scenario === "write-unknown" ? "waiting_system" : "failed",
      );
      assert.equal(work.context, state.answer.reply);
      assert.equal(
        state.trace?.status,
        scenario === "write-unknown" ? "unknown" : "failed",
      );
      assert.equal(
        h.modelCount(),
        isWrite ? 3 : scenario === "tools-unpriced" ? 0 : 1,
      );
      if (isWrite) {
        assert(beforeFailure);
        assert.deepEqual(h.dispatches, ["POST"]);
        assert.deepEqual(
          h.identity["catalog"].store.invocation(
            beforeFailure.receipt.id,
            scope.workspaceId,
            scope.userId,
          ),
          beforeFailure.receipt,
        );
        assert.deepEqual(beforeFailure.receipt.input, input);
        assert.deepEqual(reply.result, beforeFailure.card);
        assert.deepEqual(work.native?.action, beforeFailure.card);
        assert.deepEqual(state.answer.result, beforeFailure.card);
        if (scenario === "write-succeeded")
          assert.deepEqual(beforeFailure.receipt.result, {
            value: "TEST confirmed budget write",
          });
        else {
          assert.equal(beforeFailure.receipt.status, "unknown");
          assert.equal(beforeFailure.card.status, "unknown");
          assert.match(
            reply.text,
            language === "en"
              ? /before retrying; it may already have happened/
              : /Před opakováním ověř změnu.*mohla už proběhnout/,
          );
          assert(
            beforeFailure.card.fields.some((field) =>
              /before retrying|Před opakováním/.test(field.value),
            ),
          );
        }
      } else {
        assert.deepEqual(h.dispatches, []);
        assert.equal(
          h.identity["db"]
            .prepare("SELECT count(*) AS n FROM agent_service_invocation")
            .get()!.n,
          0,
        );
      }
    }
    assert.deepEqual(
      decisions,
      isWrite ? ["POST"] : [],
      "TEST failed final budget reservations never dispatch an extra decision request",
    );
    const currentPolicy = h.identity["catalog"].store.inferenceBudget.policy(
      h.target.organizationId,
      scope.workspaceId,
    );
    assert.equal(currentPolicy.revision, h.record(configured.data).revision);
    assert.deepEqual(
      currentPolicy.settings,
      h.record(configured.data).settings,
      "TEST limits and prices remain frozen throughout the attempt",
    );
    const ledger = () => {
      const db = new DatabaseSync(
        join(h.config.dataDirectory, "workflow.sqlite"),
        { readOnly: true },
      );
      try {
        return {
          identity: Object.fromEntries(
            [
              "agent_service_invocation",
              "agent_service_turn",
              "agent_service_turn_operation",
              "agent_service_turn_cursor",
              "agent_audit",
              "agent_provider_usage",
              "agent_inference_run",
              "agent_inference_attempt",
            ].map((table) => [
              table,
              h.identity["db"]
                .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
                .all(),
            ]),
          ),
          workflow: Object.fromEntries(
            ["receipts", "workflows", "events", "conversation_sessions"].map(
              (table) => [
                table,
                db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
              ],
            ),
          ),
        };
      } finally {
        db.close();
      }
    };
    const baseline = ledger(),
      modelCount = h.modelCount(),
      effects = [...h.dispatches];
    const baselineMessages = structuredClone(messages),
      baselineWorks = structuredClone(snapshot.workItems);
    for (let reopen = 0; reopen < 2; reopen++) {
      await h.restart();
      install();
      for (let index = 0; index < delivered.length; index++) {
        const posted = posts[index]!;
        assert.deepEqual(JSON.parse(posted.body), delivered[index]);
        const replay = await transport(posted.url, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + credential.accessToken,
            "Content-Type": "application/json",
          },
          body: posted.body,
          signal: AbortSignal.timeout(15000),
        });
        assert.equal(replay.status, posted.status);
        const replayed = CommandResultSchema.parse(await replay.json());
        assert.equal(replayed.status, posted.result.status);
        assert.equal(replayed.code, posted.result.code);
      }
      await session.refresh();
      assert.equal(session.getSnapshot().status, "online");
      assert.deepEqual(
        toSnapshot(session.getSnapshot().store!).conversations[0]!.messages,
        baselineMessages,
      );
      assert.deepEqual(
        toSnapshot(session.getSnapshot().store!).workItems,
        baselineWorks,
      );
      assert.deepEqual(ledger(), baseline);
      assert.equal(h.modelCount(), modelCount);
      assert.deepEqual(decisions, isWrite ? ["POST"] : []);
      assert.deepEqual(h.dispatches, effects);
    }
    return {
      scenario,
      language,
      status: last.status,
      reason,
      models: modelCount,
      decisionCalls: decisions.length,
      writes: effects,
      reopens: 2,
    };
  } finally {
    session?.stop();
    await h.close();
  }
}
