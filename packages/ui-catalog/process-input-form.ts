import {
  ProcessInputCardSchema,
  type ProcessInputCard,
} from "../protocol/process-execution";
import {
  ProcessStartInputSchema,
  type ProcessInputValue,
} from "../protocol/process-start";
import {
  processValueSchema,
  type ProcessData,
} from "../protocol/service-processes";
import type { ProcessInputCopyKey } from "./process-input-copy";

export type ProcessFormInput = Record<string, ProcessInputValue>;
export type ProcessFormPath = (string | number)[];
export type ProcessFormIssue = {
  path: ProcessFormPath;
  message: ProcessInputCopyKey;
};
export type ProcessDraft = { present: boolean } & (
  | { kind: "string"; value: string | undefined }
  | { kind: "number"; value: string }
  | { kind: "boolean"; value: boolean | undefined }
  | { kind: "null" }
  | { kind: "object"; children: ReadonlyMap<string, ProcessDraft> }
  | { kind: "array"; items: { id: string; draft: ProcessDraft }[] }
);

/** Bound hostile input before recursive Zod parsing or serialization. No getters run. */
export function boundedProcessCard(raw: unknown): boolean {
  let nodes = 0;
  const ancestors = new Set<object>();
  const visit = (value: unknown, depth: number): boolean => {
    if (++nodes > 32768 || depth > 24) return false;
    if (value === null || typeof value === "boolean") return true;
    if (typeof value === "string") return value.length <= 65536;
    if (typeof value === "number") return Number.isFinite(value);
    if (!value || typeof value !== "object" || ancestors.has(value))
      return false;
    if (Object.getOwnPropertySymbols(value).length) return false;
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (
      array
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    )
      return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (keys.length > 32768 - nodes + 1) return false;
    ancestors.add(value);
    let valid = true;
    if (array) {
      const length = descriptors.length?.value;
      if (!Number.isInteger(length) || length < 0 || keys.length !== length + 1)
        valid = false;
      else
        for (let i = 0; i < length && valid; i++) {
          const descriptor = descriptors[i];
          valid =
            !!descriptor &&
            "value" in descriptor &&
            descriptor.enumerable === true &&
            visit(descriptor.value, depth + 1);
        }
    } else {
      for (const key of keys) {
        const descriptor = descriptors[key]!;
        if (
          !descriptor.enumerable ||
          !("value" in descriptor) ||
          !visit(descriptor.value, depth + 1)
        ) {
          valid = false;
          break;
        }
      }
    }
    ancestors.delete(value);
    return valid;
  };
  try {
    return visit(raw, 0);
  } catch {
    return false;
  }
}

