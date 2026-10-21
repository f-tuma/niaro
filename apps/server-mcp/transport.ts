import type { IncomingMessage, ServerResponse } from "node:http";
// eslint-disable-next-line import/no-unresolved -- Official SDK export-map subpath.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
// eslint-disable-next-line import/no-unresolved -- Official SDK export-map subpath.
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js"; // eslint-disable-line import/no-unresolved -- Official SDK export-map subpath.
import { z } from "zod";
import { TimeZone } from "../../packages/protocol/internal-plugins";

export const MCP_MAX_GET_WAIT_MS = 10_000;
const GET_HANDLER_GRACE_MS = 1_000;
const MAX_REQUEST_BYTES = 64 * 1024;

const identifier = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,160}$/)
  .describe(
    "An application handle or an idempotency key, independent of MCP sessions.",
  );
const taskText = z
  .string()
  .min(1)
  .max(4_000)
  .regex(/\S/, "Text must not be empty.");

export const mcpTaskSubmitSchema = z
  .object({
    requestId: identifier,
    text: taskText,
    language: z.enum(["cs", "en"]).default("cs"),
    timeZone: TimeZone.optional(),
  })
  .strict();
export const mcpTaskGetSchema = z
  .object({
    taskId: identifier,
    waitMs: z.number().int().min(0).max(MCP_MAX_GET_WAIT_MS).default(0),
  })
  .strict();
export const mcpTaskRespondSchema = z
  .object({
    taskId: identifier,
    requestId: identifier,
    inputId: identifier,
    expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    text: taskText,
  })
  .strict();
export const mcpTaskCancelSchema = z
  .object({
    taskId: identifier,
    requestId: identifier,
  })
  .strict();

export type McpTaskSubmitInput = z.output<typeof mcpTaskSubmitSchema>;
export type McpTaskGetInput = z.output<typeof mcpTaskGetSchema>;
export type McpTaskRespondInput = z.output<typeof mcpTaskRespondSchema>;
export type McpTaskCancelInput = z.output<typeof mcpTaskCancelSchema>;

type TaskResult = Record<string, unknown>;
type MaybePromise<T> = T | Promise<T>;

/** Context is resolved for every HTTP request by the owning server. */
export interface McpTaskHandlers<Context> {
  submit(context: Context, input: McpTaskSubmitInput): MaybePromise<TaskResult>;
  get(context: Context, input: McpTaskGetInput): MaybePromise<TaskResult>;
  respond(
    context: Context,
    input: McpTaskRespondInput,
  ): MaybePromise<TaskResult>;
  cancel(context: Context, input: McpTaskCancelInput): MaybePromise<TaskResult>;
}

/** Connector mode: the caller's permitted service actions as MCP tools. */
export interface McpConnectorHandlers<Context> {
  /** Which tool families this authenticated context may see and call. */
  modes(context: Context): { tasks: boolean; connector: boolean };
  list(context: Context): MaybePromise<Tool[]>;
  call(
    context: Context,
    name: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): MaybePromise<TaskResult>;
  status(context: Context, requestId: string): MaybePromise<TaskResult>;
}
export const MCP_CONNECTOR_STATUS_TOOL = "niaro_call_status";
const failedCall = Symbol("failedCall");
const connectorStatusSchema = z.object({ requestId: identifier }).strict();
const connectorStatusTool: Tool = {
  name: MCP_CONNECTOR_STATUS_TOOL,
  description:
    "Return the current status and result of an earlier service call by its requestId, for example after a person approved it.",
  inputSchema: inputSchema(connectorStatusSchema),
  annotations: { readOnlyHint: true, idempotentHint: true },
};

export interface McpHttpHandlerOptions<Context> {
  authenticate(request: IncomingMessage): MaybePromise<Context | null>;
  /** Exact HTTP(S) origins. An absent Origin is allowed for native MCP clients. */
  allowedOrigins: readonly string[];
  /** RFC 9728 discovery for an OAuth-capable owning resource server. */
  resourceMetadataUrl?: string;
  /** When supplied, reject every Host outside these exact host[:port] values. */
  allowedHosts?: readonly string[];
  tasks: McpTaskHandlers<Context>;
  connector?: McpConnectorHandlers<Context>;
  serverInfo?: { name: string; version: string };
}

