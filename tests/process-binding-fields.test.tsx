import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import {
  ProcessBindingFields,
  type ProcessBindingFieldsProps,
} from "../apps/server-admin/web/process-binding-fields";
import { editorEn } from "../apps/server-admin/web/process-editor-copy";
import type {
  ProcessData,
  ProcessStep,
} from "../packages/protocol/service-processes";

jest.mock(
  "@admin/components/ui/button",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    return {
      Button: (props: React.ComponentProps<"button">) =>
        React.createElement("button", props),
    };
  },
  { virtual: true },
);

jest.mock(
  "@admin/components/ui/input",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    return {
      Input: (props: React.ComponentProps<"input">) =>
        React.createElement("input", props),
    };
  },
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/field",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    const host = (type: string) => {
      function Host(props: Record<string, unknown>) {
        return React.createElement(type, props);
      }
      return Host;
    };
    return {
      Field: host("div"),
      FieldGroup: host("div"),
      FieldSet: host("fieldset"),
      FieldLegend: host("legend"),
      FieldLabel: host("label"),
      FieldDescription: host("p"),
    };
  },
  { virtual: true },
);
jest.mock(
  "@admin/components/ui/select",
  () => {
    const React = jest.requireActual<typeof import("react")>("react");
    const host = ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children);
    return {
      Select: ({
        value,
        disabled,
        onValueChange,
        children,
      }: {
        value: string;
        disabled: boolean;
        onValueChange(value: string): void;
        children: React.ReactNode;
      }) =>
        React.createElement(
          "select",
          {
            value,
            disabled,
            onChange: (event: { target: { value: string } }) =>
              onValueChange(event.target.value),
          },
          children,
        ),
      SelectTrigger: host,
      SelectValue: host,
      SelectContent: host,
      SelectGroup: host,
      SelectItem: ({
        value,
        disabled,
        children,
      }: {
        value: string;
        disabled?: boolean;
        children: React.ReactNode;
      }) => React.createElement("option", { value, disabled }, children),
    };
  },
  { virtual: true },
);

const object = (
  properties: Record<string, ProcessData>,
): Extract<ProcessData, { type: "object" }> => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const schema = object({
  person: object({ name: { type: "string" } }),
  tags: { type: "array", items: { type: "string" } },
});
const steps: ProcessStep[] = [
  {
    id: "lookup",
    type: "action",
    serviceId: "TEST-service",
    actionId: "TEST-action",
    input: {},
    outputSchema: object({ label: { type: "string" } }),
    next: "finish",
  },
  { id: "finish", type: "return", output: {} },
];
const copy = {
  ...editorEn,
  bindingSource: "Source",
  inputSource: "Process input",
  literalSource: "Literal",
  unsetSource: "Unset",
  path: "Path",
  wholeValue: "Whole value",
  literalType: "Literal type",
  value: "Value",
  string: "Text",
  number: "Number",
  boolean: "Boolean",
  null: "Null",
  true: "True",
  false: "False",
};
function fixture(overrides: Partial<ProcessBindingFieldsProps> = {}) {
  const props: ProcessBindingFieldsProps = {
    bindings: { value: { source: "input", path: ["person", "name"] } },
    fields: ["value"],
    inputSchema: schema,
    steps,
    disabled: false,
    copy,
    onChange: jest.fn(),
    ...overrides,
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<ProcessBindingFields {...props} />);
  });
  const row = (key = "value") =>
    renderer.root.findByProps({ "data-binding-field": key });
  const update = (next: Partial<ProcessBindingFieldsProps>) =>
    act(() => {
      Object.assign(props, next);
      renderer.update(<ProcessBindingFields {...props} />);
    });
  return { props, renderer, row, update };
}

test("binding paths include whole and nested declared objects without inventing array indexes", () => {
  const f = fixture();
  const path = f.row().findAllByType("select")[1]!;
  expect(
    path.findAllByType("option").map((option) => option.props.value),
  ).toEqual(["[]", '["person"]', '["person","name"]', '["tags"]']);
  act(() => path.props.onChange({ target: { value: '["person"]' } }));
  expect(f.props.onChange).toHaveBeenLastCalledWith({
    value: { source: "input", path: ["person"] },
  });
  act(() => path.props.onChange({ target: { value: '["tags","0"]' } }));
  expect(f.props.onChange).toHaveBeenCalledTimes(1);
});

