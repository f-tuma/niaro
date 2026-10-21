import React from "react";
import type { Meta, StoryObj } from "@storybook/react-native";
import { DetailRow, Disclosure, Stack, Surface, Text } from ".";
const meta = {
  title: "Foundation/ReadableDetails",
  component: Disclosure,
  args: {
    label: "How voice replies work",
    children: (
      <Text role="caption">
        Recording ends after you finish speaking or tap Done. Usable text sends
        automatically; uncertain recognition stays editable.
      </Text>
    ),
  },
} satisfies Meta<typeof Disclosure>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Collapsed: Story = {};
export const Czech: Story = {
  args: {
    label: "Jak fungují hlasové odpovědi",
    children: (
      <Text role="caption">
        Nahrávání skončí po domluvení nebo klepnutím na Hotovo. Použitelný
        přepis se odešle automaticky; nejistý text můžeš opravit. Odpověď na
        otázku není schválením kalendářové události.
      </Text>
    ),
  },
};
export const Grouped: Story = {
  render: (args) => (
    <Surface>
      <Stack>
        <DetailRow icon="person" label="Participant">
          <Text>Peter Novák</Text>
          <Text role="caption" tone="secondary">
            peter-novak@example.test
          </Text>
        </DetailRow>
        <DetailRow icon="clock" label="Date and time · UTC">
          <Text>29 September, 12:00–12:30</Text>
        </DetailRow>
        <Disclosure {...args} />
      </Stack>
    </Surface>
  ),
};
