import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import { InputRequestForm } from "../packages/ui-catalog/InputRequestForm";
import { ActionApprovalCard } from "../packages/ui-catalog/ActionApprovalCard";
import { WorkItemCard } from "../packages/ui-catalog/WorkItemCard";
import {
  nativeTaskQuestion,
  nativeTaskApproval,
  choosePeter,
  meetingProposal,
} from "../packages/test-fixtures";
import { translate } from "../packages/i18n";

test("opening a failed native task exposes its formatted reason", () => {
  const work = nativeTaskQuestion();
  work.status = "failed";
  work.native!.question = undefined;
  work.result = "**Task search failed.** The action is unavailable.";
  render(
    <WorkItemCard work={work} language="en" compact onAnswer={() => {}} />,
  );
  expect(screen.getByText("Task search failed.")).toBeTruthy();
  expect(screen.getByText(/The action is unavailable/)).toBeTruthy();
});

test("explicit native retry is offered only on a failed or cancelled task with a source command", () => {
  const work = nativeTaskQuestion();
  work.status = "failed";
  work.native!.question = undefined;
  work.native!.sourceCommandId = "TEST-source-command";
  const onRetryNative = jest.fn();
  const props = {
    work,
    language: "en" as const,
    compact: true,
    onAnswer: () => {},
    onRetryNative,
  };
  const { rerender } = render(<WorkItemCard {...props} />);
  const retry = screen.getByRole("button", {
    name: translate("en")("retryFailedTask"),
  });
  fireEvent.press(retry);
  expect(onRetryNative).toHaveBeenCalledTimes(1);
  rerender(<WorkItemCard {...props} stale />);
  expect(
    screen.getByRole("button", {
      name: translate("en")("retryFailedTask"),
    }).props.accessibilityState.disabled,
  ).toBe(true);
  work.status = "cancelled";
  rerender(<WorkItemCard {...props} />);
  expect(
    screen.getByRole("button", {
      name: translate("en")("retryFailedTask"),
    }),
  ).toBeTruthy();
});

test("a failed native task explains when its original request is unavailable", () => {
  const work = nativeTaskQuestion();
  work.status = "failed";
  work.native!.question = undefined;
  work.native!.sourceCommandId = "TEST-source-command";
  render(
    <WorkItemCard
      work={work}
      language="en"
      compact
      onAnswer={() => {}}
      retryUnavailable
    />,
  );
  expect(
    screen.getByText(translate("en")("retrySourceUnavailable")),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", {
      name: translate("en")("retryFailedTask"),
    }),
  ).toBeNull();
});

test.each(["en", "cs"] as const)(
  "%s inline contact choice sends one revision-bound answer without another menu or submit step",
  (language) => {
    const { input, work } = choosePeter(language);
    const onAnswer = jest.fn();
    render(
      <WorkItemCard
        compact
        work={work}
        input={input}
        language={language}
        onAnswer={onAnswer}
      />,
    );
    expect(screen.getAllByText(input.question)).toHaveLength(1);
    expect(screen.queryByRole("radio")).toBeNull();
    expect(
      screen.queryByRole("button", { name: translate(language)("sendAnswer") }),
    ).toBeNull();
    expect(onAnswer).not.toHaveBeenCalled();
    fireEvent.press(
      screen.getByRole("button", {
        name: "Peter Svoboda, Northstar · Engineering",
      }),
    );
    expect(onAnswer.mock.calls).toEqual([["peter-svoboda", input.revision]]);
  },
);

test.each([
  { stale: true },
  { blocked: true },
  { state: "sending" as const },
  { state: "network_error" as const },
  { state: "accepted" as const },
])("inline choices cannot submit while unavailable: %j", (extra) => {
  const onAnswer = jest.fn();
  render(
    <InputRequestForm
      input={choosePeter().input}
      language="en"
      compact
      onAnswer={onAnswer}
      {...extra}
    />,
  );
  fireEvent.press(
    screen.getByRole("button", {
      name: "Peter Svoboda, Northstar · Engineering",
    }),
  );
  expect(onAnswer).not.toHaveBeenCalled();
});

test("a changed inline question requires current choices; expansion never answers", () => {
  const input = choosePeter().input;
  input.options = Array.from({ length: 5 }, (_, i) => ({
    id: `contact-${i}`,
    label: `TEST Person ${i}`,
    detail: `person${i}@example.test`,
  }));
  const onAnswer = jest.fn(),
    onExpand = jest.fn();
  const props = {
    input,
    language: "en" as const,
    compact: true,
    onAnswer,
    onExpand,
  };
  const { rerender } = render(<InputRequestForm {...props} />);
  expect(screen.queryByText("TEST Person 4")).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "More contacts" }));
  expect(screen.getByText("TEST Person 4")).toBeTruthy();
  expect(onExpand).toHaveBeenCalledTimes(1);
  expect(onAnswer).not.toHaveBeenCalled();
  rerender(<InputRequestForm {...props} input={{ ...input, revision: 2 }} />);
  fireEvent.press(
    screen.getByRole("button", { name: "TEST Person 4, person4@example.test" }),
  );
  expect(onAnswer).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole("button", { name: "Refresh" }));
  fireEvent.press(
    screen.getByRole("button", { name: "TEST Person 4, person4@example.test" }),
  );
  expect(onAnswer).toHaveBeenCalledWith("contact-4", 2);
});

