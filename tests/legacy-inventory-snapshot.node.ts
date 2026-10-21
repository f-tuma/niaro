import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createDrainCatalogRuntime } from "../apps/server-identity/catalog-runtime-legacy";
import type { CatalogContext } from "../apps/server-identity/catalog-controller";
import { IntegrationError } from "../apps/server-integrations/transport";
import {
  CommandSchema,
  CommandResultSchema,
  ScopeSchema,
  type Scope,
} from "../packages/protocol";
import { coordinatorHttpFixture } from "./helpers/process-coordinator-http";
import {
  inventoryLegacyTuple,
  classifyLegacyInventory,
  observeLegacyTuple,
  LEGACY_INVENTORY_LIMITS,
  LegacyInventoryFailure,
  type LegacyInventoryManifest,
  type InventoryRows,
} from "../apps/server-identity/legacy-run-inventory";
import { processDigest } from "../apps/server-identity/process-validation";
import { JournalSchema } from "../apps/server-identity/service-process-journal";

type HistoricalMode = "agent" | "progressive" | "legacy";
type Requested =
  | "pending"
  | "question"
  | "question-public"
  | "consumed"
  | "failed"
  | "succeeded"
  | "unknown"
  | "rejected"
  | "text";
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const turnKey = (scope: Scope, id: string) =>
  hash([scope.serverId, scope.workspaceId, scope.userId, id]);
