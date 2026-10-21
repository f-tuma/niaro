import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import ICAL from "ical.js";
import { z } from "zod";
import {
  CalendarTargetSchema,
  ScopeSchema,
  sameScope,
  type Scope,
  type Operation,
} from "../../packages/protocol";
import type { CalendarOutcome } from "./engine";
import type { FixtureStorage } from "./storage";
import { isAccountScope } from "../../packages/protocol/mobile-access";

export type AccountCalendarRunner = (
  scope: Scope,
  operation: Operation,
  signal: AbortSignal,
  complete: (outcome: CalendarOutcome) => void,
) => Promise<void>;

export const CalendarConfigSchema = z
  .strictObject({
    scope: ScopeSchema,
    target: CalendarTargetSchema,
    username: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-zA-Z0-9_-]+$/),
    password: z.string().min(16).max(512),
  })
  .superRefine((config, ctx) => {
    const url = new URL(config.target.collectionUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.endsWith("/") ||
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["127.0.0.1", "[::1]"].includes(url.hostname))
      )
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Calendar requires HTTPS or explicit loopback HTTP and a collection URL without credentials",
      });
  });
export type CalendarConfig = z.infer<typeof CalendarConfigSchema>;
export function loadCalendarConfig(path: string): CalendarConfig {
  if (statSync(path).mode & 0o077)
    throw new Error("Calendar configuration must be owner-only (chmod 600)");
  try {
    return CalendarConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    throw new Error("Invalid calendar configuration");
  }
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export function calendarIdentity(scope: Scope, operation: Operation) {
  return `agent-${hash(
    JSON.stringify([
      scope.connectionId,
      scope.serverId,
      scope.userId,
      scope.workspaceId,
      operation.parameters.calendar,
      operation.id,
      operation.idempotencyKey,
    ]),
  )}`;
}
const description = (op: Operation) =>
  // Preserve the exact description of already-written demo events for reconciliation.
  `${["peter-novak", "peter-svoboda"].includes(op.parameters.participant.id) ? "Synthetic test contact" : "Test contact"}: ${op.parameters.participant.label} <${op.parameters.participant.email}>. No invitation is sent.`;
const fingerprint = (op: Operation) => hash(JSON.stringify(op.parameters));
export function calendarDocument(scope: Scope, op: Operation) {
  const root = new ICAL.Component("vcalendar");
  root.updatePropertyWithValue("version", "2.0");
  root.updatePropertyWithValue("prodid", "-//Agent Client//Test Calendar//EN");
  const event = new ICAL.Component("vevent");
  root.addSubcomponent(event);
  const time = (iso: string) => ICAL.Time.fromJSDate(new Date(iso), true);
  event.updatePropertyWithValue("uid", calendarIdentity(scope, op));
  event.updatePropertyWithValue("dtstamp", time(new Date().toISOString()));
  event.updatePropertyWithValue("dtstart", time(op.parameters.startsAt));
  event.updatePropertyWithValue("dtend", time(op.parameters.endsAt));
  event.updatePropertyWithValue("summary", op.parameters.title);
  event.updatePropertyWithValue("description", description(op));
  event.updatePropertyWithValue("status", "CONFIRMED");
  event.updatePropertyWithValue("x-agent-fingerprint", fingerprint(op));
  // No ORGANIZER, ATTENDEE or METHOD: this integration never sends invitations.
  return root.toString() + "\r\n";
}
export function verifyCalendarDocument(
  text: string,
  scope: Scope,
  op: Operation,
) {
  try {
    const root = ICAL.Component.fromString(text);
    const event = root.getFirstSubcomponent("vevent");
    if (
      root.name !== "vcalendar" ||
      root.getAllSubcomponents().length !== 1 ||
      !event ||
      root.hasProperty("method") ||
      event.getAllSubcomponents().length
    )
      return false;
    for (const forbidden of [
      "attendee",
      "organizer",
      "rrule",
      "rdate",
      "exdate",
      "recurrence-id",
      "duration",
    ])
      if (event.hasProperty(forbidden)) return false;
    for (const property of [
      "uid",
      "summary",
      "description",
      "dtstart",
      "dtend",
      "status",
      "x-agent-fingerprint",
    ])
      if (event.getAllProperties(property).length !== 1) return false;
    const start = event.getFirstPropertyValue("dtstart"),
      end = event.getFirstPropertyValue("dtend");
    return (
      event.getFirstPropertyValue("uid") === calendarIdentity(scope, op) &&
      event.getFirstPropertyValue("summary") === op.parameters.title &&
      event.getFirstPropertyValue("description") === description(op) &&
      event.getFirstPropertyValue("status") === "CONFIRMED" &&
      event.getFirstPropertyValue("x-agent-fingerprint") === fingerprint(op) &&
      start instanceof ICAL.Time &&
      end instanceof ICAL.Time &&
      !start.isDate &&
      !end.isDate &&
      start.zone.tzid === "UTC" &&
      end.zone.tzid === "UTC" &&
      start.toJSDate().getTime() === Date.parse(op.parameters.startsAt) &&
      end.toJSDate().getTime() === Date.parse(op.parameters.endsAt)
    );
  } catch {
    return false;
  }
}
async function limitedText(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing calendar body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65_536) throw new Error("Calendar response too large");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel();
  }
}

