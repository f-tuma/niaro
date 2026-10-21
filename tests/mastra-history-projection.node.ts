import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import type { MastraDBMessage } from "@mastra/core/agent/message-list";
import { DurableStepIds } from "@mastra/core/agent/durable";
import { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import { createTrustHarness, type ModelRequest } from "./agent-trust/harness";

function checkpointMessages(value: unknown): MastraDBMessage[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(checkpointMessages);
  return Object.entries(value).flatMap(([key, nested]) => {
    if (
      key === "messageListState" &&
      nested &&
      typeof nested === "object" &&
      "messages" in nested &&
      Array.isArray(nested.messages)
    )
      return nested.messages as MastraDBMessage[];
    return checkpointMessages(nested);
  });
}

test("valid thread authority still projects unmarked legacy native rows without losing call/result pairs or public conversation", async () => {
  const h = createTrustHarness();
  let storage: LibSQLStore | undefined;
  try {
    h.onChat(() => ({ content: "TEST ordinary public greeting" }));
    await h.send("TEST hello", { id: "TEST-projection-public" });
    const state = h.commandState();
    assert.equal(state.threadAuthority?.version, 1);
    const resourceId = createHash("sha256")
      .update(
        JSON.stringify([
          h.scope.serverId,
          h.target.organizationId,
          h.scope.workspaceId,
          h.scope.userId,
        ]),
      )
      .digest("hex");
    storage = new LibSQLStore({
      id: "TEST-history-injector",
      url: h.catalog.nativeStorageUrl,
    });
    await storage.init();
    const memory = new Memory({
      storage,
      options: { semanticRecall: false, workingMemory: { enabled: false } },
    });
    const now = Date.now();
    const callId = randomUUID();
    const sentinel = "TEST-private-legacy@example.test";
    const invocation = {
      state: "result" as const,
      toolCallId: callId,
      toolName: h.tool("Create meeting"),
      args: { body: { attendee: sentinel } },
      rawInput: sentinel,
      result: {
        operationId: "a".repeat(64),
        status: "succeeded",
        effect: "write",
        data: { email: sentinel },
      },
    };
    const messages: MastraDBMessage[] = [
      {
        id: randomUUID(),
        role: "user",
        threadId: state.threadId,
        resourceId,
        createdAt: new Date(now),
        content: {
          format: 2,
          parts: [{ type: "text", text: "TEST historical task" }],
        },
      },
      {
        id: randomUUID(),
        role: "assistant",
        threadId: state.threadId,
        resourceId,
        createdAt: new Date(now + 1),
        content: {
          format: 2,
          content: sentinel,
          reasoning: sentinel,
          toolInvocations: [invocation],
          parts: [
            {
              type: "reasoning",
              reasoning: sentinel,
              details: [{ type: "text", text: sentinel }],
            },
            { type: "text", text: sentinel },
            { type: "tool-invocation", toolInvocation: invocation },
          ],
        },
      },
    ];
    await memory.saveMessages({ messages });
    await memory.settled();
    await storage.close();
    storage = undefined;
    let captured: ModelRequest | undefined;
    h.onChat((body) => {
      captured = structuredClone(body);
      return { content: "TEST new ordinary reply" };
    });
    await h.send("TEST explain an ordinary triangle", {
      id: "TEST-projection-next",
    });
    assert.equal(
      h.commandState().threadId,
      state.threadId,
      "Valid business authority must reuse the actual seeded native thread",
    );
    assert(captured?.messages);
    assert(!JSON.stringify(captured).includes(sentinel));
    assert(
      captured.messages.some((message) =>
        message.content?.includes("TEST ordinary public greeting"),
      ),
      "Server-stamped public assistant history remains available",
    );
    const call = captured.messages
      .flatMap((message) => message.tool_calls ?? [])
      .find((call) => call.id === callId);
    assert(call, "Projection must retain the historical native tool call ID");
    assert.deepEqual(JSON.parse(call.function.arguments), {});
    const result = captured.messages.find(
      (message) => message.role === "tool" && message.tool_call_id === callId,
    );
    assert(result, "Projection must retain the exact paired result ID");
    assert.deepEqual(JSON.parse(result.content!), {
      operationId: "a".repeat(64),
      status: "succeeded",
      effect: "write",
      toolResult: true,
    });
    assert.equal(h.network.length, 0);
  } finally {
    await storage?.close();
    await h.close();
  }
});

test("opaque native transcript and checkpoint history preserve the original guarded approval input and call ID", async () => {
  const h = createTrustHarness();
  let storage: LibSQLStore | undefined;
  try {
    h.onChat(h.writeScript);
    await h.send("Create a meeting with Jane Test", {
      id: "TEST-projection-approval",
    });
    const state = h.commandState();
    assert.equal(state.pending?.kind, "approval");
    const callId = state.pending!.toolCallId;
    const invocation = (await h.nativeInvocations(state.threadId)).find(
      (call) => call.toolCallId === callId,
    )!;
    assert(invocation);
    assert.deepEqual(invocation.args, {});
    assert.equal(invocation.rawInput, undefined);
    assert.equal(h.network.length, 0);
    storage = new LibSQLStore({
      id: "TEST-checkpoint-reader",
      url: h.catalog.nativeStorageUrl,
    });
    await storage.init();
    const workflows = await storage.getStore("workflows");
    const row = await workflows!.getWorkflowRunById({
      workflowName: DurableStepIds.AGENTIC_LOOP,
      runId: state.runId,
    });
    assert(row);
    const snapshot =
      typeof row.snapshot === "string"
        ? JSON.parse(row.snapshot)
        : row.snapshot;
    const executionRow = await workflows!.getWorkflowRunById({
      workflowName: DurableStepIds.AGENTIC_EXECUTION,
      runId: state.runId,
    });
    const executionSnapshot =
      typeof executionRow?.snapshot === "string"
        ? JSON.parse(executionRow.snapshot)
        : executionRow?.snapshot;
    const checkpointCalls = [snapshot, executionSnapshot]
      .flatMap(checkpointMessages)
      .flatMap((message) => message.content.parts)
      .filter(
        (part) =>
          part.type === "tool-invocation" &&
          part.toolInvocation.toolCallId === callId,
      );
    assert(
      checkpointCalls.length > 0,
      "Native checkpoint must retain the suspended call's transcript identity",
    );
    for (const checkpointCall of checkpointCalls) {
      assert(checkpointCall.type === "tool-invocation");
      assert.deepEqual(checkpointCall.toolInvocation.args, {});
      assert.equal(checkpointCall.toolInvocation.rawInput, undefined);
    }
    await storage.close();
    storage = undefined;
    await h.restart();
    const completed = await h
      .runtime()
      .resolve(
        state.pending!.operationId!,
        true,
        "en",
        new AbortController().signal,
      );
    assert.equal(completed?.result?.status, "succeeded");
    assert.deepEqual(h.network, [
      {
        path: "/v1/meetings",
        body: {
          attendee: "jane@example.test",
          start: "2026-10-01T12:00:00Z",
          end: "2026-10-01T12:30:00Z",
        },
      },
    ]);
    const resumed = (await h.nativeInvocations(state.threadId)).find(
      (call) => call.toolCallId === callId,
    )!;
    assert.equal(resumed.state, "result");
    assert.deepEqual(resumed.args, {});
  } finally {
    await storage?.close();
    await h.close();
  }
});
