import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ProcessInputCard } from "../packages/protocol/process-execution";
import type { ProcessData } from "../packages/protocol/service-processes";
import { ProcessInputCardView } from "../packages/ui-catalog/ProcessInputCardView";
import { processInputCopy as copy } from "../packages/ui-catalog/process-input-copy";

const object = (
  properties: Record<string, ProcessData>,
  required = Object.keys(properties),
): Extract<ProcessData, { type: "object" }> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
function card(
  schema: Extract<ProcessData, { type: "object" }>,
  version = 1,
): ProcessInputCard {
  const origin = {
    type: "command" as const,
    conversationId: "test-conversation",
    requestId: "test-request",
  };
  const formDigest = String(version).repeat(64);
  return {
    form: {
      profile: "agent-process-input/1",
      scope: {
        connectionId: "test-connection",
        serverId: "test-server",
        userId: "test-user",
        workspaceId: "test-workspace",
      },
      language: "en",
      name: "TEST inputs",
      description: "TEST local form",
      kind: "workflow",
      processId: "test-process",
      version,
      artifactDigest: "a".repeat(64),
      inputSchema: schema,
      origin,
    },
    formDigest,
    intent: {
      intentId: `test-intent-${version}`,
      processId: "test-process",
      version,
      artifactDigest: "a".repeat(64),
      formDigest,
      inputSchema: schema,
      fields: {},
      origin,
      createdAt: "2026-10-05T10:00:00.000Z",
    },
  };
}
const prepare = (language: "en" | "cs" = "en") =>
  fireEvent.press(
    screen.getByRole("button", { name: copy(language, "prepare") }),
  );
const include = (field: string, language: "en" | "cs" = "en") =>
  fireEvent.press(
    screen.getByRole("checkbox", {
      name: copy(language, "include", { field }),
    }),
  );
const add = (field: string, language: "en" | "cs" = "en") =>
  fireEvent.press(
    screen.getByRole("button", { name: copy(language, "add", { field }) }),
  );
const expand = (field: string, language: "en" | "cs" = "en") =>
  fireEvent.press(
    screen.getByRole("button", { name: copy(language, "edit", { field }) }),
  );

test("render, edit and expansion are passive; explicit prepare calls only the local typed callback", () => {
  const fetch = jest.spyOn(globalThis, "fetch");
  const onSubmit = jest.fn();
  render(
    <ProcessInputCardView
      language="en"
      onSubmit={onSubmit}
      card={card(
        object({
          title: { type: "string", minLength: 1 },
          details: object({ count: { type: "integer", minimum: 1 } }),
        }),
      )}
    />,
  );
  expect(screen.queryByLabelText("details › count")).toBeNull();
  expand("details");
  fireEvent.changeText(screen.getByLabelText("title"), "TEST review");
  fireEvent.changeText(screen.getByLabelText("details › count"), "3");
  expect(onSubmit).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  prepare();
  expect(onSubmit.mock.calls).toEqual([
    [{ title: "TEST review", details: { count: 3 } }],
  ]);
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockRestore();
});

test.each(["en", "cs"] as const)(
  "%s scalar fields show a single annotated label and keep literal accessibility paths",
  (language) => {
    render(
      <ProcessInputCardView
        language={language}
        onSubmit={() => {}}
        card={card(
          object(
            {
              title: { type: "string" },
              duration: { type: "integer" },
              note: { type: "string" },
            },
            ["title", "duration"],
          ),
        )}
      />,
    );
    for (const field of ["title", "duration"]) {
      expect(
        screen.getAllByText(`${field} · ${copy(language, "required")}`),
      ).toHaveLength(1);
      expect(screen.queryByText(field)).toBeNull();
      expect(screen.getByLabelText(field).props.accessibilityLabel).toBe(field);
    }
    expect(
      screen.getAllByText(`note · ${copy(language, "optional")}`),
    ).toHaveLength(1);
    expect(screen.queryByLabelText("note")).toBeNull();
    expect(
      screen.getByRole("checkbox", {
        name: copy(language, "include", { field: "note" }),
      }),
    ).toBeTruthy();
    expect(screen.getByText(copy(language, "omitted"))).toBeTruthy();
    include("note", language);
    expect(
      screen.getAllByText(`note · ${copy(language, "optional")}`),
    ).toHaveLength(1);
    expect(screen.queryByText("note")).toBeNull();
    expect(screen.getByLabelText("note").props.accessibilityLabel).toBe("note");
    expect(screen.queryByText(copy(language, "omitted"))).toBeNull();
  },
);

