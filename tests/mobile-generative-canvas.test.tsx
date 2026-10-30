import React from "react";
import { ScrollView } from "react-native";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { GenerativeUiView } from "../packages/ui-catalog/GenerativeUiView";

const program = `root = Stack([tabs, more])
tabs = Tabs([Tab("Overview", [Text("Overview content")]), Tab("Details", [table, form])])
table = Table(["City", "Orders"], [["Prague", 520], ["Brno", 310]], true)
form = Form("trip", [TextField("city", "Destination")], Button("Prepare question", @ToAssistant("Plan a trip")))
more = Accordion([AccordionItem("Source", [Text("Original source")])])`;

function show(
  source = program,
  options: { disabled?: boolean; streaming?: boolean } = {},
) {
  const followUp = jest.fn();
  const view = render(
    <GenerativeUiView
      program={source}
      language="en"
      onFollowUp={followUp}
      {...options}
    />,
  );
  return { ...view, followUp };
}

function expand() {
  fireEvent.press(screen.getByRole("button", { name: "Open full screen" }));
  expect(screen.getByTestId("generative-ui-expanded")).toBeTruthy();
  expect(screen.getAllByTestId("generative-ui")).toHaveLength(1);
}

function close() {
  fireEvent.press(screen.getByRole("button", { name: "Back to chat" }));
  expect(screen.queryByTestId("generative-ui-expanded")).toBeNull();
  expect(screen.getAllByTestId("generative-ui")).toHaveLength(1);
}

test("expanding and returning retain the selected tab, sorting, form values and disclosure", () => {
  const { followUp } = show();
  fireEvent.press(screen.getByRole("tab", { name: "Details" }));
  fireEvent.changeText(screen.getByLabelText("Destination"), "Vienna");
  fireEvent.press(screen.getByRole("button", { name: "Sort by Orders" }));
  fireEvent.press(screen.getByRole("button", { name: "Source" }));
  const order = () =>
    screen.getAllByText(/^(Prague|Brno)$/).map((item) => item.props.children);
  expect(order()).toEqual(["Brno", "Prague"]);
  expand();
  expect(screen.getByLabelText("Destination").props.value).toBe("Vienna");
  expect(screen.getByText("Original source")).toBeTruthy();
  expect(order()).toEqual(["Brno", "Prague"]);
  fireEvent.changeText(screen.getByLabelText("Destination"), "Berlin");
  close();
  expect(
    screen.getByRole("tab", { name: "Details" }).props.accessibilityState
      .selected,
  ).toBe(true);
  expect(screen.getByLabelText("Destination").props.value).toBe("Berlin");
  expect(screen.getByText("Original source")).toBeTruthy();
  expect(order()).toEqual(["Brno", "Prague"]);
  expect(followUp).not.toHaveBeenCalled();
});

test("expanded follow-up closes the canvas and hands only a draft to the chat", () => {
  const { followUp } = show();
  expand();
  fireEvent.press(screen.getByRole("tab", { name: "Details" }));
  fireEvent.changeText(screen.getByLabelText("Destination"), "Vienna");
  fireEvent.press(screen.getByRole("button", { name: "Prepare question" }));
  expect(screen.queryByTestId("generative-ui-expanded")).toBeNull();
  expect(followUp).toHaveBeenCalledTimes(1);
  expect(followUp).toHaveBeenCalledWith("Plan a trip\nDestination: Vienna");
});

test("read-only answers can expand for reading but their fields and follow-ups stay inert", () => {
  const { followUp } = show(program, { disabled: true });
  expand();
  fireEvent.press(screen.getByRole("tab", { name: "Details" }));
  expect(screen.getByLabelText("Destination").props.editable).toBe(false);
  fireEvent.changeText(screen.getByLabelText("Destination"), "Vienna");
  fireEvent.press(screen.getByRole("button", { name: "Prepare question" }));
  expect(screen.getByTestId("generative-ui-expanded")).toBeTruthy();
  expect(followUp).not.toHaveBeenCalled();
});

test("streaming UI has no expansion control and its existing actions remain inert", () => {
  const { followUp } = show(`root = Stack([Button("Prepare question")])`, {
    streaming: true,
  });
  expect(screen.queryByRole("button", { name: "Open full screen" })).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "Prepare question" }));
  expect(followUp).not.toHaveBeenCalled();
});

test("a new program revision resets local fields and closes the old expanded answer", () => {
  const { followUp, rerender } = show();
  fireEvent.press(screen.getByRole("tab", { name: "Details" }));
  fireEvent.changeText(
    screen.getByLabelText("Destination"),
    "Private previous draft",
  );
  expand();
  rerender(
    <GenerativeUiView
      program={program.replace("Overview content", "Revised overview")}
      language="en"
      onFollowUp={followUp}
    />,
  );
  expect(screen.queryByTestId("generative-ui-expanded")).toBeNull();
  expect(screen.getByText("Revised overview")).toBeTruthy();
  fireEvent.press(screen.getByRole("tab", { name: "Details" }));
  expect(screen.getByLabelText("Destination").props.value).toBe("");
  expect(followUp).not.toHaveBeenCalled();
});

test("separate tab sets keep independent selections across expansion", () => {
  show(
    `root = Stack([Tabs([Tab("A1", [Text("First A")]), Tab("A2", [Text("Second A")])]), Tabs([Tab("B1", [Text("First B")]), Tab("B2", [Text("Second B")])])])`,
  );
  fireEvent.press(screen.getByRole("tab", { name: "A2" }));
  expand();
  expect(screen.getByText("Second A")).toBeTruthy();
  expect(screen.getByText("First B")).toBeTruthy();
  close();
  expect(screen.getByText("Second A")).toBeTruthy();
  expect(screen.getByText("First B")).toBeTruthy();
});

test("table and expanded-canvas scroll offsets survive closing and reopening", () => {
  show();
  fireEvent.press(screen.getByRole("tab", { name: "Details" }));
  const table = () =>
    screen
      .UNSAFE_getAllByType(ScrollView)
      .find((node) => node.props.horizontal)!;
  fireEvent.scroll(table(), {
    nativeEvent: { contentOffset: { x: 140, y: 0 } },
  });
  expand();
  expect(table().props.contentOffset).toEqual({ x: 140, y: 0 });
  fireEvent.scroll(screen.getByTestId("generative-ui-expanded"), {
    nativeEvent: { contentOffset: { x: 0, y: 240 } },
  });
  fireEvent.scroll(table(), {
    nativeEvent: { contentOffset: { x: 80, y: 0 } },
  });
  close();
  expect(table().props.contentOffset).toEqual({ x: 80, y: 0 });
  expand();
  expect(
    screen.getByTestId("generative-ui-expanded").props.contentOffset,
  ).toEqual({ x: 0, y: 240 });
});
