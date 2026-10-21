import {
  CommandSchema,
  type Command,
  type Snapshot,
} from "../../packages/protocol";
import {
  cardFieldValueValid,
  type CardDocument,
  type CardAction,
  type CardValues,
  type CardInput,
} from "../../packages/protocol/card-document";

type CardResponse = Extract<Command, { type: "card.respond" }>;
type Failure = {
  ok: false;
  reason: "unknown_context" | "revision_conflict" | "invalid_answer";
};
type Resolution =
  | { ok: true; command: Extract<Command, { type: "message.send" }> }
  | Failure;

/** Typed form handoff. Labels are display data; this grants no execution authority. */
export function resolveCardSubmission(
  snapshot: Snapshot,
  command: CardResponse,
  { allowSuperseded = false }: { allowSuperseded?: boolean } = {},
):
  | { ok: true; document: CardDocument; action: CardAction; values: CardValues }
  | Failure {
  const conversation = snapshot.conversations.find(
    (c) => c.id === command.conversationId,
  );
  const message = conversation?.messages.find(
    (m) => m.id === command.messageId,
  );
  if (
    !message ||
    message.role !== "assistant" ||
    message.result?.type !== "card.document" ||
    message.result.document.id !== command.cardId
  )
    return { ok: false, reason: "unknown_context" };
  const document = message.result.document;
  if (
    document.revision !== command.expectedCardRevision ||
    (!allowSuperseded && conversation?.messages.at(-1)?.id !== message.id)
  )
    return { ok: false, reason: "revision_conflict" };
  const action = document.actions.find((a) => a.id === command.actionId);
  if (!action) return { ok: false, reason: "invalid_answer" };
  const fields = action.fields ?? [];
  if (
    Object.keys(command.values).some((id) => !fields.includes(id)) ||
    fields.some((id) => {
      const input = document.nodes.find((n) => n.id === id);
      return (
        input?.type !== "input" ||
        !cardFieldValueValid(input, command.values[id])
      );
    })
  )
    return { ok: false, reason: "invalid_answer" };
  return { ok: true, document, action, values: { ...command.values } };
}

/** Resolves only the scoped, currently visible document. Never dispatches a service. */
export function resolveCardResponse(
  snapshot: Snapshot,
  command: CardResponse,
  { allowSuperseded = false }: { allowSuperseded?: boolean } = {},
): Resolution {
  const submitted = resolveCardSubmission(snapshot, command, {
    allowSuperseded,
  });
  if (!submitted.ok) return submitted;
  const { document: doc, action } = submitted;
  const fields = action.fields ?? [];
  if (Object.keys(command.values).some((id) => !fields.includes(id)))
    return { ok: false, reason: "invalid_answer" };
  let text = action.label;
  if (action.kind === "submit") {
    const answers: string[] = [];
    for (const id of fields) {
      const input = doc.nodes.find((n) => n.id === id) as CardInput;
      const value = command.values[id];
      if (!cardFieldValueValid(input, value))
        return { ok: false, reason: "invalid_answer" };
      if (value !== undefined && (typeof value !== "string" || value.trim())) {
        const display =
          input.kind === "choice"
            ? input.options!.find((o) => o.id === value)!.label
            : typeof value === "boolean"
              ? command.language === "cs"
                ? value
                  ? "Ano"
                  : "Ne"
                : value
                  ? "Yes"
                  : "No"
              : String(value);
        answers.push(`${input.label}: ${display}`);
      }
    }
    text = [action.label, ...answers].join("\n");
  }
  if (text.length > 4000) return { ok: false, reason: "invalid_answer" };
  return {
    ok: true,
    command: CommandSchema.parse({
      type: "message.send",
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      conversationId: command.conversationId,
      language: command.language,
      text,
    }) as Extract<Command, { type: "message.send" }>,
  };
}
