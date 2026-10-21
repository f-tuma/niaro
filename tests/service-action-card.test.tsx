import React from "react";
import { Linking } from "react-native";
import { render, fireEvent } from "@testing-library/react-native";
import {
  ServiceActionCard,
  type ServiceActionReviewFrame,
} from "../packages/ui-catalog/ServiceActionCard";
import { translate } from "../packages/i18n";
import {
  SERVICE_CARD_STATES,
  type ServiceResult,
} from "../packages/protocol/service-result";
import type { ServicePresentation } from "../packages/protocol/service-presentation";
import type { CardDocument } from "../packages/protocol/card-document";
import { serviceCard } from "../apps/server-cards/adapters";
const result: ServiceResult = {
  type: "service.action",
  version: 1,
  operationId: "test",
  title: "TEST project",
  service: "Project tracker",
  status: "awaiting_approval",
  effect: "write",
  fields: [{ label: "name", value: "TEST" }],
  inputJson: '{"recipient":"TEST-person@example.test"}',
  reviewTruncated: true,
  summary: "",
};
test("complete parameters are visible before explicit approval; render never executes", () => {
  const onDecide = jest.fn();
  const ui = render(
    <ServiceActionCard
      result={result}
      language="en"
      disabled={false}
      onDecide={onDecide}
    />,
  );
  expect(ui.getByText(result.inputJson)).toBeTruthy();
  expect(onDecide).not.toHaveBeenCalled();
  fireEvent.press(ui.getByText("Approve"));
  expect(onDecide).toHaveBeenCalledWith(true);
});
test("unknown outcome never offers to repeat a write", () => {
  const ui = render(
    <ServiceActionCard
      result={{ ...result, status: "unknown", fields: [], inputJson: "" }}
      language="cs"
      disabled={false}
      onDecide={jest.fn()}
    />,
  );
  expect(ui.queryByText("Potvrdit")).toBeNull();
});

const reviewFrame: ServiceActionReviewFrame = {
  source: "https://TEST-server.example.test",
  workspace: "TEST-workspace",
  nativeRevision: 7,
  serviceId: "TEST-service",
  serviceRevision: 0,
  actionId: "TEST-action",
  actionRevision: 4,
};
test.each(["en", "cs"] as const)(
  "%s client review frame shows original identity and full JSON even with a complete preview",
  (language) => {
    const onDecide = jest.fn();
    const inputJson = JSON.stringify({
      text: "TEST long unbroken parameter ".repeat(100),
      cleared: null,
      enabled: false,
      ordered: ["first", " second "],
    });
    const ui = render(
      <ServiceActionCard
        result={{ ...result, reviewTruncated: false, inputJson }}
        reviewFrame={reviewFrame}
        language={language}
        disabled={false}
        onDecide={onDecide}
      />,
    );
    const tr = translate(language);
    expect(ui.getByTestId("service-action-parameters").props.children).toBe(
      inputJson,
    );
    expect(
      ui.getByLabelText(
        `${tr("processApprovalServer")}: ${reviewFrame.source}`,
      ),
    ).toBeTruthy();
    expect(
      ui.getByLabelText(`${tr("scope")}: ${reviewFrame.workspace}`),
    ).toBeTruthy();
    expect(
      ui.getByLabelText(`${tr("processApprovalNativeRevision")}: 7`),
    ).toBeTruthy();
    expect(
      ui.getByLabelText(
        `${tr("processApprovalServiceIdentity")}: TEST-service`,
      ),
    ).toBeTruthy();
    expect(
      ui.getByLabelText(`${tr("processApprovalServiceRevision")}: 0`),
    ).toBeTruthy();
    expect(
      ui.getByLabelText(`${tr("processApprovalActionIdentity")}: TEST-action`),
    ).toBeTruthy();
    expect(
      ui.getByLabelText(`${tr("processApprovalActionRevision")}: 4`),
    ).toBeTruthy();
    expect(ui.getByText(tr("serviceWriteEffect"))).toBeTruthy();
    expect(onDecide).not.toHaveBeenCalled();
    fireEvent.press(ui.getByRole("button", { name: tr("serviceApprove") }));
    expect(onDecide).toHaveBeenCalledWith(true);
  },
);
test.each([
  { frame: { ...reviewFrame, workspace: undefined }, inputJson: "{}" },
  { frame: { ...reviewFrame, source: " " }, inputJson: "{}" },
  { frame: { ...reviewFrame, nativeRevision: 0 }, inputJson: "{}" },
  { frame: { ...reviewFrame, actionRevision: -1 }, inputJson: "{}" },
  { frame: reviewFrame, inputJson: "" },
  { frame: reviewFrame, inputJson: "[]" },
  { frame: reviewFrame, inputJson: "null" },
  { frame: reviewFrame, inputJson: "{broken" },
])("incomplete review blocks both decisions: %j", ({ frame, inputJson }) => {
  const onDecide = jest.fn();
  const ui = render(
    <ServiceActionCard
      result={{ ...result, inputJson }}
      reviewFrame={frame}
      language="en"
      disabled={false}
      onDecide={onDecide}
    />,
  );
  expect(
    ui.getByText(translate("en")("processApprovalUnavailable")),
  ).toBeTruthy();
  for (const name of [
    translate("en")("serviceApprove"),
    translate("en")("serviceReject"),
  ]) {
    const button = ui.getByRole("button", { name });
    expect(button.props.accessibilityState.disabled).toBe(true);
    fireEvent.press(button);
  }
  expect(onDecide).not.toHaveBeenCalled();
});

