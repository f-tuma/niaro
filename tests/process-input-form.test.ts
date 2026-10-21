import type { ProcessData } from "../packages/protocol/service-processes";
import { ProcessDefinitionSchema } from "../packages/protocol/service-processes";
import type { ProcessInputCard } from "../packages/protocol/process-execution";
import {
  boundedProcessCard,
  createProcessDraft,
  createProcessDraftFromInput,
  parseProcessInputCard,
  validateProcessDraft,
  type ProcessDraft,
} from "../packages/ui-catalog/process-input-form";
import { processInputCopy } from "../packages/ui-catalog/process-input-copy";

const object = (
  properties: Record<string, ProcessData>,
  required = Object.keys(properties),
): Extract<ProcessData, { type: "object" }> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const form = (schema: ProcessData, values: Record<string, ProcessDraft>) => ({
  kind: "object" as const,
  present: true,
  children: new Map(Object.entries(values)),
});

function card(
  schema: Extract<ProcessData, { type: "object" }>,
): ProcessInputCard {
  const origin = {
    type: "command" as const,
    conversationId: "test-conversation",
    requestId: "test-request",
  };
  return {
    form: {
      profile: "agent-process-input/1",
      name: "TEST form",
      description: "",
      language: "en",
      kind: "workflow",
      scope: {
        connectionId: "test-connection",
        serverId: "test-server",
        userId: "test-user",
        workspaceId: "test-workspace",
      },
      processId: "test-process",
      version: 1,
      artifactDigest: "a".repeat(64),
      inputSchema: schema,
      origin,
    },
    formDigest: "b".repeat(64),
    intent: {
      intentId: "test-intent",
      processId: "test-process",
      version: 1,
      artifactDigest: "a".repeat(64),
      formDigest: "b".repeat(64),
      inputSchema: schema,
      fields: {},
      origin,
      createdAt: "2026-10-05T10:00:00.000Z",
    },
  };
}

test("optional absence differs from empty strings, whitespace, false, null and empty collections", () => {
  const schema = object(
    {
      omitted: { type: "string" },
      empty: { type: "string" },
      whitespace: { type: "string" },
      flag: { type: "boolean" },
      cleared: { type: "null" },
      metadata: object({}),
      tags: { type: "array", items: { type: "string" } },
    },
    [],
  );
  const result = validateProcessDraft(
    schema,
    form(schema, {
      empty: { kind: "string", present: true, value: "" },
      whitespace: { kind: "string", present: true, value: " \t " },
      flag: { kind: "boolean", present: true, value: false },
      cleared: createProcessDraft({ type: "null" }),
      metadata: createProcessDraft(object({})),
      tags: createProcessDraft({ type: "array", items: { type: "string" } }),
    }),
  );
  expect(result).toEqual({
    success: true,
    issues: [],
    input: {
      empty: "",
      whitespace: " \t ",
      flag: false,
      cleared: null,
      metadata: {},
      tags: [],
    },
  });
});

test.each(["room / A", "a:b?c=d", "", "  "])(
  "enum value %j is preserved literally",
  (value) => {
    const schema = object({ choice: { type: "string", enum: [value] } });
    expect(
      validateProcessDraft(
        schema,
        form(schema, { choice: { kind: "string", present: true, value } }),
      ),
    ).toEqual({ success: true, issues: [], input: { choice: value } });
  },
);

test("unset required singleton enums and booleans require explicit selection", () => {
  const schema = object({
    choice: { type: "string", enum: [""] },
    flag: { type: "boolean", enum: [false] },
  });
  expect(validateProcessDraft(schema, createProcessDraft(schema))).toEqual({
    success: false,
    issues: [
      { path: ["choice"], message: "errorRequired" },
      { path: ["flag"], message: "errorRequired" },
    ],
  });
});

test.each([
  ["", "errorRequired"],
  ["  ", "errorRequired"],
  ["Infinity", "errorNumber"],
  ["NaN", "errorNumber"],
  ["0x10", "errorNumber"],
  ["1.5", "errorInteger"],
  ["0", "errorRange"],
  ["6", "errorRange"],
])("integer input %j has a localized error code", (value, message) => {
  const schema = object({ count: { type: "integer", minimum: 1, maximum: 5 } });
  expect(
    validateProcessDraft(
      schema,
      form(schema, { count: { kind: "number", present: true, value } }),
    ),
  ).toEqual({ success: false, issues: [{ path: ["count"], message }] });
});

