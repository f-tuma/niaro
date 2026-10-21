import type {
  Service,
  ServiceAction,
} from "../../packages/protocol/service-catalog";
import { MCP_CONNECTOR_STATUS_TOOL } from "../server-mcp/transport";
import type { StoredInvocation } from "./service-catalog";

/** Connector mode exposes each permitted, enabled catalog action as one MCP tool. */
const MAX_TOOL_NAME = 64;

export type ConnectorTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown> & { type: "object" };
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: true;
  };
  service: Service;
  action: ServiceAction;
};

const slug = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

/** Stable, readable tool names: `<service>__<action>`, unique within one listing. */
export function connectorTools(
  services: Service[],
  allowed: (action: ServiceAction) => boolean,
): ConnectorTool[] {
  const tools: ConnectorTool[] = [];
  const used = new Set<string>([MCP_CONNECTOR_STATUS_TOOL]);
  for (const service of services) {
    if (!service.enabled) continue;
    for (const action of service.actions) {
      if (!action.enabled || !allowed(action)) continue;
      const prefix = slug(service.name).slice(0, 24) || "service";
      let name = `${prefix}__${slug(action.name) || "action"}`.slice(
        0,
        MAX_TOOL_NAME,
      );
      if (used.has(name))
        name = `${name.slice(0, MAX_TOOL_NAME - 9)}_${action.id
          .replace(/[^A-Za-z0-9]/g, "")
          .slice(0, 8)}`;
      used.add(name);
      const notes = [
        action.effect === "write"
          ? `Changes data in ${service.name}.`
          : `Reads data from ${service.name}.`,
        action.approval === "always"
          ? `A person must approve each call in Niaro before it runs; the result then says where, and ${MCP_CONNECTOR_STATUS_TOOL} returns the outcome.`
          : "",
      ].filter(Boolean);
      tools.push({
        name,
        description: [action.description.trim(), ...notes]
          .filter(Boolean)
          .join("\n\n")
          .slice(0, 2000),
        inputSchema:
          action.inputSchema.type === "object"
            ? (action.inputSchema as ConnectorTool["inputSchema"])
            : { type: "object", ...action.inputSchema },
        annotations: {
          title: `${action.name} (${service.name})`,
          readOnlyHint: action.effect === "read",
          destructiveHint: action.effect === "write",
          openWorldHint: true,
        },
        service,
        action,
      });
    }
  }
  return tools;
}

/** An upstream MCP tool result arrives as text content; hand its data over
 * directly instead of nesting serialized JSON in another JSON document. */
function unwrap(result: unknown): unknown {
  if (
    !result ||
    typeof result !== "object" ||
    !Array.isArray((result as { content?: unknown }).content)
  )
    return result ?? null;
  const content = (result as { content: unknown[] }).content;
  if (
    !content.every(
      (item) =>
        !!item &&
        typeof item === "object" &&
        (item as { type?: unknown }).type === "text" &&
        typeof (item as { text?: unknown }).text === "string",
    )
  )
    return result;
  const values = content.map((item) => {
    const text = (item as { text: string }).text;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  });
  return values.length === 1 ? values[0] : values;
}

/** Public, client-safe view of one connector call receipt. */
export function connectorResult(
  receipt: StoredInvocation,
  approvalUrl: string,
): Record<string, unknown> {
  const base = {
    requestId: receipt.id,
    tool: receipt.title,
    service: receipt.serviceName,
    status: receipt.status,
  };
  switch (receipt.status) {
    case "succeeded":
      return { ...base, result: unwrap(receipt.result) };
    case "awaiting_approval":
      return {
        ...base,
        approvalUrl,
        message: `This call needs a person's approval. Ask them to open ${approvalUrl}, then call ${MCP_CONNECTOR_STATUS_TOOL} with this requestId.`,
      };
    case "running":
      return {
        ...base,
        message: `The call is still running. Call ${MCP_CONNECTOR_STATUS_TOOL} with this requestId later.`,
      };
    case "rejected":
      return { ...base, message: "A person declined this call." };
    case "unknown":
      return {
        ...base,
        failure: receipt.failure ?? null,
        message:
          "The service may have applied this change, but its result is unconfirmed. Check the data before retrying.",
      };
    default:
      return { ...base, failure: receipt.failure ?? null };
  }
}