test("a configured long text field keeps the complete transcript editable and submittable", () => {
  const transcript = "úplný přepis schůzky ".repeat(600);
  const onSubmit = jest.fn();
  render(
    <ProcessInputCardView
      language="cs"
      card={card(
        object({
          transcript: { type: "string", maxLength: 60_000 },
        }),
      )}
      initialInput={{ transcript }}
      onSubmit={onSubmit}
    />,
  );
  const field = screen.getByLabelText("transcript");
  expect(field.props.value).toBe(transcript);
  expect(field.props.maxLength).toBe(60_000);
  expect(field.props.multiline).toBe(true);
  prepare("cs");
  expect(onSubmit).toHaveBeenCalledWith({ transcript });
});

test("meeting prefill keeps unmapped required fields editable and optional fields omitted", () => {
  const onSubmit = jest.fn();
  render(
    <ProcessInputCardView
      language="en"
      card={card(
        object(
          {
            transcript: { type: "string", maxLength: 60_000 },
            recipient: { type: "string", minLength: 1 },
            note: { type: "string" },
          },
          ["transcript", "recipient"],
        ),
      )}
      initialInput={{ transcript: "Full meeting transcript" }}
      onSubmit={onSubmit}
    />,
  );
  expect(screen.getByLabelText("transcript").props.value).toBe(
    "Full meeting transcript",
  );
  expect(screen.getByLabelText("recipient").props.value).toBe("");
  expect(screen.queryByLabelText("note")).toBeNull();
  prepare();
  expect(
    screen.getByText(`recipient: ${copy("en", "errorLength")}`),
  ).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText("recipient"), "Ada");
  prepare();
  expect(onSubmit).toHaveBeenCalledWith({
    transcript: "Full meeting transcript",
    recipient: "Ada",
  });
});

test.each(["en", "cs"] as const)(
  "%s optional controls preserve absent, empty, whitespace, false and explicit null",
  (language) => {
    const onSubmit = jest.fn();
    render(
      <ProcessInputCardView
        language={language}
        onSubmit={onSubmit}
        card={card(
          object(
            {
              absent: { type: "string" },
              empty: { type: "string" },
              spaces: { type: "string" },
              flag: { type: "boolean" },
              cleared: { type: "null" },
              metadata: object({}),
              rows: { type: "array", items: { type: "string" } },
            },
            [],
          ),
        )}
      />,
    );
    expect(screen.queryByLabelText("empty")).toBeNull();
    for (const field of [
      "empty",
      "spaces",
      "flag",
      "cleared",
      "metadata",
      "rows",
    ])
      include(field, language);
    fireEvent.changeText(screen.getByLabelText("spaces"), " \t ");
    fireEvent.press(
      screen.getByRole("radio", { name: `flag: ${copy(language, "no")}` }),
    );
    expect(screen.getByText(copy(language, "nullHint"))).toBeTruthy();
    prepare(language);
    expect(onSubmit.mock.calls).toEqual([
      [
        {
          empty: "",
          spaces: " \t ",
          flag: false,
          cleared: null,
          metadata: {},
          rows: [],
        },
      ],
    ]);
    include("empty", language);
    prepare(language);
    expect(Object.hasOwn(onSubmit.mock.calls[1]![0], "empty")).toBe(false);
  },
);

