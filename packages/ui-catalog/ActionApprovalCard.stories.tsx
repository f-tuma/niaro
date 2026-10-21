import React, { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-native";
import { choosePeter, meetingProposal } from "../test-fixtures";
import { Button, Stack } from "../ui";
import type { Operation } from "../protocol";
import { ActionApprovalCard } from "./ActionApprovalCard";
const proposal = meetingProposal();
const meta = {
  title: "Work/ActionApprovalCard",
  component: ActionApprovalCard,
  args: {
    proposal,
    contacts: choosePeter().input.options,
    operations: [],
    source: "fixture-local / a",
    language: "en",
    onDecision: () => {},
    onRevise: () => {},
  },
} satisfies Meta<typeof ActionApprovalCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const AwaitingApproval: Story = {};
export const Czech: Story = {
  args: { proposal: meetingProposal("cs"), language: "cs" },
};
export const Offline: Story = { args: { stale: true } };
export const UncertainDelivery: Story = { args: { state: "network_error" } };
export const Conflict: Story = { args: { state: "conflict" } };
const operation: Operation = {
  id: "operation-1",
  revision: 1,
  workItemId: proposal.workItemId,
  conversationId: proposal.conversationId,
  proposalId: proposal.id,
  acceptedProposalRevision: 1,
  idempotencyKey: "approval-1",
  parameters: proposal.parameters,
  status: "pending",
  demo: true,
};
const approved = {
  ...proposal,
  revision: 2,
  status: "approved" as const,
  approval: {
    operationId: operation.id,
    commandId: "approval-1",
    proposalRevision: 1,
  },
};
export const Pending: Story = {
  args: { proposal: approved, operations: [operation] },
};
export const Executing: Story = {
  args: {
    proposal: approved,
    operations: [{ ...operation, status: "executing" }],
  },
};
export const Completed: Story = {
  args: {
    proposal: approved,
    operations: [
      {
        ...operation,
        status: "succeeded",
        result: { kind: "simulated", reference: "demo-event-1" },
      },
    ],
  },
};
export const Failed: Story = {
  args: {
    proposal: approved,
    operations: [{ ...operation, status: "failed" }],
  },
};
export const UnknownResult: Story = {
  args: {
    proposal: approved,
    operations: [{ ...operation, status: "result_unknown" }],
  },
};
export const Rejected: Story = {
  args: { proposal: { ...proposal, revision: 2, status: "rejected" } },
};
const calendar = {
  provider: "caldav" as const,
  integrationId: "radicale-local",
  label: "Agent Client Test",
  collectionUrl: "http://127.0.0.1:5232/agent-test/meetings/",
  invitations: "none" as const,
};
export const CalendarReview: Story = {
  args: {
    proposal: { ...proposal, parameters: { ...proposal.parameters, calendar } },
  },
};
export const CalendarReviewCzech: Story = {
  args: { ...CalendarReview.args, language: "cs" },
};
export const ChatProposal: Story = {
  args: { ...CalendarReview.args, compact: true, timeZone: "Europe/Prague" },
};
export const ChatProposalCzech: Story = {
  args: { ...ChatProposal.args, language: "cs" },
};
export const ChatDemo: Story = {
  args: { compact: true, timeZone: "Europe/Prague" },
};
export const CalendarVerified: Story = {
  args: {
    proposal: { ...approved, parameters: { ...approved.parameters, calendar } },
    operations: [
      {
        ...operation,
        parameters: { ...operation.parameters, calendar },
        status: "succeeded",
        result: {
          kind: "calendar",
          reference: "agent-example-event",
          etag: '"etag"',
          verifiedAt: "2026-09-24T10:00:00.000Z",
        },
      },
    ],
  },
};
export const CalendarUncertain: Story = {
  args: {
    proposal: { ...approved, parameters: { ...approved.parameters, calendar } },
    operations: [
      {
        ...operation,
        parameters: { ...operation.parameters, calendar },
        status: "result_unknown",
        error: "retry_exhausted",
      },
    ],
    onReconcile: () => {},
  },
};
export const ChatUncertain: Story = {
  args: { ...CalendarUncertain.args, compact: true },
};
export const UpdatedWhileReviewing: Story = {
  render: function Updated(args) {
    const [current, setCurrent] = useState(args.proposal);
    return (
      <Stack>
        <Button
          label="Simulate changed time"
          onPress={() =>
            setCurrent({
              ...current,
              revision: current.revision + 1,
              parameters: {
                ...current.parameters,
                startsAt: "2026-09-30T14:00:00.000Z",
                endsAt: "2026-09-30T14:30:00.000Z",
              },
            })
          }
        />
        <ActionApprovalCard {...args} proposal={current} />
      </Stack>
    );
  },
};
