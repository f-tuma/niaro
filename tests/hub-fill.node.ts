import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { CatalogCommand } from "../packages/protocol/service-catalog";
import {
  HUB_FILL_LIMITS,
  createHubFillAccess,
  hubReadableServices,
  runHubFill,
  type HubFillInput,
} from "../apps/server-identity/hub-fill";
import { ServiceOAuthStore } from "../apps/server-identity/service-oauth";
import { ServiceCatalogStore } from "../apps/server-identity/service-catalog";
import { IdentityError } from "../apps/server-identity/error";
import type { InferenceRunCaps } from "../apps/server-identity/inference-budget";
import {
  ServiceStatus,
  createTrustHarness,
  type ModelRequest,
  type TrustHarness,
} from "./agent-trust/harness";
import { processObject } from "./helpers/service-process";

/*
 * The AI fill of an overview widget, end to end with real catalog stores,
 * the real controller and durable receipts, a real inference ledger and a
 * synthetic model and service transport (no paid model, no live service).
 */
const code = (value: string) => (error: unknown) =>
  error instanceof IdentityError && error.code === value;
type Message = NonNullable<ModelRequest["messages"]>[number] & {
  content?: unknown;
  tool_call_id?: string;
};
const messages = (body: ModelRequest) => (body.messages ?? []) as Message[];
const toolOutputs = (body: ModelRequest) =>
  messages(body)
    .filter((message) => message.role === "tool")
    .map(
      (message) => JSON.parse(String(message.content)) as Record<string, any>,
    );
const isCollect = (body: ModelRequest) => !!body.tools?.length;

function setup(h: TrustHarness, caps?: InferenceRunCaps) {
  const selected = h.catalog.resolveModel(
    h.target.organizationId,
    h.target.workspaceId,
  )!;
  const actions = h.catalog.service(
    h.target.workspaceId,
    h.catalog
      .inventory(h.target.organizationId, h.target.workspaceId, {
        userId: h.scope.userId,
        role: "owner",
      })
      .services.find(
        (service) => service.name === "TEST Calendar and contacts",
      )!.id,
  ).actions;
  const readId = actions.find((action) => action.effect === "read")!.id;
  const writeId = actions.find((action) => action.effect === "write")!.id;
  let runs = 0;
  // Every fill is its own budget root.
  const fill = (input: Partial<HubFillInput> = {}) => {
    const runId = `hub-fill/TEST/${randomUUID()}/${++runs}`;
    return {
      runId,
      result: runHubFill(
        createHubFillAccess({
          controller: h.controller,
          context: h.context,
          target: h.target,
          selected,
          userId: h.scope.userId,
          runId,
          check: () => {},
          ...(caps ? { caps } : {}),
        }),
        {
          type: "list",
          brief: "TEST kontakty, se kterými mám mluvit",
          config: { count: 5 },
          sources: [],
          recipe: null,
          language: "cs",
          now: Date.parse("2026-10-17T07:00:00.000Z"),
          timeZone: "Europe/Prague",
          runKey: runId,
          ...input,
        },
        new AbortController().signal,
      ),
    };
  };
  return { readId, writeId, fill };
}
/** The assembly answer for a list widget built from the contacts read. */
const listAnswer = {
  content: JSON.stringify({
    items: [{ title: "Jane Test", detail: "jane@example.test" }],
  }),
};

