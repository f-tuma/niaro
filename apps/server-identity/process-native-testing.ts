import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  PROCESS_NATIVE_TEST_PROFILE,
  NativeTestSuiteSchema,
  NativeTestReportSchema,
  NativeTestObservationSchema,
  type NativeTestSuite,
  type NativeTestCase,
  type NativeTestObservation,
  type NativeTestReceipt,
  NativeTestDiagnosticEvidenceSchema,
  type NativeTestDiagnosticEvidence,
  type NativeTestDiagnosticCode,
} from "../../packages/protocol/process-native-testing";
import { TestJsonSchema } from "../../packages/protocol/process-testing";
import { IdentityId } from "../../packages/protocol/identity";
import {
  ProcessVersionSchema,
  type ProcessVersion,
} from "../../packages/protocol/service-processes";
import {
  Routing,
  ServiceSettings,
  ProviderSettings,
} from "../../packages/protocol/service-catalog";
import { MemorySettingsSchema } from "../../packages/protocol/memory";
import {
  processCompilerVersion,
  processValueSchema,
} from "../server-agent/process-workflow";
import { runNativeComparisonDataset } from "../server-agent/process-native-experiment";
import { NativeTestDiagnosticError } from "../server-agent/process-native-diagnostic";
import { CatalogController, type CatalogContext } from "./catalog-controller";
import { ServiceCatalogStore, type StoredInvocation } from "./service-catalog";
import {
  createServiceProcessRuntime,
  type ProcessRunResult,
} from "./service-process-runtime";
import { createCatalogRuntime, type ServiceAnswer } from "./catalog-runtime";
import { closeNativeCatalogRuntime } from "./mastra-runtime";
import { DomainCommandSchema, nativeQuestionId } from "./mastra-domain";
import {
  JournalSchema,
  serviceProcessRunIdentity,
} from "./service-process-journal";
import { ProcessQuestionStore } from "./process-question-store";
import { createNativeTestAdmission } from "./process-native-test-admission";
import {
  PROCESS_QUESTION_EXECUTION_PROFILE,
  ProcessAnswerCommandSchema,
} from "../../packages/protocol/process-questions";
import { MemoryStore } from "./memory";
import { createMemoryRuntime } from "./memory-runtime";
import { AuditStore } from "./audit";
import { IdentityError } from "./error";
import { isInferenceBudgetFailureCode } from "./inference-budget-failure";
import { processDigest } from "./process-validation";
import { nativeObservableAssertions } from "./process-native-verdict";
import { assertDesignContent } from "./process-design-store";
import {
  ProcessTestCatalogSchema,
  type ProcessTestCatalog,
} from "./process-test-catalog";
import {
  IntegrationError,
  type IntegrationTransport,
} from "../server-integrations/transport";

import {
  processNativeStamp,
  processNativeExecutionSettings,
} from "./process-native-environment";
export {
  PROCESS_NATIVE_TEST_RUNNER_VERSION,
  processNativeStamp,
  processNativeExecutionSettings,
} from "./process-native-environment";
const origin = "https://native-test.example.test";
const serviceUrl = (id: string) =>
  `${origin}/services/${encodeURIComponent(id)}`;
const providerUrl = (id: string) =>
  `${origin}/providers/${encodeURIComponent(id)}/v1`;
class NativeTestQuestionBoundaryError extends NativeTestDiagnosticError {}

