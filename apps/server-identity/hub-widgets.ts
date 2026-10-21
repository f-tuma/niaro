import {
  HubFieldSchema,
  HubWidgetDataSchema,
  type HubField,
  type HubWidgetData,
  type HubWidgetView,
} from "../../packages/protocol/hub";
import type { ProcessData } from "../../packages/protocol/service-processes";
import { loopText } from "./loop-redaction";

/*
 * Redaction shared by every reading of a process output on the overview, and
 * the dashboard's widgets: the output's fields from the frozen output schema,
 * a bounded redacted copy of the latest output, and its projection into a
 * widget's view.
 */
const SENSITIVE_KEY =
  /api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|password|passwd|secret|private[_-]?key|credential|cookie|bearer|jwt/i;
/** Whole words of a key ("pinCode", "session_id") that mark it as secret. */
const SENSITIVE_WORDS = new Set([
  "token",
  "tokens",
  "jwt",
  "cookie",
  "cookies",
  "session",
  "sessionid",
  "otp",
  "totp",
  "pin",
  "passcode",
  "pwd",
  "secret",
  "password",
  "apikey",
  "authorization",
]);
export function sensitiveKey(key: string) {
  if (SENSITIVE_KEY.test(key)) return true;
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((word) => SENSITIVE_WORDS.has(word));
}
/** Credential shapes hidden wherever they appear in a value. */
const SECRET_VALUES = [
  /\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{4,}){1,2}/g, // JWT
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bglpat-[A-Za-z0-9_-]{20,}/g, // GitLab
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI-style keys, incl. sk-proj-/sk-ant-
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{10,}/g, // Stripe
  /\bagent_mcp_[A-Za-z0-9_-]{20,}/g, // this server's MCP tokens
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];
export function hubText(value: string) {
  let clean = loopText(value, Infinity);
  for (const pattern of SECRET_VALUES)
    clean = clean.replace(pattern, "[redacted]");
  return clean;
}
export const TEXT_KEYS = [
  "markdown",
  "summary",
  "text",
  "report",
  "message",
  "content",
  "shrnuti",
  "souhrn",
  "zprava",
];
/** "dueDate" / "due_date" → "Due date". */
export function humanLabel(key: string) {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return (words.charAt(0).toUpperCase() + words.slice(1)).slice(0, 160) || key;
}
export function clip(value: string, limit: number) {
  return value.length > limit ? value.slice(0, limit - 1) + "…" : value;
}
const scalarType = (schema: ProcessData) =>
  schema.type === "number" || schema.type === "integer"
    ? ("number" as const)
    : schema.type === "string" || schema.type === "boolean"
      ? schema.type
      : undefined;
const scalarFields = (schema: ProcessData) =>
  schema.type === "object"
    ? Object.entries(schema.properties)
        .filter(([key]) => !sensitiveKey(key))
        .flatMap(([key, value]) => {
          const type = scalarType(value);
          return type ? [{ key, label: humanLabel(key), type }] : [];
        })
        .slice(0, 24)
    : [];

/**
 * The top-level fields of an output schema a widget can show; sensitive keys
 * are left out, as they are from every output.
 */
export function hubFields(schema: ProcessData): HubField[] | null {
  if (schema.type !== "object") return null;
  return Object.entries(schema.properties)
    .filter(([key]) => !sensitiveKey(key))
    .flatMap(([key, value]): HubField[] => {
      const label = humanLabel(key);
      const scalar = scalarType(value);
      if (scalar) return [{ key, label, type: scalar }];
      if (value.type === "array") {
        const items = scalarType(value.items);
        return [
          items
            ? { key, label, type: "array", items }
            : { key, label, type: "array", fields: scalarFields(value.items) },
        ];
      }
      if (value.type === "object")
        return [{ key, label, type: "object", fields: scalarFields(value) }];
      return [];
    })
    .slice(0, 24)
    .map((field) => HubFieldSchema.parse(field));
}

/** A bounded, redacted copy of an output: scalars, arrays of scalars or flat
 * objects, never a sensitive key or a credential-like value. */
