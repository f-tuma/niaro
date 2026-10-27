import { z } from "zod";
import {
  ActionSettings,
  type Service,
  type ServiceAction,
  type DiscoveryIssue,
  twentyReadTool,
} from "../../packages/protocol/service-catalog";
import {
  IntegrationError,
  jsonResponse,
  sameEndpoint,
  type IntegrationTransport,
  type DispatchGuard,
} from "./transport";
import {
  relaxToolSchema,
  SchemaError,
  schemaValidator,
  validateArguments,
} from "./schema";
import { mcpActionFailure, providerFailure } from "./failures";
export type DiscoveredAction = z.infer<typeof ActionSettings> & {
  sourceKey: string;
};
type Issue = z.infer<typeof DiscoveryIssue>;
function discoveryIssue(action: string, error: unknown): Issue {
  return {
    action: action.slice(0, 200),
    ...(error instanceof SchemaError
      ? error.issue
      : { reason: "operation_unsupported" as const }),
  };
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown, fallback: string, max: number) =>
  typeof value === "string" && value.trim()
    ? value.trim().slice(0, max)
    : fallback;
function resolveLocal(
  document: Record<string, unknown>,
  input: unknown,
  trail: string[] = [],
): Record<string, unknown> {
  const value = object(input);
  const ref = value.$ref;
  if (ref !== undefined) {
    if (
      typeof ref !== "string" ||
      !ref.startsWith("#/") ||
      trail.includes(ref) ||
      trail.length > 12
    )
      throw new IntegrationError("integration_schema_unsupported");
    let found: unknown = document;
    for (const key of ref
      .slice(2)
      .split("/")
      .map((v) => v.replace(/~1/g, "/").replace(/~0/g, "~"))) {
      if (["__proto__", "constructor", "prototype"].includes(key))
        throw new IntegrationError("integration_schema_unsupported");
      found = object(found)[key];
    }
    if (!found) throw new IntegrationError("integration_schema_unsupported");
    return resolveLocal(document, found, [...trail, ref]);
  }
  return value;
}
function expandSchema(
  document: Record<string, unknown>,
  value: unknown,
  depth = 0,
  budget = { nodes: 0, bytes: 0 },
): Record<string, unknown> {
  if (++budget.nodes > 1000 || depth > 12)
    throw new IntegrationError("integration_schema_unsupported");
  const schema = resolveLocal(document, value);
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(schema)) {
    budget.bytes += key.length + 4;
    if (budget.bytes > 32768)
      throw new IntegrationError("integration_schema_unsupported");
    if (
      [
        "readOnly",
        "writeOnly",
        "example",
        "examples",
        "deprecated",
        "xml",
        "externalDocs",
        "discriminator",
      ].includes(key)
    )
      continue;
    if (key === "properties")
      result[key] = Object.fromEntries(
        Object.entries(object(item)).map(([k, v]) => {
          budget.bytes += JSON.stringify(k).length + 1;
          if (k.length > 200 || budget.bytes > 32768)
            throw new IntegrationError("integration_schema_unsupported");
          return [k, expandSchema(document, v, depth + 1, budget)];
        }),
      );
    else if (
      ["items", "additionalProperties"].includes(key) &&
      typeof item === "object"
    )
      result[key] = expandSchema(document, item, depth + 1, budget);
    else if (["anyOf", "oneOf", "allOf"].includes(key) && Array.isArray(item))
      result[key] = item.map((v) =>
        expandSchema(document, v, depth + 1, budget),
      );
    else {
      budget.bytes += JSON.stringify(item).length;
      if (budget.bytes > 32768)
        throw new IntegrationError("integration_schema_unsupported");
      result[key] = item;
    }
  }
  return result;
}
export function discoverOpenAPI(raw: unknown, baseUrl?: string) {
  const doc = object(raw);
  if (typeof doc.openapi !== "string" || !/^3\.[01]\./.test(doc.openapi))
    throw new IntegrationError("integration_openapi_required");
  if (Array.isArray(doc.servers) && doc.servers.length) {
    if (
      !baseUrl ||
      !doc.servers.some((server) => {
        const value = object(server);
        if (typeof value.url !== "string" || value.variables) return false;
        try {
          return (
            new URL(value.url, baseUrl).href.replace(/\/$/, "") ===
            new URL(baseUrl).href.replace(/\/$/, "")
          );
        } catch {
          return false;
        }
      })
    )
      throw new IntegrationError("integration_openapi_base_mismatch");
  }
  const actions: DiscoveredAction[] = [];
  const warnings: string[] = [];
  const issues: Issue[] = [];
  const paths = Object.entries(object(doc.paths));
  if (paths.length > 500)
    throw new IntegrationError("integration_catalog_too_large");
  for (const [path, rawPath] of paths) {
    let pathItem: Record<string, unknown>;
    try {
      pathItem = resolveLocal(doc, rawPath);
    } catch (error) {
      issues.push(discoveryIssue(path, error));
      warnings.push(path.slice(0, 200));
      continue;
    }
    for (const method of ["get", "post", "put", "patch", "delete"] as const) {
      if (!pathItem[method]) continue;
      const sourceKey = `${method.toUpperCase()} ${path}`;
      try {
        const operation = resolveLocal(doc, pathItem[method]);
        if (operation.callbacks || operation.servers || pathItem.servers)
          throw new IntegrationError("integration_schema_unsupported");
        const parameters = [
          ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
          ...(Array.isArray(operation.parameters) ? operation.parameters : []),
        ].map((p) => resolveLocal(doc, p));
        const properties: Record<string, unknown> = {};
        const required: string[] = [];
        const bindingParameters: {
          name: string;
          in: "path" | "query";
          required: boolean;
        }[] = [];
        for (const param of parameters) {
          if (
            !["query", "path"].includes(String(param.in)) ||
            typeof param.name !== "string" ||
            (param.style &&
              !["form", "simple"].includes(String(param.style))) ||
            param.explode === false ||
            param.allowReserved
          )
            throw new IntegrationError("integration_schema_unsupported");
          const schema = expandSchema(doc, param.schema);
          if (
            !["string", "number", "integer", "boolean"].includes(
              String(schema.type),
            ) ||
            properties[param.name]
          )
            throw new IntegrationError("integration_schema_unsupported");
          properties[param.name] = schema;
          const isRequired = param.required === true || param.in === "path";
          if (isRequired) required.push(param.name);
          bindingParameters.push({
            name: param.name,
            in: param.in as "path" | "query",
            required: isRequired,
          });
        }
        const requestBody = resolveLocal(doc, operation.requestBody);
        const hasBody = !!operation.requestBody;
        if (hasBody) {
          const media = object(object(requestBody.content)["application/json"]);
          if (!media.schema || properties.body)
            throw new IntegrationError("integration_schema_unsupported");
          properties.body = expandSchema(doc, media.schema);
          if (requestBody.required) required.push("body");
        }
        const inputSchema = {
          type: "object",
          properties,
          required,
          additionalProperties: false,
        };
        schemaValidator(inputSchema);
        const action = ActionSettings.parse({
          name: text(
            operation.summary,
            text(operation.operationId, sourceKey, 100),
            100,
          ),
          description: text(operation.description, "", 2000),
          inputSchema,
          binding: {
            type: "http",
            method: method.toUpperCase(),
            path,
            parameters: bindingParameters,
            body: hasBody,
          },
          effect: method === "get" ? "read" : "write",
          approval: "always",
          enabled: false,
          policy: { roles: [], users: [] },
        });
        actions.push({ ...action, sourceKey });
        if (actions.length > 200)
          throw new IntegrationError("integration_catalog_too_large");
      } catch (error) {
        if (
          error instanceof IntegrationError &&
          error.code === "integration_catalog_too_large"
        )
          throw error;
        issues.push(discoveryIssue(sourceKey, error));
        warnings.push(sourceKey.slice(0, 200));
      }
    }
  }
  return {
    actions,
    warnings: warnings.slice(0, 100),
    issues: issues.slice(0, 100),
  };
}
export class McpSession {
  private session?: string;
  private seq = 0;
  private serverName = "";
  /** Ephemeral redaction values only; response headers are never persisted. */
  private responseSecrets: string[] = [];
  private responseSecretsComplete = true;
  constructor(
    private transport: IntegrationTransport,
    private url: string,
    private headers: Record<string, string>,
    private signal?: AbortSignal,
    private beforeDispatch?: DispatchGuard,
    private onActionDispatch?: () => void,
  ) {}
  private failureOptions(
    stage: "connection" | "provider_response" = "provider_response",
    httpStatus?: number,
  ) {
    return {
      stage,
      ...(httpStatus === undefined ? {} : { httpStatus }),
      secretValues: [
        ...Object.values(this.headers),
        ...(this.session ? [this.session] : []),
        ...this.responseSecrets,
      ],
      omitText: !this.responseSecretsComplete,
    };
  }
  private async send(method: string, params?: unknown, notification = false) {
    const id = ++this.seq;
    const response = await this.transport({
      url: this.url,
      method: "POST",
      responseId: notification ? undefined : id,
      headers: {
        ...this.headers,
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
        ...(this.session ? { "Mcp-Session-Id": this.session } : {}),
      },
      body: {
        jsonrpc: "2.0",
        ...(!notification ? { id } : {}),
        method,
        ...(params ? { params } : {}),
      },
      signal: this.signal,
      beforeDispatch:
        this.beforeDispatch || this.onActionDispatch
          ? async (start) => {
              const dispatch = () => {
                this.signal?.throwIfAborted();
                if (method === "tools/call") this.onActionDispatch?.();
                start();
              };
              if (this.beforeDispatch) await this.beforeDispatch(dispatch);
              else dispatch();
            }
          : undefined,
    });
    const responseSecrets = [
      ...new Set([
        ...this.responseSecrets,
        ...Object.entries(response.headers)
          .filter(([name]) =>
            /cookie|authorization|token|session|api.?key/i.test(name),
          )
          .map(([, value]) => value),
      ]),
    ];
    if (
      responseSecrets.length > 128 ||
      responseSecrets.reduce((size, value) => size + value.length, 0) > 32768
    ) {
      this.responseSecretsComplete = false;
      this.responseSecrets = [];
    } else this.responseSecrets = responseSecrets;
    if (response.status < 200 || response.status >= 300)
      throw new IntegrationError(
        "integration_provider_failed",
        502,
        providerFailure(
          response.text,
          this.failureOptions(
            method === "tools/call" ? "provider_response" : "connection",
            response.status,
          ),
        ),
      );
    const session = response.headers["mcp-session-id"];
    if (session) {
      if (!/^[\x21-\x7e]{1,256}$/.test(session))
        throw new IntegrationError("integration_response_invalid", 502);
      this.session = session;
    }
    if (notification) return {};
    let values: unknown[];
    try {
      values = response.headers["content-type"]?.includes("text/event-stream")
        ? response.text
            .split(/\r?\n\r?\n/)
            .map((event) =>
              event
                .split(/\r?\n/)
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart())
                .join("\n"),
            )
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [JSON.parse(response.text)];
    } catch {
      throw new IntegrationError("integration_response_invalid", 502);
    }
    // Server initiated requests are not executed. Match only the requested JSON-RPC result.
    const value = values.map(object).find((v) => v.id === id);
    if (!value || value.jsonrpc !== "2.0")
      throw new IntegrationError("integration_response_invalid", 502);
    if (value.error)
      throw new IntegrationError(
        "integration_provider_failed",
        502,
        providerFailure(
          value.error,
          this.failureOptions(
            method === "tools/call" ? "provider_response" : "connection",
          ),
        ),
      );
    if (!value.result)
      throw new IntegrationError("integration_response_invalid", 502);
    return object(value.result);
  }
  async initialize() {
    const result = await this.send("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "agent-server", version: "0.2.0" },
    });
    if (
      result.protocolVersion !== "2025-06-18" ||
      !object(result.capabilities).tools
    )
      throw new IntegrationError("integration_mcp_unsupported");
    this.serverName = text(object(result.serverInfo).name, "", 128);
    await this.send("notifications/initialized", undefined, true);
  }
  async discover(toolNames?: string[]): Promise<{
    actions: DiscoveredAction[];
    warnings: string[];
    issues?: Issue[];
    remaining?: string[];
    /** Tools the server labels read-only (`readOnlyHint`, Twenty's read names): a hint, not applied. */
    readOnly?: string[];
    choices?: {
      name: string;
      description: string;
      category: string;
      sourceKey: string;
    }[];
  }> {
    const actions: DiscoveredAction[] = [];
    const warnings: string[] = [];
    const issues: Issue[] = [];
    const readOnly: string[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 10; page++) {
      const result = await this.send("tools/list", cursor ? { cursor } : {});
      if (!Array.isArray(result.tools))
        throw new IntegrationError("integration_response_invalid", 502);
      for (const raw of result.tools) {
        const tool = object(raw),
          name = text(tool.name, "", 128);
        try {
          if (!name || seen.has(name))
            throw new IntegrationError("integration_response_invalid");
          seen.add(name);
          // A later request asks for the rest by name; the others are skipped.
          if (!toolNames || toolNames.includes(name)) {
            const inputSchema = relaxToolSchema(object(tool.inputSchema));
            schemaValidator(inputSchema);
            actions.push({
              ...ActionSettings.parse({
                name: text(tool.title, name, 100),
                description: text(tool.description, "", 2000),
                inputSchema,
                binding: { type: "mcp", name },
                effect: "write",
                approval: "always",
                enabled: false,
                policy: { roles: [], users: [] },
              }),
              sourceKey: `mcp:${name}`,
            });
            if (object(tool.annotations).readOnlyHint === true)
              readOnly.push(name);
          }
        } catch (error) {
          issues.push(discoveryIssue(name, error));
          warnings.push(name);
        }
        if (seen.size > 200)
          throw new IntegrationError("integration_catalog_too_large");
      }
      if (!result.nextCursor) {
        if (
          this.serverName === "Twenty MCP Server" &&
          ["get_tool_catalog", "learn_tools", "execute_tool"].every((name) =>
            seen.has(name),
          )
        ) {
          return this.discoverTwenty(toolNames);
        }
        return { actions, warnings, issues, readOnly };
      }
      if (
        typeof result.nextCursor !== "string" ||
        result.nextCursor === cursor ||
        result.nextCursor.length > 2048
      )
        break;
      cursor = result.nextCursor;
    }
    throw new IntegrationError("integration_catalog_too_large");
  }
  private async toolData(name: string, input: unknown) {
    const result = await this.invoke(name, input);
    if (result.structuredContent) return object(result.structuredContent);
    const content = result.content;
    if (!Array.isArray(content))
      throw new IntegrationError("integration_response_invalid", 502);
    const blocks = content.map(object).filter((block) => block.type === "text");
    if (blocks.length !== 1 || typeof blocks[0]!.text !== "string")
      throw new IntegrationError("integration_response_invalid", 502);
    try {
      return object(JSON.parse(blocks[0]!.text));
    } catch {
      throw new IntegrationError("integration_response_invalid", 502);
    }
  }
  private async discoverTwenty(toolNames?: string[]) {
    const data = await this.toolData("get_tool_catalog", {});
    const catalog = object(data.catalog);
    const choices: {
      name: string;
      description: string;
      category: string;
      sourceKey: string;
    }[] = [];
    const seen = new Set<string>();
    for (const [category, entries] of Object.entries(catalog)) {
      if (!Array.isArray(entries) || category.length > 100)
        throw new IntegrationError("integration_response_invalid", 502);
      for (const entry of entries) {
        const tool = object(entry);
        if (
          typeof tool.name !== "string" ||
          !tool.name ||
          tool.name.length > 128 ||
          seen.has(tool.name)
        )
          throw new IntegrationError("integration_response_invalid", 502);
        seen.add(tool.name);
        choices.push({
          name: tool.name,
          description: text(tool.description, "", 2000),
          category,
          sourceKey: `mcp:execute_tool:${tool.name}`,
        });
        if (choices.length > 1000)
          throw new IntegrationError("integration_catalog_too_large");
      }
    }
    if (!Object.keys(catalog).length)
      throw new IntegrationError("integration_response_invalid", 502);
    if (!toolNames) return { actions: [], warnings: [], choices };
    if (
      !toolNames.length ||
      toolNames.length > 1000 ||
      new Set(toolNames).size !== toolNames.length ||
      toolNames.some((name) => !seen.has(name))
    )
      throw new IntegrationError("integration_input_invalid");
    const actions: DiscoveredAction[] = [],
      warnings: string[] = [];
    const issues: Issue[] = [];
    // Twenty names its record reads find_many_, find_one_ and group_by_: a
    // hint like readOnlyHint, applied only when an administrator says so.
    const readOnly: string[] = [];
    const category = new Map(choices.map((c) => [c.name, c.category]));
    const pending = toolNames.slice(0, 20);
    // The server chooses batch sizes; the console can select the entire catalogue.
    for (let offset = 0; offset < pending.length; offset += 4) {
      const batch = pending.slice(offset, offset + 4);
      const learned = await this.toolData("learn_tools", {
        toolNames: batch,
        aspects: ["description", "schema"],
      });
      if (!Array.isArray(learned.tools))
        throw new IntegrationError("integration_response_invalid", 502);
      const byName = new Map<string, Record<string, unknown>>();
      for (const raw of learned.tools) {
        const tool = object(raw);
        if (
          typeof tool.name !== "string" ||
          !batch.includes(tool.name) ||
          byName.has(tool.name)
        )
          throw new IntegrationError("integration_response_invalid", 502);
        byName.set(tool.name, tool);
      }
      for (const name of batch) {
        const tool = byName.get(name);
        if (!tool) {
          issues.push({ action: name, reason: "metadata_missing" });
          warnings.push(name);
          continue;
        }
        try {
          const inputSchema = relaxToolSchema(object(tool.inputSchema));
          schemaValidator(inputSchema);
          actions.push({
            ...ActionSettings.parse({
              name: text(tool.name, name, 100),
              description: text(tool.description, "", 2000),
              inputSchema,
              binding: { type: "mcp", name: "execute_tool", catalogTool: name },
              effect: "write",
              approval: "always",
              enabled: false,
              policy: { roles: [], users: [] },
            }),
            sourceKey: `mcp:execute_tool:${name}`,
          });
          if (category.get(name) === "DATABASE_CRUD" && twentyReadTool(name))
            readOnly.push(`execute_tool:${name}`);
        } catch (error) {
          issues.push(discoveryIssue(name, error));
          warnings.push(name);
        }
      }
    }
    return {
      actions,
      warnings,
      issues,
      readOnly,
      remaining: toolNames.slice(pending.length),
    };
  }
  async invoke(name: string, input: unknown) {
    const result = await this.send("tools/call", { name, arguments: input });
    if (result.isError !== undefined && typeof result.isError !== "boolean")
      throw new IntegrationError("integration_response_invalid", 502);
    const failure = mcpActionFailure(result, this.failureOptions());
    if (failure)
      throw new IntegrationError("integration_provider_failed", 502, failure);
    return result;
  }
}
export async function invokeAction(
  transport: IntegrationTransport,
  service: Service,
  action: ServiceAction,
  key: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
  beforeDispatch: DispatchGuard,
  onActionDispatch?: () => void,
) {
  validateArguments(action.inputSchema, input);
  const headers = authHeaders(service.auth, key);
  if (action.binding.type === "mcp") {
    const mcp = new McpSession(
      transport,
      service.url,
      headers,
      signal,
      beforeDispatch,
      onActionDispatch,
    );
    await mcp.initialize();
    return mcp.invoke(
      action.binding.name,
      action.binding.catalogTool
        ? { toolName: action.binding.catalogTool, arguments: input }
        : input,
    );
  }
  let path = action.binding.path;
  if (
    path.split("/").some((segment) => [".", ".."].includes(segment)) ||
    /%2e|%2f|%5c/i.test(path)
  )
    throw new IntegrationError("integration_path_denied", 403);
  const query = new URLSearchParams();
  for (const param of action.binding.parameters) {
    const value = input[param.name];
    if (value === undefined) {
      if (param.required)
        throw new IntegrationError("integration_input_invalid");
      continue;
    }
    if (!["string", "number", "boolean"].includes(typeof value))
      throw new IntegrationError("integration_input_invalid");
    if (param.in === "path") {
      if (/[\/\\]/.test(String(value)) || [".", ".."].includes(String(value)))
        throw new IntegrationError("integration_input_invalid");
      path = path.replaceAll(
        `{${param.name}}`,
        encodeURIComponent(String(value)),
      );
    } else query.set(param.name, String(value));
  }
  if (/[{}]/.test(path))
    throw new IntegrationError("integration_input_invalid");
  const url = sameEndpoint(service.url, service.url.replace(/\/$/, "") + path);
  url.search = query.toString();
  const response = await transport({
    url: url.href,
    method: action.binding.method,
    headers,
    body: action.binding.body ? input.body : undefined,
    signal,
    beforeDispatch: (start) =>
      beforeDispatch(() => {
        signal.throwIfAborted();
        onActionDispatch?.();
        start();
      }),
  });
  if (response.status === 204) return { ok: true };
  return jsonResponse(response, [key, ...Object.values(headers)]);
}
export function authHeaders(
  auth: Service["auth"],
  key: string,
): Record<string, string> {
  return auth.type === "none"
    ? {}
    : auth.type === "bearer"
      ? { Authorization: `Bearer ${key}` }
      : { [auth.header]: key };
}