export function parseProcessInputCard(raw: unknown): ProcessInputCard | null {
  if (!boundedProcessCard(raw)) return null;
  try {
    const result = ProcessInputCardSchema.safeParse(raw);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Arrays and objects initialize lazily; minItems never allocates child trees. */
export function createProcessDraft(
  schema: ProcessData,
  present = true,
): ProcessDraft {
  switch (schema.type) {
    case "string":
      return { kind: "string", present, value: schema.enum ? undefined : "" };
    case "number":
    case "integer":
      return { kind: "number", present, value: "" };
    case "boolean":
      return { kind: "boolean", present, value: undefined };
    case "null":
      return { kind: "null", present };
    case "object":
      return { kind: "object", present, children: new Map() };
    case "array":
      return { kind: "array", present, items: [] };
  }
}
export const processPathKey = (path: ProcessFormPath) => JSON.stringify(path);
/** Restore only validated submitted input; absence and stable array identities stay local. */
export function createProcessDraftFromInput(
  schema: ProcessData,
  input: unknown,
  itemId: () => string,
  allowPartial = false,
): ProcessDraft | null {
  if (!boundedProcessCard(input)) return null;
  const bounded = ProcessStartInputSchema.safeParse(input);
  if (
    !bounded.success ||
    (allowPartial
      ? schema.type !== "object" ||
        Object.entries(bounded.data).some(
          ([key, value]) =>
            !schema.properties[key] ||
            !processValueSchema(schema.properties[key]!).safeParse(value)
              .success,
        )
      : !processValueSchema(schema).safeParse(bounded.data).success)
  )
    return null;
  const restore = (
    definition: ProcessData,
    value: ProcessInputValue,
  ): ProcessDraft => {
    switch (definition.type) {
      case "string":
        return { kind: "string", present: true, value: value as string };
      case "number":
      case "integer":
        return { kind: "number", present: true, value: String(value) };
      case "boolean":
        return { kind: "boolean", present: true, value: value as boolean };
      case "null":
        return { kind: "null", present: true };
      case "array":
        return {
          kind: "array",
          present: true,
          items: (value as ProcessInputValue[]).map((child) => ({
            id: itemId(),
            draft: restore(definition.items, child),
          })),
        };
      case "object": {
        const values = value as Record<string, ProcessInputValue>;
        return {
          kind: "object",
          present: true,
          children: new Map(
            Object.entries(definition.properties).map(([key, child]) => [
              key,
              Object.hasOwn(values, key)
                ? restore(child, values[key]!)
                : createProcessDraft(child, definition.required.includes(key)),
            ]),
          ),
        };
      }
    }
  };
  return restore(schema, bounded.data);
}
const numericText = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

export function validateProcessDraft(
  schema: ProcessData,
  draft: ProcessDraft,
):
  | { success: true; input: ProcessFormInput; issues: [] }
  | { success: false; issues: ProcessFormIssue[] } {
  const issues: ProcessFormIssue[] = [];
  const collect = (
    definition: ProcessData,
    node: ProcessDraft,
    path: ProcessFormPath,
  ): ProcessInputValue | undefined => {
    if (!node.present) return undefined;
    switch (node.kind) {
      case "string":
      case "boolean":
        if (node.value === undefined)
          issues.push({ path, message: "errorRequired" });
        return node.value;
      case "null":
        return null;
      case "number": {
        const text = node.value.trim();
        const value = numericText.test(text) ? Number(text) : NaN;
        if (!Number.isFinite(value)) {
          issues.push({
            path,
            message: text ? "errorNumber" : "errorRequired",
          });
          return undefined;
        }
        return value;
      }
      case "array":
        if (definition.type !== "array") return undefined;
        return node.items.map(
          (item, index) =>
            collect(definition.items, item.draft, [...path, index]) ?? null,
        );
      case "object": {
        if (definition.type !== "object") return undefined;
        const entries: [string, ProcessInputValue][] = [];
        for (const [key, child] of Object.entries(definition.properties)) {
          const value = collect(
            child,
            node.children.get(key) ??
              createProcessDraft(child, definition.required.includes(key)),
            [...path, key],
          );
          if (value !== undefined) entries.push([key, value]);
        }
        return Object.fromEntries(entries);
      }
    }
  };
  const input = collect(schema, draft, []);
  const valueResult = processValueSchema(schema).safeParse(input);
  if (!valueResult.success) {
    for (const issue of valueResult.error.issues) {
      const path = issue.path.filter(
        (part): part is string | number =>
          typeof part === "string" || typeof part === "number",
      );
      if (
        issues.some(
          (current) => processPathKey(current.path) === processPathKey(path),
        )
      )
        continue;
      let field = schema;
      for (const part of path) {
        if (
          field.type === "object" &&
          typeof part === "string" &&
          Object.hasOwn(field.properties, part)
        )
          field = field.properties[part]!;
        else if (field.type === "array" && typeof part === "number")
          field = field.items;
      }
      let message: ProcessInputCopyKey = "errorInvalid";
      if (issue.code === "invalid_type")
        message = field.type === "integer" ? "errorInteger" : "errorRequired";
      else if (issue.code === "too_small" || issue.code === "too_big")
        message =
          field.type === "array"
            ? "errorCount"
            : field.type === "string"
              ? "errorLength"
              : "errorRange";
      issues.push({ path, message });
    }
  }
  if (issues.length) return { success: false, issues };
  const admission = ProcessStartInputSchema.safeParse(input);
  if (!admission.success)
    return { success: false, issues: [{ path: [], message: "errorSize" }] };
  return { success: true, input: admission.data, issues: [] };
}