test("arbitrary string enum values, empty singleton and false singleton use literal values", () => {
  const onSubmit = jest.fn();
  render(
    <ProcessInputCardView
      language="en"
      onSubmit={onSubmit}
      card={card(
        object({
          choice: { type: "string", enum: ["room / A", "id:one?two=3"] },
          fixed: { type: "string", enum: [""] },
          flag: { type: "boolean", enum: [false] },
        }),
      )}
    />,
  );
  prepare();
  expect(onSubmit).not.toHaveBeenCalled();
  expect(screen.getAllByText(copy("en", "errorRequired"))).toHaveLength(3);
  fireEvent.press(screen.getByRole("radio", { name: "choice: id:one?two=3" }));
  fireEvent.press(screen.getByRole("radio", { name: "fixed: Empty string" }));
  fireEvent.press(screen.getByRole("radio", { name: "flag: False" }));
  prepare();
  expect(onSubmit.mock.calls).toEqual([
    [{ choice: "id:one?two=3", fixed: "", flag: false }],
  ]);
});

test.each(["en", "cs"] as const)(
  "%s numeric integer and range errors prevent typed handoff",
  (language) => {
    const onSubmit = jest.fn();
    render(
      <ProcessInputCardView
        language={language}
        onSubmit={onSubmit}
        card={card(
          object({
            count: { type: "integer", minimum: 1, maximum: 5 },
            ratio: { type: "number", minimum: -1, maximum: 1 },
          }),
        )}
      />,
    );
    fireEvent.changeText(screen.getByLabelText("count"), "1.5");
    fireEvent.changeText(screen.getByLabelText("ratio"), "2");
    prepare(language);
    expect(screen.getByText(copy(language, "errorInteger"))).toBeTruthy();
    expect(screen.getByText(copy(language, "errorRange"))).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.changeText(screen.getByLabelText("count"), "2");
    fireEvent.changeText(screen.getByLabelText("ratio"), "-.25");
    prepare(language);
    expect(onSubmit.mock.calls).toEqual([[{ count: 2, ratio: -0.25 }]]);
  },
);

test("arrays of objects retain stable item identities and drafts after removing a sibling", () => {
  const onSubmit = jest.fn();
  render(
    <ProcessInputCardView
      language="en"
      onSubmit={onSubmit}
      card={card(
        object({
          rows: {
            type: "array",
            minItems: 1,
            maxItems: 2,
            items: object({ name: { type: "string", minLength: 1 } }),
          },
        }),
      )}
    />,
  );
  prepare();
  expect(screen.getByText(copy("en", "errorCount"))).toBeTruthy();
  expect(screen.queryByTestId("process-item-0")).toBeNull();
  add("rows");
  add("rows");
  expand("rows › Item 1");
  expand("rows › Item 2");
  fireEvent.changeText(screen.getByLabelText("rows › Item 1 › name"), "Ada");
  fireEvent.changeText(screen.getByLabelText("rows › Item 2 › name"), "Bo");
  expect(
    screen.getByRole("button", { name: "Add item to rows" }).props
      .accessibilityState.disabled,
  ).toBe(true);
  fireEvent.press(screen.getByRole("button", { name: "Remove rows › Item 1" }));
  expect(screen.queryByTestId("process-item-0")).toBeNull();
  expect(screen.getByTestId("process-item-1")).toBeTruthy();
  expect(screen.getByLabelText("rows › Item 1 › name").props.value).toBe("Bo");
  prepare();
  expect(onSubmit.mock.calls).toEqual([[{ rows: [{ name: "Bo" }] }]]);
  fireEvent.press(screen.getByRole("button", { name: "Remove rows › Item 1" }));
  prepare();
  expect(screen.getByText(copy("en", "errorCount"))).toBeTruthy();
  expect(onSubmit).toHaveBeenCalledTimes(1);
});

test("arrays of arrays add only explicitly requested elements", () => {
  const onSubmit = jest.fn();
  render(
    <ProcessInputCardView
      language="en"
      onSubmit={onSubmit}
      card={card(
        object({
          matrix: {
            type: "array",
            minItems: 1,
            maxItems: 2,
            items: { type: "array", maxItems: 2, items: { type: "integer" } },
          },
        }),
      )}
    />,
  );
  add("matrix");
  expect(screen.queryByLabelText("matrix › Item 1 › Item 1")).toBeNull();
  add("matrix › Item 1");
  fireEvent.changeText(screen.getByLabelText("matrix › Item 1 › Item 1"), "7");
  prepare();
  expect(onSubmit.mock.calls).toEqual([[{ matrix: [[7]] }]]);
});