export class CalDavCalendar {
  readonly config: CalendarConfig;
  constructor(
    config: CalendarConfig,
    private transport: typeof fetch = fetch,
  ) {
    this.config = CalendarConfigSchema.parse(config);
  }
  targetFor(scope: Scope) {
    return sameScope(scope, this.config.scope) ? this.config.target : undefined;
  }
  async execute(
    scope: Scope,
    op: Operation,
    signal?: AbortSignal,
  ): Promise<CalendarOutcome> {
    const unknown = (
      error: NonNullable<Operation["error"]>,
      retry = true,
    ): CalendarOutcome => ({ status: "result_unknown", error, retry });
    if (
      !sameScope(scope, this.config.scope) ||
      JSON.stringify(op.parameters.calendar) !==
        JSON.stringify(this.config.target)
    )
      return unknown("configuration_changed", false);
    const uid = calendarIdentity(scope, op);
    const url = new URL(`${uid}.ics`, this.config.target.collectionUrl).href;
    const request = (method: string, body?: string) =>
      this.transport(url, {
        method,
        redirect: "error",
        signal: AbortSignal.any([
          AbortSignal.timeout(8000),
          ...(signal ? [signal] : []),
        ]),
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString("base64")}`,
          ...(body
            ? {
                "Content-Type": "text/calendar; charset=utf-8",
                "If-None-Match": "*",
              }
            : {}),
        },
        body,
      });
    const verify = async (res: Response): Promise<CalendarOutcome> => {
      if (res.status === 401 || res.status === 403) {
        await res.body?.cancel();
        return unknown("authorization");
      }
      if (res.status !== 200) {
        await res.body?.cancel();
        return unknown("unavailable");
      }
      const etag = res.headers.get("etag");
      const text = await limitedText(res);
      if (!verifyCalendarDocument(text, scope, op))
        return unknown("remote_conflict", false);
      if (!etag || etag.length > 256 || etag.startsWith("W/"))
        return unknown("invalid_response");
      return {
        status: "succeeded",
        result: {
          kind: "calendar",
          reference: uid,
          etag,
          verifiedAt: new Date().toISOString(),
        },
      };
    };
    try {
      // Reconcile first, including after a crash or a lost PUT response.
      const existing = await request("GET");
      if (existing.status !== 404) return await verify(existing);
      await existing.body?.cancel();
      const written = await request("PUT", calendarDocument(scope, op));
      const status = written.status;
      await written.body?.cancel();
      // Never overwrite a pre-existing resource; 412/409 is resolved by GET.
      if (![201, 204, 412, 409].includes(status))
        return unknown(
          status === 401 || status === 403 ? "authorization" : "unavailable",
        );
      return await verify(await request("GET"));
    } catch {
      return unknown("unavailable");
    }
  }
}

/** Network I/O is outside SQLite; a committed claim always precedes it. */
export class CalendarWorker {
  private stopped = false;
  private busy = false;
  private abort = new AbortController();
  constructor(
    private storage: FixtureStorage,
    private calendar?: CalDavCalendar,
    private accountRunner?: AccountCalendarRunner,
  ) {}
  stop() {
    this.stopped = true;
    this.abort.abort();
  }
  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      for (const job of this.storage.calendarJobs()) {
        if (this.stopped) break;
        const claimed = this.storage.claimCalendar(job.scope, job.operationId);
        if (!claimed) continue;
        if (isAccountScope(job.scope)) {
          const complete = (outcome: CalendarOutcome) => {
            if (!this.stopped)
              this.storage.completeCalendar(
                job.scope,
                job.operationId,
                outcome,
              );
          };
          if (this.accountRunner)
            await this.accountRunner(
              job.scope,
              claimed.operation,
              this.abort.signal,
              complete,
            );
          else
            complete({
              status: "result_unknown",
              error: "configuration_changed",
              retry: false,
            });
          continue;
        }
        const outcome: CalendarOutcome = this.calendar
          ? await this.calendar.execute(
              job.scope,
              claimed.operation,
              this.abort.signal,
            )
          : {
              status: "result_unknown",
              error: "configuration_changed",
              retry: false,
            };
        if (!this.stopped)
          this.storage.completeCalendar(job.scope, job.operationId, outcome);
      }
    } finally {
      this.busy = false;
    }
  }
}
