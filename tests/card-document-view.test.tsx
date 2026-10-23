import React from "react";
import { Linking } from "react-native";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { CardDocument } from "../packages/protocol/card-document";
import { CardDocumentView } from "../packages/ui-catalog/CardDocumentView";
import { ServiceActionCard } from "../packages/ui-catalog/ServiceActionCard";
import { WorkItemCard } from "../packages/ui-catalog/WorkItemCard";
import type { ServiceResult } from "../packages/protocol/service-result";
import { choosePeter } from "../packages/test-fixtures";
import { translate } from "../packages/i18n";

const overview: CardDocument = {
  id: "review",
  revision: 1,
  title: "Review a new project",
  subtitle: "People and next steps",
  icon: "tasks",
  root: ["section", "details", "progress", "button"],
  nodes: [
    {
      id: "section",
      type: "section",
      title: "Review facts",
      icon: "person",
      children: ["heading", "columns", "status", "notice", "divider", "list"],
    },
    { id: "heading", type: "heading", text: "Website launch" },
    { id: "columns", type: "columns", children: ["owner", "when"] },
    {
      id: "owner",
      type: "field",
      label: "Owner",
      value: "Anna Nováková",
      icon: "person",
    },
    { id: "when", type: "field", label: "Date", value: "1 October" },
    { id: "status", type: "badge", label: "Ready for review", tone: "success" },
    {
      id: "notice",
      type: "notice",
      text: "A calendar event will need a separate confirmation.",
      tone: "info",
    },
    { id: "divider", type: "divider" },
    {
      id: "list",
      type: "list",
      items: [
        {
          title: "Design review",
          detail: "Navigation and accessibility",
          icon: "check",
        },
      ],
    },
    {
      id: "details",
      type: "disclosure",
      label: "More details",
      children: ["stack"],
    },
    { id: "stack", type: "stack", children: ["code", "text"] },
    { id: "code", type: "code", label: "Reference", text: "TEST-review-42" },
    {
      id: "text",
      type: "text",
      text: "Local expansion only",
      tone: "secondary",
    },
    {
      id: "progress",
      type: "progress",
      label: "Preparation",
      value: 3,
      total: 4,
    },
    { id: "button", type: "button", actionId: "prepare" },
  ],
  actions: [
    {
      id: "prepare",
      kind: "reply",
      label: "Prepare a meeting proposal",
      variant: "primary",
      icon: "calendar",
    },
  ],
};
const form: CardDocument = {
  id: "form",
  revision: 1,
  title: "Meeting details",
  root: ["title", "number", "date", "time", "choice", "toggle", "submit"],
  nodes: [
    {
      id: "title",
      type: "input",
      label: "Title",
      kind: "text",
      required: true,
    },
    {
      id: "number",
      type: "input",
      label: "Minutes",
      kind: "number",
      required: true,
    },
    { id: "date", type: "input", label: "Date", kind: "date", required: true },
    { id: "time", type: "input", label: "Time", kind: "time", required: true },
    {
      id: "choice",
      type: "input",
      label: "Location",
      kind: "choice",
      required: true,
      options: [
        { id: "room", label: "Room A" },
        { id: "online", label: "Video call" },
      ],
    },
    {
      id: "toggle",
      type: "input",
      label: "Remote participants",
      kind: "toggle",
      value: true,
    },
    { id: "submit", type: "button", actionId: "submit" },
  ],
  actions: [
    {
      id: "submit",
      kind: "submit",
      label: "Prepare the proposal",
      variant: "primary",
      fields: ["title", "number", "date", "time", "choice", "toggle"],
    },
  ],
};
test("composition renders readable primitive nodes and expands locally without dispatch or fetching", () => {
  const fetch = jest.spyOn(globalThis, "fetch");
  render(<CardDocumentView document={overview} language="en" />);
  expect(
    screen.getByRole("header", { name: "Review a new project" }),
  ).toBeTruthy();
  expect(screen.getByRole("header", { name: "Review facts" })).toBeTruthy();
  expect(screen.getByText("Anna Nováková").props.selectable).toBe(true);
  expect(screen.getByText("Navigation and accessibility")).toBeTruthy();
  expect(
    screen.getByRole("progressbar", { name: "Preparation" }).props
      .accessibilityValue,
  ).toEqual({ min: 0, max: 4, now: 3 });
  expect(screen.getByText("75%")).toBeTruthy();
  expect(screen.queryByText("TEST-review-42")).toBeNull();
  fireEvent.press(
    screen.getByRole("button", { name: "More details", expanded: false }),
  );
  expect(screen.getByText("TEST-review-42").props.selectable).toBe(true);
  expect(screen.getByText("Local expansion only")).toBeTruthy();
  // Answer-card buttons are gone; a system card shows data only.
  expect(
    screen.queryByRole("button", { name: "Prepare a meeting proposal" }),
  ).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockRestore();
});
test.each(["en", "cs"] as const)(
  "%s passive field cards open complete contact and URL values only on tap",
  (language) => {
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    const fetch = jest.spyOn(globalThis, "fetch");
    const card: CardDocument = {
      id: "contact-links",
      revision: 1,
      title: "TEST Contact",
      actions: [],
      root: ["phone", "email", "url", "id", "invalid", "multiple"],
      nodes: [
        {
          id: "phone",
          type: "field",
          label: "Phone",
          value: "+420 555 010 001",
          icon: "phone",
        },
        {
          id: "email",
          type: "field",
          label: "Email",
          value: "person@example.test",
          icon: "mail",
        },
        {
          id: "url",
          type: "field",
          label: "Meeting",
          value: "https://example.test/review",
          icon: "link",
        },
        { id: "id", type: "field", label: "Record ID", value: "555010001" },
        {
          id: "invalid",
          type: "field",
          label: "Phone",
          value: "Call the reception",
          icon: "phone",
        },
        {
          id: "multiple",
          type: "field",
          label: "Emails",
          value: "one@example.test, two@example.test",
          icon: "mail",
        },
      ],
    };
    render(<CardDocumentView document={card} language={language} embedded />);
    const tr = translate(language);
    expect(screen.getAllByRole("link")).toHaveLength(3);
    expect(screen.getByText("555010001").props.selectable).toBe(true);
    expect(screen.getByText("Call the reception").props.selectable).toBe(true);
    expect(screen.queryByRole("button")).toBeNull();
    expect(openURL).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    for (const [key, value, href] of [
      ["contactCall", "+420 555 010 001", "tel:+420555010001"],
      ["contactWrite", "person@example.test", "mailto:person@example.test"],
      [
        "contactOpen",
        "https://example.test/review",
        "https://example.test/review",
      ],
    ] as const) {
      fireEvent.press(
        screen.getByRole("link", { name: tr(key).replace("{value}", value) }),
      );
      expect(openURL).toHaveBeenLastCalledWith(href);
    }
    expect(openURL).toHaveBeenCalledTimes(3);
    fetch.mockRestore();
    openURL.mockRestore();
  },
);

