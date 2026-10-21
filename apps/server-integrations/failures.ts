import {
  ActionFailureSchema,
  type ActionFailure,
} from "../../packages/protocol/action-failure";
import { IntegrationError } from "./integration-error";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const sensitive = (name: string) =>
  /password|secret|token|authorization|credential|cookie|session|apikey|privatekey|headers/i.test(
    name.replace(/[_.\s-]/g, ""),
  );

/** Error evidence is a small allowlist projection. It never contains request bodies. */
export function diagnosticText(
  value: unknown,
  limit = 600,
  secretValues: readonly string[] = [],
): string | undefined {
  if (typeof value !== "string" || !value.trim() || value.length > 32768)
    return undefined;
  // Redact exact credentials before clipping, including short personal API keys.
  let result = value;
  for (const secret of [...new Set(secretValues)]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length))
    result = result.split(secret).join("[redacted]");
  result = result
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
      "[redacted]",
    )
    .replace(/\b(?:Bearer|Basic)\s+[^\s"'<>]+/gi, "[redacted authorization]")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,})\b/g,
      "[redacted]",
    )
    .replace(
      /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|session[_-]?id|cookie)\b["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
      "[redacted]",
    )
    .replace(/https?:\/\/[^\s<>"']+/gi, "[redacted URL]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Provider HTML and serialized objects are not useful human diagnostic messages.
  if (/<(?:[!/?]|[A-Za-z][^>]*>)/.test(result) || /^[{[]/.test(result))
    return undefined;
  return result ? result.slice(0, limit) : undefined;
}

function classify(
  code: string,
  httpStatus?: number,
): Pick<ActionFailure, "kind" | "retry"> {
  if (code === "process_origin_changed")
    return { kind: "validation", retry: "none" };
  if (
    [
      "catalog_budget_exhausted",
      "catalog_budget_overrun",
      "catalog_budget_usage_unknown",
    ].includes(code)
  )
    return { kind: "rate_limit", retry: "none" };
  // The provider's daily request counter resets the next day.
  if (code === "catalog_provider_limit")
    return { kind: "rate_limit", retry: "later" };
  if (
    code === "catalog_budget_policy_changed" ||
    code === "catalog_budget_price_required" ||
    code === "catalog_budget_request_too_large"
  )
    return { kind: "permission", retry: "none" };
  if (httpStatus === 429 || /rate.?limit|quota/i.test(code))
    return { kind: "rate_limit", retry: "later" };
  if (
    httpStatus === 401 ||
    /credential|unauthenticated|grant_revoked|login_required|service_connection_required|service_oauth_conflict/i.test(
      code,
    )
  )
    return { kind: "connection", retry: "reconnect" };
  if (
    httpStatus === 403 ||
    /forbidden|denied|permission|not_found|catalog_conflict|context_changed/i.test(
      code,
    )
  )
    return { kind: "permission", retry: "none" };
  if (
    [400, 409, 422].includes(httpStatus ?? 0) ||
    /input_invalid|input_too_large|validation|invalid.?argument|invalid.?data|invalid_args_data|missing.?required/i.test(
      code,
    ) ||
    code === "-32602"
  )
    return { kind: "validation", retry: "correct_input" };
  if (/cancelled|canceled|aborted/i.test(code))
    return { kind: "cancelled", retry: "none" };
  if (
    /response_invalid|response_too_large|schema_unsupported|mcp_unsupported/i.test(
      code,
    )
  )
    return { kind: "response", retry: "none" };
  if (/unavailable|timeout|connection|network/i.test(code))
    return { kind: "connection", retry: "later" };
  return { kind: "provider", retry: "later" };
}

const knownCodes = new Set([
  "identity_forbidden",
  "catalog_not_found",
  "catalog_conflict",
  "catalog_action_denied",
  "catalog_service_denied",
  "catalog_disabled",
  "catalog_pending_limit",
  "catalog_busy",
  "card_context_changed",
  "memory_context_changed",
  "contact_context_changed",
  "process_origin_changed",
  "service_connection_required",
  "service_oauth_grant_revoked",
  "service_oauth_conflict",
  "catalog_budget_exhausted",
  "catalog_budget_overrun",
  "catalog_budget_usage_unknown",
  "catalog_budget_policy_changed",
  "catalog_budget_price_required",
  "catalog_budget_request_too_large",
  "catalog_provider_limit",
]);

/** Re-project saved diagnostics defensively; historical journals are not presentation contracts. */
export function sanitizeActionFailure(
  value: unknown,
): ActionFailure | undefined {
  const object = record(value);
  if (!object) return undefined;
  const fields = Array.isArray(object.fields)
    ? object.fields.slice(0, 8).flatMap((field) => {
        const entry = record(field);
        const path = diagnosticText(entry?.path, 160);
        const issue = diagnosticText(entry?.issue, 300);
        return path && issue && !sensitive(path) ? [{ path, issue }] : [];
      })
    : [];
  const message = diagnosticText(object.message, 600);
  const parsed = ActionFailureSchema.safeParse({
    code: object.code,
    kind: object.kind,
    stage: object.stage,
    retry: object.retry,
    ...(message ? { message } : {}),
    ...(object.httpStatus !== undefined
      ? { httpStatus: object.httpStatus }
      : {}),
    fields,
  });
  return parsed.success ? parsed.data : undefined;
}

export function actionFailure(
  error: unknown,
  options: {
    stage: ActionFailure["stage"];
    effect: "read" | "write";
    dispatched: boolean;
    aborted?: boolean;
  },
): ActionFailure {
  const typed =
    error instanceof IntegrationError
      ? sanitizeActionFailure(error.failure)
      : undefined;
  const candidate =
    error instanceof Error && "code" in error ? String(error.code) : "";
  const code =
    error instanceof IntegrationError
      ? /^[A-Za-z0-9_.-]{1,80}$/.test(error.code)
        ? error.code
        : "action_failed"
      : knownCodes.has(candidate)
        ? candidate
        : options.aborted
          ? "integration_cancelled"
          : "action_failed";
  const failure: ActionFailure = typed
    ? typed
    : {
        code,
        ...(code === "action_failed"
          ? { kind: "unknown" as const, retry: "none" as const }
          : classify(code)),
        stage:
          /input_invalid|input_too_large|schema_unsupported|path_denied/.test(
            code,
          )
            ? "validation"
            : options.dispatched &&
                /response_invalid|response_too_large|provider_failed/.test(code)
              ? "provider_response"
              : options.stage,
        fields: [],
      };
  return ActionFailureSchema.parse({
    ...failure,
    ...(options.aborted ? { kind: "cancelled" } : {}),
    ...(options.dispatched && options.effect === "write"
      ? { retry: "verify_first" }
      : {}),
  });
}

type DiagnosticOptions = {
  httpStatus?: number;
  secretValues?: readonly string[];
  stage?: ActionFailure["stage"];
  omitText?: boolean;
};

/** Only known diagnostic shapes are visited. Credential subtrees are used for redaction only. */
export function providerFailure(
  value: unknown,
  options: DiagnosticOptions = {},
): ActionFailure {
  const secrets = (options.secretValues ?? []).flatMap((secret) => {
    const authorization = /^(?:Bearer|Basic)\s+(.+)$/i.exec(secret);
    const cookies = [...secret.matchAll(/(?:^|;)\s*[^=;]+\s*=\s*([^;]+)/g)].map(
      (match) => match[1]!,
    );
    return [secret, ...(authorization ? [authorization[1]!] : []), ...cookies];
  });
  let secretNodes = 0;
  let secretScanComplete = true;
  const collect = (item: unknown, depth: number, privateTree = false) => {
    if (++secretNodes > 1000 || depth > 8) {
      secretScanComplete = false;
      return;
    }
    if (privateTree && typeof item === "string" && item) secrets.push(item);
    if (Array.isArray(item)) {
      for (const child of item) {
        collect(child, depth + 1, privateTree);
        if (!secretScanComplete) break;
      }
    } else {
      const object = record(item);
      if (object)
        for (const [key, child] of Object.entries(object).sort(
          ([left], [right]) =>
            Number(sensitive(right)) - Number(sensitive(left)),
        )) {
          collect(child, depth + 1, privateTree || sensitive(key));
          if (!secretScanComplete) break;
        }
      if (
        object?.type === "text" &&
        typeof object.text === "string" &&
        object.text.length <= 32768
      ) {
        try {
          collect(JSON.parse(object.text), depth + 1, privateTree);
        } catch {
          /* Plain text has no credential object to traverse. */
        }
      }
    }
  };
  let root = value;
  if (typeof value === "string") {
    // A huge/malformed/HTML body is discarded, not clipped into apparent JSON.
    if (value.length > 32768) root = undefined;
    else {
      try {
        root = JSON.parse(value);
      } catch {
        root = undefined;
      }
    }
  }
  collect(root, 0);
  let code = "integration_provider_failed";
  let message: string | undefined;
  let messagePriority = -1;
  const fields: ActionFailure["fields"] = [];
  let nodes = 0;
  const diagnosticMessage = (value: unknown, limit: number) =>
    Array.isArray(value)
      ? value
          .slice(0, 8)
          .map((item) => diagnosticText(item, limit, secrets))
          .filter(Boolean)
          .join("; ")
          .slice(0, limit) || undefined
      : diagnosticText(value, limit, secrets);
  const chooseMessage = (value: unknown, priority: number) => {
    const safe = diagnosticMessage(value, 600);
    if (safe && priority > messagePriority) {
      message = safe;
      messagePriority = priority;
    }
  };
  const addField = (path: unknown, issue: unknown) => {
    const safePath = diagnosticText(path, 160, secrets);
    const safeIssue = diagnosticMessage(issue, 300);
    if (safePath && safeIssue && fields.length < 8 && !sensitive(safePath))
      fields.push({ path: safePath, issue: safeIssue });
  };
  const visit = (
    item: unknown,
    depth: number,
    field?: string,
    priority = 1,
  ) => {
    if (++nodes > 200 || depth > 8) return;
    if (Array.isArray(item)) {
      for (const child of item.slice(0, 12))
        visit(child, depth + 1, field, priority);
      return;
    }
    const object = record(item);
    if (!object) {
      if (field) addField(field, item);
      return;
    }
    const rawCode = object.code ?? object.errorCode;
    const safeCode = diagnosticText(
      typeof rawCode === "number" && Number.isSafeInteger(rawCode)
        ? String(rawCode)
        : rawCode,
      80,
      secrets,
    );
    if (safeCode && /^[A-Za-z0-9_.-]{1,80}$/.test(safeCode))
      // This namespace belongs to the server's reservation ledger. A provider
      // cannot diagnose our budget by returning an identically named error.
      code =
        safeCode.startsWith("catalog_budget_") ||
        safeCode === "catalog_provider_limit"
          ? "integration_provider_failed"
          : safeCode;
    const rawDetail =
      object.message ??
      object.messages ??
      object.error_description ??
      object.detail;
    chooseMessage(rawDetail, priority);
    const path = object.path ?? object.field ?? object.property ?? field;
    if (typeof path === "string")
      addField(
        path,
        object.issue ?? object.message ?? object.messages ?? object.reason,
      );
    else if (
      Array.isArray(path) &&
      path.every((part) => typeof part === "string" || typeof part === "number")
    )
      addField(
        "/" + path.join("/"),
        object.issue ?? object.message ?? object.messages ?? object.reason,
      );
    for (const key of [
      "error",
      "cause",
      "errors",
      "details",
      "validationErrors",
      "issues",
      "data",
      "structuredContent",
    ]) {
      const child = object[key];
      if ((key === "error" || key === "cause") && typeof child === "string") {
        // Twenty ToolOutput uses `message` as a generic summary and `error` as the cause.
        // Nest HTTP envelopes use `error` for the exception name and `messages` for details.
        const exceptionName =
          /^(?:[A-Za-z]*(?:Exception|Error)|Bad Request|Unauthorized|Forbidden|Internal Server Error)$/i.test(
            child.trim(),
          );
        chooseMessage(child, exceptionName ? 0 : priority + 2);
      } else if (child !== undefined)
        visit(
          child,
          depth + 1,
          undefined,
          key === "error" || key === "cause" ? priority + 2 : priority,
        );
    }
    const fieldErrors = record(object.fieldErrors);
    if (fieldErrors)
      for (const [name, child] of Object.entries(fieldErrors).slice(0, 8))
        if (!sensitive(name)) visit(child, depth + 1, name, priority);
    if (Array.isArray(object.content))
      for (const block of object.content.slice(0, 3)) {
        const content = record(block);
        if (content?.type !== "text" || typeof content.text !== "string")
          continue;
        if (content.text.length > 32768) continue;
        try {
          visit(JSON.parse(content.text), depth + 1);
        } catch {
          chooseMessage(content.text, 0);
        }
      }
  };
  // If credential scanning was incomplete, discard all text rather than returning a partial redaction.
  if (secretScanComplete && !options.omitText) visit(root, 0);
  const httpStatus =
    options.httpStatus && options.httpStatus >= 100 && options.httpStatus <= 599
      ? options.httpStatus
      : undefined;
  return ActionFailureSchema.parse({
    code,
    ...classify(code, httpStatus),
    stage: options.stage ?? "provider_response",
    ...(httpStatus ? { httpStatus } : {}),
    ...(message ? { message } : {}),
    fields,
  });
}

export function mcpActionFailure(
  result: unknown,
  options: DiagnosticOptions = {},
): ActionFailure | undefined {
  const explicit = (item: unknown) => {
    const object = record(item);
    const hasDiagnostic =
      !!object &&
      (!!object.error ||
        (typeof object.message === "string" && !!object.message.trim()) ||
        (typeof object.code === "string" && !!object.code.trim()) ||
        (typeof object.code === "number" && Number.isFinite(object.code)) ||
        (typeof object.errorCode === "string" && !!object.errorCode.trim()) ||
        (Array.isArray(object.errors) && object.errors.length > 0) ||
        (!!record(object.fieldErrors) &&
          Object.keys(object.fieldErrors as Record<string, unknown>).length >
            0));
    return (
      !!object &&
      (object.isError === true ||
        (hasDiagnostic &&
          (object.success === false ||
            object.ok === false ||
            ["error", "failed", "failure"].includes(String(object.status)))) ||
        (!!object.error && object.status !== "succeeded"))
    );
  };
  const object = record(result);
  if (!object) return undefined;
  if (explicit(object) || explicit(object.structuredContent))
    return providerFailure(object, options);
  if (Array.isArray(object.content))
    for (const block of object.content.slice(0, 3)) {
      const content = record(block);
      if (
        content?.type !== "text" ||
        typeof content.text !== "string" ||
        content.text.length > 32768
      )
        continue;
      try {
        const parsed = JSON.parse(content.text);
        if (explicit(parsed)) return providerFailure(object, options);
      } catch {
        /* Successful plain text content remains data. */
      }
    }
  return undefined;
}
