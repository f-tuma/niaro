import {
  CardDocumentSchema,
  cardDocumentText,
  cardFieldValueValid,
  type CardDocument,
} from "../packages/protocol/card-document";
import { MessageResultSchema, WorkItemSchema } from "../packages/protocol";
import { ServiceResultSchema } from "../packages/protocol/service-result";
import { FixtureEngine } from "../apps/fixture-server/engine";
import {
  messageCommand,
  answerCommand,
} from "../packages/client-core/commands";
import { choosePeter } from "../packages/test-fixtures";
import {
  snapshotWithoutCards,
  eventsWithoutCards,
} from "../packages/protocol/card-delivery";

// Answers no longer carry model-composed cards. These tests keep the
// stored ones readable and their old form answers safely bound.
const card = (raw: object, identity: { id: string; revision: number }) =>
  CardDocumentSchema.parse({ ...raw, ...identity });
const document = (): CardDocument =>
  card(
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
const interpretation = (engine: FixtureEngine) => ({
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
});
/** An answer as stored with its card before such cards were retired. */
function storeCard(engine: FixtureEngine, stored: CardDocument) {
  const message = engine.data.snapshot.conversations[0]!.messages.at(-1)!;
  message.result = { type: "card.document", version: 1, document: stored };
  return message;
}
function setup() {
  const engine = new FixtureEngine();
  engine.execute(
    messageCommand("Prepare a review", "en", "TEST-create"),
    interpretation(engine),
  );
  storeCard(engine, document());
  return { engine };
}

test("a stored card stays readable history as plain text", () => {
  expect(
    MessageResultSchema.parse({
      type: "card.document",
      version: 1,
      document: document(),
    }).type,
  ).toBe("card.document");
  expect(
    cardDocumentText(
      card(
        {
          title: "TEST Review",
          subtitle: "TEST Friday",
          nodes: [
            { id: "h", type: "heading", text: "TEST Agenda" },
            { id: "f", type: "field", label: "Room", value: "TEST 4" },
            {
              id: "l",
              type: "list",
              items: [{ title: "TEST Budget", detail: "TEST Q3" }],
            },
            { id: "d", type: "divider" },
          ],
          root: ["h", "f", "l", "d"],
          actions: [],
        },
        { id: "TEST-text", revision: 1 },
      ),
    ),
  ).toBe(
    "TEST Review\nTEST Friday\nTEST Agenda\nRoom: TEST 4\nTEST Budget: TEST Q3",
  );
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

test("work summaries preserve an explicitly authored current revision instead of a fixed template", () => {
  const engine = new FixtureEngine();
  engine.execute(messageCommand("Choose Peter", "en", "TEST-work"));
  const work = engine.data.snapshot.workItems[0]!;
  const body = card(
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