test("a fill offers and runs only read actions; a write can never be reached", async () => {
  const h = createTrustHarness({ writeApproval: "never" });
  try {
    const { readId, writeId, fill } = setup(h);
    const collect: ModelRequest[] = [];
    let assemble: ModelRequest | undefined;
    h.onChat((body) => {
      if (!isCollect(body)) {
        assemble = body;
        return listAnswer;
      }
      collect.push(body);
      const outputs = toolOutputs(body);
      switch (outputs.length) {
        case 0:
          // A write the model guessed: never offered, so never run.
          return h.call("read", { action: writeId, input: {} });
        case 1:
          return h.call("find_actions", {
            service: "TEST Calendar and contacts",
            need: "create a meeting or find a contact",
          });
        case 2:
          return h.call("read", {
            action: writeId,
            input: { body: { attendee: "x", start: "y", end: "z" } },
          });
        case 3:
          return h.call("read", { action: readId, input: { name: "Jane" } });
        default:
          return { content: "TEST done" };
      }
    });
    const { result } = fill();
    const filled = await result;
    // Only the two read-only tools exist; no action tool, no approval.
    for (const body of collect)
      assert.deepEqual(body.tools!.map((tool) => tool.function.name).sort(), [
        "find_actions",
        "read",
      ]);
    const outputs = toolOutputs(collect.at(-1)!);
    assert.equal(outputs[0]!.error, "unknown_action");
    // Discovery lists the service's read action only.
    assert.deepEqual(
      outputs[1]!.actions.map((action: { action: string }) => action.action),
      [readId],
    );
    assert.equal(outputs[2]!.error, "unknown_action");
    // The read's result reaches the model as untrusted data.
    assert.deepEqual(outputs[3]!.untrustedData, {
      contacts: [
        { id: "TEST-jane", name: "Jane Test", email: "jane@example.test" },
      ],
    });
    assert.match(outputs[3]!.note, /untrusted/);
    assert.match(String(messages(collect[0]!)[0]!.content), /untrusted data/);
    assert.match(String(messages(assemble!)[0]!.content), /untrusted data/);
    // Nothing but the contacts read went out; no write, no pending approval.
    assert.deepEqual(
      h.serviceRequests.map((request) => request.url),
      ["/v1/contacts?name=Jane"],
    );
    assert.equal(
      Number(
        h.db
          .prepare(
            "SELECT COUNT(*) AS n FROM agent_service_invocation WHERE json_extract(data,'$.effect')='write' OR json_extract(data,'$.status')='awaiting_approval'",
          )
          .get()!.n,
      ),
      0,
    );
    assert.deepEqual(filled.data, {
      items: [{ title: "Jane Test", detail: "jane@example.test" }],
    });
    assert.equal(filled.mode, "agent");
    assert.deepEqual(filled.recipe.services, ["TEST Calendar and contacts"]);
    assert.deepEqual(
      filled.recipe.calls.map((call) => [call.actionId, call.input]),
      [[readId, { name: "Jane" }]],
    );
  } finally {
    await h.close();
  }
});

test("the widget's schema is enforced: output that doesn't fit is refused", async () => {
  const h = createTrustHarness();
  try {
    const { readId, fill } = setup(h);
    let answer: object = { content: "TEST not JSON at all" };
    h.onChat((body) => {
      if (!isCollect(body)) return answer;
      if (!toolOutputs(body).length)
        return h.call("find_actions", {
          service: "TEST Calendar and contacts",
          need: "contacts",
        });
      if (toolOutputs(body).length === 1)
        return h.call("read", { action: readId, input: { name: "Jane" } });
      return { content: "TEST done" };
    });
    await assert.rejects(fill().result, code("hub_fill_invalid"));
    // Valid JSON in the wrong shape: a list item without its title.
    answer = { content: JSON.stringify({ items: [{ detail: "TEST" }] }) };
    await assert.rejects(fill().result, code("hub_fill_invalid"));
    // A link that is not a web link is refused as well.
    answer = {
      content: JSON.stringify({
        items: [{ title: "TEST", link: "javascript:alert(1)" }],
      }),
    };
    await assert.rejects(fill().result, code("hub_fill_invalid"));
    // A fill that read nothing has nothing to show.
    h.onChat((body) =>
      isCollect(body) ? { content: "TEST nothing fits" } : listAnswer,
    );
    await assert.rejects(fill().result, code("hub_fill_no_data"));
  } finally {
    await h.close();
  }
});

