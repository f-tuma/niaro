import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
// eslint-disable-next-line import/no-unresolved -- Official SDK export-map subpath.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
// eslint-disable-next-line import/no-unresolved -- Official SDK export-map subpath.
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SnapshotSchema } from "../packages/protocol";
import { CARD_PROFILE } from "../packages/protocol/card-document";
import { OrganizationDetailSchema } from "../packages/protocol/identity";
import { coordinatorHttpFixture } from "./helpers/process-coordinator-http";
import { askQuestion } from "./helpers/process-questions-runtime";
import { toolResults, type ModelRequest } from "./agent-trust/harness";

type Fixture = Awaited<ReturnType<typeof coordinatorHttpFixture>>;
const fixture = coordinatorHttpFixture({ allowOrdinaryRuntime: true }).then(
  async (h) => {
    const routing = h.identity["catalog"].store.routing(h.target.workspaceId);
    await h.catalog({
      type: "saveRouting",
      routing: { ...routing, modelId: h.modelId },
    });
    return h;
  },
);
after(async () => {
  await (await fixture).close();
});
type TaskView = {
  taskId: string;
  conversationId: string;
  revision: number;
  status: string;
  reply: string;
  cancellationRequested?: boolean;
  nextInput?: {
    kind: string;
    inputId?: string;
    expectedRevision?: number;
    question?: string;
    url?: string;
    operationId?: string;
  };
};

async function issue(
  h: Fixture,
  role: "owner" | "member" = "owner",
  workspaceId = h.target.workspaceId,
  scopes: ("native.view" | "native.run")[] = ["native.view", "native.run"],
) {
  const result = await h.request(role, "api/identity/mcp/access/issue", {
    workspaceId,
    label: "TEST MCP HTTP client",
    scopes,
    expiresAt: Date.now() + 3_600_000,
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const data = h.record(result.data);
  assert.equal(typeof data.accessToken, "string");
  return {
    accessToken: data.accessToken as string,
    grantId: String(h.record(data.grant).id),
  };
}

async function connect(h: Fixture, token: string, requestFetch?: typeof fetch) {
  const client = new Client({ name: "TEST Niaro MCP client", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(h.origin + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + token } },
      ...(requestFetch ? { fetch: requestFetch } : {}),
    }),
  );
  return client;
}

async function task(
  client: Client,
  name: string,
  input: Record<string, unknown>,
) {
  const result = await client.callTool({ name, arguments: input });
  assert.equal(result.isError ?? false, false, JSON.stringify(result));
  assert(
    result.structuredContent && typeof result.structuredContent === "object",
  );
  const view = result.structuredContent as TaskView;
  assert.equal(typeof view.taskId, "string");
  assert.equal(typeof view.conversationId, "string");
  assert.equal(typeof view.status, "string");
  return view;
}

async function failed(
  client: Client,
  name: string,
  input: Record<string, unknown>,
  code: string,
) {
  const result = await client.callTool({ name, arguments: input });
  assert.equal(result.isError, true, JSON.stringify(result));
  const structured = result.structuredContent as { error: { code: string } };
  assert.equal(structured.error.code, code, JSON.stringify(result));
  return result;
}

async function settled(client: Client, taskId: string, status: string) {
  const deadline = Date.now() + 15_000;
  let view: TaskView;
  do {
    view = await task(client, "task_get", { taskId, waitMs: 1_000 });
    if (view.status === status) return view;
    assert(
      !["failed", "expired", "superseded"].includes(view.status),
      JSON.stringify(view),
    );
    await delay(20);
  } while (Date.now() < deadline);
  assert.fail(
    "TEST task did not reach " + status + ": " + JSON.stringify(view),
  );
}

const toolCall = (name: string, input: object) => ({
  content: null,
  tool_calls: [
    {
      id: randomUUID(),
      type: "function",
      function: { name, arguments: JSON.stringify(input) },
    },
  ],
});

function configureWrite(h: Fixture) {
  const service = h.identity["catalog"].store.service(
    h.target.workspaceId,
    h.serviceId,
  );
  const actionName = "action_" + h.writeId.replaceAll("-", "_");
  h.onModel((body: ModelRequest) => {
    if (
      toolResults(body).some(
        (result) =>
          result.currentTurn &&
          result.effect === "write" &&
          result.status === "succeeded",
      )
    )
      return { content: "TEST approved MCP service result" };
    if (!body.tools?.some((tool) => tool.function.name === actionName))
      return toolCall("find_actions", {
        service: service.name,
        need: "TEST confirmed write",
      });
    return toolCall(actionName, { name: "TEST MCP item" });
  });
}

