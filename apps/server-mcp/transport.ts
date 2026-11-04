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

const MAX_REQUEST_BYTES = 64 * 1024;

type ToolResult = Record<string, unknown>;
type MaybePromise<T> = T | Promise<T>;

/** One answer of a tool: its data, marked as an error when it is one. */
export type McpToolOutcome = { result: ToolResult; isError?: boolean };

/** Context is resolved for every HTTP request by the owning server. */
export interface McpToolHandlers<Context> {
  /** The tools this authenticated context may see, computed per request. */
  list(context: Context): MaybePromise<Tool[]>;
  call(
    context: Context,
    name: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): MaybePromise<McpToolOutcome>;
}

export interface McpHttpHandlerOptions<Context> {
  authenticate(request: IncomingMessage): MaybePromise<Context | null>;
  /** Exact HTTP(S) origins. An absent Origin is allowed for native MCP clients. */
  allowedOrigins: readonly string[];
  /** RFC 9728 discovery for an OAuth-capable owning resource server. */
  resourceMetadataUrl?: string;
  /** Scopes named in the 401 challenge next to the resource metadata. */
  scopes?: readonly string[];
  /** When supplied, reject every Host outside these exact host[:port] values. */
  allowedHosts?: readonly string[];
  tools: McpToolHandlers<Context>;
  /** How a client's model should use this server (MCP `instructions`). */
  instructions?: string;
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
export class McpToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "McpToolError";
  }
}

const describe = (path: PropertyKey[]) =>
  path.length
    ? path
        .map((part, index) =>
          typeof part === "number"
            ? `[${part}]`
            : `${index ? "." : ""}${String(part)}`,
        )
        .join("")
    : "(input)";

/**
 * A validation failure as the client's model can fix it: every wrong field
 * with what it expects, and optionally a correct example call.
 */
export function invalidInput(error: z.ZodError, example?: unknown) {
  const fields = error.issues.slice(0, 10).map((issue) => {
    if (issue.code === "unrecognized_keys")
      return `${describe(issue.path)}: unknown field(s) ${issue.keys.join(", ")}; remove them.`;
    return `${describe(issue.path)}: ${issue.message}`;
  });
  return new McpToolError(
    "invalid_input",
    [
      `The input is invalid. ${fields.join(" ")}`,
      example === undefined
        ? ""
        : `A correct call looks like ${JSON.stringify(example)}.`,
    ]
      .filter(Boolean)
      .join(" ")
      .slice(0, 2_000),
  );
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

function toolResult(result: ToolResult): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

async function invokeTool(
  operation: () => MaybePromise<McpToolOutcome>,
): Promise<CallToolResult> {
  try {
    const { result, isError } = await operation();
    return isError
      ? { ...toolResult(result), isError: true }
      : toolResult(result);
  } catch (error) {
    const failure =
      error instanceof McpToolError
        ? error
        : error instanceof z.ZodError
          ? invalidInput(error)
          : new McpToolError("tool_failed", "The tool call failed.");
    return {
      ...toolResult({
        error: { code: failure.code, message: failure.message },
      }),
      isError: true,
    };
  }
}

/** A tool's JSON Schema from its Zod schema, as MCP clients read it. */
export function inputSchema(schema: z.ZodType): Tool["inputSchema"] {
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

function createServer<Context>(
  options: McpHttpHandlerOptions<Context>,
  context: Context,
): Server {
  const server = new Server(
    options.serverInfo ?? { name: "niaro", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      ...(options.instructions ? { instructions: options.instructions } : {}),
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await options.tools.list(context),
  }));
  server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
    if (request.params.task !== undefined) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "MCP task creation is not supported. Call the tool directly.",
      );
    }
    return invokeTool(() =>
      options.tools.call(
        context,
        request.params.name,
        request.params.arguments ?? {},
        extra.signal,
      ),
    );
  });
  return server;
}

/**
 * Stateless Streamable HTTP for the installed MCP SDK's 2025 protocol family.
 * The caller routes the MCP endpoint here; every request authenticates again.
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
    ? `Bearer realm="mcp", resource_metadata="${options.resourceMetadataUrl}"${
        options.scopes?.length ? `, scope="${options.scopes.join(" ")}"` : ""
      }`
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
      // on socket disconnect: SDK close aborts requests, but a started write
      // must reach its durable receipt even when the acknowledgement is lost.
      await server.close();
    }
  };
}
