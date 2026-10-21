import type { Meta, StoryObj } from "@storybook/react-native";
import React from "react";
import { View } from "react-native";
import { WorkItemSchema, type Language } from "../protocol";
import {
  nativeTaskQuestion,
  nativeTaskApproval,
  choosePeter,
  processTaskResult,
  processTaskQuestion,
} from "../test-fixtures";
import { WorkItemCard } from "./WorkItemCard";
const fixture = choosePeter();
const meta = {
  title: "Work/WorkItemCard",
  component: WorkItemCard,
  args: { ...fixture, language: "en", onAnswer: () => {}, onReply: () => {} },
} satisfies Meta<typeof WorkItemCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const NeedsInput: Story = {};
export const ChatChoice: Story = { args: { compact: true } };
export const ChatChoiceCzech: Story = {
  args: { ...choosePeter("cs"), language: "cs", compact: true },
};
export const Czech: Story = { args: { ...choosePeter("cs"), language: "cs" } };
export const Running: Story = {
  args: {
    input: undefined,
    work: { ...fixture.work, status: "running", revision: 2 },
  },
};
export const Completed: Story = {
  args: {
    input: undefined,
    work: { ...fixture.work, status: "succeeded", revision: 3 },
  },
};
export const Failed: Story = {
  args: {
    input: undefined,
    work: { ...fixture.work, status: "failed", revision: 3 },
  },
};

export const NativeQuestion: Story = {
  args: {
    input: undefined,
    compact: true,
    work: nativeTaskQuestion(),
    onReply: () => {},
  },
};
export const NativeQuestionCzech: Story = {
  args: {
    input: undefined,
    compact: true,
    work: nativeTaskQuestion("cs"),
    language: "cs",
    onReply: () => {},
  },
};
export const NativeApproval: Story = {
  args: {
    input: undefined,
    compact: true,
    work: nativeTaskApproval(),
    onNativeDecision: () => {},
  },
};
export const NativeApprovalCzech: Story = {
  args: {
    input: undefined,
    compact: true,
    work: nativeTaskApproval("cs"),
    language: "cs",
    onNativeDecision: () => {},
  },
};
export const ProcessFailedAfterWrite: Story = {
  args: { input: undefined, compact: true, work: processTaskResult() },
};
export const ProcessFailedAfterWriteCzech: Story = {
  args: {
    input: undefined,
    compact: true,
    language: "cs",
    work: processTaskResult("cs"),
  },
};
export const ProcessUnknown: Story = {
  args: {
    input: undefined,
    compact: true,
    work: processTaskResult("en", "unknown"),
  },
};
export const ProcessCancelled: Story = {
  args: {
    input: undefined,
    compact: true,
    language: "cs",
    work: processTaskResult("cs", "cancelled"),
  },
};
export const ProcessCompleted: Story = {
  args: {
    input: undefined,
    compact: true,
    work: processTaskResult("en", "succeeded"),
  },
};
export const ProcessQuestion: Story = {
  args: {
    input: undefined,
    compact: true,
    work: processTaskQuestion(),
    onReply: () => {},
  },
};
export const ProcessQuestionCzech: Story = {
  args: {
    input: undefined,
    compact: true,
    language: "cs",
    work: processTaskQuestion("cs"),
    onReply: () => {},
  },
};
export const ProcessQuestionStale: Story = {
  args: {
    input: undefined,
    compact: true,
    work: processTaskQuestion(),
    stale: true,
    onReply: () => {},
  },
};
export const ProcessQuestionWithoutCard: Story = {
  args: {
    input: undefined,
    compact: true,
    work: processTaskQuestion("en", false),
    onReply: () => {},
  },
};

function processApprovalWork(language: Language = "en") {
  const work = processTaskQuestion(language, false);
  const cs = language === "cs";
  const result = {
    type: "service.action",
    version: 1,
    operationId: "TEST-approval",
    title: cs ? "Založit projekt" : "Create project",
    service: "TEST Project tracker",
    status: "awaiting_approval",
    effect: "write",
    fields: [{ label: "name", value: "TEST Website" }],
    inputJson: JSON.stringify({
      name: "TEST Website",
      description: "TEST Original description. ".repeat(60),
      enabled: false,
      cleared: null,
      reviewers: ["first", " second "],
    }),
    reviewTruncated: false,
    summary: "",
  };
  return WorkItemSchema.parse({
    ...work,
    title: cs ? "TEST Založení projektu" : "TEST Project creation",
    context: cs
      ? "Proces čeká na tvé rozhodnutí."
      : "The process awaits your decision.",
    status: "waiting_approval",
    native: {
      ...work.native,
      process: {
        ...work.native!.process,
        question: undefined,
        approval: {
          nodeId: "TEST-create-step",
          serviceId: "TEST-project-service",
          serviceRevision: 2,
          actionId: "TEST-create-project",
          actionRevision: 4,
          result,
        },
        receipts: [
          {
            operationId: result.operationId,
            title: result.title,
            service: result.service,
            status: result.status,
            effect: result.effect,
            summary: "",
          },
        ],
      },
    },
  });
}
export const ProcessApprovalNarrow: Story = {
  render: (args) => (
    <View style={{ width: 320, maxWidth: "100%" }}>
      <WorkItemCard {...args} />
    </View>
  ),
  args: {
    input: undefined,
    work: processApprovalWork(),
    compact: true,
    source: "https://TEST-server.example.test",
    workspace: "TEST-workspace",
    onProcessDecision: () => {},
  },
};
export const ProcessApprovalNarrowCzech: Story = {
  ...ProcessApprovalNarrow,
  args: {
    ...ProcessApprovalNarrow.args,
    language: "cs",
    work: processApprovalWork("cs"),
  },
};
export const ProcessApprovalStale: Story = {
  ...ProcessApprovalNarrow,
  args: { ...ProcessApprovalNarrow.args, stale: true },
};
export const ProcessApprovalSending: Story = {
  ...ProcessApprovalNarrow,
  args: { ...ProcessApprovalNarrow.args, approvalState: "sending" },
};
export const ProcessApprovalUnavailable: Story = {
  ...ProcessApprovalNarrowCzech,
  args: {
    ...ProcessApprovalNarrowCzech.args,
    work: (() => {
      const work = processApprovalWork("cs");
      return {
        ...work,
        native: {
          ...work.native!,
          process: {
            ...work.native!.process!,
            approval: undefined,
            approvalUnavailable: "parameters" as const,
          },
        },
      };
    })(),
  },
};