function completed(presentation?: ServicePresentation): ServiceResult {
  return {
    ...result,
    status: "succeeded",
    effect: "read",
    fields: [],
    inputJson: "",
    reviewTruncated: false,
    presentation,
  };
}

afterEach(() => jest.restoreAllMocks());
beforeEach(() => jest.clearAllMocks());

test("contacts expand locally and open the dialer or mail app only on tap", () => {
  const onDecide = jest.fn();
  const fetch = jest.spyOn(globalThis, "fetch");
  const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
  const ui = render(
    <ServiceActionCard
      result={completed({
        kind: "contacts",
        items: Array.from({ length: 4 }, (_, index) => ({
          name: `Contact ${index + 1}`,
          email: `contact${index + 1}@example.test`,
          phone: "+420 555 010 001",
        })),
        hasMore: true,
      })}
      language="en"
      disabled={false}
      onDecide={onDecide}
    />,
  );
  expect(ui.getByText("Contact 1")).toBeTruthy();
  expect(ui.getByText("contact1@example.test")).toBeTruthy();
  expect(ui.queryByText("Contact 4")).toBeNull();
  fireEvent.press(
    ui.getByRole("button", { name: "Show more", expanded: false }),
  );
  expect(ui.getByText("Contact 4")).toBeTruthy();
  fireEvent.press(
    ui.getByRole("button", { name: "Show less", expanded: true }),
  );
  expect(ui.queryByText("Contact 4")).toBeNull();
  expect(ui.getByText("Partial results. Narrow your request.")).toBeTruthy();
  expect(ui.queryAllByRole("link")).toHaveLength(6);
  expect(onDecide).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(openURL).not.toHaveBeenCalled();
  fireEvent.press(
    ui.getByRole("link", { name: "Write to contact1@example.test" }),
  );
  expect(openURL).toHaveBeenLastCalledWith("mailto:contact1@example.test");
  fireEvent.press(
    ui.getAllByRole("link", { name: "Call +420 555 010 001" })[0]!,
  );
  expect(openURL).toHaveBeenLastCalledWith("tel:+420555010001");
  expect(onDecide).not.toHaveBeenCalled();
});

test("large records keep item details hidden until their own disclosure opens", () => {
  const onDecide = jest.fn();
  const ui = render(
    <ServiceActionCard
      result={completed({
        kind: "records",
        hasMore: false,
        items: [
          {
            title: "Website",
            subtitle: "Project",
            fields: [
              { label: "Owner", value: "Anna" },
              { label: "Status", value: "Planned" },
              { label: "Notes", value: "Review with team" },
            ],
          },
          {
            title: "Onboarding",
            fields: [{ label: "Notes", value: "More detail. ".repeat(15) }],
          },
        ],
      })}
      language="en"
      disabled={false}
      onDecide={onDecide}
    />,
  );
  expect(ui.getByText("Website")).toBeTruthy();
  expect(ui.queryByText("Review with team")).toBeNull();
  fireEvent.press(
    ui.getByRole("button", { name: "Details for Website", expanded: false }),
  );
  expect(ui.getByText("Review with team")).toBeTruthy();
  expect(
    ui.getByRole("button", { name: "Details for Website", expanded: true }),
  ).toBeTruthy();
  expect(ui.queryByText("More detail. ".repeat(15))).toBeNull();
  fireEvent.press(ui.getByRole("button", { name: "Details for Website" }));
  expect(ui.queryByText("Review with team")).toBeNull();
  expect(onDecide).not.toHaveBeenCalled();
});

