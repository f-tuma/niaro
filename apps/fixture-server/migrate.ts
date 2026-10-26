import { z } from "zod";
import {
  PROFILE,
  ScopeSchema,
  ConversationSchema,
  WorkItemSchema,
  InputRequestSchema,
  CommandSchema,
  CommandResultSchema,
} from "../../packages/protocol";
const LegacyWork = z.strictObject(WorkItemSchema.shape).omit({
  actionProposalIds: true,
  operationIds: true,
});
const envelope = {
  eventId: z.string(),
  sequence: z.number().int().nonnegative(),
  scope: ScopeSchema,
};
const LegacyDatabase = z.strictObject({
  version: z.literal(1),
  eventFloor: z.literal(0).optional(),
  snapshot: z.strictObject({
    profile: z.literal("agent-client/0.1-fixture"),
    scope: ScopeSchema,
    cursor: z.number().int().nonnegative(),
    conversations: z.array(ConversationSchema),
    workItems: z.array(LegacyWork),
    inputRequests: z.array(InputRequestSchema),
  }),
  events: z.array(
    z.discriminatedUnion("type", [
      z.strictObject({
        ...envelope,
        type: z.literal("conversation.upserted"),
        entity: ConversationSchema,
      }),
      z.strictObject({
        ...envelope,
        type: z.literal("work_item.upserted"),
        entity: LegacyWork,
      }),
      z.strictObject({
        ...envelope,
        type: z.literal("input_request.upserted"),
        entity: InputRequestSchema,
      }),
    ]),
  ),
  receipts: z.array(
    z.strictObject({
      command: CommandSchema,
      status: z.enum(["accepted", "conflict", "rejected"]),
      code: CommandResultSchema.shape.code,
    }),
  ),
  pending: z.array(
    z.strictObject({ workItemId: z.string(), dueAt: z.number() }),
  ),
  nextWork: z.number().int().positive(),
});
/** Preserve legacy work/receipts. Unfinished contact selection now prepares a proposal. */
export function migrateDatabase(raw: unknown): unknown {
  // Receipts of the removed card.respond command are dropped on import.
  if (
    raw &&
    typeof raw === "object" &&
    "receipts" in raw &&
    Array.isArray(raw.receipts)
  )
    raw = {
      ...raw,
      receipts: raw.receipts.filter(
        (receipt: unknown) =>
          !(
            receipt &&
            typeof receipt === "object" &&
            "command" in receipt &&
            receipt.command &&
            typeof receipt.command === "object" &&
            "type" in receipt.command &&
            receipt.command.type === "card.respond"
          ),
      ),
    };
  if (
    raw &&
    typeof raw === "object" &&
    "version" in raw &&
    raw.version === 2 &&
    "snapshot" in raw
  ) {
    const snapshot = raw.snapshot;
    if (
      snapshot &&
      typeof snapshot === "object" &&
      "profile" in snapshot &&
      [
        "agent-client/0.2-fixture",
        "agent-client/0.3-fixture",
        "agent-client/0.4-fixture",
        "agent-client/0.5-fixture",
        "agent-client/0.6-fixture",
        "agent-client/0.7-fixture",
      ].includes(String(snapshot.profile))
    )
      return { ...raw, snapshot: { ...snapshot, profile: PROFILE } };
  }
  if (
    !raw ||
    typeof raw !== "object" ||
    !("version" in raw) ||
    raw.version !== 1
  )
    return raw;
  const old = LegacyDatabase.parse(raw);
  const work = (w: z.infer<typeof LegacyWork>) => ({
    ...w,
    actionProposalIds: [],
    operationIds: [],
  });
  return {
    ...old,
    version: 2,
    snapshot: {
      ...old.snapshot,
      profile: PROFILE,
      workItems: old.snapshot.workItems.map(work),
      actionProposals: [],
      operations: [],
    },
    events: old.events.map((e) =>
      e.type === "work_item.upserted" ? { ...e, entity: work(e.entity) } : e,
    ),
    pending: old.pending.map((p) => ({ ...p, kind: "prepare_proposal" })),
  };
}
