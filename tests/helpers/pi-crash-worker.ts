/**
 * One process of a Pi agent core crash scenario (tests/pi-crash.node.ts).
 * Usage: pi-crash-worker.ts <scenario> <start|resume> <dir>
 *
 * Scenarios:
 * - model-stream: killed while a streamed model request is in flight.
 * - write-keyed: killed after an idempotent write's side effect, before its
 *   result is committed.
 * - write-unkeyed: the same crash for a write without an idempotency key.
 */
import { join } from "node:path";
import type { PiAgentCore } from "@niaro/server-agent/pi";
import { agentCoreModelHost } from "../../apps/server-identity/agent-core";
import {
  canStream,
  streamingTransport,
  type IntegrationTransport,
} from "../../apps/server-integrations/transport";
import { crashChild } from "./pi-crash";
import {
  attempts,
  enforce,
  entries,
  fakeTransport,
  loadPi,
  loadPiDurable,
  piCatalog,
  piScope,
  serialQueue,
  type Reply,
} from "./pi-agent";

const child = crashChild();
const LONG = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");

async function main() {
  const { PiAgentCore, ctx, idempotentWriteTool, interruptibleWriteTool } =
    await loadPi();
  const { defineExtension } = await loadPiDurable();
  const { str, obj } = await import("@earendil-works/pi-schema");
  const start = child.step === "start";
  const catalog = piCatalog(join(child.dir, "identity.sqlite"), start);
  catalog.db.exec(
    "CREATE TABLE IF NOT EXISTS test_effect(key TEXT PRIMARY KEY, text TEXT NOT NULL, executions INTEGER NOT NULL)",
  );
  if (start) {
    catalog.command({
      type: "saveOrganizationModelPolicy",
      revision: 0,
      policy: { roles: { chat: { models: [catalog.models.fast] } } },
    });
    enforce(catalog, [catalog.models.fast], { maxOutputTokens: 400 });
  }
  const effects = () =>
    catalog.db.prepare("SELECT key,text,executions FROM test_effect").all();
  const apply = (key: string, text: string) =>
    catalog.db
      .prepare(
        "INSERT INTO test_effect VALUES (?,?,1) ON CONFLICT(key) DO UPDATE SET executions=executions+1",
      )
      .run(key, text);
  const parameters = obj({ text: str() });
  const afterEffect = async () => {
    if (!start) return;
    child.mark("side_effect_done");
    await child.hang();
  };
  const keyed = idempotentWriteTool({
    name: "save_note",
    description: "Save a note (deduplicated by key)",
    parameters,
    execute: async (args, _api, key) => {
      // The service keeps one effect per key, as a provider's idempotency does.
      catalog.db
        .prepare(
          "INSERT INTO test_effect VALUES (?,?,1) ON CONFLICT(key) DO NOTHING",
        )
        .run(key, args.text);
      await afterEffect();
      return { output: [{ type: "text", text: `Saved "${args.text}".` }] };
    },
  });
  const unkeyed = interruptibleWriteTool({
    name: "save_note",
    description: "Save a note",
    parameters,
    execute: async (args, api) => {
      apply(`call:${String(api.taskId)}:${process.pid}`, args.text);
      await afterEffect();
      return { output: [{ type: "text", text: `Saved "${args.text}".` }] };
    },
  });

  let transport: IntegrationTransport;
  let tools: Parameters<typeof defineExtension>[0]["tools"] = [];
  if (child.scenario === "model-stream")
    transport = fakeTransport([{ kind: "text", text: LONG }], {
      stream: true,
      delayMs: start ? 150 : 0,
    }).transport;
  else {
    const replies: Reply[] = start
      ? [{ kind: "tool", name: "save_note", args: { text: "pay invoice 42" } }]
      : [{ kind: "text", text: "Done." }];
    transport = fakeTransport(replies).transport;
    tools = [child.scenario === "write-keyed" ? keyed : unkeyed];
  }
  let requests = 0;
  const counted: IntegrationTransport = (request) => {
    requests++;
    return transport({
      ...request,
      // The crash point: the reply is being streamed.
      ...(start &&
        request.onEvent && {
          onEvent: (data: string) => {
            request.onEvent!(data);
            child.mark("streaming");
          },
        }),
    });
  };
  const host = agentCoreModelHost({
    catalog: catalog.store,
    transport: canStream(transport) ? streamingTransport(counted) : counted,
    serial: serialQueue(),
  });
  const core: PiAgentCore = await PiAgentCore.open({
    file: join(child.dir, "agent-core.sqlite"),
    host,
    extensions: [defineExtension({ name: "test-notes", tools })],
    settings: { retry: { baseDelayMs: 10, maxAgentDelayMs: 50 } },
    // The resumed process looks at the stored state before Pi runs anything.
    resume: false,
  });
  if (start) {
    const conversation = await core.createConversation(piScope);
    const submission = await conversation.submit(
      {
        type: "input",
        content:
          child.scenario === "model-stream" ? "tell a long story" : "save it",
      },
      ctx,
    );
    child.state("ids", {
      conversation: String(conversation.id),
      submission: String(submission.id),
    });
    child.mark("submitted");
    await submission.wait(ctx);
    // Reached only when the parent's kill came too late.
    child.mark("finished_without_crash");
    await child.hang();
  }

  const ids = child.state<{ conversation: string; submission: string }>("ids");
  const ledgerBefore = attempts(catalog.db).map((row) => row.status);
  const effectsBefore = effects();
  core.harness.resume();
  const submission = await core.harness.submission(
    ids.submission as never,
    ctx,
  );
  const settled = await submission!.wait(ctx);
  const items = await entries(core, ids.conversation);
  child.result({
    status: settled.status,
    ledgerBefore,
    ledger: attempts(catalog.db).map((row) => ({
      run: row.run_id,
      status: row.status,
    })),
    requests,
    effectsBefore,
    effects: effects(),
    users: items.filter((e) => e.kind === "pi.user").length,
    assistants: items
      .filter((e) => e.kind === "pi.assistant")
      .map((e) => ({
        stop: e.message.stopReason,
        text: e.message.content
          ?.filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
      })),
    toolResults: items
      .filter((e) => e.kind === "pi.tool-result")
      .map((e) => ({
        error: (e.message as { isError?: boolean }).isError === true,
        text: e.message.content?.map((part) => part.text).join(""),
      })),
  });
  await core.close();
  catalog.db.close();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