test("event details are readable and raw source diagnostics are absent", () => {
  const ui = render(
    <ServiceActionCard
      result={{
        ...completed({
          kind: "events",
          hasMore: false,
          items: [
            {
              title: "Project review",
              start: "2026-09-29T10:00:00+02:00",
              end: "2026-09-29T10:30:00+02:00",
              location: "Room A",
            },
          ],
        }),
        summary: '{"event":"source-data"}',
      }}
      language="en"
      disabled={false}
      onDecide={jest.fn()}
    />,
  );
  expect(ui.getByText("Project review")).toBeTruthy();
  expect(ui.getByText("Room A")).toBeTruthy();
  // One local range instead of separate start and end lines.
  expect(ui.getByText(/\d{2}:\d{2}–\d{2}:\d{2}$/)).toBeTruthy();
  expect(ui.queryByText('{"event":"source-data"}')).toBeNull();
  expect(ui.queryByRole("button", { name: "Source details" })).toBeNull();
});

test.each([
  [{ kind: "contacts", items: [], hasMore: false }, "No contacts found."],
  [{ kind: "events", items: [], hasMore: false }, "No events found."],
  [{ kind: "records", items: [], hasMore: false }, "No results found."],
] satisfies [ServicePresentation, string][])(
  "empty %s has no expansion or remote-load control",
  (presentation, label) => {
    const ui = render(
      <ServiceActionCard
        result={completed(presentation)}
        language="en"
        disabled={false}
        onDecide={jest.fn()}
      />,
    );
    expect(ui.getByText(label)).toBeTruthy();
    expect(ui.queryAllByRole("button")).toHaveLength(0);
  },
);

test("a complete detail URL opens only on tap; text explanations remain selectable content", () => {
  const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
  const onDecide = jest.fn();
  const props = { language: "en" as const, disabled: false, onDecide };
  const ui = render(
    <ServiceActionCard
      {...props}
      result={completed({
        kind: "detail",
        fields: [{ label: "Website", value: "https://example.test" }],
      })}
    />,
  );
  expect(ui.queryAllByRole("link")).toHaveLength(1);
  expect(openURL).not.toHaveBeenCalled();
  fireEvent.press(ui.getByRole("link", { name: "Open https://example.test" }));
  expect(openURL).toHaveBeenCalledWith("https://example.test/");
  ui.rerender(
    <ServiceActionCard
      {...props}
      result={completed({
        kind: "text",
        text: "**Plain text**, https://example.test",
      })}
    />,
  );
  expect(
    ui.getByText("**Plain text**, https://example.test").props.selectable,
  ).toBe(true);
  expect(ui.queryAllByRole("link")).toHaveLength(0);
  expect(onDecide).not.toHaveBeenCalled();
});

test.each([
  "awaiting_approval",
  "running",
  "unknown",
  "failed",
  "rejected",
] as const)("%s never renders a successful presentation", (status) => {
  const ui = render(
    <ServiceActionCard
      result={{
        ...result,
        status,
        presentation: { kind: "text", text: "Must not appear" },
      }}
      language="en"
      disabled={false}
      onDecide={jest.fn()}
    />,
  );
  expect(ui.queryByText("Must not appear")).toBeNull();
  if (status === "awaiting_approval")
    expect(ui.getByText(result.inputJson)).toBeTruthy();
  else expect(ui.queryByText("Approve")).toBeNull();
});

test("legacy successful results omit raw summary and source disclosures", () => {
  const summary = '{"legacy":"result"}';
  const ui = render(
    <ServiceActionCard
      result={{ ...completed(), summary }}
      language="en"
      disabled={false}
      onDecide={jest.fn()}
    />,
  );
  expect(ui.queryByText(summary)).toBeNull();
  expect(ui.queryByRole("button", { name: "Result details" })).toBeNull();
});

