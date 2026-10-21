import type { Meta, StoryObj } from "@storybook/react-native";
import React from "react";
import { View } from "react-native";
import { ProcessApprovalRecoveryCard } from "./ProcessApprovalRecoveryCard";
import { translate } from "../i18n";

const meta = {
  title: "Workflow/Saved process decision",
  component: ProcessApprovalRecoveryCard,
  args: {
    language: "en",
    outcome: "unknown",
    canRetry: true,
    onRetry: () => {},
    review: {
      title: "TEST Create original project A",
      service: "TEST Project tracker",
      approved: true,
      effect: "write",
      frame: {
        source: "https://TEST-server.example.test/v1/TEST-workspace",
        workspace: "TEST-workspace",
        conversationId: "TEST-conversation-A",
        language: "en",
        nativeRevision: 7,
        serviceId: "TEST-project-service",
        serviceRevision: 2,
        actionId: "TEST-create-project",
        actionRevision: 4,
      },
      result: {
        type: "service.action",
        version: 1,
        operationId: "TEST-operation-A",
        title: "TEST Create original project A",
        service: "TEST Project tracker",
        status: "awaiting_approval",
        effect: "write",
        fields: [{ label: "name", value: "TEST Original project A" }],
        inputJson: JSON.stringify(
          {
            name: "  TEST Original project A\n",
            enabled: false,
            cleared: null,
            amount: 0,
            reviewers: ["second", "first"],
          },
          null,
          2,
        ),
        reviewTruncated: false,
        summary: "",
      },
    },
  },
} satisfies Meta<typeof ProcessApprovalRecoveryCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const OriginalDecisionUnknown: Story = {};
export const OriginalDecisionUnknownCzech: Story = { args: { language: "cs" } };
export const ExecutionDetailsUnverified: Story = {
  args: { explanation: translate("en")("savedProcessExecutionUnverified") },
};
export const ExecutionDetailsUnverifiedCzechNarrow: Story = {
  render: (args) => (
    <View style={{ width: 320, maxWidth: "100%" }}>
      <ProcessApprovalRecoveryCard {...args} />
    </View>
  ),
  args: {
    language: "cs",
    explanation: translate("cs")("savedProcessExecutionUnverified"),
  },
};
export const KnownAcceptedSavingOffline: Story = {
  args: { outcome: "accepted", explanation: "TEST Local saving failed." },
};
export const KnownRejectedSavingCzech: Story = {
  args: {
    language: "cs",
    outcome: "rejected",
    explanation: "TEST Oprávnění služby se změnila.",
    review: { ...meta.args.review, approved: false },
  },
};
export const LegacyParametersUnavailable: Story = {
  args: {
    review: {
      ...meta.args.review,
      result: undefined,
      frame: {
        source: meta.args.review.frame.source,
        workspace: meta.args.review.frame.workspace,
        conversationId: meta.args.review.frame.conversationId,
        language: "en",
        nativeRevision: 7,
      },
    },
  },
};
export const ProofUnavailableCzech: Story = {
  args: { language: "cs", review: undefined, canRetry: false },
};
export const OneRetryInFlight: Story = { args: { retrying: true } };
export const NarrowLongParameters: Story = {
  render: (args) => (
    <View style={{ width: 320, maxWidth: "100%" }}>
      <ProcessApprovalRecoveryCard {...args} />
    </View>
  ),
  args: {
    review: {
      ...meta.args.review,
      result: {
        ...meta.args.review.result,
        inputJson: JSON.stringify({
          name: "TEST_original_long_parameter_".repeat(100),
          description: "TEST original context. ".repeat(100),
          enabled: false,
          cleared: null,
          reviewers: ["second", "first"],
        }),
      },
    },
  },
};