test("adding an item does not allocate its nested minItems tree", () => {
  const onSubmit = jest.fn();
  render(
    <ProcessInputCardView
      language="en"
      onSubmit={onSubmit}
      card={card(
        object({
          rows: {
            type: "array",
            items: {
              type: "array",
              minItems: 100,
              items: {
                type: "array",
                minItems: 100,
                items: { type: "string" },
              },
            },
          },
        }),
      )}
    />,
  );
  add("rows");
  expect(screen.getAllByTestId(/^process-item-/)).toHaveLength(1);
  expect(screen.queryByLabelText("rows › Item 1 › Item 1 › Item 1")).toBeNull();
  prepare();
  expect(onSubmit).not.toHaveBeenCalled();
  expect(screen.getByText(copy("en", "errorCount"))).toBeTruthy();
});

test("large nested forms expose every root group and lazily render the opened group's leaves", () => {
  const fields: Record<string, ProcessData> = Object.fromEntries(
    Array.from({ length: 40 }, (_, index) => [
      `field${index}`,
      { type: "string" },
    ]),
  );
  const groups = Object.fromEntries(
    Array.from({ length: 30 }, (_, index) => [`group${index}`, object(fields)]),
  );
  render(
    <ProcessInputCardView
      language="en"
      onSubmit={() => {}}
      card={card(object(groups))}
    />,
  );
  expect(screen.getAllByRole("button", { name: /^Edit group/ })).toHaveLength(
    30,
  );
  expect(screen.queryByLabelText("group0 › field0")).toBeNull();
  expand("group29");
  expect(screen.getByLabelText("group29 › field39")).toBeTruthy();
  expect(screen.queryByLabelText("group0 › field0")).toBeNull();
});

test("empty root objects, required empty objects and zero-length arrays remain representable", () => {
  const onSubmit = jest.fn();
  const view = render(
    <ProcessInputCardView
      language="en"
      onSubmit={onSubmit}
      card={card(object({}))}
    />,
  );
  prepare();
  expect(onSubmit).toHaveBeenLastCalledWith({});
  view.rerender(
    <ProcessInputCardView
      language="en"
      onSubmit={onSubmit}
      card={card(
        object({
          empty: object({}),
          rows: { type: "array", maxItems: 0, items: { type: "string" } },
        }),
        2,
      )}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Add item to rows" }).props
      .accessibilityState.disabled,
  ).toBe(true);
  prepare();
  expect(onSubmit).toHaveBeenLastCalledWith({ empty: {}, rows: [] });
});

test("more than twelve leaves and inherited-looking field keys render and submit", () => {
  const onSubmit = jest.fn();
  const properties: Record<string, ProcessData> = Object.fromEntries(
    Array.from({ length: 16 }, (_, index) => [
      `field${index}`,
      { type: "string" },
    ]),
  );
  Object.assign(properties, { toString: { type: "string" as const } });
  render(
    <ProcessInputCardView
      language="en"
      onSubmit={onSubmit}
      card={card(object(properties))}
    />,
  );
  for (let index = 0; index < 16; index++)
    fireEvent.changeText(
      screen.getByLabelText(`field${index}`),
      `TEST ${index}`,
    );
  fireEvent.changeText(screen.getByLabelText("toString"), "own value");
  prepare();
  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(Object.keys(onSubmit.mock.calls[0]![0])).toHaveLength(17);
  expect(onSubmit.mock.calls[0]![0].toString).toBe("own value");
});

test.each(["version", "scope", "intent", "schema", "origin", "digest"])(
  "changed immutable %s binding resets draft",
  (change) => {
    const onSubmit = jest.fn();
    const current = card(object({ title: { type: "string" } }));
    const view = render(
      <ProcessInputCardView language="en" onSubmit={onSubmit} card={current} />,
    );
    fireEvent.changeText(screen.getByLabelText("title"), "old local value");
    const next = structuredClone(current);
    if (change === "version") {
      next.form.version = 2;
      next.intent.version = 2;
    }
    if (change === "scope") next.form.scope.workspaceId = "another-workspace";
    if (change === "intent") next.intent.intentId = "another-intent";
    if (change === "schema") {
      next.form.inputSchema = object({
        title: { type: "string", maxLength: 20 },
      });
      next.intent.inputSchema = next.form.inputSchema;
    }
    if (change === "origin") {
      next.form.origin = {
        type: "command",
        conversationId: "another-conversation",
        requestId: "another-request",
      };
      next.intent.origin = next.form.origin;
    }
    if (change === "digest") {
      next.formDigest = "b".repeat(64);
      next.intent.formDigest = next.formDigest;
    }
    view.rerender(
      <ProcessInputCardView language="en" onSubmit={onSubmit} card={next} />,
    );
    expect(screen.getByLabelText("title").props.value).toBe("");
    expect(screen.getByText(copy("en", "updated"))).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  },
);

