import { z } from "zod";
import { PROFILE } from "../protocol";
import { AuthenticationError } from "./auth";
import type {
  ConnectionDiagnostic,
  ConnectionPhase,
} from "../protocol/connection-diagnostic";
export type {
  ConnectionDiagnostic,
  ConnectionPhase,
} from "../protocol/connection-diagnostic";
export class ConnectionHttpError extends Error {
  constructor(readonly httpStatus: number) {
    super("connection_failed");
  }
}
export class ConnectionJsonError extends SyntaxError {
  constructor(readonly httpStatus: number) {
    super("Invalid server JSON response");
  }
}
export class ConnectionPayloadError extends Error {
  constructor(readonly httpStatus: number) {
    super("payload_too_large");
  }
}
// Paths are schema vocabulary only: map keys, private values and error text never
// enter the diagnostic. Unknown server versions are omitted, never echoed.
const fields = new Set([
  "profile",
  "scope",
  "serverId",
  "connectionId",
  "workspaceId",
  "userId",
  "conversations",
  "messages",
  "workItems",
  "inputRequests",
  "actionProposals",
  "operations",
  "cards",
  "events",
  "cursor",
  "revision",
  "replyToCommandId",
  "commandId",
  "conversationId",
  "workItemId",
  "status",
  "createdAt",
  "updatedAt",
  "type",
  "text",
  "id",
  "authProfile",
  "permissions",
  "expiresAt",
  "result",
  "title",
  "kind",
  "content",
  "version",
  "source",
  "inputRequestIds",
  "actionProposalIds",
]);
export function connectionDiagnostic(
  error: unknown,
  phase: ConnectionPhase,
  httpStatus?: number,
  response?: unknown,
): ConnectionDiagnostic {
  const status =
    error instanceof ConnectionHttpError ||
    error instanceof ConnectionJsonError ||
    error instanceof ConnectionPayloadError ||
    error instanceof AuthenticationError
      ? error.httpStatus
      : httpStatus;
  const base = {
    phase,
    ...(status !== undefined ? { httpStatus: status } : {}),
  };
  if (error instanceof ConnectionHttpError) return { ...base, reason: "http" };
  if (
    error instanceof AuthenticationError &&
    status !== undefined &&
    status >= 400
  )
    return { ...base, reason: "http" };
  if (error instanceof z.ZodError) {
    const profile =
      response && typeof response === "object" && "profile" in response
        ? response.profile
        : undefined;
    const mismatch =
      (phase === "snapshot" || phase === "events") &&
      error.issues.some(
        (issue) => issue.path.length === 1 && issue.path[0] === "profile",
      );
    return {
      ...base,
      reason: mismatch ? "protocol" : "schema",
      ...(mismatch
        ? {
            expectedProfile: PROFILE,
            ...(typeof profile === "string" &&
            /^agent-client\/\d{1,3}\.\d{1,3}-fixture$/.test(profile)
              ? { receivedProfile: profile }
              : {}),
          }
        : {}),
      fields: [
        ...new Set(
          error.issues.slice(0, 8).map((issue) =>
            issue.path
              .slice(0, 8)
              .map((part) =>
                typeof part === "number"
                  ? "[]"
                  : fields.has(String(part))
                    ? String(part)
                    : "[item]",
              )
              .join("."),
          ),
        ),
      ]
        .filter(Boolean)
        .slice(0, 4),
    };
  }
  if (error instanceof SyntaxError)
    return { ...base, reason: status && status >= 400 ? "http" : "response" };
  if (error instanceof Error) {
    if (error.message === "payload_too_large")
      return { ...base, reason: "payload" };
    if (
      error.message === "scope_mismatch" ||
      error.message === "auth_scope_mismatch"
    )
      return { ...base, reason: "scope" };
    if (error.name === "AbortError" || error.message === "session_stopped")
      return { ...base, reason: "timeout" };
    if (
      ["Network request failed", "Failed to fetch", "fetch failed"].includes(
        error.message,
      )
    )
      return { ...base, reason: "network" };
  }
  return { ...base, reason: "unknown" };
}
