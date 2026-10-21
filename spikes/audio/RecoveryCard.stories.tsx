import type { Meta, StoryObj } from "@storybook/react-native";
import { RecoveryCard } from "./RecoveryCard";
const meta = {
  title: "Audio spike/Recovery",
  component: RecoveryCard,
  args: {
    language: "en",
    candidate: {
      uri: "file:///documents/Audio/recording-00000000-0000-0000-0000-000000000001.m4a",
      bytes: 48000,
      reason: "unfinished",
      status: "unchecked",
    },
    onCheck: () => {},
    onRecover: () => {},
    onIgnore: () => {},
  },
} satisfies Meta<typeof RecoveryCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Unfinished: Story = {};
export const Ready: Story = {
  args: {
    candidate: {
      ...meta.args.candidate,
      status: "ready",
      durationMillis: 4000,
    },
  },
};
export const UnreadableCS: Story = {
  args: {
    language: "cs",
    candidate: { ...meta.args.candidate, status: "unreadable" },
  },
};
export const Missing: Story = {
  args: { candidate: { ...meta.args.candidate, bytes: 0, status: "missing" } },
};
export const Unindexed: Story = {
  args: { candidate: { ...meta.args.candidate, reason: "unindexed" } },
};
