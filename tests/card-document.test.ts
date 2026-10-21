import {
  CardDocumentSchema,
  cardFieldValueValid,
  type CardDocument,
} from "../packages/protocol/card-document";
import {
  CommandSchema,
  MessageResultSchema,
  WorkItemSchema,
} from "../packages/protocol";
import { ServiceResultSchema } from "../packages/protocol/service-result";
import { composeCard, COMPOSE_CARD_TOOL } from "../apps/server-cards/composer";
import { resolveCardResponse } from "../apps/server-cards/respond";
import { FixtureEngine } from "../apps/fixture-server/engine";
import {
  messageCommand,
  answerCommand,
} from "../packages/client-core/commands";
import { choosePeter, scopeFor } from "../packages/test-fixtures";
import {
  snapshotWithoutCards,
  eventsWithoutCards,
} from "../packages/protocol/card-delivery";

const document = (): CardDocument =>
  composeCard(
    {
      title: "Prepare a review",
      icon: "calendar",
      nodes: [
        {
          id: "agenda",
          type: "input",
          label: "Agenda",
          kind: "text",
          required: true,
        },
        {
          id: "choice",
          type: "input",
          label: "Venue",
          kind: "choice",
          required: true,
          options: [
            { id: "office", label: "TEST office" },
            { id: "online", label: "TEST online" },
          ],
        },
        { id: "button", type: "button", actionId: "prepare" },
      ],
      root: ["agenda", "choice", "button"],
      actions: [
        {
          id: "prepare",
          label: "Prepare a proposal",
          kind: "submit",
          variant: "primary",
          fields: ["agenda", "choice"],
        },
      ],
    },
    { id: "TEST-card", revision: 2 },
  );
const interpretation = (engine: FixtureEngine, card?: CardDocument) => ({
  decision: {
    kind: "reply" as const,
    contactId: null,
    title: null,
    localStart: null,
    durationMinutes: null,
    reply: "TEST received",
  },
  expectedCursor: engine.snapshot().cursor,
  timeZone: "UTC",
  ...(card ? { card } : {}),
});
function setup() {
  const engine = new FixtureEngine();
  engine.execute(
    messageCommand("Prepare a review", "en", "TEST-create"),
    interpretation(engine, document()),
  );
  const message = engine.snapshot().conversations[0]!.messages.at(-1)!;
  const command = CommandSchema.parse({
    type: "card.respond",
    commandId: "TEST-answer",
    idempotencyKey: "TEST-answer",
    conversationId: "conversation-1",
    messageId: message.id,
    cardId: "TEST-card",
    expectedCardRevision: 2,
    actionId: "prepare",
    language: "en",
    values: { agenda: "TEST quarterly review", choice: "online" },
  });
  if (command.type !== "card.respond") throw new Error("Invalid test command");
  return { engine, command };
}

test("validated composition is data-only and supports unfamiliar layouts", () => {
  expect(
    MessageResultSchema.parse({
      type: "card.document",
      version: 1,
      document: document(),
    }).type,
  ).toBe("card.document");
  expect(COMPOSE_CARD_TOOL.function.parameters).toMatchObject({
    type: "object",
    additionalProperties: false,
  });
  expect(() =>
    composeCard(
      { ...document(), id: undefined, revision: undefined },
      { id: "server-id", revision: 1 },
    ),
  ).toThrow();
});

test.each([
  (d: CardDocument) => ({ ...d, style: { color: "red" } }),
  (d: CardDocument) => ({
    ...d,
    nodes: [...d.nodes, { id: "orphan", type: "text", text: "Hidden" }],
  }),
  (d: CardDocument) => ({ ...d, root: [...d.root, d.root[0]] }),
  (d: CardDocument) => ({
    ...d,
    actions: [{ ...d.actions[0], endpoint: "/approve" }],
  }),
  (d: CardDocument) => ({
    ...d,
    nodes: d.nodes.map((n) =>
      n.id === "button" ? { ...n, actionId: "unknown" } : n,
    ),
  }),
  (d: CardDocument) => ({
    ...d,
    nodes: d.nodes.map((n) =>
      n.id === "choice"
        ? {
            ...n,
            options: [
              { id: "same", label: "One" },
              { id: "same", label: "Two" },
            ],
          }
        : n,
    ),
  }),
])(
  "rejects malformed graph and executable or hidden properties (%#)",
  (mutate) => {
    expect(CardDocumentSchema.safeParse(mutate(document())).success).toBe(
      false,
    );
  },
);

