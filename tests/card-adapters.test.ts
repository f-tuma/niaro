import { CardBuilder } from "../apps/server-cards/builders";
import { crmCard, serviceCard, workCard } from "../apps/server-cards/adapters";
import {
  CardDocumentSchema,
  CARD_LIMITS,
  type CardNode,
} from "../packages/protocol/card-document";
import type { ServiceResult } from "../packages/protocol/service-result";
import type { ServicePresentation } from "../packages/protocol/service-presentation";
import { choosePeter, crmContactResult } from "../packages/test-fixtures";

const result = (overrides: Partial<ServiceResult> = {}): ServiceResult => ({
  type: "service.action",
  version: 1,
  operationId: "TEST-operation",
  title: "Find contacts",
  service: "TEST company directory",
  status: "succeeded",
  effect: "read",
  fields: [],
  inputJson: "",
  reviewTruncated: false,
  summary: "",
  ...overrides,
});

test("the typed builder composes an arbitrary passive data section", () => {
  const builder = new CardBuilder({
    id: "TEST-card",
    revision: 3,
    title: "Plan the review",
  });
  const participant = builder.add(
    { type: "field", label: "Participant", value: "TEST Anna", icon: "person" },
    { root: false },
  );
  const time = builder.add(
    {
      type: "field",
      label: "Starts",
      value: "30 Sep 2026, 12:00 · UTC",
      icon: "clock",
    },
    { root: false },
  );
  builder.add({
    type: "section",
    title: "Meeting",
    children: [participant, time],
    icon: "calendar",
  });
  builder.add({ type: "notice", text: "TEST room booked", tone: "info" });
  const card = builder.build();
  expect(CardDocumentSchema.safeParse(card).success).toBe(true);
  expect(card.id).toBe("TEST-card");
  expect(card.revision).toBe(3);
  expect(card.root).toEqual(["node-3", "node-4"]);
  expect(card.actions).toEqual([]);
});

test("the builder cannot bypass graph, passivity or arbitrary-style validation", () => {
  const form = new CardBuilder({ id: "TEST-card", revision: 1, title: "Form" });
  form.add({ type: "input", kind: "text", label: "Agenda" });
  expect(() => form.build()).toThrow();

  const unreachable = new CardBuilder({
    id: "TEST-card",
    revision: 1,
    title: "Task",
  });
  unreachable.add({ type: "text", text: "Visible" });
  unreachable.add({ type: "text", text: "Orphan" }, { root: false });
  expect(() => unreachable.build()).toThrow();

  const styled = new CardBuilder({
    id: "TEST-card",
    revision: 1,
    title: "Task",
  });
  styled.add({ type: "text", text: "Visible", color: "red" } as unknown as Omit<
    Extract<CardNode, { type: "text" }>,
    "id"
  >);
  expect(() => styled.build()).toThrow();
});

test.each(["en", "cs"] as const)(
  "CRM adapter produces passive source-backed contacts in %s",
  (language) => {
    const input = crmContactResult();
    const contact = input.contacts[0]!;
    const card = crmCard(input, language);
    expect(CardDocumentSchema.safeParse(card).success).toBe(true);
    expect(card.subtitle).toBe("Twenty");
    expect(card.actions).toEqual([]);
    expect(
      card.nodes.some(
        (node) => node.type === "input" || node.type === "button",
      ),
    ).toBe(false);
    expect(card.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "field",
          label: language === "cs" ? "E-mail" : "Email",
          value: contact.email,
          icon: "mail",
        }),
        expect.objectContaining({
          type: "field",
          label: language === "cs" ? "Telefon" : "Phone",
          value: contact.phone,
          icon: "phone",
        }),
        expect.objectContaining({
          type: "section",
          title: contact.name,
        }),
      ]),
    );
    expect(crmCard(input, language)).toEqual(card);
  },
);

test("empty and name-only contacts remain useful without invented details", () => {
  const empty = crmCard(
    { ...crmContactResult(), contacts: [], hasMore: true },
    "cs",
  );
  expect(empty.nodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "text",
        text: "Žádné kontakty nebyly nalezeny.",
      }),
      expect.objectContaining({ type: "notice", tone: "info" }),
    ]),
  );
  const nameOnly = crmCard(
    {
      ...crmContactResult(),
      contacts: [{ id: "TEST-person", name: "TEST Name only" }],
    },
    "en",
  );
  expect(nameOnly.nodes).toEqual([
    expect.objectContaining({ type: "heading", text: "TEST Name only" }),
  ]);
});

