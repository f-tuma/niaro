import { processOfferInitialInput } from "../packages/protocol/process-offer-input";
import { meetingProcessValueFitsInput } from "../packages/protocol/meeting-process-input";
import type { ProcessData } from "../packages/protocol/service-processes";

const schema = {
  type: "object",
  properties: { topic: { type: "string", maxLength: 200 } },
  required: [],
  additionalProperties: false,
} as unknown as ProcessData;

test("model-suggested field names match only the schema's own fields", () => {
  for (const field of [
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
  ])
    expect(meetingProcessValueFitsInput(field, "TEST", schema)).toBe(false);
  const raw = JSON.parse(
    '{"topic":"TEST topic","__proto__":{"polluted":true},"constructor":"x"}',
  ) as Record<string, unknown>;
  const values = processOfferInitialInput(raw, schema);
  expect(values).toEqual({ topic: "TEST topic" });
  expect(Object.getPrototypeOf(values)).toBe(Object.prototype);
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
});
