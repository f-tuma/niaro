import React from "react";
import { View } from "react-native";
import type { Meta, StoryObj } from "@storybook/react-native";
import { choosePeter, meetingProposal } from "../test-fixtures";
import { WorkItemSummary } from "./WorkItemSummary";
const fixture = choosePeter();
const meta = {
  title: "Work/WorkItemSummary",
  component: WorkItemSummary,
  args: { ...fixture, language: "en", onOpen: () => {} },
} satisfies Meta<typeof WorkItemSummary>;
export default meta;
type Story = StoryObj<typeof meta>;
export const NeedsInput: Story = {};
export const Czech: Story = { args: { ...choosePeter("cs"), language: "cs" } };
export const Approval: Story = {
  args: {
    input: undefined,
    proposal: meetingProposal(),
    work: { ...fixture.work, status: "waiting_approval" },
  },
};
export const Completed: Story = {
  args: { input: undefined, work: { ...fixture.work, status: "succeeded" } },
};
export const UpdatedMeeting: Story = {
  args: {
    input: undefined,
    language: "en",
    timeZone: "Europe/Prague",
    work: {
      ...fixture.work,
      status: "waiting_approval",
      title: "Product review",
    },
    proposal: {
      ...meetingProposal(),
      revision: 2,
      parameters: {
        ...meetingProposal().parameters,
        startsAt: "2026-09-30T13:00:00Z",
        endsAt: "2026-09-30T13:45:00Z",
      },
    },
  },
};
export const UpdatedMeetingCzechNarrow: Story = {
  ...UpdatedMeeting,
  args: {
    ...UpdatedMeeting.args,
    language: "cs",
    work: {
      ...fixture.work,
      status: "waiting_approval",
      title: "Příprava prezentace s týmem",
    },
  },
  decorators: [
    (Story) => (
      <View style={{ width: 240 }}>
        <Story />
      </View>
    ),
  ],
};
export const Failed: Story = {
  args: { input: undefined, work: { ...fixture.work, status: "failed" } },
};
export const LongText: Story = {
  args: {
    work: {
      ...fixture.work,
      title:
        "Review the proposed meeting with the international product and engineering team",
    },
    input: {
      ...fixture.input,
      question:
        "Which of the contacts from your workspace should be invited to the meeting next week? Review the full contact details before sending your answer.",
    },
  },
};