/** Internal snapshot plus a closed resolver, never a production catalog/controller. */
async function observe(
  artifact: ProcessVersion,
  catalog: ProcessTestCatalog,
  item: NativeTestCase,
  genericModelId: string | undefined,
  strategy: "configured" | "generic",
  path: string,
  signal: AbortSignal,
  authorize: () => Promise<void>,
  capture: (evidence: NativeTestDiagnosticEvidence) => void,
): Promise<NativeTestObservation> {
  const obs: NativeTestObservation = {
    caseId: item.id,
    scenario: item.scenario,
    strategy,
    runId: randomUUID(),
    observed: "failed",
    receipts: [],
    modelCalls: 0,
    businessDispatches: 0,
    approvals: 0,
    reopened: false,
    infrastructureCodes: [],
    budget: {
      accountedTokens: 0,
      accountedCostMicros: 0,
      unknownCalls: 0,
      overrun: false,
    },
    assertions: [],
    passed: false,
  };
  const caseRunId = obs.runId;
  const questionEnabled =
    processCompilerVersion(artifact.definition) === "niaro-native-workflow/3";
  let configuredRunId = obs.runId;
  let modelIndex = 0,
    actionIndex = 0,
    questionIndex = 0;
  let infrastructure = false;
  const dispatches = new Map<string, number>(),
    approvals = new Set<string>();
  const target = {
    organizationId: catalog.organizationId,
    workspaceId: catalog.workspaceId,
  };
  const scope = {
    serverId: "niaro-isolated-native-test",
    connectionId: "niaro-isolated-native-test",
    workspaceId: catalog.workspaceId,
    userId: catalog.userId,
  };
  const caps = {
    maxTokens: artifact.definition.limits.maxTokens,
    maxCostMicros: artifact.definition.limits.maxCostMicros,
    maxModelCalls: artifact.definition.limits.maxModelCalls,
  };
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => T | Promise<T>): Promise<T> => {
    const next = queue.then(fn);
    queue = next.catch(() => {});
    return next;
  };
  const check = async () => {
    signal.throwIfAborted();
    await authorize();
    signal.throwIfAborted();
  };
  function fault(code: string): never {
    infrastructure = true;
    if (
      !obs.infrastructureCodes.includes(code) &&
      obs.infrastructureCodes.length < 8
    )
      obs.infrastructureCodes.push(code);
    if (code === "native_test_approval_unexpected")
      throw new NativeTestDiagnosticError(code);
    throw Error(code);
  }
  const same = (a: unknown, b: unknown) =>
    a === undefined || b === undefined
      ? a === b
      : processDigest(a) === processDigest(b);
  const actor = { ...target, userId: catalog.userId, role: catalog.role };
  let owner: ReturnType<typeof open>;
  function rows(): StoredInvocation[] {
    return owner.db
      .prepare("SELECT data FROM agent_service_invocation ORDER BY rowid")
      .all()
      .map((row) => JSON.parse(String(row.data)) as StoredInvocation);
  }
  function fixture(receipt: StoredInvocation) {
    const f = item.actions[actionIndex] ?? fault("native_test_fixture_missing");
    if (
      f.serviceId !== receipt.serviceId ||
      f.actionId !== receipt.actionId ||
      !same(f.input, receipt.input)
    )
      fault("native_test_fixture_conflict");
    return f;
  }
  const transport: IntegrationTransport = async (request) => {
    await check();
    request.signal?.throwIfAborted();
    const url = new URL(request.url);
    if (url.origin !== origin || !request.beforeDispatch)
      fault("native_test_transport_denied");
    const provider = catalog.providers.find(
      (p) => request.url === providerUrl(p.id) + "/chat/completions",
    );
    if (provider) {
      const step =
        item.models[strategy][modelIndex] ?? fault("native_test_model_missing");
      const model = catalog.models.find((m) => m.id === step.modelId);
      const body = request.body as {
        model?: string;
        tools?: { function: { name: string } }[];
      };
      if (
        !model ||
        model.providerId !== provider.id ||
        body?.model !== model.model ||
        step.requiredTools.some(
          (name) => !body.tools?.some((t) => t.function.name === name),
        )
      )
        fault("native_test_model_conflict");
      await request.beforeDispatch(() => {
        modelIndex++;
        obs.modelCalls++;
      });
      const message =
        step.reply.type === "text"
          ? { content: step.reply.text }
          : {
              content: null,
              tool_calls: [
                {
                  id: step.reply.callId,
                  type: "function",
                  function: {
                    name: step.reply.name,
                    arguments: JSON.stringify(step.reply.input),
                  },
                },
              ],
            };
      return {
        status: 200,
        headers: {},
        text: JSON.stringify({
          choices: [{ message }],
          usage: {
            prompt_tokens: step.usage.inputTokens,
            completion_tokens: step.usage.outputTokens,
          },
        }),
      };
    }
    const service = catalog.services.find(
      (s) =>
        url.pathname === new URL(serviceUrl(s.id)).pathname ||
        url.pathname.startsWith(new URL(serviceUrl(s.id)).pathname + "/"),
    );
    if (!service) fault("native_test_transport_denied");
    // MCP connection/control traffic is mocked but is never a business dispatch.
    if (service.protocol === "mcp") {
      const body = request.body as {
        id?: number;
        method?: string;
        params?: { name?: string; arguments?: unknown };
      };
      if (
        body.method === "initialize" ||
        body.method === "notifications/initialized"
      ) {
        await request.beforeDispatch(() => {});
        return {
          status: 200,
          headers: {},
          text: JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "NIARO TEST", version: "1" },
            },
          }),
        };
      }
      if (body.method !== "tools/call") fault("native_test_transport_denied");
    }
    const candidates = rows().filter(
      (r) =>
        r.serviceId === service.id &&
        (r.status === "running" || r.status === "awaiting_approval"),
    );
    if (candidates.length !== 1) fault("native_test_receipt_conflict");
    const receipt = candidates[0]!;
    const f = fixture(receipt);
    const action =
      service.actions.find((a) => a.id === receipt.actionId) ??
      fault("native_test_action_missing");
    if (action.binding.type === "mcp") {
      const body = request.body as {
        params?: { name?: string; arguments?: unknown };
      };
      const expected = action.binding.catalogTool
        ? { toolName: action.binding.catalogTool, arguments: receipt.input }
        : receipt.input;
      if (
        body.params?.name !== action.binding.name ||
        !same(body.params?.arguments, expected)
      )
        fault("native_test_mcp_request_conflict");
    } else if (request.method !== action.binding.method)
      fault("native_test_http_request_conflict");
    if (f.decision === "approve" && !approvals.has(receipt.id))
      fault("native_test_approval_not_exercised");
    if (f.decision === "reject" || dispatches.has(receipt.id))
      fault("native_test_duplicate_dispatch");
    await request.beforeDispatch(() => {
      actionIndex++;
      dispatches.set(receipt.id, 1);
      obs.businessDispatches++;
    });
    if (f.outcome === "unknown")
      throw new IntegrationError("integration_unavailable", 502);
    const value =
      f.outcome === "failure"
        ? { error: { message: "NIARO TEST service rejected the request" } }
        : f.output;
    if (service.protocol === "mcp") {
      const body = request.body as { id?: number };
      return {
        status: 200,
        headers: {},
        text: JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result:
            f.outcome === "failure"
              ? {
                  isError: true,
                  content: [
                    {
                      type: "text",
                      text: "NIARO TEST service rejected the request",
                    },
                  ],
                }
              : mcpFixtureResult(value),
        }),
      };
    }
    return {
      status: f.outcome === "failure" ? 422 : 200,
      headers: {},
      text: JSON.stringify(value),
    };
  };
  function open() {
    const db = new DatabaseSync(path);
    db.exec(
      'PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS organization(id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS user(id TEXT PRIMARY KEY,name TEXT); CREATE TABLE IF NOT EXISTS agent_workspace(id TEXT PRIMARY KEY,organization_id TEXT,name TEXT); CREATE TABLE IF NOT EXISTS member(id TEXT PRIMARY KEY,"organizationId" TEXT,"userId" TEXT); CREATE TABLE IF NOT EXISTS test_native_pin(run_id TEXT PRIMARY KEY,artifact_digest TEXT NOT NULL);',
    );
    db.prepare("INSERT OR IGNORE INTO organization VALUES(?)").run(
      target.organizationId,
    );
    db.prepare("INSERT OR IGNORE INTO user VALUES(?,?)").run(
      scope.userId,
      "NIARO TEST actor",
    );
    db.prepare("INSERT OR IGNORE INTO agent_workspace VALUES(?,?,?)").run(
      target.workspaceId,
      target.organizationId,
      "NIARO TEST workspace",
    );
    db.prepare("INSERT OR IGNORE INTO member VALUES(?,?,?)").run(
      "NIARO-TEST-member",
      target.organizationId,
      scope.userId,
    );
    const audit = new AuditStore(db);
    const store = new ServiceCatalogStore(db, "NIARO TEST isolated key", []);
    // A model-free workspace workflow legitimately has no catalog resources.
    // Routing is seeded even for that empty snapshot and survives a reopen.
    if (
      !db
        .prepare("SELECT 1 FROM agent_catalog_routing WHERE workspace_id=?")
        .get(target.workspaceId)
    ) {
      const put = (
        id: string,
        scopeId: string,
        kind: string,
        revision: number,
        data: unknown,
      ) =>
        db
          .prepare("INSERT INTO agent_catalog VALUES(?,?,?,?,?,NULL)")
          .run(id, scopeId, kind, revision, JSON.stringify(data));
      for (const service of catalog.services) {
        put(
          service.id,
          target.workspaceId,
          "service",
          service.revision,
          ServiceSettings.parse({
            name: service.name,
            url: serviceUrl(service.id),
            protocol: service.protocol,
            icon: "plug",
            auth: { type: "none" },
            enabled: service.enabled,
            access: service.access,
          }),
        );
        for (const action of service.actions) {
          const { id, revision, ...settings } = action;
          put(id, service.id, "action", revision, {
            ...settings,
            sourceKey: null,
          });
        }
      }
      for (const provider of catalog.providers)
        put(
          provider.id,
          target.organizationId,
          "provider",
          provider.revision,
          ProviderSettings.parse({
            name: "NIARO TEST provider",
            url: providerUrl(provider.id),
            enabled: provider.enabled,
            dailyRequestLimit: provider.dailyRequestLimit,
          }),
        );
      for (const model of catalog.models) {
        const { id, revision, ...settings } = model;
        put(id, target.organizationId, "model", revision, settings);
      }
      db.prepare("INSERT INTO agent_catalog_routing VALUES(?,?,?)").run(
        target.workspaceId,
        1,
        JSON.stringify(
          Routing.parse({
            revision: 1,
            modelId: genericModelId ?? null,
            services: catalog.services.map((s) => ({
              serviceId: s.id,
              modelId: genericModelId ?? null,
            })),
            planner: "model",
            decision: { enabled: false, modelId: null, minConfidence: 0.8 },
          }),
        ),
      );
      for (const roleId of catalog.workspaceRoles) {
        db.prepare("INSERT INTO agent_workspace_role VALUES(?,?,?,?)").run(
          roleId,
          target.workspaceId,
          1,
          roleId,
        );
        db.prepare("INSERT INTO agent_workspace_role_member VALUES(?,?)").run(
          roleId,
          "NIARO-TEST-member",
        );
      }
      store.inferenceBudget.savePolicy(
        target.organizationId,
        target.workspaceId,
        0,
        catalog.budget,
      );
    }
    const controller = new CatalogController(store, transport);
    const context: CatalogContext = {
      serial,
      actor: async (t) => {
        await check();
        if (
          t.organizationId !== target.organizationId ||
          t.workspaceId !== target.workspaceId
        )
          throw new IdentityError(403, "identity_forbidden");
        return { userId: scope.userId, role: actor.role };
      },
      epoch: () => 0,
      change: () => {},
      audit: (r) => audit.append(r),
      finish: (...args) => audit.finish(...args),
      transaction: async (fn) => fn(),
    };
    const authorizeActor = (a: typeof actor) => {
      if (
        a.organizationId !== actor.organizationId ||
        a.workspaceId !== actor.workspaceId ||
        a.userId !== actor.userId
      )
        throw new IdentityError(403, "identity_forbidden");
    };
    const resolver = {
      pinRun: (a: typeof actor, processId: string, runId: string) => {
        authorizeActor(a);
        if (processId !== artifact.processId)
          throw new IdentityError(404, "process_not_found");
        const previous = db
          .prepare("SELECT artifact_digest FROM test_native_pin WHERE run_id=?")
          .get(runId);
        if (previous && previous.artifact_digest !== artifact.digest)
          throw new IdentityError(409, "process_conflict");
        db.prepare("INSERT OR IGNORE INTO test_native_pin VALUES(?,?)").run(
          runId,
          artifact.digest,
        );
        return artifact;
      },
      resolveRun: (a: typeof actor, runId: string) => {
        authorizeActor(a);
        if (
          db
            .prepare(
              "SELECT artifact_digest FROM test_native_pin WHERE run_id=?",
            )
            .get(runId)?.artifact_digest !== artifact.digest
        )
          throw new IdentityError(404, "process_not_found");
        return artifact;
      },
    };
    const memoryStore = new MemoryStore(db, {
      secret: "NIARO TEST saved-memory key",
    });
    const memory = createMemoryRuntime(
      memoryStore,
      { ...target, userId: scope.userId, canManageShared: true },
      MemorySettingsSchema.parse({}),
      {
        read: (fn) =>
          serial(async () => {
            await check();
            return fn();
          }),
        mutate: async () => {
          throw Error("native_test_memory_read_only");
        },
        check: () => signal.throwIfAborted(),
        sourceAccess: () => false,
      },
    );
    const admission =
      questionEnabled && strategy === "configured"
        ? createNativeTestAdmission(db, artifact, actor, scope, caseRunId)
        : undefined;
    const questions = admission
      ? new ProcessQuestionStore(db, admission.starts)
      : undefined;
    return {
      db,
      store,
      controller,
      memoryStore,
      admission,
      questions,
      process: createServiceProcessRuntime(
        controller,
        admission?.resolver ?? resolver,
        context,
        scope,
        target.organizationId,
        { memory, ...(questions ? { questions } : {}) },
      ),
      generic: createCatalogRuntime(
        controller,
        transport,
        context,
        scope,
        target.organizationId,
        true,
        false,
        { enabled: [], timeZone: "UTC" },
        memory,
        caps,
        undefined,
        "generic",
      ),
    };
  }
  const close = async () => {
    await queue;
    try {
      await closeNativeCatalogRuntime(owner.controller);
      await owner.memoryStore.close();
    } finally {
      owner.db.close();
    }
  };
  const reopen = async () => {
    await close();
    owner = open();
    obs.reopened = true;
  };
  const readGeneric = () => {
    const row = owner.db
      .prepare(
        "SELECT data FROM agent_service_turn WHERE json_extract(data,'$.kind')='mastra-1' ORDER BY rowid DESC LIMIT 1",
      )
      .get();
    return row
      ? DomainCommandSchema.parse(JSON.parse(String(row.data)))
      : undefined;
  };
  const start = async () => {
    if (strategy === "configured") {
      if (owner.admission) {
        const receipt = await serial(async () => {
          await check();
          return owner.admission!.admit(item.input);
        });
        if (receipt.status !== "admitted")
          fault("native_test_admission_rejected");
        configuredRunId = receipt.runId;
        obs.runId = receipt.runId;
      }
      return owner.process.start(
        artifact.processId,
        configuredRunId,
        item.input,
        signal,
      );
    }
    return owner.generic.message(
      obs.runId,
      JSON.stringify(item.input),
      "en",
      [],
      signal,
      undefined,
      undefined,
      "UTC",
      { conversationId: obs.runId, session: "new" },
    );
  };
  owner = open();
  let completed: ProcessRunResult | ServiceAnswer | null | undefined;
  let primary: unknown;
  let facts: NativeTestDiagnosticEvidence | undefined;
  const retire = (code: NativeTestDiagnosticCode) => {
    if (primary instanceof NativeTestDiagnosticError) primary.secondary(code);
    else if (!primary) primary = new NativeTestDiagnosticError(code, facts);
  };
  try {
    await check();
    if (
      !processValueSchema(artifact.definition.inputSchema).safeParse(item.input)
        .success
    ) {
      obs.observed = "input_invalid";
      obs.code = "process_input_invalid";
    } else {
      completed = await start();
      let resumes = 0;
      let pending = rows().find((r) => r.status === "awaiting_approval");
      let configuredQuestion =
        strategy === "configured"
          ? (completed as ProcessRunResult).question
          : undefined;
      let genericQuestion =
        strategy === "generic" ? readGeneric()?.pending : undefined;
      if (
        (pending ||
          configuredQuestion ||
          genericQuestion?.kind === "question") &&
        item.reopenAt === "suspended"
      )
        await reopen();
      while (
        pending ||
        configuredQuestion ||
        genericQuestion?.kind === "question"
      ) {
        if (configuredQuestion || genericQuestion?.kind === "question") {
          const fixture = item.questions?.[strategy][questionIndex];
          const actualQuestion =
            configuredQuestion?.question ?? genericQuestion?.question;
          if (
            !questionEnabled ||
            !fixture ||
            fixture.question !== actualQuestion
          )
            throw new NativeTestQuestionBoundaryError(
              "native_test_question_fixture_conflict",
            );
          if (configuredQuestion) {
            const question = configuredQuestion;
            const binding = await serial(async () => {
              await check();
              if (!owner.questions || !owner.admission)
                throw new NativeTestQuestionBoundaryError(
                  "native_test_question_storage_missing",
                );
              const journal = JournalSchema.parse(
                owner.store.turn(
                  question.parentRunId,
                  scope.workspaceId,
                  scope.userId,
                ),
              );
              return owner.questions.bind(
                actor,
                scope,
                ProcessAnswerCommandSchema.parse({
                  profile: PROCESS_QUESTION_EXECUTION_PROFILE,
                  type: "process.answer",
                  commandId: caseRunId + "-answer-" + questionIndex,
                  idempotencyKey: caseRunId + "-answer-key-" + questionIndex,
                  conversationId: caseRunId,
                  workItemId: question.parentRunId,
                  expectedWorkRevision: journal.revision,
                  nodeId: question.nodeId,
                  childRunId: question.childRunId,
                  toolCallId: question.toolCallId,
                  questionId: question.questionId,
                  questionRevision: question.questionRevision,
                  answer: fixture.answer,
                  language: "en",
                }),
                () => {},
              ).binding;
            });
            completed = await owner.process.resume(
              configuredRunId,
              {
                kind: "question",
                nodeId: question.nodeId,
                questionId: question.questionId,
                questionRevision: question.questionRevision,
                answerId: binding.bindingId,
              },
              signal,
            );
            if (!owner.questions!.consumed(binding.bindingId, question))
              throw new NativeTestQuestionBoundaryError(
                "native_test_question_answer_unconsumed",
              );
          } else {
            const state = readGeneric();
            if (!state || state.pending?.kind !== "question")
              throw new NativeTestQuestionBoundaryError(
                "native_test_generic_question_missing",
              );
            completed = await owner.generic.message(
              caseRunId + "-answer-" + questionIndex,
              fixture.answer,
              "en",
              [],
              signal,
              undefined,
              undefined,
              "UTC",
              {
                conversationId: caseRunId,
                task: {
                  workItemId: state.runId,
                  inputRequestId: nativeQuestionId(
                    state.runId,
                    state.pending.toolCallId,
                  ),
                  expectedInputRevision: 1,
                },
              },
            );
          }
          questionIndex++;
          configuredQuestion =
            strategy === "configured"
              ? (completed as ProcessRunResult).question
              : undefined;
          genericQuestion =
            strategy === "generic" ? readGeneric()?.pending : undefined;
          pending = rows().find((r) => r.status === "awaiting_approval");
          continue;
        }
        if (!pending)
          throw new NativeTestQuestionBoundaryError(
            "native_test_pending_missing",
          );
        if (++resumes > item.actions.length) fault("native_test_approval_loop");
        const f = fixture(pending);
        if (f.decision === "none") fault("native_test_approval_unexpected");
        if (!approvals.has(pending.id)) {
          approvals.add(pending.id);
          obs.approvals++;
        }
        if (f.decision === "reject") actionIndex++;
        if (strategy === "configured") {
          const approval = (completed as ProcessRunResult).approval;
          if (!approval || approval.operationId !== pending.id)
            fault("native_test_approval_conflict");
          completed = await owner.process.resume(
            configuredRunId,
            { ...approval, approved: f.decision === "approve" },
            signal,
          );
        } else
          completed = await owner.generic.resolve(
            pending.id,
            f.decision === "approve",
            "en",
            signal,
          );
        pending = rows().find((r) => r.status === "awaiting_approval");
        configuredQuestion =
          strategy === "configured"
            ? (completed as ProcessRunResult).question
            : undefined;
        genericQuestion =
          strategy === "generic" ? readGeneric()?.pending : undefined;
      }
      if (
        strategy === "configured" &&
        ["running", "waiting"].includes((completed as ProcessRunResult).status)
      )
        throw new NativeTestQuestionBoundaryError(
          "native_test_process_nonterminal",
        );
      // Every terminal command is replayed passively; restart cases also reopen storage.
      {
        const before = [modelIndex, actionIndex, obs.businessDispatches];
        if (item.reopenAt === "completed") await reopen();
        const replay = await start();
        if (!same(before, [modelIndex, actionIndex, obs.businessDispatches]))
          obs.assertions.push("replay_dispatched");
        if (
          !same(
            strategy === "configured"
              ? completed
              : (completed as ServiceAnswer | null)?.reply,
            strategy === "configured"
              ? replay
              : (replay as ServiceAnswer | null)?.reply,
          )
        )
          obs.assertions.push("native_result_unavailable");
      }
      const genericState = strategy === "generic" ? readGeneric() : undefined;
      if (strategy === "generic" && !genericState)
        fault("native_test_generic_result_missing");
      if (
        genericState &&
        (genericState.pending ||
          !genericState.trace?.finishedAt ||
          ["running", "waiting"].includes(genericState.trace.status))
      )
        throw new NativeTestQuestionBoundaryError(
          "native_test_generic_nonterminal",
        );
      const receipts = rows();
      const uncertain = receipts.find(
        (r) => r.status === "unknown" || r.status === "running",
      );
      const rejected = receipts.find((r) => r.status === "rejected");
      const failed = receipts.find((r) => r.status === "failed");
      const processResult =
        strategy === "configured" ? (completed as ProcessRunResult) : undefined;
      if (uncertain) {
        obs.observed = "unknown";
        obs.code = uncertain.failure?.code ?? "process_action_unknown";
      } else if (rejected) {
        obs.observed = "rejected";
        obs.code = rejected.failure?.code ?? "process_action_rejected";
      } else if (failed) {
        obs.observed = "failed";
        obs.code = failed.failure?.code ?? "process_action_failed";
      } else if (processResult && processResult.status !== "succeeded") {
        obs.observed = "failed";
        obs.code = processResult.failure?.code ?? "native_test_process_failed";
      } else if (genericState?.terminalCandidate) {
        obs.observed = "failed";
        obs.code = isInferenceBudgetFailureCode(genericState.terminalCandidate)
          ? genericState.terminalCandidate
          : `native_${genericState.terminalCandidate}`;
      } else if (genericState && genericState.trace?.status !== "succeeded") {
        obs.observed = "failed";
        obs.code = `native_${genericState.trace?.status ?? "result_missing"}`;
      } else {
        let value: unknown;
        try {
          value =
            strategy === "configured"
              ? processResult?.output
              : JSON.parse((completed as ServiceAnswer | null)?.reply ?? "");
        } catch {
          value = undefined;
        }
        const parsed = processValueSchema(
          artifact.definition.outputSchema,
        ).safeParse(value);
        if (!parsed.success) {
          obs.observed = "failed";
          obs.code = "process_output_invalid";
        } else {
          obs.observed = "succeeded";
          obs.output = parsed.data as NativeTestObservation["output"];
        }
      }
    }
  } catch (error) {
    if (signal.aborted || error instanceof NativeTestDiagnosticError)
      primary = error;
    else {
      obs.observed = "failed";
      obs.code =
        error instanceof IdentityError
          ? error.code
          : "native_test_runner_failed";
      if (!(error instanceof IdentityError)) {
        infrastructure = true;
        if (!obs.infrastructureCodes.length)
          obs.infrastructureCodes.push("native_test_unexpected_error");
      }
    }
  } finally {
    // Match the native domain commandKey algorithm even if its stored
    // checkpoint is unavailable; aliases retain this staged original run.
    const genericKey = (commandId: string) =>
      processDigest([
        scope.serverId,
        scope.workspaceId,
        scope.userId,
        commandId,
      ]);
    const genericRunId = genericKey(caseRunId);
    try {
      facts = NativeTestDiagnosticEvidenceSchema.parse({
        caseId: item.id,
        scenario: item.scenario,
        strategy,
        runId: strategy === "generic" ? genericRunId : configuredRunId,
        businessDispatches: obs.businessDispatches,
        approvals: approvals.size,
      });
      const journals =
        strategy === "configured"
          ? owner.db
              .prepare(
                "SELECT id,workspace_id,user_id,data FROM agent_service_turn WHERE json_extract(data,'$.kind')='service-process-1'",
              )
              .all()
              .map((row) => ({
                row,
                state: JournalSchema.parse(JSON.parse(String(row.data))),
              }))
          : [];
      if (journals.length > 1)
        throw new NativeTestDiagnosticError("native_test_receipt_unavailable");
      const genericRow =
        strategy === "generic"
          ? owner.db
              .prepare(
                "SELECT id,workspace_id,user_id,data FROM agent_service_turn WHERE json_extract(data,'$.kind')='mastra-1' ORDER BY rowid DESC LIMIT 1",
              )
              .get()
          : undefined;
      const generic = genericRow
        ? DomainCommandSchema.parse(JSON.parse(String(genericRow.data)))
        : undefined;
      const genericRoot = generic
        ? owner.db
            .prepare(
              "SELECT workspace_id,user_id,data FROM agent_service_turn WHERE id=?",
            )
            .get(generic.runId)
        : undefined;
      const genericRootState = genericRoot
        ? DomainCommandSchema.parse(JSON.parse(String(genericRoot.data)))
        : undefined;
      const state = strategy === "configured" ? journals[0]?.state : generic;
      const configured = journals[0]?.state;
      const identity = serviceProcessRunIdentity(
        scope,
        target.organizationId,
        configuredRunId,
      );
      const genericAliases = [
        caseRunId,
        ...Array.from(
          { length: questionIndex + 1 },
          (_, i) => caseRunId + "-answer-" + i,
        ),
      ];
      if (
        (configured &&
          (journals[0]!.row.id !== identity.parentRunId ||
            journals[0]!.row.workspace_id !== scope.workspaceId ||
            journals[0]!.row.user_id !== scope.userId ||
            configured.runId !== configuredRunId ||
            configured.scopeDigest !== identity.scopeDigest ||
            configured.processId !== artifact.processId ||
            configured.version !== artifact.version ||
            configured.artifactDigest !== artifact.digest)) ||
        (genericRow &&
          (genericRow.workspace_id !== scope.workspaceId ||
            genericRow.user_id !== scope.userId ||
            generic!.runId !== genericRunId ||
            (genericRow.id !== genericRunId &&
              !generic!.aliases.some(
                (a) =>
                  genericAliases.includes(a.commandId) &&
                  genericRow.id === genericKey(a.commandId),
              )) ||
            generic!.conversationId !== caseRunId ||
            !genericRoot ||
            genericRoot.workspace_id !== scope.workspaceId ||
            genericRoot.user_id !== scope.userId ||
            genericRootState!.runId !== generic!.runId ||
            genericRootState!.conversationId !== caseRunId))
      )
        throw new NativeTestDiagnosticError("native_test_receipt_unavailable");
      const status =
        strategy === "configured"
          ? (state as ReturnType<typeof JournalSchema.parse> | undefined)
              ?.status
          : (state as ReturnType<typeof readGeneric>)?.trace?.status;
      const pending =
        strategy === "configured"
          ? (state as ReturnType<typeof JournalSchema.parse> | undefined)
              ?.pending
            ? "kind" in
              (state as ReturnType<typeof JournalSchema.parse>).pending!
              ? "question"
              : "approval"
            : undefined
          : (state as ReturnType<typeof readGeneric>)?.pending?.kind;
      facts = NativeTestDiagnosticEvidenceSchema.parse({
        ...facts,
        ...([
          "running",
          "waiting",
          "succeeded",
          "failed",
          "unknown",
          "cancelled",
        ].includes(status ?? "")
          ? {
              checkpoint: {
                status,
                ...(pending === "question" || pending === "approval"
                  ? { pending }
                  : {}),
              },
            }
          : {}),
      });
    } catch {
      retire("native_test_receipt_unavailable");
    }
    try {
      const receipts = rows();
      if (
        receipts.some(
          (r) =>
            !IdentityId.safeParse(r.id).success ||
            r.organizationId !== target.organizationId ||
            r.workspaceId !== target.workspaceId ||
            r.userId !== scope.userId ||
            (["succeeded", "unknown"].includes(r.status) &&
              !dispatches.has(r.id)),
        )
      )
        throw new NativeTestDiagnosticError("native_test_receipt_unavailable");
      const withReceipts = NativeTestDiagnosticEvidenceSchema.parse({
        ...facts,
        receipts: receipts.map((r) => ({
          serviceId: r.serviceId,
          actionId: r.actionId,
          serviceRevision: r.serviceRevision,
          actionRevision: r.actionRevision,
          effect: r.effect,
          status: r.status,
          dispatches: dispatches.get(r.id) ?? 0,
        })),
      });
      // Validate against the pinned source before calling this trusted capture.
      if (
        withReceipts.receipts!.some(
          (r) =>
            !catalog.services.some(
              (s) =>
                s.id === r.serviceId &&
                s.revision === r.serviceRevision &&
                s.actions.some(
                  (a) =>
                    a.id === r.actionId &&
                    a.revision === r.actionRevision &&
                    a.effect === r.effect,
                ),
            ),
        )
      )
        throw new NativeTestDiagnosticError("native_test_receipt_unavailable");
      facts = withReceipts;
    } catch {
      retire("native_test_receipt_unavailable");
    }
    try {
      const attempts = owner.db
        .prepare(
          "SELECT COUNT(*) AS n FROM agent_inference_attempt WHERE status IN ('settled','unknown','dispatched')",
        )
        .get()!.n;
      facts = NativeTestDiagnosticEvidenceSchema.parse({
        ...facts,
        modelCalls: attempts,
      });
    } catch {
      retire("native_test_budget_unavailable");
    }
    if (facts) {
      capture(facts);
      if (primary instanceof NativeTestDiagnosticError)
        primary.diagnostic.evidence = facts;
    }
    try {
      obs.receipts = rows().map((r) => ({
        serviceId: r.serviceId,
        actionId: r.actionId,
        serviceRevision: r.serviceRevision,
        actionRevision: r.actionRevision,
        input: r.input as NativeTestReceipt["input"],
        effect: r.effect,
        status:
          r.status === "running"
            ? "unknown"
            : (r.status as NativeTestReceipt["status"]),
        ...(r.status === "succeeded"
          ? { output: r.result as NativeTestReceipt["output"] }
          : {}),
        ...(r.failure ? { code: r.failure.code } : {}),
        dispatches: dispatches.get(r.id) ?? 0,
      }));
      for (const row of owner.db
        .prepare("SELECT id FROM agent_inference_run")
        .all()) {
        const summary = owner.store.inferenceBudget.summary(String(row.id));
        obs.budget.accountedTokens += summary.accountedTokens;
        obs.budget.accountedCostMicros += summary.accountedCostMicros;
        obs.budget.unknownCalls += summary.unknownCalls;
        obs.budget.overrun ||= summary.overrun;
      }
      const actualAttempts = owner.db
        .prepare(
          "SELECT COUNT(*) AS n FROM agent_inference_attempt WHERE status IN ('settled','unknown','dispatched')",
        )
        .get()!.n;
      if (actualAttempts !== obs.modelCalls) {
        infrastructure = true;
        obs.infrastructureCodes.push("native_test_model_ledger_conflict");
      }
    } catch {
      retire("native_test_budget_unavailable");
    } finally {
      try {
        await close();
      } catch {
        retire("native_test_cleanup_failed");
      }
    }
  }
  if (primary) throw primary;
  await check();
  obs.assertions.push(...nativeObservableAssertions(item, obs));
  if (modelIndex !== item.models[strategy].length)
    obs.assertions.push("model_script_unconsumed");
  if (actionIndex !== item.actions.length)
    obs.assertions.push("action_fixtures_unconsumed");
  if (questionIndex !== (item.questions?.[strategy].length ?? 0))
    obs.assertions.push("question_fixtures_unconsumed");
  if (infrastructure && !obs.assertions.includes("infrastructure_failure"))
    obs.assertions.push("infrastructure_failure");
  obs.passed = obs.assertions.length === 0;
  try {
    return NativeTestObservationSchema.parse(obs);
  } catch {
    throw new NativeTestDiagnosticError(
      "native_test_observation_invalid",
      facts,
    );
  }
}

