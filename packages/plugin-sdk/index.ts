import { z } from "zod";

/**
 * The plugin SDK: types and a few helpers, nothing of the server.
 *
 * A plugin's entry module (index.ts) default-exports a function that receives
 * this SDK and returns `definePlugin({...})`. The module imports the SDK only
 * as a type, so it runs from any directory, including the server's data
 * directory, without resolving packages:
 *
 *   import type { PluginSdk } from "@niaro/plugin-sdk";
 *   export default ({ definePlugin, defineTool, z }: PluginSdk) =>
 *     definePlugin({ tools: [defineTool({ ... })] });
 *
 * See docs/plugins.md.
 */
export * from "./manifest";

/** A result value that the agent may forward into an action argument. */
export type Scalar = string | number | boolean;

/**
 * What a pure tool returns. `resolved` values are flat scalars (strings up to
 * 200 characters); each one can be bound into a later action as
 * `$plugin.result_N.<key>`. `clarification` stops the action flow and asks
 * the person (the reasons are the date and time ones).
 */
export type PureToolResult =
  | { status: "resolved"; values: Record<string, Scalar> }
  | {
      status: "clarification";
      reason:
        | "missing_time"
        | "invalid_date"
        | "ambiguous_time"
        | "nonexistent_time"
        | "invalid_offset";
      timeZone: string;
      localDateTime?: string;
      alternatives?: { utc: string; utcOffset: string }[];
    };

export type MemoryKind = "preference" | "fact" | "note";
/** A saved memory as the agent sees it: attributed data, never instructions. */
export type MemoryRecord = {
  id: string;
  revision: number;
  content: string | null;
  kind: MemoryKind;
  scope: "private" | "workspace";
  source: unknown;
  trust: string | null;
  expiresAt: string | null;
};
/** A committed change to saved memory. */
export type MemoryReceipt = { id: string; revision: number; status: string };

/**
 * The host's saved-memory store for the person and workspace of the turn.
 * The host keeps the guarantees: one transaction per change, retries reuse
 * the first result, attribution to the actual chat message, revisions.
 */
export interface MemoryCapability {
  search(query?: string): Promise<{ version: number; items: MemoryRecord[] }>;
  remember(input: {
    content: string;
    kind: MemoryKind;
  }): Promise<MemoryReceipt>;
  /** null: no active private record with this id and exactly this content. */
  forget(input: {
    id: string;
    revision: number;
    expectedContent: string;
  }): Promise<MemoryReceipt | null>;
  revise(input: {
    id: string;
    revision: number;
    expectedContent: string;
    content: string;
  }): Promise<MemoryReceipt | { error: "memory_selection_ambiguous" }>;
}

/** One web search hit, as the search engine described it. */
export type WebSearchResult = {
  title: string;
  url: string;
  /** A short excerpt of the page, when the engine gave one. */
  snippet: string;
  /** The page's publication date (YYYY-MM-DD), when known. */
  date?: string;
};
/** One public page, already converted to readable text. */
export type WebPage = {
  /** The address asked for, and where the page was after redirects. */
  url: string;
  finalUrl: string;
  contentType: string;
  title: string | null;
  /** HTML as text with Markdown links ([text](url)); other types as sent. */
  text: string;
  /** The server cut the page (size or conversion limits). */
  truncated: boolean;
};
/**
 * The public web, through the server. The host keeps the guarantees: public
 * addresses only (every redirect re-checked), size and time limits, allowed
 * content types, a cap on calls per agent run, the workspace's model and
 * inference budget for searches, and operator logs without content. A
 * refused or failed call throws; the host turns it into `{ error }` for the
 * model, so a tool does not need to catch.
 */
export interface WebCapability {
  search(input: {
    query: string;
    /** 1–8 results. */
    limit: number;
    /** A hint for the engine; not every engine filters by date. */
    freshness?: "day" | "week" | "month" | "year";
    /** A model ID of the workspace's AI models; empty: its chat model. */
    model?: string;
    /** exa (default), native (the model provider's own search) or auto. */
    engine?: "exa" | "native" | "auto";
    /** Only providers that keep no data (default true). */
    zeroDataRetention?: boolean;
  }): Promise<{ results: WebSearchResult[]; model: string }>;
  fetch(url: string): Promise<WebPage>;
}

export interface PluginLogger {
  info(message: string, details?: Record<string, Scalar>): void;
  warn(message: string, details?: Record<string, Scalar>): void;
  error(message: string, details?: Record<string, Scalar>): void;
}

/** Everything a tool gets besides its input. Nothing else of the server is reachable. */
export interface ToolContext {
  pluginId: string;
  /** The turn's reference instant (ISO, UTC). A retried turn keeps it. */
  now: string;
  /** The person's IANA time zone for this turn: device, else workspace default. */
  timeZone: string;
  /** This workspace's values of the settings in plugin.json. */
  settings: Readonly<Record<string, Scalar>>;
  workspaceId?: string;
  /** The person the agent works for. */
  personId?: string;
  /** The person's latest message. Context tools only. */
  request?: { text: string; commandId: string; conversationId?: string };
  /** Present when plugin.json asks for the memory capability. */
  memory?: MemoryCapability;
  /** Present when plugin.json asks for the web capability. */
  web?: WebCapability;
  log: PluginLogger;
}

export interface ToolDefinition<Input = unknown> {
  /** Must match a tool in plugin.json. */
  name: string;
  /** What the model reads to decide when and how to call the tool. */
  description: string;
  /** Validates the model's arguments; the JSON schema the model sees is made from it. */
  input: z.ZodType<Input>;
  /**
   * Pure tools return a PureToolResult synchronously. Context and network
   * tools return any JSON object, also as a promise.
   */
  run(input: Input, ctx: ToolContext): unknown;
}

export interface PluginDefinition {
  tools: ToolDefinition<never>[];
}

/** Types the tool's `run` from its input schema. Returns the tool unchanged. */
export function defineTool<Schema extends z.ZodType>(tool: {
  name: string;
  description: string;
  input: Schema;
  run(input: z.output<Schema>, ctx: ToolContext): unknown;
}): ToolDefinition<never> {
  return tool as unknown as ToolDefinition<never>;
}
export function definePlugin(plugin: PluginDefinition): PluginDefinition {
  return plugin;
}
/** Shorthand for a pure tool's successful result. */
export function resolved(values: Record<string, Scalar>): PureToolResult {
  return { status: "resolved", values };
}

/** What the server hands to a plugin's default export. */
export const sdk = { definePlugin, defineTool, resolved, z } as const;
export type PluginSdk = typeof sdk;
/** The default export of a plugin's index.ts. */
export type PluginModule = (sdk: PluginSdk) => PluginDefinition;

/** The JSON schema the model sees for a tool's input. */
export function toolParameters(tool: Pick<ToolDefinition, "input">) {
  const { $schema: _schema, ...schema } = z.toJSONSchema(tool.input, {
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  return schema;
}
