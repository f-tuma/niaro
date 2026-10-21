import { createHash } from "node:crypto";
import {
  ProcessDefinitionSchema,
  ProcessSourceManifestSchema,
  type ProcessDefinition,
  type ProcessBinding,
  type ProcessData,
  type ProcessLimits,
  type ProcessStep,
  type ProcessValidation,
} from "../../packages/protocol/service-processes";
import type { ServiceCatalogStore, CatalogActor } from "./service-catalog";
import type { WorkspacePluginStore } from "./workspace-plugins";
import { schemaValidator } from "../server-integrations/schema";
import { compilePattern } from "../server-integrations/schema-pattern";

export const DEFAULT_PROCESS_LIMITS: Readonly<ProcessLimits> = Object.freeze({
  maxSteps: 64,
  maxModelCalls: 32,
  maxTokens: 100_000,
  maxCostMicros: 10_000_000,
  maxDurationMs: 600_000,
});
/** Stable identity for the exact definition and its effective dependencies. */
export function processDigest(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (Array.isArray(item)) return "[" + item.map(canonical).join(",") + "]";
    if (item && typeof item === "object")
      return (
        "{" +
        Object.keys(item)
          .sort()
          .map(
            (key) =>
              JSON.stringify(key) +
              ":" +
              canonical((item as Record<string, unknown>)[key]),
          )
          .join(",") +
        "}"
      );
    return JSON.stringify(item);
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function bounded(value: unknown) {
  const pending: [unknown, number][] = [[value, 0]];
  let count = 0,
    bytes = 0;
  while (pending.length) {
    const [item, depth] = pending.pop()!;
    if (++count > 5000 || depth > 24) return false;
    if (typeof item === "string") bytes += Buffer.byteLength(item);
    if (item && typeof item === "object") {
      for (const [key, child] of Object.entries(item)) {
        bytes += Buffer.byteLength(key);
        pending.push([child, depth + 1]);
      }
    }
    if (bytes > 65536) return false;
  }
  return true;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const scalarType = (value: string | number | boolean | null): ProcessData =>
  typeof value === "string"
    ? {
        type: "string",
        enum: [value],
        minLength: [...value].length,
        maxLength: [...value].length,
      }
    : typeof value === "number"
      ? {
          type: Number.isInteger(value) ? "integer" : "number",
          minimum: value,
          maximum: value,
        }
      : value === null
        ? { type: "null" }
        : { type: "boolean", enum: [value] };

type PatternProofBudget = {
  exhausted: boolean;
  remainingWork: number;
  remainingProgramSize: number;
  patterns: Map<string, ReturnType<typeof compilePattern>>;
};
const patternProofBudget = (): PatternProofBudget => ({
  exhausted: false,
  // Match the catalog validator's limits, shared across the entire definition.
  remainingWork: 4_000_000,
  remainingProgramSize: 16384,
  patterns: new Map(),
});

/** Prove a declared value fits a target schema. Unsupported constraints fail closed.
 * Catalog schemas remain authoritative and are also checked at actual dispatch. */
function assignable(
  source: ProcessData,
  raw: unknown,
  root = raw,
  depth = 0,
  proof = patternProofBudget(),
): boolean {
  if (!object(raw) || depth > 12 || proof.exhausted) return false;
  let target = raw;
  if (typeof target.$ref === "string") {
    if (!target.$ref.startsWith("#/") || !object(root)) return false;
    let resolved: unknown = root;
    for (const key of target.$ref
      .slice(2)
      .split("/")
      .map((x) => x.replace(/~1/g, "/").replace(/~0/g, "~")))
      resolved =
        object(resolved) && Object.hasOwn(resolved, key)
          ? resolved[key]
          : undefined;
    return (
      assignable(source, resolved, root, depth + 1, proof) &&
      assignable(
        source,
        Object.fromEntries(
          Object.entries(target).filter(([key]) => key !== "$ref"),
        ),
        root,
        depth + 1,
        proof,
      )
    );
  }
  const supported = new Set([
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "minItems",
    "maxItems",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "enum",
    "const",
    "title",
    "description",
    "default",
    "format",
    "$schema",
    "$defs",
    "definitions",
    "anyOf",
    "allOf",
    "nullable",
    "pattern",
  ]);
  if (Object.keys(target).some((key) => !supported.has(key))) return false;
  for (const combinator of ["allOf", "anyOf"]) {
    if (target[combinator] !== undefined) {
      const options = target[combinator];
      if (!Array.isArray(options) || !options.length) return false;
      const results = options.map((item) =>
        assignable(source, item, root, depth + 1, proof),
      );
      if (
        proof.exhausted ||
        (combinator === "allOf"
          ? results.some((result) => !result)
          : !results.some(Boolean))
      )
        return false;
    }
  }
  // format is annotation-only in the existing bounded catalog validator.
  if (
    target.type !== undefined &&
    !(Array.isArray(target.type) ? target.type : [target.type]).some(
      (type) =>
        type === source.type ||
        (type === "number" && source.type === "integer"),
    )
  )
    return false;
  if (target.const !== undefined || target.enum !== undefined) {
    const choices = [
      ...(target.const !== undefined ? [[target.const]] : []),
      ...(target.enum !== undefined ? [target.enum] : []),
    ];
    const values =
      source.type === "string"
        ? source.enum
        : source.type === "null"
          ? [null]
          : source.type === "boolean"
            ? (source.enum ?? [true, false])
            : (source.type === "number" || source.type === "integer") &&
                source.minimum === source.maximum &&
                source.minimum !== undefined
              ? [source.minimum]
              : undefined;
    if (
      !values ||
      choices.some(
        (choice) =>
          !Array.isArray(choice) ||
          !values.every((value) => choice.includes(value)),
      )
    )
      return false;
  }
  if (source.type === "string") {
    if (source.enum) {
      // Both the installed Zod validator and catalog JSON Schema count code
      // points; finite alternatives can be checked without widening their type.
      if (
        source.enum.some((value) => {
          const length = [...value].length;
          return (
            length < Number(target.minLength ?? 0) ||
            length > Number(target.maxLength ?? Infinity)
          );
        })
      )
        return false;
    } else if (
      (source.minLength ?? 0) < Number(target.minLength ?? 0) ||
      (source.maxLength ?? Infinity) > Number(target.maxLength ?? Infinity)
    )
      return false;
  }
  if (target.pattern !== undefined) {
    if (
      source.type !== "string" ||
      !source.enum ||
      typeof target.pattern !== "string"
    )
      return false;
    try {
      let expression = proof.patterns.get(target.pattern);
      if (!expression) {
        expression = compilePattern(
          target.pattern,
          Math.min(4096, proof.remainingProgramSize),
        );
        proof.remainingProgramSize -= expression.programSize();
        proof.patterns.set(target.pattern, expression);
      }
      for (const value of source.enum) {
        proof.remainingWork -= (value.length + 1) * expression.programSize();
        if (proof.remainingWork < 0) {
          proof.exhausted = true;
          return false;
        }
        if (!expression.test(value)) return false;
      }
    } catch {
      proof.exhausted = true;
      return false;
    }
  }
  if (source.type === "number" || source.type === "integer") {
    if (
      (source.minimum ?? -Infinity) < Number(target.minimum ?? -Infinity) ||
      (source.maximum ?? Infinity) > Number(target.maximum ?? Infinity)
    )
      return false;
  }
  if (source.type === "array") {
    if (
      (source.minItems ?? 0) < Number(target.minItems ?? 0) ||
      (source.maxItems ?? Infinity) > Number(target.maxItems ?? Infinity)
    )
      return false;
    if (
      target.items !== undefined &&
      !assignable(source.items, target.items, root, depth + 1, proof)
    )
      return false;
  }
  if (source.type === "object") {
    const properties = object(target.properties) ? target.properties : {};
    if (
      Array.isArray(target.required) &&
      !target.required.every((key) => source.required.includes(String(key)))
    )
      return false;
    for (const [key, schema] of Object.entries(source.properties)) {
      if (Object.hasOwn(properties, key)) {
        if (!assignable(schema, properties[key], root, depth + 1, proof))
          return false;
      } else if (
        target.additionalProperties === false ||
        (object(target.additionalProperties) &&
          !assignable(
            schema,
            target.additionalProperties,
            root,
            depth + 1,
            proof,
          ))
      )
        return false;
    }
  }
  return true;
}
export type ProcessValidationContext = {
  organizationId: string;
  workspaceId: string;
  serviceId?: string;
  actor: CatalogActor;
  catalog: ServiceCatalogStore;
  plugins: WorkspacePluginStore;
  limits?: ProcessLimits;
};
export function validateProcessDefinition(
  raw: unknown,
  context: ProcessValidationContext,
): ProcessValidation {
  const issues: ProcessValidation["issues"] = [];
  const issue = (
    code: ProcessValidation["issues"][number]["code"],
    path: string,
  ) => {
    if (issues.length < 20) issues.push({ code, path: path.slice(0, 300) });
  };
  const invalid = (): ProcessValidation => ({
    valid: false,
    issues,
    sources: null,
  });
  if (!bounded(raw)) {
    issue("limit_exceeded", "/");
    return invalid();
  }
  const parsed = ProcessDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    for (const item of parsed.error.issues)
      issue("definition_invalid", "/" + item.path.join("/"));
    return invalid();
  }
  const definition = parsed.data,
    limits = context.limits ?? DEFAULT_PROCESS_LIMITS;
  const proof = patternProofBudget();
  for (const key of Object.keys(limits) as (keyof ProcessLimits)[])
    if (definition.limits[key] > limits[key])
      issue("limit_exceeded", "/limits/" + key);
  const resources = new Map<
    string,
    {
      kind: "service" | "action" | "model" | "provider";
      id: string;
      revision: number;
    }
  >();
  const resource = (
    kind: "service" | "action" | "model" | "provider",
    id: string,
    revision: number,
  ) => resources.set(kind + ":" + id, { kind, id, revision });
  let savedMemory = false;
  const service = (id: string, path: string) => {
    try {
      const current = context.catalog.service(context.workspaceId, id);
      resource("service", current.id, current.revision);
      if (
        !context.catalog.serviceAllowed(
          current,
          context.workspaceId,
          context.actor,
        )
      )
        issue("capability_denied", path);
      if (!current.enabled) issue("resource_unavailable", path);
      return current;
    } catch {
      issue("resource_unavailable", path);
      return undefined;
    }
  };
  if (context.serviceId) service(context.serviceId, "/serviceId");
  const capability = (
    value: { serviceId: string; actionId: string },
    path: string,
  ) => {
    const current = service(value.serviceId, path + "/serviceId");
    const action = current?.actions.find(
      (action) => action.id === value.actionId,
    );
    if (!action || !action.enabled) {
      issue("resource_unavailable", path + "/actionId");
      return undefined;
    }
    resource("action", action.id, action.revision);
    if (!context.catalog.allowed(action, context.actor))
      issue("capability_denied", path + "/actionId");
    return action;
  };
  const agent = (
    value:
      | Extract<ProcessDefinition, { kind: "agent" }>
      | Extract<ProcessStep, { type: "agent" }>,
    path: string,
  ) => {
    try {
      const current = context.catalog.processModelMetadata(
        context.organizationId,
        value.modelId,
      );
      resource("model", current.model.id, current.model.revision);
      resource("provider", current.provider.id, current.provider.revision);
    } catch {
      issue("resource_unavailable", path + "/modelId");
    }
    if (definition.limits.maxModelCalls < 1)
      issue("limit_exceeded", "/limits/maxModelCalls");
    const keys = new Set<string>();
    for (const [index, item] of value.capabilities.entries()) {
      const key = item.serviceId + ":" + item.actionId;
      if (keys.has(key))
        issue("definition_invalid", path + "/capabilities/" + index);
      keys.add(key);
      capability(item, path + "/capabilities/" + index);
    }
    if (value.memory === "saved") savedMemory = true;
  };
  if (definition.kind === "agent") agent(definition, "");
  else {
    if (definition.steps.length > definition.limits.maxSteps)
      issue("limit_exceeded", "/limits/maxSteps");
    if (
      definition.steps.filter((step) => step.type === "agent").length >
      definition.limits.maxModelCalls
    )
      issue("limit_exceeded", "/limits/maxModelCalls");
    const nodes = new Map(definition.steps.map((step) => [step.id, step]));
    if (nodes.size !== definition.steps.length || !nodes.has(definition.entry))
      issue("graph_invalid", "/steps");
    const incoming = new Map<string, string[]>(),
      reachable = new Set<string>(),
      visiting = new Set<string>(),
      ordered: string[] = [];
    const successors = (node: ProcessStep): string[] =>
      node.type === "return"
        ? []
        : node.type === "branch"
          ? [node.whenTrue, node.whenFalse]
          : [node.next];
    for (const node of definition.steps)
      for (const next of successors(node)) {
        if (!nodes.has(next)) issue("graph_invalid", "/steps/" + node.id);
        incoming.set(next, [...(incoming.get(next) ?? []), node.id]);
      }
    const visit = (id: string) => {
      if (visiting.has(id)) {
        issue("graph_invalid", "/steps/" + id);
        return;
      }
      if (reachable.has(id)) return;
      const node = nodes.get(id);
      if (!node) return;
      reachable.add(id);
      visiting.add(id);
      for (const next of successors(node)) visit(next);
      visiting.delete(id);
      ordered.unshift(id);
    };
    visit(definition.entry);
    if (reachable.size !== nodes.size) issue("graph_invalid", "/steps");
    if (issues.some((item) => item.code === "graph_invalid")) return invalid();
    const dominators = new Map<string, Set<string>>();
    for (const id of ordered) {
      const predecessors = incoming.get(id) ?? [];
      const prior = predecessors.length
        ? new Set(dominators.get(predecessors[0]!) ?? [])
        : new Set<string>();
      for (const predecessor of predecessors.slice(1))
        for (const ancestor of prior)
          if (!dominators.get(predecessor)?.has(ancestor))
            prior.delete(ancestor);
      dominators.set(id, new Set([...prior, id]));
    }
    const bindingType = (
      binding: ProcessBinding,
      consumer: string,
      path: string,
      optional = false,
    ): ProcessData | undefined => {
      if (binding.source === "literal") return scalarType(binding.value);
      let schema: ProcessData | undefined = definition.inputSchema;
      if (binding.source === "step") {
        const source = nodes.get(binding.stepId);
        if (
          source &&
          source.id !== consumer &&
          dominators.get(consumer)?.has(source.id) &&
          (source.type === "action" || source.type === "agent")
        )
          schema = source.outputSchema;
        else schema = undefined;
      }
      for (const key of binding.path) {
        if (
          schema?.type !== "object" ||
          (!optional && !schema.required.includes(key))
        ) {
          schema = undefined;
          break;
        }
        schema = schema.properties[key];
      }
      if (!schema) issue("binding_invalid", path);
      return schema;
    };
    const inputs = (
      values: Record<string, ProcessBinding>,
      target: Record<string, unknown>,
      node: ProcessStep,
      path: string,
    ) => {
      const properties = object(target.properties) ? target.properties : {};
      for (const key of Array.isArray(target.required) ? target.required : [])
        if (!Object.hasOwn(values, String(key)))
          issue("binding_invalid", path + "/" + key);
      for (const [key, binding] of Object.entries(values)) {
        const schema = bindingType(binding, node.id, path + "/" + key);
        const expected = Object.hasOwn(properties, key)
          ? properties[key]
          : (target.additionalProperties ?? {});
        if (expected === false) issue("binding_invalid", path + "/" + key);
        else if (
          schema &&
          !assignable(
            schema,
            expected === true ? {} : expected,
            target,
            0,
            proof,
          )
        )
          issue("binding_type_unproven", path + "/" + key);
      }
      // Root-level unions/refs may carry required fields not visible in properties.
      const supplied: ProcessData = {
        type: "object",
        properties: {},
        required: Object.keys(values),
        additionalProperties: false,
      };
      for (const [key, binding] of Object.entries(values)) {
        const schema = bindingType(binding, node.id, path + "/" + key);
        if (schema) supplied.properties[key] = schema;
      }
      if (!assignable(supplied, target, target, 0, proof))
        issue("binding_type_unproven", path);
    };
    for (const [index, node] of definition.steps.entries()) {
      const path = "/steps/" + index;
      if (node.type === "action") {
        const action = capability(node, path);
        if (action) {
          try {
            schemaValidator(action.inputSchema);
            inputs(node.input, action.inputSchema, node, path + "/input");
          } catch {
            issue("binding_type_unproven", path + "/input");
          }
        }
      } else if (node.type === "agent") {
        agent(node, path);
        inputs(
          node.input,
          node.inputSchema as unknown as Record<string, unknown>,
          node,
          path + "/input",
        );
      } else if (node.type === "return")
        inputs(
          node.output,
          definition.outputSchema as unknown as Record<string, unknown>,
          node,
          path + "/output",
        );
      else {
        const schema = bindingType(
          node.condition.left,
          node.id,
          path + "/condition",
          node.condition.operator === "exists",
        );
        if (
          node.condition.operator === "equals" &&
          schema &&
          !assignable(
            scalarType(node.condition.right),
            schema,
            schema,
            0,
            proof,
          )
        )
          issue("binding_type_unproven", path + "/condition");
      }
    }
  }
  let pluginsDigest: string | null = null;
  if (savedMemory) {
    const current = context.plugins.read(context.workspaceId);
    if (!current.settings.enabled.includes("memory"))
      issue("resource_unavailable", "/memory");
    pluginsDigest = processDigest(current);
  }
  if (resources.size > 256) issue("limit_exceeded", "/capabilities");
  if (issues.length) return invalid();
  return {
    valid: true,
    issues: [],
    sources: ProcessSourceManifestSchema.parse({
      resources: [...resources.values()].sort((a, b) =>
        (a.kind + a.id).localeCompare(b.kind + b.id),
      ),
      pluginsDigest,
      limitsDigest: processDigest(limits),
    }),
  };
}
