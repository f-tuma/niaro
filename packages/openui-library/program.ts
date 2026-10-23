import {
  createParser,
  jsonToOpenUI,
  walkAST,
  type ASTNode,
  type ElementNode,
  type ParseResult,
} from "@openuidev/lang-core";
import { displayLink } from "../protocol/display-link";
import {
  GENERATIVE_UI_LIMITS,
  generativeUiLibrary,
  type GenerativeUiComponentName,
} from "./spec";

// lang-core samples runtime telemetry only when a server opts in with
// OPENUI_RUNTIME_TELEMETRY_ENABLED; this flag also overrides that opt-in.
if (typeof process !== "undefined" && process.env)
  process.env.OPENUI_TELEMETRY_DISABLED = "1";

const L = GENERATIVE_UI_LIMITS;
const schema = generativeUiLibrary.toJSONSchema();
type Schema = Record<string, unknown>;
const defs = (schema.$defs ?? {}) as Record<string, Schema>;
const components = new Set(Object.keys(generativeUiLibrary.components));
/** Action steps a program may use: a follow-up the person sends themself, a
 * checked web link and local UI state. No Query, Mutation, @Run or custom step. */
const STEPS = new Set(["Action", "ToAssistant", "OpenUrl", "Set", "Reset"]);

let parser: ReturnType<typeof createParser> | undefined;
/** Parses with the shared library; unknown components are already dropped. */
export function parseProgram(source: string): ParseResult {
  parser ??= createParser(schema, generativeUiLibrary.root);
  return parser.parse(source);
}

function refs(value: unknown, into = new Set<string>()) {
  if (Array.isArray(value)) for (const item of value) refs(item, into);
  else if (value && typeof value === "object") {
    const ref = (value as Schema).$ref;
    if (typeof ref === "string") {
      const name = ref.replace("#/$defs/", "");
      if (components.has(name)) into.add(name);
    }
    for (const [key, child] of Object.entries(value))
      if (key !== "$ref") refs(child, into);
  }
  return into;
}
/** The components each prop accepts, from the library's own schema. */
const slots = new Map(
  [...components].map((name) => {
    const properties = (defs[name]?.properties ?? {}) as Record<string, Schema>;
    return [
      name,
      new Map(
        Object.entries(properties).map(([prop, value]) => [
          prop,
          { schema: value, accepts: refs(value) },
        ]),
      ),
    ];
  }),
);

const isElement = (value: unknown): value is ElementNode =>
  !!value &&
  typeof value === "object" &&
  (value as { type?: unknown }).type === "element";
const isAst = (value: unknown): value is ASTNode =>
  !!value &&
  typeof value === "object" &&
  typeof (value as { k?: unknown }).k === "string";

/** A web address shown to the person: http(s) only, by our link checks. */
export function safeUrl(value: unknown) {
  if (typeof value !== "string") return undefined;
  const link = displayLink(value, "url");
  return link?.kind === "url" ? link.href : undefined;
}

type Walk = {
  nodes: number;
  actions: number;
  issues: string[];
  /** The parser turned an unknown @step into null: its control goes too. */
  unknownSteps: boolean;
};

/** Why an expression cannot stay, or undefined when it can. */
function expressionIssue(node: ASTNode, walk: Walk) {
  let issue: string | undefined;
  walkAST(node, (part) => {
    if (issue) return;
    if (part.k === "RuntimeRef") issue = "Query and Mutation are not supported";
    if (part.k !== "Comp") return;
    if (components.has(part.name)) {
      walk.nodes++;
      return;
    }
    if (!STEPS.has(part.name)) {
      issue = `@${part.name} is not available`;
      return;
    }
    if (part.name === "Action") return;
    walk.actions++;
    const [first] = part.args;
    if (part.name === "OpenUrl")
      issue =
        first?.k === "Str" && safeUrl(first.v)
          ? undefined
          : "@OpenUrl needs a literal http(s) address";
    if (part.name === "ToAssistant")
      issue =
        first && (first.k !== "Str" || first.v.trim().length <= 500)
          ? undefined
          : "@ToAssistant needs a short message";
  });
  return issue;
}