test.each(["en", "cs"] as const)(
  "%s composable result and outer frame both omit source diagnostics",
  (language) => {
    const ui = render(
      <ServiceActionCard
        result={{
          ...completed({
            kind: "detail",
            fields: [{ label: "Email", value: "person@example.test" }],
          }),
          summary: '{"raw":"TEST-private-source"}',
          card: {
            id: "TEST-body",
            revision: 1,
            title: "TEST Contact",
            root: ["email"],
            actions: [],
            nodes: [
              {
                id: "email",
                type: "field",
                label: "Email",
                value: "person@example.test",
                icon: "mail",
              },
            ],
          },
        }}
        language={language}
        disabled={false}
        onDecide={jest.fn()}
      />,
    );
    expect(ui.getByText("person@example.test")).toBeTruthy();
    expect(ui.getAllByRole("link")).toHaveLength(1);
    expect(
      ui.queryByText(/Source details|Podrobnosti zdroje|TEST-private-source/),
    ).toBeNull();
    expect(ui.queryByRole("button")).toBeNull();
  },
);

test.each(["en", "cs"] as const)(
  "%s previously stored generated cards stop rendering their known source payload",
  (language) => {
    const summary = '{"raw":"TEST-old-source"}';
    const card = {
      id: "service-" + "a".repeat(32),
      revision: 1,
      title: "TEST Stored result",
      actions: [],
      root: ["status", "source"],
      nodes: [
        {
          id: "status",
          type: "badge" as const,
          label: "Completed",
          tone: "success" as const,
        },
        {
          id: "source",
          type: "disclosure" as const,
          label: language === "cs" ? "Podrobnosti zdroje" : "Source details",
          children: ["code"],
        },
        { id: "code", type: "code" as const, text: summary },
      ],
    };
    const saved = JSON.parse(JSON.stringify(card));
    const ui = render(
      <ServiceActionCard
        result={{ ...completed(), summary, card }}
        language={language}
        disabled={false}
        onDecide={jest.fn()}
      />,
    );
    expect(
      ui.getAllByText(language === "cs" ? "Hotovo" : "Completed"),
    ).toHaveLength(1);
    if (language === "cs") expect(ui.queryByText("Completed")).toBeNull();
    expect(ui.queryByRole("button")).toBeNull();
    expect(ui.queryByText(summary)).toBeNull();
    expect(card).toEqual(saved);
  },
);

test("Czech result controls and empty states are translated", () => {
  const props = {
    language: "cs" as const,
    disabled: false,
    onDecide: jest.fn(),
  };
  const ui = render(
    <ServiceActionCard
      {...props}
      result={completed({
        kind: "contacts",
        hasMore: false,
        items: Array.from({ length: 4 }, (_, index) => ({
          name: `Kontakt ${index + 1}`,
        })),
      })}
    />,
  );
  fireEvent.press(ui.getByRole("button", { name: "Zobrazit více" }));
  expect(
    ui.getByRole("button", { name: "Zobrazit méně", expanded: true }),
  ).toBeTruthy();
  ui.rerender(
    <ServiceActionCard
      {...props}
      result={completed({ kind: "events", hasMore: false, items: [] })}
    />,
  );
  expect(ui.getByText("Žádné události nebyly nalezeny.")).toBeTruthy();
});

test.each(["contacts", "events", "records"] as const)(
  "empty %s with more server results does not claim no matches",
  (kind) => {
    const props = {
      result: completed({ kind, items: [], hasMore: true }),
      disabled: false,
      onDecide: jest.fn(),
    };
    const ui = render(<ServiceActionCard {...props} language="en" />);
    expect(ui.getByText("No items in this part of the results.")).toBeTruthy();
    expect(ui.getByText("Partial results. Narrow your request.")).toBeTruthy();
    expect(ui.queryByText(/No (contacts|events|results) found\./)).toBeNull();
    expect(ui.queryAllByRole("button")).toHaveLength(0);
    ui.rerender(<ServiceActionCard {...props} language="cs" />);
    expect(
      ui.getByText("V této části výsledků nejsou žádné položky."),
    ).toBeTruthy();
    expect(ui.getByText("Jen část výsledků. Upřesni požadavek.")).toBeTruthy();
    expect(ui.queryAllByRole("button")).toHaveLength(0);
  },
);

