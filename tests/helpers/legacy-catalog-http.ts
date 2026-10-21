import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AgentTurn } from "../../apps/server-identity/agent-runtime";
import { ProgressiveTurn } from "../../apps/server-identity/progressive-runtime";
import { createDrainCatalogRuntime } from "../../apps/server-identity/catalog-runtime-legacy";
import type { CatalogContext } from "../../apps/server-identity/catalog-controller";
import type { StoredInvocation } from "../../apps/server-identity/service-catalog";
import { cardDeliveryPath } from "../../packages/protocol/card-delivery";
import type { ServiceResult } from "../../packages/protocol/service-result";
import { IntegrationError } from "../../apps/server-integrations/transport";
import {
  CommandSchema,
  CommandResultSchema,
  SnapshotSchema,
  type Scope,
} from "../../packages/protocol";
import { coordinatorHttpFixture } from "./process-coordinator-http";
import type { StoppedCopyProof } from "./process-design-http";

export const historicalModes = ["agent", "progressive"] as const;
export const historicalOutcomes = [
  "succeeded",
  "rejected",
  "unknown",
  "question",
  "failed",
] as const;
export type HistoricalMode = (typeof historicalModes)[number];
export type HistoricalOutcome = (typeof historicalOutcomes)[number];

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const turnKey = (scope: Scope, id: string) =>
  hash([scope.serverId, scope.workspaceId, scope.userId, id]);
const HistoricalTurn = z.union([AgentTurn, ProgressiveTurn]);
const OuterReceipt = z.strictObject({
  command: CommandSchema,
  status: CommandResultSchema.shape.status,
  code: CommandResultSchema.shape.code,
});
const DecisionBody = z.object({
  questions: z.object({
    route: z.object({ criteria: z.record(z.string(), z.string()) }),
  }),
});

function tupleFiles(root: string) {
  const hashes: Record<string, string> = {};
  const modes: Record<string, number> = {};
  const walk = (relative = "") => {
    const path = join(root, relative);
    const stat = lstatSync(path);
    assert(stat.isDirectory() || stat.isFile());
    modes[relative] = stat.mode & 0o777;
    if (stat.isDirectory())
      for (const entry of readdirSync(path)) walk(join(relative, entry));
    else
      hashes[relative] = createHash("sha256")
        .update(readFileSync(path))
        .digest("hex");
  };
  walk();
  return { hashes, modes };
}

