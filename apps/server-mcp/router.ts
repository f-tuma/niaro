import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { fitReadResult } from "../server-identity/result-budget";
import {
  inputSchema,
  invalidInput,
  McpToolError,
  type McpToolHandlers,
  type McpToolOutcome,
} from "./transport";

/**
 * Niaro as a router for the person's own AI app: the app's model does the
 * thinking, Niaro supplies the person's data and permitted actions. Nothing
 * here calls a model on the Niaro server.
 */
export const MCP_CONNECTOR_STATUS_TOOL = "niaro_call_status";
export const MCP_RESULT_MAX_CHARACTERS = 64_000;

/** The scope names; the grant store owns them (`MCP_ACCESS_SCOPES`). */
type Scope = "data.read" | "memory.write" | "services.call";

const require = createRequire(import.meta.url);
function packageVersion() {
  try {
    const version = (require("../../package.json") as { version?: unknown })
      .version;
    return typeof version === "string" ? version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
export const MCP_SERVER_INFO = { name: "niaro", version: packageVersion() };

export const MCP_SERVER_INSTRUCTIONS = `Niaro is this person's work assistant and memory. It holds their meetings (summaries, decisions, action items, transcripts), their tasks, their chats with Niaro and what Niaro has learned about them, plus the company services their workspace connects.

Search first: before asking the person about their meetings, tasks, colleagues, customers or projects, call niaro_search. Open a meeting with niaro_meeting_get and list open work with niaro_tasks_list.

Remember the person: during the conversation, proactively save durable facts about them with niaro_memory_save, without being asked. Good facts: preferences, working style, the people they work with and their roles, their projects, decisions they made, recurring needs. Write one concise fact per item, in the person's language, phrased about the person (e.g. "Prefers short answers in Czech."). Do not save transient chit-chat, one-off requests, guesses, secrets or credentials, or sensitive data about other people. Before saving, check niaro_search with kinds ["memory"] (or niaro_memory_list) so you do not save a duplicate. The person sees and can delete everything saved in their Niaro profile.

Service actions: tools named <service>__<action> run actions in the workspace's connected services. A write may need the person's approval in Niaro: when the result has status "awaiting_approval", show the person the approvalUrl, and after they approve call niaro_call_status with the requestId. Pass a requestId of your own on writes and reuse it when retrying after a lost response, so nothing runs twice. A status "unknown" means the change may have happened: check before retrying.

Results are cut at 64,000 characters; when a result says truncated, narrow the query or use the cursor to page.`;

const KINDS = ["meetings", "tasks", "memory", "chats"] as const;
type Kind = (typeof KINDS)[number];
const detail = z
  .enum(["concise", "full"])
  .default("concise")
  .describe(
    'How much to return: "concise" (default) or "full" for every field.',
  );
const cursor = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[A-Za-z0-9_.:-]+$/, "Use the nextCursor of the previous result.")
  .describe("The nextCursor from the previous page; omit for the first page.");
const text = (max: number, what: string) =>
  z
    .string()
    .trim()
    .min(1, `Give ${what}.`)
    .max(max, `Use at most ${max} characters.`);

export const searchSchema = z.strictObject({
  query: text(200, "words to search for").describe(
    'What to look for, e.g. a person, customer, project or topic ("Novák budget").',
  ),
  kinds: z
    .array(z.enum(KINDS))
    .min(1)
    .max(4)
    .optional()
    .describe(
      "Limit the search to these kinds; all kinds when omitted. memory = what Niaro knows about the person.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(25)
    .default(10)
    .describe("Hits per page, 1-25."),
  cursor: cursor.optional(),
  detail,
});
export const meetingSchema = z.strictObject({
  meetingId: z
    .string()
    .uuid("Use the id of a meeting hit from niaro_search.")
    .describe("The meeting's id from niaro_search."),
  cursor: cursor
    .optional()
    .describe("The transcript's nextCursor to read its next page."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(300)
    .default(80)
    .describe("Transcript turns per page, 1-300."),
  detail,
});
export const tasksSchema = z.strictObject({
  status: z
    .enum(["open", "done"])
    .default("open")
    .describe('"open" (default) for work still to do, "done" for finished.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Tasks per page, 1-100."),
  cursor: cursor.optional(),
  detail,
});
export const memorySaveSchema = z.strictObject({
  facts: z
    .array(
      z.strictObject({
        text: text(500, "the fact").describe(
          "One concise, durable fact about the person, in their language.",
        ),
        kind: z
          .enum(["fact", "preference", "note"])
          .default("fact")
          .describe(
            '"preference" for how they like things done, "fact" otherwise.',
          ),
      }),
    )
    .min(1, "Give at least one fact.")
    .max(10, "Save at most 10 facts per call.")
    .describe("1-10 facts, each at most 500 characters."),
});
export const memoryListSchema = z.strictObject({
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(50)
    .describe("Memories per page, 1-100."),
  cursor: cursor.optional(),
  detail,
});
const statusSchema = z.strictObject({
  requestId: z
    .string()
    .regex(
      /^[A-Za-z0-9._:-]{1,160}$/,
      "Use the requestId returned by the service call.",
    )
    .describe("The requestId returned by the earlier service call."),
});

export type SearchInput = z.output<typeof searchSchema>;
export type MeetingInput = z.output<typeof meetingSchema>;
export type TasksInput = z.output<typeof tasksSchema>;
export type MemorySaveInput = z.output<typeof memorySaveSchema>;
export type MemoryListInput = z.output<typeof memoryListSchema>;

/** One search hit: short, with the id a follow-up call needs. */
export type SearchHit = {
  kind: Kind;
  id: string;
  title: string;
  date: string | null;
  snippet?: string;
  [field: string]: unknown;
};
export type KindSearch<Context> = (
  context: Context,
  query: string,
  offset: number,
  take: number,
  full: boolean,
) => Promise<{ hits: SearchHit[]; more: boolean }>;

export interface McpRouterBackend<Context> {
  scopes(context: Context): readonly string[];
  search: Partial<Record<Kind, KindSearch<Context>>>;
  meeting(
    context: Context,
    input: MeetingInput,
  ): Promise<Record<string, unknown>>;
  tasks(context: Context, input: TasksInput): Promise<Record<string, unknown>>;
  memorySave(
    context: Context,
    input: MemorySaveInput,
  ): Promise<Record<string, unknown>>;
  memoryList(
    context: Context,
    input: MemoryListInput,
  ): Promise<Record<string, unknown>>;
  /** One audit entry per read, source `mcp`; writes audit in their own path. */
  audit?(context: Context, tool: string, outcome: "succeeded" | "failed"): void;
  connector?: {
    list(context: Context): Promise<Tool[]>;
    call(
      context: Context,
      name: string,
      input: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<Record<string, unknown>>;
    status(
      context: Context,
      requestId: string,
    ): Promise<Record<string, unknown>>;
  };
}

type Definition = {
  tool: Tool;
  scope: Scope;
  schema: z.ZodType;
  example: Record<string, unknown>;
};
const readOnly = (title: string) => ({
  title,
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});
const definitions: Definition[] = [
  {
    scope: "data.read",
    schema: searchSchema,
    example: { query: "Novák budget", kinds: ["meetings", "tasks"] },
    tool: {
      name: "niaro_search",
      description:
        "Search the person's Niaro data: meetings (titles, summaries, transcripts), tasks, chats with Niaro and memory (what Niaro knows about the person). Use it before asking the person about their meetings, tasks, colleagues, customers or projects. Returns short hits with kind, title, date, snippet and the id for niaro_meeting_get.",
      inputSchema: inputSchema(searchSchema),
      annotations: readOnly("Search Niaro"),
    },
  },
  {
    scope: "data.read",
    schema: meetingSchema,
    example: { meetingId: "1b4e28ba-2fa1-4d2b-883f-0016d3cca427" },
    tool: {
      name: "niaro_meeting_get",
      description:
        "Open one of the person's recorded meetings: summary, decisions, action items with owners and due dates, open questions, and the transcript with speakers, paged with cursor.",
      inputSchema: inputSchema(meetingSchema),
      annotations: readOnly("Open a meeting"),
    },
  },
  {
    scope: "data.read",
    schema: tasksSchema,
    example: { status: "open", limit: 20 },
    tool: {
      name: "niaro_tasks_list",
      description:
        "List the person's tasks in Niaro (from meetings and chats), open by default or done, newest first, with due dates and where each came from.",
      inputSchema: inputSchema(tasksSchema),
      annotations: readOnly("List tasks"),
    },
  },
  {
    scope: "data.read",
    schema: memoryListSchema,
    example: { limit: 50 },
    tool: {
      name: "niaro_memory_list",
      description:
        "List what Niaro remembers about the person (their saved memories and what it noticed), newest first. Use it to see what is known before saving, or when the person asks what Niaro knows about them.",
      inputSchema: inputSchema(memoryListSchema),
      annotations: readOnly("List memories"),
    },
  },
  {
    scope: "memory.write",
    schema: memorySaveSchema,
    example: {
      facts: [{ text: "Prefers short answers in Czech.", kind: "preference" }],
    },
    tool: {
      name: "niaro_memory_save",
      description:
        "Save durable facts about the person into their Niaro memory: preferences, working style, people and their roles, projects, decisions, recurring needs. Saved at once, shown in the person's Niaro profile where they can delete them; duplicates are skipped. One concise fact per item, in the person's language; never secrets, credentials or other people's sensitive data.",
      inputSchema: inputSchema(memorySaveSchema),
      annotations: {
        title: "Save to Niaro memory",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
  },
];
const statusTool: Tool = {
  name: MCP_CONNECTOR_STATUS_TOOL,
  description:
    "Check an earlier service call by its requestId: awaiting_approval, running, succeeded with the result, rejected, unknown (check the data before retrying) or failed. Use it after the person approved a call in Niaro.",
  inputSchema: inputSchema(statusSchema),
  annotations: readOnly("Check a service call"),
};

/** Niaro data results are fitted to the budget and say so. */
function fitted(value: Record<string, unknown>) {
  const result = fitReadResult(value, MCP_RESULT_MAX_CHARACTERS);
  if (result === undefined)
    throw new McpToolError(
      "result_too_large",
      "The result is too large. Narrow the query or use a smaller limit.",
    );
  if (result === value) return value;
  return {
    ...(result as Record<string, unknown>),
    note: "The result was cut to fit 64,000 characters. Narrow the query, use a smaller limit or page with the cursor.",
  };
}

type SearchCursor = { q: string; o: Partial<Record<Kind, number>> };
const queryKey = (query: string, kinds: readonly Kind[]) =>
  createHash("sha256")
    .update(JSON.stringify([query.toLowerCase(), [...kinds].sort()]))
    .digest("base64url")
    .slice(0, 16);
function readCursor(value: string | undefined, key: string): SearchCursor {
  if (!value) return { q: key, o: {} };
  try {
    const parsed = z
      .strictObject({
        q: z.string(),
        o: z.partialRecord(z.enum(KINDS), z.number().int().min(0).max(100_000)),
      })
      .parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (parsed.q === key) return parsed;
  } catch {
    /* Answered below. */
  }
  throw new McpToolError(
    "invalid_cursor",
    "This cursor belongs to a different search. Repeat the same query and kinds, or omit cursor to start again.",
  );
}

/** Each kind pages on its own; hits interleave so every kind shows up. */
async function search<Context>(
  backend: McpRouterBackend<Context>,
  context: Context,
  input: SearchInput,
) {
  const kinds = (input.kinds ?? [...KINDS]).filter(
    (kind, index, all) => all.indexOf(kind) === index && backend.search[kind],
  );
  const key = queryKey(input.query, kinds);
  const position = readCursor(input.cursor, key);
  const full = input.detail === "full";
  const pages = await Promise.all(
    kinds.map(async (kind) => {
      const offset = position.o[kind] ?? 0;
      if (input.cursor && position.o[kind] === undefined)
        return { kind, offset, hits: [] as SearchHit[], more: false };
      const page = await backend.search[kind]!(
        context,
        input.query,
        offset,
        input.limit,
        full,
      );
      return { kind, offset, ...page };
    }),
  );
  const hits: SearchHit[] = [];
  const used = new Map<Kind, number>(kinds.map((kind) => [kind, 0]));
  for (let round = 0; hits.length < input.limit; round++) {
    let added = false;
    for (const page of pages) {
      const hit = page.hits[round];
      if (!hit || hits.length >= input.limit) continue;
      hits.push(hit);
      used.set(page.kind, round + 1);
      added = true;
    }
    if (!added) break;
  }
  const next: Partial<Record<Kind, number>> = {};
  for (const page of pages) {
    const taken = used.get(page.kind) ?? 0;
    if (taken < page.hits.length || page.more)
      next[page.kind] = page.offset + taken;
  }
  return {
    query: input.query,
    hits,
    nextCursor: Object.keys(next).length
      ? Buffer.from(JSON.stringify({ q: key, o: next })).toString("base64url")
      : null,
    ...(hits.length
      ? {}
      : {
          message:
            "Nothing found. Try other words, a name or a shorter query, or other kinds.",
        }),
  };
}

/** The MCP tools of one grant: Niaro data by scope, plus permitted actions. */
export function createMcpRouter<Context>(
  backend: McpRouterBackend<Context>,
): McpToolHandlers<Context> {
  const allowed = (context: Context, scope: Scope) =>
    backend.scopes(context).includes(scope);
  return {
    async list(context) {
      const tools = definitions
        .filter((definition) => allowed(context, definition.scope))
        .map((definition) => definition.tool);
      if (backend.connector && allowed(context, "services.call"))
        tools.push(...(await backend.connector.list(context)), statusTool);
      return tools;
    },
    async call(context, name, input, signal): Promise<McpToolOutcome> {
      const definition = definitions.find((item) => item.tool.name === name);
      if (definition) {
        if (!allowed(context, definition.scope))
          throw new McpToolError(
            "insufficient_scope",
            `This access does not include ${definition.scope}. Ask the person to connect the app again with that permission.`,
          );
        const parsed = definition.schema.safeParse(input);
        if (!parsed.success)
          throw invalidInput(parsed.error, definition.example);
        const read = definition.scope === "data.read";
        try {
          const value =
            name === "niaro_search"
              ? await search(backend, context, parsed.data as SearchInput)
              : name === "niaro_meeting_get"
                ? await backend.meeting(context, parsed.data as MeetingInput)
                : name === "niaro_tasks_list"
                  ? await backend.tasks(context, parsed.data as TasksInput)
                  : name === "niaro_memory_list"
                    ? await backend.memoryList(
                        context,
                        parsed.data as MemoryListInput,
                      )
                    : await backend.memorySave(
                        context,
                        parsed.data as MemorySaveInput,
                      );
          const result = fitted(value);
          if (read) backend.audit?.(context, name, "succeeded");
          return { result };
        } catch (error) {
          if (read) backend.audit?.(context, name, "failed");
          throw error;
        }
      }
      if (backend.connector && allowed(context, "services.call")) {
        if (name === MCP_CONNECTOR_STATUS_TOOL) {
          const parsed = statusSchema.safeParse(input);
          if (!parsed.success)
            throw invalidInput(parsed.error, {
              requestId: "write-2026-11-04-1",
            });
          const result = await backend.connector.status(
            context,
            parsed.data.requestId,
          );
          return { result, isError: result.status === "failed" };
        }
        const result = await backend.connector.call(
          context,
          name,
          input,
          signal,
        );
        // Service reads are already fitted by the catalog; a write's
        // receipt is evidence of what the service did and is never cut.
        return { result, isError: result.status === "failed" };
      }
      throw new McpToolError(
        "unknown_tool",
        "The requested tool is not available. List the tools again.",
      );
    },
  };
}