test.each(["en", "cs"] as const)(
  "%s results keep their readable title and canonical state alongside an arbitrary badge",
  (language) => {
    const ui = render(
      <ServiceActionCard
        result={{
          ...completed(),
          title: "list-mail-messages",
          card: {
            id: "service-" + "b".repeat(32),
            revision: 1,
            title: "list-mail-messages",
            actions: [],
            root: ["state"],
            nodes: [
              {
                id: "state",
                type: "badge",
                label: "TEST state",
                tone: "success",
              },
            ],
          },
        }}
        language={language}
        disabled={false}
        onDecide={jest.fn()}
      />,
    );
    expect(ui.getByText("List mail messages")).toBeTruthy();
    expect(ui.queryByText("list-mail-messages")).toBeNull();
    expect(ui.getAllByText("TEST state")).toHaveLength(1);
    expect(
      ui.getAllByText(language === "cs" ? "Hotovo" : "Completed"),
    ).toHaveLength(1);
  },
);

const canonicalStates = {
  en: {
    // Awaiting approval states its effect; the buttons carry the rest.
    awaiting_approval: "Approving lets it change data.",
    running: "Running",
    succeeded: "Completed",
    failed: "Action failed",
    unknown: "Result unknown",
    rejected: "Cancelled",
  },
  cs: {
    awaiting_approval: "Po potvrzení změní data.",
    running: "Probíhá",
    succeeded: "Hotovo",
    failed: "Akce selhala",
    unknown: "Výsledek neznámý",
    rejected: "Zrušeno",
  },
};
const languages = ["en", "cs"] as const;
const statuses = Object.keys(SERVICE_CARD_STATES) as ServiceResult["status"][];

test.each(
  languages.flatMap((language) =>
    statuses.map((status) => [language, status] as const),
  ),
)(
  "%s %s generated cards render one canonical status, retain evidence and never decide on render",
  (language, status) => {
    const onDecide = jest.fn();
    const input: ServiceResult = {
      ...result,
      status,
      title: "list-mail-messages",
      fields: status === "failed" || status === "unknown" ? [] : result.fields,
      summary: status === "failed" ? "TEST recorded failure" : "",
      presentation: { kind: "text", text: "TEST recorded result" },
    };
    input.card = serviceCard(input, language);
    const saved = JSON.parse(JSON.stringify(input));
    const ui = render(
      <ServiceActionCard
        result={input}
        language={language}
        disabled={false}
        onDecide={onDecide}
      />,
    );
    expect(ui.getByText("List mail messages")).toBeTruthy();
    expect(ui.getAllByText(canonicalStates[language][status])).toHaveLength(1);
    const generatedLabel = SERVICE_CARD_STATES[status][language];
    if (generatedLabel !== canonicalStates[language][status])
      expect(ui.queryByText(generatedLabel)).toBeNull();
    expect(
      ui.queryByText(
        language === "cs"
          ? "Tuto kartu nelze zobrazit."
          : "This card can't be shown.",
      ),
    ).toBeNull();
    if (status === "succeeded")
      expect(ui.getByText("TEST recorded result")).toBeTruthy();
    else expect(ui.queryByText("TEST recorded result")).toBeNull();
    if (status === "failed")
      expect(ui.getByText("TEST recorded failure")).toBeTruthy();
    if (status === "unknown")
      expect(
        ui.getByText(
          language === "cs"
            ? "Před opakováním ověř výsledek ve službě."
            : "Check the result in the service before retrying.",
        ),
      ).toBeTruthy();
    if (status !== "awaiting_approval")
      expect(ui.queryByRole("button")).toBeNull();
    ui.rerender(
      <ServiceActionCard
        result={input}
        language={language}
        disabled={false}
        onDecide={onDecide}
      />,
    );
    expect(onDecide).not.toHaveBeenCalled();
    expect(input).toEqual(saved);
  },
);

test.each(
  languages.flatMap((language) =>
    (["failed", "unknown", "succeeded"] as const).flatMap((status) =>
      (["generated", "composed"] as const).map(
        (kind) => [language, status, kind] as const,
      ),
    ),
  ),
)(
  "%s %s canonical outcome stays visible with a conflicting %s badge",
  (language, status, kind) => {
    const stale =
      SERVICE_CARD_STATES[status === "succeeded" ? "failed" : "succeeded"];
    const card: CardDocument = {
      id: kind === "generated" ? "service-" + "c".repeat(32) : "TEST-composed",
      revision: 1,
      title: "TEST recorded context",
      actions: [],
      root: ["state", "context"],
      nodes: [
        {
          id: "state",
          type: "badge",
          label: stale[language],
          tone: stale.tone,
        },
        { id: "context", type: "text", text: "TEST retained body" },
      ],
    };
    const input = { ...completed(), status, effect: "write" as const, card };
    const saved = JSON.parse(JSON.stringify(input));
    const onDecide = jest.fn();
    const fetch = jest.spyOn(globalThis, "fetch");
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    const ui = render(
      <ServiceActionCard
        result={input}
        language={language}
        disabled={false}
        onDecide={onDecide}
      />,
    );
    expect(ui.getAllByText(canonicalStates[language][status])).toHaveLength(1);
    expect(ui.getByText("TEST retained body")).toBeTruthy();
    if (kind === "generated")
      expect(ui.queryByText(stale[language])).toBeNull();
    else expect(ui.getByText(stale[language])).toBeTruthy();
    expect(ui.queryByRole("button")).toBeNull();
    expect(onDecide).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(openURL).not.toHaveBeenCalled();
    expect(input).toEqual(saved);
  },
);