/** Bounds a prop value by its schema; undefined drops it. */
function bounded(value: unknown, propSchema: Schema | undefined): unknown {
  if (typeof value === "string") {
    const max = Number(propSchema?.maxLength ?? L.text);
    return value.length > max ? value.slice(0, max) : value;
  }
  if (Array.isArray(value)) {
    const max = Number(propSchema?.maxItems ?? L.items);
    const items = (propSchema?.items ?? undefined) as Schema | undefined;
    return value.slice(0, max).map((item) => bounded(item, items));
  }
  return value;
}

const DROP = Symbol("drop");
/** A copy of the node keeping only what the library allows where it stands. */
function sanitize(
  node: ElementNode,
  depth: number,
  walk: Walk,
): ElementNode | null {
  if (!components.has(node.typeName)) return null;
  if (depth > L.depth) {
    walk.issues.push(`${node.typeName} is nested too deeply`);
    return null;
  }
  walk.nodes++;
  const own = slots.get(node.typeName)!;
  const required = (defs[node.typeName]?.required ?? []) as string[];
  const props: Record<string, unknown> = {};
  for (const [prop, raw] of Object.entries(node.props)) {
    const slot = own.get(prop);
    if (!slot || raw === undefined) continue;
    const child = (value: unknown): unknown => {
      if (isElement(value)) {
        if (!slot.accepts.has(value.typeName)) {
          walk.issues.push(
            `${value.typeName} cannot be placed in ${node.typeName}`,
          );
          return DROP;
        }
        return sanitize(value, depth + 1, walk) ?? DROP;
      }
      if (isAst(value)) {
        const issue = expressionIssue(value, walk);
        if (issue) walk.issues.push(`${node.typeName}: ${issue}`);
        return issue ? DROP : value;
      }
      if (Array.isArray(value))
        return value.map(child).filter((item) => item !== DROP);
      return value;
    };
    const value = child(raw);
    if (value !== DROP) props[prop] = bounded(value, slot.schema);
  }
  if (
    required.some((prop) => props[prop] === undefined || props[prop] === null)
  )
    return null;
  if (node.typeName === "Link" && !safeUrl(props.url)) {
    walk.issues.push("Link needs an http(s) address");
    return null;
  }
  // A control whose action was refused is not shown at all.
  if (
    ("action" in node.props && node.props.action && !("action" in props)) ||
    (walk.unknownSteps && "action" in node.props && node.props.action === null)
  )
    return null;
  return { ...node, props };
}

export type ProgramCheck =
  | {
      ok: true;
      /** Normalized source: only what both renderers will show. */
      program: string;
      root: ElementNode;
      /** What was dropped, for the operator log and the model's repair. */
      issues: string[];
    }
  | { ok: false; issues: string[] };

/**
 * Server-side admission of a generated program before it is stored or
 * delivered. Untrusted model output stays data: unknown components, wrong
 * nesting, bad links and unsupported steps are dropped; data fetching,
 * missing roots and oversized programs refuse the whole program.
 */
