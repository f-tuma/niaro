import { translate } from "../../packages/i18n";
import type { Scope, Language } from "../../packages/protocol";
import { processValueSchema } from "../../packages/protocol/service-processes";
import {
  PROCESS_OUTPUT_PROFILE,
  PROCESS_OUTPUT_REDACTION_VERSION,
  PROCESS_OUTPUT_MAX_VALUE_BYTES,
  PROCESS_OUTPUT_MAX_VALUE_NODES,
  PROCESS_OUTPUT_MAX_PATH,
  PROCESS_OUTPUT_MAX_PAGE_BYTES,
  PROCESS_OUTPUT_MAX_PAGE_CHILDREN,
  ProcessOutputReferenceSchema,
  ProcessOutputRequestSchema,
  ProcessOutputPageSchema,
  type ProcessOutputReference,
  type ProcessOutputRequest,
  type ProcessOutputPath,
  type ProcessOutputNode,
  type ProcessOutputPage,
} from "../../packages/protocol/process-output";
import { processDigest } from "./process-validation";
import { IdentityError } from "./error";
import { loopText } from "./loop-redaction";
import type {
  ProcessReadCapture,
  ProcessReadWindow,
} from "./process-read-window";

export type ProcessOutputTree =
  | { kind: "object"; children: { label: string; node: ProcessOutputTree }[] }
  | { kind: "array"; children: ProcessOutputTree[] }
  | Exclude<ProcessOutputNode, { kind: "object" | "array" }>;

/** Preflight plain JSON without executing accessors or recursive schema parsing. */
function boundedOutput(raw: unknown) {
  let nodes = 0,
    bytes = 0;
  const ancestors = new Set<object>();
  const visit = (value: unknown, depth: number): boolean => {
    if (
      ++nodes > PROCESS_OUTPUT_MAX_VALUE_NODES ||
      depth > PROCESS_OUTPUT_MAX_PATH
    )
      return false;
    if (typeof value === "string") {
      bytes += Buffer.byteLength(value);
      return bytes <= PROCESS_OUTPUT_MAX_VALUE_BYTES;
    }
    if (value === null || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (
      !value ||
      typeof value !== "object" ||
      ancestors.has(value) ||
      Object.getOwnPropertySymbols(value).length
    )
      return false;
    const array = Array.isArray(value),
      proto = Object.getPrototypeOf(value);
    if (
      array
        ? proto !== Array.prototype
        : proto !== Object.prototype && proto !== null
    )
      return false;
    const descriptors = Object.getOwnPropertyDescriptors(value),
      keys = Object.keys(descriptors);
    if (keys.length > PROCESS_OUTPUT_MAX_VALUE_NODES - nodes + 1) return false;
    ancestors.add(value);
    let valid = true;
    if (array) {
      const length: unknown = descriptors.length?.value;
      if (
        typeof length !== "number" ||
        !Number.isInteger(length) ||
        length < 0 ||
        keys.length !== length + 1
      )
        valid = false;
      else
        for (let index = 0; index < length && valid; index++) {
          const d = descriptors[index];
          valid =
            !!d &&
            "value" in d &&
            d.enumerable === true &&
            visit(d.value, depth + 1);
        }
    } else
      for (const key of keys) {
        bytes += Buffer.byteLength(key);
        const d = descriptors[key]!;
        if (
          bytes > PROCESS_OUTPUT_MAX_VALUE_BYTES ||
          !d.enumerable ||
          !("value" in d) ||
          !visit(d.value, depth + 1)
        ) {
          valid = false;
          break;
        }
      }
    ancestors.delete(value);
    return valid;
  };
  try {
    return (
      visit(raw, 0) &&
      Buffer.byteLength(JSON.stringify(raw)) <= PROCESS_OUTPUT_MAX_VALUE_BYTES
    );
  } catch {
    return false;
  }
}

/** Redact the complete typed value before ordering, digest, paths or wire serialization. */
export function sanitizeProcessOutput(raw: unknown): {
  tree: ProcessOutputTree;
  redacted: boolean;
} {
  if (!boundedOutput(raw)) throw new IdentityError(413, "process_output_limit");
  let redacted = false;
  const visit = (value: unknown): ProcessOutputTree => {
    if (value === null) return { kind: "null", value: null };
    if (typeof value === "boolean") return { kind: "boolean", value };
    if (typeof value === "number") return { kind: "number", value };
    if (typeof value === "string") {
      const safe = loopText(value, Infinity);
      if (safe !== value) redacted = true;
      // Redaction may expand a valid leaf. Preserve the complete safe result
      // as an explicit hidden node rather than clipping or rejecting its run.
      if (safe.length > 4000) {
        redacted = true;
        return { kind: "redacted" };
      }
      return { kind: "string", value: safe };
    }
    if (Array.isArray(value))
      return { kind: "array", children: value.map(visit) };
    const children = Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => {
        const safe = loopText(key, Infinity);
        const unsafeKey = safe !== key;
        const sensitive =
          /api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|private[_-]?key|credential/i.test(
            key,
          );
        if (unsafeKey || sensitive) redacted = true;
        return {
          label: unsafeKey || sensitive ? "[redacted field]" : safe,
          node:
            unsafeKey || sensitive
              ? { kind: "redacted" as const }
              : visit(item),
        };
      },
    );
    children.sort((a, b) => {
      const left = JSON.stringify([a.label, a.node]),
        right = JSON.stringify([b.label, b.node]);
      return left < right ? -1 : left > right ? 1 : 0;
    });
    return { kind: "object", children };
  };
  const tree = visit(raw);
  if (Buffer.byteLength(JSON.stringify(tree)) > PROCESS_OUTPUT_MAX_VALUE_BYTES)
    throw new IdentityError(413, "process_output_limit");
  return { tree, redacted };
}
export function processOutputNode(tree: ProcessOutputTree): ProcessOutputNode {
  return tree.kind === "object" || tree.kind === "array"
    ? { kind: tree.kind, childCount: tree.children.length }
    : tree;
}
export function processOutputPreview(
  tree: ProcessOutputTree,
  language: Language,
): string {
  const tr = translate(language);
  if (tree.kind === "object")
    return tree.children.length
      ? tr("processOutputObject").replace(
          "{count}",
          String(tree.children.length),
        )
      : "{}";
  if (tree.kind === "array")
    return tree.children.length
      ? tr("processOutputArray").replace(
          "{count}",
          String(tree.children.length),
        )
      : "[]";
  if (tree.kind === "redacted") return tr("processOutputHidden");
  return JSON.stringify(tree.value);
}