test("card graph caps depth, size and hidden action controls", () => {
  const base = { id: "TEST", revision: 1, title: "TEST", actions: [] };
  const nodes = Array.from({ length: 7 }, (_, i) =>
    i === 6
      ? { id: `n${i}`, type: "text", text: "TEST" }
      : { id: `n${i}`, type: "stack", children: [`n${i + 1}`] },
  );
  expect(
    CardDocumentSchema.safeParse({ ...base, root: ["n0"], nodes }).success,
  ).toBe(false);
  expect(
    CardDocumentSchema.safeParse({
      ...base,
      root: Array.from({ length: 9 }, (_, i) => `n${i}`),
      nodes: Array.from({ length: 9 }, (_, i) => ({
        id: `n${i}`,
        type: "text",
        text: "x".repeat(4000),
      })),
    }).success,
  ).toBe(false);
  const d = document();
  expect(
    CardDocumentSchema.safeParse({
      ...d,
      root: ["hidden"],
      nodes: [
        ...d.nodes,
        {
          id: "hidden",
          type: "disclosure",
          label: "Details",
          children: d.root,
        },
      ],
    }).success,
  ).toBe(false);
});

test("generic card controls cannot become work or service approval controls", () => {
  expect(
    WorkItemSchema.safeParse({ ...choosePeter("en").work, card: document() })
      .success,
  ).toBe(false);
  expect(
    ServiceResultSchema.safeParse({
      type: "service.action",
      version: 1,
      operationId: "TEST",
      title: "TEST",
      service: "TEST",
      status: "awaiting_approval",
      effect: "write",
      fields: [],
      inputJson: "{}",
      reviewTruncated: false,
      summary: "",
      card: document(),
    }).success,
  ).toBe(false);
});

test("form answers use visible labels and offered values without performing an operation", () => {
  const { engine, command } = setup();
  const resolved = resolveCardResponse(engine.snapshot(), command);
  expect(resolved).toMatchObject({
    ok: true,
    command: {
      text: "Prepare a proposal\nAgenda: TEST quarterly review\nVenue: TEST online",
    },
  });
  const first = engine.execute(command, interpretation(engine));
  expect(first.status).toBe("accepted");
  expect(first.snapshot.operations).toEqual([]);
  expect(first.snapshot.actionProposals).toEqual([]);
  expect(engine.data.receipts.at(-1)?.command).toEqual(command);
  const cursor = first.snapshot.cursor;
  expect(engine.execute(command)).toEqual(first);
  expect(engine.snapshot().cursor).toBe(cursor);
  expect(
    engine.execute({
      ...command,
      values: { agenda: "Changed", choice: "online" },
    }).code,
  ).toBe("idempotency_conflict");
});

test.each([
  { values: { agenda: "TEST" } },
  { values: { agenda: "   ", choice: "online" } },
  { values: { agenda: "TEST", choice: "forged" } },
  { values: { agenda: "TEST", choice: "online", approved: true } },
  { actionId: "approve" },
  { messageId: "foreign-message" },
  { cardId: "foreign-card" },
  { expectedCardRevision: 1 },
])(
  "rejects changed, foreign or invalid responses before mutation (%#)",
  (change) => {
    const { engine, command } = setup();
    const before = engine.snapshot();
    expect(
      engine.execute({ ...command, ...change }, interpretation(engine)).status,
    ).not.toBe("accepted");
    expect(engine.snapshot()).toEqual(before);
  },
);

test("a newer turn and a cleared session invalidate former card controls", () => {
  const { engine, command } = setup();
  engine.execute(
    messageCommand("TEST new topic", "en", "TEST-next"),
    interpretation(engine),
  );
  expect(engine.execute(command, interpretation(engine)).code).toBe(
    "revision_conflict",
  );
  const fresh = setup();
  fresh.engine.startSession();
  expect(
    fresh.engine.execute(fresh.command, interpretation(fresh.engine)).code,
  ).toBe("unknown_context");
});