export function checkProgram(source: string): ProgramCheck {
  const text = source.trim();
  if (!text) return { ok: false, issues: ["The program is empty"] };
  if (text.length > L.characters)
    return {
      ok: false,
      issues: [`The program is longer than ${L.characters} characters`],
    };
  let parsed: ParseResult;
  try {
    parsed = parseProgram(text);
  } catch {
    return { ok: false, issues: ["The program could not be parsed"] };
  }
  if (parsed.queryStatements.length || parsed.mutationStatements.length)
    return { ok: false, issues: ["Query and Mutation are not supported"] };
  if (!parsed.root || parsed.root.typeName !== generativeUiLibrary.root)
    return {
      ok: false,
      issues: [`The program needs root = ${generativeUiLibrary.root}(...)`],
    };
  const walk: Walk = {
    nodes: 0,
    actions: 0,
    unknownSteps: parsed.meta.errors.some(
      (error) => error.code === "unknown-function",
    ),
    issues: parsed.meta.errors
      .filter((error) => error.severity !== "warning")
      .map((error) =>
        [error.statementId, error.message].filter(Boolean).join(": "),
      ),
  };
  const root = sanitize(parsed.root, 0, walk);
  if (!root || !(root.props.children as unknown[] | undefined)?.length)
    return {
      ok: false,
      issues: [...walk.issues, "The program shows nothing"].slice(-6),
    };
  if (walk.nodes > L.nodes)
    return {
      ok: false,
      issues: [`The program has more than ${L.nodes} components`],
    };
  if (walk.actions > L.actions)
    return {
      ok: false,
      issues: [`The program has more than ${L.actions} actions`],
    };
  const body = jsonToOpenUI(root, generativeUiLibrary as never);
  // Declared defaults of the `$variables` the kept program still uses.
  const state = Object.entries(parsed.stateDeclarations)
    .filter(
      ([name, value]) =>
        (value === null || typeof value !== "object") &&
        new RegExp(`\\${name}\\b`).test(body),
    )
    .map(([name, value]) => `${name} = ${JSON.stringify(value)}`);
  const program = [...state, body].join("\n");
  return {
    ok: true,
    program,
    root,
    issues: [...new Set(walk.issues)].map((issue) => issue.slice(0, 300)),
  };
}

/** Readable strings of a program: the checker's claims and text fallbacks. */
export function programText(root: ElementNode, limit = 8000): string {
  const parts: string[] = [];
  const visit = (value: unknown) => {
    if (parts.join("\n").length > limit) return;
    if (typeof value === "string" || typeof value === "number")
      parts.push(String(value));
    else if (Array.isArray(value)) value.forEach(visit);
    else if (isElement(value)) Object.values(value.props).forEach(visit);
  };
  visit(root);
  return parts.join("\n").slice(0, limit);
}

/** The first heading or paragraph, for a reply that has no text of its own. */
export function programTitle(root: ElementNode): string | undefined {
  let found: string | undefined;
  const visit = (value: unknown) => {
    if (found) return;
    if (Array.isArray(value)) value.forEach(visit);
    else if (isElement(value)) {
      const name = value.typeName as GenerativeUiComponentName;
      if (
        (name === "Heading" || name === "Text") &&
        typeof value.props.text === "string" &&
        value.props.text.trim()
      )
        found = value.props.text.trim();
      else Object.values(value.props).forEach(visit);
    }
  };
  visit(root);
  return found;
}

const FENCE = /^\s*```\s*(openui-lang|openui)\s*$/i;
const CLOSE = /^\s*```\s*$/;
/**
 * Splits a model reply into its Markdown text and its one OpenUI Lang
 * program (the first ```openui-lang fence; further programs are dropped).
 * An unterminated fence runs to the end, as while streaming.
 */
export function splitReply(reply: string): { text: string; program?: string } {
  const lines = reply.split("\n");
  const text: string[] = [];
  let program: string[] | undefined;
  let current: string[] | undefined;
  for (const line of lines) {
    if (current) {
      if (CLOSE.test(line)) current = undefined;
      else current.push(line);
    } else if (FENCE.test(line)) {
      current = [];
      if (!program) program = current;
    } else text.push(line);
  }
  const source = program?.join("\n").trim();
  // A reply that is a bare program, as OpenUI's default prompt asks for.
  if (!source && /^\s*root\s*=\s*[A-Z]\w*\(/.test(reply))
    return { text: "", program: reply.trim() };
  return {
    text: text
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    ...(source ? { program: source } : {}),
  };
}