test.each([
  ["awaiting_approval", "info"],
  ["running", "info"],
  ["succeeded", "success"],
  ["failed", "danger"],
  ["unknown", "warning"],
  ["rejected", "neutral"],
] as const)("service %s retains its authoritative state", (status, tone) => {
  const card = serviceCard(
    result({
      status,
      presentation: { kind: "text", text: "TEST success content" },
    }),
    "en",
  );
  expect(card.nodes[0]).toMatchObject({ type: "badge", tone });
  expect(JSON.stringify(card).includes("TEST success content")).toBe(
    status === "succeeded",
  );
  if (status === "unknown")
    expect(card.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "notice", tone: "warning" }),
      ]),
    );
});

test("service approval body never invents controls or replaces the full review fields", () => {
  const card = serviceCard(
    result({
      status: "awaiting_approval",
      effect: "write",
      title: "Create a meeting",
      fields: [{ label: "recipient", value: "TEST-recipient@example.test" }],
      inputJson: '{"recipient":"TEST-recipient@example.test"}',
      reviewTruncated: true,
    }),
    "cs",
  );
  expect(card.actions).toEqual([]);
  expect(card.nodes).toEqual([
    expect.objectContaining({
      type: "badge",
      label: "Čeká na tvoje potvrzení",
    }),
  ]);
  expect(JSON.stringify(card)).not.toContain("TEST-recipient@example.test");
});

test("service event rows show timezone-normalized facts without source diagnostics", () => {
  const card = serviceCard(
    result({
      presentation: {
        kind: "events",
        hasMore: false,
        items: [
          {
            title: "TEST Review",
            start: "2026-09-30T14:00:00+02:00",
            end: "2026-09-30T15:00:00+02:00",
            location: "TEST Room",
          },
        ],
      },
      summary: '{"eventId":"TEST-event"}',
    }),
    "cs",
  );
  const starts = card.nodes.find(
    (node) => node.type === "field" && node.label === "Začátek",
  );
  expect(starts).toMatchObject({
    type: "field",
    value: expect.stringContaining("12:00"),
  });
  expect(starts).toMatchObject({ value: expect.stringContaining("UTC") });
  expect(
    card.nodes.some(
      (node) => node.type === "disclosure" || node.type === "code",
    ),
  ).toBe(false);
  expect(JSON.stringify(card)).not.toContain("TEST-event");
});

test("large rich record results use an explicit bounded preview", () => {
  const card = serviceCard(
    result({
      presentation: {
        kind: "records",
        hasMore: false,
        items: Array.from({ length: 10 }, (_, index) => ({
          title: `TEST project ${index + 1}`,
          subtitle: "TEST detail",
          fields: Array.from({ length: 6 }, (_, field) => ({
            label: `Field ${field + 1}`,
            value: "A".repeat(500),
          })),
        })),
      },
    }),
    "en",
  );
  expect(CardDocumentSchema.safeParse(card).success).toBe(true);
  expect(card.nodes.length).toBeLessThanOrEqual(CARD_LIMITS.nodes);
  expect(card.nodes.filter((node) => node.type === "section")).toHaveLength(6);
  expect(card.nodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "notice",
        text: expect.stringContaining("preview"),
      }),
    ]),
  );
});

test("empty detail values are omitted without breaking the card graph", () => {
  const card = serviceCard(
    result({
      presentation: { kind: "detail", fields: [{ label: "Empty", value: "" }] },
    }),
    "en",
  );
  expect(card.nodes).toEqual([
    expect.objectContaining({ type: "badge", tone: "success" }),
  ]);
});

test("work summaries retain revision and full long titles without inventing progress", () => {
  const work = {
    ...choosePeter("cs").work,
    revision: 4,
    title: "TEST ".repeat(70),
    result: "TEST result",
  };
  const card = workCard(work, "cs");
  expect(card.revision).toBe(4);
  expect(card.title.length).toBe(160);
  expect(card.nodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "text", text: work.title.trim() }),
      expect.objectContaining({ type: "text", text: work.result }),
      expect.objectContaining({
        type: "badge",
        label: "Čeká na tvoji odpověď",
      }),
    ]),
  );
  expect(
    card.nodes.some(
      (node) =>
        node.type === "progress" ||
        node.type === "button" ||
        node.type === "input",
    ),
  ).toBe(false);
  expect(workCard({ ...work, revision: 5 }, "cs").id).toBe(card.id);
});

test("malformed legacy result data fails closed rather than forging success", () => {
  expect(() =>
    serviceCard(
      result({ status: "unverified" as ServiceResult["status"] }),
      "en",
    ),
  ).toThrow();
  expect(() =>
    crmCard(
      {
        ...crmContactResult(),
        contacts: [
          { id: "TEST-contact", name: "TEST Contact", email: "bad address" },
        ],
      },
      "en",
    ),
  ).toThrow();
});

