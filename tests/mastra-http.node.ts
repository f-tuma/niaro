import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ServerConfigSchema } from "../apps/reference-server/config";
import { createReferenceServer } from "../apps/reference-server/runtime";
import { issueAdminKey } from "../apps/server-admin/auth";
import { openIdentity } from "../apps/server-identity/service";
import { DomainCommandSchema } from "../apps/server-identity/mastra-domain";
import { inspectNativeCatalogRuntime } from "../apps/server-identity/mastra-runtime";
import type { IntegrationTransport } from "../apps/server-integrations/transport";
import {
  AUTH_PROFILE,
  PROFILE,
  CommandSchema,
  CommandResultSchema,
  CredentialSchema,
  SnapshotSchema,
  type Command,
  type Snapshot,
} from "../packages/protocol";
import { CARD_PROFILE } from "../packages/protocol/card-document";
import {
  IdentityStateSchema,
  OrganizationDetailSchema,
} from "../packages/protocol/identity";
import { CatalogSchema } from "../packages/protocol/service-catalog";
import { toolResults, type ModelRequest } from "./agent-trust/harness";
import { coordinatorHttpFixture } from "./helpers/process-coordinator-http";
import { ActionSettings } from "../packages/protocol/service-catalog";
import { LoopDetailSchema, LoopPageSchema } from "../packages/protocol/loops";

function textProperty(value: unknown, key: string): string {
  assert(value && typeof value === "object" && key in value);
  const property = (value as Record<string, unknown>)[key];
  assert.equal(typeof property, "string");
  return property as string;
}

