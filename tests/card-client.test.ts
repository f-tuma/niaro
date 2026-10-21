import { commandTarget } from "../packages/client-core/session";
import type { Command } from "../packages/protocol";

const command: Extract<Command, { type: "card.respond" }> = {
  type: "card.respond",
  commandId: "answer-1",
  idempotencyKey: "answer-1",
  conversationId: "conversation-1",
  messageId: "message-1",
  cardId: "meeting-template",
  expectedCardRevision: 1,
  actionId: "prepare",
  values: {},
  language: "en",
};
test("card delivery states belong to the originating message as well as document and revision", () => {
  expect(commandTarget(command)).toBe("message-1:meeting-template:1");
  expect(commandTarget({ ...command, messageId: "message-2" })).not.toBe(
    commandTarget(command),
  );
  expect(commandTarget({ ...command, expectedCardRevision: 2 })).not.toBe(
    commandTarget(command),
  );
});
