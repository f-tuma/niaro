import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ServerConfigSchema } from "../apps/reference-server/config";
import { createReferenceServer } from "../apps/reference-server/runtime";
import { issueAdminKey } from "../apps/server-admin/auth";
import { openIdentity } from "../apps/server-identity/service";
import type { IntegrationTransport } from "../apps/server-integrations/transport";
import {
  AUTH_PROFILE,
  CommandResultSchema,
  CommandSchema,
  CredentialSchema,
  PROFILE,
  type Command,
} from "../packages/protocol";
import {
  ANSWER_STREAM_MEDIA_TYPE,
  parseAnswerStreamEvent,
  splitServerSentEvents,
  type AnswerStreamChunk,
} from "../packages/protocol/answer-stream";
import { CARD_PROFILE } from "../packages/protocol/card-document";
import { GENERATIVE_UI_PROFILE } from "../packages/protocol/generative-ui";
import {
  IdentityStateSchema,
  OrganizationDetailSchema,
} from "../packages/protocol/identity";
import { CatalogSchema } from "../packages/protocol/service-catalog";
import type { ModelRequest } from "./agent-trust/harness";

function textProperty(value: unknown, key: string): string {
  assert(value && typeof value === "object" && key in value);
  const property = (value as Record<string, unknown>)[key];
  assert.equal(typeof property, "string");
  return property as string;
}

/** The chunks of one streamed command, read as they arrive. */
async function readStream(response: Response) {
  assert(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: (AnswerStreamChunk | "done")[] = [];
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = splitServerSentEvents(buffer);
    buffer = rest;
    for (const event of events) {
      const chunk = parseAnswerStreamEvent(event);
      if (chunk) chunks.push(chunk);
    }
  }
  return chunks;
}