test("nested object and array values obey their actual schema and preserve order", () => {
  const child = object({ name: { type: "string", minLength: 1 } });
  const schema = object({
    rows: { type: "array", minItems: 1, maxItems: 2, items: child },
    matrix: {
      type: "array",
      items: { type: "array", items: { type: "number" } },
    },
  });
  const row = (value: string): ProcessDraft =>
    form(child, { name: { kind: "string", present: true, value } });
  const draft = form(schema, {
    rows: {
      kind: "array",
      present: true,
      items: [
        { id: "a", draft: row("Ada") },
        { id: "b", draft: row("Bo") },
      ],
    },
    matrix: {
      kind: "array",
      present: true,
      items: [
        {
          id: "c",
          draft: {
            kind: "array",
            present: true,
            items: [
              {
                id: "d",
                draft: { kind: "number", present: true, value: "-2.5e1" },
              },
            ],
          },
        },
      ],
    },
  });
  expect(validateProcessDraft(schema, draft)).toEqual({
    success: true,
    issues: [],
    input: {
      rows: [{ name: "Ada" }, { name: "Bo" }],
      matrix: [[-25]],
    },
  });
});

test("minItems does not preallocate nested arrays or objects", () => {
  let schema: ProcessData = { type: "string" };
  for (let index = 0; index < 5; index++)
    schema = { type: "array", minItems: 100, items: schema };
  const root = object({ nested: schema });
  expect(createProcessDraft(schema)).toEqual({
    kind: "array",
    present: true,
    items: [],
  });
  expect(createProcessDraft(root)).toEqual({
    kind: "object",
    present: true,
    children: new Map(),
  });
  expect(validateProcessDraft(root, createProcessDraft(root))).toEqual({
    success: false,
    issues: [{ path: ["nested"], message: "errorCount" }],
  });
});

test("array contract accepts one hundred entries and rejects the next entry", () => {
  const schema = object({ values: { type: "array", items: { type: "null" } } });
  const entries = Array.from({ length: 100 }, (_, index) => ({
    id: `item-${index}`,
    draft: createProcessDraft({ type: "null" }),
  }));
  expect(
    validateProcessDraft(
      schema,
      form(schema, {
        values: { kind: "array", present: true, items: entries },
      }),
    ).success,
  ).toBe(true);
  expect(
    validateProcessDraft(
      schema,
      form(schema, {
        values: {
          kind: "array",
          present: true,
          items: [...entries, entries[0]!],
        },
      }),
    ),
  ).toEqual({
    success: false,
    issues: [{ path: ["values"], message: "errorCount" }],
  });
});

test("inherited-looking property names are own keys, never prototype data", () => {
  const schema = object({
    toString: { type: "string" as const },
    hasOwnProperty: { type: "boolean" as const },
  });
  const result = validateProcessDraft(
    schema,
    form(schema, {
      toString: { kind: "string" as const, present: true, value: "test" },
      hasOwnProperty: { kind: "boolean" as const, present: true, value: false },
    }),
  );
  expect(result.success).toBe(true);
  if (result.success) {
    expect(Object.keys(result.input)).toEqual(["toString", "hasOwnProperty"]);
    expect(result.input.toString).toBe("test");
    expect(result.input.hasOwnProperty).toBe(false);
  }
});

test("exact complete UTF-8 JSON input size accepts 65536 bytes and rejects one more", () => {
  const properties: Record<string, ProcessData> = {};
  const values: Record<string, ProcessDraft> = {};
  for (let index = 0; index < 16; index++) {
    properties[`f${index}`] = { type: "string" };
    values[`f${index}`] = {
      kind: "string",
      present: true,
      value: "é".repeat(2000),
    };
  }
  properties.tail = { type: "string" };
  values.tail = { kind: "string", present: true, value: "" };
  const base = Object.fromEntries(
    Object.entries(values).map(([key, node]) => [
      key,
      node.kind === "string" ? node.value : "",
    ]),
  );
  const tailLength = 65536 - Buffer.byteLength(JSON.stringify(base));
  values.tail = {
    kind: "string",
    present: true,
    value: "a".repeat(tailLength),
  };
  const schema = object(properties);
  const accepted = validateProcessDraft(schema, form(schema, values));
  expect(accepted.success).toBe(true);
  if (accepted.success)
    expect(Buffer.byteLength(JSON.stringify(accepted.input))).toBe(65536);
  values.tail = {
    kind: "string",
    present: true,
    value: "a".repeat(tailLength + 1),
  };
  expect(validateProcessDraft(schema, form(schema, values))).toEqual({
    success: false,
    issues: [{ path: [], message: "errorSize" }],
  });
});

