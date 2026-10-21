import { z } from "zod";
import {
  DateTimeInput,
  PluginResultSchema,
  TimeZone,
} from "../../packages/protocol/internal-plugins";
import {
  LoopToolDetailsSchema,
  type LoopToolDetails,
  type LoopStatus,
} from "../../packages/protocol/loops";
import {
  diagnosticText,
  sanitizeActionFailure,
} from "../server-integrations/failures";
import { loopText } from "./loop-redaction";

type Field = LoopToolDetails["input"][number];
const builtins = new Set([
  "find_service",
  "find_actions",
  "internal_datetime_resolve",
  "compose_card",
  "ask_user",
  "memory_search",
  "memory_remember",
  "memory_revise",
  "memory_forget",
  "verified_prior_read",
  "skill_load",
  "skill_propose",
]);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const toolName = (value: string) =>
  builtins.has(value) || /^action_[A-Za-z0-9_]{1,100}$/.test(value)
    ? value
    : "unknown";
const privateKey =
  /password|secret|token|authorization|credential|cookie|session|apikey|privatekey|headers|signature/i;
type Credentials = { values: string[]; complete: boolean };
// Exact values are transient redaction context, never part of the persisted DTO.
const transientCredentials = new WeakMap<LoopToolDetails, Credentials>();

