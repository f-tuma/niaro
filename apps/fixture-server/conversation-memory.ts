import { z } from "zod";
import type { Snapshot } from "../../packages/protocol";

/** Explicit creation wording starts a fresh request before inference, so old contacts cannot bleed into it. */
export function startsNewMeeting(text: string) {
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
  return (
    /^(?:(?:prosim|tak|a)[, ]+)*(?:(?:nova|novou|dalsi|jina|jinou)\s+schuzk[au]\b|(?:naplanuj|priprav|vytvor|zaloz)\s+(?:(?:mi|prosim|novou|dalsi|jinou)\s+)*schuzku\b)/.test(
      normalized,
    ) ||
    /^(?:please\s+)?(?:(?:new|another)\s+meeting\b|(?:schedule|prepare|create|set up)\s+(?:(?:a|the|new|another|me)\s+)*meeting\b)/.test(
      normalized,
    )
  );
}

/** The synthetic directory has two Peters; a new request naming only Peter cannot select one. */
export function namesOnlyPeter(text: string) {
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return (
    /\b(?:peter|petr)(?:em|a|ovi)?\b/.test(normalized) &&
    !/\b(?:novak\w*|svobod\w*|acme|northstar)\b/.test(normalized)
  );
}

export function refersToLastMeeting(text: string) {
  return /\b(?:posledni\s+schuzk[auye]|(?:last|latest|most recent)\s+meeting)\b/i.test(
    text.normalize("NFD").replace(/[\u0300-\u036f]/g, ""),
  );
}

export const MEMORY_TTL_MS = 30 * 60 * 1000;
export const ContactIdSchema = z.union([
  z.enum(["peter-novak", "peter-svoboda"]),
  z.uuid(),
]);
export const MeetingSlotsSchema = z.strictObject({
  contactId: ContactIdSchema.nullable(),
  contactName: z.string().trim().min(1).max(160).nullable(),
  localDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((value) => {
      const date = new Date(`${value}T12:00:00Z`);
      return (
        Number.isFinite(date.valueOf()) &&
        date.toISOString().slice(0, 10) === value
      );
    })
    .nullable(),
  localTime: z
    .string()
    .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
    .nullable(),
  durationMinutes: z.number().int().min(5).max(240).nullable(),
  title: z.string().trim().min(1).max(160).nullable(),
});
export type MeetingSlots = z.infer<typeof MeetingSlotsSchema>;
export const emptyMeeting = (): MeetingSlots => ({
  contactId: null,
  contactName: null,
  localDate: null,
  localTime: null,
  durationMinutes: null,
  title: null,
});
export const MeetingPatchSchema = MeetingSlotsSchema.extend({
  mode: z.enum(["new", "continue"]),
});
export const ConversationMemorySchema = z.strictObject({
  conversationId: z.string().min(1).max(160),
  updatedAt: z.number().finite().nonnegative(),
  historyFrom: z.number().int().nonnegative(),
  timeZone: z.string().max(80),
  meeting: z
    .strictObject({
      workItemId: z.string().max(160).nullable(),
      slots: MeetingSlotsSchema,
      pendingProposalRevision: z.number().int().positive().optional(),
      pendingContactOptions: z
        .array(
          z.strictObject({
            id: ContactIdSchema,
            label: z.string().max(160),
            detail: z.string().max(500),
          }),
        )
        .max(20)
        .optional(),
    })
    .nullable(),
});
export type ConversationMemory = z.infer<typeof ConversationMemorySchema>;
export type MeetingContext = {
  phase: "collecting" | "waiting_input" | "waiting_approval" | "locked";
  slots: MeetingSlots;
  displayTitle: string | null;
  pendingChanges?: boolean;
  options: { id: string; label: string; detail: string }[];
};
export function localParts(iso: string, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("sv-SE", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return {
    localDate: `${parts.year}-${parts.month}-${parts.day}`,
    localTime: `${parts.hour}:${parts.minute}`,
  };
}
/** Project current workflow facts; saved language-model memory can never override a proposal. */
export function meetingContext(
  memory: ConversationMemory | undefined,
  snapshot: Snapshot,
  now: number,
  timeZone: string,
  drafts: Record<string, { startsAt: string; durationMinutes: number }> = {},
): MeetingContext | null {
  if (
    !memory?.meeting ||
    now - memory.updatedAt > MEMORY_TTL_MS ||
    now < memory.updatedAt ||
    memory.timeZone !== timeZone
  )
    return null;
  const { workItemId, slots } = memory.meeting;
  if (!workItemId)
    return {
      phase: "collecting",
      slots: structuredClone(slots),
      displayTitle: null,
      options: [],
    };
  const work = snapshot.workItems.find(
    (w) => w.id === workItemId && w.conversationId === memory.conversationId,
  );
  if (!work) return null;
  const input = snapshot.inputRequests.find((i) => i.workItemId === work.id);
  const proposal = snapshot.actionProposals.find(
    (p) => p.id === work.actionProposalIds.at(-1),
  );
  const draft = drafts[work.id];
  const parameters = proposal?.parameters;
  const contactId = ContactIdSchema.safeParse(
    parameters?.participant.id ?? input?.resolution?.selectedContactId,
  );
  const startsAt = parameters?.startsAt ?? draft?.startsAt;
  const pending =
    proposal?.status === "awaiting_approval" &&
    work.status === "waiting_approval" &&
    proposal.revision === memory.meeting.pendingProposalRevision;
  return {
    phase:
      work.status === "waiting_input" && input?.status === "open"
        ? "waiting_input"
        : work.status === "waiting_approval" &&
            proposal?.status === "awaiting_approval"
          ? "waiting_approval"
          : "locked",
    slots: {
      ...slots,
      ...(contactId.success
        ? {
            contactId: contactId.data,
            contactName:
              parameters?.participant.label ??
              input?.options.find((o) => o.id === contactId.data)?.label ??
              slots.contactName,
          }
        : {}),
      ...(startsAt ? localParts(startsAt, timeZone) : {}),
      ...(parameters
        ? {
            durationMinutes:
              (Date.parse(parameters.endsAt) -
                Date.parse(parameters.startsAt)) /
              60000,
          }
        : draft
          ? { durationMinutes: draft.durationMinutes }
          : {}),
    },
    ...(pending ? { slots: structuredClone(slots), pendingChanges: true } : {}),
    displayTitle: work.title,
    options:
      (pending ? memory.meeting.pendingContactOptions : undefined) ??
      input?.options.map(({ id, label, detail }) => ({ id, label, detail })) ??
      (parameters
        ? [
            {
              id: parameters.participant.id,
              label: parameters.participant.label,
              detail: parameters.participant.email,
            },
          ]
        : undefined) ??
      [],
  };
}
export function mergeMeeting(
  base: MeetingSlots,
  patch: z.infer<typeof MeetingPatchSchema>,
): MeetingSlots {
  const slots = { ...base };
  for (const key of [
    "localDate",
    "localTime",
    "durationMinutes",
    "title",
  ] as const)
    if (patch[key] !== null) Object.assign(slots, { [key]: patch[key] });
  if (patch.contactName !== null || patch.contactId !== null) {
    slots.contactName = patch.contactName;
    slots.contactId = patch.contactId;
  }
  return MeetingSlotsSchema.parse(slots);
}
