import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { ProcessStepPicker } from "../apps/server-admin/web/process-step-picker";
import { editorEn } from "../apps/server-admin/web/process-editor-copy";
import type { DesignCapabilities } from "../packages/protocol/process-design";
import { designUiCapabilities } from "./admin-design-fixtures";

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

const base = designUiCapabilities.services[0]!;
const action = base.actions[0]!;
const capabilities: DesignCapabilities = {
  ...designUiCapabilities,
  services: [
    {
      ...base,
      actions: [
        action,
        {
          ...action,
          id: "test_write",
          name: "create_person",
          description: "Synthetic write",
          effect: "write",
          approval: "always",
        },
        {
          ...action,
          id: "test_unusable",
          name: "broken_schema",
          inputSchema: null,
          schemaUnavailable: "schema_unsupported",
        },
      ],
    },
    {
      ...base,
      id: "test_mail",
      name: "TEST Mail",
      description: "Synthetic mailbox",
      actions: [{ ...action, id: "test_send", name: "send_mail" }],
    },
    { ...base, id: "test_disabled", name: "TEST Disabled", enabled: false },
  ],
};

function fixture(overrides: { allowAgent?: boolean } = {}) {
  const onPick = jest.fn();
  let tree: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      <ProcessStepPicker
        capabilities={capabilities}
        copy={editorEn}
        disabled={false}
        allowAgent={overrides.allowAgent ?? true}
        onPick={onPick}
      />,
    );
  });
  const options = () =>
    tree!.root.findAll(
      (node) => node.type === "button" && node.props.role === "option",
    );
  const labels = () => options().map((node) => node.props["aria-label"]);
  const selected = () =>
    options().find((node) => node.props["aria-selected"])?.props["aria-label"];
  const input = () => tree!.root.findByType("input");
  const type = (value: string) =>
    act(() => input().props.onChange({ target: { value } }));
  const key = (value: string) =>
    act(() =>
      input().props.onKeyDown({ key: value, preventDefault: jest.fn() }),
    );
  const choose = (label: string) =>
    act(() =>
      options()
        .find((node) => node.props["aria-label"] === label)!
        .props.onClick(),
    );
  return { tree: tree!, onPick, options, labels, selected, type, key, choose };
}

test("the first view lists flow steps and services with usable actions only", () => {
  const f = fixture();
  expect(f.labels()).toEqual([
    editorEn.agent,
    editorEn.branch,
    editorEn.return,
    "TEST CRM",
    "TEST Mail",
  ]);
  f.choose(editorEn.branch);
  expect(f.onPick).toHaveBeenCalledWith("branch");
  const withoutModel = fixture({ allowAgent: false });
  expect(
    withoutModel.options().find((node) => node.props["aria-label"] === "Agent")!
      .props.disabled,
  ).toBe(true);
});

test("a service opens its actions grouped by effect, and Backspace returns", () => {
  const f = fixture();
  f.choose("TEST CRM");
  expect(f.labels()).toEqual([
    "Find contacts · TEST CRM",
    "Create person · TEST CRM",
  ]);
  const groups = f.tree.root
    .findAll((node) => node.type === "div" && node.props.role === "group")
    .map((node) => node.props["aria-label"]);
  expect(groups).toEqual([editorEn.reads, editorEn.writes]);
  expect(JSON.stringify(f.tree.toJSON())).toContain(editorEn.needsApproval);
  f.choose("Create person · TEST CRM");
  expect(f.onPick).toHaveBeenCalledWith("action", {
    serviceId: "test_service",
    actionId: "test_write",
  });
  f.key("Backspace");
  expect(f.labels()).toContain("TEST Mail");
});

test("search spans services, ranks names first and is driven by the keyboard", () => {
  const f = fixture();
  f.type("synthetic");
  // Only descriptions match, so every result has the same rank and keeps
  // catalogue order.
  expect(f.labels()).toEqual([
    "Find contacts · TEST CRM",
    "Create person · TEST CRM",
    "Send mail · TEST Mail",
  ]);
  f.type("mail send");
  expect(f.labels()).toEqual(["Send mail · TEST Mail"]);
  f.type("result");
  expect(f.labels()).toEqual([editorEn.return]);
  f.type("person");
  expect(f.selected()).toBe("Create person · TEST CRM");
  f.key("Enter");
  expect(f.onPick).toHaveBeenLastCalledWith("action", {
    serviceId: "test_service",
    actionId: "test_write",
  });
  f.type("");
  f.key("ArrowDown");
  f.key("ArrowDown");
  f.key("ArrowDown");
  expect(f.selected()).toBe("TEST CRM");
  f.key("ArrowRight");
  expect(f.selected()).toBe("Find contacts · TEST CRM");
  f.key("ArrowUp");
  expect(f.selected()).toBe("Create person · TEST CRM");
  f.type("nothing like this");
  expect(f.labels()).toEqual([]);
  expect(JSON.stringify(f.tree.toJSON())).toContain(editorEn.noResults);
});
