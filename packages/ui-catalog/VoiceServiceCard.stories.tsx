import React from "react";
import { View } from "react-native";
import type { Meta, StoryObj } from "@storybook/react-native";
import { voiceCapabilities } from "../protocol/voice";
import { VoiceServiceCard } from "./VoiceServiceCard";
const meta = {
  title: "Voice/Transcription service",
  component: VoiceServiceCard,
  args: { language: "en", capabilities: voiceCapabilities(true, "openrouter") },
} satisfies Meta<typeof VoiceServiceCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Cloud: Story = {};
export const Local: Story = { args: { capabilities: voiceCapabilities(true) } };
export const Checking: Story = { args: { capabilities: undefined } };
export const Unavailable: Story = { args: { capabilities: null } };
export const Expired: Story = {
  args: { capabilities: voiceCapabilities(false, "openrouter") },
};
export const CzechNarrow: Story = {
  args: { language: "cs" },
  render: (args) => (
    <View style={{ width: 280 }}>
      <VoiceServiceCard {...args} />
    </View>
  ),
};