test("card guard rejects accessors, symbols, cycles, sparse arrays and nonplain objects without evaluating accessors", () => {
  const getter = jest.fn(() => "test");
  const accessor = Object.defineProperty({}, "value", {
    enumerable: true,
    get: getter,
  });
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  for (const raw of [
    accessor,
    { [Symbol("test")]: true },
    cyclic,
    new Date(),
    new Map(),
    Array(1),
    Object.create({ inherited: true }),
  ]) {
    expect(boundedProcessCard(raw)).toBe(false);
    expect(parseProcessInputCard(raw)).toBeNull();
  }
  expect(getter).not.toHaveBeenCalled();
});

test("card guard bounds depth and node counts before recursive parsers", () => {
  let depth: unknown = null;
  for (let index = 0; index < 25; index++) depth = { child: depth };
  expect(boundedProcessCard(depth)).toBe(false);
  expect(parseProcessInputCard(depth)).toBeNull();
  expect(boundedProcessCard(Array.from({ length: 32768 }, () => null))).toBe(
    false,
  );
  expect(boundedProcessCard(Array.from({ length: 32767 }, () => null))).toBe(
    true,
  );
});

test("repeated immutable schema references and null-prototype own properties remain supported", () => {
  const shared = object({ field: { type: "string" } });
  expect(boundedProcessCard({ schema: shared, repeated: shared })).toBe(true);
  const own = Object.create(null) as Record<string, unknown>;
  Object.assign(own, { toString: "value" });
  expect(boundedProcessCard(own)).toBe(true);
});

test("a valid large form with 1200 leaves survives the pre-parser budget", () => {
  const properties: Record<string, ProcessData> = Object.fromEntries(
    Array.from({ length: 40 }, (_, index) => [
      `field${index}`,
      { type: "string" },
    ]),
  );
  const groups = Object.fromEntries(
    Array.from({ length: 30 }, (_, index) => [
      `group${index}`,
      object(properties),
    ]),
  );
  const raw = card(object(groups));
  expect(boundedProcessCard(raw)).toBe(true);
  expect(parseProcessInputCard(raw)?.form.inputSchema).toEqual(
    raw.form.inputSchema,
  );
});

test("maximum supported schema nesting remains below the guard depth budget", () => {
  let child: ProcessData = { type: "string" };
  for (let index = 0; index < 5; index++) child = object({ nested: child });
  expect(parseProcessInputCard(card(object({ root: child })))).not.toBeNull();
});

test("a registry-size-boundary definition's repeated input schema passes the card guard", () => {
  const fields: Record<string, ProcessData> = Object.fromEntries(
    Array.from({ length: 40 }, (_, index) => [
      `field${index}`,
      { type: "string" },
    ]),
  );
  const groups: Record<string, ProcessData> = Object.fromEntries(
    Array.from({ length: 39 }, (_, index) => [`group${index}`, object(fields)]),
  );
  groups.last = object(Object.fromEntries(Object.entries(fields).slice(0, 17)));
  const inputSchema = object(groups);
  const definition = {
    schemaVersion: 1,
    name: "TEST bounded",
    description: "",
    trigger: "manual",
    kind: "workflow",
    inputSchema,
    outputSchema: object({}),
    entry: "finish",
    steps: [{ id: "finish", type: "return", output: {} }],
    limits: {
      maxSteps: 1,
      maxModelCalls: 0,
      maxTokens: 1,
      maxCostMicros: 1,
      maxDurationMs: 1,
    },
  };
  // Match the registry's whole-definition node and UTF-8 key/string budgets.
  const pending: unknown[] = [definition];
  let nodes = 0,
    bytes = 0;
  while (pending.length) {
    const value = pending.pop();
    nodes++;
    if (typeof value === "string") bytes += Buffer.byteLength(value);
    if (value && typeof value === "object")
      for (const [key, child] of Object.entries(value)) {
        bytes += Buffer.byteLength(key);
        pending.push(child);
      }
  }
  expect(nodes).toBe(4999);
  expect(bytes).toBeLessThanOrEqual(65536);
  expect(ProcessDefinitionSchema.safeParse(definition).success).toBe(true);
  const raw = card(inputSchema);
  expect(boundedProcessCard(raw)).toBe(true);
  expect(parseProcessInputCard(raw)).not.toBeNull();
});

