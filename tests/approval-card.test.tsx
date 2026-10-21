import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import { ActionApprovalCard } from "../packages/ui-catalog/ActionApprovalCard";
import { choosePeter, meetingProposal } from "../packages/test-fixtures";
import type { Operation } from "../packages/protocol";
const props = () => ({
  proposal: meetingProposal(),
  contacts: choosePeter().input.options,
  operations: [],
  source: "fixture-local / a",
  language: "en" as const,
  onDecision: jest.fn(),
  onRevise: jest.fn(),
});
test("approval is passive until explicit confirmation and exposes all effect details", () => {
  const p = props();
  render(<ActionApprovalCard {...p} />);
  expect(p.onDecision).not.toHaveBeenCalled();
  expect(screen.queryByText(/fixture-local \/ a/)).toBeNull();
  fireEvent.press(
    screen.getByRole("button", { name: "Connection & version details" }),
  );
  expect(screen.getByText(/fixture-local \/ a/)).toBeTruthy();
  expect(screen.getByText("peter-novak@example.test")).toBeTruthy();
  expect(screen.getByText(/No real calendar or email/)).toBeTruthy();
  fireEvent.press(
    screen.getByRole("button", { name: "Confirm this meeting · Demo" }),
  );
  expect(p.onDecision).toHaveBeenCalledWith("approve", 1);
});
test("a new proposal revision requires reviewing the new details before confirmation", () => {
  const p = props();
  const { rerender } = render(<ActionApprovalCard {...p} />);
  const proposal = {
    ...p.proposal,
    revision: 2,
    parameters: {
      ...p.proposal.parameters,
      participant: {
        id: "peter-svoboda",
        label: "Peter Svoboda",
        email: "peter-svoboda@example.test",
      },
    },
  };
  rerender(<ActionApprovalCard {...p} proposal={proposal} />);
  fireEvent.press(
    screen.getByRole("button", { name: "Confirm this meeting · Demo" }),
  );
  expect(p.onDecision).not.toHaveBeenCalled();
  expect(screen.getByText("peter-svoboda@example.test")).toBeTruthy();
  fireEvent.press(
    screen.getByRole("button", { name: "Review current version" }),
  );
  fireEvent.press(
    screen.getByRole("button", { name: "Confirm this meeting · Demo" }),
  );
  expect(p.onDecision).toHaveBeenCalledWith("approve", 2);
});
test.each([
  { stale: true },
  { blocked: true },
  { state: "sending" as const },
  { state: "network_error" as const },
])("blocked approval cannot submit or revise: %j", (extra) => {
  const p = props();
  render(<ActionApprovalCard {...p} {...extra} />);
  fireEvent.press(
    screen.getByRole("button", { name: "Confirm this meeting · Demo" }),
  );
  fireEvent.press(screen.getByRole("button", { name: "Edit details" }));
  expect(p.onDecision).not.toHaveBeenCalled();
  expect(p.onRevise).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: "Save new proposal" }),
  ).toBeNull();
});
test("native date/time selection and revision-bound editing retain a draft across a server update", () => {
  const p = props();
  const { rerender } = render(<ActionApprovalCard {...p} />);
  fireEvent.press(screen.getByRole("button", { name: "Edit details" }));
  const date = new Date(2026, 9, 1, 15, 0);
  fireEvent(screen.getByLabelText("Date"), "change", {
    nativeEvent: { timestamp: date.getTime(), utcOffset: 0 },
  });
  fireEvent(screen.getByLabelText(/^Time · /), "change", {
    nativeEvent: { timestamp: date.getTime(), utcOffset: 0 },
  });
  fireEvent.press(screen.getByRole("button", { name: "Peter Svoboda" }));
  fireEvent.press(screen.getByRole("button", { name: "Save new proposal" }));
  expect(p.onRevise).toHaveBeenCalledWith(
    "peter-svoboda",
    date.toISOString(),
    1,
  );
  rerender(
    <ActionApprovalCard {...p} proposal={{ ...p.proposal, revision: 2 }} />,
  );
  expect(new Date(screen.getByLabelText("Date").props.date).getDate()).toBe(1);
  p.onRevise.mockClear();
  fireEvent.press(screen.getByRole("button", { name: "Save new proposal" }));
  expect(p.onRevise).not.toHaveBeenCalled();
});
test("approval acknowledgment does not falsely invalidate consent; pending edit binds the current revision", () => {
  const p = props();
  const { rerender } = render(<ActionApprovalCard {...p} />);
  const operation: Operation = {
    id: "op",
    revision: 1,
    workItemId: p.proposal.workItemId,
    conversationId: p.proposal.conversationId,
    proposalId: p.proposal.id,
    acceptedProposalRevision: 1,
    idempotencyKey: "approve",
    parameters: p.proposal.parameters,
    status: "pending",
    demo: true,
  };
  const approved = {
    ...p.proposal,
    revision: 2,
    status: "approved" as const,
    approval: { operationId: "op", proposalRevision: 1, commandId: "approve" },
  };
  rerender(
    <ActionApprovalCard {...p} proposal={approved} operations={[operation]} />,
  );
  expect(screen.queryByText(/The proposal changed/)).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "Edit details" }));
  fireEvent.press(screen.getByRole("button", { name: "Save new proposal" }));
  expect(p.onRevise).toHaveBeenCalledWith(
    "peter-novak",
    p.proposal.parameters.startsAt,
    2,
  );
  rerender(
    <ActionApprovalCard
      {...p}
      proposal={approved}
      operations={[{ ...operation, status: "executing" }]}
    />,
  );
  expect(
    screen.queryByRole("button", { name: "Save new proposal" }),
  ).toBeNull();
});
test("Czech rejection is explicit and leaves no approval control", () => {
  const p = props();
  render(
    <ActionApprovalCard
      {...p}
      language="cs"
      proposal={{ ...p.proposal, status: "rejected", revision: 2 }}
    />,
  );
  expect(screen.getByText(/Návrh byl odmítnut/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Potvrdit/ })).toBeNull();
  expect(p.onDecision).not.toHaveBeenCalled();
});

