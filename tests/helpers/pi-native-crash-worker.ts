/**
 * One process of a native agent run crash scenario on Pi (tests/pi-crash.node.ts).
 * Usage: pi-native-crash-worker.ts <scenario> <start|resume> <dir>
 *
 * Scenarios:
 * - native-fatal: the run's model call fails for good; killed after that.
 * - native-tool: killed while the domain runs a write of the run.
 *
 * The resumed process only reopens the core and reports what it proves; no
 * request continues the run (continuing chat turns is wave 3 step C).
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  LanguageModelV4,
  LanguageModelV4StreamPart,
} from "../../apps/server-agent/model-types";
import type {
  NativeAgentInput,
  NativeAgentSession,
} from "../../apps/server-agent/native-contract";
import { crashChild } from "./pi-crash";

const child = crashChild();
const binding = {
  runId: "TEST-run-1",
  threadId: "TEST-thread",
  resourceId: "TEST-resource",
};
const log = join(child.dir, "events.log");
const event = (name: string) => appendFileSync(log, `${name}\n`);
const events = () =>
  existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];

const finish = {
  type: "finish",
  finishReason: { unified: "tool-calls", raw: undefined },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
} as LanguageModelV4StreamPart;
const createModel: NativeAgentInput["createModel"] = () =>
  ({
    specificationVersion: "v4",
    provider: "test",
    modelId: "test",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("TEST stream only");
    },
    doStream: async () => {
      event("model");
      if (child.scenario === "native-fatal")
        throw Object.assign(new Error("integration_provider_failed"), {
          code: "integration_provider_failed",
        });
      const parts: LanguageModelV4StreamPart[] = [
        {
          type: "tool-call",
          toolCallId: "TEST-call-1",
          toolName: "write_note",
          input: JSON.stringify({ text: "TEST note" }),
        },
        finish,
      ];
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  }) as unknown as LanguageModelV4;

const session: NativeAgentSession = {
  state: {},
  activeTools: () => ["write_note"],
  prepareModel: async () => ({
    selected: {
      provider: { id: "TEST-provider", revision: 1 },
      model: { id: "TEST-model-id", model: "TEST-model" },
    } as never,
    instructions: "TEST instructions",
    context: "TEST context",
    privateContext: false,
  }),
  allowance: async (_provider, _revision, start) => start(),
  invoke: async () => {
    event("invoke");
    child.mark("invoked");
    return child.hang();
  },
  finalize: async (reply) => ({ reply }) as never,
  save: async () => undefined,
};

async function main() {
  const { PiAgentCore } = await import("@niaro/server-agent/pi");
  const core = await PiAgentCore.open({
    file: join(child.dir, "identity.sqlite.pi.sqlite"),
    host: {
      plan: async () => {
        throw new Error("TEST no route model");
      },
    },
  });
  const runtime = core.agentRuntime();
  if (child.step === "start") {
    const failed = await runtime
      .execute({
        ...binding,
        text: "Write a note",
        signal: new AbortController().signal,
        definitions: [
          {
            name: "write_note",
            description: "Write a note",
            parameters: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
            validate: () => ({ valid: true }),
          },
        ],
        createModel,
        session,
      })
      .then(
        () => "",
        (error: unknown) => String((error as Error).message),
      );
    child.mark("failed", { failed });
    await child.hang();
  }
  // Let anything Pi resumes by itself run before reading the state.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const { messages } = await runtime.inspect(binding);
  child.result({
    events: events(),
    settled: runtime.isSettled(binding.runId),
    retired: await runtime.proveRetired(binding),
    suspended: await runtime.proveSuspended({
      ...binding,
      toolCallId: "TEST-call-1",
    }),
    roles: messages.map((message) => message.role),
  });
  await core.close();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