test(
  "real MCP SDK client replays lost admission acknowledgements and reads native tasks after restart with current account authorization",
  { timeout: 60_000 },
  async () => {
    const h = await fixture;
    const clients: Client[] = [];
    try {
      h.onModel(() => ({ content: "TEST native MCP reply" }));
      const grant = await issue(h);
      let loseAcknowledgement = true;
      const requestFetch: typeof fetch = async (url, init) => {
        const response = await fetch(url, init);
        const message =
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        if (
          loseAcknowledgement &&
          message?.method === "tools/call" &&
          message.params?.name === "task_submit"
        ) {
          loseAcknowledgement = false;
          await response.text();
          throw Error("TEST lost MCP acknowledgement");
        }
        return response;
      };
      const lossy = await connect(h, grant.accessToken, requestFetch);
      clients.push(lossy);
      const input = {
        requestId: "TEST-submit-lost",
        text: "TEST prepare a reply",
        language: "en",
      };
      await assert.rejects(
        lossy.callTool({ name: "task_submit", arguments: input }),
        /TEST lost MCP acknowledgement/,
      );
      const client = await connect(h, grant.accessToken);
      clients.push(client);
      assert.deepEqual(
        (await client.listTools()).tools.map((tool) => tool.name),
        ["task_submit", "task_get", "task_respond", "task_cancel"],
      );
      const replay = await task(client, "task_submit", input);
      const completed = await settled(client, replay.taskId, "succeeded");
      assert.match(completed.reply, /TEST native MCP reply/);
      const modelCalls = h.modelCount();
      assert.equal(modelCalls, 1);
      await h.restart();
      const reopened = await task(client, "task_get", {
        taskId: replay.taskId,
      });
      assert.equal(reopened.status, "succeeded");
      assert.equal(reopened.conversationId, completed.conversationId);
      assert.equal(
        (await task(client, "task_submit", input)).taskId,
        replay.taskId,
      );
      await failed(
        client,
        "task_submit",
        { ...input, text: "TEST changed request" },
        "mcp_idempotency_conflict",
      );
      assert.equal(h.modelCount(), modelCalls);

      const mobileCredential = await h.pair("owner");
      const snapshot = await h.mobile(
        mobileCredential,
        "snapshot?cards=" +
          encodeURIComponent(CARD_PROFILE) +
          "&conversationId=" +
          encodeURIComponent(completed.conversationId),
      );
      assert.equal(snapshot.status, 200, JSON.stringify(snapshot.data));
      const conversation = SnapshotSchema.parse(
        snapshot.data,
      ).conversations.find((chat) => chat.id === completed.conversationId);
      assert(conversation, JSON.stringify(snapshot.data));
      assert(
        conversation.messages.some(
          (message) =>
            message.role === "assistant" &&
            message.text.includes("TEST native MCP reply"),
        ),
        JSON.stringify(conversation),
      );

      const otherGrant = await issue(h, "member");
      const other = await connect(h, otherGrant.accessToken);
      clients.push(other);
      const hidden = await failed(
        other,
        "task_get",
        { taskId: replay.taskId },
        "mcp_task_not_found",
      );
      assert(!JSON.stringify(hidden).includes(completed.conversationId));
      assert(!JSON.stringify(hidden).includes("TEST native MCP reply"));

      const created = await h.request("owner", "api/identity/command", {
        organizationId: h.target.organizationId,
        type: "createWorkspace",
        name: "TEST other MCP workspace",
      });
      assert.equal(created.status, 200);
      const detail = OrganizationDetailSchema.parse(
        (
          await h.request(
            "owner",
            "api/identity/organization?id=" + h.target.organizationId,
          )
        ).data,
      );
      const otherWorkspace = detail.workspaces.find(
        (workspace) => workspace.id !== h.target.workspaceId,
      );
      assert(otherWorkspace);
      const workspaceGrant = await issue(h, "owner", otherWorkspace.id);
      const workspaceClient = await connect(h, workspaceGrant.accessToken);
      clients.push(workspaceClient);
      await failed(
        workspaceClient,
        "task_get",
        { taskId: replay.taskId },
        "mcp_task_not_found",
      );

      const noBearer = await h.request("owner", "../mcp", {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      });
      assert.equal(noBearer.status, 401);
      const mobileBearer = await fetch(h.origin + "/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + mobileCredential.accessToken,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      assert.equal(mobileBearer.status, 401);
      const revoke = await h.request(
        "owner",
        "api/identity/mcp/access/revoke",
        { workspaceId: h.target.workspaceId, grantId: grant.grantId },
      );
      assert.equal(revoke.status, 200, JSON.stringify(revoke.data));
      const revokedHttp = await fetch(h.origin + "/mcp", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + grant.accessToken,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      assert.equal(revokedHttp.status, 401);
      await assert.rejects(
        client.callTool({
          name: "task_get",
          arguments: { taskId: replay.taskId },
        }),
      );
      assert.equal(h.modelCount(), modelCalls);
      assert.deepEqual(h.dispatches, []);
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()));
    }
  },
);

