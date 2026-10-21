import type { Meta, StoryObj } from "@storybook/react-native";
import { VoiceReplyCard } from "./VoiceReplyCard";
const meta = {
  title: "Voice/Voice input",
  component: VoiceReplyCard,
  args: {
    language: "en",
    stage: "idle",
    address: "http://localhost:8793/v1/a",
    text: "",
    onStart: () => {},
    onStop: () => {},
    onUpload: () => {},
    onEdit: () => {},
    onSend: () => {},
    onCancel: () => {},
  },
} satisfies Meta<typeof VoiceReplyCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Ready: Story = {};
export const Question: Story = {
  args: { question: "Which Peter do you mean?" },
};
export const Recording: Story = { args: { stage: "recording" } };
export const Transcribing: Story = { args: { stage: "transcribing" } };
export const Review: Story = {
  args: {
    stage: "review",
    text: "Choose Peter Novak.",
    reviewReasons: ["uncertain"],
  },
};
export const CzechReview: Story = {
  args: {
    language: "cs",
    stage: "review",
    question: "Kterého Petera myslíš?",
    text: "Vyber Petera Nováka.",
    reviewReasons: ["uncertain"],
  },
};
export const Denied: Story = { args: { error: "voice_permission" } };
export const ServerFailure: Story = {
  args: { stage: "recorded", error: "voice_processing_failed" },
};
export const Unsupported: Story = { args: { stage: "unavailable" } };
export const TimeLimit: Story = {
  args: {
    stage: "review",
    language: "cs",
    text: "Naplánuj schůzku s",
    reviewReasons: ["limit"],
  },
};