test("commit revalidates the document after inference and persisted replay remains passive", () => {
  const { engine, command } = setup();
  const pending = interpretation(engine);
  engine.execute(
    messageCommand("TEST concurrent turn", "en", "TEST-concurrent"),
    interpretation(engine),
  );
  expect(engine.execute(command, pending).code).toBe("revision_conflict");
  const restored = new FixtureEngine(
    "a",
    engine.data,
    () => {},
    () => Date.now(),
    scopeFor("a"),
  );
  expect(restored.execute(command)).toEqual(engine.execute(command));
});

test("strict older clients get plain message fallbacks and workflow entities", () => {
  const { engine } = setup();
  const legacy = snapshotWithoutCards(engine.snapshot());
  expect(legacy.conversations[0]!.messages.at(-1)).toMatchObject({
    text: "TEST received",
  });
  expect(legacy.conversations[0]!.messages.at(-1)).not.toHaveProperty("result");
  expect(
    eventsWithoutCards(engine.data.events)
      .filter((e) => e.type === "conversation.upserted")
      .at(-1)?.entity,
  ).toEqual(legacy.conversations[0]);
});

test("field checks reject impossible dates, times and wrong value types", () => {
  const field = {
    id: "TEST",
    type: "input" as const,
    label: "Date",
    kind: "date" as const,
    required: true,
  };
  expect(cardFieldValueValid(field, "2026-02-31")).toBe(false);
  expect(cardFieldValueValid(field, "2026-09-30")).toBe(true);
  expect(cardFieldValueValid({ ...field, kind: "time" }, "24:30")).toBe(false);
  expect(cardFieldValueValid({ ...field, kind: "number" }, "12")).toBe(false);
  expect(cardFieldValueValid({ ...field, kind: "toggle" }, false)).toBe(true);
});

test.each(["__proto__", "constructor", "toString", "prototype"])(
  "reserved dictionary ID %s cannot alter field maps",
  (id) => {
    const card = document();
    expect(
      CardDocumentSchema.safeParse({
        ...card,
        nodes: card.nodes.map((n) => (n.id === "agenda" ? { ...n, id } : n)),
        root: [id, "choice", "button"],
        actions: [{ ...card.actions[0], fields: [id, "choice"] }],
      }).success,
    ).toBe(false);
  },
);

test("a dispatched service outcome is preserved when another turn supersedes its answer card", () => {
  const { engine, command } = setup();
  const acceptedIntent = interpretation(engine);
  engine.execute(
    messageCommand("TEST later question", "en", "TEST-later"),
    interpretation(engine),
  );
  const result = engine.execute(command, {
    ...acceptedIntent,
    serviceResult: {
      type: "service.action",
      version: 1,
      operationId: "TEST-durable-operation",
      title: "TEST Lookup",
      service: "TEST Directory",
      status: "succeeded",
      effect: "read",
      fields: [],
      inputJson: "",
      reviewTruncated: false,
      summary: "TEST verified result",
    },
  });
  expect(result.status).toBe("accepted");
  expect(
    result.snapshot.conversations[0]!.messages.at(-1)?.result,
  ).toMatchObject({
    operationId: "TEST-durable-operation",
    status: "succeeded",
  });
  expect(engine.execute(command)).toEqual(result);
});

test("work summaries preserve an explicitly authored current revision instead of a fixed template", () => {
  const engine = new FixtureEngine();
  engine.execute(messageCommand("Choose Peter", "en", "TEST-work"));
  const work = engine.data.snapshot.workItems[0]!;
  const body = composeCard(
    {
      title: "TEST bespoke task summary",
      nodes: [
        {
          id: "fact",
          type: "field",
          label: "TEST verified fact",
          value: "TEST custom layout",
        },
      ],
      root: ["fact"],
      actions: [],
    },
    { id: "TEST-work-body", revision: work.revision },
  );
  work.card = body;
  expect(engine.snapshot().workItems[0]!.card).toEqual(body);
  const nextBody = { ...body, revision: work.revision + 1 };
  work.card = nextBody;
  engine.execute(
    answerCommand(
      engine.snapshot().inputRequests[0]!,
      "peter-novak",
      "TEST-work-answer",
    ),
  );
  expect(engine.snapshot().workItems[0]!.card).toEqual(nextBody);
  expect(
    engine.data.events.filter((e) => e.type === "work_item.upserted").at(-1)
      ?.entity,
  ).toMatchObject({ card: nextBody });
});
