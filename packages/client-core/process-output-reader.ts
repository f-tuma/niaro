import { sameScope, type Scope } from "../protocol";
import {
  PROCESS_OUTPUT_MAX_PAGE_BYTES,
  PROCESS_OUTPUT_MAX_REQUEST_BYTES,
  ProcessOutputPageSchema,
  ProcessOutputRequestSchema,
  ProcessOutputCapabilitiesSchema,
  type ProcessOutputRequest,
  type ProcessOutputPage,
} from "../protocol/process-output";
import {
  canonicalProcessJson,
  processCommandDigest,
} from "./process-command-digest";
import { deepFreezeProcessValue } from "./process-commands";
import {
  boundedProcessReaderJson,
  processReaderUtf8Bytes,
  ProcessReaderError,
} from "./process-execution-reader";
import type { Store } from "./store";

const equal = (a: unknown, b: unknown) =>
  canonicalProcessJson(a) === canonicalProcessJson(b);
export const processOutputCursor = (
  request: Pick<ProcessOutputRequest, "reference" | "path">,
  offset: number,
) =>
  `${offset}.${processCommandDigest([request.reference, request.path, offset])}`;

/** Copy the selection before any asynchronous work; a reference is never authority. */
export function freezeProcessOutputRequest(raw: unknown): ProcessOutputRequest {
  if (!boundedProcessReaderJson(raw, 5000, PROCESS_OUTPUT_MAX_REQUEST_BYTES))
    throw new ProcessReaderError("process_output_invalid");
  const parsed = ProcessOutputRequestSchema.safeParse(raw);
  if (!parsed.success) throw new ProcessReaderError("process_output_invalid");
  if (
    processReaderUtf8Bytes(
      canonicalProcessJson(parsed.data),
      PROCESS_OUTPUT_MAX_REQUEST_BYTES,
    ) > PROCESS_OUTPUT_MAX_REQUEST_BYTES
  )
    throw new ProcessReaderError("process_output_limit");
  return deepFreezeProcessValue(parsed.data);
}

/** Only the current completed, available work can own a passive detail read. */
export function assertCurrentProcessOutput(
  store: Store | null,
  address: string,
  scope: Scope,
  request: ProcessOutputRequest,
) {
  const work = store?.workItems[request.reference.parentRunId];
  const process = work?.native?.process;
  if (
    !store ||
    store.connectionKey !== address ||
    store.stale ||
    store.needsSnapshot ||
    !sameScope(store.scope, scope) ||
    !sameScope(request.reference.scope, scope) ||
    !work ||
    work.status !== "succeeded" ||
    work.conversationId !== request.reference.origin.conversationId ||
    work.native?.revision !== request.reference.nativeRevision ||
    process?.status !== "succeeded" ||
    process.journalStatus !== "succeeded" ||
    !process.detailsAvailable ||
    process.outputUnavailable ||
    !process.output ||
    !equal(process.provenance, request.reference.provenance) ||
    !equal(process.output, request.reference)
  )
    throw new ProcessReaderError("process_output_changed");
}

export function supportsProcessOutput(raw: unknown, scope: Scope): boolean {
  if (!boundedProcessReaderJson(raw, 64, 4096)) return false;
  const parsed = ProcessOutputCapabilitiesSchema.safeParse(raw);
  return parsed.success && sameScope(parsed.data.scope, scope);
}

/** Verify every page boundary, including the cursor's complete reference/path binding. */
export function parseProcessOutputPage(
  raw: unknown,
  request: ProcessOutputRequest,
  expectedOffset: number,
): ProcessOutputPage {
  if (
    !Number.isSafeInteger(expectedOffset) ||
    expectedOffset < 0 ||
    expectedOffset > 100 ||
    request.cursor !==
      (expectedOffset === 0
        ? null
        : processOutputCursor(request, expectedOffset)) ||
    !boundedProcessReaderJson(raw, 5000, PROCESS_OUTPUT_MAX_PAGE_BYTES)
  )
    throw new ProcessReaderError("process_output_invalid");
  const parsed = ProcessOutputPageSchema.safeParse(raw);
  if (!parsed.success) throw new ProcessReaderError("process_output_invalid");
  const page = parsed.data;
  if (
    processReaderUtf8Bytes(
      canonicalProcessJson(page),
      PROCESS_OUTPUT_MAX_PAGE_BYTES,
    ) > PROCESS_OUTPUT_MAX_PAGE_BYTES
  )
    throw new ProcessReaderError("process_output_limit");
  if (
    !equal(page.reference, request.reference) ||
    !equal(page.path, request.path) ||
    page.cursor !== request.cursor ||
    page.offset !== expectedOffset ||
    page.nextCursor !==
      (page.offset + page.children.length < page.total
        ? processOutputCursor(request, page.offset + page.children.length)
        : null)
  )
    throw new ProcessReaderError("process_output_invalid");
  return deepFreezeProcessValue(page);
}

export function processOutputServerError(raw: unknown): ProcessReaderError {
  const error =
    raw && typeof raw === "object" && "error" in raw ? raw.error : undefined;
  const code =
    error === "process_output_changed"
      ? error
      : error === "process_output_limit"
        ? error
        : error === "process_output_cursor_invalid" ||
            error === "process_output_path_invalid" ||
            error === "invalid_payload"
          ? "process_output_invalid"
          : error === "process_profile_unsupported"
            ? "process_output_unsupported"
            : "process_output_unavailable";
  return new ProcessReaderError(code);
}