/** Real authenticated HTTP and native execution; providers and services are offline fixtures. */
test("a message.send that accepts an event stream gets the draft, the steps and the JSON result as chunks", async () => {
  const root = mkdtempSync(join(tmpdir(), "niaro-answer-stream-"));
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
    name: "TEST answer stream",
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
  const providerKey = "TEST-answer-stream-provider-key";
  const serviceKey = "TEST-answer-stream-service-key";
  let actionName = "",
    writeActionName = "";
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
    await request.beforeDispatch!(() => {});
    if (url.hostname === "services.example.test") {
      assert.equal(url.pathname, "/v1/items");
      assert.equal(request.headers?.Authorization, `Bearer ${serviceKey}`);
      return {
        status: 200,
        headers: {},
        text: JSON.stringify(
          request.method === "POST"
            ? { id: "TEST-new", created: true }
            : { items: [{ id: "TEST-1" }, { id: "TEST-2" }] },
        ),
      };
    }
    assert.equal(url.hostname, "models.example.test");
    assert.equal(request.headers?.Authorization, `Bearer ${providerKey}`);
    const body = request.body as ModelRequest;
    // The turn's own tool results decide the reply: none yet calls the
    // action the person asked for; a settled write (approved or declined)
    // is reported; a finished read is answered.
    const messages = body.messages ?? [];
    const lastUser = messages.map((m) => m.role).lastIndexOf("user");
    const results = messages
      .slice(lastUser + 1)
      .filter((entry) => entry.role === "tool");
    const last = results.at(-1)?.content ?? "";
    const creating = /create/i.test(messages[lastUser]?.content ?? "");
    const message = !results.length
      ? creating
        ? call(writeActionName, { name: "TEST-new" })
        : call(actionName, {})
      : creating
        ? {
            content: last.includes('"status":"succeeded"')
              ? "TEST item created"
              : "TEST item not created",
          }
        : { content: "TEST two items found" };
    return {
      status: 200,
      headers: {},
      text: JSON.stringify({
        choices: [{ message }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    };
  };
  const identity = await openIdentity(config, {
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
  const commandsUrl = (workspaceId: string) =>
    `${origin}/v1/${workspaceId}/commands?cards=${encodeURIComponent(CARD_PROFILE)}&ui=${encodeURIComponent(GENERATIVE_UI_PROFILE)}`;
  try {
    await admin("api/login", { key: adminKey });
    const email = "answer-stream@example.test",
      password = "TEST-answer-stream-password-2026";
    await admin("api/identity/bootstrap", {
      name: "TEST Owner",
      email,
      password,
      organizationName: "TEST answer stream",
    });
    await admin("auth/sign-in/email", { email, password });
    const organizationId = IdentityStateSchema.parse(
      await admin("api/identity"),
    ).organizations[0]!.id;
    await admin("api/identity/command", {
      type: "createWorkspace",
      organizationId,
      name: "TEST Main",
    });
    const workspaceId = OrganizationDetailSchema.parse(
      await admin(`api/identity/organization?id=${organizationId}`),
    ).workspaces[0]!.id;
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
        { model: "TEST-answer-stream-model", name: "TEST model", tools: true },
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
          name: "TEST Items",
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
          name: "TEST List items",
          description: "List items",
          effect: "read",
          approval: "never",
          enabled: true,
          policy: { roles: ["owner", "admin", "member"], users: [] },
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          binding: {
            type: "http",
            method: "GET",
            path: "/items",
            parameters: [],
            body: false,
          },
        },
      }),
      "id",
    );
    actionName = "action_" + actionId.replaceAll("-", "_");
    const writeActionId = textProperty(
      await catalog({
        type: "saveAction",
        serviceId,
        serviceRevision: CatalogSchema.parse(
          await admin(`api/identity/catalog?${query}`),
        ).services[0]!.revision,
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
            properties: { name: { type: "string" } },
            required: ["name"],
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
    writeActionName = "action_" + writeActionId.replaceAll("-", "_");
    await catalog({
      type: "saveRouting",
      routing: { revision: 0, planner: "jev", modelId, services: [] },
    });
    const code = textProperty(
      await admin("api/identity/mobile/pairing", {
        organizationId,
        workspaceId,
      }),
      "code",
    );
    const paired = await fetch(`${origin}/v1/${workspaceId}/auth/pair`, {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        authProfile: AUTH_PROFILE,
        profile: PROFILE,
        code,
      }),
    });
    assert.equal(paired.status, 200);
    const principal = CredentialSchema.parse(await paired.json());
    const command = (id: string, text: string): Command =>
      CommandSchema.parse({
        type: "message.send",
        commandId: id,
        idempotencyKey: id,
        conversationId: "conversation-1",
        text,
        language: "en",
        timeZone: "UTC",
      });
    const send = (body: Command, accept?: string) =>
      fetch(commandsUrl(workspaceId), {
        method: "POST",
        signal: AbortSignal.timeout(30000),
        headers: {
          Authorization: `Bearer ${principal.accessToken}`,
          "Content-Type": "application/json",
          ...(accept ? { Accept: accept } : {}),
        },
        body: JSON.stringify(body),
      });

    const streamed = await send(
      command("TEST-stream-1", "TEST list the items"),
      ANSWER_STREAM_MEDIA_TYPE,
    );
    assert.equal(streamed.status, 200);
    assert.match(
      streamed.headers.get("content-type") ?? "",
      /^text\/event-stream/,
    );
    const chunks = await readStream(streamed);
    const types = chunks.map((chunk) =>
      chunk === "done" ? chunk : chunk.type,
    );
    assert.equal(types[0], "start");
    assert.deepEqual(types.slice(-3), ["data-niaro-result", "finish", "done"]);
    const typed = chunks.filter(
      (chunk): chunk is AnswerStreamChunk => chunk !== "done",
    );
    // The read's step, labelled as the Runs page labels it.
    const started = typed.find((chunk) => chunk.type === "tool-input-start");
    assert(started && started.type === "tool-input-start");
    assert.equal(started.toolName, "TEST List items");
    const finished = typed.find(
      (chunk) => chunk.type === "tool-output-available",
    );
    assert(finished && finished.type === "tool-output-available");
    assert.equal(finished.toolCallId, started.toolCallId);
    assert.deepEqual(
      (finished.output as { status: string; fields: { label: string }[] })
        .status,
      "succeeded",
    );
    // The draft, as text deltas.
    const text = typed
      .filter((chunk) => chunk.type === "text-delta")
      .map((chunk) => (chunk.type === "text-delta" ? chunk.delta : ""))
      .join("");
    assert.equal(text, "TEST two items found");
    // The result the JSON response would have carried.
    const result = typed.find((chunk) => chunk.type === "data-niaro-result");
    assert(result && result.type === "data-niaro-result");
    assert.equal(result.data.status, 202);
    const parsed = CommandResultSchema.parse(result.data.body);
    assert.equal(parsed.status, "accepted");
    const reply = parsed.snapshot.conversations[0]!.messages.at(-1)!;
    assert.equal(reply.text, "TEST two items found");
    assert.equal(reply.role, "assistant");

    // Resending the same command without the header reads the receipt as JSON.
    const replay = await send(command("TEST-stream-1", "TEST list the items"));
    assert.equal(replay.status, 202);
    assert.match(
      replay.headers.get("content-type") ?? "",
      /^application\/json/,
    );
    assert.deepEqual(
      CommandResultSchema.parse(await replay.json()).snapshot.conversations[0]!
        .messages.length,
      parsed.snapshot.conversations[0]!.messages.length,
    );

    // A refused command still streams: the error and the JSON path's status.
    const conflict = await send(
      command("TEST-stream-1", "TEST a different text"),
      ANSWER_STREAM_MEDIA_TYPE,
    );
    assert.equal(conflict.status, 200);
    const refused = (await readStream(conflict)).filter(
      (chunk): chunk is AnswerStreamChunk => chunk !== "done",
    );
    assert.deepEqual(
      refused.map((chunk) => chunk.type),
      ["start", "error", "data-niaro-result", "finish"],
    );
    const outcome = refused.find((chunk) => chunk.type === "data-niaro-result");
    assert(outcome && outcome.type === "data-niaro-result");
    // A refused command is a rejected result, as the JSON path answers it.
    assert.equal(outcome.data.status, 422);
    const rejected = CommandResultSchema.parse(outcome.data.body);
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.code, "idempotency_conflict");

    // A write stops for the person's decision: the stream announces the
    // card's reviewed fields before the stored result, never the arguments.
    const resolve = (id: string, operationId: string, approved: boolean) =>
      CommandSchema.parse({
        type: "service.resolve",
        commandId: id,
        idempotencyKey: id,
        conversationId: "conversation-1",
        operationId,
        approved,
        language: "en",
      });
    const typedChunks = async (response: Response) => {
      assert.equal(response.status, 200);
      assert.match(
        response.headers.get("content-type") ?? "",
        /^text\/event-stream/,
      );
      return (await readStream(response)).filter(
        (chunk): chunk is AnswerStreamChunk => chunk !== "done",
      );
    };
    const typesOf = (list: AnswerStreamChunk[]) => list.map((c) => c.type);
    const cardOf = (body: unknown, operationId: string) => {
      const message = CommandResultSchema.parse(
        body,
      ).snapshot.conversations[0]!.messages.findLast(
        (entry) =>
          entry.result?.type === "service.action" &&
          entry.result.operationId === operationId,
      );
      assert(message && message.result?.type === "service.action");
      return message.result;
    };
    const waiting = await typedChunks(
      await send(
        command("TEST-stream-write-1", "TEST create an item"),
        ANSWER_STREAM_MEDIA_TYPE,
      ),
    );
    const announced = waiting.find(
      (chunk) => chunk.type === "data-tool-call-approval",
    );
    assert(announced && announced.type === "data-tool-call-approval");
    assert.deepEqual(Object.keys(announced.data).sort(), [
      "effect",
      "input",
      "operationId",
      "reviewTruncated",
      "service",
      "toolCallId",
      "toolName",
    ]);
    assert.equal(announced.data.toolName, "TEST Create item");
    assert.equal(announced.data.service, "TEST Items");
    assert.equal(announced.data.effect, "write");
    assert.deepEqual(announced.data.input, {
      fields: [{ label: "name", value: "TEST-new" }],
    });
    assert.equal(announced.data.reviewTruncated, false);
    assert(
      waiting
        .filter((chunk) => chunk.type !== "data-niaro-result")
        .every((chunk) => !JSON.stringify(chunk).includes("inputJson")),
      "Only the stored result carries the write's arguments",
    );
    const waitingStep = waiting.find(
      (chunk) =>
        chunk.type === "tool-output-available" &&
        chunk.toolCallId === announced.data.toolCallId,
    );
    assert(waitingStep && waitingStep.type === "tool-output-available");
    assert.equal((waitingStep.output as { status: string }).status, "waiting");
    assert(
      typesOf(waiting).indexOf("data-tool-call-approval") <
        typesOf(waiting).indexOf("data-niaro-result"),
      "The approval is announced before the result",
    );
    const waitingResult = waiting.find(
      (chunk) => chunk.type === "data-niaro-result",
    );
    assert(waitingResult && waitingResult.type === "data-niaro-result");
    assert.equal(waitingResult.data.status, 202);
    const storedCard = cardOf(
      waitingResult.data.body,
      announced.data.operationId,
    );
    assert.equal(storedCard.status, "awaiting_approval");
    assert.deepEqual(storedCard.fields, announced.data.input.fields);
    assert.equal(storedCard.title, announced.data.toolName);

    // Approving streams the continuation: the write's step and the reply.
    const approved = await typedChunks(
      await send(
        resolve("TEST-resolve-1", announced.data.operationId, true),
        ANSWER_STREAM_MEDIA_TYPE,
      ),
    );
    assert.equal(typesOf(approved)[0], "start");
    assert.deepEqual(typesOf(approved).slice(-2), [
      "data-niaro-result",
      "finish",
    ]);
    assert.equal(
      approved
        .filter((chunk) => chunk.type === "text-delta")
        .map((chunk) => (chunk.type === "text-delta" ? chunk.delta : ""))
        .join(""),
      "TEST item created",
    );
    const approvedResult = approved.find(
      (chunk) => chunk.type === "data-niaro-result",
    );
    assert(approvedResult && approvedResult.type === "data-niaro-result");
    assert.equal(approvedResult.data.status, 202);
    const afterApproval = CommandResultSchema.parse(approvedResult.data.body);
    assert.equal(afterApproval.status, "accepted");
    assert.equal(
      cardOf(approvedResult.data.body, announced.data.operationId).status,
      "succeeded",
    );
    assert.equal(
      afterApproval.snapshot.conversations[0]!.messages.at(-1)!.text,
      "TEST item created",
    );

    // Replaying the decision with another answer is the same refusal as JSON.
    const replayedStream = await typedChunks(
      await send(
        resolve("TEST-resolve-1", announced.data.operationId, false),
        ANSWER_STREAM_MEDIA_TYPE,
      ),
    );
    const replayedJson = await send(
      resolve("TEST-resolve-1", announced.data.operationId, false),
    );
    assert.deepEqual(typesOf(replayedStream), [
      "start",
      "error",
      "data-niaro-result",
      "finish",
    ]);
    const replayedResult = replayedStream.find(
      (chunk) => chunk.type === "data-niaro-result",
    );
    assert(replayedResult && replayedResult.type === "data-niaro-result");
    assert.equal(replayedResult.data.status, 422);
    assert.equal(replayedResult.data.status, replayedJson.status);
    assert.deepEqual(replayedResult.data.body, await replayedJson.json());
    assert.equal(
      CommandResultSchema.parse(replayedResult.data.body).code,
      "idempotency_conflict",
    );

    // Declining streams the rejected outcome.
    const second = await typedChunks(
      await send(
        command("TEST-stream-write-2", "TEST create another item"),
        ANSWER_STREAM_MEDIA_TYPE,
      ),
    );
    const announcedAgain = second.find(
      (chunk) => chunk.type === "data-tool-call-approval",
    );
    assert(announcedAgain && announcedAgain.type === "data-tool-call-approval");
    assert.notEqual(
      announcedAgain.data.operationId,
      announced.data.operationId,
    );
    const declined = await typedChunks(
      await send(
        resolve("TEST-resolve-2", announcedAgain.data.operationId, false),
        ANSWER_STREAM_MEDIA_TYPE,
      ),
    );
    const declinedResult = declined.find(
      (chunk) => chunk.type === "data-niaro-result",
    );
    assert(declinedResult && declinedResult.type === "data-niaro-result");
    assert.equal(declinedResult.data.status, 202);
    assert.equal(
      cardOf(declinedResult.data.body, announcedAgain.data.operationId).status,
      "rejected",
    );
    assert.equal(
      CommandResultSchema.parse(
        declinedResult.data.body,
      ).snapshot.conversations[0]!.messages.at(-1)!.text,
      "TEST item not created",
    );
    assert(
      !declined.some((chunk) => chunk.type === "data-tool-call-approval"),
      "A declined write asks for nothing more",
    );
  } finally {
    app.emit("close");
    await identity.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
