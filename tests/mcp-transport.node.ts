import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import { test } from "node:test";
import { z } from "zod";
import {
  createMcpHttpHandler,
  inputSchema,
  invalidInput,
  McpAuthenticationError,
  McpToolError,
  type McpToolHandlers,
} from "../apps/server-mcp/transport";

type Context = { owner: string };
type Call = { tool: string; context: Context; input: unknown };
const echoSchema = z.strictObject({
  text: z.string().min(1).max(4_000),
  count: z.number().int().min(1).max(10).default(1),
});

async function fixture(
  options: {
    call?: McpToolHandlers<Context>["call"];
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
    resourceMetadataUrl:
      "https://niaro.example/.well-known/oauth-protected-resource/mcp",
    scopes: ["data.read", "memory.write", "services.call"],
    instructions: "TEST instructions",
    authenticate: async (request) => {
      authentications += 1;
      if (options.authenticate) return options.authenticate(request);
      const token = request.headers.authorization;
      return token === "Bearer TEST-a" || token === "Bearer TEST-b"
        ? { owner: token.slice("Bearer TEST-".length) }
        : null;
    },
    tools: {
      list: () => [
        {
          name: "test_echo",
          description: "TEST echo",
          inputSchema: inputSchema(echoSchema),
          annotations: { readOnlyHint: true },
        },
      ],
      call:
        options.call ??
        ((context, name, input) => {
          if (name !== "test_echo")
            throw new McpToolError("unknown_tool", "Unknown tool.");
          const parsed = echoSchema.safeParse(input);
          if (!parsed.success)
            throw invalidInput(parsed.error, { text: "hello" });
          calls.push({ tool: name, context, input: parsed.data });
          return { result: { echo: parsed.data.text } };
        }),
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
    assert.equal(initialized.result.instructions, "TEST instructions");

    const response = await app.post({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    assert.equal(response.status, 200);
    const tools = (await response.json()).result.tools;
    assert.deepEqual(
      tools.map((tool: { name: string }) => tool.name),
      ["test_echo"],
    );
    assert.equal(tools[0].inputSchema.additionalProperties, false);
    assert.equal(tools[0].inputSchema.properties.text.maxLength, 4_000);
    assert.equal(app.authentications(), 2);
    assert.deepEqual(app.calls, []);
  } finally {
    await app.close();
  }
});

test("MCP tools pass validated values and the current authentication context", async () => {
  const app = await fixture();
  try {
    const echoed = await app.call("test_echo", { text: "Hello" });
    assert.deepEqual(echoed.result.structuredContent, { echo: "Hello" });
    assert.deepEqual(
      JSON.parse(echoed.result.content[0].text),
      echoed.result.structuredContent,
    );
    const other = await app.post(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "test_echo", arguments: { text: "B", count: 2 } },
      },
      {
        authorization: "Bearer TEST-b",
        "mcp-session-id": "TEST-unused-session",
      },
    );
    assert.equal(other.status, 200);
    assert.equal((await other.json()).result.structuredContent.echo, "B");
    assert.deepEqual(app.calls, [
      {
        tool: "test_echo",
        context: { owner: "a" },
        input: { text: "Hello", count: 1 },
      },
      {
        tool: "test_echo",
        context: { owner: "b" },
        input: { text: "B", count: 2 },
      },
    ]);
    assert.equal(app.authentications(), 2);
  } finally {
    await app.close();
  }
});

test("MCP validation errors name each wrong field and show a correct call", async () => {
  const app = await fixture();
  try {
    const invalid = await app.call("test_echo", {
      count: 11,
      owner: "other",
    });
    assert.equal(invalid.result.isError, true);
    const error = invalid.result.structuredContent.error;
    assert.equal(error.code, "invalid_input");
    assert.match(error.message, /text:/);
    assert.match(error.message, /count:/);
    assert.match(error.message, /unknown field\(s\) owner/);
    assert.match(error.message, /A correct call looks like \{"text":"hello"\}/);
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
        name: "test_echo",
        arguments: { text: "Task" },
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
        name: "test_echo",
        arguments: { text: "x".repeat(64 * 1024) },
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

test("MCP preserves public tool errors and withholds internal handler failures", async () => {
  const app = await fixture({
    call: (_, name) => {
      if (name === "test_missing")
        throw new McpToolError("not_found", "Nothing was found.");
      throw Error("TEST private backend details");
    },
  });
  try {
    const failed = await app.call("test_echo", { text: "Task" });
    assert.equal(failed.result.isError, true);
    assert.deepEqual(failed.result.structuredContent.error, {
      code: "tool_failed",
      message: "The tool call failed.",
    });
    assert.doesNotMatch(JSON.stringify(failed), /TEST private/);
    const missing = await app.call("test_missing", {});
    assert.equal(missing.result.isError, true);
    assert.equal(missing.result.structuredContent.error.code, "not_found");
  } finally {
    await app.close();
  }
});

test("MCP 401 challenge names the resource metadata and the scopes", async () => {
  const app = await fixture();
  try {
    const response = await app.post({}, { authorization: "Bearer TEST-none" });
    assert.equal(response.status, 401);
    assert.equal(
      response.headers.get("www-authenticate"),
      'Bearer realm="mcp", resource_metadata="https://niaro.example/.well-known/oauth-protected-resource/mcp", scope="data.read memory.write services.call"',
    );
  } finally {
    await app.close();
  }
});

test("MCP lost acknowledgement does not abort a started call", async () => {
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let completed!: () => void;
  const completion = new Promise<void>((resolve) => {
    completed = resolve;
  });
  let aborted = false;
  const app = await fixture({
    call: async (_context, _name, _input, signal) => {
      started();
      await released;
      aborted = signal.aborted;
      completed();
      return { result: { done: true } };
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
        params: { name: "test_echo", arguments: { text: "Write" } },
      }),
    });
    await running;
    controller.abort();
    await assert.rejects(response, { name: "AbortError" });
    release();
    await completion;
    assert.equal(aborted, false);
  } finally {
    release();
    await app.close();
  }
});
