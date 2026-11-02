import {
  processEarlierInputDraft,
  validateProcessDraft,
} from "../packages/ui-catalog/process-input-form";
import type { ProcessData } from "../packages/protocol/service-processes";

let item = 0;
const itemId = () => `item-${item++}`;
const schema: ProcessData = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    count: { type: "integer", minimum: 1 },
    note: { type: "string" },
  },
  required: ["name", "count"],
  additionalProperties: false,
};

test("earlier input that still fits fills the current form without issues", () => {
  const { draft, issues } = processEarlierInputDraft(
    schema,
    { name: "TEST name", count: 2 },
    itemId,
  );
  expect(issues).toEqual([]);
  expect(validateProcessDraft(schema, draft!)).toEqual({
    success: true,
    input: { name: "TEST name", count: 2 },
    issues: [],
  });
});

test("a changed schema shows field errors at once and the draft can't be sent as it is", () => {
  const { draft, issues } = processEarlierInputDraft(
    schema,
    // count was text before; "region" is a field the form no longer has.
    { name: "TEST name", count: "three", region: "TEST north" },
    itemId,
  );
  expect(issues).toEqual([
    { path: ["count"], message: "errorChanged" },
    { path: [], message: "errorDropped" },
  ]);
  // The value that no longer fits is left empty, so Review refuses it.
  expect(validateProcessDraft(schema, draft!).success).toBe(false);
});

test("a new required field without an earlier value is flagged, too", () => {
  const { issues } = processEarlierInputDraft(schema, { count: 1 }, itemId);
  // The shared validator's own message for an empty required text.
  expect(issues).toEqual([{ path: ["name"], message: "errorLength" }]);
});
