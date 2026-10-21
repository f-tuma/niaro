// Offline child-process fixture. Never imported by the production application.
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type {
  NativeAgentInput,
  NativeAgentSession,
} from "../../apps/server-agent/runtime";
import {
  createNiaroMastraModel,
  type NiaroModelSelection,
} from "../../apps/server-integrations/mastra-model";
import type { IntegrationTransport } from "../../apps/server-integrations/transport";
import { runProductionDomainCrash } from "./mastra-domain-crash";
import { nativeToolValidator } from "../../apps/server-identity/mastra-domain";

const directory = process.argv[2];
const mode = process.argv[3];
if (!directory || !mode)
  throw new Error("TEST crash fixture arguments missing");

const binding = {
  runId: "TEST-original-native-run",
  threadId: "TEST-original-native-thread",
  resourceId: createHash("sha256")
    .update(
      JSON.stringify([
        "TEST-server",
        "TEST-org",
        "TEST-workspace",
        "TEST-user",
      ]),
    )
    .digest("hex"),
};
const selection: NiaroModelSelection = {
  provider: {
    id: "11111111-1111-4111-8111-111111111111",
    revision: 1,
    name: "TEST offline provider",
    url: "https://offline.test.invalid/v1",
    enabled: true,
    dailyRequestLimit: 100,
    hasCredential: true,
    requestsToday: 0,
  },
  key: "TEST-offline-secret",
  model: {
    id: "22222222-2222-4222-8222-222222222222",
    revision: 1,
    providerId: "11111111-1111-4111-8111-111111111111",
    name: "TEST offline model",
    model: "TEST/offline",
    enabled: true,
    tools: true,
    audioInput: false,
    audioOutput: false,
    kind: "chat",
  },
};

function report(value: unknown) {
  writeFileSync(join(directory!, "outcome.json"), JSON.stringify(value));
}

