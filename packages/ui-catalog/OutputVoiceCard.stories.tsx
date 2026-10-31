import React from "react";
import { View } from "react-native";
import type { Meta, StoryObj } from "@storybook/react-native";
import {
  OUTPUT_VOICE_PROFILE,
  type OutputVoiceSnapshot,
} from "../protocol/output-voice";
import { Group } from "../ui";
import { OutputVoiceCard } from "./OutputVoiceCard";
const snapshot: OutputVoiceSnapshot = {
  profile: OUTPUT_VOICE_PROFILE,
  scope: {
    connectionId: "storybook",
    serverId: "storybook",
    workspaceId: "storybook",
    userId: "storybook",
  },
  revision: 0,
  catalogueRevision: "a".repeat(64),
  availability: "selectable",
  route: { identity: "b".repeat(64), model: "Reader", method: "reader" },
  serverDefault: { label: "Cedar" },
  options: ["Alloy", "Echo", "Shimmer"].map((label, index) => ({
    label,
    optionId: `ov_${String(index + 1).repeat(64)}`,
  })),
  saved: null,
  effective: {
    choice: { kind: "server-default" },
    label: "Cedar",
    reason: "server-default",
  },
};
const meta = {
  title: "Voice/Output voice",
  component: OutputVoiceCard,
  args: {
    language: "en",
    snapshot,
    onOpen: () => {},
    onChoose: () => {},
    onReset: () => {},
  },
  decorators: [
    (Story) => (
      <View style={{ maxWidth: 520 }}>
        <Group>
          <Story />
        </Group>
      </View>
    ),
  ],
} satisfies Meta<typeof OutputVoiceCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ServerDefault: Story = {};
export const Selectable: Story = { args: { options: true } };
export const DefaultOnly: Story = {
  args: {
    snapshot: { ...snapshot, availability: "server-default-only", options: [] },
  },
};
export const Fallback: Story = {
  args: {
    snapshot: {
      ...snapshot,
      revision: 2,
      saved: {
        choice: { kind: "catalogue", optionId: `ov_${"d".repeat(64)}` },
        label: "Old voice",
      },
      effective: { ...snapshot.effective, reason: "saved-choice-unavailable" },
    },
  },
};
export const Unavailable: Story = {
  args: {
    snapshot: {
      ...snapshot,
      revision: 2,
      availability: "speech-unavailable",
      route: null,
      serverDefault: null,
      options: [],
      effective: {
        choice: { kind: "server-default" },
        label: "",
        reason: "speech-unavailable",
      },
    },
  },
};
export const Unsupported: Story = { args: { snapshot: null } };
export const Loading: Story = { args: { snapshot: undefined } };
export const Pending: Story = { args: { options: true, pending: true } };
export const Error: Story = {
  args: { options: true, issue: "outputVoiceSaveFailed" },
};
export const Uncertain: Story = {
  args: { options: true, issue: "outputVoiceUnknown", onRetry: () => {} },
};
export const CzechNarrow: Story = {
  args: { language: "cs", options: true },
  render: (args) => (
    <View style={{ width: 280 }}>
      <OutputVoiceCard {...args} />
    </View>
  ),
};