export type HubSnapshot = {
  values: Record<string, unknown>;
  /** The full length of each array before it was cut. */
  totals: Record<string, number>;
};
const SNAPSHOT_BYTES = 64 * 1024;
export function hubSnapshot(raw: unknown): HubSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const clean = (value: unknown, limit: number) =>
    typeof value === "string"
      ? clip(hubText(value), limit)
      : (typeof value === "number" && Number.isFinite(value)) ||
          typeof value === "boolean"
        ? value
        : null;
  const flat = (value: object) =>
    Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !sensitiveKey(key))
        .slice(0, 12)
        .map(([key, item]) => [key, clean(item, 200)]),
    );
  const entry = (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? flat(value)
      : clean(value, 200);
  const build = (rows: number): HubSnapshot => {
    const values: Record<string, unknown> = {};
    const totals: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw).slice(0, 40)) {
      if (sensitiveKey(key)) continue;
      if (Array.isArray(value)) {
        totals[key] = value.length;
        values[key] = value.slice(0, rows).map(entry);
      } else
        values[key] =
          value && typeof value === "object" ? flat(value) : clean(value, 4000);
    }
    return { values, totals };
  };
  // Long arrays are cut further until the copy is small enough to keep.
  for (const rows of [50, 24, 10, 3, 0]) {
    const snapshot = build(rows);
    if (JSON.stringify(snapshot).length <= SNAPSHOT_BYTES) return snapshot;
  }
  return { values: {}, totals: {} };
}

const asNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const asText = (value: unknown, limit: number) =>
  value === null || value === undefined
    ? ""
    : typeof value === "boolean"
      ? value
        ? "✓"
        : "✗"
      : clip(String(value), limit);
const cell = (value: unknown) =>
  typeof value === "string"
    ? clip(value, 500)
    : (asNumber(value) ?? (typeof value === "boolean" ? value : null));

/**
 * The widget's data from the latest good output (and the one before it, for
 * a comparison). Null when there is no output yet, or it lacks the view's
 * fields (the process changed since the view was chosen).
 */
export function hubWidgetData(
  view: HubWidgetView,
  fields: HubField[] | null,
  current: HubSnapshot | null,
  previous: HubSnapshot | null = null,
): HubWidgetData | null {
  if (
    !current ||
    view.type === "summary" ||
    view.type === "tasks" ||
    view.type === "widget"
  )
    return null;
  const value = current.values[view.field];
  if (value === undefined) return null;
  const rows = Array.isArray(value) ? (value as unknown[]) : null;
  const total = current.totals[view.field] ?? rows?.length ?? 0;
  const inner = fields?.find((field) => field.key === view.field)?.fields;
  const get = (row: unknown, key: string | undefined) =>
    key && row && typeof row === "object" && !Array.isArray(row)
      ? (row as Record<string, unknown>)[key]
      : row;
  let data: HubWidgetData | null = null;
  switch (view.type) {
    case "number": {
      const compare =
        view.compare === "previous"
          ? asNumber(previous?.values[view.field])
          : view.compare
            ? asNumber(current.values[view.compare.field])
            : undefined;
      data = {
        type: "number",
        value: asNumber(value) ?? null,
        ...(compare !== undefined ? { compare: { value: compare } } : {}),
      };
      break;
    }
    case "text":
      if (typeof value !== "string") return null;
      data = { type: "text", text: clip(value, 4000) };
      break;
    case "list": {
      if (!rows) return null;
      const shown = rows.slice(0, 20).map((row) => {
        const subtitle = view.subtitle
          ? asText(get(row, view.subtitle), 500)
          : "";
        return {
          title: asText(get(row, view.title), 500),
          ...(subtitle ? { subtitle } : {}),
        };
      });
      data = { type: "list", rows: shown, more: total - shown.length };
      break;
    }
    case "table": {
      if (!rows) return null;
      const shown = rows
        .slice(0, 20)
        .map((row) => view.columns.map((column) => cell(get(row, column.key))));
      data = {
        type: "table",
        columns: view.columns.map((column) => ({
          key: column.key,
          label:
            column.label ??
            inner?.find((field) => field.key === column.key)?.label ??
            humanLabel(column.key),
        })),
        rows: shown,
        more: total - shown.length,
      };
      break;
    }
    case "chart": {
      if (!rows) return null;
      const points = rows.flatMap((row) => {
        const y = asNumber(get(row, view.y));
        return y === undefined
          ? []
          : [{ label: asText(get(row, view.x), 160), value: y }];
      });
      const shown = points.slice(0, 24);
      data = {
        type: "chart",
        points: shown,
        more: Math.max(0, total - rows.length) + points.length - shown.length,
      };
      break;
    }
  }
  return HubWidgetDataSchema.parse(data);
}