async function main() {
  const invalidMode = mode!.startsWith("invalid-");
  const businessMode = mode!.startsWith("business-");
  const invalidKind = mode!.split("-")[1];
  const schema = invalidMode
    ? { type: "object", properties: {}, additionalProperties: false }
    : businessMode
      ? {
          type: "object",
          properties: {
            resumeData: { type: "string" },
            _background: { type: "boolean" },
            suspendedToolRunId: { type: "string" },
            suspendedToolCallId: { type: "string" },
            niaroBusinessInput: { type: "string" },
          },
          required: [
            "resumeData",
            "_background",
            "suspendedToolRunId",
            "suspendedToolCallId",
            "niaroBusinessInput",
          ],
          additionalProperties: false,
        }
      : {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        };
  const db = new DatabaseSync(join(directory!, "business.sqlite"));
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS probe_authority(id INTEGER PRIMARY KEY, allowed INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS probe_effect(id INTEGER PRIMARY KEY, revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS probe_receipt(call_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, resource_id TEXT NOT NULL, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS probe_tool_call(id INTEGER PRIMARY KEY, mode TEXT NOT NULL, call_id TEXT NOT NULL, run_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS probe_model_call(id INTEGER PRIMARY KEY, mode TEXT NOT NULL, has_result INTEGER NOT NULL, new_call_id TEXT NOT NULL, request TEXT NOT NULL);
    INSERT OR IGNORE INTO probe_authority VALUES(1,1);
    INSERT OR IGNORE INTO probe_effect VALUES(1,0);
  `);
  const authorize = async () => {
    if (
      db.prepare("SELECT allowed FROM probe_authority WHERE id=1").get()
        ?.allowed !== 1
    ) {
      throw new Error("TEST-current-actor-revoked");
    }
  };
  const transport: IntegrationTransport = async (request) => {
    await authorize();
    await request.beforeDispatch?.(() => {});
    const body = request.body as {
      messages: { role: string; content?: string; tool_call_id?: string }[];
    };
    const receipt = body.messages.findLast(
      (message) => message.role === "tool",
    );
    const callId = randomUUID();
    db.prepare(
      "INSERT INTO probe_model_call(mode,has_result,new_call_id,request) VALUES(?,?,?,?)",
    ).run(mode!, receipt ? 1 : 0, callId, JSON.stringify(body.messages));
    return {
      status: 200,
      headers: {},
      text: JSON.stringify({
        choices: [
          {
            finish_reason: receipt ? "stop" : "tool_calls",
            message: receipt
              ? { content: "TEST effect verified" }
              : {
                  content: null,
                  tool_calls: [
                    {
                      id: callId,
                      type: "function",
                      function: {
                        name:
                          invalidKind === "unknownName"
                            ? "TEST_PRIVATE_NATIVE_UNKNOWN_TOOL_NAME"
                            : invalidKind === "unavailable"
                              ? "unavailable_probe"
                              : "probe_effect",
                        arguments: JSON.stringify(
                          invalidMode
                            ? invalidKind === "null"
                              ? null
                              : {
                                  [invalidKind!]: {
                                    secret:
                                      "TEST_PRIVATE_NATIVE_CRASH_CREDENTIAL",
                                  },
                                }
                            : businessMode
                              ? {
                                  niaroBusinessInput: {
                                    resumeData: "TEST-business-resumeData",
                                    _background: false,
                                    suspendedToolRunId: "TEST-business-run-id",
                                    suspendedToolCallId:
                                      "TEST-business-call-id",
                                    niaroBusinessInput:
                                      "TEST-nested-business-envelope-key",
                                  },
                                }
                              : { value: "TEST-once" },
                        ),
                      },
                    },
                  ],
                },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    };
  };
  const session: NativeAgentSession = {
    state: {},
    activeTools: () => ["probe_effect"],
    async prepareModel() {
      await authorize();
      return {
        selected: selection,
        instructions: "TEST use probe_effect once",
      };
    },
    async allowance(_provider, _revision, start) {
      await authorize();
      start();
    },
    async invoke(name, args, metadata) {
      await authorize();
      if (name !== "probe_effect") throw new Error("TEST-unexpected-tool");
      db.prepare(
        "INSERT INTO probe_tool_call(mode,call_id,run_id) VALUES(?,?,?)",
      ).run(mode!, metadata.toolCallId, metadata.runId);
      if (mode === "start-before" || mode === "business-start")
        process.kill(process.pid, "SIGKILL");
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = db
          .prepare("SELECT * FROM probe_receipt WHERE call_id=?")
          .get(metadata.toolCallId);
        if (!existing) {
          db.prepare(
            "INSERT INTO probe_receipt(call_id,run_id,resource_id,value) VALUES(?,?,?,?)",
          ).run(
            metadata.toolCallId,
            metadata.runId,
            binding.resourceId,
            JSON.stringify(args),
          );
          db.exec("UPDATE probe_effect SET revision=revision+1 WHERE id=1");
        } else if (
          existing.run_id !== metadata.runId ||
          existing.resource_id !== binding.resourceId
        ) {
          throw new Error("TEST-receipt-scope-mismatch");
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      if (mode === "start-after") process.kill(process.pid, "SIGKILL");
      return { verified: true, toolCallId: metadata.toolCallId };
    },
    async finalize(reply) {
      await authorize();
      const answer = { reply };
      session.state.answer = answer;
      return answer;
    },
    async save() {},
  };
  const { createNativeAgentRuntime } = await import("@niaro/server-agent");
  const runtime = createNativeAgentRuntime(
    pathToFileURL(join(directory!, "native.sqlite")).href,
  );
  let result: Awaited<ReturnType<typeof runtime.execute>>;
  try {
    const input: NativeAgentInput = {
      ...binding,
      ...(mode === "foreign-resource"
        ? { resourceId: "TEST-another-actor-resource" }
        : {}),
      ...(mode === "foreign-thread" ? { threadId: "TEST-another-thread" } : {}),
      text: "TEST perform effect once",
      signal: new AbortController().signal,
      definitions: [
        {
          name: "probe_effect",
          description: "TEST offline idempotent effect",
          parameters: schema,
          validate: nativeToolValidator(schema),
        },
      ],
      session,
      createModel: (selected, guard) =>
        createNiaroMastraModel(selected, transport, guard),
      onEvent: (event) => {
        if (
          invalidMode &&
          mode!.endsWith("-start") &&
          event.type === "tool-start"
        )
          process.kill(process.pid, "SIGKILL");
        if (mode === "business-start" && event.type === "tool-start")
          process.kill(process.pid, "SIGKILL");
      },
    };
    result = await runtime.execute(input);
  } finally {
    await runtime.close();
    db.close();
  }
  report({ result });
}

// Native offline execution can wait on promises without a referenced socket.
// Keep the fixture alive until main settles, so a silent event-loop exit cannot
// masquerade as a successful process recovery.
const keepAlive = setInterval(() => {}, 1000);
(mode.startsWith("memory-") || mode.startsWith("action-")
  ? runProductionDomainCrash(directory, mode).then(report)
  : main()
)
  .catch((error: unknown) => {
    report({ error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  })
  .finally(() => clearInterval(keepAlive));
