import React from "react";
import type { Meta, StoryObj } from "@storybook/react-native";
import { Button, Surface, Badge, Stack, Text } from "./index";
export default {
  title: "Foundation/Controls",
  component: Button,
  args: { label: "Send answer", onPress: () => {} },
} satisfies Meta<typeof Button>;
export const Primary: StoryObj<typeof Button> = {};
export const Disabled: StoryObj<typeof Button> = {
  args: { label: "Recording is not available yet", disabled: true },
};
export const Loading: StoryObj<typeof Button> = {
  args: { label: "Sending…", loading: true },
};
export const CzechLongLabel: StoryObj<typeof Button> = {
  args: { label: "Zkontrolovat aktuální kontext a znovu odeslat odpověď" },
};
export const VoiceUnavailable: StoryObj<typeof Button> = {
  render: () => (
    <Surface>
      <Stack>
        <Badge label="Voice is not connected" />
        <Text>Use text for this first demo.</Text>
      </Stack>
    </Surface>
  ),
};
