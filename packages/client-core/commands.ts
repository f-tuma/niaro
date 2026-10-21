import {
  CommandSchema,
  type Command,
  type InputRequest,
  type ActionProposal,
  type Operation,
  type Language,
  type ReplyInput,
} from "../protocol";
export type LocalCommandState =
  | "idle"
  | "sending"
  | "accepted"
  | "network_error"
  | "conflict"
  | "rejected";
export function answerCommand(
  input: InputRequest,
  selectedContactId: string,
  newId: string,
): Command {
  return CommandSchema.parse({
    type: "input.submit",
    commandId: newId,
    idempotencyKey: newId,
    conversationId: input.conversationId,
    workItemId: input.workItemId,
    inputRequestId: input.id,
    expectedInputRevision: input.revision,
    answer: { selectedContactId },
  });
}
/** The zone the phone is set to; nothing when the platform cannot say. */
function deviceTimeZone(): { timeZone?: string } {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && /^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+)$/.test(zone)
      ? { timeZone: zone }
      : {};
  } catch {
    return {};
  }
}
export function messageCommand(
  text: string,
  language: Language,
  newId: string,
  input?: ReplyInput,
): Extract<Command, { type: "message.send" }> {
  return CommandSchema.parse({
    type: "message.send",
    commandId: newId,
    idempotencyKey: newId,
    conversationId: input?.conversationId ?? "conversation-1",
    text,
    language,
    ...deviceTimeZone(),
    ...(input
      ? {
          context: {
            workItemId: input.workItemId,
            inputRequestId: input.id,
            expectedInputRevision: input.revision,
            ...("runtime" in input ? { runtime: input.runtime } : {}),
          },
        }
      : {}),
  }) as Extract<Command, { type: "message.send" }>;
}

/**
 * Create a new, explicit retry attempt for a chat message. Transport retries
 * must keep the returned command byte-for-byte; this helper is only for a
 * deliberate user action after the prior attempt has a terminal result.
 */
export function retryMessageCommand(
  original: Extract<Command, { type: "message.send" }>,
  identity: string | { commandId: string; idempotencyKey: string },
): Extract<Command, { type: "message.send" }> {
  const {
    commandId: parentCommandId,
    idempotencyKey: _parentIdempotencyKey,
    logicalMessageId,
    retryOf: _retryOf,
    session: _session,
    ...intent
  } = original;
  const commandId = typeof identity === "string" ? identity : identity.commandId;
  const idempotencyKey =
    typeof identity === "string" ? identity : identity.idempotencyKey;
  return CommandSchema.parse({
    ...intent,
    type: "message.send",
    commandId,
    idempotencyKey,
    logicalMessageId: logicalMessageId ?? parentCommandId,
    retryOf: parentCommandId,
  }) as Extract<Command, { type: "message.send" }>;
}

export function proposalDecision(
  proposal: ActionProposal,
  decision: "approve" | "reject",
  newId: string,
): Command {
  return CommandSchema.parse({
    type: "proposal.decide",
    commandId: newId,
    idempotencyKey: newId,
    conversationId: proposal.conversationId,
    workItemId: proposal.workItemId,
    proposalId: proposal.id,
    expectedProposalRevision: proposal.revision,
    decision,
  });
}
export function reviseProposal(
  proposal: ActionProposal,
  participantId: string,
  startsAt: string,
  newId: string,
): Command {
  return CommandSchema.parse({
    type: "proposal.revise",
    commandId: newId,
    idempotencyKey: newId,
    conversationId: proposal.conversationId,
    workItemId: proposal.workItemId,
    proposalId: proposal.id,
    expectedProposalRevision: proposal.revision,
    changes: { participantId, startsAt },
  });
}

export function reconcileOperation(
  operation: Operation,
  newId: string,
): Command {
  return CommandSchema.parse({
    type: "operation.reconcile",
    commandId: newId,
    idempotencyKey: newId,
    conversationId: operation.conversationId,
    workItemId: operation.workItemId,
    operationId: operation.id,
    expectedOperationRevision: operation.revision,
  });
}