test(
  "real MCP answers the persisted native question with exact revision and cancellation prevents another answer",
  { timeout: 60_000 },
  async () => {
    const h = await fixture;
    let client: Client | undefined;
    try {
      let answer = false;
      h.onModel(() =>
        answer
          ? { content: "TEST original MCP task completed" }
          : askQuestion("TEST which day?"),
      );
      const grant = await issue(h);
      client = await connect(h, grant.accessToken);
      const submitted = await task(client, "task_submit", {
        requestId: "TEST-question",
        text: "TEST ask which day",
        language: "en",
      });
      const pending = await settled(client, submitted.taskId, "waiting_input");
      assert.equal(pending.nextInput?.kind, "question");
      assert.equal(pending.nextInput.question, "TEST which day?");
      const response = {
        taskId: pending.taskId,
        requestId: "TEST-answer",
        inputId: pending.nextInput.inputId!,
        expectedRevision: pending.nextInput.expectedRevision!,
        text: "Tomorrow, please.",
      };
      const modelCalls = h.modelCount();
      await h.restart();
      const reopened = await task(client, "task_get", {
        taskId: pending.taskId,
      });
      assert.deepEqual(reopened.nextInput, pending.nextInput);
      await failed(
        client,
        "task_respond",
        {
          ...response,
          requestId: "TEST-stale",
          expectedRevision: response.expectedRevision + 1,
        },
        "mcp_input_changed",
      );
      await failed(
        client,
        "task_respond",
        {
          ...response,
          requestId: "TEST-wrong-input",
          inputId: "TEST-other-input",
        },
        "mcp_input_changed",
      );
      assert.equal(h.modelCount(), modelCalls);
      answer = true;
      assert.equal(
        (await task(client, "task_respond", response)).taskId,
        pending.taskId,
      );
      const completed = await settled(client, pending.taskId, "succeeded");
      assert.match(completed.reply, /TEST original MCP task completed/);
      assert.equal(completed.conversationId, pending.conversationId);
      assert.equal(h.modelCount(), modelCalls + 1);
      await task(client, "task_respond", response);
      assert.equal(h.modelCount(), modelCalls + 1);

      answer = false;
      const second = await task(client, "task_submit", {
        requestId: "TEST-cancel-question",
        text: "TEST ask another day",
        language: "en",
      });
      const cancellable = await settled(client, second.taskId, "waiting_input");
      const cancellation = {
        taskId: cancellable.taskId,
        requestId: "TEST-cancel",
      };
      const cancelled = await task(client, "task_cancel", cancellation);
      assert.equal(cancelled.cancellationRequested, true);
      assert.equal(cancelled.status, "cancelled");
      const callsAfterCancellation = h.modelCount();
      await task(client, "task_cancel", cancellation);
      await failed(
        client,
        "task_respond",
        {
          taskId: cancellable.taskId,
          requestId: "TEST-answer-cancelled",
          inputId: cancellable.nextInput!.inputId!,
          expectedRevision: cancellable.nextInput!.expectedRevision!,
          text: "Friday",
        },
        "mcp_input_changed",
      );
      assert.equal(h.modelCount(), callsAfterCancellation);
      assert.deepEqual(h.dispatches, []);
    } finally {
      await client?.close();
    }
  },
);