const DecisionBody = z.object({
  questions: z.object({
    route: z.object({ criteria: z.record(z.string(), z.string()) }),
  }),
});
function fixtureRoles(root: string): LegacyInventoryManifest["roles"] {
  const identityDatabase = "identity/identity.sqlite",
    workflowDatabase = "workflow/workflow.sqlite";
  return {
    identityDatabase,
    workflowDatabase,
    workflowServerId: "workflow/auth/server-id",
    originalSecret: "identity/secret",
    configuration: "TEST-server-config.json",
    administrationKey: "key",
    nativeDatabases: existsSync(join(root, identityDatabase + ".mastra.sqlite"))
      ? [identityDatabase + ".mastra.sqlite"]
      : [],
    ownerLocks: ["identity/server-lock.sqlite", "workflow/server-lock.sqlite"],
  };
}
/** One real pair per process: Better Auth's process-wide bootstrap limit is real. */
async function produceStoppedInventory(
  mode: HistoricalMode,
  requested: Requested,
) {
  const outcome =
    requested === "pending"
      ? "succeeded"
      : ["question-public", "consumed"].includes(requested)
        ? "question"
        : requested;
  const h = await coordinatorHttpFixture({ allowOrdinaryRuntime: true });
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
    if (["consumed", "question-public", "text"].includes(requested)) {
      const policy = h.identity["catalog"].store.inferenceBudget.policy(
        h.target.organizationId,
        scope.workspaceId,
      );
      const budget = await h.request("owner", "api/identity/catalog/budget", {
        ...h.target,
        revision: policy.revision,
        settings: {
          ...policy.settings,
          prices: [
            ...policy.settings.prices,
            { ...h.budgetSettings.prices[0]!, modelId: decisionId },
          ],
        },
      });
      assert.equal(budget.status, 200, JSON.stringify(budget.data));
    }
    await h.catalog({
      type: "saveRouting",
      routing: {
        revision: 0,
        planner: mode === "agent" ? "model" : "jev",
        modelId: h.modelId,
        decision: {
          enabled: mode !== "legacy",
          modelId: decisionId,
          minConfidence: 0.8,
        },
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
            (["question", "text"].includes(outcome) &&
            criteria.answer_without_tools
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
      if (outcome === "text")
        return { content: "TEST bounded historical prose" };
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
    const producer = await historicalAccess(
      "Bearer " + credential.accessToken,
      scope.workspaceId,
      scope.serverId,
    );
    let operationId: string | undefined;
    if (outcome === "question") {
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
      assert.equal(old?.reply, question);
      if (requested !== "question") {
        const response = await h.mobile(
          credential,
          "commands",
          undefined,
          wire,
        );
        assert.equal(response.status, 202, JSON.stringify(response.data));
        const initial = CommandResultSchema.parse(response.data);
        assert.equal(initial.status, "accepted");

        assert(
          initial.snapshot.conversations.some((c) =>
            c.messages.some(
              (m) => m.role === "assistant" && m.text === question,
            ),
          ),
          "TEST first current public router must retain original question text; raw proof is checked only after stop",
        );
        if (requested === "consumed") {
          h.onModel(() => ({ content: "TEST original question answered" }));
          const answerCommand = CommandSchema.parse({
            ...command,
            commandId: "TEST-answer-" + mode,
            idempotencyKey: "TEST-answer-" + mode,
            text: "TEST original answer QX91",
          });
          const response = await h.mobile(
            credential,
            "commands",
            undefined,
            JSON.stringify(answerCommand),
          );
          assert.equal(response.status, 202, JSON.stringify(response.data));
          assert.equal(
            CommandResultSchema.parse(response.data).status,
            "accepted",
          );
        }
      }
    } else {
      h.identity.mobileAccess = historicalAccess;
      try {
        const response = await h.mobile(
          credential,
          "commands",
          undefined,
          wire,
        );
        assert.equal(response.status, 202, JSON.stringify(response.data));
        const initial = CommandResultSchema.parse(response.data);
        if (outcome === "text")
          assert(
            initial.snapshot.conversations.some((c) =>
              c.messages.some(
                (m) =>
                  m.role === "assistant" &&
                  m.text === "TEST bounded historical prose",
              ),
            ),
          );
        else {
          const offered = initial.snapshot.conversations[0]!.messages.findLast(
            (message) => message.result?.type === "service.action",
          );
          assert(offered?.result?.type === "service.action");
          assert.equal(offered.result.status, "awaiting_approval");
          operationId = offered.result.operationId;
        }
      } finally {
        h.identity.mobileAccess = currentAccess;
      }
      if (requested !== "pending" && requested !== "text") {
        await producer.integrations!.resolve(
          operationId!,
          outcome !== "rejected",
          "en",
          new AbortController().signal,
        );
        const receipt = h.identity["catalog"].store.invocation(
          operationId!,
          scope.workspaceId,
          scope.userId,
        );
        assert.equal(receipt?.status, outcome);
      }
    }
    const baselineCounts = {
      models: h.modelCount(),
      decisions: decisions.length,
      dispatches: h.dispatches.length,
      serviceAttempts,
      modelAttempts,
      decisionAttempts,
    };
    const sentinel = new Error("PRE_EDIT_PROBE_STOPPED_BEFORE_OWNER_REOPEN");
    try {
      await h.restoreCopy((proof) => {
        const roles = fixtureRoles(proof.source);
        const originalBefore = observeLegacyTuple(proof.source, roles);
        const destinationBefore = observeLegacyTuple(proof.destination, roles);
        assert.deepEqual(
          originalBefore.files.map((file) => [file.path, file.sha256]),
          Object.entries(proof.sourceHashes)
            .sort()
            .map(([path, sha]) => [path, sha]),
        );
        assert.deepEqual(
          { ...destinationBefore, tupleRoot: proof.source },
          originalBefore,
        );
        const observed = inventoryLegacyTuple(originalBefore);
        assert.equal(observed.status, "incomplete");
        assert.equal(observed.scanComplete, true);
        assert.deepEqual(observed.provenance, {
          ownerStop: "unverified",
          commonCheckpoint: "unverified",
          basis: "offline_manifest_only",
        });
        assert.deepEqual(
          observeLegacyTuple(proof.source, roles),
          originalBefore,
        );
        assert.deepEqual(
          observeLegacyTuple(proof.destination, roles),
          destinationBefore,
        );
        if (requested === "pending") {
          assert.equal(observed.counts.awaitingReceipts, 1);
          assert.equal(observed.counts.activeTurns, 1);
        } else if (["question", "question-public"].includes(requested)) {
          assert.equal(observed.counts.activeTurns, 1);
          if (requested === "question") {
            assert.equal(observed.classificationComplete, false);
            assert(
              observed.entries[0]!.blockers.includes("question_proof_missing"),
            );
          }
        } else if (requested === "consumed") {
          assert.equal(observed.counts.passiveTurns, 1);
          assert.equal(observed.counts.activeTurns, 0);
          assert.equal(observed.nativeRuns.length, 1);
          assert.equal(observed.classificationComplete, false);
          assert(observed.blockers.includes("native_unclassified"));
        } else if (requested === "text") {
          const wrapper = mkdtempSync(
            join(tmpdir(), "niaro-inventory-control-"),
          );
          chmodSync(wrapper, 0o700);
          try {
            const rawClone = join(wrapper, "tuple");
            cpSync(proof.destination, rawClone, { recursive: true });
            const db = new DatabaseSync(
              join(rawClone, roles.identityDatabase),
              { readOnly: true },
            );
            try {
              const size = db
                .prepare(
                  "SELECT length(CAST(data AS BLOB)) AS n FROM agent_service_turn WHERE id=?",
                )
                .get(key);
              assert(Number(size?.n) <= LEGACY_INVENTORY_LIMITS.rowBytes);
              const raw = JSON.parse(
                String(
                  db
                    .prepare("SELECT data FROM agent_service_turn WHERE id=?")
                    .get(key)!.data,
                ),
              );
              assert.equal(
                raw.paused,
                false,
                "TEST this producer completed control, distinct from older paused prose",
              );
              if (mode === "progressive") assert.equal(raw.pendingInput, false);
              assert.equal(raw.answer.reply, "TEST bounded historical prose");
            } finally {
              db.close();
            }
          } finally {
            rmSync(wrapper, { recursive: true, force: true });
          }
          assert.equal(
            observed.classificationComplete,
            false,
            JSON.stringify(observed),
          );
          assert(observed.blockers.includes("native_store_unclassified"));
          assert.equal(observed.counts.passiveTurns, 1);
          assert.equal(observed.counts.activeTurns, 0);
        } else {
          assert.equal(observed.counts.passiveReceipts, 1);
          assert.equal(observed.counts.passiveTurns, 0);
          assert.equal(observed.classificationComplete, false);
        }
        assert.deepEqual(
          {
            models: h.modelCount(),
            decisions: decisions.length,
            dispatches: h.dispatches.length,
            serviceAttempts,
            modelAttempts,
            decisionAttempts,
          },
          baselineCounts,
        );
        console.log(
          JSON.stringify({
            mode,
            requested,
            genuine: true,
            scanComplete: observed.scanComplete,
            classificationComplete: observed.classificationComplete,
            counts: observed.counts,
            sourceStable: true,
            inventoryDelta: { models: 0, decisions: 0, dispatches: 0 },
          }),
        );
        throw sentinel;
      });
      throw new Error("TEST must stop before reopening any copied owner");
    } catch (error) {
      if (error !== sentinel) throw error;
    }
  } finally {
    await h.close();
  }
}

function rawTuple(root: string) {
  mkdirSync(join(root, "identity"));
  mkdirSync(join(root, "workflow"));
  mkdirSync(join(root, "workflow/auth"));
  const roles = fixtureRoles(root);
  writeFileSync(
    join(root, roles.workflowServerId),
    "fixture-123456789012345678901234",
    { mode: 0o600 },
  );
  for (const path of [
    roles.originalSecret,
    roles.configuration,
    roles.administrationKey,
  ])
    writeFileSync(join(root, path), "TEST-private-unparsed-material", {
      mode: 0o600,
    });
  const identity = new DatabaseSync(join(root, roles.identityDatabase));
  identity.exec(`CREATE TABLE agent_service_turn(id TEXT,workspace_id TEXT,user_id TEXT,data TEXT);
    CREATE TABLE agent_service_invocation(id TEXT,workspace_id TEXT,user_id TEXT,data TEXT);
    CREATE TABLE agent_service_turn_operation(operation_id TEXT,turn_id TEXT,workspace_id TEXT,user_id TEXT);
    CREATE TABLE agent_workspace(id TEXT,organization_id TEXT);`);
  identity.close();
  const workflow = new DatabaseSync(join(root, roles.workflowDatabase));
  workflow.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);
    INSERT INTO metadata VALUES('server_id','fixture-123456789012345678901234');
    CREATE TABLE workflows(scope_key TEXT,state TEXT);
    CREATE TABLE receipts(scope_key TEXT,command_id TEXT,idempotency_key TEXT,payload TEXT);`);
  workflow.close();
  for (const path of roles.ownerLocks) {
    const db = new DatabaseSync(join(root, path));
    db.exec("CREATE TABLE owner(id TEXT)");
    db.close();
  }
  return roles;
}
function disposable(
  fn: (root: string, roles: LegacyInventoryManifest["roles"]) => void,
) {
  const root = mkdtempSync(join(tmpdir(), "niaro-inventory-derived-"));
  chmodSync(root, 0o700);
  try {
    fn(root, rawTuple(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function addNativeStorage(
  root: string,
  roles: LegacyInventoryManifest["roles"],
  options: {
    extraWorkflowColumn?: boolean;
    wrongWorkflowType?: boolean;
    omitWorkflowUnique?: boolean;
    workflowIndexDrift?: "partial" | "nocase";
    extraTable?: boolean;
    sqlitePrefixLookalike?: boolean;
    snapshots?: number;
    backgroundTasks?: number;
    omitWorkflowTable?: boolean;
    oversizedSnapshot?: boolean;
    snapshotPayloadBytes?: number;
  } = {},
) {
  const path = roles.identityDatabase + ".mastra.sqlite";
  roles.nativeDatabases = [path];
  const db = new DatabaseSync(join(root, path));
  const snapshotColumns = [
    `workflow_name ${options.wrongWorkflowType ? "INTEGER" : "TEXT"}`,
    "run_id TEXT",
    "resourceId TEXT",
    "snapshot TEXT",
    "createdAt TEXT",
    "updatedAt TEXT",
    ...(options.extraWorkflowColumn ? ["unexpected TEXT"] : []),
  ];
  db.exec(`${options.omitWorkflowTable ? "" : `CREATE TABLE mastra_workflow_snapshot(${snapshotColumns.join(",")}${options.omitWorkflowUnique || options.workflowIndexDrift ? "" : ", UNIQUE(workflow_name, run_id)"});`}
    CREATE TABLE mastra_background_tasks(
      id TEXT NOT NULL PRIMARY KEY, tool_call_id TEXT NOT NULL, tool_name TEXT NOT NULL,
      agent_id TEXT NOT NULL, run_id TEXT NOT NULL, thread_id TEXT, resource_id TEXT,
      status TEXT NOT NULL, args TEXT NOT NULL, result TEXT, error TEXT,
      suspend_payload TEXT, retry_count INTEGER NOT NULL, max_retries INTEGER NOT NULL,
      timeout_ms INTEGER NOT NULL, createdAt TEXT NOT NULL, startedAt TEXT,
      suspendedAt TEXT, completedAt TEXT, ownerId TEXT, leaseExpiresAt TEXT
    );${options.extraTable ? " CREATE TABLE unexpected_native_table(id TEXT);" : ""}${options.sqlitePrefixLookalike ? " CREATE TABLE sqliteXprivate(id TEXT);" : ""}`);
  if (options.workflowIndexDrift === "partial")
    db.exec(
      "CREATE UNIQUE INDEX workflow_snapshot_drift ON mastra_workflow_snapshot(workflow_name,run_id) WHERE workflow_name <> '';",
    );
  if (options.workflowIndexDrift === "nocase")
    db.exec(
      "CREATE UNIQUE INDEX workflow_snapshot_drift ON mastra_workflow_snapshot(workflow_name COLLATE NOCASE,run_id);",
    );
  if (!options.omitWorkflowTable) {
    const insertSnapshot = db.prepare(
      "INSERT INTO mastra_workflow_snapshot VALUES(?,?,?,?,?,?" +
        (options.extraWorkflowColumn ? ",?)" : ")"),
    );
    for (let i = 0; i < (options.snapshots ?? 1); i++)
      insertSnapshot.run(
        `TEST-workflow-${i}`,
        `TEST-run-${i}`,
        null,
        options.oversizedSnapshot
          ? "X".repeat(LEGACY_INVENTORY_LIMITS.rowBytes + 1)
          : options.snapshotPayloadBytes
            ? "X".repeat(options.snapshotPayloadBytes)
            : "TEST_PRIVATE_SNAPSHOT_CONTENT",
        "TEST-created",
        "TEST-updated",
        ...(options.extraWorkflowColumn ? ["TEST-unknown-schema"] : []),
      );
  }
  const insertTask = db.prepare(
    "INSERT INTO mastra_background_tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  for (let i = 0; i < (options.backgroundTasks ?? 1); i++)
    insertTask.run(
      `TEST-background-id-${i}`,
      `TEST-call-id-${i}`,
      "TEST-tool-name",
      "TEST-agent-id",
      `TEST-background-run-id-${i}`,
      null,
      null,
      "TEST-private-status",
      "TEST_PRIVATE_ARGS",
      "TEST_PRIVATE_RESULT",
      "TEST_PRIVATE_ERROR",
      "TEST_PRIVATE_SUSPEND",
      0,
      0,
      1,
      "TEST-created",
      null,
      null,
      null,
      null,
      null,
    );
  db.close();
}
function failCode(fn: () => unknown, code: string) {
  assert.throws(
    fn,
    (error) => error instanceof LegacyInventoryFailure && error.code === code,
  );
}
async function worker(args: string[]) {
  const root = mkdtempSync(join(tmpdir(), "niaro-inventory-worker-"));
  chmodSync(root, 0o700);
  let child: ReturnType<typeof spawn> | undefined,
    deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TMPDIR: root,
      TSX_DISABLE_CACHE: "1",
    };
    delete env.NODE_TEST_CONTEXT;
    child = spawn(
      process.execPath,
      ["--import", "tsx", fileURLToPath(import.meta.url), ...args],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "",
      errorOutput = "",
      failure: Error | undefined;
    const collect = (chunk: Buffer, err: boolean) => {
      if (err) errorOutput += chunk.toString();
      else output += chunk.toString();
      if (
        Buffer.byteLength(output) + Buffer.byteLength(errorOutput) >
        64 * 1024
      ) {
        failure = Error("TEST inventory worker output limit");
        child!.kill("SIGKILL");
      }
    };
    child.stdout!.on("data", (chunk) => collect(chunk, false));
    child.stderr!.on("data", (chunk) => collect(chunk, true));
    const closed = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child!.once("error", (error) => {
        failure = error;
      });
      child!.once("close", (code, signal) => resolve({ code, signal }));
    });
    deadline = setTimeout(() => {
      failure = Error("TEST inventory worker deadline");
      child!.kill("SIGKILL");
    }, 120_000);
    const result = await closed;
    if (failure) throw failure;
    assert.equal(result.signal, null, errorOutput);
    assert.equal(result.code, 0, output + errorOutput);
    return JSON.parse(output.trim().split("\n").at(-1)!) as Record<
      string,
      unknown
    >;
  } finally {
    if (deadline) clearTimeout(deadline);
    if (child && child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
}
async function privacyAndGrowthWorker() {
  const fs = await import("node:fs"),
    { syncBuiltinESMExports } = await import("node:module");
  const originalChmod = fs.default.chmodSync,
    originalRead = fs.default.readSync;
  const changes: { path: string; mode: number }[] = [];
  fs.default.chmodSync = ((
    path: Parameters<typeof originalChmod>[0],
    mode: Parameters<typeof originalChmod>[1],
  ) => {
    originalChmod(path, mode);
    if (String(path).includes("niaro-legacy-inventory-"))
      changes.push({ path: String(path), mode: lstatSync(path).mode & 0o777 });
  }) as typeof originalChmod;
  syncBuiltinESMExports();
  try {
    disposable((root, roles) => {
      originalChmod(root, 0o755);
      const before = observeLegacyTuple(root, roles),
        report = inventoryLegacyTuple(before);
      assert.equal(report.classificationComplete, true);
      assert.equal(report.status, "incomplete");
      assert.deepEqual(observeLegacyTuple(root, roles), before);
      const outer = changes.filter((item) =>
        /niaro-legacy-inventory-[^/]+$/.test(item.path),
      );
      assert(outer.length > 0);
      assert(outer.every((item) => item.mode === 0o700));
      assert(
        changes.some(
          (item) => item.path.endsWith("/tuple") && item.mode === 0o755,
        ),
      );
    });
    disposable((root, roles) => {
      const victim = join(root, roles.configuration);
      const victimStat = lstatSync(victim);
      let reads = 0,
        mutated = false;
      fs.default.readSync = ((...args: Parameters<typeof originalRead>) => {
        const n = originalRead(...args);
        reads++;
        const current = fs.fstatSync(args[0]);
        if (
          !mutated &&
          current.ino === victimStat.ino &&
          current.dev === victimStat.dev
        ) {
          mutated = true;
          writeFileSync(victim, "TEST-growing-source-" + "X".repeat(100));
        }
        return n;
      }) as typeof originalRead;
      syncBuiltinESMExports();
      failCode(() => observeLegacyTuple(root, roles), "tuple_changed");
      assert(
        mutated,
        "TEST growth targets the descriptor currently being hashed, independent of directory order",
      );
      assert(
        reads < 100,
        "TEST source growth cannot keep streaming until a moving EOF",
      );
      fs.default.readSync = originalRead;
      syncBuiltinESMExports();
    });
  } finally {
    fs.default.chmodSync = originalChmod;
    fs.default.readSync = originalRead;
    syncBuiltinESMExports();
  }
  console.log(
    JSON.stringify({
      derived: true,
      privateOuter: true,
      originalRootModePreserved: true,
      growingSourceRejected: true,
    }),
  );
}

function reviewRows(
  fault: "duplicate" | "native" | "public" | "consumed-public" | "consumed-raw",
): InventoryRows {
  const scope = ScopeSchema.parse({
      connectionId: "TEST-review-connection",
      serverId: "fixture-123456789012345678901234",
      workspaceId: "TEST-workspace",
      userId: "TEST-user",
    }),
    org = "TEST-organization";
  const scopeKey = JSON.stringify([
    scope.connectionId,
    scope.serverId,
    scope.userId,
    scope.workspaceId,
  ]);
  const original = CommandSchema.parse({
    type: "message.send",
    commandId: "TEST-original",
    idempotencyKey: "TEST-original",
    conversationId: "conversation-1",
    text: "TEST original goal",
    language: "en",
  });
  assert.equal(original.type, "message.send");
  if (original.type !== "message.send") throw Error("TEST message control");
  const id = turnKey(scope, original.idempotencyKey),
    value: Record<string, unknown> = {
      kind: "agent-1",
      commandId: original.idempotencyKey,
      text: original.text,
      language: original.language,
      hash: hash([original.text, original.language]),
      requestHash: hash(original),
      operations: [],
      pendingCalls: [],
      continuityPending: false,
      paused: false,
      answer: { reply: "TEST completed" },
    };
  const data: InventoryRows = {
    serverId: scope.serverId,
    turns: [
      { id, workspace_id: scope.workspaceId, user_id: scope.userId, data: "" },
    ],
    invocations: [],
    links: [],
    workspaces: [{ id: scope.workspaceId, organization_id: org }],
    workflows: [
      {
        scope_key: scopeKey,
        state: JSON.stringify({
          snapshot: {
            scope,
            conversations: [
              {
                id: original.conversationId,
                messages: [
                  {
                    role: "assistant",
                    text: "TEST completed",
                    replyToCommandId: original.commandId,
                  },
                ],
              },
            ],
          },
        }),
      },
    ],
    receipts: [
      {
        scope_key: scopeKey,
        command_id: original.commandId,
        idempotency_key: original.idempotencyKey,
        payload: JSON.stringify({ status: "accepted", command: original }),
      },
    ],
  };
  if (fault === "public") {
    const op = {
      id: "TEST-operation",
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      organizationId: org,
      status: "succeeded",
      effect: "write",
    };
    value.operations = [op.id];
    data.invocations.push({
      id: op.id,
      workspace_id: scope.workspaceId,
      user_id: scope.userId,
      data: JSON.stringify(op),
    });
    const workflow = JSON.parse(String(data.workflows[0]!.state));
    workflow.snapshot.conversations[0].messages[0].result = {
      operationId: op.id,
      status: "awaiting_approval",
    };
    data.workflows[0]!.state = JSON.stringify(workflow);
  }
  if (fault === "native" || fault.startsWith("consumed-")) {
    Object.assign(value, {
      epoch: 1,
      clock: { referenceNow: "2026-10-07T12:00:00.000Z" },
      paused: true,
      working: {
        conversationId: original.conversationId,
        goal: original.text,
        openedAt: "2026-10-07T12:00:00.000Z",
        question: "TEST question",
        sources: [],
      },
      answer: { reply: "TEST question" },
    });
    const workflow = JSON.parse(String(data.workflows[0]!.state));
    workflow.snapshot.conversations[0].messages[0].text = "TEST question";
    data.workflows[0]!.state = JSON.stringify(workflow);
    const answer = CommandSchema.parse({
      ...original,
      commandId: "TEST-answer",
      idempotencyKey: "TEST-answer",
      text: "TEST human answer",
    });
    assert.equal(answer.type, "message.send");
    if (answer.type !== "message.send") throw Error("TEST answer control");
    const root = {
      kind: "mastra-1",
      runId: turnKey(scope, answer.idempotencyKey),
      goal: original.text,
      conversationId: original.conversationId,
      operations: [],
      aliases: [
        {
          commandId: answer.idempotencyKey,
          hash: hash([answer.text, answer.language]),
          requestHash: hash(answer),
        },
      ],
      legacyQuestion: {
        kind: "agent-1",
        turnId: id,
        turnHash: hash(value),
        commandId: original.commandId,
        requestHash: hash(original),
        scopeHash: hash([scope, org]),
        conversationId: original.conversationId,
        question: "TEST question",
        decision: "accepted",
        sources: [],
      },
    };
    data.turns.push(
      {
        id: root.runId,
        workspace_id: scope.workspaceId,
        user_id: scope.userId,
        data: JSON.stringify(root),
      },
      ...(fault === "native"
        ? [
            {
              id: turnKey(scope, "TEST-invalid-process"),
              workspace_id: scope.workspaceId,
              user_id: scope.userId,
              data: JSON.stringify({
                kind: "service-process-1",
                runId: "TEST-process",
                scopeDigest: "TEST-wrong-scope",
                operations: [],
              }),
            },
          ]
        : []),
    );
    data.receipts.push({
      scope_key: scopeKey,
      command_id: answer.commandId,
      idempotency_key: answer.idempotencyKey,
      payload: JSON.stringify({ status: "accepted", command: answer }),
    });
  }
  data.turns[0]!.data = JSON.stringify(value);
  if (fault === "duplicate") data.turns.push({ ...data.turns[0]! });
  if (fault.startsWith("consumed-")) {
    assert.equal(
      classifyLegacyInventory(data).counts.passiveTurns,
      1,
      "TEST the persisted consumer starts from a proven positive",
    );
    const control = {
      type: "service.action",
      operationId: "TEST-missing-approval",
      status: "awaiting_approval",
      effect: "write",
    };
    if (fault === "consumed-public") {
      const workflow = JSON.parse(String(data.workflows[0]!.state));
      workflow.snapshot.conversations[0].messages[0].result = control;
      data.workflows[0]!.state = JSON.stringify(workflow);
    } else {
      const raw = JSON.parse(String(data.turns[0]!.data));
      raw.answer.result = control;
      data.turns[0]!.data = JSON.stringify(raw);
      const root = JSON.parse(String(data.turns[1]!.data));
      root.legacyQuestion.turnHash = hash(raw);
      data.turns[1]!.data = JSON.stringify(root);
    }
  }
  return data;
}
function seedReviewRows(
  root: string,
  roles: LegacyInventoryManifest["roles"],
  data: InventoryRows,
) {
  const identity = new DatabaseSync(join(root, roles.identityDatabase));
  try {
    for (const row of data.turns)
      identity
        .prepare("INSERT INTO agent_service_turn VALUES(?,?,?,?)")
        .run(
          String(row.id),
          String(row.workspace_id),
          String(row.user_id),
          String(row.data),
        );
    for (const row of data.invocations)
      identity
        .prepare("INSERT INTO agent_service_invocation VALUES(?,?,?,?)")
        .run(
          String(row.id),
          String(row.workspace_id),
          String(row.user_id),
          String(row.data),
        );
    for (const row of data.links)
      identity
        .prepare("INSERT INTO agent_service_turn_operation VALUES(?,?,?,?)")
        .run(
          String(row.operation_id),
          String(row.turn_id),
          String(row.workspace_id),
          String(row.user_id),
        );
    for (const row of data.workspaces)
      identity
        .prepare("INSERT INTO agent_workspace VALUES(?,?)")
        .run(String(row.id), String(row.organization_id));
  } finally {
    identity.close();
  }
  const workflow = new DatabaseSync(join(root, roles.workflowDatabase));
  try {
    for (const row of data.workflows)
      workflow
        .prepare("INSERT INTO workflows VALUES(?,?)")
        .run(String(row.scope_key), String(row.state));
    for (const row of data.receipts)
      workflow
        .prepare("INSERT INTO receipts VALUES(?,?,?,?)")
        .run(
          String(row.scope_key),
          String(row.command_id),
          String(row.idempotency_key),
          String(row.payload),
        );
  } finally {
    workflow.close();
  }
}
function addNativeOwnedReceipt(
  data: InventoryRows,
  status: "succeeded" | "waiting" = "succeeded",
) {
  const scope = ScopeSchema.parse({
    connectionId: "TEST-review-connection",
    serverId: "fixture-123456789012345678901234",
    workspaceId: "TEST-workspace",
    userId: "TEST-user",
  });
  const organizationId = "TEST-organization",
    runId = "TEST-native-process",
    scopeDigest = processDigest([
      scope.serverId,
      organizationId,
      scope.workspaceId,
      scope.userId,
    ]),
    turnId = processDigest(["service-process-1", scopeDigest, runId]),
    callId = "TEST-native-call",
    operationId = processDigest([turnId, "action", callId]);
  const journal = JournalSchema.parse({
    kind: "service-process-1",
    runId,
    processId: "TEST-native-definition",
    version: 1,
    artifactDigest: "0".repeat(64),
    compilerVersion: "niaro-native-workflow/3",
    scopeDigest,
    inputDigest: processDigest({ private: "TEST-private-native-input" }),
    input: { private: "TEST-private-native-input" },
    text: "TEST-private-native-goal",
    status,
    startedAt: 1,
    visited: [],
    operations: [operationId],
    receipts: [{ callId, operationId }],
    sources: [],
    ...(status === "waiting"
      ? { pending: { nodeId: "approval_step", operationId } }
      : {}),
    trace: {
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(1).toISOString(),
      status,
      steps:
        status === "waiting"
          ? [
              {
                id: "approval-step",
                kind: "tool",
                label: "TEST approval",
                status: "waiting",
                startedAt: new Date(0).toISOString(),
                finishedAt: new Date(1).toISOString(),
                details: [],
                callId,
                action: {
                  operationId,
                  serviceName: "TEST service",
                  actionName: "TEST action",
                  effect: "write",
                  status: "awaiting_approval",
                  phase: "proposal",
                  input: [],
                  output: [],
                  inputTruncated: false,
                  outputTruncated: false,
                },
              },
            ]
          : [],
      truncated: false,
    },
  });
  data.turns.push({
    id: turnId,
    workspace_id: scope.workspaceId,
    user_id: scope.userId,
    data: JSON.stringify(journal),
  });
  data.invocations.push({
    id: operationId,
    workspace_id: scope.workspaceId,
    user_id: scope.userId,
    data: JSON.stringify({
      id: operationId,
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      organizationId,
      status: status === "waiting" ? "awaiting_approval" : "succeeded",
      effect: "write",
    }),
  });
  data.links.push({
    operation_id: operationId,
    turn_id: turnId,
    workspace_id: scope.workspaceId,
    user_id: scope.userId,
  });
}
async function schemaWorker() {
  const original = DatabaseSync.prototype.prepare;
  let forbidden = 0;
  for (const fault of [
    "view",
    "virtual-shadow",
    "generated",
    "schema-overflow",
    "column-overflow",
  ] as const)
    disposable((root, roles) => {
      const producer = new DatabaseSync(join(root, roles.identityDatabase));
      try {
        if (fault === "view")
          producer.exec(
            "DROP TABLE agent_service_turn; CREATE VIEW agent_service_turn AS WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM r WHERE n<1000000000) SELECT printf('%064d',n) AS id,'TEST-workspace' AS workspace_id,'TEST-user' AS user_id,'{}' AS data FROM r",
          );
        if (fault === "virtual-shadow")
          producer.exec(
            "DROP TABLE agent_service_turn; CREATE VIRTUAL TABLE agent_service_turn USING fts5(id,workspace_id,user_id,data)",
          );
        if (fault === "generated")
          producer.exec(
            "DROP TABLE agent_service_turn; CREATE TABLE agent_service_turn(id TEXT,workspace_id TEXT,user_id TEXT,data TEXT GENERATED ALWAYS AS('{}') STORED)",
          );
        if (fault === "schema-overflow") {
          producer.exec("BEGIN");
          for (let i = 0; i < LEGACY_INVENTORY_LIMITS.schemaEntries; i++)
            producer.exec("CREATE TABLE extra_" + i + "(id TEXT)");
          producer.exec("COMMIT");
        }
        if (fault === "column-overflow")
          producer.exec(
            "CREATE TABLE oversized(" +
              Array.from(
                { length: LEGACY_INVENTORY_LIMITS.schemaColumns + 1 },
                (_, i) => "c" + i + " TEXT",
              ).join(",") +
              ")",
          );
      } finally {
        producer.close();
      }
      const before = observeLegacyTuple(root, roles);
      DatabaseSync.prototype.prepare = function (sql: string) {
        if (
          /integrity_check|foreign_key_check|FROM agent_service_turn\b/i.test(
            sql,
          )
        ) {
          forbidden++;
          throw Error(
            "TEST nonordinary schema reached forbidden integrity/data query",
          );
        }
        return original.call(this, sql);
      };
      try {
        failCode(() => inventoryLegacyTuple(before), "database_invalid");
        assert.equal(forbidden, 0, fault);
      } finally {
        DatabaseSync.prototype.prepare = original;
      }
      assert.deepEqual(observeLegacyTuple(root, roles), before);
    });
  console.log(
    JSON.stringify({
      derived: true,
      schemaRejectedBeforeIntegrityAndData: true,
      forbiddenQueries: forbidden,
      cases: 5,
    }),
  );
}

async function pathWorker() {
  const fs = await import("node:fs"),
    { syncBuiltinESMExports } = await import("node:module"),
    original = fs.default.mkdtempSync,
    originalDirectory = fs.default.opendirSync;
  const oldTmp = process.env.TMPDIR;
  let attempts = 0,
    rootReads = 0;
  try {
    disposable((root, roles) => {
      const before = observeLegacyTuple(root, roles);
      process.env.TMPDIR = root;
      fs.default.mkdtempSync = ((
        prefix: Parameters<typeof original>[0],
        options: Parameters<typeof original>[1],
      ) => {
        if (String(prefix).startsWith(root + "/")) {
          attempts++;
          throw Error("TEST attempted protected source write");
        }
        return original(prefix, options);
      }) as typeof original;
      fs.default.opendirSync = ((
        ...args: Parameters<typeof originalDirectory>
      ) => {
        if (String(args[0]) === "/") {
          rootReads++;
          throw Error(
            "TEST containment gate tried root inventory before rejection",
          );
        }
        return originalDirectory(...args);
      }) as typeof originalDirectory;
      syncBuiltinESMExports();
      for (const tupleRoot of [root, root + "/", root + "/.", "/"])
        failCode(
          () => inventoryLegacyTuple({ ...before, tupleRoot }),
          "manifest_invalid",
        );
      failCode(() => observeLegacyTuple(root + "/", roles), "manifest_invalid");
      failCode(
        () => observeLegacyTuple(root + "/.", roles),
        "manifest_invalid",
      );
      assert.equal(attempts, 0);
      assert.equal(rootReads, 0);
      assert.deepEqual(observeLegacyTuple(root, roles), before);
    });
  } finally {
    fs.default.mkdtempSync = original;
    fs.default.opendirSync = originalDirectory;
    syncBuiltinESMExports();
    if (oldTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = oldTmp;
  }
  console.log(
    JSON.stringify({
      derived: true,
      protectedWriteAttempts: attempts,
      rootReads,
      canonicalAliasesRejected: true,
    }),
  );
}

if (process.argv[2] === "--inventory-worker") {
  void produceStoppedInventory(
    process.argv[3] as HistoricalMode,
    process.argv[4] as Requested,
  ).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else if (process.argv[2] === "--path-worker") {
  void pathWorker().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else if (process.argv[2] === "--schema-worker") {
  void schemaWorker().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else if (process.argv[2] === "--privacy-worker") {
  void privacyAndGrowthWorker().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  // Real retained-engine producers are test-only. Each fresh worker reaches the
  // accepted helper's stopped copy callback before any copied owner is reopened.
  for (const mode of ["agent", "progressive"] as const)
    for (const requested of [
      "pending",
      "question",
      "question-public",
      "consumed",
      "succeeded",
      "unknown",
      "failed",
      "rejected",
      "text",
    ] as const)
      test(
        `genuine stopped ${mode} ${requested}: bounded raw reader changes no protected bytes/modes or runtime counters`,
        { timeout: 150_000 },
        async () => {
          const result = await worker(["--inventory-worker", mode, requested]);
          assert.equal(result.genuine, true);
          assert.equal(result.sourceStable, true);
          assert.deepEqual(result.inventoryDelta, {
            models: 0,
            decisions: 0,
            dispatches: 0,
          });
        },
      );
  test(
    "genuine absent-kind legacy pending approval is inventoried without interpreting a delegate",
    { timeout: 150_000 },
    async () => {
      const result = await worker(["--inventory-worker", "legacy", "pending"]);
      assert.equal(result.genuine, true);
    },
  );
  test("derived reader keeps a 0700 outer wrapper for a 0755 tuple and rejects a growing source in bounded reads", async () => {
    const result = await worker(["--privacy-worker"]);
    assert.equal(result.privateOuter, true);
    assert.equal(result.growingSourceRejected, true);
  });
  test("derived SQL row count, full key bytes and aggregate payload preflight block before malformed JSON parsing", () => {
    for (const fault of [
      "row-count",
      "turn-key",
      "scope-key",
      "aggregate",
    ] as const)
      disposable((root, roles) => {
        const path =
          fault === "scope-key"
            ? roles.workflowDatabase
            : roles.identityDatabase;
        const db = new DatabaseSync(join(root, path));
        try {
          if (fault === "scope-key")
            db.prepare("INSERT INTO receipts VALUES(?,?,?,?)").run(
              "X".repeat(LEGACY_INVENTORY_LIMITS.rowBytes + 1),
              "TEST-command",
              "TEST-command",
              "{",
            );
          else {
            const insert = db.prepare(
              "INSERT INTO agent_service_turn VALUES(?,?,?,?)",
            );
            db.exec("BEGIN");
            const count =
              fault === "row-count"
                ? LEGACY_INVENTORY_LIMITS.rows + 1
                : fault === "aggregate"
                  ? 66
                  : 1;
            const data =
              fault === "aggregate"
                ? "{" + "X".repeat(LEGACY_INVENTORY_LIMITS.rowBytes - 1024)
                : "{";
            const id =
              fault === "turn-key"
                ? "X".repeat(LEGACY_INVENTORY_LIMITS.rowBytes + 1)
                : "0".repeat(64);
            for (let i = 0; i < count; i++)
              insert.run(id, "TEST-workspace", "TEST-user", data);
            db.exec("COMMIT");
          }
        } finally {
          db.close();
        }
        const before = observeLegacyTuple(root, roles),
          report = inventoryLegacyTuple(before);
        assert.equal(report.scanComplete, false, fault);
        assert.equal(report.classificationComplete, false, fault);
        assert(report.blockers.includes("payload_limit"));
        assert.deepEqual(observeLegacyTuple(root, roles), before);
      });
  });
  test("derived malformed JSON and foreign keys fail finitely without echoing private content", () => {
    disposable((root, roles) => {
      const db = new DatabaseSync(join(root, roles.identityDatabase));
      db.prepare("INSERT INTO agent_service_turn VALUES(?,?,?,?)").run(
        "0".repeat(64),
        "TEST-workspace",
        "TEST-user",
        "{TEST-private",
      );
      db.close();
      const report = inventoryLegacyTuple(observeLegacyTuple(root, roles));
      assert.equal(report.classificationComplete, false);
      assert(!JSON.stringify(report).includes("TEST-private"));
    });
    disposable((root, roles) => {
      const db = new DatabaseSync(join(root, roles.identityDatabase));
      db.exec(
        "PRAGMA foreign_keys=OFF; CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER REFERENCES parent(id)); INSERT INTO child VALUES(1)",
      );
      db.close();
      const before = observeLegacyTuple(root, roles);
      failCode(() => inventoryLegacyTuple(before), "database_invalid");
      assert.deepEqual(observeLegacyTuple(root, roles), before);
    });
  });
  test("derived manifest requires each role's exact SQLite family and explicit WAL/SHM absence", () =>
    disposable((root, roles) => {
      const before = observeLegacyTuple(root, roles);
      assert(
        before.sqliteFamilies.every(
          (family) =>
            family.wal.presence === "absent" &&
            family.shm.presence === "absent",
        ),
      );
      const omitted = structuredClone(before);
      delete (
        omitted.sqliteFamilies[0] as Partial<(typeof omitted.sqliteFamilies)[0]>
      ).wal;
      failCode(() => inventoryLegacyTuple(omitted), "manifest_invalid");
      const mixed = structuredClone(before);
      mixed.roles.ownerLocks = [roles.identityDatabase];
      failCode(() => inventoryLegacyTuple(mixed), "manifest_invalid");
      const extension = structuredClone(before);
      extension.roles.identityDatabase = "identity/identity.db";
      failCode(() => inventoryLegacyTuple(extension), "manifest_invalid");
      const capped = structuredClone(before);
      capped.files[0]!.size = LEGACY_INVENTORY_LIMITS.tupleBytes + 1;
      failCode(() => inventoryLegacyTuple(capped), "tuple_limit");
      writeFileSync(join(root, roles.configuration), "TEST changed bytes");
      failCode(() => inventoryLegacyTuple(before), "tuple_changed");
    }));
  test("derived manifest rejects a SQLite family omitted from all database roles", () =>
    disposable((root, roles) => {
      const extraPath = join(root, "identity/unclassified.sqlite");
      const extra = new DatabaseSync(extraPath);
      extra.exec("CREATE TABLE private_unknown(value TEXT)");
      extra.close();
      const before = observeLegacyTuple(root, roles);
      failCode(() => inventoryLegacyTuple(before), "manifest_invalid");
    }));
  test("derived manifest rejects unclassified uppercase SQLite extensions", () =>
    disposable((root, roles) => {
      writeFileSync(
        join(root, "identity/unclassified.SQLITE"),
        "TEST unclassified database",
      );
      const before = observeLegacyTuple(root, roles);
      assert(
        before.sqliteFamilies.some(
          (family) => family.main === "identity/unclassified.SQLITE",
        ),
      );
      failCode(() => inventoryLegacyTuple(before), "manifest_invalid");
    }));
  test("derived manifest cannot mislabel the canonical Mastra database as an owner lock", () =>
    disposable((root, roles) => {
      const path = roles.identityDatabase + ".mastra.sqlite";
      roles.nativeDatabases = [path];
      const native = new DatabaseSync(join(root, path));
      native.exec(
        "CREATE TABLE mastra_workflow_snapshot(workflow_name TEXT,run_id TEXT,resourceId TEXT,snapshot TEXT,createdAt TEXT,updatedAt TEXT)",
      );
      native.close();
      roles.nativeDatabases = [];
      roles.ownerLocks.push(path);
      failCode(
        () => inventoryLegacyTuple(observeLegacyTuple(root, roles)),
        "manifest_invalid",
      );
    }));
  test("derived matched WAL byte-state is consumed on disposable normal SQLite clone while source sidecars remain unchanged", () => {
    disposable((producer, roles) => {
      const db = new DatabaseSync(join(producer, roles.identityDatabase));
      const privateParent = mkdtempSync(
        join(tmpdir(), "niaro-inventory-wal-copy-"),
      );
      chmodSync(privateParent, 0o700);
      try {
        db.exec(
          "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO agent_service_turn VALUES('" +
            "0".repeat(64) +
            "','TEST-workspace','TEST-user','{TEST-WAL-private')",
        );
        assert(existsSync(join(producer, roles.identityDatabase + "-wal")));
        assert(existsSync(join(producer, roles.identityDatabase + "-shm")));
        const protectedRoot = join(privateParent, "tuple");
        cpSync(producer, protectedRoot, { recursive: true });
        // This is a derived fixed byte-state from a quiescent test producer, not
        // evidence of production owner exit or an accepted checkpoint provenance.
        db.close();
        const before = observeLegacyTuple(protectedRoot, roles),
          family = before.sqliteFamilies.find(
            (f) => f.main === roles.identityDatabase,
          )!;
        assert.equal(family.wal.presence, "present");
        assert.equal(family.shm.presence, "present");
        const report = inventoryLegacyTuple(before);
        assert.equal(report.scanComplete, true);
        assert.equal(
          report.entries.length,
          1,
          "TEST WAL-only committed row must be read",
        );
        assert.equal(report.classificationComplete, false);
        assert.deepEqual(observeLegacyTuple(protectedRoot, roles), before);
        const missing = structuredClone(before);
        missing.sqliteFamilies.find(
          (f) => f.main === roles.identityDatabase,
        )!.wal = { presence: "absent" };
        failCode(() => inventoryLegacyTuple(missing), "manifest_invalid");
      } finally {
        if (db.isOpen) db.close();
        rmSync(privateParent, { recursive: true, force: true });
      }
    });
  });
  test("derived fingerprint binds declared roles and ignores directory creation order", () =>
    disposable((root, roles) => {
      const identity = new DatabaseSync(join(root, roles.identityDatabase));
      identity.exec(
        "CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);INSERT INTO metadata VALUES('server_id','fixture-123456789012345678901234');CREATE TABLE workflows(scope_key TEXT,state TEXT);CREATE TABLE receipts(scope_key TEXT,command_id TEXT,idempotency_key TEXT,payload TEXT);INSERT INTO agent_service_turn VALUES('" +
          "0".repeat(64) +
          "','TEST-workspace','TEST-user','{TEST-private-legacy')",
      );
      identity.close();
      const workflow = new DatabaseSync(join(root, roles.workflowDatabase));
      workflow.exec(
        "CREATE TABLE agent_service_turn(id TEXT,workspace_id TEXT,user_id TEXT,data TEXT);CREATE TABLE agent_service_invocation(id TEXT,workspace_id TEXT,user_id TEXT,data TEXT);CREATE TABLE agent_service_turn_operation(operation_id TEXT,turn_id TEXT,workspace_id TEXT,user_id TEXT);CREATE TABLE agent_workspace(id TEXT,organization_id TEXT)",
      );
      workflow.close();
      const first = observeLegacyTuple(root, roles),
        firstReport = inventoryLegacyTuple(first);
      assert.equal(firstReport.classificationComplete, false);
      const swapped = {
        ...roles,
        identityDatabase: roles.workflowDatabase,
        workflowDatabase: roles.identityDatabase,
      };
      const secondReport = inventoryLegacyTuple(
        observeLegacyTuple(root, swapped),
      );
      assert.equal(secondReport.classificationComplete, true);
      assert.notEqual(firstReport.fingerprint, secondReport.fingerprint);
      const wrapper = mkdtempSync(join(tmpdir(), "niaro-inventory-reordered-"));
      chmodSync(wrapper, 0o700);
      try {
        const copy = join(wrapper, "tuple");
        mkdirSync(copy);
        chmodSync(
          copy,
          first.directories.find((item) => item.path === ".")!.mode,
        );
        for (const directory of [...first.directories]
          .filter((item) => item.path !== ".")
          .sort(
            (a, b) =>
              a.path.length - b.path.length || b.path.localeCompare(a.path),
          )) {
          mkdirSync(join(copy, directory.path));
          chmodSync(join(copy, directory.path), directory.mode);
        }
        for (const file of [...first.files].reverse()) {
          cpSync(join(root, file.path), join(copy, file.path));
          chmodSync(join(copy, file.path), file.mode);
        }
        const reordered = observeLegacyTuple(copy, roles);
        assert.deepEqual(reordered.files, first.files);
        assert.deepEqual(reordered.directories, first.directories);
        assert.equal(
          inventoryLegacyTuple(reordered).fingerprint,
          firstReport.fingerprint,
        );
        const arrayOrder = {
          ...roles,
          ownerLocks: [...roles.ownerLocks].reverse(),
        };
        assert.equal(
          inventoryLegacyTuple(observeLegacyTuple(root, arrayOrder))
            .fingerprint,
          firstReport.fingerprint,
        );
      } finally {
        rmSync(wrapper, { recursive: true, force: true });
      }
    }));
  test("derived nonordinary or overflowing schema is rejected before any integrity/FK/data query", async () => {
    const result = await worker(["--schema-worker"]);
    assert.equal(result.schemaRejectedBeforeIntegrityAndData, true);
    assert.equal(result.forbiddenQueries, 0);
    assert.equal(result.cases, 5);
  });
  for (const fault of ["duplicate", "native", "public"] as const)
    test(`derived persisted ${fault} ambiguity denies complete/passive old turns while originals remain unchanged`, () =>
      disposable((root, roles) => {
        seedReviewRows(root, roles, reviewRows(fault));
        const before = observeLegacyTuple(root, roles),
          report = inventoryLegacyTuple(before);
        assert.equal(report.scanComplete, true);
        assert.equal(report.classificationComplete, false);
        assert.equal(report.counts.passiveTurns, 0);
        assert.deepEqual(observeLegacyTuple(root, roles), before);
        if (fault === "duplicate")
          assert(report.blockers.includes("journal_identity_ambiguous"));
        if (fault === "native") {
          assert(report.blockers.includes("native_unclassified"));
          assert.equal(report.counts.activeTurns, 1);
        }
        if (fault === "public") {
          assert.equal(report.counts.passiveReceipts, 1);
          assert(
            report.entries[0]!.blockers.includes("completed_control_unproven"),
          );
        }
      }));
  test("derived native receipt attribution stays incomplete and preserves the stopped tuple", () =>
    disposable((root, roles) => {
      const data = reviewRows("public");
      addNativeOwnedReceipt(data);
      seedReviewRows(root, roles, data);
      const before = observeLegacyTuple(root, roles),
        report = inventoryLegacyTuple(before);
      assert.equal(report.status, "incomplete");
      assert.equal(report.scanComplete, true);
      assert.equal(report.classificationComplete, false);
      assert.equal(report.provenance.ownerStop, "unverified");
      assert.equal(report.provenance.commonCheckpoint, "unverified");
      assert(!report.blockers.includes("native_unclassified"));
      assert(!report.blockers.includes("native_lifecycle_invalid"));
      assert(!report.blockers.includes("unowned_receipt"));
      assert.deepEqual(report.nativeRuns, [
        {
          id: String(
            data.turns.find((row) => row.id !== data.turns[0]!.id)!.id,
          ),
          kind: "service-process-1",
          classification: "terminal_candidate",
          status: "succeeded",
        },
      ]);
      assert(!JSON.stringify(report).includes("TEST-private-native-input"));
      assert.deepEqual(observeLegacyTuple(root, roles), before);
    }));
  test("derived native approval wait remains a blocker and preserves the stopped tuple", () =>
    disposable((root, roles) => {
      const data = reviewRows("public");
      addNativeOwnedReceipt(data, "waiting");
      seedReviewRows(root, roles, data);
      const before = observeLegacyTuple(root, roles),
        report = inventoryLegacyTuple(before);
      assert.equal(report.status, "incomplete");
      assert.equal(report.scanComplete, true);
      assert.equal(report.classificationComplete, false);
      assert(report.blockers.includes("native_waiting"));
      assert(!report.blockers.includes("native_unclassified"));
      assert(!report.blockers.includes("native_lifecycle_invalid"));
      assert.deepEqual(report.nativeRuns, [
        {
          id: String(
            data.turns.find((row) => row.id !== data.turns[0]!.id)!.id,
          ),
          kind: "service-process-1",
          classification: "waiting",
          status: "waiting",
        },
      ]);
      assert(!JSON.stringify(report).includes("TEST-private-native-input"));
      assert.deepEqual(observeLegacyTuple(root, roles), before);
    }));
  test("native Mastra run tables contribute bounded redacted counts only", () =>
    disposable((root, roles) => {
      addNativeStorage(root, roles);
      const before = observeLegacyTuple(root, roles);
      const report = inventoryLegacyTuple(before);
      assert.equal(report.profile, "niaro-legacy-inventory/4");
      assert.equal(report.scanComplete, true);
      assert.equal(report.classificationComplete, false);
      assert(report.blockers.includes("native_store_unclassified"));
      assert.deepEqual(report.nativeStorage, {
        profile: "@mastra/core@1.74.0+@mastra/libsql@1.25.0",
        databaseCount: 1,
        workflowSnapshots: 1,
        backgroundTasks: 1,
        scan: "complete",
      });
      for (const secret of [
        "TEST_PRIVATE_SNAPSHOT_CONTENT",
        "TEST_PRIVATE_ARGS",
        "TEST_PRIVATE_RESULT",
        "TEST_PRIVATE_ERROR",
        "TEST_PRIVATE_SUSPEND",
        "TEST-private-status",
        "TEST-background-id",
        "TEST-workflow-0",
      ])
        assert(!JSON.stringify(report).includes(secret));
      assert.deepEqual(observeLegacyTuple(root, roles), before);
    }));
  test("empty but supported native storage reports zero counts while staying unclassified", () =>
    disposable((root, roles) => {
      addNativeStorage(root, roles, { snapshots: 0, backgroundTasks: 0 });
      const report = inventoryLegacyTuple(observeLegacyTuple(root, roles));
      assert.equal(report.scanComplete, true);
      assert.equal(report.classificationComplete, false);
      assert.deepEqual(report.nativeStorage, {
        profile: "@mastra/core@1.74.0+@mastra/libsql@1.25.0",
        databaseCount: 1,
        workflowSnapshots: 0,
        backgroundTasks: 0,
        scan: "complete",
      });
      assert(report.blockers.includes("native_store_unclassified"));
    }));
  test("native snapshot composite unique key matches the writer schema", () =>
    disposable((root, roles) => {
      addNativeStorage(root, roles, {
        snapshots: 2,
        backgroundTasks: 0,
      });
      const report = inventoryLegacyTuple(observeLegacyTuple(root, roles));
      assert.equal(report.scanComplete, true);
      assert.equal(report.classificationComplete, false);
      assert.equal(report.nativeStorage.workflowSnapshots, 2);
      assert(report.blockers.includes("native_store_unclassified"));
    }));
  test("missing required native tables remain unrecognized rather than appearing empty", () =>
    disposable((root, roles) => {
      addNativeStorage(root, roles, { omitWorkflowTable: true });
      const report = inventoryLegacyTuple(observeLegacyTuple(root, roles));
      assert.equal(report.scanComplete, false);
      assert(report.blockers.includes("native_schema_unrecognized"));
      assert.equal(report.nativeStorage.workflowSnapshots, null);
      assert.equal(report.nativeStorage.backgroundTasks, null);
    }));
  test("unsupported native storage schema is an explicit incomplete blocker", () =>
    disposable((root, roles) => {
      addNativeStorage(root, roles, { extraWorkflowColumn: true });
      const report = inventoryLegacyTuple(observeLegacyTuple(root, roles));
      assert.equal(report.scanComplete, false);
      assert.equal(report.classificationComplete, false);
      assert(report.blockers.includes("native_schema_unrecognized"));
      assert.deepEqual(report.nativeStorage, {
        profile: "@mastra/core@1.74.0+@mastra/libsql@1.25.0",
        databaseCount: 1,
        workflowSnapshots: null,
        backgroundTasks: null,
        scan: "incomplete",
      });
    }));
  test("native tables with matching names but drifted types are unrecognized", () =>
    disposable((root, roles) => {
      addNativeStorage(root, roles, { wrongWorkflowType: true });
      const report = inventoryLegacyTuple(observeLegacyTuple(root, roles));
      assert.equal(report.scanComplete, false);
      assert(report.blockers.includes("native_schema_unrecognized"));
      assert.equal(report.nativeStorage.workflowSnapshots, null);
    }));
  test("native workflow tables without the writer unique key are unrecognized", () =>
    disposable((root, roles) => {
      addNativeStorage(root, roles, { omitWorkflowUnique: true });
      const report = inventoryLegacyTuple(observeLegacyTuple(root, roles));
      assert.equal(report.scanComplete, false);
      assert(report.blockers.includes("native_schema_unrecognized"));
      assert.equal(report.nativeStorage.workflowSnapshots, null);
    }));
  for (const workflowIndexDrift of ["partial", "nocase"] as const)
    test(`native workflow ${workflowIndexDrift} unique indexes are unrecognized`, () =>
      disposable((root, roles) => {
        addNativeStorage(root, roles, { workflowIndexDrift });
        const report = inventoryLegacyTuple(observeLegacyTuple(root, roles));
        assert.equal(report.scanComplete, false);
        assert(report.blockers.includes("native_schema_unrecognized"));
        assert.equal(report.nativeStorage.workflowSnapshots, null);
      }));
  test("additional native tables make the inventory incomplete", () =>
    disposable((root, roles) => {
      addNativeStorage(root, roles, { extraTable: true });
      const report = inventoryLegacyTuple(observeLegacyTuple(root, roles));
      assert.equal(report.scanComplete, false);
      assert(report.blockers.includes("native_schema_unrecognized"));
      assert.equal(report.nativeStorage.backgroundTasks, null);
    }));
  test("SQLite-prefix lookalike tables are not mistaken for internal tables", () =>
    disposable((root, roles) => {
      addNativeStorage(root, roles, { sqlitePrefixLookalike: true });
      const report = inventoryLegacyTuple(observeLegacyTuple(root, roles));
      assert.equal(report.scanComplete, false);
      assert(report.blockers.includes("native_schema_unrecognized"));
      assert.equal(report.nativeStorage.backgroundTasks, null);
    }));
  test("corrupt native storage is an explicit incomplete blocker", () =>
    disposable((root, roles) => {
      const path = roles.identityDatabase + ".mastra.sqlite";
      roles.nativeDatabases = [path];
      writeFileSync(join(root, path), "TEST-not-a-sqlite-database", {
        mode: 0o600,
      });
      const report = inventoryLegacyTuple(observeLegacyTuple(root, roles));
      assert.equal(report.scanComplete, false);
      assert.equal(report.classificationComplete, false);
      assert(report.blockers.includes("native_schema_unrecognized"));
      assert.deepEqual(report.nativeStorage, {
        profile: "@mastra/core@1.74.0+@mastra/libsql@1.25.0",
        databaseCount: 1,
        workflowSnapshots: null,
        backgroundTasks: null,
        scan: "incomplete",
      });
    }));
  test("native row bounds fail closed without exposing counts", () =>
    disposable((root, roles) => {
      addNativeStorage(root, roles, {
        snapshots: LEGACY_INVENTORY_LIMITS.rows + 1,
      });
      const report = inventoryLegacyTuple(observeLegacyTuple(root, roles));
      assert.equal(report.scanComplete, false);
      assert(report.blockers.includes("payload_limit"));
      assert.deepEqual(report.nativeStorage, {
        profile: "@mastra/core@1.74.0+@mastra/libsql@1.25.0",
        databaseCount: 1,
        workflowSnapshots: null,
        backgroundTasks: null,
        scan: "incomplete",
      });
    }));
  test("native full-row byte bounds cover sensitive snapshot payload without exposing it", () =>
    disposable((root, roles) => {
      addNativeStorage(root, roles, { oversizedSnapshot: true });
      const report = inventoryLegacyTuple(observeLegacyTuple(root, roles));
      assert.equal(report.scanComplete, false);
      assert(report.blockers.includes("payload_limit"));
      assert.equal(report.nativeStorage.workflowSnapshots, null);
      assert(
        !JSON.stringify(report).includes(
          "X".repeat(LEGACY_INVENTORY_LIMITS.rowBytes + 1),
        ),
      );
    }));
  test("native aggregate byte bound covers individually bounded rows", () =>
    disposable((root, roles) => {
      addNativeStorage(root, roles, {
        snapshots: 65,
        backgroundTasks: 0,
        snapshotPayloadBytes: LEGACY_INVENTORY_LIMITS.rowBytes - 500,
      });
      const report = inventoryLegacyTuple(observeLegacyTuple(root, roles));
      assert.equal(report.scanComplete, false);
      assert(report.blockers.includes("payload_limit"));
      assert.equal(report.nativeStorage.workflowSnapshots, null);
      assert(!JSON.stringify(report).includes("XXXX"));
    }));
  test("derived canonical root aliases and root directory cannot attempt a protected temporary write", async () => {
    const result = await worker(["--path-worker"]);
    assert.equal(result.protectedWriteAttempts, 0);
    assert.equal(result.rootReads, 0);
    assert.equal(result.canonicalAliasesRejected, true);
  });
  for (const fault of ["consumed-public", "consumed-raw"] as const)
    test(`derived persisted ${fault} result cannot promote a known-positive question to consumed`, () =>
      disposable((root, roles) => {
        seedReviewRows(root, roles, reviewRows(fault));
        const before = observeLegacyTuple(root, roles),
          report = inventoryLegacyTuple(before);
        assert.equal(report.scanComplete, true);
        assert.equal(report.classificationComplete, false);
        assert.equal(report.counts.passiveTurns, 0);
        assert.equal(report.counts.activeTurns, 1);
        assert.deepEqual(observeLegacyTuple(root, roles), before);
      }));
}