test.each(
  languages.flatMap((language) =>
    (["later badge", "different tone"] as const).map(
      (kind) => [language, kind] as const,
    ),
  ),
)(
  "%s generated cards preserve a %s alongside the canonical outcome",
  (language, kind) => {
    const state = SERVICE_CARD_STATES.succeeded;
    const card: CardDocument = {
      id: "service-" + "d".repeat(32),
      revision: 1,
      title: "TEST context",
      actions: [],
      root:
        kind === "later badge" ? ["context", "state"] : ["state", "context"],
      nodes: [
        { id: "context", type: "text", text: "TEST retained body" },
        {
          id: "state",
          type: "badge",
          label: state[language],
          tone: kind === "different tone" ? "info" : state.tone,
        },
      ],
    };
    const saved = JSON.parse(JSON.stringify(card));
    const onDecide = jest.fn();
    const ui = render(
      <ServiceActionCard
        result={{ ...completed(), status: "failed", card }}
        language={language}
        disabled={false}
        onDecide={onDecide}
      />,
    );
    expect(ui.getAllByText(canonicalStates[language].failed)).toHaveLength(1);
    expect(ui.getByText(state[language])).toBeTruthy();
    expect(ui.getByText("TEST retained body")).toBeTruthy();
    expect(ui.queryByRole("button")).toBeNull();
    expect(onDecide).not.toHaveBeenCalled();
    expect(card).toEqual(saved);
  },
);

test.each(languages)(
  "%s a composed badge cannot approve an action or replace authoritative review controls",
  (language) => {
    const card: CardDocument = {
      id: "TEST-review-context",
      revision: 1,
      title: "TEST untrusted title",
      actions: [],
      root: ["state", "context"],
      nodes: [
        { id: "state", type: "badge", label: "Completed", tone: "success" },
        { id: "context", type: "text", text: "TEST extra context" },
      ],
    };
    const input = { ...result, card };
    const saved = JSON.parse(JSON.stringify(input));
    const onDecide = jest.fn();
    const fetch = jest.spyOn(globalThis, "fetch");
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    const ui = render(
      <ServiceActionCard
        result={input}
        language={language}
        disabled={false}
        onDecide={onDecide}
      />,
    );
    expect(ui.getByText(result.title)).toBeTruthy();
    expect(ui.queryByText(card.title!)).toBeNull();
    expect(
      ui.getByText(canonicalStates[language].awaiting_approval),
    ).toBeTruthy();
    expect(ui.getByText(result.inputJson)).toBeTruthy();
    expect(ui.getByText("TEST")).toBeTruthy();
    fireEvent.press(
      ui.getByRole("button", {
        name: language === "cs" ? "Doplňující kontext" : "Additional context",
      }),
    );
    expect(ui.getByText("TEST extra context")).toBeTruthy();
    expect(ui.getByText("Completed")).toBeTruthy();
    expect(onDecide).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(openURL).not.toHaveBeenCalled();
    fireEvent.press(
      ui.getByRole("button", {
        name: language === "cs" ? "Potvrdit" : "Approve",
      }),
    );
    fireEvent.press(
      ui.getByRole("button", { name: language === "cs" ? "Zrušit" : "Cancel" }),
    );
    expect(onDecide.mock.calls).toEqual([[true], [false]]);
    ui.rerender(
      <ServiceActionCard
        result={input}
        language={language}
        disabled={false}
        onDecide={onDecide}
      />,
    );
    expect(onDecide.mock.calls).toEqual([[true], [false]]);
    expect(input).toEqual(saved);
  },
);
