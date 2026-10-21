import React, { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-native";
import { Animated, View } from "react-native";
import { VoiceOrb } from "./VoiceOrb";
/** A synthetic level so the live state can be judged without a microphone. */
function Live(props: React.ComponentProps<typeof VoiceOrb>) {
  const [level] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const timer = setInterval(
      () => level.setValue(Math.abs(Math.sin(Date.now() / 260)) * 0.8),
      80,
    );
    return () => clearInterval(timer);
  }, [level]);
  return <VoiceOrb {...props} state="live" level={level} />;
}
export default {
  title: "Foundation/VoiceOrb",
  component: VoiceOrb,
  args: { label: "Talk to the assistant", onPress: () => {} },
  decorators: [
    (Story) => (
      <View style={{ alignItems: "center", padding: 24 }}>
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof VoiceOrb>;
type Story = StoryObj<typeof VoiceOrb>;
/** Drifts and invites with a sparse ripple; never claims to listen. */
export const Ready: Story = {};
export const Listening: Story = { render: (args) => <Live {...args} /> };
export const VoiceUnavailable: Story = { args: { state: "disabled" } };
export const NoServerYet: Story = {
  args: { state: "dormant", onPress: undefined, size: 132 },
};
export const RecordMeeting: Story = {
  args: { tone: "record", size: 120, label: "Record meeting" },
};
export const RecordingMeeting: Story = {
  render: (args) => (
    <Live {...args} tone="record" glyph="stop" size={120} label="Stop" />
  ),
};