/** Only use public messages; other authentication errors are withheld. */
export class McpAuthenticationError extends Error {
  constructor(
    readonly status: 401 | 403,
    message = status === 401 ? "Authentication required." : "Access denied.",
  ) {
    super(message);
    this.name = "McpAuthenticationError";
  }
}

/** Deliberate, public application errors may be returned to the MCP client. */
export class McpTaskError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "McpTaskError";
  }
}

function httpError(response: ServerResponse, status: number, message: string) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message },
    }),
  );
}

function headerCount(request: IncomingMessage, name: string): number {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) count += 1;
  }
  return count;
}

function toolResult(result: TaskResult): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

async function invokeTool(
  operation: () => MaybePromise<TaskResult & { [failedCall]?: true }>,
): Promise<CallToolResult> {
  try {
    const { [failedCall]: failed, ...result } = await operation();
    // A connector call can complete as a recorded failure of the service
    // itself; task results keep their own status semantics.
    return failed
      ? { ...toolResult(result), isError: true }
      : toolResult(result);
  } catch (error) {
    const failure =
      error instanceof McpTaskError
        ? { code: error.code, message: error.message }
        : error instanceof z.ZodError
          ? {
              code: "invalid_task_input",
              message: "The task input is invalid.",
            }
          : { code: "task_failed", message: "The task operation failed." };
    return { ...toolResult({ error: failure }), isError: true };
  }
}

async function boundedGet(
  operation: () => MaybePromise<TaskResult>,
  waitMs: number,
): Promise<TaskResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new McpTaskError(
              "task_get_timeout",
              "The task status wait timed out. Query the same task again.",
            ),
          );
        }, waitMs + GET_HANDLER_GRACE_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function inputSchema(schema: z.ZodType): Tool["inputSchema"] {
  const jsonSchema = z.toJSONSchema(schema, { target: "draft-7", io: "input" });
  delete jsonSchema.$schema;
  const { properties: rawProperties, ...rest } = jsonSchema;
  const properties: Record<string, Record<string, unknown>> = {};
  for (const [name, property] of Object.entries(rawProperties ?? {})) {
    properties[name] =
      typeof property === "boolean"
        ? property
          ? {}
          : { not: {} }
        : { ...property };
  }
  return { ...rest, type: "object", properties };
}

// Keep validation and schema generation in the same Zod installation. The
// SDK's own peer may differ when it is also installed transitively by Mastra.
const taskTools: Tool[] = [
  {
    name: "task_submit",
    description:
      "Submit a task to the native assistant. Returns an application task handle; retry with the same requestId after a lost response.",
    inputSchema: inputSchema(mcpTaskSubmitSchema),
    annotations: { idempotentHint: true },
  },
  {
    name: "task_get",
    description:
      "Read a task and its current result or required human input. Optionally wait for a change for at most 10 seconds.",
    inputSchema: inputSchema(mcpTaskGetSchema),
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: "task_respond",
    description:
      "Answer the task's current human input request using its inputId and expectedRevision. Retry with the same requestId after a lost response.",
    inputSchema: inputSchema(mcpTaskRespondSchema),
    annotations: { idempotentHint: true },
  },
  {
    name: "task_cancel",
    description:
      "Explicitly request cancellation of a task. Closing an MCP connection never cancels accepted work.",
    inputSchema: inputSchema(mcpTaskCancelSchema),
    annotations: { idempotentHint: true },
  },
];

