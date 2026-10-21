import {
  LoopActionDetailsSchema,
  type LoopActionDetails,
  type LoopNode,
} from "../../packages/protocol/loops";
import type { StoredInvocation } from "./service-catalog";
import { loopText } from "./loop-redaction";
import { sanitizeActionFailure } from "../server-integrations/failures";

const normalize = (value: string) =>
  value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\s.-]/g, "")
    .toLowerCase();
const privateKey =
  /(?:password|secret|token|authorization|credential|cookie|session|apikey|privatekey|headers|signature|clientsecret)/;
const opaqueKey =
  /^(?:raw|rawbody|rawresponse|request|response|payload|binary|base64|attachment|attachments|image|images|resource|resources|error|errors|stack|stacktrace)$/;
const envelopes = new Set([
  "data",
  "result",
  "results",
  "items",
  "records",
  "nodes",
  "edges",
  "node",
  "people",
  "contacts",
  "person",
  "contact",
  "events",
  "event",
  "body",
]);
const priority = (key: string) =>
  /^(?:name|firstname|lastname|title|summary|email|phone|start|end|date|duration|query|filter|location|subject|to|recipient)$/.test(
    normalize(key),
  )
    ? 0
    : /^(?:id|createdat|updatedat|deletedat|typename)$/.test(normalize(key))
      ? 2
      : 1;
const label = (key: string) =>
  key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ");
type Preview = { fields: LoopActionDetails["input"]; truncated: boolean };

/** Small structured business preview; sensitive/opaque subtrees are never serialized. */
function preview(raw: unknown, output: boolean): Preview {
  const fields: Preview["fields"] = [];
  let truncated = false;
  let visits = 0;
  let budget = 4000;
  const put = (path: string[], value: string) => {
    const clean = loopText(value, 1001);
    if (!clean.trim()) return;
    if (fields.length >= 12 || budget <= 0) {
      truncated = true;
      return;
    }
    const length = Math.min(1000, budget);
    if (clean.length > length || value.length > 1000) truncated = true;
    const shown = clean.slice(0, length);
    fields.push({
      label: loopText(path.join(" · ") || (output ? "Result" : "Value"), 80),
      value: shown,
    });
    budget -= shown.length;
  };
  const visit = (value: unknown, path: string[], depth: number) => {
    if (++visits > 200 || depth > 8) {
      truncated = true;
      return;
    }
    if (value === null || value === undefined) return;
    if (typeof value === "string") {
      if (/^data:|^[A-Za-z0-9+/]{256,}={0,2}$/.test(value)) {
        truncated = true;
        return;
      }
      const trimmed = value.trim();
      if (/^[\[{]/.test(trimmed)) {
        if (trimmed.length > 32768) {
          truncated = true;
          return;
        }
        try {
          visit(JSON.parse(trimmed), path, depth + 1);
          return;
        } catch {
          /* ordinary bracket-prefixed business text */
        }
      }
      put(path, value);
    } else if (typeof value === "number" && Number.isFinite(value))
      put(path, String(value));
    else if (typeof value === "boolean") put(path, String(value));
    else if (Array.isArray(value)) {
      put([...path, "Returned items"], String(value.length));
      if (value.length > 3) truncated = true;
      value
        .slice(0, 3)
        .forEach((item, index) =>
          visit(item, [...path, `Item ${index + 1}`], depth + 1),
        );
    } else if (typeof value === "object") {
      const object = value as Record<string, unknown>;
      if (output && object.isError === true) {
        truncated = true;
        return;
      }
      // MCP structured results supersede their text copy; never decode media/resources.
      if (output && Object.hasOwn(object, "structuredContent")) {
        if (
          Array.isArray(object.content) &&
          object.content.some(
            (item) =>
              !item ||
              typeof item !== "object" ||
              (item as Record<string, unknown>).type !== "text",
          )
        )
          truncated = true;
        visit(object.structuredContent, path, depth + 1);
        return;
      }
      if (output && Array.isArray(object.content)) {
        const texts = object.content.filter(
          (item): item is { type: "text"; text: string } =>
            !!item &&
            typeof item === "object" &&
            (item as Record<string, unknown>).type === "text" &&
            typeof (item as Record<string, unknown>).text === "string",
        );
        if (texts.length !== object.content.length || texts.length > 3)
          truncated = true;
        texts.slice(0, 3).forEach((item) => visit(item.text, path, depth + 1));
        return;
      }
      const entries = Object.entries(object);
      if (entries.length > 60) truncated = true;
      for (const [key, child] of entries
        .sort(([a], [b]) => priority(a) - priority(b))
        .slice(0, 60)) {
        const normalized = normalize(key);
        if (
          privateKey.test(normalized) ||
          opaqueKey.test(normalized) ||
          key.startsWith("__")
        ) {
          truncated = true;
          continue;
        }
        if (
          output &&
          (normalized === "hasmore" || normalized === "hasnextpage") &&
          child === true
        )
          truncated = true;
        visit(
          child,
          envelopes.has(key) ? path : [...path, label(key)],
          depth + 1,
        );
      }
    }
  };
  visit(raw, [], 0);
  return { fields, truncated };
}

/** Input is canonical receipt data. Output is shown only for a known completed execution. */
export function loopActionDetails(
  receipt: StoredInvocation,
  node: Pick<LoopNode, "status" | "label"> & Partial<Pick<LoopNode, "details">>,
): LoopActionDetails {
  const declined =
    node.details?.some(
      (item) => item.label === "Person's decision" && item.value === "declined",
    ) === true ||
    (node.status === "cancelled" && receipt.status === "rejected");
  const proposal = node.status === "waiting" || declined;
  const status =
    node.status === "waiting"
      ? "awaiting_approval"
      : declined || receipt.status === "rejected"
        ? "rejected"
        : node.status === "running"
          ? "running"
          : node.status === "unknown"
            ? "unknown"
            : node.status === "failed"
              ? "failed"
              : node.status === "interrupted" || node.status === "cancelled"
                ? receipt.effect === "write"
                  ? "unknown"
                  : "failed"
                : receipt.status;
  const input = preview(receipt.input, false);
  const output =
    !proposal && node.status === "succeeded" && status === "succeeded"
      ? preview(receipt.result, true)
      : { fields: [], truncated: false };
  const failure = sanitizeActionFailure(receipt.failure);
  return LoopActionDetailsSchema.parse({
    operationId: receipt.id,
    serviceName: loopText(receipt.serviceName, 100),
    actionName: loopText(receipt.title, 100),
    effect: receipt.effect,
    status,
    phase: proposal ? "proposal" : "execution",
    input: input.fields,
    output: output.fields,
    inputTruncated: input.truncated,
    outputTruncated: output.truncated,
    ...(!proposal && ["failed", "unknown"].includes(status) && failure
      ? {
          failure: {
            ...failure,
            retry:
              status === "unknown" && receipt.effect === "write"
                ? ("verify_first" as const)
                : failure.retry,
            ...(failure.message
              ? { message: loopText(failure.message, 600) }
              : {}),
            fields: failure.fields.map((field) => ({
              path: loopText(field.path, 160),
              issue: loopText(field.issue, 300),
            })),
          },
        }
      : {}),
  });
}