/** Trusted internal experiment only. No activation, HTTP, model tool or retained native store. */
/**
 * The MCP result a fixture stands for. A real MCP action's receipt keeps the
 * whole `tools/call` result, so a fixture output that already is one
 * (`{content: [{type, …}], structuredContent?}`) is returned as it is and
 * its receipt equals the fixture, as qualification requires; any other
 * output is sent as one text block of its JSON, as before.
 */
function mcpFixtureResult(value: unknown) {
  const object =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const shaped =
    !!object &&
    Array.isArray(object.content) &&
    object.content.length > 0 &&
    object.content.every(
      (block) =>
        !!block &&
        typeof block === "object" &&
        typeof (block as { type?: unknown }).type === "string",
    ) &&
    Object.keys(object).every((key) =>
      ["content", "structuredContent"].includes(key),
    );
  return shaped
    ? object
    : { content: [{ type: "text", text: JSON.stringify(value) }] };
}
export async function runProcessNativeComparison(
  rawArtifact: ProcessVersion,
  rawCatalog: ProcessTestCatalog,
  rawSuite: NativeTestSuite,
  signal: AbortSignal,
  authorize: () => Promise<void>,
) {
  TestJsonSchema.parse(rawSuite);
  TestJsonSchema.parse(rawCatalog);
  assertDesignContent(rawSuite);
  assertDesignContent(rawCatalog);
  const artifact = ProcessVersionSchema.parse(rawArtifact),
    catalog = ProcessTestCatalogSchema.parse(rawCatalog),
    suite = NativeTestSuiteSchema.parse(rawSuite);
  if (
    processDigest({
      definition: artifact.definition,
      sources: artifact.sources,
    }) !== artifact.digest
  )
    throw Error("native_test_artifact_conflict");
  const descriptors = [
    ...catalog.services.map((s) => ({
      kind: "service",
      id: s.id,
      revision: s.revision,
    })),
    ...catalog.services.flatMap((s) =>
      s.actions.map((a) => ({
        kind: "action",
        id: a.id,
        revision: a.revision,
      })),
    ),
    ...catalog.models.map((m) => ({
      kind: "model",
      id: m.id,
      revision: m.revision,
    })),
    ...catalog.providers.map((p) => ({
      kind: "provider",
      id: p.id,
      revision: p.revision,
    })),
  ];
  const baseline = catalog.models.find((m) => m.id === suite.genericModelId);
  const configuredOnly = suite.comparisonMode === "configured_only";
  if (
    configuredOnly &&
    (artifact.definition.kind !== "workflow" ||
      artifact.definition.steps.some((step) => step.type === "agent") ||
      suite.cases.some(
        (item) =>
          item.models.configured.length > 0 ||
          (item.questions?.configured.length ?? 0) > 0,
      ))
  )
    throw Error("native_test_comparison_mode_invalid");
  const capabilities =
    artifact.definition.kind === "agent"
      ? artifact.definition.capabilities
      : artifact.definition.steps.flatMap((step) =>
          step.type === "agent"
            ? step.capabilities
            : step.type === "action"
              ? [step]
              : [],
        );
  if (
    artifact.sources.resources.some(
      (r) => !descriptors.some((d) => sameSource(d, r)),
    ) ||
    descriptors.some(
      (d) =>
        !artifact.sources.resources.some((r) => sameSource(d, r)) &&
        !(
          (d.kind === "model" && d.id === baseline?.id) ||
          (d.kind === "provider" && d.id === baseline?.providerId)
        ),
    ) ||
    capabilities.some(
      (c) =>
        !catalog.services.some(
          (s) =>
            s.id === c.serviceId && s.actions.some((a) => a.id === c.actionId),
        ),
    ) ||
    catalog.models.some(
      (m) => !catalog.providers.some((p) => p.id === m.providerId),
    ) ||
    new Set(descriptors.map((d) => d.id)).size !== descriptors.length ||
    (!configuredOnly && !baseline)
  )
    throw Error("native_test_sources_conflict");
  if (catalog.budget.mode !== "enforce")
    throw Error("native_test_budget_required");
  let authorityLost = false;
  let authorityError: unknown;
  const checkAuthority = async () => {
    signal.throwIfAborted();
    if (authorityLost) throw authorityError;
    try {
      await authorize();
    } catch (error) {
      authorityLost = true;
      authorityError = error;
      throw error;
    }
    signal.throwIfAborted();
  };
  await checkAuthority();
  const root = mkdtempSync(join(tmpdir(), "niaro-native-comparison-"));
  chmodSync(root, 0o700);
  const stamp = processNativeStamp(artifact, catalog, suite);
  try {
    const native = await runNativeComparisonDataset(
      root,
      suite,
      stamp,
      signal,
      processDigest,
      async (strategy, item, itemSignal, capture) => {
        await checkAuthority();
        return observe(
          artifact,
          catalog,
          item,
          suite.genericModelId,
          strategy,
          join(root, `${strategy}-${item.id}.sqlite`),
          AbortSignal.any([
            signal,
            itemSignal,
            AbortSignal.timeout(
              Math.min(artifact.definition.limits.maxDurationMs, 30000),
            ),
          ]),
          checkAuthority,
          capture,
        );
      },
    );
    await checkAuthority();
    const observations = native.observations;
    const configured = observations.filter((o) => o.strategy === "configured"),
      generic = observations.filter((o) => o.strategy === "generic");
    return NativeTestReportSchema.parse({
      profile: PROCESS_NATIVE_TEST_PROFILE,
      qualification: "native_scripted",
      agentExecution: "native_agent_scripted_provider",
      adapterMode: "isolated_catalog_receipts",
      activationEligible: false,
      executionSettings: processNativeExecutionSettings(artifact, catalog),
      stamp,
      ...native,
      comparison: {
        ...(configuredOnly ? { mode: "configured_only" } : {}),
        cases: suite.cases.length,
        configuredPassed: configured.filter((o) => o.passed).length,
        genericPassed: generic.filter((o) => o.passed).length,
        configuredModelCalls: configured.reduce((n, o) => n + o.modelCalls, 0),
        genericModelCalls: generic.reduce((n, o) => n + o.modelCalls, 0),
      },
      status: observations.every((o) => o.passed) ? "passed" : "failed",
    });
  } catch (error) {
    signal.throwIfAborted();
    if (authorityLost) throw authorityError;
    throw error;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function sameSource(
  a: { kind: string; id: string; revision: number },
  b: { kind: string; id: string; revision: number },
) {
  return a.kind === b.kind && a.id === b.id && a.revision === b.revision;
}
