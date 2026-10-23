import React, { useState } from "react";
import { Linking } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { Workspace } from "../apps/mobile/App";
import type { Section } from "../apps/mobile/ScreenChrome";
import type {
  ClientSession,
  SessionState,
} from "../packages/client-core/session";
import { fromSnapshot } from "../packages/client-core/store";
import { emptySnapshot } from "../packages/test-fixtures";
import { GenerativeUiView } from "../packages/ui-catalog/GenerativeUiView";
import { GENERATIVE_UI_VIEWS } from "../packages/ui-catalog/generative-ui-components";
import { GENERATIVE_UI_COMPONENTS } from "../packages/openui-library/spec";
import { translate } from "../packages/i18n";

jest.mock("../apps/mobile/voice-capture", () => ({
  createVoiceCapture: () => ({ supported: () => false }),
}));
jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => {}),
}));
jest.mock("../apps/mobile/feedback", () => ({
  feedback: () => 0,
  setFeedbackEnabled: jest.fn(),
}));
jest.mock("../apps/mobile/app-login", () => ({
  loginProof: jest.fn(),
  authorizeApp: jest.fn(),
}));
jest.mock("expo-crypto", () => ({ randomUUID: () => "TEST-command" }));
jest.mock("../apps/mobile/ReplySpeech", () => ({
  useReplySpeech: () => ({
    player: { stop: jest.fn(), waitForReply: jest.fn() },
    state: { phase: "idle" },
    enabled: false,
  }),
}));

const overview = `root = Stack([title, kpis, people, facts, chart, table])
title = Heading("TEST Q3 sales", "l")
kpis = Row([Metric("Revenue", "1.2 M", "CZK", "+12 % vs Q2", "success"), Metric("Orders", 340)])
people = List([ListItem("Anna Nováková", "Product designer", "2 Sep", Badge("Open", "info"))])
facts = Details([Detail("Owner", "Anna"), Detail("Email", "anna@example.test"), Detail("Code", "javascript:alert(1)")])
chart = BarChart(["Jul", "Aug"], [Series("Revenue", [380, 410])])
table = Table(["Branch", "Revenue"], [["Prague", 520], ["Brno", 310], ["Zlín", null]], true)`;

function show(
  program: string,
  options: Partial<React.ComponentProps<typeof GenerativeUiView>> = {},
) {
  const onFollowUp = jest.fn();
  const onOpenUrl = jest.fn();
  const view = render(
    <GenerativeUiView
      program={program}
      language="en"
      onFollowUp={onFollowUp}
      onOpenUrl={onOpenUrl}
      {...options}
    />,
  );
  return { ...view, onFollowUp, onOpenUrl };
}

test("every library component has a phone view", () => {
  const names = GENERATIVE_UI_COMPONENTS.map((component) => component.name);
  for (const name of names)
    expect(
      GENERATIVE_UI_VIEWS[name as keyof typeof GENERATIVE_UI_VIEWS],
    ).toBeDefined();
  expect(Object.keys(GENERATIVE_UI_VIEWS).sort()).toEqual([...names].sort());
});

test("a program renders its content passively with the app's components", () => {
  const fetch = jest.spyOn(globalThis, "fetch");
  const { onFollowUp, onOpenUrl } = show(overview);
  expect(screen.getByRole("header", { name: "TEST Q3 sales" })).toBeTruthy();
  expect(screen.getByLabelText("Revenue, 1.2 M CZK, +12 % vs Q2")).toBeTruthy();
  expect(screen.getByText("340")).toBeTruthy();
  expect(screen.getByText("Product designer")).toBeTruthy();
  expect(screen.getByLabelText("Open")).toBeTruthy();
  // A complete email is a link; other values stay selectable text.
  expect(
    screen.getByRole("link", {
      name: translate("en")("contactWrite").replace(
        "{value}",
        "anna@example.test",
      ),
    }),
  ).toBeTruthy();
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(screen.getByText("javascript:alert(1)").props.selectable).toBe(true);
  expect(
    screen.getByRole("image", { name: "Revenue: Jul 380, Aug 410" }),
  ).toBeTruthy();
  expect(screen.getByText("Prague")).toBeTruthy();
  expect(onFollowUp).not.toHaveBeenCalled();
  expect(onOpenUrl).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockRestore();
});