test.each([
  {
    kind: "contacts",
    hasMore: true,
    items: Array.from({ length: 10 }, () => ({
      name: "N".repeat(160),
      subtitle: "R".repeat(160),
      email: "E".repeat(254),
      phone: "P".repeat(64),
    })),
  },
  {
    kind: "events",
    hasMore: true,
    items: Array.from({ length: 10 }, () => ({
      title: "T".repeat(160),
      start: "2026-09-30T12:00:00Z",
      end: "2026-09-30T13:00:00Z",
      location: "L".repeat(160),
    })),
  },
  {
    kind: "detail",
    fields: Array.from({ length: 6 }, () => ({
      label: "L".repeat(100),
      value: "V".repeat(500),
    })),
  },
  { kind: "text", text: "T".repeat(1600) },
] satisfies ServicePresentation[])(
  "maximal $kind legacy presentation produces a valid card",
  (presentation) => {
    const card = serviceCard(
      result({ presentation, summary: "S".repeat(2000) }),
      "cs",
    );
    expect(CardDocumentSchema.safeParse(card).success).toBe(true);
    expect(card.nodes.length).toBeLessThanOrEqual(CARD_LIMITS.nodes);
  },
);

test("JSON escaping cannot overflow a valid service-result preview", () => {
  const card = serviceCard(
    result({
      presentation: {
        kind: "records",
        hasMore: false,
        items: Array.from({ length: 10 }, () => ({
          title: "\0".repeat(160),
          subtitle: "\0".repeat(160),
          fields: Array.from({ length: 6 }, () => ({
            label: "\0".repeat(100),
            value: "\0".repeat(500),
          })),
        })),
      },
      summary: "\0".repeat(2000),
    }),
    "en",
  );
  expect(CardDocumentSchema.safeParse(card).success).toBe(true);
  expect(card.nodes.filter((node) => node.type === "section")).toHaveLength(1);
  expect(card.nodes.filter((node) => node.type === "notice")).toHaveLength(1);
});

test.each(["en", "cs"] as const)(
  "%s scalar fields get links only for useful complete destinations",
  (language) => {
    const card = serviceCard(
      result({
        presentation: {
          kind: "detail",
          fields: [
            { label: "Email", value: "person@example.test" },
            { label: "Website", value: "https://example.test/review" },
            {
              label: language === "cs" ? "Telefonní číslo" : "Mobile number",
              value: "+420 555 010 001",
            },
            { label: "Record ID", value: "555010001" },
            { label: "Phone", value: "Call the reception" },
            { label: "Other", value: "javascript:alert(1)" },
          ],
        },
        summary: '{"raw":"TEST-secret-source"}',
      }),
      language,
    );
    const fields = card.nodes.filter((node) => node.type === "field");
    expect(fields.map((node) => node.icon)).toEqual([
      "mail",
      "link",
      "phone",
      undefined,
      undefined,
      undefined,
    ]);
    expect(JSON.stringify(card)).not.toContain("TEST-secret-source");
    expect(card.actions).toEqual([]);
  },
);

test("maximal escaped work text uses an explicit safe preview", () => {
  const work = {
    ...choosePeter().work,
    title: "\0".repeat(4000),
    context: "\0".repeat(4000),
    result: "\0".repeat(4000),
  };
  const card = workCard(work, "en");
  expect(CardDocumentSchema.safeParse(card).success).toBe(true);
  expect(card.nodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "notice",
        text: expect.stringContaining("shortened"),
      }),
    ]),
  );
});

test("legacy whitespace-only optional values do not break a passive preview", () => {
  const card = serviceCard(
    result({
      title: " ",
      service: " ",
      presentation: {
        kind: "records",
        hasMore: false,
        items: [{ title: " ", subtitle: " ", fields: [] }],
      },
    }),
    "en",
  );
  expect(CardDocumentSchema.safeParse(card).success).toBe(true);
  expect(card.title).toBe("Service result");
  const work = workCard(
    { ...choosePeter().work, title: " ", context: " ", result: " " },
    "en",
  );
  expect(work.title).toBe("Task");
  expect(work.nodes).toHaveLength(1);
});

test("service cards name the action for people and keep diagnostics out of the failure body", () => {
  expect(serviceCard(result({ title: "list-mail-messages" }), "en").title).toBe(
    "List mail messages",
  );
  const failed = serviceCard(
    result({
      title: "search_tasks",
      status: "failed",
      fields: [
        { label: "Důvod", value: "TEST connection failed." },
        { label: "Kód chyby", value: "TEST_CONNECTION" },
        { label: "HTTP", value: "502" },
      ],
    }),
    "cs",
  );
  expect(failed.title).toBe("Search tasks");
  const body = JSON.stringify(failed);
  expect(body).toContain("TEST connection failed.");
  expect(body).not.toContain("TEST_CONNECTION");
  expect(body).not.toContain("502");
  expect(failed.nodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "section", title: "Co se stalo" }),
    ]),
  );
});