test("a recipe is replayed without the agent, and offered as a hint when it holds dates", async () => {
  const h = createTrustHarness();
  try {
    const { readId, fill } = setup(h);
    let calls = 0;
    h.onChat((body) => {
      calls++;
      if (!isCollect(body)) return listAnswer;
      const outputs = toolOutputs(body);
      if (!outputs.length)
        return h.call("find_actions", {
          service: "TEST Calendar and contacts",
          need: "contacts",
        });
      if (outputs.length === 1)
        return h.call("read", { action: readId, input: { name: "Jane" } });
      return { content: "TEST done" };
    });
    const first = await fill().result;
    assert.equal(first.mode, "agent");
    assert.equal(calls, 4);
    // The same reads again: no collection step, one assembly call.
    calls = 0;
    h.serviceRequests.length = 0;
    const second = await fill({ recipe: first.recipe }).result;
    assert.equal(second.mode, "replay");
    assert.equal(calls, 1);
    assert.deepEqual(
      h.serviceRequests.map((request) => request.url),
      ["/v1/contacts?name=Jane"],
    );
    assert.deepEqual(second.recipe, first.recipe);
    // A recipe with a date is a hint: the agent adjusts it to now and may
    // call its action right away, without discovery.
    const dated = {
      ...first.recipe,
      calls: first.recipe.calls.map((call) => ({
        ...call,
        input: { name: "2026-10-16" },
      })),
    };
    let prompt = "";
    h.onChat((body) => {
      if (!isCollect(body)) return listAnswer;
      prompt ||= String(messages(body).at(-1)!.content);
      return toolOutputs(body).length
        ? { content: "TEST done" }
        : h.call("read", { action: readId, input: { name: "Jane" } });
    });
    const third = await fill({ recipe: dated }).result;
    assert.equal(third.mode, "agent");
    const hint = JSON.parse(prompt).lastTime;
    assert.deepEqual(hint.reads[0].lastInput, { name: "2026-10-16" });
    assert.equal(hint.reads[0].action, readId);
    // A recipe whose action changed is not replayed either.
    calls = 0;
    const stale = await fill({
      recipe: {
        ...first.recipe,
        calls: first.recipe.calls.map((call) => ({
          ...call,
          actionRevision: call.actionRevision + 1,
        })),
      },
    }).result;
    assert.equal(stale.mode, "agent");
  } finally {
    await h.close();
  }
});

test("a service that refuses access fails the fill with that reason, not a generic one", async () => {
  const h = createTrustHarness();
  try {
    const { readId, fill } = setup(h);
    h.onService(({ path }) =>
      path.endsWith("/contacts")
        ? new ServiceStatus(403, { error: { code: "ErrorAccessDenied" } })
        : undefined,
    );
    h.onChat((body) => {
      const outputs = toolOutputs(body);
      if (!isCollect(body)) return listAnswer;
      if (!outputs.length)
        return h.call("find_actions", {
          service: "TEST Calendar and contacts",
          need: "contacts",
        });
      if (outputs.length === 1)
        return h.call("read", { action: readId, input: { name: "Jane" } });
      return { content: "TEST done" };
    });
    await assert.rejects(fill().result, code("service_access_denied"));
  } finally {
    await h.close();
  }
});

test("a fill stays within its own model-call and step caps, recorded in the ledger", async () => {
  const h = createTrustHarness();
  try {
    // The agent never stops looking: the step limit ends collection.
    const looping = setup(h);
    let calls = 0;
    h.onChat((body) => {
      calls++;
      return isCollect(body)
        ? h.call("find_actions", {
            service: "TEST Calendar and contacts",
            need: "everything",
          })
        : listAnswer;
    });
    const { result, runId } = looping.fill();
    await assert.rejects(result, code("hub_fill_no_data"));
    assert.equal(calls, HUB_FILL_LIMITS.steps);
    assert.equal(
      h.catalog.inferenceBudget.summary(runId).calls,
      HUB_FILL_LIMITS.steps,
    );
    // A smaller cap for the fill's own budget root refuses the next call
    // before dispatch.
    const capped = setup(h, {
      maxTokens: 1_000_000,
      maxCostMicros: 10_000_000,
      maxModelCalls: 2,
    });
    calls = 0;
    const second = capped.fill();
    await assert.rejects(second.result, code("catalog_budget_exhausted"));
    assert.equal(calls, 2);
    assert.equal(h.catalog.inferenceBudget.summary(second.runId).calls, 2);
  } finally {
    await h.close();
  }
});