const props = (language: "en" | "cs" = "en") => {
  const proposal = meetingProposal(language);
  return {
    proposal: {
      ...proposal,
      parameters: {
        ...proposal.parameters,
        startsAt: "2026-09-27T12:00:00.000Z",
        endsAt: "2026-09-27T12:45:00.000Z",
        calendar: {
          provider: "caldav" as const,
          integrationId: "local",
          label: "Agent Client Test",
          collectionUrl: "http://127.0.0.1:5232/test/",
          invitations: "none" as const,
        },
      },
    },
    contacts: choosePeter().input.options,
    operations: [],
    source: "fixture-local / a",
    language,
    compact: true,
    timeZone: "Europe/Prague",
    onDecision: jest.fn(),
    onRevise: jest.fn(),
    onExpand: jest.fn(),
  };
};
test.each(["en", "cs"] as const)(
  "%s compact approval keeps person, date/time, target and real effect visible; extra information expands in place",
  (language) => {
    const p = props(language),
      tr = translate(language);
    render(<ActionApprovalCard {...p} />);
    expect(screen.getByText("peter-novak@example.test")).toBeTruthy();
    expect(screen.getByText("Agent Client Test")).toBeTruthy();
    expect(screen.getByText(tr("calendarEffectShort"))).toBeTruthy();
    expect(screen.getByText(/45\s?min/)).toBeTruthy();
    expect(
      screen.queryByText(p.proposal.parameters.calendar.collectionUrl),
    ).toBeNull();
    fireEvent.press(screen.getByRole("button", { name: tr("meetingDetails") }));
    expect(
      screen.getByText(p.proposal.parameters.calendar.collectionUrl),
    ).toBeTruthy();
    expect(p.onExpand).toHaveBeenCalled();
    expect(p.onDecision).not.toHaveBeenCalled();
    fireEvent.press(
      screen.getByRole("button", { name: tr("approveCalendarShort") }),
    );
    expect(p.onDecision.mock.calls).toEqual([["approve", p.proposal.revision]]);
  },
);
test("inline edit remains a local draft until saved and preserves revision protection", () => {
  const p = props();
  const { rerender } = render(<ActionApprovalCard {...p} />);
  fireEvent.press(screen.getByRole("button", { name: "Edit" }));
  const selected = new Date(2026, 8, 27, 13, 30);
  fireEvent(screen.getByLabelText(/^Time · /), "change", {
    nativeEvent: { timestamp: selected.getTime(), utcOffset: 0 },
  });
  expect(p.onRevise).not.toHaveBeenCalled();
  expect(p.onDecision).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole("button", { name: "Save new proposal" }));
  expect(p.onRevise).toHaveBeenCalledWith(
    "peter-novak",
    selected.toISOString(),
    1,
  );
  rerender(
    <ActionApprovalCard {...p} proposal={{ ...p.proposal, revision: 2 }} />,
  );
  p.onRevise.mockClear();
  fireEvent.press(screen.getByRole("button", { name: "Save new proposal" }));
  expect(p.onRevise).not.toHaveBeenCalled();
});
test("compact rendering does not turn a demo into a real calendar action", () => {
  const p = props();
  render(<ActionApprovalCard {...p} proposal={meetingProposal()} />);
  expect(
    screen.getByText("Demo only. No calendar or email changes."),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Create event" })).toBeNull();
  expect(screen.getByRole("button", { name: "Confirm · Demo" })).toBeTruthy();
  expect(p.onDecision).not.toHaveBeenCalled();
});

test.each(["en", "cs"] as const)(
  "%s native task question uses its own context and only offers explicit reply",
  (language) => {
    const work = nativeTaskQuestion(language),
      onReply = jest.fn(),
      onAnswer = jest.fn();
    render(
      <WorkItemCard
        compact
        work={work}
        language={language}
        onAnswer={onAnswer}
        onReply={onReply}
      />,
    );
    expect(screen.getAllByText(work.native!.question!.question)).toHaveLength(
      1,
    );
    expect(onReply).not.toHaveBeenCalled();
    expect(onAnswer).not.toHaveBeenCalled();
    fireEvent.press(
      screen.getByRole("button", { name: translate(language)("replyInChat") }),
    );
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(onAnswer).not.toHaveBeenCalled();
  },
);
test.each(["en", "cs"] as const)(
  "%s native task approval uses the shared service confirmation frame",
  (language) => {
    const work = nativeTaskApproval(language),
      onNativeDecision = jest.fn();
    const props = {
      compact: true,
      work,
      language,
      onAnswer: jest.fn(),
      onNativeDecision,
    };
    const { rerender } = render(<WorkItemCard {...props} />);
    expect(onNativeDecision).not.toHaveBeenCalled();
    expect(screen.getByText("jane@example.test")).toBeTruthy();
    fireEvent.press(
      screen.getByRole("button", {
        name: translate(language)("serviceApprove"),
      }),
    );
    expect(onNativeDecision.mock.calls).toEqual([[true]]);
    rerender(<WorkItemCard {...props} stale />);
    fireEvent.press(
      screen.getByRole("button", {
        name: translate(language)("serviceApprove"),
      }),
    );
    expect(onNativeDecision).toHaveBeenCalledTimes(1);
  },
);
