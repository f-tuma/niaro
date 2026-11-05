import { DomainCommandSchema } from "../../apps/server-identity/mastra-domain";

/**
 * A finished chat turn as the server stores it, with only what a receipt
 * reads set; the rest takes the schema's defaults (NIAR-296 tests).
 */
export function storedTurn(
  commandId: string,
  conversationId: string,
  extra: Record<string, unknown> = {},
) {
  return DomainCommandSchema.parse({
    kind: "mastra-1",
    hash: "TEST-hash-" + commandId,
    commandId,
    text: "TEST question",
    goal: "TEST question",
    openedAt: "2026-11-05T10:00:00.000Z",
    aliases: [{ commandId, hash: "TEST-hash-" + commandId }],
    language: "en",
    clock: { referenceNow: "2026-11-05T10:00:00.000Z", timeZone: "UTC" },
    epoch: 1,
    conversationId,
    threadId: "TEST-thread-" + commandId,
    runId: "TEST-run-" + commandId,
    operations: [],
    sources: [],
    exposed: [],
    calls: 0,
    inference: 0,
    modelCalls: 1,
    rejectedWrites: [],
    plugins: [],
    ...extra,
  });
}