test("EN and CS error and control text is available without borrowing schema values", () => {
  for (const language of ["en", "cs"] as const) {
    expect(
      processInputCopy(language, "include", { field: "toString" }),
    ).toContain("toString");
    expect(processInputCopy(language, "errorSize")).toContain("64 KB");
    expect(processInputCopy(language, "errorInteger")).toBeTruthy();
  }
  expect(processInputCopy("cs", "prepare")).toBe("Zkontrolovat");
});

test("restored typed draft preserves absence, null, falsy values, strings, arrays and unique item identities", () => {
  const schema = object(
    {
      omitted: { type: "string" },
      text: { type: "string", enum: ["", "  ", "TEST"] },
      count: { type: "integer" },
      flag: { type: "boolean" },
      nil: { type: "null" },
      empty: object({}),
      rows: {
        type: "array",
        items: object({
          text: { type: "string" },
          flags: { type: "array", items: { type: "boolean" } },
        }),
      },
    },
    ["text", "count", "flag", "nil", "empty", "rows"],
  );
  const input = {
    text: "  ",
    count: 0,
    flag: false,
    nil: null,
    empty: {},
    rows: [
      { text: "", flags: [false, true] },
      { text: " last ", flags: [] },
    ],
  };
  let next = 0;
  const draft = createProcessDraftFromInput(
    schema,
    input,
    () => `TEST-${next++}`,
  )!;
  expect(validateProcessDraft(schema, draft)).toEqual({
    success: true,
    input,
    issues: [],
  });
  expect(draft.kind).toBe("object");
  if (draft.kind !== "object") throw Error("TEST object expected");
  expect(draft.children.get("omitted")?.present).toBe(false);
  const rows = draft.children.get("rows")!;
  if (rows.kind !== "array") throw Error("TEST array expected");
  expect(rows.items.map((item) => item.id)).toEqual(["TEST-0", "TEST-3"]);
  expect(next).toBe(4);
  expect(
    createProcessDraftFromInput(schema, { ...input, count: "0" }, () => "TEST"),
  ).toBeNull();
  expect(
    createProcessDraftFromInput(
      schema,
      { ...input, extra: "TEST" },
      () => "TEST",
    ),
  ).toBeNull();
  let reads = 0;
  const accessor = Object.defineProperty({}, "text", {
    enumerable: true,
    get: () => {
      reads++;
      return "TEST";
    },
  });
  expect(
    createProcessDraftFromInput(schema, accessor, () => "TEST"),
  ).toBeNull();
  expect(reads).toBe(0);
});

test("partial restored input leaves required fields editable and optional fields omitted", () => {
  const schema = object(
    {
      transcript: { type: "string" },
      recipient: { type: "string", minLength: 1 },
      optionalNote: { type: "string" },
    },
    ["transcript", "recipient"],
  );
  const draft = createProcessDraftFromInput(
    schema,
    { transcript: "Complete meeting transcript" },
    () => "TEST",
    true,
  )!;
  expect(draft.kind).toBe("object");
  if (draft.kind !== "object") throw Error("TEST object expected");
  expect(draft.children.get("transcript")).toMatchObject({
    kind: "string",
    present: true,
    value: "Complete meeting transcript",
  });
  expect(draft.children.get("recipient")).toMatchObject({
    kind: "string",
    present: true,
    value: "",
  });
  expect(draft.children.get("optionalNote")).toMatchObject({
    kind: "string",
    present: false,
    value: "",
  });
  expect(validateProcessDraft(schema, draft)).toMatchObject({
    success: false,
    issues: [{ path: ["recipient"], message: "errorLength" }],
  });
});