test("a sortable table sorts locally by the tapped column", () => {
  show(overview);
  const tr = translate("en");
  const order = () =>
    screen
      .getAllByText(/^(Prague|Brno|Zlín)$/)
      .map((node) => node.props.children as string);
  expect(order()).toEqual(["Prague", "Brno", "Zlín"]);
  fireEvent.press(
    screen.getByRole("button", {
      name: tr("generativeSortBy").replace("{column}", "Revenue"),
    }),
  );
  expect(order()).toEqual(["Brno", "Prague", "Zlín"]);
  fireEvent.press(
    screen.getByRole("button", {
      name: tr("generativeSortBy").replace("{column}", "Revenue"),
    }),
  );
  expect(order()).toEqual(["Prague", "Brno", "Zlín"]);
  fireEvent.press(
    screen.getByRole("button", {
      name: tr("generativeSortBy").replace("{column}", "Branch"),
    }),
  );
  expect(order()).toEqual(["Brno", "Prague", "Zlín"]);
});

test("a streaming program renders progressively and stays inert", () => {
  const partial = overview.slice(0, overview.indexOf("people ="));
  const view = show(`${partial}people = List([ListItem("Anna`, {
    streaming: true,
  });
  expect(screen.getByRole("header", { name: "TEST Q3 sales" })).toBeTruthy();
  expect(screen.getByText("340")).toBeTruthy();
  expect(screen.queryByText("Prague")).toBeNull();
  view.rerender(
    <GenerativeUiView
      program={overview}
      language="en"
      streaming
      onFollowUp={view.onFollowUp}
    />,
  );
  expect(screen.getByText("Prague")).toBeTruthy();
  view.rerender(
    <GenerativeUiView
      program={overview}
      language="en"
      onFollowUp={view.onFollowUp}
    />,
  );
  expect(screen.getByText("Prague")).toBeTruthy();
});

test("@ToAssistant and a plain button only fill the message box", () => {
  const fetch = jest.spyOn(globalThis, "fetch");
  const { onFollowUp } = show(`root = Stack([b])
b = Buttons([Button("Compare", @ToAssistant("Compare with last year", "hidden context"), "primary"), Button("Tell me more"), Button("Other", null, "primary")])`);
  fireEvent.press(screen.getByRole("button", { name: "Compare" }));
  expect(onFollowUp).toHaveBeenLastCalledWith("Compare with last year");
  fireEvent.press(screen.getByRole("button", { name: "Tell me more" }));
  expect(onFollowUp).toHaveBeenLastCalledWith("Tell me more");
  expect(onFollowUp).toHaveBeenCalledTimes(2);
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockRestore();
});

const form = `$days = "3"
root = Stack([f])
f = Form("trip", [TextField("city", "City", "Where to", null, true), TextField("days", "Days", null, $days), Select("kind", "Kind", ["Work", "Holiday"], null, true), Checkbox("hotel", "Hotel"), DateField("start", "Start")], Button("Plan it", @ToAssistant("Plan my trip")))`;

test.each(["en", "cs"] as const)(
  "%s form answers join the follow-up as Label: value lines once complete",
  (language) => {
    const tr = translate(language);
    const { onFollowUp } = show(form, { language });
    fireEvent.press(screen.getByRole("button", { name: "Plan it" }));
    expect(onFollowUp).not.toHaveBeenCalled();
    expect(screen.getAllByText(tr("generativeRequired"))).toHaveLength(2);
    fireEvent.changeText(screen.getByLabelText("City"), "Brno");
    fireEvent.press(screen.getByRole("radio", { name: "Holiday" }));
    fireEvent(screen.getByLabelText("Hotel"), "valueChange", true);
    fireEvent.changeText(screen.getByLabelText("Start"), "2026-02-30");
    fireEvent.press(screen.getByRole("button", { name: "Plan it" }));
    expect(screen.getByText(tr("generativeDate"))).toBeTruthy();
    expect(onFollowUp).not.toHaveBeenCalled();
    fireEvent.changeText(screen.getByLabelText("Start"), "2026-11-02");
    // A $variable-bound field keeps its declared value.
    expect(screen.getByLabelText("Days").props.value).toBe("3");
    fireEvent.press(screen.getByRole("button", { name: "Plan it" }));
    expect(onFollowUp).toHaveBeenCalledTimes(1);
    expect(onFollowUp.mock.calls[0]![0]!.split("\n").sort()).toEqual(
      [
        "Plan my trip",
        "City: Brno",
        "Days: 3",
        "Kind: Holiday",
        `Hotel: ${language === "cs" ? "ano" : "yes"}`,
        "Start: 2026-11-02",
      ].sort(),
    );
    expect(onFollowUp.mock.calls[0]![0]!.startsWith("Plan my trip\n")).toBe(
      true,
    );
  },
);

