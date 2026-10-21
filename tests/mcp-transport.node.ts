import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import { test } from "node:test";
import {
  createMcpHttpHandler,
  McpAuthenticationError,
  McpTaskError,
  type McpTaskHandlers,
} from "../apps/server-mcp/transport";

type Context = { owner: string };
type Call = { tool: string; context: Context; input: unknown };

async function fixture(
  options: {
    tasks?: Partial<McpTaskHandlers<Context>>;
    authenticate?: (
      request: IncomingMessage,
    ) => Context | null | Promise<Context | null>;
    allowedHosts?: readonly string[];
  } = {},
) {
  const calls: Call[] = [];
  let authentications = 0;
  const errors: unknown[] = [];
  const handler = createMcpHttpHandler({
    allowedOrigins: ["https://client.example"],
    allowedHosts: options.allowedHosts,
    authenticate: async (request) => {
      authentications += 1;
      if (options.authenticate) return options.authenticate(request);
      const token = request.headers.authorization;
      return token === "Bearer TEST-a" || token === "Bearer TEST-b"
        ? { owner: token.slice("Bearer TEST-".length) }
        : null;
    },
    tasks: {
      submit: (context, input) => {
        calls.push({ tool: "submit", context, input });
        return { taskId: "TEST-task", status: "accepted" };
      },
      get: (context, input) => {
        calls.push({ tool: "get", context, input });
        return { taskId: input.taskId, status: "working" };
      },
      respond: (context, input) => {
        calls.push({ tool: "respond", context, input });
        return { taskId: input.taskId, status: "working" };
      },
      cancel: (context, input) => {
        calls.push({ tool: "cancel", context, input });
        return { taskId: input.taskId, status: "cancelled" };
      },
      ...options.tasks,
    },
  });
  const server = createServer((request, response) => {
    void handler(request, response).catch((error: unknown) => {
      errors.push(error);
      response.destroy();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: "Bearer TEST-a",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const call = async (name: string, args: unknown) => {
    const response = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  return {
    calls,
    endpoint,
    post,
    call,
    authentications: () => authentications,
    close: async () => {
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeAllConnections();
      await closed;
      assert.deepEqual(errors, []);
    },
  };
}

test("MCP initialize and tools/list use authenticated stateless JSON responses", async () => {
  const app = await fixture();
  try {
    const initialize = await app.post({
      jsonrpc: "2.0",
      id: "TEST-init",
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "TEST-client", version: "1" },
      },
    });
    assert.equal(initialize.status, 200);
    assert.match(
      initialize.headers.get("content-type") ?? "",
      /application\/json/,
    );
    assert.equal(initialize.headers.get("mcp-session-id"), null);
    assert.equal(initialize.headers.get("cache-control"), "no-store");
    assert.equal(initialize.headers.get("x-content-type-options"), "nosniff");
    const initialized = await initialize.json();
    assert.equal(initialized.id, "TEST-init");
    assert.equal(initialized.result.protocolVersion, "2025-11-25");
    assert.equal(initialized.result.serverInfo.name, "niaro");

    const response = await app.post({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    assert.equal(response.status, 200);
    const tools = (await response.json()).result.tools;
    assert.deepEqual(
      tools.map((tool: { name: string }) => tool.name),
      ["task_submit", "task_get", "task_respond", "task_cancel"],
    );
    assert.equal(tools[0].inputSchema.additionalProperties, false);
    assert.equal(tools[0].inputSchema.properties.text.maxLength, 4_000);
    assert.equal(tools[1].inputSchema.properties.waitMs.maximum, 10_000);
    assert.equal(app.authentications(), 2);
    assert.deepEqual(app.calls, []);
  } finally {
    await app.close();
  }
});

test("MCP tools pass validated values and the current authentication context", async () => {
  const app = await fixture();
  try {
    const submitted = await app.call("task_submit", {
      requestId: "TEST-submit",
      text: "Create an offer",
      timeZone: "Europe/Prague",
    });
    assert.deepEqual(submitted.result.structuredContent, {
      taskId: "TEST-task",
      status: "accepted",
    });
    assert.deepEqual(
      JSON.parse(submitted.result.content[0].text),
      submitted.result.structuredContent,
    );
    const read = await app.post(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "task_get", arguments: { taskId: "TEST-task" } },
      },
      {
        authorization: "Bearer TEST-b",
        "mcp-session-id": "TEST-unused-session",
      },
    );
    assert.equal(read.status, 200);
    assert.equal(
      (await read.json()).result.structuredContent.status,
      "working",
    );
    await app.call("task_respond", {
      taskId: "TEST-task",
      requestId: "TEST-respond",
      inputId: "TEST-input",
      expectedRevision: 1,
      text: "Confirmed",
    });
    await app.call("task_cancel", {
      taskId: "TEST-task",
      requestId: "TEST-cancel",
    });
    assert.deepEqual(app.calls, [
      {
        tool: "submit",
        context: { owner: "a" },
        input: {
          requestId: "TEST-submit",
          text: "Create an offer",
          language: "cs",
          timeZone: "Europe/Prague",
        },
      },
      {
        tool: "get",
        context: { owner: "b" },
        input: { taskId: "TEST-task", waitMs: 0 },
      },
      {
        tool: "respond",
        context: { owner: "a" },
        input: {
          taskId: "TEST-task",
          requestId: "TEST-respond",
          inputId: "TEST-input",
          expectedRevision: 1,
          text: "Confirmed",
        },
      },
      {
        tool: "cancel",
        context: { owner: "a" },
        input: { taskId: "TEST-task", requestId: "TEST-cancel" },
      },
    ]);
    assert.equal(app.authentications(), 4);
  } finally {
    await app.close();
  }
});

test("MCP schema rejects malformed identifiers, oversized text and unsafe task inputs", async () => {
  const app = await fixture();
  try {
    const invalid: [string, unknown][] = [
      ["task_submit", { requestId: "bad key", text: "Task" }],
      ["task_submit", { requestId: "TEST-id", text: "  \n\t" }],
      ["task_submit", { requestId: "TEST-id", text: "x".repeat(4_001) }],
      ["task_submit", { requestId: "TEST-id", text: "Task", language: "de" }],
      [
        "task_submit",
        { requestId: "TEST-id", text: "Task", timeZone: "TEST/invalid" },
      ],
      [
        "task_submit",
        { requestId: "TEST-id", text: "Task", timeZone: "+01:00" },
      ],
      [
        "task_submit",
        { requestId: "TEST-id", text: "Task", conversationId: "TEST-chat" },
      ],
      ["task_get", { taskId: "TEST-task", waitMs: 10_001 }],
      ["task_get", { taskId: "TEST-task", waitMs: -1 }],
      ["task_get", { taskId: "TEST-task", waitMs: 0.5 }],
      [
        "task_respond",
        {
          taskId: "TEST-task",
          requestId: "TEST-id",
          inputId: "TEST-input",
          expectedRevision: 0,
          text: "Reply",
        },
      ],
      [
        "task_respond",
        {
          taskId: "TEST-task",
          requestId: "TEST-id",
          expectedRevision: 1,
          text: "Reply",
        },
      ],
      ["task_cancel", { taskId: "TEST-task" }],
      [
        "task_cancel",
        { taskId: "TEST-task", requestId: "TEST-id", owner: "other" },
      ],
    ];
    for (const [name, args] of invalid) {
      const result = await app.call(name, args);
      assert.equal(
        result.result.isError,
        true,
        name + " " + JSON.stringify(args),
      );
    }
    assert.deepEqual(app.calls, []);
  } finally {
    await app.close();
  }
});

test("MCP rejects unsupported HTTP methods and JSON-RPC methods", async () => {
  const app = await fixture();
  try {
    for (const method of ["GET", "DELETE", "PUT", "OPTIONS"]) {
      const response = await fetch(app.endpoint, {
        method,
        headers: { authorization: "Bearer TEST-a" },
      });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get("allow"), "POST");
    }
    const unknown = await app.post({
      jsonrpc: "2.0",
      id: 2,
      method: "TEST/unknown",
    });
    assert.equal(unknown.status, 200);
    assert.equal((await unknown.json()).error.code, -32601);
    const unknownTool = await app.call("TEST-unknown", {});
    assert.equal(unknownTool.result.isError, true);
    const extensionTask = await app.post({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "task_submit",
        arguments: { requestId: "TEST-id", text: "Task" },
        task: { ttl: 60_000 },
      },
    });
    assert.equal(extensionTask.status, 200);
    const unsupportedTask = await extensionTask.json();
    assert.match(
      unsupportedTask.error.message,
      /does not support task creation|MCP task creation is not supported/,
    );
    const notified = await app.post({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    assert.equal(notified.status, 202);
    assert.equal(await notified.text(), "");
    assert.deepEqual(app.calls, []);
  } finally {
    await app.close();
  }
});

test("MCP validates HTTP protocol headers, malformed JSON and the bounded request body", async () => {
  const app = await fixture();
  try {
    const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    assert.equal(
      (await app.post(list, { accept: "application/json" })).status,
      406,
    );
    assert.equal(
      (await app.post(list, { "content-type": "text/plain" })).status,
      415,
    );
    assert.equal(
      (await app.post(list, { "mcp-protocol-version": "TEST-invalid" })).status,
      400,
    );
    const malformed = await fetch(app.endpoint, {
      method: "POST",
      headers: {
        authorization: "Bearer TEST-a",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: "{",
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, -32700);
    const oversized = await app.post({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "task_submit",
        arguments: { requestId: "TEST-id", text: "x".repeat(64 * 1024) },
      },
    });
    assert.equal(oversized.status, 413);
    assert.deepEqual(app.calls, []);
  } finally {
    await app.close();
  }
});

test("MCP Origin allowlist rejects invalid and duplicate origins before authentication", async () => {
  const app = await fixture();
  try {
    for (const origin of [
      "https://evil.example",
      "null",
      "https://client.example/path",
      "https://client.example https://evil.example",
    ]) {
      const response = await app.post(
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { origin },
      );
      assert.equal(response.status, 403);
    }
    const duplicate = await new Promise<number | undefined>(
      (resolve, reject) => {
        const request = httpRequest(
          app.endpoint,
          {
            method: "POST",
            headers: [
              "Host",
              new URL(app.endpoint).host,
              "Origin",
              "https://client.example",
              "Origin",
              "https://client.example",
              "Authorization",
              "Bearer TEST-a",
            ],
          },
          (response) => {
            response.resume();
            response.once("end", () => resolve(response.statusCode));
          },
        );
        request.on("error", reject);
        request.end();
      },
    );
    assert.equal(duplicate, 403);
    assert.equal(app.authentications(), 0);
    const accepted = await app.post(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { origin: "https://client.example" },
    );
    assert.equal(accepted.status, 200);
    assert.equal(app.authentications(), 1);
    assert.deepEqual(app.calls, []);
  } finally {
    await app.close();
  }
});

test("MCP validates Host when configured before authentication", async () => {
  const app = await fixture({ allowedHosts: ["allowed.example:1234"] });
  try {
    const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    const rawPost = (host: string) =>
      new Promise<number | undefined>((resolve, reject) => {
        const request = httpRequest(
          app.endpoint,
          {
            method: "POST",
            headers: {
              Host: host,
              Authorization: "Bearer TEST-a",
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
            },
          },
          (response) => {
            response.resume();
            response.once("end", () => resolve(response.statusCode));
          },
        );
        request.on("error", reject);
        request.end(JSON.stringify(list));
      });
    assert.equal(await rawPost("evil.example"), 403);
    assert.equal(app.authentications(), 0);
    assert.equal(await rawPost("ALLOWED.example:1234"), 200);
    assert.equal(app.authentications(), 1);
    assert.deepEqual(app.calls, []);
  } finally {
    await app.close();
  }
});

test("MCP authentication has no cookie, pairing or administrator fallback", async () => {
  const app = await fixture();
  try {
    for (const method of ["POST", "GET", "DELETE"]) {
      const response = await fetch(app.endpoint, {
        method,
        headers: {
          cookie: "TEST-session=TEST-admin",
          "x-admin-key": "TEST-admin",
          "x-pairing-code": "TEST-pairing",
        },
      });
      assert.equal(response.status, 401);
      assert.match(response.headers.get("www-authenticate") ?? "", /^Bearer /);
      assert.equal(response.headers.get("set-cookie"), null);
    }
    assert.deepEqual(app.calls, []);
    assert.equal(app.authentications(), 3);
  } finally {
    await app.close();
  }
});

test("MCP exposes deliberate public authentication errors and withholds internal failures", async () => {
  const app = await fixture({
    authenticate: (request) => {
      if (request.headers.authorization === "Bearer TEST-denied") {
        throw new McpAuthenticationError(403, "Credential is not allowed.");
      }
      throw Error("TEST private authentication details");
    },
  });
  try {
    const denied = await app.post({}, { authorization: "Bearer TEST-denied" });
    assert.equal(denied.status, 403);
    assert.equal(
      (await denied.json()).error.message,
      "Credential is not allowed.",
    );
    const failed = await app.post({});
    assert.equal(failed.status, 500);
    assert.doesNotMatch(await failed.text(), /TEST private/);
    assert.deepEqual(app.calls, []);
  } finally {
    await app.close();
  }
});

test("MCP preserves public task errors and withholds internal handler failures", async () => {
  const app = await fixture({
    tasks: {
      submit: () => {
        throw Error("TEST private backend details");
      },
      cancel: () => {
        throw new McpTaskError("task_not_found", "Task was not found.");
      },
    },
  });
  try {
    const failed = await app.call("task_submit", {
      requestId: "TEST-id",
      text: "Task",
    });
    assert.equal(failed.result.isError, true);
    assert.deepEqual(failed.result.structuredContent.error, {
      code: "task_failed",
      message: "The task operation failed.",
    });
    assert.doesNotMatch(JSON.stringify(failed), /TEST private/);
    const missing = await app.call("task_cancel", {
      taskId: "TEST-task",
      requestId: "TEST-id",
    });
    assert.equal(missing.result.isError, true);
    assert.equal(missing.result.structuredContent.error.code, "task_not_found");
  } finally {
    await app.close();
  }
});

test("MCP bounds a task_get handler that never resolves without invoking task cancellation", async () => {
  let getInput: unknown;
  let cancellations = 0;
  const app = await fixture({
    tasks: {
      get: (_, input) => {
        getInput = input;
        return new Promise(() => {});
      },
      cancel: () => {
        cancellations += 1;
        return {};
      },
    },
  });
  try {
    const started = Date.now();
    const result = await app.call("task_get", { taskId: "TEST-task" });
    assert.equal(result.result.isError, true);
    assert.equal(
      result.result.structuredContent.error.code,
      "task_get_timeout",
    );
    assert(Date.now() - started < 3_000);
    assert.deepEqual(getInput, { taskId: "TEST-task", waitMs: 0 });
    assert.equal(cancellations, 0);
  } finally {
    await app.close();
  }
});

test("MCP lost submit acknowledgement does not abort accepted native work", async () => {
  let accepted!: () => void;
  const admitted = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let completed!: () => void;
  const completion = new Promise<void>((resolve) => {
    completed = resolve;
  });
  let cancellations = 0;
  const app = await fixture({
    tasks: {
      submit: async () => {
        accepted();
        await released;
        completed();
        return { taskId: "TEST-durable-task", status: "accepted" };
      },
      cancel: () => {
        cancellations += 1;
        return {};
      },
    },
  });
  try {
    const controller = new AbortController();
    const response = fetch(app.endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: "Bearer TEST-a",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "task_submit",
          arguments: { requestId: "TEST-submit", text: "Task" },
        },
      }),
    });
    await admitted;
    controller.abort();
    await assert.rejects(response, { name: "AbortError" });
    release();
    await completion;
    assert.equal(cancellations, 0);
  } finally {
    release();
    await app.close();
  }
});