export function prepareProcessOutput(
  captured: ProcessReadCapture,
  scope: Scope,
) {
  const { journal, saved, artifact, receipts, detailsAvailable } = captured;
  if (
    journal.output === undefined ||
    journal.status !== "succeeded" ||
    receipts.some((r) => r?.status === "unknown")
  )
    return null;
  if (!detailsAvailable)
    return { available: false as const, reason: "context" as const };
  if (!boundedOutput(journal.output))
    return { available: false as const, reason: "limit" as const };
  const parsed = processValueSchema(artifact.definition.outputSchema).safeParse(
    journal.output,
  );
  if (!parsed.success)
    return { available: false as const, reason: "invalid" as const };
  let sanitized: ReturnType<typeof sanitizeProcessOutput>;
  try {
    sanitized = sanitizeProcessOutput(parsed.data);
  } catch (error) {
    if (
      !(error instanceof IdentityError) ||
      error.code !== "process_output_limit"
    )
      throw error;
    return { available: false as const, reason: "limit" as const };
  }
  const admission = saved.receipt;
  if (admission.status !== "admitted" || sanitized.tree.kind !== "object")
    throw new IdentityError(409, "process_start_conflict");
  const reference = ProcessOutputReferenceSchema.parse({
    profile: PROCESS_OUTPUT_PROFILE,
    scope,
    parentRunId: admission.parentRunId,
    nativeRevision: journal.revision,
    provenance: {
      runId: journal.runId,
      processId: journal.processId,
      version: journal.version,
      artifactDigest: journal.artifactDigest,
      actorId: scope.userId,
      conversationId: admission.origin.conversationId,
      commandId: admission.commandId,
      admissionId: admission.receiptId,
    },
    origin: admission.origin,
    outputDigest: processDigest(sanitized.tree),
    redactionVersion: PROCESS_OUTPUT_REDACTION_VERSION,
  });
  const shown = sanitized.tree.children.slice(0, 8);
  return {
    available: true as const,
    reference,
    tree: sanitized.tree,
    summary: {
      fieldCount: sanitized.tree.children.length,
      shownFields: shown.length,
      clipped:
        shown.length < sanitized.tree.children.length ||
        shown.some(
          (entry) =>
            processOutputPreview(entry.node, saved.command.language).length >
              1000 ||
            ((entry.node.kind === "object" || entry.node.kind === "array") &&
              entry.node.children.length > 0),
        ),
      redacted: sanitized.redacted,
    },
  };
}