test("missing source/path and omitted destination keys stay visible and unchanged", () => {
  const bindings: ProcessBindingFieldsProps["bindings"] = {
    value: { source: "step", stepId: "missing", path: ["private"] },
    prior: { source: "input", path: ["absent"] },
  };
  const f = fixture({ bindings });
  const missingSource = f
    .row()
    .findAllByType("option")
    .find((option) => option.props.value === "step:missing")!;
  expect(missingSource.props.disabled).toBe(true);
  expect(f.row().findAllByType("select")[1]!.props.disabled).toBe(true);
  expect(
    f
      .row("prior")
      .findAllByType("option")
      .find((option) => option.props.value === '["absent"]')!.props.disabled,
  ).toBe(true);
  expect(f.props.onChange).not.toHaveBeenCalled();
  const source = f.row().findAllByType("select")[0]!;
  act(() => source.props.onChange({ target: { value: "step:lookup" } }));
  expect(f.props.onChange).toHaveBeenLastCalledWith({
    ...bindings,
    value: { source: "step", stepId: "lookup", path: [] },
  });
});

test("controlled invalid numeric text survives reopening and commits only finite numeric values", () => {
  const onDraft = jest.fn(),
    onInvalid = jest.fn();
  const f = fixture({
    bindings: { value: { source: "literal", value: 1 } },
    drafts: { value: "1e" },
    onDraft,
    onInvalid,
  });
  expect(f.row().findByType("input").props.value).toBe("1e");
  expect(f.row().findByType("input").props["aria-invalid"]).toBe(true);
  expect(onInvalid).toHaveBeenLastCalledWith(true);
  for (const value of ["", "-", "1e", "Infinity", "0x10", "NaN"]) {
    act(() =>
      f.row().findByType("input").props.onChange({ target: { value } }),
    );
    expect(onDraft).toHaveBeenLastCalledWith("value", value);
  }
  expect(f.props.onChange).not.toHaveBeenCalled();
  act(() =>
    f
      .row()
      .findByType("input")
      .props.onChange({ target: { value: "1e2" } }),
  );
  expect(onDraft).toHaveBeenLastCalledWith("value", null);
  expect(f.props.onChange).toHaveBeenLastCalledWith({
    value: { source: "literal", value: 100 },
  });
  f.update({
    bindings: { value: { source: "literal", value: 100 } },
    drafts: {},
  });
  expect(onInvalid).toHaveBeenLastCalledWith(false);
});

test("uncontrolled invalid drafts stay local and a disabled inspector cannot mutate bindings", () => {
  const f = fixture({ bindings: { value: { source: "literal", value: 1 } } });
  act(() =>
    f
      .row()
      .findByType("input")
      .props.onChange({ target: { value: "-" } }),
  );
  expect(f.row().findByType("input").props.value).toBe("-");
  expect(f.props.onChange).not.toHaveBeenCalled();
  f.update({ disabled: true });
  act(() =>
    f
      .row()
      .findByType("input")
      .props.onChange({ target: { value: "9" } }),
  );
  act(() =>
    f
      .row()
      .findAllByType("select")[0]!
      .props.onChange({ target: { value: "unset" } }),
  );
  expect(f.props.onChange).not.toHaveBeenCalled();
});

test("orphaned literal drafts remain visible and can be explicitly discarded without inventing a binding", () => {
  const onDraft = jest.fn();
  const f = fixture({
    bindings: {},
    fields: [],
    drafts: { former: "1e" },
    onDraft,
  });
  expect(f.row("former").findByType("input").props.value).toBe("1e");
  expect(f.row("former").findByType("input").props.readOnly).toBe(true);
  expect(f.props.onChange).not.toHaveBeenCalled();
  act(() => f.row("former").findByType("button").props.onClick());
  expect(onDraft).toHaveBeenLastCalledWith("former", null);
  expect(f.props.onChange).not.toHaveBeenCalled();
});

test("literal types remain explicit and unsetting one binding preserves every other field", () => {
  const bindings: ProcessBindingFieldsProps["bindings"] = {
    value: { source: "literal", value: "false" },
    preserved: { source: "literal", value: null },
  };
  const f = fixture({ bindings });
  expect(f.row().findByType("input").props.value).toBe("false");
  act(() =>
    f
      .row()
      .findAllByType("select")[1]!
      .props.onChange({ target: { value: "boolean" } }),
  );
  expect(f.props.onChange).toHaveBeenLastCalledWith({
    ...bindings,
    value: { source: "literal", value: false },
  });
  f.update({
    bindings: { ...bindings, value: { source: "literal", value: false } },
  });
  act(() =>
    f
      .row()
      .findAllByType("select")[2]!
      .props.onChange({ target: { value: "true" } }),
  );
  expect(f.props.onChange).toHaveBeenLastCalledWith({
    ...bindings,
    value: { source: "literal", value: true },
  });
  act(() =>
    f
      .row()
      .findAllByType("select")[0]!
      .props.onChange({ target: { value: "unset" } }),
  );
  expect(f.props.onChange).toHaveBeenLastCalledWith({
    preserved: bindings.preserved,
  });
});