function createServer<Context>(
  options: McpHttpHandlerOptions<Context>,
  context: Context,
): Server {
  const server = new Server(
    options.serverInfo ?? { name: "niaro", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  const modes = options.connector?.modes(context) ?? {
    tasks: true,
    connector: false,
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...(modes.tasks ? taskTools : []),
      ...(modes.connector && options.connector
        ? [...(await options.connector.list(context)), connectorStatusTool]
        : []),
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
    if (request.params.task !== undefined) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "MCP task creation is not supported. Use the application's task_submit and task_get handles.",
      );
    }
    return invokeTool(() => {
      const args = request.params.arguments;
      const name = request.params.name;
      if (modes.tasks && name.startsWith("task_"))
        switch (name) {
          case "task_submit":
            return options.tasks.submit(
              context,
              mcpTaskSubmitSchema.parse(args),
            );
          case "task_get": {
            const input = mcpTaskGetSchema.parse(args);
            return boundedGet(
              () => options.tasks.get(context, input),
              input.waitMs,
            );
          }
          case "task_respond":
            return options.tasks.respond(
              context,
              mcpTaskRespondSchema.parse(args),
            );
          case "task_cancel":
            return options.tasks.cancel(
              context,
              mcpTaskCancelSchema.parse(args),
            );
        }
      if (modes.connector && options.connector) {
        if (name === MCP_CONNECTOR_STATUS_TOOL)
          return options.connector.status(
            context,
            connectorStatusSchema.parse(args).requestId,
          );
        return Promise.resolve(
          options.connector.call(context, name, args ?? {}, extra.signal),
        ).then((result) =>
          result.status === "failed"
            ? { ...result, [failedCall]: true as const }
            : result,
        );
      }
      throw new McpTaskError(
        "unknown_tool",
        "The requested tool is not available.",
      );
    });
  });
  return server;
}

/**
 * Stateless Streamable HTTP for the installed MCP SDK's 2025 protocol family.
 * The caller routes the MCP endpoint here. Application task state and ownership
 * remain in the native runtime, outside the lifetime of each SDK connection.
 */
export function createMcpHttpHandler<Context>(
  options: McpHttpHandlerOptions<Context>,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const allowedOrigins = new Set(options.allowedOrigins);
  const allowedHosts = options.allowedHosts
    ? new Set(options.allowedHosts.map((host) => host.toLowerCase()))
    : undefined;
  for (const origin of allowedOrigins) {
    const parsed = new URL(origin);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.origin !== origin
    ) {
      throw new Error("MCP allowedOrigins must contain exact HTTP(S) origins.");
    }
  }

  if (options.resourceMetadataUrl) {
    const metadata = new URL(options.resourceMetadataUrl);
    if (
      !["http:", "https:"].includes(metadata.protocol) ||
      metadata.username ||
      metadata.password ||
      metadata.hash ||
      metadata.search
    )
      throw new Error("MCP resource metadata URL must be an HTTP(S) URL.");
  }
  const challenge = options.resourceMetadataUrl
    ? `Bearer realm="mcp", resource_metadata="${options.resourceMetadataUrl}", scope="native.view native.run services.call"`
    : 'Bearer realm="mcp"';

  return async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const origin = request.headers.origin;
    if (
      headerCount(request, "origin") > 1 ||
      (origin !== undefined && !allowedOrigins.has(origin))
    ) {
      httpError(response, 403, "Origin is not allowed.");
      return;
    }
    const host = request.headers.host?.toLowerCase();
    if (
      allowedHosts &&
      (headerCount(request, "host") !== 1 ||
        host === undefined ||
        !allowedHosts.has(host))
    ) {
      httpError(response, 403, "Host is not allowed.");
      return;
    }

    let context: Context | null;
    try {
      context = await options.authenticate(request);
    } catch (error) {
      if (error instanceof McpAuthenticationError) {
        if (error.status === 401) {
          response.setHeader("WWW-Authenticate", challenge);
        }
        httpError(response, error.status, error.message);
      } else {
        httpError(response, 500, "Authentication could not be checked.");
      }
      return;
    }
    if (context == null) {
      response.setHeader("WWW-Authenticate", challenge);
      httpError(response, 401, "Authentication required.");
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      httpError(response, 405, "Method not allowed.");
      return;
    }

    const server = createServer(options, context);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: MAX_REQUEST_BYTES,
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } catch {
      httpError(response, 500, "MCP request failed.");
    } finally {
      // In JSON response mode handleRequest waits for the callback. Do not close
      // on socket disconnect: SDK close aborts requests, but accepted work must
      // finish its durable admission even when the acknowledgement is lost.
      await server.close();
    }
  };
}