test.each(["en", "cs"] as const)(
  "%s calendar approval states the real effect and destination without executing on render",
  (language) => {
    const p = props();
    const proposal = {
      ...p.proposal,
      parameters: {
        ...p.proposal.parameters,
        calendar: {
          provider: "caldav" as const,
          integrationId: "local",
          label: "Agent Client Test",
          collectionUrl: "http://127.0.0.1:5232/test/",
          invitations: "none" as const,
        },
      },
    };
    render(
      <ActionApprovalCard {...p} language={language} proposal={proposal} />,
    );
    expect(screen.getByText(/Agent Client Test/)).toBeTruthy();
    expect(
      screen.getByText(proposal.parameters.calendar.collectionUrl),
    ).toBeTruthy();
    expect(
      screen.getByText(
        language === "en" ? /creates a real event/ : /vznikne skutečná událost/,
      ),
    ).toBeTruthy();
    expect(p.onDecision).not.toHaveBeenCalled();
    fireEvent.press(
      screen.getByRole("button", {
        name:
          language === "en"
            ? "Create event in test calendar"
            : "Vytvořit událost v testovacím kalendáři",
      }),
    );
    expect(p.onDecision).toHaveBeenCalledWith("approve", 1);
  },
);

test("unknown calendar result offers explicit reconciliation of the same operation", () => {
  const p = props();
  const op: Operation = {
    id: "op",
    revision: 3,
    workItemId: p.proposal.workItemId,
    conversationId: p.proposal.conversationId,
    proposalId: p.proposal.id,
    acceptedProposalRevision: 1,
    idempotencyKey: "approve",
    demo: true,
    status: "result_unknown",
    error: "retry_exhausted",
    parameters: {
      ...p.proposal.parameters,
      calendar: {
        provider: "caldav",
        integrationId: "local",
        label: "Test",
        collectionUrl: "http://127.0.0.1:5232/test/",
        invitations: "none",
      },
    },
  };
  const check = jest.fn();
  render(
    <ActionApprovalCard
      {...p}
      proposal={{
        ...p.proposal,
        revision: 2,
        status: "approved",
        parameters: op.parameters,
        approval: {
          operationId: op.id,
          proposalRevision: 1,
          commandId: "approve",
        },
      }}
      operations={[op]}
      onReconcile={check}
    />,
  );
  expect(check).not.toHaveBeenCalled();
  expect(screen.queryByText(/event was read back/)).toBeNull();
  fireEvent.press(
    screen.getByRole("button", { name: "Check the same calendar event" }),
  );
  expect(check).toHaveBeenCalledWith(op);
});