test(
  "real MCP exposes native service approval for a person and cannot approve through task_respond",
  { timeout: 60_000 },
  async () => {
    const h = await fixture;
    let client: Client | undefined;
    try {
      configureWrite(h);
      const grant = await issue(h);
      client = await connect(h, grant.accessToken);
      const submitted = await task(client, "task_submit", {
        requestId: "TEST-approval",
        text: "TEST create one confirmed item",
        language: "en",
      });
      const approval = await settled(
        client,
        submitted.taskId,
        "waiting_approval",
      );
      assert.equal(approval.nextInput?.kind, "human_approval");
      assert.match(
        approval.nextInput.url ?? "",
        /^http:\/\/127\.0\.0\.1:\d+\/admin\//,
      );
      assert.deepEqual(h.dispatches, []);
      const modelCalls = h.modelCount();
      await failed(
        client,
        "task_respond",
        {
          taskId: approval.taskId,
          requestId: "TEST-forged-approval",
          inputId: approval.nextInput.operationId!,
          expectedRevision: approval.revision,
          text: "Approved",
        },
        "mcp_input_changed",
      );
      assert.deepEqual(h.dispatches, []);
      assert.equal(h.modelCount(), modelCalls);

      await h.restart();
      assert.equal(
        (await task(client, "task_get", { taskId: approval.taskId })).status,
        "waiting_approval",
      );
      const credential = await h.pair("owner");
      const snapshot = await h.mobile(
        credential,
        "snapshot?cards=" + encodeURIComponent(CARD_PROFILE),
      );
      assert.equal(snapshot.status, 200, JSON.stringify(snapshot.data));
      const work = SnapshotSchema.parse(snapshot.data).workItems.find(
        (item) => item.conversationId === approval.conversationId,
      );
      assert(work?.native?.action?.operationId);
      const confirmed = await h.mobile(credential, "commands", {
        type: "service.resolve",
        commandId: "TEST-person-approval",
        idempotencyKey: "TEST-person-approval",
        conversationId: work.conversationId,
        workItemId: work.id,
        expectedWorkRevision: work.revision,
        operationId: work.native.action.operationId,
        approved: true,
        language: "en",
      });
      assert.equal(confirmed.status, 202, JSON.stringify(confirmed.data));
      assert.deepEqual(h.dispatches, ["POST"]);
      const completed = await settled(client, approval.taskId, "succeeded");
      assert.match(completed.reply, /TEST approved MCP service result/);
      await h.restart();
      assert.equal(
        (await task(client, "task_get", { taskId: approval.taskId })).status,
        "succeeded",
      );
      assert.deepEqual(h.dispatches, ["POST"]);
    } finally {
      await client?.close();
    }
  },
);

test(
  "MCP human approval link uses browser identity and a canonical current revision with idempotent native execution",
  { timeout: 60_000 },
  async () => {
    const h = await fixture;
    let client: Client | undefined;
    try {
      configureWrite(h);
      const grant = await issue(h);
      client = await connect(h, grant.accessToken);
      const effects = [...h.dispatches];
      const submitted = await task(client, "task_submit", {
        requestId: "TEST-browser-approval",
        text: "TEST create an item for browser approval",
        language: "en",
      });
      const approval = await settled(
        client,
        submitted.taskId,
        "waiting_approval",
      );
      const get = {
        workspaceId: h.target.workspaceId,
        taskId: approval.taskId,
      };
      assert.equal(
        (await h.request("anonymous", "api/identity/mcp/task/get", get)).status,
        401,
      );
      assert.equal((await h.loginOperator()).status, 200);
      assert.equal(
        (await h.request("operator", "api/identity/mcp/task/get", get)).status,
        403,
      );
      assert.equal(
        (await h.request("member", "api/identity/mcp/task/get", get)).status,
        404,
      );
      const machine = await fetch(
        h.origin + "/admin/api/identity/mcp/task/get",
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + grant.accessToken,
            Origin: h.origin,
            "X-Agent-Admin": "1",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(get),
        },
      );
      assert.equal(machine.status, 401);
      const page = await fetch(approval.nextInput!.url!);
      assert.equal(page.status, 200);
      assert.match(page.headers.get("content-type") ?? "", /text\/html/);
      assert.deepEqual(h.dispatches, effects);

      await h.restart();
      const human = await h.request("owner", "api/identity/mcp/task/get", get);
      assert.equal(human.status, 200, JSON.stringify(human.data));
      const next = h.record(h.record(human.data).nextInput);
      const decision = {
        ...get,
        requestId: "TEST-browser-decision",
        input: {
          operationId: next.operationId,
          expectedRevision: next.expectedRevision,
        },
        approved: true,
      };
      const stale = await h.request("owner", "api/identity/mcp/task/decide", {
        ...decision,
        requestId: "TEST-browser-stale",
        input: {
          ...decision.input,
          expectedRevision: Number(next.expectedRevision) + 1,
        },
      });
      assert.equal(stale.status, 409, JSON.stringify(stale.data));
      assert.deepEqual(h.dispatches, effects);
      const approved = await h.request(
        "owner",
        "api/identity/mcp/task/decide",
        decision,
      );
      assert.equal(approved.status, 202, JSON.stringify(approved.data));
      await settled(client, approval.taskId, "succeeded");
      assert.deepEqual(h.dispatches, [...effects, "POST"]);
      const modelCalls = h.modelCount();
      assert.equal(
        (await h.request("owner", "api/identity/mcp/task/decide", decision))
          .status,
        202,
      );
      assert.equal(h.modelCount(), modelCalls);
      await h.restart();
      assert.equal(
        (await task(client, "task_get", { taskId: approval.taskId })).status,
        "succeeded",
      );
      assert.deepEqual(h.dispatches, [...effects, "POST"]);
    } finally {
      await client?.close();
    }
  },
);