/** Hidden credential values are used only for redaction, never for presentation. */
function credentials(raw: unknown) {
  const values: string[] = [];
  let complete = true,
    visits = 0;
  const visit = (value: unknown, depth: number, hidden = false) => {
    if (++visits > 200 || depth > 8) {
      complete = false;
      return;
    }
    if (typeof value === "string" && value) {
      if (value.length > 32768) {
        complete = false;
        return;
      }
      if (hidden) {
        if (values.length >= 64) {
          complete = false;
          return;
        }
        values.push(value);
        const authorization = /^(?:Bearer|Basic)\s+(.+)$/i.exec(value);
        if (authorization) {
          if (values.length >= 64) complete = false;
          else values.push(authorization[1]!);
        }
        for (const match of value.matchAll(/(?:^|;)\s*[^=;]+\s*=\s*([^;]+)/g)) {
          if (values.length >= 64) {
            complete = false;
            break;
          }
          values.push(match[1]!);
        }
      }
      for (const match of value.matchAll(
        /\b(?:Bearer|Basic)\s+([^\s"'<>]+)|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|cookie)\b["']?\s*[:=]\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s,;]+))/gi,
      )) {
        if (values.length >= 64) {
          complete = false;
          break;
        }
        const credential = match[1] ?? match[2] ?? match[3] ?? match[4];
        if (credential) values.push(credential);
      }
    } else if (Array.isArray(value)) {
      if (value.length > 60) complete = false;
      for (const child of value.slice(0, 60)) visit(child, depth + 1, hidden);
    } else if (record(value)) {
      const object = record(value)!;
      const entries = Object.entries(object);
      if (entries.length > 60) complete = false;
      for (const [key, child] of entries.slice(0, 60))
        visit(
          child,
          depth + 1,
          hidden ||
            privateKey.test(key.replace(/[_.\s-]/g, "")) ||
            (key === "value" &&
              typeof object.label === "string" &&
              privateKey.test(object.label.replace(/[_.\s-]/g, ""))),
        );
    }
  };
  visit(raw, 0);
  return {
    values: [...new Set(values)].sort((a, b) => b.length - a.length),
    complete,
  };
}

function combineCredentials(
  ...sources: (Credentials | undefined)[]
): Credentials {
  const values = [
    ...new Set(sources.flatMap((source) => source?.values ?? [])),
  ].sort((a, b) => b.length - a.length);
  return {
    values: values.slice(0, 64),
    complete:
      values.length <= 64 &&
      sources.every((source) => !source || source.complete),
  };
}

/** Redact field diagnostics before their bounds are applied; provider prose is omitted. */
function toolFailure(raw: unknown, secrets: Credentials) {
  const object = record(raw);
  if (!object) return undefined;
  const fields =
    secrets.complete && Array.isArray(object.fields)
      ? object.fields.slice(0, 8).flatMap((field) => {
          const item = record(field);
          if (
            typeof item?.path !== "string" ||
            privateKey.test(item.path.replace(/[_.\s-]/g, ""))
          )
            return [];
          const path = diagnosticText(item.path, 160, secrets.values);
          const issue = diagnosticText(item.issue, 300, secrets.values);
          return path && issue ? [{ path, issue }] : [];
        })
      : [];
  const code =
    !secrets.complete ||
    (typeof object.code === "string" &&
      secrets.values.some(
        (secret) =>
          object.code === secret || String(object.code).includes(secret),
      ))
      ? "tool_failure_redacted"
      : object.code;
  return sanitizeActionFailure({ ...object, code, message: undefined, fields });
}

function preview(raw: unknown, known?: Credentials) {
  const secrets = combineCredentials(known, credentials(raw));
  const fields: Field[] = [];
  let truncated = !secrets.complete,
    budget = 4000;
  const put = (label: string, value: unknown) => {
    if (
      typeof value !== "string" &&
      typeof value !== "boolean" &&
      !(typeof value === "number" && Number.isFinite(value))
    )
      return;
    if (typeof value === "string" && !secrets.complete) return;
    let text = String(value);
    if (/^\s*(?:data:|[\[{])|^[A-Za-z0-9+/]{256,}={0,2}$/.test(text)) {
      truncated = true;
      return;
    }
    for (const secret of secrets.values)
      text = text.split(secret).join("[redacted]");
    text = loopText(text, 1001);
    if (!text.trim()) return;
    if (fields.length >= 12 || budget <= 0) {
      truncated = true;
      return;
    }
    const limit = Math.min(1000, budget);
    if (text.length > limit) truncated = true;
    fields.push({ label, value: text.slice(0, limit) });
    budget -= Math.min(text.length, limit);
  };
  return {
    fields,
    put,
    truncate: () => {
      truncated = true;
    },
    get truncated() {
      return truncated;
    },
  };
}

const dateFields = {
  utc: "UTC",
  iso: "ISO",
  date: "Date",
  time: "Time",
  timeZone: "Time zone",
  utcOffset: "UTC offset",
  endUtc: "End UTC",
  endIso: "End ISO",
  durationMinutes: "Duration minutes",
  wholeDay: "Whole day",
} as const;
const inputLabels: Record<string, readonly string[]> = {
  find_service: ["Need"],
  skill_load: ["Skill id"],
  skill_propose: ["Name"],
  find_actions: ["Service", "Need"],
  internal_datetime_resolve: [
    "Date kind",
    "Date",
    "Days",
    "Weeks",
    "Weekday",
    "Elapsed minutes",
    "Time",
    "Time zone",
    "UTC offset",
    "Duration minutes",
    "Whole day",
  ],
};
const outputLabels: Record<string, readonly string[]> = {
  find_service: ["Returned services", "Service", "Candidates"],
  find_actions: ["Service", "Returned actions", "Action", "Tool", "Effect"],
  internal_datetime_resolve: [
    "Status",
    "Reason",
    "Local date and time",
    ...Object.values(dateFields),
  ],
  compose_card: ["Status", "Revision"],
  ask_user: ["Status"],
  skill_load: ["Skill", "Revision"],
  skill_propose: ["Status"],
  memory_remember: ["Receipt status", "Revision"],
  memory_revise: ["Receipt status", "Revision"],
  memory_forget: ["Receipt status", "Revision"],
};
const memoryStatuses = new Set([
  "candidate",
  "active",
  "superseded",
  "deleted",
]);
const knownErrors = new Set([
  "service_unavailable",
  "unknown_service",
  "action_unavailable",
  "question_required",
  "invalid_card_document",
  "invalid_date_arguments",
  "memory_context_changed",
  "memory_result_unavailable",
  "unknown_tool",
  "action_limit",
  "plugin_limit",
  "checker_mismatch",
  "skill_unavailable",
  "skill_load_limit",
  "invalid_skill",
  "already_proposed",
]);
function validField(
  name: string,
  label: string,
  value: string,
  output: boolean,
) {
  if (
    [
      "Returned services",
      "Returned actions",
      "Candidates",
      "Revision",
      "Days",
      "Weeks",
      "Weekday",
      "Elapsed minutes",
      "Duration minutes",
    ].includes(label)
  )
    return /^-?\d{1,12}$/.test(value) && Number.isSafeInteger(Number(value));
  if (label === "Tool") return toolName(value) !== "unknown";
  if (label === "Effect") return value === "read" || value === "write";
  if (label === "Receipt status") return memoryStatuses.has(value);
  if (label === "Status")
    return (
      name === "compose_card"
        ? ["composed"]
        : name === "ask_user"
          ? ["asked", "answered"]
          : name === "skill_propose"
            ? ["proposed"]
            : ["resolved", "clarification"]
    ).includes(value);
  if (label === "Reason")
    return [
      "missing_time",
      "invalid_date",
      "ambiguous_time",
      "nonexistent_time",
      "invalid_offset",
    ].includes(value);
  if (name !== "internal_datetime_resolve") return true;
  if (label === "Date kind")
    return [
      "date",
      "day_offset",
      "week_day",
      "next_weekday",
      "elapsed",
    ].includes(value);
  if (label === "Time zone") return TimeZone.safeParse(value).success;
  if (label === "Whole day") return value === "true" || value === "false";
  if (label === "Date") return /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (label === "Time") return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  if (label === "UTC offset") return /^[+-](?:0\d|1[0-4]):[0-5]\d$/.test(value);
  if (label === "Local date and time")
    return /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(
      value,
    );
  return output && z.iso.datetime({ offset: true }).safeParse(value).success;
}

/** Called only with transient validated tool arguments, never model prompts. */
export function startLoopToolDetails(
  name: string,
  args?: unknown,
): LoopToolDetails {
  const known = toolName(name),
    input = preview(args),
    object = record(args);
  if (object && (known === "find_service" || known === "find_actions")) {
    if (known === "find_actions") input.put("Service", object.service);
    input.put("Need", object.need);
  } else if (object && known === "skill_load") {
    input.put("Skill id", object.skillId);
  } else if (object && known === "skill_propose") {
    input.put("Name", object.name);
  } else if (known === "internal_datetime_resolve") {
    const parsed = DateTimeInput.safeParse(args);
    if (parsed.success) {
      const value = parsed.data;
      input.put("Date kind", value.when.kind);
      const when = value.when as Record<string, unknown>;
      for (const [key, label] of Object.entries({
        date: "Date",
        days: "Days",
        weeks: "Weeks",
        weekday: "Weekday",
        minutes: "Elapsed minutes",
      }))
        input.put(label, when[key]);
      for (const [key, label] of Object.entries(dateFields))
        input.put(label, (value as Record<string, unknown>)[key]);
    }
  }
  const tool = LoopToolDetailsSchema.parse({
    name: known,
    outcome: "pending",
    input: input.fields,
    output: [],
    inputRecorded: input.fields.length > 0,
    outputRecorded: false,
    inputTruncated: input.truncated,
    outputTruncated: false,
  });
  transientCredentials.set(tool, credentials(args));
  return tool;
}

type ToolEnd = {
  output?: unknown;
  error?: unknown;
  unavailable?: boolean;
  invalidArguments?: boolean;
  status?: LoopStatus;
};
const statusOutcome = (
  status: LoopStatus | undefined,
): LoopToolDetails["outcome"] =>
  status === "running"
    ? "pending"
    : status === "succeeded"
      ? "completed"
      : status === "waiting"
        ? "waiting"
        : status === "cancelled" || status === "interrupted"
          ? "cancelled"
          : status === "failed"
            ? "failed"
            : "unknown";

/** Tool output is projected by identity. Raw errors and service bodies are never copied. */
export function finishLoopToolDetails(
  previous: LoopToolDetails,
  event: ToolEnd,
): LoopToolDetails {
  const tool = sanitizeLoopToolDetails(previous)!;
  const secrets = combineCredentials(
    transientCredentials.get(previous),
    credentials(event.output),
    credentials(previous),
  );
  transientCredentials.delete(previous);
  const object = record(event.output),
    output = preview(event.output, secrets);
  const outcome: LoopToolDetails["outcome"] = event.invalidArguments
    ? "invalid_arguments"
    : event.unavailable
      ? "unavailable"
      : object?.skipped === true
        ? "skipped"
        : event.status
          ? statusOutcome(event.status)
          : event.error || object?.error
            ? "failed"
            : object?.status === "failed" || object?.status === "unknown"
              ? object.status
              : object?.status === "rejected"
                ? "cancelled"
                : object?.asked === true ||
                    object?.status === "needs_input" ||
                    object?.status === "awaiting_approval"
                  ? "waiting"
                  : "completed";
  let recorded = false;
  if (
    object &&
    !event.error &&
    !event.unavailable &&
    !event.invalidArguments &&
    !object.error &&
    !object.skipped &&
    (outcome === "completed" || outcome === "waiting")
  ) {
    const names = (items: unknown[], key: string, label: string) => {
      if (items.length > 3) output.truncate();
      for (const item of items.slice(0, 3))
        output.put(label, record(item)?.[key]);
    };
    if (tool.name === "find_service") {
      if (Array.isArray(object.services)) {
        output.put("Returned services", object.services.length);
        names(object.services, "service", "Service");
        recorded = true;
      } else if (Array.isArray(object.candidates)) {
        output.put("Candidates", object.candidates.length);
        names(object.candidates, "service", "Service");
        recorded = true;
      } else if (typeof object.service === "string") {
        output.put("Service", object.service);
        recorded = true;
      }
    } else if (tool.name === "find_actions" && Array.isArray(object.actions)) {
      output.put("Service", object.service);
      output.put("Returned actions", object.actions.length);
      if (object.actions.length > 3) output.truncate();
      for (const item of object.actions.slice(0, 3)) {
        const action = record(item);
        output.put("Action", action?.name);
        if (
          typeof action?.tool === "string" &&
          toolName(action.tool) !== "unknown"
        )
          output.put("Tool", action.tool);
        if (action?.effect === "read" || action?.effect === "write")
          output.put("Effect", action.effect);
      }
      recorded = true;
    } else if (tool.name === "internal_datetime_resolve") {
      const parsed = PluginResultSchema.safeParse(event.output);
      if (parsed.success) {
        output.put("Status", parsed.data.status);
        if (parsed.data.status === "resolved")
          for (const [key, label] of Object.entries(dateFields))
            output.put(label, parsed.data.values[key]);
        else {
          output.put("Reason", parsed.data.reason);
          output.put("Time zone", parsed.data.timeZone);
          output.put("Local date and time", parsed.data.localDateTime);
          if (parsed.data.alternatives?.length) output.truncate();
        }
        recorded = true;
      }
    } else if (tool.name === "skill_load" && object.status === "loaded") {
      // Which know-how entered the turn; never its content.
      output.put("Skill", object.name);
      if (
        typeof object.revision === "number" &&
        Number.isSafeInteger(object.revision) &&
        object.revision > 0
      )
        output.put("Revision", object.revision);
      recorded = true;
    } else if (tool.name === "skill_propose" && object.status === "proposed") {
      output.put("Status", "proposed");
      recorded = true;
    } else if (tool.name === "compose_card" && object.status === "composed") {
      output.put("Status", "composed");
      if (
        typeof object.revision === "number" &&
        Number.isSafeInteger(object.revision) &&
        object.revision > 0
      )
        output.put("Revision", object.revision);
      recorded = true;
    } else if (
      tool.name === "ask_user" &&
      (object.asked === true || object.answered === true)
    ) {
      output.put("Status", object.answered === true ? "answered" : "asked");
      recorded = true;
    } else if (
      outputLabels[tool.name]?.includes("Receipt status") &&
      typeof object.status === "string" &&
      memoryStatuses.has(object.status)
    ) {
      output.put("Receipt status", object.status);
      if (
        typeof object.revision === "number" &&
        Number.isSafeInteger(object.revision) &&
        object.revision >= 0
      )
        output.put("Revision", object.revision);
      recorded = true;
    }
  }
  // Only a structured domain failure is eligible; Error.message/stack are private.
  const failure = toolFailure(
    event.invalidArguments
      ? {
          code: "tool_input_invalid",
          kind: "validation",
          stage: "validation",
          retry: "correct_input",
          fields: record(object?.failure)?.fields ?? [],
        }
      : event.unavailable
        ? {
            code: "tool_unavailable",
            kind: "unknown",
            stage: "validation",
            retry: "none",
            fields: [],
          }
        : (object?.failure ??
          (typeof object?.error === "string" && knownErrors.has(object.error)
            ? {
                code: object.error,
                kind: /^invalid_|_required$/.test(object.error)
                  ? "validation"
                  : "unknown",
                stage: "validation",
                retry: "none",
                fields: [],
              }
            : undefined)),
    secrets,
  );
  const safeFailure = failure ? { ...failure, message: undefined } : undefined;
  return sanitizeLoopToolDetails({
    ...tool,
    outcome,
    ...(event.output !== undefined
      ? {
          output: output.fields,
          outputRecorded: recorded,
          outputTruncated: output.truncated,
        }
      : {}),
    ...(["failed", "unknown", "invalid_arguments", "unavailable"].includes(
      outcome,
    ) && safeFailure
      ? { failure: safeFailure }
      : {}),
  })!;
}

/** Persisted trace metadata is re-projected defensively before reaching the API. */
export function sanitizeLoopToolDetails(
  raw: unknown,
): LoopToolDetails | undefined {
  const parsed = LoopToolDetailsSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const tool = parsed.data,
    name = toolName(tool.name);
  const secrets = combineCredentials(
    transientCredentials.get(raw as LoopToolDetails),
    credentials(raw),
  );
  const project = (
    fields: Field[],
    allowed: readonly string[] | undefined,
    recorded: boolean,
    isOutput: boolean,
  ) => {
    const result = preview(fields, secrets);
    if (recorded && allowed)
      for (const field of fields)
        if (
          allowed.includes(field.label) &&
          validField(name, field.label, field.value, isOutput)
        )
          result.put(field.label, field.value);
    return result;
  };
  const input = project(
    tool.input,
    inputLabels[name],
    tool.inputRecorded,
    false,
  );
  const output = project(
    tool.output,
    outputLabels[name],
    tool.outputRecorded,
    true,
  );
  const failure = toolFailure(tool.failure, secrets);
  return LoopToolDetailsSchema.parse({
    name,
    outcome: tool.outcome,
    input: input.fields,
    output: output.fields,
    inputRecorded:
      tool.inputRecorded && !!inputLabels[name] && input.fields.length > 0,
    outputRecorded:
      tool.outputRecorded &&
      !!outputLabels[name] &&
      (tool.output.length === 0 || output.fields.length > 0),
    inputTruncated: tool.inputTruncated || input.truncated,
    outputTruncated: tool.outputTruncated || output.truncated,
    ...(name !== "unknown" &&
    failure &&
    ["failed", "unknown", "invalid_arguments", "unavailable"].includes(
      tool.outcome,
    )
      ? { failure: { ...failure, message: undefined } }
      : {}),
  });
}
