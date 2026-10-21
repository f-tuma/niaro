import assert from "node:assert/strict";
import { test } from "node:test";
import { IdentityError } from "../apps/server-identity/error";
import type { CatalogRuntime } from "../apps/server-identity/catalog-runtime";
import type { IntegrationTransport } from "../apps/server-integrations/transport";
import { createTrustHarness, toolResults } from "./agent-trust/harness";

const isCode = (code: string) => (error: unknown) =>
  error instanceof IdentityError && error.code === code;

test("new commands use native Mastra even when historical planner selection remains configured", async () => {
  const h = createTrustHarness();
  try {
    const routing = h.catalog.inventory(
      h.target.organizationId,
      h.target.workspaceId,
      {
        userId: h.scope.userId,
        role: "owner",
      },
    ).routing;
    h.command({
      type: "saveRouting",
      routing: {
        ...routing,
        planner: "jev",
        decision: { ...routing.decision, enabled: false },
      },
    });
    h.onChat(() => ({ content: "TEST native reply" }));
    const result = await h.send("TEST new native command", {
      id: "TEST-native-default",
    });
    assert.equal(result.status, "accepted");
    const state = h.commandState();
    assert.equal(state.kind, "mastra-1");
    for (const property of ["transcript", "carried", "pendingCalls", "paused"])
      assert(
        !(property in state),
        `New domain journals must not own ${property}`,
      );
    const messages = await h.nativeMessages(state.threadId);
    assert(messages.some((message) => message.role === "assistant"));
    assert(h.requests.some((request) => request.messages));
  } finally {
    await h.close();
  }
});

test("cached plain answers revalidate the memory version before returning", async () => {
  const h = createTrustHarness();
  try {
    const note = await h.memoryStore.remember(h.memoryActor, {
      requestId: "TEST-cached-memory-note",
      content: "TEST forgotten preference",
      kind: "preference",
      source: { type: "user_note" },
      explicitIntent: true,
      settings: h.memorySettings,
    });
    h.onChat(() => ({ content: "TEST forgotten preference" }));
    const runtime = h.runtime();
    const input: Parameters<CatalogRuntime["message"]> = [
      "TEST-cached-answer",
      "TEST request",
      "en",
      [],
      new AbortController().signal,
    ];
    assert.equal(
      (await runtime.message(...input))?.reply,
      "TEST forgotten preference",
    );
    await h.memoryStore.forget(h.memoryActor, {
      requestId: "TEST-forget-cached",
      id: note.id,
      revision: note.revision,
    });
    const requests = h.requests.length;
    await assert.rejects(
      runtime.message(...input),
      isCode("memory_context_changed"),
    );
    assert.equal(h.requests.length, requests);
  } finally {
    await h.close();
  }
});

test("a committed read lost before source projection still blocks inference after source expiry", async () => {
  const h = createTrustHarness();
  try {
    h.onChat(h.lookupScript);
    const abort = new AbortController();
    const invoke = h.controller.invoke.bind(h.controller);
    h.controller.invoke = async (...args) => {
      await invoke(...args);
      const error = new Error("TEST lost read return");
      abort.abort(error);
      throw error;
    };
    const runtime = h.runtime();
    const input: Parameters<CatalogRuntime["message"]> = [
      "TEST-lost-read",
      "Find Jane Test",
      "en",
      [],
      abort.signal,
    ];
    await assert.rejects(runtime.message(...input), /TEST lost read return/);
    const state = h.commandState();
    assert.equal(state.sources.length, 0);
    const receipt = h.catalog.invocation(
      state.operations[0]!,
      h.scope.workspaceId,
      h.scope.userId,
    )!;
    assert.equal(receipt.status, "succeeded");
    h.catalog.saveInvocation({
      ...receipt,
      completedAt: Date.now() - 31 * 60 * 1000,
    });
    h.controller.invoke = invoke;
    input[4] = new AbortController().signal;
    const requests = h.requests.length;
    await assert.rejects(runtime.message(...input), isCode("catalog_conflict"));
    assert.equal(h.requests.length, requests);
    assert.equal(h.network.length, 1);
  } finally {
    await h.close();
  }
});