/** One real pair per process: Better Auth's process-wide bootstrap limit is real. */
export async function runHistoricalHttpCase(
  mode: HistoricalMode,
  outcome: HistoricalOutcome,
) {
  const h = await coordinatorHttpFixture({ allowOrdinaryRuntime: true });
  const commandPath =
    outcome === "failed" ? cardDeliveryPath("commands") : "commands";
  const snapshotPath =
    outcome === "failed" ? cardDeliveryPath("snapshot") : "snapshot";
  let copy: StoppedCopyProof | undefined;
  let protectedModes: Record<string, number> | undefined;
  let producerCalls = 0;
  let serviceAttempts = 0;
  let modelAttempts = 0;
  let decisionAttempts = 0;
  const decisions: string[] = [];
  try {
    const credential = await h.pair("owner");
    const scope = credential.scope;
    const providerId = await h.catalog({
      type: "saveProvider",
      revision: 0,
      apiKey: "TEST-decision-key",
      settings: {
        name: "TEST synthetic decision provider",
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
        name: "TEST decision",
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
        planner: mode === "agent" ? "model" : "jev",
        modelId: h.modelId,
        decision: { enabled: true, modelId: decisionId, minConfidence: 0.8 },
        services: [{ serviceId: h.serviceId, modelId: h.modelId }],
      },
    });
    h.beforeDispatch(() => {
      serviceAttempts++;
      if (outcome === "failed")
        throw new IntegrationError("integration_unavailable", 502);
    });
    h.onService(async () => {
      if (outcome === "unknown")
        throw new DOMException(
          "TEST response lost after dispatch",
          "TimeoutError",
        );
      return {
        status: 200,
        headers: {},
        text: JSON.stringify({ value: "TEST-old-write-result" }),
      };
    });
    const syntheticTransport = h.identity["catalog"].transport;
    const installTransport = () => {
      Object.defineProperty(h.identity["catalog"], "transport", {
        value: async (request: Parameters<typeof syntheticTransport>[0]) => {
          const url = new URL(request.url);
          if (!url.pathname.endsWith("/decisions")) {
            if (url.origin === "https://models.example.test") modelAttempts++;
            return syntheticTransport(request);
          }
          decisionAttempts++;
          assert.equal(url.origin, "https://openrouter.ai");
          assert(request.beforeDispatch);
          await request.beforeDispatch(() =>
            decisions.push(request.method ?? "GET"),
          );
          const criteria = DecisionBody.parse(request.body).questions.route
            .criteria;
          const choice =
            (outcome === "question" && criteria.answer_without_tools
              ? "answer_without_tools"
              : undefined) ??
            ["matches", "complete"].find((key) => key in criteria) ??
            Object.entries(criteria).find(
              ([key, value]) =>
                key.startsWith("action_") &&
                value.includes("TEST confirmed write"),
            )?.[0] ??
            Object.keys(criteria).find(
              (key) => !["fallback", "unsure", "no_match"].includes(key),
            );
          assert(
            choice,
            "TEST historical decision must offer a supported route",
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
            }),
          };
        },
      });
    };
    installTransport();
    let callId = 0;
    const call = (name: string, args: object) => ({
      content: null,
      tool_calls: [
        {
          id: "TEST-old-call-" + ++callId,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    });
    const question = "TEST which original item QX91?";
    const originalInput = { name: "TEST genuine historical input" };
    h.onModel((body) => {
      if (outcome === "question")
        return call(mode === "agent" ? "ask_user" : "ask_clarification", {
          question,
        });
      const completed = body.messages?.findLast(
        (message) =>
          message.role === "user" &&
          message.content?.startsWith("[Server]") &&
          message.content.includes("Result:"),
      );
      if (completed)
        return {
          content: completed.content!.includes('"status":"unknown"')
            ? "TEST outcome unknown"
            : completed.content!.includes('"status":"rejected"')
              ? "TEST action cancelled"
              : completed.content!.includes('"status":"failed"')
                ? "TEST old write failed before dispatch: integration_unavailable."
                : "TEST old write complete",
        };
      const action = "action_" + h.writeId.replaceAll("-", "_");
      if (
        mode === "agent" &&
        !body.tools?.some((tool) => tool.function.name === action)
      )
        return call("find_actions", {
          service: "TEST design service",
          need: "TEST confirmed write",
        });
      if (body.tools?.some((tool) => tool.function.name === action))
        return call(action, originalInput);
      const offered = body.tools?.find((tool) =>
        tool.function.name.startsWith("action_"),
      )?.function.name;
      assert(offered, "TEST historical planner must expose the write action");
      return call(offered, originalInput);
    });
    const command = CommandSchema.parse({
      type: "message.send",
      commandId: "TEST-old-" + mode + "-" + outcome,
      idempotencyKey: "TEST-old-" + mode + "-" + outcome,
      conversationId: "conversation-1",
      text: "TEST create one confirmed item",
      language: "en",
      timeZone: "UTC",
    });
    assert.equal(command.type, "message.send");
    if (command.type !== "message.send")
      throw Error("TEST expected message command");
    const wire = JSON.stringify(command);
    const key = turnKey(scope, command.commandId);
    const currentAccess = h.identity.mobileAccess.bind(h.identity);
    const historicalAccess: typeof h.identity.mobileAccess = async (
      ...args
    ) => {
      const access = await currentAccess(...args);
      producerCalls++;
      const identity = h.identity;
      const context: CatalogContext = {
        serial: identity["serial"].bind(identity),
        actor: async (target) => {
          assert.equal(target.organizationId, h.target.organizationId);
          assert.equal(target.workspaceId, h.target.workspaceId);
          const auth = identity["mobile"].authenticate(
            args[0],
            args[1],
            args[2],
          );
          assert.deepEqual(auth.session.scope, scope);
          return { userId: auth.session.scope.userId, role: auth.role };
        },
        epoch: (org) => identity["connections"].policyVersion(org),
        change: (org) => identity["connections"].changePolicy(org),
        audit: (record) => identity["audit"].append(record),
        finish: (...args) => identity["audit"].finish(...args),
        transaction: identity["transaction"].bind(identity),
      };
      return {
        ...access,
        integrations: createDrainCatalogRuntime(
          identity["catalog"],
          identity["catalog"].transport,
          context,
          scope,
          h.target.organizationId,
          true,
        ),
      };
    };
    const workflowTables = [
      "receipts",
      "workflows",
      "events",
      "conversation_sessions",
      "process_answer_messages",
    ] as const;
    const workflowRows = (table: (typeof workflowTables)[number]) => {
      const db = new DatabaseSync(
        join(h.config.dataDirectory, "workflow.sqlite"),
        { readOnly: true },
      );
      try {
        return db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
      } finally {
        db.close();
      }
    };
    const outerRows = () => workflowRows("receipts");
    const ledger = () => {
      const tables = [
        "agent_service_invocation",
        "agent_service_turn",
        "agent_service_turn_operation",
        "agent_service_turn_cursor",
        "agent_service_task_selection",
        "agent_audit",
        "agent_provider_usage",
        "agent_inference_run",
        "agent_inference_attempt",
      ];
      return {
        identity: Object.fromEntries(
          tables.map((table) => [
            table,
            h.identity["db"]
              .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
              .all(),
          ]),
        ),
        workflow: Object.fromEntries(
          workflowTables.map((table) => [table, workflowRows(table)]),
        ),
      };
    };
    const savedTurn = () =>
      HistoricalTurn.parse(
        h.identity["catalog"].store.turn(key, scope.workspaceId, scope.userId),
      );
    const invocation = (operationId: string) => {
      const receipt = h.identity["catalog"].store.invocation(
        operationId,
        scope.workspaceId,
        scope.userId,
      );
      assert(receipt);
      return structuredClone(receipt);
    };
    const assertAuthority = (
      receipt: StoredInvocation,
      original: StoredInvocation,
    ) => {
      for (const field of [
        "id",
        "organizationId",
        "workspaceId",
        "userId",
        "serviceId",
        "actionId",
        "serviceRevision",
        "actionRevision",
        "policyRevision",
        "effect",
        "input",
        "title",
        "serviceName",
        "executionPin",
        "contactSource",
        "dependencies",
      ] as const)
        assert.deepEqual(receipt[field], original[field], field);
    };
    const assertOperationLink = (operationId: string) => {
      const linked = h.identity["catalog"].store.turnForOperation(
        operationId,
        scope.workspaceId,
        scope.userId,
      );
      assert.equal(linked?.id, key);
      assert.deepEqual(linked?.value, savedTurn());
    };
    let pendingOperationId: string | undefined;
    let historicalFailedReceipt: StoredInvocation | undefined;
    let historicalFailedResult: ServiceResult | undefined;
    let resolveWire: string | undefined;
    if (outcome === "question" || outcome === "failed") {
      assert.equal(outerRows().length, 0);
      const producer = await historicalAccess(
        "Bearer " + credential.accessToken,
        scope.workspaceId,
        scope.serverId,
      );
      const old = await producer.integrations!.message(
        command.commandId,
        command.text,
        command.language,
        [],
        new AbortController().signal,
        undefined,
        undefined,
        command.timeZone,
        { conversationId: command.conversationId, requestHash: hash(command) },
      );
      if (outcome === "question") assert.equal(old?.reply, question);
      else {
        assert.equal(old?.result?.status, "awaiting_approval");
        assert(old?.result);
        pendingOperationId = old.result.operationId;
        const pendingReceipt = invocation(pendingOperationId);
        assert.equal(pendingReceipt.status, "awaiting_approval");
        assert.deepEqual(pendingReceipt.input, originalInput);
        assert.equal(pendingReceipt.organizationId, h.target.organizationId);
        assert.equal(pendingReceipt.workspaceId, scope.workspaceId);
        assert.equal(pendingReceipt.userId, scope.userId);
        assert.equal(pendingReceipt.serviceId, h.serviceId);
        assert.equal(pendingReceipt.actionId, h.writeId);
        assert.equal(pendingReceipt.effect, "write");
        assertOperationLink(pendingOperationId);
        assert.deepEqual(h.dispatches, []);
        assert.equal(serviceAttempts, 0);
        assert.equal(outerRows().length, 0);
        const pendingTurn = savedTurn();
        const terminal = await producer.integrations!.resolve(
          pendingOperationId,
          true,
          command.language,
          new AbortController().signal,
        );
        historicalFailedResult = terminal.resolved ?? terminal.result;
        assert.equal(historicalFailedResult?.status, "failed");
        assert.equal(historicalFailedResult?.operationId, pendingOperationId);
        historicalFailedReceipt = invocation(pendingOperationId);
        assertAuthority(historicalFailedReceipt, pendingReceipt);
        assert.equal(historicalFailedReceipt.status, "failed");
        assert.equal(historicalFailedReceipt.result, undefined);
        assert.equal(typeof historicalFailedReceipt.completedAt, "number");
        assert.deepEqual(historicalFailedReceipt.failure, {
          code: "integration_unavailable",
          kind: "connection",
          stage: "connection",
          retry: "later",
          fields: [],
        });
        assert(historicalFailedReceipt.auditId);
        const audit = h.identity["db"]
          .prepare("SELECT * FROM agent_audit WHERE id=?")
          .get(historicalFailedReceipt.auditId);
        assert(audit);
        assert.equal(audit.outcome, "failed");
        assert.equal(audit.organization_id, h.target.organizationId);
        assert.equal(audit.workspace_id, scope.workspaceId);
        assert.equal(audit.actor_id, scope.userId);
        assert.equal(audit.source, "chat");
        assert.equal(audit.action, "catalog.action_invoked");
        assert.equal(audit.target_id, h.writeId);
        assert.equal(typeof audit.finished_at, "string");
        assertOperationLink(pendingOperationId);
        if (mode === "progressive")
          assert.deepEqual(
            savedTurn(),
            pendingTurn,
            "TEST progressive resolve preserves its original approval projection",
          );
        else assert.equal(savedTurn().answer?.result?.status, "failed");
        assert.equal(serviceAttempts, 1);
        assert.deepEqual(h.dispatches, []);
        resolveWire = JSON.stringify(
          CommandSchema.parse({
            type: "service.resolve",
            commandId: command.commandId + "-resolve",
            idempotencyKey: command.commandId + "-resolve",
            conversationId: command.conversationId,
            operationId: pendingOperationId,
            approved: true,
            language: command.language,
          }),
        );
      }
      assert.equal(
        outerRows().length,
        0,
        "TEST retained production precedes both outer workflow receipts",
      );
    } else {
      h.identity.mobileAccess = historicalAccess;
      try {
        const pending = await h.mobile(
          credential,
          commandPath,
          undefined,
          wire,
        );
        assert.equal(pending.status, 202, JSON.stringify(pending.data));
        const initial = CommandResultSchema.parse(pending.data);
        assert.equal(initial.status, "accepted");
        const offered = initial.snapshot.conversations[0]!.messages.findLast(
          (message) => message.result?.type === "service.action",
        );
        assert(offered?.result?.type === "service.action");
        assert.equal(
          offered.result.status,
          "awaiting_approval",
          JSON.stringify(initial),
        );
        pendingOperationId = offered.result.operationId;
      } finally {
        h.identity.mobileAccess = currentAccess;
      }
      assert.equal(outerRows().length, 1);
      assert.deepEqual(
        OuterReceipt.parse(JSON.parse(String(outerRows()[0]!.payload))).command,
        command,
      );
    }
    const before = savedTurn();
    const outerScope = JSON.stringify([
      scope.connectionId,
      scope.serverId,
      scope.userId,
      scope.workspaceId,
    ]);
    for (const row of outerRows()) assert.equal(row.scope_key, outerScope);
    const pendingReceipt = pendingOperationId
      ? structuredClone(
          h.identity["catalog"].store.invocation(
            pendingOperationId,
            scope.workspaceId,
            scope.userId,
          ),
        )
      : undefined;
    assert.equal(before.kind, mode === "agent" ? "agent-1" : "progressive-1");
    assert.equal(before.commandId, command.commandId);
    assert.equal(before.text, command.text);
    assert.equal(before.language, command.language);
    if (before.kind === "agent-1")
      assert.equal(before.requestHash, hash(command));
    else assert.equal(Object.hasOwn(before, "requestHash"), false);
    assert.equal(
      h.identity["catalog"].store.nativeTurns(scope.workspaceId, scope.userId)
        .length,
      0,
    );
    assert.deepEqual(h.dispatches, []);
    assert(h.modelCount() > 0);
    assert(modelAttempts > 0);
    if (mode === "progressive") assert(decisions.length > 0);
    assert(decisions.every((method) => method === "POST"));
    const produced = ledger();
    const producerCount = producerCalls;
    const copiedCounts = {
      models: h.modelCount(),
      decisions: decisions.length,
      dispatches: [...h.dispatches],
      serviceAttempts,
      modelAttempts,
      decisionAttempts,
    };
    copy = await h.restoreCopy((proof) => {
      assert.notEqual(proof.source, proof.destination);
      assert.deepEqual(proof.copyHashes, proof.sourceHashes);
      const source = tupleFiles(proof.source),
        destination = tupleFiles(proof.destination);
      assert.deepEqual(source.hashes, proof.sourceHashes);
      assert.deepEqual(destination.hashes, proof.copyHashes);
      assert.deepEqual(destination.modes, source.modes);
      protectedModes = source.modes;
      for (const path of [
        "identity/secret",
        "identity/identity.sqlite",
        "workflow/workflow.sqlite",
        "TEST-server-config.json",
        "key",
      ])
        assert(proof.copyHashes[path], path);
      assert(
        Object.keys(proof.copyHashes).some((path) =>
          path.endsWith("server-id"),
        ),
      );
      assert.equal(
        proof.integrity.length,
        Object.keys(proof.copyHashes).filter((path) => path.endsWith(".sqlite"))
          .length,
      );
      for (const item of proof.integrity) {
        assert.deepEqual(item.checks, ["ok"]);
        assert.deepEqual(item.foreignKeys, []);
      }
    });
    assert.equal(h.config.dataDirectory, join(copy.destination, "workflow"));
    assert.equal(
      h.config.administration!.identity!.directory,
      join(copy.destination, "identity"),
    );
    assert.equal(
      fileURLToPath(h.identity["catalog"].store.nativeStorageUrl),
      join(copy.destination, "identity", "identity.sqlite.mastra.sqlite"),
    );
    installTransport();
    assert.notEqual(h.identity.mobileAccess, historicalAccess);
    assert.deepEqual(ledger(), produced);
    assert.deepEqual(savedTurn(), before);
    assert.equal(h.modelCount(), copiedCounts.models);
    assert.equal(decisions.length, copiedCounts.decisions);
    assert.deepEqual(h.dispatches, copiedCounts.dispatches);
    assert.equal(serviceAttempts, copiedCounts.serviceAttempts);
    assert.equal(modelAttempts, copiedCounts.modelAttempts);
    assert.equal(decisionAttempts, copiedCounts.decisionAttempts);
    const assertFailedSnapshot = (snapshot: z.infer<typeof SnapshotSchema>) => {
      assert(historicalFailedResult);
      const visible = snapshot.conversations
        .find((conversation) => conversation.id === command.conversationId)!
        .messages.findLast(
          (message) =>
            message.result?.type === "service.action" &&
            message.result.operationId === pendingOperationId,
        );
      assert(visible?.result?.type === "service.action");
      assert.equal(visible.result.status, "failed");
      assert.equal(visible.result.operationId, pendingOperationId);
      assert.equal(visible.result.effect, "write");
      assert.deepEqual(visible.result, historicalFailedResult);
      assert.match(visible.text, /failed/i);
      assert(
        visible.result.fields.some(
          (field) =>
            field.label === "Error code" &&
            field.value === "integration_unavailable",
        ),
      );
      assert(
        visible.result.fields.some(
          (field) =>
            field.label === "Next step" &&
            field.value ===
              "Try again later; a write still needs its required approval.",
        ),
      );
      assert.deepEqual(visible.result.card?.actions, []);
    };
    const assertHistoricalFailurePreserved = () => {
      assert(historicalFailedReceipt);
      assert.deepEqual(
        invocation(historicalFailedReceipt.id),
        historicalFailedReceipt,
      );
      assertOperationLink(historicalFailedReceipt.id);
      assert.deepEqual(savedTurn(), before);
      assert.deepEqual(ledger().identity, produced.identity);
      assert.equal(h.modelCount(), copiedCounts.models);
      assert.equal(decisions.length, copiedCounts.decisions);
      assert.equal(serviceAttempts, copiedCounts.serviceAttempts);
      assert.equal(modelAttempts, copiedCounts.modelAttempts);
      assert.equal(decisionAttempts, copiedCounts.decisionAttempts);
      assert.deepEqual(h.dispatches, copiedCounts.dispatches);
      assert.equal(producerCalls, producerCount);
      assert.equal(
        h.identity["catalog"].store.nativeTurns(scope.workspaceId, scope.userId)
          .length,
        0,
      );
      assert.deepEqual(tupleFiles(copy!.source), {
        hashes: copy!.sourceHashes,
        modes: protectedModes,
      });
    };
    let receipt: StoredInvocation | undefined;
    if (outcome === "failed") {
      assert(historicalFailedReceipt);
      assert(resolveWire);
      receipt = historicalFailedReceipt;
      assertHistoricalFailurePreserved();
      assert.equal(
        outerRows().length,
        0,
        "TEST copied canonical failure has no hot outer command or resolve receipt",
      );
      // No outer receipt exists: this authenticated current HTTP command must
      // route through the saved historical kind, not FixtureStorage replay.
      const first = await h.mobile(credential, commandPath, undefined, wire);
      assert.equal(first.status, 202, JSON.stringify(first.data));
      const answer = CommandResultSchema.parse(first.data);
      assert.equal(answer.status, "accepted");
      assert.deepEqual(answer.snapshot.scope, scope);
      assertFailedSnapshot(answer.snapshot);
      assertHistoricalFailurePreserved();
      assert.equal(outerRows().length, 1);
      const firstOuter = outerRows()[0]!;
      assert.equal(firstOuter.scope_key, outerScope);
      assert.equal(firstOuter.command_id, command.commandId);
      assert.equal(firstOuter.idempotency_key, command.idempotencyKey);
      assert.deepEqual(
        OuterReceipt.parse(JSON.parse(String(firstOuter.payload))).command,
        command,
      );
      const resolution = CommandSchema.parse(JSON.parse(resolveWire));
      assert.equal(
        outerRows().filter(
          (row) =>
            row.command_id === resolution.commandId ||
            row.idempotency_key === resolution.idempotencyKey,
        ).length,
        0,
        "TEST first public resolve cannot use an outer resolve receipt",
      );
      const terminal = await h.mobile(
        credential,
        commandPath,
        undefined,
        resolveWire,
      );
      assert.equal(terminal.status, 202, JSON.stringify(terminal.data));
      const resolved = CommandResultSchema.parse(terminal.data);
      assert.equal(resolved.status, "accepted");
      assertFailedSnapshot(resolved.snapshot);
      assertHistoricalFailurePreserved();
      assert.equal(outerRows().length, 2);
      const resolveOuter = outerRows().find(
        (row) => row.command_id === resolution.commandId,
      )!;
      assert.equal(resolveOuter.scope_key, outerScope);
      assert.deepEqual(
        OuterReceipt.parse(JSON.parse(String(resolveOuter.payload))).command,
        resolution,
      );
    } else if (outcome === "question") {
      assert.equal(before.paused, true);
      if (before.kind === "progressive-1")
        assert.equal(before.pendingInput, true);
      assert.equal(outerRows().length, 0);
      const first = await h.mobile(credential, commandPath, undefined, wire);
      assert.equal(first.status, 202, JSON.stringify(first.data));
      const answer = CommandResultSchema.parse(first.data);
      assert.equal(answer.status, "accepted");
      assert.equal(
        answer.snapshot.conversations[0]!.messages.findLast(
          (message) => message.role === "assistant",
        )!.text,
        question,
      );
      assert.deepEqual(savedTurn(), before);
      assert.equal(h.modelCount(), copiedCounts.models);
      assert.equal(decisions.length, copiedCounts.decisions);
      assert.deepEqual(h.dispatches, []);
      assert.equal(outerRows().length, 1);
      assert.deepEqual(
        OuterReceipt.parse(JSON.parse(String(outerRows()[0]!.payload))).command,
        command,
      );
      assert.deepEqual(ledger().identity, produced.identity);
    } else {
      const pending = h.identity["db"]
        .prepare(
          "SELECT id FROM agent_service_invocation WHERE workspace_id=? AND user_id=?",
        )
        .all(scope.workspaceId, scope.userId);
      assert.equal(pending.length, 1);
      const operationId = String(pending[0]!.id);
      assert.equal(operationId, pendingOperationId);
      const originalReceipt = structuredClone(
        h.identity["catalog"].store.invocation(
          operationId,
          scope.workspaceId,
          scope.userId,
        ),
      );
      assert(originalReceipt);
      assert.deepEqual(originalReceipt, pendingReceipt);
      assert.equal(originalReceipt.status, "awaiting_approval");
      assert.deepEqual(originalReceipt.input, originalInput);
      assert.equal(originalReceipt.organizationId, h.target.organizationId);
      assert.equal(originalReceipt.workspaceId, scope.workspaceId);
      assert.equal(originalReceipt.userId, scope.userId);
      assert.equal(originalReceipt.serviceId, h.serviceId);
      assert.equal(originalReceipt.actionId, h.writeId);
      const resolve = CommandSchema.parse({
        type: "service.resolve",
        commandId: command.commandId + "-resolve",
        idempotencyKey: command.commandId + "-resolve",
        conversationId: command.conversationId,
        operationId,
        approved: outcome !== "rejected",
        language: "en",
      });
      resolveWire = JSON.stringify(resolve);
      const terminal = await h.mobile(
        credential,
        commandPath,
        undefined,
        resolveWire,
      );
      assert.equal(terminal.status, 202, JSON.stringify(terminal.data));
      assert.equal(CommandResultSchema.parse(terminal.data).status, "accepted");
      receipt = structuredClone(
        h.identity["catalog"].store.invocation(
          operationId,
          scope.workspaceId,
          scope.userId,
        ),
      );
      assert(receipt);
      assert.equal(receipt.status, outcome);
      assertAuthority(receipt, originalReceipt);
      assert.deepEqual(h.dispatches, outcome === "rejected" ? [] : ["POST"]);
      assert.equal(savedTurn().kind, before.kind);
      assert.equal(outerRows().length, 2);
      assert.deepEqual(
        OuterReceipt.parse(
          JSON.parse(
            String(
              outerRows().find((row) => row.command_id === resolve.commandId)!
                .payload,
            ),
          ),
        ).command,
        resolve,
      );
    }
    const finalTurn = savedTurn();
    const finalLedger = ledger();
    const finalCounts = {
      models: h.modelCount(),
      decisions: decisions.length,
      dispatches: [...h.dispatches],
      serviceAttempts,
      modelAttempts,
      decisionAttempts,
    };
    if (outcome === "failed") {
      for (const exactBytes of [wire, resolveWire!]) {
        const replay = await h.mobile(
          credential,
          commandPath,
          undefined,
          exactBytes,
        );
        assert.equal(replay.status, 202, JSON.stringify(replay.data));
        const repeated = CommandResultSchema.parse(replay.data);
        assert.equal(repeated.status, "accepted");
        assertFailedSnapshot(repeated.snapshot);
      }
      assert.deepEqual(ledger(), finalLedger);
      assertHistoricalFailurePreserved();
    }
    for (let reopen = 0; reopen < 2; reopen++) {
      await h.restart();
      installTransport();
      assert.deepEqual(ledger(), finalLedger);
      const snapshot = await h.mobile(credential, snapshotPath);
      assert.equal(snapshot.status, 200);
      assert.deepEqual(SnapshotSchema.parse(snapshot.data).scope, scope);
      if (outcome === "failed")
        assertFailedSnapshot(SnapshotSchema.parse(snapshot.data));
      assert.deepEqual(
        ledger(),
        finalLedger,
        "TEST public snapshot is passive",
      );
      for (const exactBytes of [wire, ...(resolveWire ? [resolveWire] : [])]) {
        const replay = await h.mobile(
          credential,
          commandPath,
          undefined,
          exactBytes,
        );
        assert.equal(replay.status, 202, JSON.stringify(replay.data));
        const repeated = CommandResultSchema.parse(replay.data);
        assert.equal(repeated.status, "accepted");
        if (outcome === "failed") assertFailedSnapshot(repeated.snapshot);
      }
      if (outcome === "question" || outcome === "failed") {
        const conflict = await h.mobile(credential, commandPath, {
          ...command,
          text: "TEST changed original input",
        });
        assert.equal(conflict.status, 422, JSON.stringify(conflict.data));
        assert.equal(
          CommandResultSchema.parse(conflict.data).code,
          "idempotency_conflict",
        );
        if (outcome === "question")
          assert.equal(
            SnapshotSchema.parse(
              snapshot.data,
            ).conversations[0]!.messages.findLast(
              (message) => message.role === "assistant",
            )!.text,
            question,
          );
        else
          assertFailedSnapshot(
            CommandResultSchema.parse(conflict.data).snapshot,
          );
      }
      assert.deepEqual(ledger(), finalLedger);
      assert.deepEqual(savedTurn(), finalTurn);
      if (receipt)
        assert.deepEqual(
          h.identity["catalog"].store.invocation(
            receipt.id,
            scope.workspaceId,
            scope.userId,
          ),
          receipt,
        );
      assert.equal(h.modelCount(), finalCounts.models);
      assert.equal(decisions.length, finalCounts.decisions);
      assert.equal(serviceAttempts, finalCounts.serviceAttempts);
      assert.equal(modelAttempts, finalCounts.modelAttempts);
      assert.equal(decisionAttempts, finalCounts.decisionAttempts);
      assert.deepEqual(h.dispatches, finalCounts.dispatches);
      assert.equal(producerCalls, producerCount);
      assert.equal(
        h.identity["catalog"].store.nativeTurns(scope.workspaceId, scope.userId)
          .length,
        0,
      );
      assert.deepEqual(tupleFiles(copy.source), {
        hashes: copy.sourceHashes,
        modes: protectedModes,
      });
      if (outcome === "failed") assertHistoricalFailurePreserved();
    }
    return {
      mode,
      outcome,
      kind: before.kind,
      reopens: 2,
      dispatches: h.dispatches,
      decisions: decisions.length,
      models: h.modelCount(),
      serviceAttempts,
      receiptStatusAtCopy: pendingReceipt?.status ?? null,
      firstPublicQuestionRoute: outcome === "question",
      firstPublicFailedRoute: outcome === "failed",
      protectedSource: true,
    };
  } finally {
    try {
      if (copy)
        assert.deepEqual(tupleFiles(copy.source), {
          hashes: copy.sourceHashes,
          modes: protectedModes,
        });
    } finally {
      await h.close();
    }
  }
}
