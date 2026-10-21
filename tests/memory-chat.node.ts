import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerConfigSchema } from "../apps/reference-server/config";
import { createReferenceServer } from "../apps/reference-server/runtime";
import { openIdentity } from "../apps/server-identity/service";
import { issueAdminKey } from "../apps/server-admin/auth";
import { AUTH_PROFILE, PROFILE, CredentialSchema } from "../packages/protocol";
import { MemoryViewSchema } from "../packages/protocol/memory";
import type { IntegrationTransport } from "../apps/server-integrations/transport";
import type { ModelMessage } from "../apps/server-integrations/models";
import { memoryCorrectionIntent } from "../apps/server-identity/memory-runtime";
import { systemEvidence } from "./agent-trust/harness";

// Full identity → catalog planner → scoped memory hook; synthetic model only.
test("memory chat: explicit notes persist into new sessions, opt-out and deletion invalidate actual inference", async () => {
  const root = mkdtempSync(join(tmpdir(), "memory-chat-"));
  let app: ReturnType<typeof createReferenceServer>;
  const server = createServer((req, res) => app.emit("request", req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const config = ServerConfigSchema.parse({
    version: 1,
    name: "TEST Memory Chat",
    listen: { port: address.port },
    dataDirectory: join(root, "workflow"),
    allowedOrigins: [],
    plugins: { enabled: ["memory"], timeZone: "UTC" },
    administration: {
      keyFile: join(root, "key"),
      identity: { directory: join(root, "identity"), baseURL: origin },
    },
    adapters: {
      model: { provider: "fixture" },
      voice: { provider: "disabled" },
      crm: { provider: "disabled" },
      calendar: { provider: "simulated" },
    },
  });
  const key = issueAdminKey(config.administration!.keyFile);
  const requests: {
    messages: ModelMessage[];
    tools?: { function: { name: string } }[];
  }[] = [];
  let gate: (() => Promise<void>) | undefined;
  const transport: IntegrationTransport = async (req) => {
    assert(
      req.url.endsWith("/chat/completions"),
      "No external service calls expected",
    );
    await req.beforeDispatch?.(() => {});
    const body = req.body as (typeof requests)[number];
    requests.push(body);
    await gate?.();
    const latest = [...body.messages]
      .reverse()
      .find((m) => m.role === "user")?.content;
    const saved = body.messages.some(
      (m) => m.role === "tool" && m.content?.includes('"status":"active"'),
    );
    const correction = memoryCorrectionIntent(latest ?? "");
    const searched = systemEvidence<{
      items?: { id: string; revision: number; content: string }[];
    }>(
      { model: "TEST-model", ...body },
      "Current authorized memory tool results: ",
    )
      .flatMap((value) => value.items ?? [])
      .find((item) => item.content === correction?.previousContent);
    const tool = (name: string, args: unknown) => ({
      tool_calls: [
        {
          id: `TEST-${name}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    });
    const message =
      correction && !saved
        ? searched
          ? tool("memory_revise", {
              id: searched.id,
              revision: searched.revision,
              content: correction.content,
            })
          : tool("memory_search", { query: correction.previousContent })
        : latest?.startsWith("Remember:") && !saved
          ? {
              tool_calls: [
                {
                  id: "TEST-remember",
                  type: "function",
                  function: {
                    name: "memory_remember",
                    arguments: JSON.stringify({
                      content: "TEST private preference",
                      kind: "preference",
                    }),
                  },
                },
              ],
            }
          : { content: "TEST reply" };
    return {
      status: 200,
      headers: {},
      text: JSON.stringify({ choices: [{ message }] }),
    };
  };
  const identity = await openIdentity(config, {
    integrationTransport: transport,
  });
  app = createReferenceServer(config, {}, identity);
  const cookies = new Map<string, string>();
  const request = async (path: string, input?: unknown) => {
    const res = await fetch(origin + "/admin/" + path, {
      method: input === undefined ? "GET" : "POST",
      signal: AbortSignal.timeout(10000),
      headers: {
        Origin: origin,
        "X-Agent-Admin": "1",
        "Content-Type": "application/json",
        Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      },
      body: input === undefined ? undefined : JSON.stringify(input),
    });
    for (const value of res.headers.getSetCookie()) {
      const pair = value.split(";")[0]!,
        i = pair.indexOf("=");
      cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const data = await res.json();
    assert.equal(res.status, 200, JSON.stringify(data));
    return data;
  };
  try {
    await request("api/login", { key });
    const password = "TEST-memory-chat-password-2026",
      email = "memory-chat@example.test";
    await request("api/identity/bootstrap", {
      name: "TEST Owner",
      email,
      password,
      organizationName: "TEST Memory Chat",
    });
    await request("auth/sign-in/email", { email, password });
    const organizationId = (await request("api/identity")).organizations[0].id;
    await request("api/identity/command", {
      organizationId,
      type: "createWorkspace",
      name: "TEST Workspace",
    });
    const workspaceId = (
      await request(`api/identity/organization?id=${organizationId}`)
    ).workspaces[0].id;
    const target = { organizationId, workspaceId },
      query = new URLSearchParams(target);
    const catalog = (value: object) =>
      request("api/identity/catalog/command", { ...target, ...value });
    const providerId = (
      await catalog({
        type: "saveProvider",
        revision: 0,
        settings: {
          name: "TEST Provider",
          url: "https://models.example.test/v1",
          enabled: true,
          dailyRequestLimit: 100,
        },
      })
    ).id;
    await catalog({
      type: "importModels",
      providerId,
      providerRevision: 1,
      models: [{ model: "TEST-model", name: "TEST model", tools: true }],
    });
    const modelId = (await request(`api/identity/catalog?${query}`)).models[0]
      .id;
    await catalog({
      type: "saveRouting",
      routing: { revision: 0, planner: "model", modelId, services: [] },
    });
    const grant = await request("api/identity/mobile/pairing", target);
    const paired = await fetch(`${origin}/v1/${workspaceId}/auth/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        authProfile: AUTH_PROFILE,
        profile: PROFILE,
        code: grant.code,
      }),
    });
    const credential = CredentialSchema.parse(await paired.json());
    const run = async (text = "TEST new request") => {
      const access = await identity.mobileAccess(
        `Bearer ${credential.accessToken}`,
        workspaceId,
        credential.scope.serverId,
      );
      return access.integrations!.message(
        randomUUID(),
        text,
        "en",
        [],
        new AbortController().signal,
        undefined,
        undefined,
        undefined,
        { conversationId: "TEST.conversation:new", session: "new" },
      );
    };
    await run("Remember: TEST private preference");
    const memory = () =>
      request(`api/identity/memory?${query}`).then((data) =>
        MemoryViewSchema.parse(data),
      );
    let item = (await memory()).items[0];
    assert(item);
    assert.equal(item.content, "TEST private preference");
    const count = requests.length;
    await run();
    assert(
      requests[count]!.messages.some((m) =>
        m.content?.includes("TEST private preference"),
      ),
      "A new session should retrieve saved preferences",
    );
    assert(
      requests[count]!.tools?.some((t) => t.function.name === "memory_search"),
    );
    assert(
      requests[count]!.tools?.some((t) => t.function.name === "memory_revise"),
    );
    const original = item;
    const revisionCommandId = randomUUID();
    const correctionText =
      'Revise memory: "TEST private preference" to "TEST replacement preference"';
    const access = await identity.mobileAccess(
      `Bearer ${credential.accessToken}`,
      workspaceId,
      credential.scope.serverId,
    );
    const revise = () =>
      access.integrations!.message(
        revisionCommandId,
        correctionText,
        "en",
        [],
        new AbortController().signal,
        undefined,
        undefined,
        undefined,
        { conversationId: "TEST.conversation:new", session: "new" },
      );
    const corrected = await revise();
    const revised = (await memory()).items.find(
      (entry) => entry.status === "active",
    );
    assert(revised);
    assert.equal(revised.content, "TEST replacement preference");
    assert.equal(revised.supersedesId, original.id);
    assert.deepEqual(revised.source, {
      type: "user_message",
      commandId: revisionCommandId,
      conversationId: "TEST.conversation:new",
    });
    assert.equal(
      (await memory()).items.find((entry) => entry.id === original.id)?.status,
      "superseded",
    );
    const replayCount = requests.length,
      version = (await memory()).version;
    assert.deepEqual(await revise(), corrected);
    assert.equal(requests.length, replayCount);
    assert.equal((await memory()).version, version);
    const fresh = requests.length;
    await run();
    assert(
      JSON.stringify(requests[fresh]!.messages).includes(
        "TEST replacement preference",
      ),
    );
    assert(
      !JSON.stringify(requests[fresh]!.messages).includes(
        "TEST private preference",
      ),
    );
    const mutate = (value: object) =>
      request("api/identity/memory", {
        ...target,
        requestId: randomUUID(),
        ...value,
      });
    await mutate({ type: "preference", optOut: true });
    const opted = requests.length;
    await run();
    for (const content of [
      "TEST private preference",
      "TEST replacement preference",
    ])
      assert(!JSON.stringify(requests[opted]!.messages).includes(content));
    await mutate({ type: "preference", optOut: false });
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      wait = new Promise<void>((resolve) => {
        release = resolve;
      });
    gate = async () => {
      entered();
      await wait;
    };
    const pending = run(),
      rejected = assert.rejects(
        pending,
        /memory_context_changed|model_unavailable/,
      );
    await started;
    item = (await memory()).items.find((entry) => entry.status === "active")!;
    try {
      await mutate({ type: "forget", id: item.id, revision: item.revision });
    } finally {
      gate = undefined;
      release();
    }
    await rejected;
    assert.deepEqual((await memory()).items, []);
    const erased = requests.length;
    await run();
    for (const content of [
      "TEST private preference",
      "TEST replacement preference",
    ])
      assert(!JSON.stringify(requests[erased]!.messages).includes(content));
  } finally {
    app.emit("close");
    await identity.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
