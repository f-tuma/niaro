import { sameScope, type Scope } from "../protocol";
import {
  ProcessExecutionEntrySchema,
  ProcessExecutionInventorySchema,
  ProcessInputCardSchema,
  ProcessInputRequestSchema,
  type ProcessExecutionEntry,
  type ProcessExecutionInventory,
  type ProcessInputRequest,
} from "../protocol/process-execution";
import {
  captureProcessStartTarget,
  deepFreezeProcessValue,
  type ProcessStartTarget,
} from "./process-commands";
import { canonicalProcessJson } from "./process-command-digest";

/** Mobile resource limits fail closed; a partial list is never selectable.
 * These are client limits, not a claim that every registry-sized inventory fits.
 * Per-schema limits retain the registry's 5,000-node/64 KiB string/key budget.
 */
export const PROCESS_INVENTORY_PAGE_BYTES = 4 * 1024 * 1024;
export const PROCESS_INVENTORY_TOTAL_BYTES = 16 * 1024 * 1024;
export const PROCESS_INVENTORY_MAX_ENTRIES = 1000;
export const PROCESS_INVENTORY_MAX_PAGES = 10;
export const PROCESS_INPUT_RESPONSE_BYTES = 2 * 1024 * 1024;
export type ReadyProcessExecutionEntry = Extract<
  ProcessExecutionEntry,
  { availability: "ready" }
>;
export type ProcessExecutionList = Readonly<{
  scope: Scope;
  fingerprint: string;
  processes: readonly ProcessExecutionEntry[];
  /** A changed paginated inventory was discarded and reread once. */
  refreshed: boolean;
}>;

export class ProcessReaderError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProcessReaderError";
  }
}

/** Portable UTF-8 accounting, with an optional early-out for hostile strings. */
export function processReaderUtf8Bytes(text: string, limit = Infinity): number {
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes > limit) return bytes;
  }
  return bytes;
}

/** Bound plain values before recursive schema parsing. Accessors never execute. */
export function boundedProcessReaderJson(
  raw: unknown,
  maxNodes: number,
  stringBudget = Infinity,
) {
  let nodes = 0,
    bytes = 0;
  const ancestors = new Set<object>();
  const visit = (value: unknown, depth: number): boolean => {
    if (++nodes > maxNodes || depth > 24) return false;
    if (value === null || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value === "string") {
      if (value.length > 65536) return false;
      bytes += processReaderUtf8Bytes(value, stringBudget - bytes);
      return bytes <= stringBudget;
    }
    if (!value || typeof value !== "object" || ancestors.has(value))
      return false;
    if (Object.getOwnPropertySymbols(value).length) return false;
    const array = Array.isArray(value),
      prototype = Object.getPrototypeOf(value);
    if (
      array
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    )
      return false;
    const descriptors = Object.getOwnPropertyDescriptors(value),
      keys = Object.keys(descriptors);
    if (keys.length > maxNodes - nodes + 1) return false;
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
        for (let i = 0; i < length && valid; i++) {
          const descriptor = descriptors[i];
          bytes += processReaderUtf8Bytes(String(i), stringBudget - bytes);
          valid =
            bytes <= stringBudget &&
            !!descriptor &&
            "value" in descriptor &&
            descriptor.enumerable === true &&
            visit(descriptor.value, depth + 1);
        }
    } else {
      for (const key of keys) {
        const descriptor = descriptors[key]!;
        bytes += processReaderUtf8Bytes(key, stringBudget - bytes);
        if (
          key.length > 65536 ||
          bytes > stringBudget ||
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

const object = (raw: unknown): raw is Record<string, unknown> =>
  !!raw && typeof raw === "object" && !Array.isArray(raw);
const boundedSchema = (raw: unknown) =>
  boundedProcessReaderJson(raw, 5000, 65536);

export function parseProcessInventoryPage(
  raw: unknown,
  scope: Scope,
): ProcessExecutionInventory {
  // A page holds up to 100 independent registry-sized schemas. The form's
  // 32,768-node total guard would incorrectly reject legitimate large pages.
  if (!boundedProcessReaderJson(raw, 100 * 5016 + 32))
    throw new ProcessReaderError("process_inventory_invalid");
  if (
    !object(raw) ||
    !Array.isArray(raw.processes) ||
    raw.processes.some(
      (entry) =>
        object(entry) &&
        "inputSchema" in entry &&
        !boundedSchema(entry.inputSchema),
    )
  )
    throw new ProcessReaderError("process_inventory_invalid");
  const parsed = ProcessExecutionInventorySchema.safeParse(raw);
  if (!parsed.success || !sameScope(parsed.data.scope, scope))
    throw new ProcessReaderError("process_inventory_invalid");
  return parsed.data;
}

export function freezeProcessInputSelection(
  rawRequest: ProcessInputRequest,
  rawEntry: ReadyProcessExecutionEntry,
) {
  if (!boundedProcessReaderJson(rawRequest, 1024))
    throw new ProcessReaderError("process_input_invalid");
  const parsed = ProcessInputRequestSchema.safeParse(rawRequest);
  if (!parsed.success) throw new ProcessReaderError("process_input_invalid");
  if (
    !boundedProcessReaderJson(rawEntry, 5016) ||
    !object(rawEntry) ||
    !boundedSchema(rawEntry.inputSchema)
  )
    throw new ProcessReaderError("process_input_changed");
  const entry = ProcessExecutionEntrySchema.options[0].safeParse(rawEntry);
  if (
    !entry.success ||
    parsed.data.processId !== entry.data.processId ||
    parsed.data.version !== entry.data.version ||
    parsed.data.artifactDigest !== entry.data.artifactDigest
  )
    throw new ProcessReaderError("process_input_changed");
  return deepFreezeProcessValue({ request: parsed.data, entry: entry.data });
}

export function parseProcessInputTarget(
  raw: unknown,
  request: ProcessInputRequest,
  entry: ReadyProcessExecutionEntry,
  endpoint: string,
  scope: Scope,
): ProcessStartTarget {
  if (
    !boundedProcessReaderJson(raw, 32768) ||
    !object(raw) ||
    !object(raw.form) ||
    !object(raw.intent) ||
    !boundedSchema(raw.form.inputSchema) ||
    !boundedSchema(raw.intent.inputSchema)
  )
    throw new ProcessReaderError("process_form_invalid");
  const parsed = ProcessInputCardSchema.safeParse(raw);
  if (
    !parsed.success ||
    !sameScope(parsed.data.form.scope, scope) ||
    parsed.data.form.language !== request.language ||
    canonicalProcessJson(parsed.data.form.origin) !==
      canonicalProcessJson(request.origin)
  )
    throw new ProcessReaderError("process_form_invalid");
  try {
    return captureProcessStartTarget(endpoint, scope, entry, parsed.data);
  } catch {
    throw new ProcessReaderError("process_form_invalid");
  }
}

const serverErrors = new Set([
  "process_inventory_changed",
  "process_inventory_limit",
  "process_not_found",
  "process_active_version_changed",
  "process_execution_unavailable",
  "process_origin_changed",
  "process_profile_unsupported",
  "process_input_invalid",
  "invalid_payload",
  "rate_limit",
  "rate_limited",
]);
export function processReaderServerError(raw: unknown): ProcessReaderError {
  return new ProcessReaderError(
    object(raw) && typeof raw.error === "string" && serverErrors.has(raw.error)
      ? raw.error
      : "process_read_failed",
  );
}