export function processOutputCursor(
  reference: ProcessOutputReference,
  path: ProcessOutputPath,
  offset: number,
) {
  return offset + "." + processDigest([reference, path, offset]);
}
export function pageProcessOutput(
  tree: ProcessOutputTree,
  rawRequest: ProcessOutputRequest,
): ProcessOutputPage {
  const request = ProcessOutputRequestSchema.parse(rawRequest);
  let selected = tree;
  for (const segment of request.path) {
    if (segment.kind === "property" && selected.kind === "object")
      selected = selected.children[segment.index]?.node!;
    else if (segment.kind === "item" && selected.kind === "array")
      selected = selected.children[segment.index]!;
    else throw new IdentityError(400, "process_output_path_invalid");
    if (!selected) throw new IdentityError(400, "process_output_path_invalid");
  }
  const container =
    selected.kind === "object" || selected.kind === "array"
      ? selected
      : undefined;
  const total = container ? container.children.length : 0;
  const offset =
    request.cursor === null ? 0 : Number(request.cursor.split(".")[0]);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    (offset >= total && request.cursor !== null) ||
    (request.cursor !== null &&
      request.cursor !==
        processOutputCursor(request.reference, request.path, offset))
  )
    throw new IdentityError(409, "process_output_cursor_invalid");
  const children: ProcessOutputPage["children"] = [];
  const build = (): ProcessOutputPage => ({
    profile: PROCESS_OUTPUT_PROFILE,
    ...request,
    node: processOutputNode(selected),
    offset,
    total,
    children,
    nextCursor:
      offset + children.length < total
        ? processOutputCursor(
            request.reference,
            request.path,
            offset + children.length,
          )
        : null,
  });
  if (container)
    for (
      let index = offset;
      index < Math.min(total, offset + PROCESS_OUTPUT_MAX_PAGE_CHILDREN);
      index++
    ) {
      const child =
        container.kind === "object"
          ? {
              index,
              label: container.children[index]!.label,
              node: processOutputNode(container.children[index]!.node),
            }
          : { index, node: processOutputNode(container.children[index]!) };
      children.push(child);
      if (
        Buffer.byteLength(JSON.stringify(build())) >
        PROCESS_OUTPUT_MAX_PAGE_BYTES
      ) {
        children.pop();
        break;
      }
    }
  const page = build();
  if (
    Buffer.byteLength(JSON.stringify(page)) > PROCESS_OUTPUT_MAX_PAGE_BYTES ||
    (container && offset < total && children.length === 0)
  )
    throw new IdentityError(413, "process_output_limit");
  return ProcessOutputPageSchema.parse(page);
}

/** A reference selects data; only the current shared read window authorizes it. */
export async function readProcessOutput(
  window: ProcessReadWindow | null,
  request: ProcessOutputRequest,
  scope: Scope,
) {
  if (!window) throw new IdentityError(404, "process_output_not_found");
  const output = prepareProcessOutput(window.value, scope);
  if (!output) throw new IdentityError(409, "process_output_unavailable");
  if (!output.available)
    throw new IdentityError(
      output.reason === "limit" ? 413 : 403,
      output.reason === "limit"
        ? "process_output_limit"
        : "process_output_unavailable",
    );
  if (processDigest(output.reference) !== processDigest(request.reference))
    throw new IdentityError(409, "process_output_changed");
  return window.publish(() => pageProcessOutput(output.tree, request));
}
