import { createHash } from "node:crypto";
import { z } from "zod";
import { MemorySourceSchema } from "../../packages/protocol/memory";
import { MessageSchema, type Scope } from "../../packages/protocol";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Id = MessageSchema.shape.id;
const MemoryPin = z.strictObject({
  expiresAt: z.number().finite().optional(),
  sources: z.array(MemorySourceSchema).max(1000).optional(),
});
/** Bounded origin/evidence metadata only. No legacy execution identity or transcript. */
export const LegacyQuestionSchema = z.strictObject({
  kind: z.enum(["agent-1", "progressive-1"]),
  turnId: Digest,
  turnHash: Digest,
  commandId: Id,
  requestHash: Digest,
  scopeHash: Digest,
  conversationId: Id,
  question: z.string().min(1).max(2000),
  decision: z.enum(["pending", "accepted"]),
  sources: z.array(z.strictObject({ id: Id, hash: Digest })).max(32),
});
export type LegacyQuestion = z.infer<typeof LegacyQuestionSchema>;

// These passive projections deliberately do not import either historical runner.
const Common = z.object({
  kind: z.enum(["agent-1", "progressive-1"]),
  commandId: Id,
  hash: Digest,
  text: z.string().min(1).max(8000),
  language: z.enum(["en", "cs"]),
  epoch: z.number().int().nonnegative(),
  clock: z.object({ referenceNow: z.iso.datetime() }),
  paused: z.literal(true),
  answer: z.object({ reply: z.string().min(1).max(2000) }),
});
const Agent = Common.extend({
  kind: z.literal("agent-1"),
  requestHash: Digest.optional(),
  working: z.object({
    conversationId: Id,
    goal: z.string().max(8000),
    openedAt: z.iso.datetime(),
    question: z.string().min(1).max(2000),
    sources: z.array(Id).max(32),
  }),
  operations: z.array(Id).max(32),
  pending: z.never().optional(),
  plan: z.never().optional(),
  card: z.never().optional(),
  continuityPending: z.literal(false).optional(),
  pendingCalls: z.array(z.unknown()).max(0),
  batchMemory: z.never().optional(),
  memoryVersion: z.union([z.string(), z.number()]).optional(),
  memoryMetadata: MemoryPin.optional(),
});
const Progressive = Common.extend({
  kind: z.literal("progressive-1"),
  pendingInput: z.literal(true),
  carriedSteps: z.literal(0),
  steps: z
    .array(z.object({ plan: z.object({ operationId: Id }).optional() }))
    .max(20),
});
export function legacyQuestionCandidate(value: unknown) {
  const parsed = z.union([Agent, Progressive]).safeParse(value);
  if (!parsed.success) return undefined;
  const turn = parsed.data;
  if (turn.hash !== hash([turn.text, turn.language])) return undefined;
  if (
    turn.kind === "agent-1" &&
    (turn.working.goal !== turn.text ||
      turn.working.question !== turn.answer.reply ||
      turn.working.sources.some((id) => !turn.operations.includes(id)))
  )
    return undefined;
  return {
    kind: turn.kind,
    commandId: turn.commandId,
    requestHash: turn.kind === "agent-1" ? turn.requestHash : undefined,
    conversationId:
      turn.kind === "agent-1" ? turn.working.conversationId : undefined,
    goal: turn.text,
    language: turn.language,
    question: turn.answer.reply,
    epoch: turn.epoch,
    openedAt:
      turn.kind === "agent-1" ? turn.working.openedAt : turn.clock.referenceNow,
    turnHash: hash(value),
    operations:
      turn.kind === "agent-1"
        ? turn.operations
        : turn.steps.flatMap((step) =>
            step.plan ? [step.plan.operationId] : [],
          ),
    sources:
      turn.kind === "agent-1"
        ? turn.working.sources
        : turn.steps.flatMap((step) =>
            step.plan ? [step.plan.operationId] : [],
          ),
    memoryVersion: turn.kind === "agent-1" ? turn.memoryVersion : undefined,
    memoryMetadata: turn.kind === "agent-1" ? turn.memoryMetadata : undefined,
  };
}

/** The original question's deadline continues to apply throughout handoff. */
export function legacyQuestionIsCurrent(
  candidate: ReturnType<typeof legacyQuestionCandidate>,
  now = Date.now(),
) {
  const age = candidate ? now - Date.parse(candidate.openedAt) : NaN;
  return Number.isFinite(age) && age >= 0 && age < 30 * 60 * 1000;
}

const ConsumedRoot = z.object({
  kind: z.literal("mastra-1"),
  runId: Digest,
  goal: z.string().min(1).max(8000),
  conversationId: Id,
  aliases: z.array(z.unknown()).min(1).max(32),
  legacyQuestion: LegacyQuestionSchema,
});
const FirstAlias = z.object({
  commandId: Id,
  hash: Digest,
  requestHash: Digest,
});
/** Passive permanent consumption. Current TTL, proof and access are execution gates. */
export function legacyQuestionConsumedRoot(
  value: unknown,
  rootId: string,
  turnId: string,
  oldValue: unknown,
  scope: Pick<Scope, "serverId" | "workspaceId" | "userId">,
) {
  const root = ConsumedRoot.safeParse(value);
  const old = legacyQuestionCandidate(oldValue);
  if (!root.success || !old) return false;
  const alias = FirstAlias.safeParse(root.data.aliases[0]);
  if (!alias.success) return false;
  // The historical commandId is its runtime/idempotency key; the public
  // origin.commandId may be a different outer command ID.
  const key = (id: string) =>
    hash([scope.serverId, scope.workspaceId, scope.userId, id]);
  const origin = root.data.legacyQuestion;
  return (
    root.data.runId === rootId &&
    rootId === key(alias.data.commandId) &&
    turnId === key(old.commandId) &&
    origin.turnId === turnId &&
    origin.decision === "accepted" &&
    origin.kind === old.kind &&
    origin.turnHash === old.turnHash &&
    origin.question === old.question &&
    root.data.goal === old.goal &&
    root.data.conversationId === origin.conversationId &&
    (!old.conversationId || old.conversationId === origin.conversationId) &&
    (!old.requestHash || old.requestHash === origin.requestHash)
  );
}
