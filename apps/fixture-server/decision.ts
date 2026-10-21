import { z } from "zod";
import {
  ContactIdSchema,
  MeetingPatchSchema,
  type MeetingContext,
} from "./conversation-memory";
import type { Language } from "../../packages/protocol";

// Model output is a proposal for interpretation, never a command or an approval.
export const DecisionSchema = z
  .strictObject({
    kind: z.enum([
      "meeting",
      "contact",
      "reply",
      "crm_contacts",
      "meeting_patch",
      "new_topic",
    ]),
    contactId: ContactIdSchema.nullable(),
    title: z.string().min(1).max(160).nullable(),
    localStart: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::00)?$/)
      .transform((value) => value.slice(0, 16))
      .nullable(),
    durationMinutes: z.number().int().min(5).max(240).nullable(),
    reply: z.string().min(1).max(800).nullable(),
    patch: MeetingPatchSchema.nullable().optional(),
  })
  .superRefine((d, ctx) => {
    const valid =
      d.kind === "meeting_patch"
        ? d.patch != null &&
          d.contactId === null &&
          d.title === null &&
          d.localStart === null &&
          d.durationMinutes === null &&
          d.reply === null
        : d.patch != null
          ? false
          : d.kind === "meeting"
            ? d.title !== null &&
              d.localStart !== null &&
              d.durationMinutes !== null &&
              d.reply === null
            : d.kind === "crm_contacts"
              ? d.contactId === null &&
                d.title === null &&
                d.localStart === null &&
                d.durationMinutes === null &&
                d.reply === null
              : d.kind === "contact"
                ? d.contactId !== null &&
                  d.title === null &&
                  d.localStart === null &&
                  d.durationMinutes === null &&
                  d.reply === null
                : d.reply !== null &&
                  d.contactId === null &&
                  d.title === null &&
                  d.localStart === null &&
                  d.durationMinutes === null;
    if (!valid)
      ctx.addIssue({ code: "custom", message: "Inconsistent decision" });
  });
export type Decision = z.infer<typeof DecisionSchema>;
/** Contextual inference has only meaningful fields; normalize to the engine's shared decision type. */
export const ContextDecisionSchema = z
  .strictObject({
    kind: z.enum(["meeting_patch", "reply", "new_topic", "crm_contacts"]),
    reply: z.string().min(1).max(800).nullable(),
    patch: MeetingPatchSchema.nullable(),
  })
  .transform((value) =>
    DecisionSchema.parse({
      contactId: null,
      title: null,
      localStart: null,
      durationMinutes: null,
      ...value,
    }),
  );

export const MeetingDraftSchema = z.strictObject({
  startsAt: z.iso.datetime(),
  durationMinutes: z.number().int().min(5).max(240),
});
export type ModelInput = {
  text: string;
  language: Language;
  now: string;
  timeZone: string;
  history: { role: "user" | "assistant"; text: string }[];
  testCrmRead?: boolean;
  /** Separate grants: listing contacts must not imply permission to search them. */
  testCrmSearch?: boolean;
  recentContacts?: { id: string; label: string }[];
  /** null explicitly negotiates structured short-term context; omitted preserves legacy adapter calls. */
  activeMeeting?: MeetingContext | null;
  question?: {
    text: string;
    options: { id: string; label: string; detail: string }[];
  };
};
export interface DecisionRouter {
  readonly timeZone: string;
  decide(input: ModelInput, signal: AbortSignal): Promise<Decision>;
}
export class ModelError extends Error {
  constructor(
    public readonly code:
      | "model_unavailable"
      | "model_timeout"
      | "model_invalid_response"
      | "model_busy"
      | "model_limit"
      | "model_expired",
  ) {
    super(code);
  }
}

/** Resolve wall-clock time on the server; reject nonexistent or ambiguous DST times. */
export function localToUtc(
  local: string,
  timeZone: string,
): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) return;
  const base = Date.parse(`${local}:00Z`);
  if (
    !Number.isFinite(base) ||
    new Date(base).toISOString().slice(0, 16) !== local
  )
    return;
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const wallTime = (epoch: number) => {
    const parts = Object.fromEntries(
      formatter.formatToParts(epoch).map((p) => [p.type, p.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  };
  const candidates = new Set<number>();
  for (const delta of [-86400000, 0, 86400000]) {
    const sample = base + delta;
    const offset = Date.parse(`${wallTime(sample)}Z`) - sample;
    const utc = base - offset;
    if (wallTime(utc) === `${local}:00`) candidates.add(utc);
  }
  return candidates.size === 1
    ? new Date([...candidates][0]!).toISOString()
    : undefined;
}