/** Real authenticated HTTP and native execution; providers/services are offline fixtures. */
test("native HTTP binds forms and approval to paired scope and replays after restart without another effect", async () => {
  const root = mkdtempSync(join(tmpdir(), "niaro-mastra-http-"));
  let app: ReturnType<typeof createReferenceServer>;
  const server = createServer((request, response) =>
    app.emit("request", request, response),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const config = ServerConfigSchema.parse({
    version: 1,
    name: "TEST native HTTP",
    listen: { port: address.port },
    dataDirectory: join(root, "workflow"),
    allowedOrigins: [],
    plugins: { enabled: ["datetime"], timeZone: "UTC" },
    administration: {
      keyFile: join(root, "admin-key"),
      identity: { directory: join(root, "identity"), baseURL: origin },
    },
    adapters: {
      model: { provider: "fixture" },
      voice: { provider: "disabled" },
      crm: { provider: "disabled" },
      calendar: { provider: "simulated" },
    },
  });
  const adminKey = issueAdminKey(config.administration!.keyFile);
  const serviceName = "TEST HTTP Service";
  const providerKey = "TEST-native-http-provider-key";
  const serviceKey = "TEST-native-http-service-key";
  const requests: ModelRequest[] = [];
  let writes = 0;
  let actionName = "";
  const call = (name: string, args: unknown) => ({
    content: null,
    tool_calls: [
      {
        id: randomUUID(),
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  });
  const transport: IntegrationTransport = async (request) => {
    const url = new URL(request.url);
    assert(
      request.signal && !request.signal.aborted,
      "Current native execution must reach the guarded transport",
    );
    assert.equal(typeof request.beforeDispatch, "function");
    if (url.hostname === "services.example.test") {
      assert.equal(url.pathname, "/v1/items");
      assert.equal(request.headers?.Authorization, `Bearer ${serviceKey}`);
      assert.deepEqual(request.body, { title: "TEST one item" });
      await request.beforeDispatch!(() => {
        writes++;
      });
      return {
        status: 200,
        headers: {},
        text: JSON.stringify({
          id: "TEST-created-item",
          title: "TEST one item",
        }),
      };
    }
    assert.equal(url.hostname, "models.example.test");
    assert.equal(url.pathname, "/v1/chat/completions");
    assert.equal(request.headers?.Authorization, `Bearer ${providerKey}`);
    await request.beforeDispatch!(() => {});
    const body = request.body as ModelRequest;
    assert.equal(body.model, "TEST-native-http-model");
    requests.push(structuredClone(body));
    assert(requests.length <= 16, "The offline native scenario is bounded");
    const latestUser = body.messages!.findLastIndex(
      (message) => message.role === "user",
    );
    const current = body.messages!.slice(latestUser + 1);
    const text = body.messages![latestUser]?.content;
    let message: object;
    if (text === "TEST new chat") {
      message = { content: "TEST new chat started" };
    } else if (text === "TEST compose a details form") {
      message = current.some((entry) =>
        entry.tool_calls?.some((tool) => tool.function.name === "compose_card"),
      )
        ? { content: "TEST details form ready" }
        : call("compose_card", {
            title: "TEST details",
            nodes: [
              {
                id: "title",
                type: "input",
                label: "Title",
                kind: "text",
                required: true,
              },
              { id: "submit", type: "button", actionId: "continue" },
            ],
            root: ["title", "submit"],
            actions: [
              {
                id: "continue",
                label: "TEST continue",
                kind: "submit",
                variant: "primary",
                fields: ["title"],
              },
            ],
          });
    } else if (
      toolResults({ ...body, messages: current }).some(
        (result) => result.effect === "write" && result.status === "succeeded",
      )
    ) {
      message = {
        content: "TEST item created from the observed service receipt",
      };
    } else if (!body.tools?.some((tool) => tool.function.name === actionName)) {
      message = call("find_actions", {
        service: serviceName,
        need: "Create an item",
      });
    } else {
      message = call(actionName, { body: { title: "TEST one item" } });
    }
    return {
      status: 200,
      headers: {},
      text: JSON.stringify({
        choices: [{ message }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    };
  };
  let identity = await openIdentity(config, {
    integrationTransport: transport,
  });
  app = createReferenceServer(config, {}, identity);
  const cookies = new Map<string, string>();
  async function admin(path: string, input?: unknown) {
    const response = await fetch(`${origin}/admin/${path}`, {
      method: input === undefined ? "GET" : "POST",
      signal: AbortSignal.timeout(10000),
      headers: {
        Origin: origin,
        "X-Agent-Admin": "1",
        "Content-Type": "application/json",
        Cookie: [...cookies]
          .map(([key, value]) => `${key}=${value}`)
          .join("; "),
      },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0]!,
        split = pair.indexOf("=");
      cookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
    const value: unknown = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  }
  async function mobile(token: string, workspaceId: string, command?: Command) {
    const path = command ? "commands" : "snapshot";
    const response = await fetch(
      `${origin}/v1/${workspaceId}/${path}?cards=${encodeURIComponent(CARD_PROFILE)}`,
      {
        method: command ? "POST" : "GET",
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: command ? JSON.stringify(command) : undefined,
      },
    );
    return {
      status: response.status,
      value: (await response.json()) as unknown,
    };
  }
  const restart = async () => {
    app.emit("close");
    await identity.close();
    identity = await openIdentity(config, { integrationTransport: transport });
    app = createReferenceServer(config, {}, identity);
  };
  try {
    await admin("api/login", { key: adminKey });
    const email = "native-http@example.test",
      password = "TEST-native-http-password-2026";
    await admin("api/identity/bootstrap", {
      name: "TEST Owner",
      email,
      password,
      organizationName: "TEST native HTTP",
    });
    await admin("auth/sign-in/email", { email, password });
    const organizationId = IdentityStateSchema.parse(
      await admin("api/identity"),
    ).organizations[0]!.id;
    for (const name of ["TEST Main", "TEST Foreign"])
      await admin("api/identity/command", {
        type: "createWorkspace",
        organizationId,
        name,
      });
    const workspaces = OrganizationDetailSchema.parse(
      await admin(`api/identity/organization?id=${organizationId}`),
    ).workspaces;
    const workspaceId = workspaces.find(
      (workspace) => workspace.name === "TEST Main",
    )!.id;
    const foreignId = workspaces.find(
      (workspace) => workspace.name === "TEST Foreign",
    )!.id;
    const target = { organizationId, workspaceId };
    const query = new URLSearchParams(target);
    const catalog = (value: object) =>
      admin("api/identity/catalog/command", { ...target, ...value });
    const providerId = textProperty(
      await catalog({
        type: "saveProvider",
        revision: 0,
        settings: {
          name: "TEST Provider",
          url: "https://models.example.test/v1",
          enabled: true,
          dailyRequestLimit: 100,
        },
        apiKey: providerKey,
      }),
      "id",
    );
    await catalog({
      type: "importModels",
      providerId,
      providerRevision: 1,
      models: [
        {
          model: "TEST-native-http-model",
          name: "TEST native model",
          tools: true,
        },
      ],
    });
    const modelId = CatalogSchema.parse(
      await admin(`api/identity/catalog?${query}`),
    ).models[0]!.id;
    const serviceId = textProperty(
      await catalog({
        type: "saveService",
        revision: 0,
        settings: {
          name: serviceName,
          url: "https://services.example.test/v1",
          protocol: "openapi",
          icon: "database",
          auth: { type: "bearer" },
          enabled: true,
        },
        apiKey: serviceKey,
      }),
      "id",
    );
    const serviceRevision = CatalogSchema.parse(
      await admin(`api/identity/catalog?${query}`),
    ).services[0]!.revision;
    const actionId = textProperty(
      await catalog({
        type: "saveAction",
        serviceId,
        serviceRevision,
        revision: 0,
        settings: {
          name: "TEST Create item",
          description: "Create an item",
          effect: "write",
          approval: "always",
          enabled: true,
          policy: { roles: ["owner", "admin", "member"], users: [] },
          inputSchema: {
            type: "object",
            properties: {
              body: {
                type: "object",
                properties: { title: { type: "string" } },
                required: ["title"],
                additionalProperties: false,
              },
            },
            required: ["body"],
            additionalProperties: false,
          },
          binding: {
            type: "http",
            method: "POST",
            path: "/items",
            parameters: [],
            body: true,
          },
        },
      }),
      "id",
    );
    actionName = "action_" + actionId.replaceAll("-", "_");
    await catalog({
      type: "saveRouting",
      routing: { revision: 0, planner: "jev", modelId, services: [] },
    });
    async function pair(workspace: string) {
      const code = textProperty(
        await admin("api/identity/mobile/pairing", {
          organizationId,
          workspaceId: workspace,
        }),
        "code",
      );
      const response = await fetch(`${origin}/v1/${workspace}/auth/pair`, {
        method: "POST",
        signal: AbortSignal.timeout(10000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          authProfile: AUTH_PROFILE,
          profile: PROFILE,
          code,
        }),
      });
      assert.equal(response.status, 200);
      return CredentialSchema.parse(await response.json());
    }
    const principal = await pair(workspaceId),
      foreign = await pair(foreignId);
    const command = (id: string, text: string) =>
      CommandSchema.parse({
        type: "message.send",
        commandId: id,
        idempotencyKey: id,
        conversationId: "conversation-1",
        text,
        language: "en",
        timeZone: "UTC",
      });
    const beforeUnboundRetry = requests.length;
    const unboundRetry = await mobile(
      principal.accessToken,
      workspaceId,
      CommandSchema.parse({
        ...command(
          "TEST-http-retry-public-attempt",
          "TEST retry unavailable work",
        ),
        idempotencyKey: "TEST-http-retry-internal-key",
        logicalMessageId: "TEST-http-retry-logical-message",
        retryOf: "TEST-http-missing-parent-command",
      }),
    );
    assert.equal(unboundRetry.status, 409, JSON.stringify(unboundRetry.value));
    assert.equal(requests.length, beforeUnboundRetry);
    assert.equal(writes, 0);
    const form = await mobile(
      principal.accessToken,
      workspaceId,
      CommandSchema.parse({
        ...command("TEST-http-form-public", "TEST compose a details form"),
        idempotencyKey: "TEST-http-form-internal",
      }),
    );
    assert.equal(form.status, 202, JSON.stringify(form.value));
    const formResult = CommandResultSchema.parse(form.value);
    const formKey = createHash("sha256")
      .update(
        JSON.stringify([
          principal.scope.serverId,
          workspaceId,
          principal.scope.userId,
          "TEST-http-form-internal",
        ]),
      )
      .digest("hex");
    const formState = DomainCommandSchema.parse(
      identity["catalog"].store.turn(
        formKey,
        workspaceId,
        principal.scope.userId,
      ),
    );
    assert.equal(formState.aliases[0]?.commandId, "TEST-http-form-internal");
    assert.equal(formState.aliases[0]?.outerCommandId, "TEST-http-form-public");
    const formMessage = formResult.snapshot.conversations[0]!.messages.findLast(
      (message) => message.result?.type === "card.document",
    )!;
    assert(formMessage.result?.type === "card.document");
    const document = formMessage.result.document;
    const countBeforeStale = requests.length;
    const stale = await mobile(
      principal.accessToken,
      workspaceId,
      CommandSchema.parse({
        type: "card.respond",
        commandId: "TEST-http-stale",
        idempotencyKey: "TEST-http-stale",
        conversationId: "conversation-1",
        messageId: formMessage.id,
        cardId: document.id,
        expectedCardRevision: document.revision + 1,
        actionId: "continue",
        values: { title: "TEST one item" },
        language: "en",
      }),
    );
    assert.equal(stale.status, 409);
    assert.equal(
      CommandResultSchema.parse(stale.value).code,
      "revision_conflict",
    );
    assert.equal(requests.length, countBeforeStale);
    assert.equal(writes, 0);

    const proposal = await mobile(
      principal.accessToken,
      workspaceId,
      command("TEST-http-create", "TEST create one item"),
    );
    assert.equal(proposal.status, 202, JSON.stringify(proposal.value));
    const pending = CommandResultSchema.parse(proposal.value);
    const proposedMessage =
      pending.snapshot.conversations[0]!.messages.findLast(
        (message) => message.result?.type === "service.action",
      )!;
    assert(proposedMessage.result?.type === "service.action");
    assert.equal(proposedMessage.result.status, "awaiting_approval");
    assert.equal(writes, 0);
    const operationId = proposedMessage.result.operationId;
    const approve = CommandSchema.parse({
      type: "service.resolve",
      commandId: "TEST-http-approve",
      idempotencyKey: "TEST-http-approve",
      conversationId: "conversation-1",
      operationId,
      workItemId: pending.snapshot.workItems.find(
        (work) => work.native?.action?.operationId === operationId,
      )!.id,
      expectedWorkRevision: pending.snapshot.workItems.find(
        (work) => work.native?.action?.operationId === operationId,
      )!.revision,
      approved: true,
      language: "en",
    });
    const beforeDenial = requests.length;
    assert.equal(
      (await mobile(foreign.accessToken, workspaceId, approve)).status,
      403,
    );
    assert.equal(
      (await mobile(foreign.accessToken, foreignId, approve)).status,
      422,
    );
    assert.equal(requests.length, beforeDenial);
    assert.equal(writes, 0);
    const nativeKey = createHash("sha256")
      .update(
        JSON.stringify([
          principal.scope.serverId,
          workspaceId,
          principal.scope.userId,
          "TEST-http-create",
        ]),
      )
      .digest("hex");
    const state = DomainCommandSchema.parse(
      identity["catalog"].store.turn(
        nativeKey,
        workspaceId,
        principal.scope.userId,
      ),
    );
    assert.equal(state.kind, "mastra-1");
    assert.equal(state.pending?.operationId, operationId);
    assert.equal(
      statSync(fileURLToPath(identity["catalog"].store.nativeStorageUrl)).mode &
        0o777,
      0o600,
    );
    const reset = await mobile(
      principal.accessToken,
      workspaceId,
      CommandSchema.parse({
        ...command("TEST-http-new-chat", "TEST new chat"),
        session: "new",
      }),
    );
    assert.equal(reset.status, 202);
    assert(
      !CommandResultSchema.parse(
        reset.value,
      ).snapshot.conversations[0]!.messages.some(
        (message) => message.result?.type === "service.action",
      ),
    );
    await restart();
    const taskSnapshot = SnapshotSchema.parse(
      (await mobile(principal.accessToken, workspaceId)).value,
    );
    const task = taskSnapshot.workItems.find((work) => work.id === nativeKey)!;
    assert.equal(task.native?.action?.operationId, operationId);
    assert.equal(task.status, "waiting_approval");
    const openTask = CommandSchema.parse({
      type: "task.open",
      commandId: "TEST-http-open-task",
      idempotencyKey: "TEST-http-open-task",
      conversationId: task.conversationId,
      workItemId: task.id,
      expectedWorkRevision: task.revision,
      language: "en",
    });
    const beforeOpen = requests.length;
    assert.equal(
      (
        await mobile(principal.accessToken, workspaceId, {
          ...openTask,
          commandId: "TEST-http-stale-task",
          idempotencyKey: "TEST-http-stale-task",
          expectedWorkRevision: task.revision + 1,
        } as Command)
      ).status,
      409,
    );
    assert.equal(
      (await mobile(principal.accessToken, workspaceId, openTask)).status,
      202,
    );
    assert.equal(requests.length, beforeOpen);
    assert.equal(writes, 0);
    const accepted = await mobile(principal.accessToken, workspaceId, approve);
    assert.equal(accepted.status, 202, JSON.stringify(accepted.value));
    const completed = CommandResultSchema.parse(accepted.value);
    const outcome = completed.snapshot.conversations[0]!.messages.findLast(
      (message) => message.result?.type === "service.action",
    )!.result;
    assert(outcome?.type === "service.action");
    assert.equal(outcome.operationId, operationId);
    assert.equal(outcome.status, "succeeded");
    assert.equal(writes, 1);
    const resourceId = createHash("sha256")
      .update(
        JSON.stringify([
          principal.scope.serverId,
          organizationId,
          workspaceId,
          principal.scope.userId,
        ]),
      )
      .digest("hex");
    const native = await inspectNativeCatalogRuntime(
      identity["catalog"],
      state.threadId,
      resourceId,
    );
    assert(native.messages.some((message) => message.role === "assistant"));
    assert(JSON.stringify(native.messages).includes(operationId));
    assert(!JSON.stringify(completed).includes(providerKey));
    assert(!JSON.stringify(completed).includes(serviceKey));
    const beforeReplay = requests.length;
    const duplicate = await mobile(principal.accessToken, workspaceId, approve);
    assert.equal(duplicate.status, 202);
    assert.deepEqual(CommandResultSchema.parse(duplicate.value), completed);
    await restart();
    assert.deepEqual(
      CommandResultSchema.parse(
        (await mobile(principal.accessToken, workspaceId, approve)).value,
      ),
      completed,
    );
    assert.equal(requests.length, beforeReplay);
    assert.equal(writes, 1);
    const snapshot = await mobile(principal.accessToken, workspaceId);
    assert.equal(snapshot.status, 200);
    assert.deepEqual(
      SnapshotSchema.parse(snapshot.value),
      completed.snapshot as Snapshot,
    );
  } finally {
    app.emit("close");
    await identity.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(root, { recursive: true, force: true });
  }
});

test("paired mobile HTTP keeps a confirmed note separate from a refused person link", async () => {
  const h = await coordinatorHttpFixture({ allowOrdinaryRuntime: true });
  try {
    const service = h.identity["catalog"].store.service(
      h.target.workspaceId,
      h.serviceId,
    );
    const updateAction = async (
      id: string,
      patch: Partial<ReturnType<typeof ActionSettings.parse>>,
    ) => {
      const currentService = h.identity["catalog"].store.service(
        h.target.workspaceId,
        h.serviceId,
      );
      const current = currentService.actions.find(
        (action) => action.id === id,
      )!;
      await h.catalog({
        type: "saveAction",
        id,
        serviceId: h.serviceId,
        serviceRevision: currentService.revision,
        revision: current.revision,
        settings: { ...ActionSettings.strip().parse(current), ...patch },
      });
    };
    const roles: ReturnType<typeof ActionSettings.parse>["policy"] = {
      roles: ["owner", "admin", "member"],
      users: [],
    };
    const personLookupId = h.actionId;
    const createNoteId = h.writeId;
    await updateAction(personLookupId, {
      name: "TEST find target person",
      description: "Find one CRM person by their supplied name",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
      binding: {
        type: "http",
        method: "GET",
        path: "/people",
        parameters: [{ name: "name", in: "query", required: true }],
        body: false,
      },
      effect: "read",
      approval: "never",
      enabled: true,
      policy: roles,
    });
    await updateAction(createNoteId, {
      name: "TEST create note",
      description: "Create a standalone CRM note",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
        additionalProperties: false,
      },
      binding: {
        type: "http",
        method: "POST",
        path: "/notes",
        parameters: [],
        body: true,
      },
      effect: "write",
      approval: "never",
      enabled: true,
      policy: roles,
    });
    const currentService = h.identity["catalog"].store.service(
      h.target.workspaceId,
      h.serviceId,
    );
    const linkId = await h.catalog({
      type: "saveAction",
      serviceId: h.serviceId,
      serviceRevision: currentService.revision,
      revision: 0,
      settings: {
        name: "TEST attach note to person",
        description: "Attach a previously created note to a verified person",
        inputSchema: {
          type: "object",
          properties: {
            person_id: { type: "string" },
            note_id: { type: "string" },
            position: { type: "number" },
          },
          required: ["person_id", "note_id", "position"],
          additionalProperties: false,
        },
        binding: {
          type: "http",
          method: "POST",
          path: "/person-notes",
          parameters: [],
          body: true,
        },
        effect: "write",
        approval: "never",
        enabled: true,
        policy: roles,
      },
    });
    const providerId = await h.catalog({
      type: "saveProvider",
      revision: 0,
      apiKey: "TEST-decision-key",
      settings: {
        name: "TEST decisions provider",
        url: "https://openrouter.ai/api/v1",
        enabled: true,
        dailyRequestLimit: 100,
      },
    });
    const decisionModelId = await h.catalog({
      type: "saveModel",
      revision: 0,
      settings: {
        providerId,
        name: "TEST Jev decision model",
        model: "typesafe/jev-1.13",
        enabled: true,
        tools: false,
        kind: "decision",
      },
    });
    const routing = h.identity["catalog"].store.routing(h.target.workspaceId);
    await h.catalog({
      type: "saveRouting",
      routing: {
        ...routing,
        modelId: h.modelId,
        decision: {
          enabled: true,
          modelId: decisionModelId,
          minConfidence: 0.8,
        },
      },
    });
    const inferenceBudget = h.identity["catalog"].store.inferenceBudget;
    const budgetPolicy = inferenceBudget.policy(
      h.target.organizationId,
      h.target.workspaceId,
    );
    inferenceBudget.savePolicy(
      h.target.organizationId,
      h.target.workspaceId,
      budgetPolicy.revision,
      {
        ...budgetPolicy.settings,
        prices: [
          ...budgetPolicy.settings.prices,
          {
            modelId: decisionModelId,
            modelRevision: 1,
            providerRevision: 1,
            maxInputTokens: 100_000,
            maxOutputTokens: 10_000,
            inputMicrosPerMillion: 1_000_000,
            outputMicrosPerMillion: 1_000_000,
          },
        ],
      },
    );

    let decisionCalls = 0;
    const catalog = h.identity["catalog"] as unknown as {
      transport: IntegrationTransport;
    };
    const chatAndServiceTransport = catalog.transport;
    Object.defineProperty(catalog, "transport", {
      configurable: true,
      value: async (request: Parameters<IntegrationTransport>[0]) => {
        if (request.url === "https://openrouter.ai/api/alpha/decisions") {
          await request.beforeDispatch?.(() => {
            decisionCalls++;
          });
          const modelRequest = request.body as {
            questions: { route: { criteria: Record<string, string> } };
            state: { action?: string };
          };
          const criteria = modelRequest.questions.route.criteria;
          const decisionState = modelRequest.state;
          const choice =
            decisionState.action === "TEST create note"
              ? "matches"
              : decisionState.action === "TEST attach note to person"
                ? "mismatch"
                : "incomplete";
          const other = Object.keys(criteria).filter((key) => key !== choice);
          const probability = other.length ? 0.01 / other.length : 0;
          return {
            status: 200,
            headers: {},
            text: JSON.stringify({
              answers: {
                route: {
                  type: "choice",
                  choice,
                  confidence: 0.99,
                  probabilities: Object.fromEntries([
                    [choice, 0.99],
                    ...other.map((key) => [key, probability]),
                  ]),
                },
              },
              usage: {
                input_tokens: 10,
                output_tokens: 5,
                cost: 0.00002,
              },
            }),
          };
        }
        return chatAndServiceTransport(request);
      },
    });

    const personTool = "action_" + personLookupId.replaceAll("-", "_");
    const createNoteTool = "action_" + createNoteId.replaceAll("-", "_");
    const linkTool = "action_" + linkId.replaceAll("-", "_");
    const toolCall = (name: string, args: object) => ({
      content: null,
      tool_calls: [
        {
          id: randomUUID(),
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    });
    const requests: ModelRequest[] = [];
    h.onModel((body) => {
      requests.push(structuredClone(body));
      const results = toolResults(body).filter(
        (result) => result.currentTurn === true,
      );
      if (!body.tools?.some((tool) => tool.function.name === personTool))
        return toolCall("find_actions", {
          service: service.name,
          need: "Find TEST Person, create a note, and attach it to that person",
        });
      if (
        !results.some(
          (result) => result.effect === "read" && result.status === "succeeded",
        )
      )
        return toolCall(personTool, { name: "TEST Person" });
      if (
        !results.some(
          (result) =>
            result.effect === "write" && result.status === "succeeded",
        )
      )
        return toolCall(createNoteTool, { title: "TEST meeting note" });
      if (
        body.messages?.some(
          (message) =>
            message.role === "tool" &&
            message.content?.includes("checker_mismatch"),
        )
      )
        return {
          content:
            "The note record was created, but attaching it to TEST Person was not sent. The full request is incomplete.",
        };
      return toolCall(linkTool, {
        person_id: "TEST-person-17",
        note_id: "TEST-note-83",
        position: 0,
      });
    });
    h.onService(async (request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/people"))
        return {
          status: 200,
          headers: {},
          text: JSON.stringify({ id: "TEST-person-17", name: "TEST Person" }),
        };
      if (path.endsWith("/notes"))
        return {
          status: 200,
          headers: {},
          text: JSON.stringify({
            id: "TEST-note-83",
            title: "TEST meeting note",
          }),
        };
      throw Error("TEST relation must not reach the service provider");
    });

    const credential = await h.pair("member");
    const command = CommandSchema.parse({
      type: "message.send",
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      conversationId: "conversation-1",
      text: "Create a meeting note and attach it to TEST Person",
      language: "en",
      timeZone: "UTC",
    });
    const response = await h.mobile(credential, "commands", command);
    assert.equal(response.status, 202, JSON.stringify(response.data));
    const completed = CommandResultSchema.parse(response.data);
    const conversation = completed.snapshot.conversations.find(
      (item) => item.id === command.conversationId,
    );
    assert(conversation);
    const reply = conversation.messages.at(-1)!;
    assert.equal(reply.role, "assistant");
    const runWork = completed.snapshot.workItems.find(
      (work) => work.id === reply.workItemId,
    );
    assert(runWork, "the mobile snapshot carries the owning native work item");
    assert.equal(runWork.status, "failed");
    assert.equal(runWork.result, reply.text);
    assert.equal(
      runWork.native?.action,
      undefined,
      "partial completion must not project an action card onto the run work item",
    );
    const actionCards = conversation.messages.flatMap((message) =>
      message.result?.type === "service.action" ? [message.result] : [],
    );
    assert.equal(
      reply.result,
      undefined,
      "a partially completed request must not publish a green overall result card",
    );
    assert(
      !actionCards.some(
        (result) =>
          result.title === "TEST attach note to person" &&
          result.status === "succeeded",
      ),
      "the refused relation cannot produce a green success card",
    );
    assert.match(reply.text, /earlier write .*TEST create note.* confirmed/i);
    assert.match(
      reply.text,
      /separate write .*TEST attach note to person.* was not sent/i,
    );
    assert.match(
      reply.text,
      /completion of the overall request are not confirmed/i,
    );
    assert(
      requests.some((request) =>
        request.tools?.some((tool) => tool.function.name === linkTool),
      ),
      "the linked write was offered through the authenticated mobile runtime",
    );
    assert.equal(
      decisionCalls,
      3,
      "create, rejected link and final reply each pass a Jev check",
    );
    assert.deepEqual(h.dispatches, ["GET", "POST"]);

    const loopsResponse = await h.request(
      "owner",
      "api/identity/loops?" + h.query,
    );
    assert.equal(loopsResponse.status, 200);
    const page = LoopPageSchema.parse(loopsResponse.data);
    const entry = page.entries.find((item) => item.reply === reply.text);
    assert(entry);
    const detailResponse = await h.request(
      "owner",
      `api/identity/loops/${encodeURIComponent(entry.id)}?${h.query}`,
    );
    assert.equal(detailResponse.status, 200);
    const detail = LoopDetailSchema.parse(detailResponse.data);
    assert.equal(detail.run.status, "failed");
    assert(
      detail.nodes.some(
        (node) =>
          node.kind === "tool" &&
          node.status === "succeeded" &&
          JSON.stringify(node).includes("TEST create note"),
      ),
      "Loops preserves the successful note create as a distinct effect",
    );
    assert(
      detail.nodes.some(
        (node) =>
          node.kind === "reply" &&
          node.status === "failed" &&
          JSON.stringify(node).includes("TEST attach note to person"),
      ),
      "Loops separately shows the failed request and explanation",
    );

    const retry = await h.mobile(credential, "commands", command);
    assert.equal(retry.status, 202);
    assert.deepEqual(CommandResultSchema.parse(retry.data), completed);
    assert.deepEqual(h.dispatches, ["GET", "POST"]);
    assert.equal(decisionCalls, 3);
  } finally {
    await h.close();
  }
});