test("@OpenUrl and links open only checked http(s) addresses", () => {
  const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
  const { onOpenUrl } = show(`root = Stack([a, b, c, d])
a = Button("Report", @OpenUrl("https://example.test/report"))
b = Button("Bad", @OpenUrl("javascript:alert(1)"))
c = Link("Docs", "https://example.test/docs")
d = Link("Evil", "javascript:alert(1)")`);
  expect(screen.queryByRole("button", { name: "Bad" })).toBeNull();
  expect(screen.queryByText("Evil")).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "Report" }));
  fireEvent.press(screen.getByRole("link", { name: "Docs" }));
  expect(onOpenUrl.mock.calls).toEqual([
    ["https://example.test/report"],
    ["https://example.test/docs"],
  ]);
  expect(openURL).not.toHaveBeenCalled();
  openURL.mockRestore();
});

test("without a host handler a checked link opens in the system browser", () => {
  const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
  render(
    <GenerativeUiView
      program={`root = Stack([Link("Docs", "https://example.test/docs")])`}
      language="en"
      onFollowUp={jest.fn()}
    />,
  );
  fireEvent.press(screen.getByRole("link", { name: "Docs" }));
  expect(openURL).toHaveBeenCalledWith("https://example.test/docs");
  openURL.mockRestore();
});

test("a streaming javascript: step never opens anything", () => {
  const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
  const { onOpenUrl, rerender, onFollowUp } = show(
    `root = Stack([Button("Bad", @OpenUrl("javascript:alert(1)"))])`,
    { streaming: true },
  );
  fireEvent.press(screen.getByRole("button", { name: "Bad" }));
  rerender(
    <GenerativeUiView
      program={`root = Stack([Button("Bad", @OpenUrl("javascript:alert(1)"))])`}
      language="en"
      onFollowUp={onFollowUp}
      onOpenUrl={onOpenUrl}
    />,
  );
  expect(screen.queryByRole("button", { name: "Bad" })).toBeNull();
  expect(onOpenUrl).not.toHaveBeenCalled();
  expect(openURL).not.toHaveBeenCalled();
  openURL.mockRestore();
});

test("@Set and @Reset change local state only", () => {
  const { onFollowUp } = show(`$open = false
root = Stack([t, b])
t = Text($open ? "TEST shown" : "TEST hidden")
b = Buttons([Button("Show", @Set($open, true)), Button("Hide", @Reset($open))])`);
  expect(screen.getByText("TEST hidden")).toBeTruthy();
  fireEvent.press(screen.getByRole("button", { name: "Show" }));
  expect(screen.getByText("TEST shown")).toBeTruthy();
  fireEvent.press(screen.getByRole("button", { name: "Hide" }));
  expect(screen.getByText("TEST hidden")).toBeTruthy();
  expect(onFollowUp).not.toHaveBeenCalled();
});

test("unknown components are dropped and an invalid program shows nothing", () => {
  show(
    `root = Stack([Heading("TEST kept"), Iframe("https://example.test"), Text("TEST also kept")])`,
  );
  expect(screen.getByText("TEST kept")).toBeTruthy();
  expect(screen.getByText("TEST also kept")).toBeTruthy();
  expect(screen.queryByText("https://example.test")).toBeNull();
  show(`root = Card([Heading("TEST lost")])`);
  expect(screen.queryByText("TEST lost")).toBeNull();
});

test("read-only history disables controls and makes actions do nothing", () => {
  const { onFollowUp } = show(
    `$open = false
root = Stack([t, b, f])
t = Text($open ? "TEST shown" : "TEST hidden")
b = Buttons([Button("Show", @Set($open, true)), Button("Ask")])
f = Form("x", [TextField("name", "Name")], Button("Send"))`,
    { disabled: true },
  );
  fireEvent.press(screen.getByRole("button", { name: "Show" }));
  fireEvent.press(screen.getByRole("button", { name: "Ask" }));
  fireEvent.press(screen.getByRole("button", { name: "Send" }));
  expect(screen.getByText("TEST hidden")).toBeTruthy();
  expect(screen.getByLabelText("Name").props.editable).toBe(false);
  expect(
    screen.getByRole("button", { name: "Ask" }).props.accessibilityState
      .disabled,
  ).toBe(true);
  expect(onFollowUp).not.toHaveBeenCalled();
});

