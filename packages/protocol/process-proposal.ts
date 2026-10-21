import { z } from "zod";
import { IdentityId, IdentityName } from "./identity";
import { Revision } from "./service-catalog";
import { ProcessKey } from "./service-processes";

/**
 * A personal process the designer drafted from a chat request. It is passive:
 * nothing is saved until the person presses "Save and turn on", which runs the
 * server pipeline below. The design session stays open in Processes.
 */
export const PROCESS_PROPOSAL_PROFILE = "agent-process-proposal/1" as const;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const label = z.string().trim().min(1).max(160);
const code = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

/** One step as a person reads it; no schemas, bindings or identifiers. */
export const ProcessProposalStepSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("action"),
    service: label,
    action: label,
    effect: z.enum(["read", "write"]),
    /** The write waits for the person's approval on every run. */
    approval: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("agent"),
    /** The beginning of the step's instructions. */
    task: z.string().max(300),
    model: label.optional(),
    /** Services the step may use by itself. */
    tools: z.array(label).max(16),
  }),
  z.strictObject({ type: z.literal("branch") }),
  z.strictObject({
    type: z.literal("return"),
    fields: z.array(ProcessKey).max(40),
  }),
]);
export type ProcessProposalStep = z.infer<typeof ProcessProposalStepSchema>;

export const ProcessProposalResultSchema = z
  .strictObject({
    type: z.literal("process.proposal"),
    version: z.literal(1),
    /** The design session; Edit opens it in Processes. None when nothing
     * could be designed (`budget`). */
    sessionId: IdentityId.nullable(),
    /** The exact reviewed proposal this card shows; saving checks it again. */
    revision: Revision.nullable(),
    reviewDigest: digest.nullable(),
    /** `ready` can be saved; `questions` needs answers first (in chat or in
     * Processes); `budget` means the AI budget is not set up, so nothing could
     * be designed. */
    status: z.enum(["ready", "questions", "budget"]),
    name: IdentityName,
    description: z.string().max(1000),
    kind: z.enum(["agent", "workflow"]).nullable(),
    steps: z.array(ProcessProposalStepSchema).max(32),
    inputs: z
      .array(
        z.strictObject({
          key: ProcessKey,
          type: z.enum([
            "string",
            "number",
            "integer",
            "boolean",
            "null",
            "array",
            "object",
          ]),
          required: z.boolean(),
        }),
      )
      .max(40),
    outputs: z.array(ProcessKey).max(40),
    services: z
      .array(
        z.strictObject({
          name: label,
          reads: z.boolean(),
          writes: z.boolean(),
        }),
      )
      .max(16),
    /** What the designer assumed; saving acknowledges exactly these. */
    assumptions: z
      .array(
        z.strictObject({
          id: ProcessKey,
          text: z.string().min(1).max(1000),
          digest,
        }),
      )
      .max(20),
    questions: z.array(z.string().min(1).max(1000)).max(20),
    /** It could be on the overview: no required input and no write that runs
     * without the person's approval. */
    hubEligible: z.boolean(),
    /** "Add to overview" starts checked: the person asked for the overview. */
    addToHub: z.boolean(),
  })
  .refine(
    (v) =>
      (v.status === "budget") ===
        (v.sessionId === null &&
          v.revision === null &&
          v.reviewDigest === null) &&
      (!v.addToHub || v.hubEligible),
  );
export type ProcessProposalResult = z.infer<typeof ProcessProposalResultSchema>;

/** Save and turn on: an authenticated, idempotent command over the app API. */
export const ProcessProposalAcceptSchema = z.strictObject({
  profile: z.literal(PROCESS_PROPOSAL_PROFILE),
  type: z.literal("accept"),
  sessionId: IdentityId,
  /** One per press; a retry of the same press sends the same id. */
  requestId: IdentityId,
  revision: Revision,
  reviewDigest: digest,
  /** The assumptions the card showed, acknowledged by this press. */
  assumptions: z.array(z.strictObject({ id: ProcessKey, digest })).max(20),
  addToHub: z.boolean(),
});
export type ProcessProposalAccept = z.infer<typeof ProcessProposalAcceptSchema>;

export const ProcessProposalPhaseSchema = z.enum([
  "saving",
  "testing",
  "activating",
  "hub",
]);
export const ProcessProposalStatusSchema = z.strictObject({
  profile: z.literal(PROCESS_PROPOSAL_PROFILE),
  sessionId: IdentityId,
  /**
   * `open`: not pressed yet; `running`: see `phase`; `done`: active (and on
   * the overview when asked); `stopped`: saved and frozen, but its test needs
   * a person (see `gap`); `failed`: see `failure`.
   */
  state: z.enum(["open", "running", "done", "stopped", "failed"]),
  phase: ProcessProposalPhaseSchema.optional(),
  requestId: IdentityId.optional(),
  processId: IdentityId.optional(),
  version: z.number().int().positive().optional(),
  /** Overview outcome when it was asked for. */
  hub: z.enum(["added", "failed"]).optional(),
  hubFailure: code.optional(),
  /** Done, but its active version has limits an ordinary run outgrows (it
   * was saved before limits were sized): a new press saves, tests and turns
   * on a resized version and keeps the overview item. */
  resize: z.literal(true).optional(),
  failure: code.optional(),
  gap: code.optional(),
  /** For `model_reservation_too_large`: what the smallest useful run's model
   * calls reserve at the least (floor input + full output each), and the
   * most a process may hold in this workspace. */
  reservation: z
    .strictObject({
      tokens: z.number().int().nonnegative(),
      costMicros: z.number().int().nonnegative(),
      maxTokens: z.number().int().nonnegative(),
      maxCostMicros: z.number().int().nonnegative(),
      /** How many model calls the smallest useful run needs. */
      calls: z.number().int().positive().optional(),
    })
    .optional(),
  updatedAt: z.iso.datetime().optional(),
});
export type ProcessProposalStatus = z.infer<typeof ProcessProposalStatusSchema>;

/** Where the web app continues a proposal: its design session in Processes.
 * `address` is a client's API address (`…/v1/<workspace>`); the web app is
 * served from the same origin. */
export function processProposalWebUrl(
  address: string,
  proposal: Pick<ProcessProposalResult, "sessionId">,
) {
  const url = new URL(
    proposal.sessionId ? "/processes/design" : "/processes",
    new URL(address).origin,
  );
  if (proposal.sessionId) url.searchParams.set("sessionId", proposal.sessionId);
  return url.toString();
}
