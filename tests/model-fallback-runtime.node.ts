import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import {
  createNativeAgentRuntime,
  type NativeAgentEvent,
  type NativeAgentSession,
} from "@niaro/server-agent";
import {
  createNiaroMastraModel,
  type NiaroModelSelection,
} from "../apps/server-integrations/mastra-model";
import {
  IntegrationError,
  RequestNotSent,
  type IntegrationTransport,
} from "../apps/server-integrations/transport";
import { IdentityError } from "../apps/server-identity/error";
import { notDispatchedCause } from "../apps/server-identity/model-policy";

const selection = (
  name: string,
  index: number,
  reason: string,
): NiaroModelSelection => {
  const providerId = `11111111-1111-4111-8111-11111111111${index}`;
  return {
    provider: {
      id: providerId,
      revision: 1,
      name: "TEST provider " + name,
      url: `https://${name}.test.invalid/api/v1`,
      enabled: true,
      dailyRequestLimit: 10,
      hasCredential: true,
      requestsToday: 0,
    },
    key: "TEST-key-" + name,
    model: {
      id: `22222222-2222-4222-8222-22222222222${index}`,
      revision: 1,
      providerId,
      name: "TEST model " + name,
      model: "test/" + name,
      enabled: true,
      tools: true,
      audioInput: false,
      audioOutput: false,
      kind: "chat",
    },
    route: { role: "chat", index, fallback: true, reason },
  };
};
const first = selection("first", 0, "primary");
const second = selection("second", 1, "fallback: pending");

/**
 * One chat run whose first model fails as `failFirst` says: refused by the
 * daily limit before dispatch, a connection that never sent a byte, or a
 * timeout after the request left.
 */
async function run(failFirst: "limit" | "unsent" | "timeout") {
  const directory = mkdtempSync(join(tmpdir(), "niaro-fallback-"));
  const runtime = createNativeAgentRuntime(
    pathToFileURL(join(directory, "native.sqlite")).href,
  );
  const sent: string[] = [];
  const events: NativeAgentEvent[] = [];
  const asked: unknown[] = [];
  const transport: IntegrationTransport = async (request) => {
    const model = (request.body as { model: string }).model;
    await request.beforeDispatch?.(() => {});
    if (model === "test/first" && failFirst === "unsent")
      throw new RequestNotSent();
    sent.push(model);
    if (model === "test/first" && failFirst === "timeout")
      throw new IntegrationError("integration_timeout", 504);
    return {
      status: 200,
      headers: {},
      text: JSON.stringify({
        choices: [{ message: { content: "TEST answer from " + model } }],
      }),
    };
  };
  const session: NativeAgentSession = {
    state: {},
    activeTools: () => [],
    prepareModel: async () => ({
      selected: first,
      instructions: "TEST",
      privateContext: false,
    }),
    allowance: async (providerId, _revision, start) => {
      // The provider's daily limit refuses before anything is dispatched.
      if (providerId === first.provider.id && failFirst === "limit")
        throw new IdentityError(429, "catalog_provider_limit");
      start();
    },
    fallback: async (selected, error) => {
      asked.push(error);
      const cause = notDispatchedCause(error);
      return cause && selected.model.id === first.model.id
        ? {
            ...second,
            route: { ...second.route!, reason: `fallback: ${cause}` },
          }
        : undefined;
    },
    invoke: async () => ({}),
    finalize: async (reply) => {
      const answer = { reply };
      session.state.answer = answer;
      return answer;
    },
    save: async () => {},
  };
  try {
    const result = await runtime
      .execute({
        runId: "TEST-fallback-" + failFirst,
        threadId: "TEST-fallback-thread-" + failFirst,
        resourceId: "TEST-fallback-resource",
        memoryMode: "none",
        text: "TEST question",
        signal: new AbortController().signal,
        definitions: [],
        session,
        createModel: (selected, guard) =>
          createNiaroMastraModel(selected, transport, guard),
        onEvent: (event) => {
          events.push(event);
        },
      })
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    return { result, sent, events, asked };
  } finally {
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("a model refused by its provider's daily limit before dispatch moves to the next model", async () => {
  const { result, sent, events } = await run("limit");
  assert("value" in result, "the run answers");
  assert.match(result.value.text, /TEST answer from test\/second/);
  assert.deepEqual(sent, ["test/second"]);
  const steps = events.filter((event) => event.type.startsWith("model-"));
  assert.deepEqual(steps, [
    {
      type: "model-start",
      model: "test/first",
      role: "chat",
      reason: "primary",
    },
    { type: "model-end", failed: true },
    {
      type: "model-start",
      model: "test/second",
      role: "chat",
      reason: "fallback: provider_limit",
    },
    { type: "model-end" },
  ]);
});

test("a connection that failed before the request left moves to the next model", async () => {
  const { result, sent, events } = await run("unsent");
  assert("value" in result);
  assert.deepEqual(sent, ["test/second"]);
  assert(
    events.some(
      (event) =>
        event.type === "model-start" &&
        event.reason === "fallback: connection_failed",
    ),
  );
});

test("a call that reached its provider is never repeated on another model", async () => {
  const { result, sent, asked } = await run("timeout");
  assert("error" in result, "the run fails instead of moving on");
  assert.deepEqual(sent, ["test/first"]);
  assert.equal(asked.length, 1);
  assert.equal(notDispatchedCause(asked[0]), undefined);
});