test("same pending question accepts one authenticated continuation and rejects a concurrent resume", async () => {
  const h = createTrustHarness();
  let release!: () => void;
  try {
    h.onChat((body) =>
      toolResults(body).some((result) => result.answered === true)
        ? { content: "TEST answer accepted" }
        : h.call("ask_user", { question: "Which name?" }),
    );
    await h.send("TEST ask a name", { id: "TEST-native-question" });
    const original = h.commandState();
    assert.equal(original.pending?.kind, "question");
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transport = h.controller.transport;
    const gated: IntegrationTransport = async (request) => {
      if (request.url.endsWith("/chat/completions")) {
        entered();
        await wait;
      }
      return transport(request);
    };
    Object.defineProperty(h.controller, "transport", { value: gated });
    const runtime = h.runtime();
    const first = runtime.message(
      "TEST-native-answer-1",
      "Jane Test",
      "en",
      [],
      new AbortController().signal,
      undefined,
      undefined,
      "UTC",
      { conversationId: "conversation-1" },
    );
    await Promise.race([
      started,
      first.then((answer) => {
        throw new Error(
          "Continuation returned before gated inference: " +
            JSON.stringify({ answer, conversationId: original.conversationId }),
        );
      }),
    ]);
    await assert.rejects(
      runtime.message(
        "TEST-native-answer-2",
        "Another Name",
        "en",
        [],
        new AbortController().signal,
        undefined,
        undefined,
        "UTC",
        { conversationId: "conversation-1" },
      ),
      isCode("catalog_busy"),
    );
    release();
    assert.equal((await first)?.reply, "TEST answer accepted");
    const continued = h.commandState();
    assert.equal(continued.runId, original.runId);
    assert.equal(continued.threadId, original.threadId);
    assert(
      continued.aliases.some(
        (alias) => alias.commandId === "TEST-native-answer-1",
      ),
    );
    assert(
      !continued.aliases.some(
        (alias) => alias.commandId === "TEST-native-answer-2",
      ),
    );
    const requests = h.requests.length;
    assert.equal(
      (
        await runtime.message(
          "TEST-native-answer-1",
          "Jane Test",
          "en",
          [],
          new AbortController().signal,
          undefined,
          undefined,
          "UTC",
          { conversationId: "conversation-1" },
        )
      )?.reply,
      "TEST answer accepted",
    );
    assert.equal(h.requests.length, requests);
  } finally {
    release?.();
    await h.close();
  }
});

test("the final service dispatch rechecks a read whose source projection was lost", async () => {
  const h = createTrustHarness({ writeApproval: "never" });
  try {
    const invoke = h.controller.invoke.bind(h.controller);
    h.controller.invoke = async (...args) => {
      const result = await invoke(...args);
      if (result.effect === "read")
        throw new Error("TEST lost source projection");
      return result;
    };
    h.onChat((body) => {
      if (
        !toolResults(body).some(
          (result) => result.currentTurn && result.data?.contacts,
        )
      )
        return h.lookupScript(body);
      return h.writeScript(body);
    });
    h.onBeforeActionDispatch(() => {
      if (h.network.length !== 1) return;
      const state = h.commandState();
      assert.equal(state.sources.length, 0);
      const read = state.operations
        .map((id) =>
          h.catalog.invocation(id, h.scope.workspaceId, h.scope.userId),
        )
        .find(
          (receipt) =>
            receipt?.effect === "read" && receipt.status === "succeeded",
        )!;
      h.catalog.saveInvocation({
        ...read,
        completedAt: Date.now() - 31 * 60 * 1000,
      });
    });
    const answer = await h.send("Find Jane Test then create a meeting", {
      id: "TEST-read-dispatch-guard",
    });
    assert.equal(answer.status, "conflict");
    assert.equal(answer.code, "revision_conflict");
    assert.equal(h.network.length, 1);
    assert.equal(h.network[0]?.path, "/v1/contacts");
    const state = h.commandState();
    const write = state.operations
      .map((id) =>
        h.catalog.invocation(id, h.scope.workspaceId, h.scope.userId),
      )
      .find((receipt) => receipt?.effect === "write");
    assert.equal(write?.status, "failed");
  } finally {
    await h.close();
  }
});

for (const outcome of ["success", "lost"] as const)
  test(`recorded ${outcome} write survives terminal native checkpoint loss without a fresh model or effect`, async () => {
    const abort = new AbortController();
    const h = createTrustHarness({
      writeApproval: "never",
      signal: abort.signal,
    });
    try {
      h.writeResponse = outcome;
      h.onChat(h.writeScript);
      const original = h.controller.invoke.bind(h.controller);
      h.controller.invoke = async (...args) => {
        await original(...args);
        const error = new Error("TEST lost after receipt");
        abort.abort(error);
        throw error;
      };
      await assert.rejects(
        h.send("Create a meeting with Jane Test", {
          id: "TEST-passive-effect",
        }),
        /TEST lost after receipt/,
      );
      const state = h.commandState();
      assert(state.requestHash);
      assert(!state.answer);
      const receipt = h.catalog.invocation(
        state.operations[0]!,
        h.scope.workspaceId,
        h.scope.userId,
      )!;
      assert.equal(
        receipt.status,
        outcome === "success" ? "succeeded" : "unknown",
      );
      await h.restart();
      const requests = h.requests.length;
      const recovered = await h.runtime().recoverResult!({
        commandId: "TEST-passive-effect",
        text: "Create a meeting with Jane Test",
        language: "en",
        requestHash: state.requestHash,
      });
      assert.equal(recovered?.result?.operationId, receipt.id);
      assert.equal(recovered?.result?.status, receipt.status);
      assert.match(recovered!.reply, /remaining task is unconfirmed/);
      assert.equal(h.requests.length, requests);
      assert.equal(h.network.length, 1);
      await assert.rejects(
        h.runtime().recoverResult!({
          commandId: "TEST-passive-effect",
          text: "Create a meeting with Jane Test",
          language: "en",
          requestHash: "TEST-other-binding",
        }),
        isCode("catalog_conflict"),
      );
    } finally {
      await h.close();
    }
  });
