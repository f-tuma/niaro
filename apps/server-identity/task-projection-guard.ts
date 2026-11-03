import { operatorLog } from "../fixture-server/operator-log";
import { IdentityError } from "./error";

/**
 * A failure that belongs to the whole read rather than to one task: the person
 * is no longer signed in or allowed, the request was cancelled, or the server
 * cannot answer now. These still fail the read; anything else is one task's.
 */
export function requestLevelFailure(error: unknown) {
  if (error instanceof IdentityError)
    return (
      error.status === 401 ||
      error.status === 503 ||
      error.code === "identity_forbidden"
    );
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Projects one task, or skips it with an operator log line when only that
 * task cannot be projected, so one bad record never fails a person's whole
 * snapshot or events read. The log names the task kind, its run id and the
 * error class or code, never the task's content.
 */
export async function projectOrSkip<T>(
  kind: string,
  id: string,
  project: () => Promise<T | null> | T | null,
): Promise<T | null> {
  try {
    return await project();
  } catch (error) {
    if (requestLevelFailure(error)) throw error;
    logSkippedTask(kind, id, error);
    return null;
  }
}

export function logSkippedTask(kind: string, id: unknown, error: unknown) {
  operatorLog(
    "task_projection_skipped",
    {
      kind,
      runId: typeof id === "string" ? id.slice(0, 160) : undefined,
      error: failureName(error),
    },
    "warn",
  );
}

export function failureName(error: unknown) {
  if (error instanceof IdentityError) return error.code.slice(0, 60);
  return error instanceof Error
    ? error.constructor.name.slice(0, 60)
    : typeof error;
}