test("a fill reads only what the person may use: their own switches and the administrator's grants", async () => {
  const db = new DatabaseSync(":memory:");
  const target = {
    organizationId: "TEST-org",
    workspaceId: "11111111-1111-4111-8111-111111111111",
  };
  try {
    db.exec(`CREATE TABLE organization(id TEXT PRIMARY KEY);
      CREATE TABLE user(id TEXT PRIMARY KEY,name TEXT);
      CREATE TABLE agent_workspace(id TEXT PRIMARY KEY,organization_id TEXT,name TEXT);
      CREATE TABLE member(id TEXT PRIMARY KEY,"organizationId" TEXT,"userId" TEXT);
      INSERT INTO organization VALUES ('TEST-org');
      INSERT INTO user VALUES ('TEST-owner','TEST owner'),('TEST-alice','TEST alice');
      INSERT INTO agent_workspace VALUES ('${target.workspaceId}','TEST-org','TEST');
      INSERT INTO member VALUES ('m1','TEST-org','TEST-owner'),('m2','TEST-org','TEST-alice');`);
    const oauth = new ServiceOAuthStore(
      db,
      "TEST-only-encryption-secret",
      "https://agent.example.test",
    );
    const catalog = new ServiceCatalogStore(
      db,
      "TEST-only-encryption-secret",
      [],
      oauth,
    );
    const command = (body: object) =>
      catalog.command(CatalogCommand.parse({ ...target, ...body }));
    const serviceId = command({
      type: "saveService",
      revision: 0,
      settings: {
        name: "TEST mail",
        url: "https://mail.example.test/v1",
        protocol: "openapi",
        icon: "mail",
        auth: { type: "none" },
        enabled: true,
      },
    });
    const action = (
      name: string,
      effect: "read" | "write",
      approval: "always" | "never" = "never",
      roles: string[] = ["owner", "admin"],
    ) =>
      command({
        type: "saveAction",
        serviceId,
        serviceRevision: catalog.service(target.workspaceId, serviceId)
          .revision,
        revision: 0,
        settings: {
          name,
          description: name,
          inputSchema: processObject({}),
          binding: {
            type: "http",
            method: effect === "read" ? "GET" : "POST",
            path: "/items",
            parameters: [],
            body: effect === "write",
          },
          effect,
          approval,
          enabled: true,
          policy: { roles, users: [] },
        },
      });
    const inbox = action("TEST inbox", "read");
    action("TEST send", "write");
    action("TEST audited read", "read", "always");
    const names = (userId: string, role: "owner" | "member") =>
      hubReadableServices(catalog, target.organizationId, target.workspaceId, {
        userId,
        role,
      }).flatMap((service) => service.actions.map((value) => value.name));
    // Shared credential: the administrator's grants and approvals decide.
    assert.deepEqual(names("TEST-owner", "owner"), ["TEST inbox"]);
    assert.deepEqual(names("TEST-alice", "member"), []);
    // Personal sign-in: the person's own switches decide, writes never appear.
    const oauthTarget = catalog.oauthTarget(target.workspaceId, serviceId);
    oauth.save(oauthTarget, oauth.config(oauthTarget).revision, {
      requiredFor: "all",
      signInHint: "service",
    });
    assert.deepEqual(names("TEST-alice", "member").sort(), [
      "TEST audited read",
      "TEST inbox",
    ]);
    catalog.personalPolicy.save(
      { ...target, serviceId, userId: "TEST-alice" },
      catalog.personalPolicy.revision(
        target.workspaceId,
        serviceId,
        "TEST-alice",
      ),
      [
        {
          action: { id: inbox, effect: "read" },
          choice: { enabled: false, approval: "never" },
        },
      ],
    );
    assert.deepEqual(names("TEST-alice", "member"), ["TEST audited read"]);
  } finally {
    db.close();
  }
});
