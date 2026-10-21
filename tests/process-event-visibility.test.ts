import { processEventsForCurrentWindow } from "../apps/fixture-server/process-event-visibility";
import { EventSchema, type DomainEvent } from "../packages/protocol";
import { CardBuilder } from "../apps/server-cards/builders";
import { outputWork } from "./helpers/process-output-client";
import { credential } from "./auth-fixtures";

function event(): DomainEvent {
  const work = outputWork();
  const card = new CardBuilder({
    id: "TEST-private-card",
    revision: 1,
    title: "TEST title",
    icon: "tasks",
  });
  card.add({ type: "text", text: "TEST historical private output" });
  return EventSchema.parse({
    eventId: "TEST-event",
    sequence: 17,
    scope: credential().scope,
    type: "work_item.upserted",
    entity: {
      ...work,
      card: card.build(),
      result: "TEST private result",
      context: "TEST private context",
      native: {
        ...work.native,
        process: {
          ...work.native!.process,
          receipts: [
            {
              operationId: "TEST-op",
              title: "TEST private action",
              service: "TEST private service",
              effect: "write",
              status: "succeeded",
              summary: "TEST historical private output",
            },
          ],
        },
      },
    },
  });
}
test("only the exact fresh process body retains private data; historical event identity and recorded outcomes survive", () => {
  const original = event();
  if (original.type !== "work_item.upserted") throw Error("fixture");
  expect(
    processEventsForCurrentWindow(
      [original],
      [structuredClone(original.entity)],
    )[0],
  ).toBe(original);
  const fresh = structuredClone(original.entity);
  fresh.revision++;
  const [hidden] = processEventsForCurrentWindow([original], [fresh]);
  expect(EventSchema.safeParse(hidden).success).toBe(true);
  expect(JSON.stringify(hidden)).not.toMatch(/TEST (historical|private)/);
  expect(hidden!.eventId).toBe(original.eventId);
  expect(hidden!.sequence).toBe(original.sequence);
  if (!hidden || hidden.type !== "work_item.upserted")
    throw Error("projection");
  expect(hidden.entity.revision).toBe(original.entity.revision);
  expect(hidden.entity.status).toBe("succeeded");
  expect(hidden.entity.native!.revision).toBe(original.entity.native!.revision);
  expect(hidden.entity.native!.process!.provenance).toEqual(
    original.entity.native!.process!.provenance,
  );
  expect(hidden.entity.native!.process!.receipts[0]).toMatchObject({
    operationId: "TEST-op",
    effect: "write",
    status: "succeeded",
    summary: "",
  });
  expect(hidden.entity.native!.process!.output).toBeUndefined();
  expect(hidden.entity.native!.process!.outputUnavailable).toBe("context");
  expect(original.entity.card).toBeDefined();
  expect(original.entity.native!.process!.output).toBeDefined();
});
test.each(["missing", "legacy-card", "changed-card"])(
  "%s stored preview cannot authorize its own delivery",
  (kind) => {
    const original = event();
    if (original.type !== "work_item.upserted") throw Error("fixture");
    const fresh = structuredClone(original.entity);
    if (kind === "legacy-card") {
      delete original.entity.native!.process!.output;
      delete original.entity.native!.process!.outputSummary;
    } else fresh.context = "Fresh safe context";
    const delivered = processEventsForCurrentWindow(
      [original],
      kind === "missing" ? [] : [fresh],
    );
    expect(EventSchema.safeParse(delivered[0]).success).toBe(true);
    expect(JSON.stringify(delivered)).not.toMatch(/TEST (historical|private)/);
  },
);
