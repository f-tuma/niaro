import Ajv, { type ErrorObject } from "ajv";
import type { z } from "zod";
import type { DiscoveryIssue } from "../../packages/protocol/service-catalog";
import { compilePattern } from "./schema-pattern";
import { IntegrationError } from "./transport";
import type { ActionFailure } from "../../packages/protocol/action-failure";
import { diagnosticText } from "./failures";
const keywords = new Set([
  "type",
  "title",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "minimum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "anyOf",
  "oneOf",
  "allOf",
  "nullable",
  "default",
  "format",
  "$schema",
  "$defs",
  "definitions",
  "$ref",
  "propertyNames",
  "pattern",
]);
type Schema = Record<string, unknown>;
function argumentIssues(
  errors: ErrorObject[] | null | undefined,
): ActionFailure["fields"] {
  return (errors ?? []).slice(0, 8).flatMap((error) => {
    const name =
      error.keyword === "required"
        ? error.params.missingProperty
        : error.keyword === "additionalProperties"
          ? error.params.additionalProperty
          : undefined;
    const path =
      diagnosticText(
        error.instancePath +
          (typeof name === "string"
            ? "/" + name.replace(/~/g, "~0").replace(/\//g, "~1")
            : ""),
        160,
      ) ?? "/";
    const expectedType = [
      "string",
      "number",
      "integer",
      "object",
      "array",
      "boolean",
      "null",
    ].includes(error.params.type)
      ? error.params.type
      : "supported type";
    const issue =
      error.keyword === "required"
        ? "Required field is missing."
        : error.keyword === "type"
          ? `Expected ${expectedType}.`
          : error.keyword === "additionalProperties"
            ? "This field is not supported."
            : error.keyword === "enum"
              ? "Use one of the allowed values."
              : error.keyword === "const"
                ? "Value does not match the required value."
                : ["minLength", "maxLength"].includes(error.keyword)
                  ? "Text length is outside the allowed range."
                  : [
                        "minimum",
                        "maximum",
                        "exclusiveMinimum",
                        "exclusiveMaximum",
                      ].includes(error.keyword)
                    ? "Number is outside the allowed range."
                    : ["minItems", "maxItems"].includes(error.keyword)
                      ? "Number of items is outside the allowed range."
                      : "Value does not match the supported format.";
    return [{ path, issue }];
  });
}
const record = (value: unknown): value is Schema =>
  !!value && typeof value === "object" && !Array.isArray(value);
type SchemaIssue = Omit<z.infer<typeof DiscoveryIssue>, "action">;
export class SchemaError extends IntegrationError {
  constructor(readonly issue: SchemaIssue) {
    super("integration_schema_unsupported");
  }
}
function fail(
  reason: SchemaIssue["reason"] = "schema_invalid",
  path = "#",
  keyword?: string,
): never {
  throw new SchemaError({
    reason,
    path: path.slice(0, 300),
    ...(keyword ? { keyword: keyword.slice(0, 64) } : {}),
  });
}
const unsafe = (name: string) =>
  ["__proto__", "constructor", "prototype"].includes(name);
/** Bounded draft-7 subset with local recursive filters, object unions and linear regex matching. */
type CompiledSchema = (
  input: unknown,
  onInvalid?: (fields: ActionFailure["fields"]) => void,
) => boolean;
// Compiling a fresh AJV instance costs milliseconds per schema, and catalogs
// re-check hundreds of unchanged action schemas per request. Successful compiles
// are cached by canonical text; the cached validator owns a private copy.
const compiled = new Map<string, CompiledSchema>();
const COMPILED_LIMIT = 2048;
export function schemaValidator(
  schema: Schema,
  onInvalid?: (fields: ActionFailure["fields"]) => void,
) {
  const key = JSON.stringify(schema);
  let validate = compiled.get(key);
  if (validate) {
    compiled.delete(key);
    compiled.set(key, validate);
  } else {
    if (key.length > 32768) fail("schema_limit");
    validate = compileSchema(structuredClone(schema));
    if (compiled.size >= COMPILED_LIMIT)
      compiled.delete(compiled.keys().next().value!);
    compiled.set(key, validate);
  }
  const run = validate;
  return (input: unknown): boolean => run(input, onInvalid);
}
function compileSchema(schema: Schema): CompiledSchema {
  const nodes = new Set<Schema>();
  const paths = new Map<Schema, string>();
  const patterns = new Map<string, ReturnType<typeof compilePattern>>();
  let remainingPatternSize = 16384;
  const edges = new Map<Schema, Schema[]>();
  function check(value: unknown, depth: number, path: string): void {
    if (!record(value) || nodes.has(value)) fail("schema_invalid", path);
    if (nodes.size >= 1000 || depth > 12) fail("schema_limit", path);
    nodes.add(value);
    paths.set(value, path);
    const sameInput: Schema[] = [];
    edges.set(value, sameInput);
    for (const [key, item] of Object.entries(value)) {
      if (!keywords.has(key)) fail("keyword_unsupported", path, key);
      if (key === "pattern") {
        if (typeof item !== "string") fail("schema_invalid", path, key);
        try {
          if (!patterns.has(item)) {
            const pattern = compilePattern(
              item,
              Math.min(4096, remainingPatternSize),
            );
            remainingPatternSize -= pattern.programSize();
            patterns.set(item, pattern);
          }
        } catch {
          fail("pattern_unsupported", path, key);
        }
      }
      if (
        key === "$schema" &&
        item !== "http://json-schema.org/draft-07/schema#" &&
        item !== "https://json-schema.org/draft-07/schema#"
      )
        fail("keyword_unsupported", path, key);
      if (["properties", "$defs", "definitions"].includes(key)) {
        if (!record(item)) fail();
        for (const [name, child] of Object.entries(item)) {
          if (unsafe(name)) fail();
          check(
            child,
            depth + 1,
            `${path}/${key}/${name.replace(/~/g, "~0").replace(/\//g, "~1")}`,
          );
        }
      }
      if (
        ["items", "additionalProperties", "propertyNames"].includes(key) &&
        typeof item === "object"
      )
        check(item, depth + 1, `${path}/${key}`);
      if (["anyOf", "oneOf", "allOf"].includes(key)) {
        if (!Array.isArray(item) || !item.length)
          fail("schema_invalid", path, key);
        for (const [index, child] of item.entries()) {
          check(child, depth + 1, `${path}/${key}/${index}`);
          sameInput.push(child as Schema);
        }
      }
    }
  }
  if (JSON.stringify(schema).length > 32768) fail("schema_limit");
  check(schema, 0, "#");
  // Keep malformed/missing schemas from becoming unconstrained when accepting root unions.
  function objectRoot(node: Schema): boolean {
    return (
      node.type === "object" ||
      ["anyOf", "oneOf"].some(
        (key) =>
          Array.isArray(node[key]) &&
          node[key].every((child) => record(child) && objectRoot(child)),
      )
    );
  }
  if (!objectRoot(schema)) fail("object_required");
  for (const node of nodes) {
    if (node.$ref === undefined) continue;
    // Use canonical pointer fragments: URI normalization must not change AJV's target.
    if (
      typeof node.$ref !== "string" ||
      !/^#(?:\/(?:[A-Za-z0-9_$-]|~[01])+)*$/.test(node.$ref)
    )
      fail("reference_unsupported", paths.get(node), "$ref");
    let target: unknown = schema;
    for (const part of node.$ref === "#" ? [] : node.$ref.slice(2).split("/")) {
      if (/~(?![01])/.test(part))
        fail("reference_unsupported", paths.get(node), "$ref");
      const name = part.replace(/~1/g, "/").replace(/~0/g, "~");
      if (unsafe(name) || !record(target) || !Object.hasOwn(target, name))
        fail("reference_unsupported", paths.get(node), "$ref");
      target = target[name];
    }
    if (!record(target) || !nodes.has(target))
      fail("reference_unsupported", paths.get(node), "$ref");
    edges.get(node)!.push(target);
  }
  // A reference cycle must consume an input property/item, never recurse on the same value.
  const visiting = new Set<Schema>(),
    visited = new Set<Schema>();
  function acyclic(node: Schema) {
    if (visiting.has(node))
      fail("reference_unsupported", paths.get(node), "$ref");
    if (visited.has(node)) return;
    visiting.add(node);
    for (const child of edges.get(node)!) acyclic(child);
    visiting.delete(node);
    visited.add(node);
  }
  for (const node of nodes) acyclic(node);
  // Scope AJV to this validator: a global instance retains code/patterns after removeSchema().
  const regExp = Object.assign(
    (pattern: string) => {
      const expression = patterns.get(pattern);
      if (!expression) fail("pattern_unsupported");
      return {
        test: (value: string) => expression.test(value),
        // AJV caches compiled pattern references by this identity.
        toString: () => pattern,
      };
    },
    { code: "boundedPattern" },
  );
  const ajv = new Ajv({
    strict: false,
    allErrors: false,
    validateFormats: false,
    ownProperties: true,
    inlineRefs: false,
    code: { regExp },
  });
  try {
    const validator = ajv.compile(schema);
    return (input, onInvalid): boolean => {
      if (!record(input)) {
        onInvalid?.([{ path: "/", issue: "Expected object." }]);
        return false;
      }
      let budget = 10000;
      let patternBudget = 4_000_000;
      // Count repeated evaluations too: recursive anyOf/allOf can otherwise multiply AJV work.
      function affordable(
        node: Schema,
        value: unknown,
        depth: number,
      ): boolean {
        if (--budget < 0 || depth > 128) return false;
        if (typeof value === "string" && typeof node.pattern === "string") {
          patternBudget -=
            (value.length + 1) * patterns.get(node.pattern)!.programSize();
          if (patternBudget < 0) return false;
        }
        for (const child of edges.get(node)!)
          if (!affordable(child, value, depth + 1)) return false;
        if (Array.isArray(value) && record(node.items)) {
          for (const item of value)
            if (!affordable(node.items, item, depth + 1)) return false;
        } else if (record(value)) {
          const properties = record(node.properties) ? node.properties : {};
          for (const [name, item] of Object.entries(value)) {
            const child = Object.hasOwn(properties, name)
              ? properties[name]
              : node.additionalProperties;
            if (record(child) && !affordable(child, item, depth + 1))
              return false;
            if (
              record(node.propertyNames) &&
              !affordable(node.propertyNames, name, depth + 1)
            )
              return false;
          }
        }
        return true;
      }
      const pending: [unknown, number][] = [[input, 0]];
      let inputNodes = 0;
      while (pending.length) {
        const [value, depth] = pending.pop()!;
        if (++inputNodes > 10000 || depth > 32) {
          onInvalid?.([
            { path: "/", issue: "Input exceeds supported validation limits." },
          ]);
          return false;
        }
        if (value && typeof value === "object")
          for (const child of Object.values(value))
            pending.push([child, depth + 1]);
      }
      if (!affordable(schema, input, 0)) {
        onInvalid?.([
          { path: "/", issue: "Input exceeds supported validation limits." },
        ]);
        return false;
      }
      const valid = !!validator(input);
      if (!valid) onInvalid?.(argumentIssues(validator.errors));
      return valid;
    };
  } catch {
    return fail();
  } finally {
    ajv.removeSchema(schema);
  }
}
export function validateArguments(schema: Schema, input: unknown) {
  let fields: ActionFailure["fields"] = [];
  const tooLarge = (JSON.stringify(input)?.length ?? Infinity) > 65536;
  if (
    tooLarge ||
    !schemaValidator(schema, (issues) => {
      fields = issues;
    })(input)
  )
    throw new IntegrationError("integration_input_invalid", 400, {
      code: "integration_input_invalid",
      kind: "validation",
      stage: "validation",
      retry: "correct_input",
      message: tooLarge
        ? "Input exceeds the supported size."
        : "Input does not match the action schema.",
      fields,
    });
}
