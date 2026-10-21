import type { Meta, StoryObj } from "@storybook/react-native";
import React, { useState } from "react";
import { View } from "react-native";
import type { ActivityWorkflow } from "../protocol/activity";
import {
  requestActivity,
  pluginActivity,
  workflowActivity,
} from "../test-fixtures";
import { Button } from "../ui";
import { RequestProgressCard } from "./RequestProgressCard";
const activity = requestActivity();
const meta = {
  title: "Workflow/Request progress",
  component: RequestProgressCard,
  args: { activity, language: "en" },
} satisfies Meta<typeof RequestProgressCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Searching: Story = {};
const workflowStages: ActivityWorkflow[] = [
  { step: 1, stage: "service" },
  { step: 1, stage: "action" },
  { step: 1, stage: "inputs" },
  { step: 1, stage: "execute" },
  { step: 2, stage: "service" },
  { step: 2, stage: "action" },
  { step: 2, stage: "inputs" },
  { step: 2, stage: "execute" },
  { step: 5, stage: "execute" },
];
function WorkflowSequence(
  args: React.ComponentProps<typeof RequestProgressCard>,
) {
  const [index, setIndex] = useState(0);
  const activity = workflowActivity(workflowStages[index]!);
  const final = index === workflowStages.length - 1;
  return (
    <View style={{ gap: 16 }}>
      <RequestProgressCard {...args} activity={activity} />
      <Button
        label={
          args.language === "cs"
            ? final
              ? "Znovu"
              : "Další fáze"
            : final
              ? "Restart"
              : "Next stage"
        }
        onPress={() =>
          setIndex((current) => (current + 1) % workflowStages.length)
        }
      />
    </View>
  );
}
export const MultiStepWorkflow: Story = { render: WorkflowSequence };
export const MultiStepWorkflowCzech: Story = {
  args: { language: "cs" },
  render: WorkflowSequence,
};
export const WorkflowWithDateCalculation: Story = {
  args: {
    activity: {
      ...workflowActivity({ step: 2, stage: "inputs" }),
      tools: pluginActivity().tools,
    },
    language: "cs",
  },
};
export const WorkflowConnectionLost: Story = {
  args: {
    activity: workflowActivity({ step: 2, stage: "execute" }),
    connection: "unavailable",
  },
};
export const CalculatingDate: Story = {
  args: { activity: pluginActivity(), language: "cs" },
};
export const DateCalculated: Story = {
  args: { activity: pluginActivity("succeeded"), language: "cs" },
};
export const DateNeedsInput: Story = {
  args: { activity: pluginActivity("needs_input"), language: "cs" },
};
export const DateConnectionLost: Story = {
  args: { activity: pluginActivity(), connection: "unavailable" },
};
export const Czech: Story = { args: { language: "cs" } };
export const Sending: Story = {
  args: { activity: null, connection: "waiting" },
};
export const ConnectionLost: Story = { args: { connection: "unavailable" } };
export const Failed: Story = {
  args: {
    activity: {
      ...activity,
      status: "failed",
      steps: activity.steps.map((step) =>
        step.status === "running" ? { ...step, status: "failed" } : step,
      ),
    },
  },
};
export const Ready: Story = {
  args: {
    activity: {
      ...activity,
      status: "succeeded",
      steps: activity.steps.map((step) => ({ ...step, status: "succeeded" })),
    },
  },
};
export const PreparingVoiceCzech: Story = {
  args: {
    language: "cs",
    voice: true,
    activity: {
      ...activity,
      status: "succeeded",
      steps: activity.steps.map((step) => ({ ...step, status: "succeeded" })),
    },
  },
};