test("equivalent replay preserves local drafts without producing a callback", () => {
  const onSubmit = jest.fn();
  const current = card(object({ title: { type: "string" } }));
  const view = render(
    <ProcessInputCardView language="en" onSubmit={onSubmit} card={current} />,
  );
  fireEvent.changeText(screen.getByLabelText("title"), "retained");
  view.rerender(
    <ProcessInputCardView
      language="en"
      onSubmit={onSubmit}
      card={structuredClone(current)}
    />,
  );
  expect(screen.getByLabelText("title").props.value).toBe("retained");
  expect(screen.queryByText(copy("en", "updated"))).toBeNull();
  expect(onSubmit).not.toHaveBeenCalled();
});

test.each(["disabled", "missing coordinator"])(
  "%s disables data controls and local prepare",
  (mode) => {
    const onSubmit = jest.fn();
    render(
      <ProcessInputCardView
        language="en"
        onSubmit={mode === "disabled" ? onSubmit : undefined}
        disabled={mode === "disabled"}
        card={card(
          object(
            {
              name: { type: "string" },
              flag: { type: "boolean" },
              note: { type: "string" },
              rows: { type: "array", items: { type: "string" } },
            },
            ["name", "flag", "rows"],
          ),
        )}
      />,
    );
    expect(screen.getByLabelText("name").props.editable).toBe(false);
    expect(
      screen.getByRole("radio", { name: "flag: False" }).props
        .accessibilityState.disabled,
    ).toBe(true);
    expect(
      screen.getByRole("checkbox", { name: "Include note" }).props
        .accessibilityState.disabled,
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: copy("en", "prepare") }).props
        .accessibilityState.disabled,
    ).toBe(true);
    fireEvent.changeText(screen.getByLabelText("name"), "ignored");
    prepare();
    expect(screen.getByLabelText("name").props.value).toBe("");
    expect(onSubmit).not.toHaveBeenCalled();
  },
);

test.each(["en", "cs"] as const)(
  "%s malformed binding falls back without any controls",
  (language) => {
    const onSubmit = jest.fn();
    const current = card(object({ name: { type: "string" } }));
    render(
      <ProcessInputCardView
        language={language}
        onSubmit={onSubmit}
        card={{ ...current, formDigest: "b".repeat(64) }}
      />,
    );
    expect(screen.getByText(copy(language, "unavailable"))).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  },
);

test("a hostile accessor never executes during rendering", () => {
  const getter = jest.fn(() => card(object({})));
  const hostile = Object.defineProperty({}, "form", {
    enumerable: true,
    get: getter,
  });
  render(
    <ProcessInputCardView language="en" card={hostile as ProcessInputCard} />,
  );
  expect(screen.getByText(copy("en", "unavailable"))).toBeTruthy();
  expect(getter).not.toHaveBeenCalled();
});

test("invalid original submitted input fails closed without a blank editable replacement", () => {
  const onSubmit = jest.fn();
  render(
    <ProcessInputCardView
      language="en"
      card={card(object({ name: { type: "string" } }))}
      initialInput={{ name: false }}
      onSubmit={onSubmit}
    />,
  );
  expect(screen.getByText(copy("en", "unavailable"))).toBeTruthy();
  expect(screen.queryByLabelText("name")).toBeNull();
  expect(
    screen.queryByRole("button", { name: copy("en", "prepare") }),
  ).toBeNull();
  expect(onSubmit).not.toHaveBeenCalled();
});
