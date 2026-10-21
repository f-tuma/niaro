import type { Meta, StoryObj } from "@storybook/react-native";
import { ReplySpeechButton } from "./ReplySpeechButton";
const meta = {
  title: "Voice/Read reply",
  component: ReplySpeechButton,
  args: { language: "en", phase: "idle", disabled: false, onPress: () => {} },
} satisfies Meta<typeof ReplySpeechButton>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Ready: Story = {};
export const Preparing: Story = { args: { phase: "loading" } };
export const Playing: Story = { args: { phase: "playing" } };
export const Failed: Story = { args: { phase: "error", language: "cs" } };
export const MicrophoneActive: Story = { args: { disabled: true } };