test("unhandled URI schemes remain selectable data and failed external navigation is contained", async () => {
  const openURL = jest
    .spyOn(Linking, "openURL")
    .mockRejectedValue(new Error("TEST missing handler"));
  render(
    <CardDocumentView
      language="en"
      document={{
        id: "safe-links",
        revision: 1,
        title: "TEST Links",
        actions: [],
        root: ["unsafe", "url"],
        nodes: [
          {
            id: "unsafe",
            type: "field",
            label: "Reference",
            value: "intent://open/#Intent;end",
            icon: "link",
          },
          {
            id: "url",
            type: "field",
            label: "Review",
            value: "https://example.test",
            icon: "link",
          },
        ],
      }}
    />,
  );
  expect(screen.getByText("intent://open/#Intent;end").props.selectable).toBe(
    true,
  );
  expect(screen.getAllByRole("link")).toHaveLength(1);
  fireEvent.press(screen.getByRole("link"));
  await Promise.resolve();
  expect(openURL).toHaveBeenCalledWith("https://example.test/");
  openURL.mockRestore();
});
test("stored inputs and buttons never become controls", () => {
  render(<CardDocumentView document={form} language="cs" embedded />);
  expect(screen.queryByText("Meeting details")).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByRole("radio")).toBeNull();
  expect(screen.queryByText("Title")).toBeNull();
  expect(screen.queryByText("Prepare the proposal")).toBeNull();
});
test.each(["en", "cs"] as const)(
  "%s invalid graphs fall back passively and hide their actions",
  (language) => {
    render(
      <CardDocumentView
        document={{ ...overview, root: ["missing"] }}
        language={language}
      />,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(
      screen.getByText(translate(language)("cardUnavailable")),
    ).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  },
);
test("non-document input falls back passively without throwing", () => {
  render(
    <CardDocumentView
      document={null as unknown as CardDocument}
      language="en"
    />,
  );
  expect(screen.getByText(translate("en")("cardUnavailable"))).toBeTruthy();
});
const service: ServiceResult = {
  type: "service.action",
  version: 1,
  operationId: "op",
  title: "Create project",
  service: "Project tracker",
  status: "awaiting_approval",
  effect: "write",
  fields: [{ label: "Name", value: "TEST project" }],
  inputJson: '{"name":"TEST project","recipient":"review@example.test"}',
  reviewTruncated: true,
  summary: "",
  card: overview,
};
test("dynamic confirmation context keeps canonical identity, effect, parameters and buttons visible", () => {
  const onDecide = jest.fn();
  render(
    <ServiceActionCard
      result={service}
      language="en"
      disabled={false}
      onDecide={onDecide}
    />,
  );
  expect(screen.getByText("Create project")).toBeTruthy();
  expect(screen.getByText("Project tracker")).toBeTruthy();
  expect(screen.getByText(translate("en")("serviceWriteEffect"))).toBeTruthy();
  expect(screen.getByText(service.inputJson)).toBeTruthy();
  expect(screen.queryByText("Anna Nováková")).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "Additional context" }));
  expect(screen.getByText("Anna Nováková")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Prepare a meeting proposal" }),
  ).toBeNull();
  expect(onDecide).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole("button", { name: "Approve" }));
  expect(onDecide.mock.calls).toEqual([[true]]);
});
test("dynamic result content leaves unknown outcomes unconfirmed and offers no write retry", () => {
  render(
    <ServiceActionCard
      result={{ ...service, status: "unknown" }}
      language="cs"
      disabled={false}
      onDecide={jest.fn()}
    />,
  );
  expect(screen.getByText(translate("cs")("serviceUnknown"))).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Potvrdit" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Prepare a meeting proposal" }),
  ).toBeNull();
});
test("optional work-card content preserves authoritative input answering", () => {
  const { work, input } = choosePeter();
  const onAnswer = jest.fn();
  render(
    <WorkItemCard
      work={{
        ...work,
        card: {
          ...overview,
          root: overview.root.filter((id) => id !== "button"),
          nodes: overview.nodes.filter((node) => node.type !== "button"),
          actions: [],
        },
      }}
      input={input}
      language="en"
      compact
      onAnswer={onAnswer}
    />,
  );
  expect(screen.getByText("Anna Nováková")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Prepare a meeting proposal" }),
  ).toBeNull();
  expect(onAnswer).not.toHaveBeenCalled();
  fireEvent.press(
    screen.getByRole("button", {
      name: "Peter Svoboda, Northstar · Engineering",
    }),
  );
  expect(onAnswer).toHaveBeenCalledWith("peter-svoboda", input.revision);
});