test("tabs, accordions and charts render their parts", () => {
  show(`root = Stack([tabs, acc, Separator(), p, pie, line])
tabs = Tabs([Tab("One", [Text("TEST first")]), Tab("Two", [Text("TEST second")])])
acc = Accordion([AccordionItem("More", [Text("TEST inside")])])
p = Progress("Done", 3, 4)
pie = PieChart(["A", "B"], [3, 1])
line = LineChart(["Mon", "Tue"], [Series("Calls", [2, 5]), Series("Mails", [1, 1])])`);
  expect(screen.getByText("TEST first")).toBeTruthy();
  expect(screen.queryByText("TEST second")).toBeNull();
  fireEvent.press(screen.getByRole("tab", { name: "Two" }));
  expect(screen.getByText("TEST second")).toBeTruthy();
  expect(screen.queryByText("TEST inside")).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "More" }));
  expect(screen.getByText("TEST inside")).toBeTruthy();
  expect(
    screen.getByRole("progressbar", { name: "Done" }).props.accessibilityValue,
  ).toEqual({ min: 0, max: 4, now: 3 });
  expect(
    screen.getByRole("image", { name: "A 3 (75%), B 1 (25%)" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("image", {
      name: "Calls: Mon 2, Tue 5; Mails: Mon 1, Tue 1",
    }),
  ).toBeTruthy();
});

test("in chat, generated UI follows the answer text and a follow-up only fills the composer", async () => {
  const snapshot = emptySnapshot();
  const messages: (typeof snapshot)["conversations"][number]["messages"] = [
    { id: "m-1", role: "user", text: "TEST How did Q3 go?" },
    {
      id: "m-2",
      role: "assistant",
      text: "TEST Sales grew.",
      ui: {
        type: "openui.program",
        version: 1,
        library: "niaro-ui@1",
        program: `root = Stack([Metric("Revenue", 410), Button("Compare", @ToAssistant("TEST Compare with last year"))])`,
      },
    },
    {
      id: "m-3",
      role: "assistant",
      text: "TEST Earlier card.",
      result: {
        type: "card.document",
        version: 1,
        document: {
          id: "TEST-card",
          revision: 1,
          title: "TEST Old card",
          root: ["owner", "go"],
          nodes: [
            { id: "owner", type: "field", label: "Owner", value: "Anna" },
            { id: "go", type: "button", actionId: "go" },
          ],
          actions: [
            { id: "go", kind: "reply", label: "TEST Go", variant: "primary" },
          ],
        },
      },
    },
  ];
  let state: SessionState = {
    store: fromSnapshot("https://fixture.test/v1/a", snapshot.scope, snapshot),
    status: "online",
    pending: null,
    answerAttempts: [],
    answerRecoveryBlocked: false,
    processPending: null,
    commandStates: {},
    error: null,
    activity: null,
    activityConnection: "waiting",
  };
  const listeners = new Set<() => void>();
  const session = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: jest.fn(async () => {}),
    stop: jest.fn(),
    refresh: jest.fn(async () => {}),
    send: jest.fn(async () => {}),
    retry: jest.fn(async () => {}),
  };
  function Harness() {
    const [section, setSection] = useState<Section>("chat");
    return (
      <Workspace
        session={session as unknown as ClientSession}
        language="en"
        section={section}
        setSection={setSection}
        settings={null}
        authError={null}
        spokenReplies={false}
      />
    );
  }
  render(<Harness />);
  // The chat shows this session's messages: they arrive after it opens.
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const store = state.store!;
    state = {
      ...state,
      store: {
        ...store,
        conversations: {
          ...store.conversations,
          "conversation-1": {
            ...store.conversations["conversation-1"]!,
            revision: 2,
            messages,
          },
        },
      },
    };
    listeners.forEach((listener) => listener());
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
  expect(screen.getByText("TEST Sales grew.")).toBeTruthy();
  expect(screen.getByLabelText("Revenue, 410")).toBeTruthy();
  // A stored answer card reads as text, without its controls.
  expect(screen.getByText("TEST Earlier card.")).toBeTruthy();
  expect(screen.getByText("TEST Old card\nOwner: Anna")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "TEST Go" })).toBeNull();
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Compare" }));
  });
  expect(screen.getByLabelText(translate("en")("composer")).props.value).toBe(
    "TEST Compare with last year",
  );
  expect(session.send).not.toHaveBeenCalled();
});
