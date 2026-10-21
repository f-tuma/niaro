import type { Meta, StoryObj } from "@storybook/react-native";
import { ProcessAnswerRecoveryCard } from "./ProcessAnswerRecoveryCard";

const meta = {
  title: "Workflow/Saved process answer",
  component: ProcessAnswerRecoveryCard,
  args: {
    language: "en",
    question: "Which contact should this process use?",
    answer: "  TEST Alex\nKeep the original wording.  ",
    outcome: "accepted",
    canReview: true,
    onReview: () => {},
    onDiscard: () => {},
    onRetry: () => {},
  },
} satisfies Meta<typeof ProcessAnswerRecoveryCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const AwaitingConsumption: Story = {};
export const RejectedCzech: Story = {
  args: {
    language: "cs",
    question: "Kterou osobu má tento proces použít?",
    answer: "  TEST Alex\nZachovat přesné znění.  ",
    outcome: "rejected",
    explanation: "Oprávnění služby se změnilo. Odpověď zatím zůstává uložena.",
  },
};
export const UnknownDelivery: Story = {
  args: { outcome: "unknown", canRetry: true },
};
export const QuestionChanged: Story = { args: { canReview: false } };
export const RetryLocalSaving: Story = {
  args: {
    canReview: false,
    canRetry: true,
    explanation: "TEST Local storage is unavailable.",
  },
};
export const LongAnswer: Story = {
  args: {
    answer: "TEST unbroken_answer_".repeat(120),
    question: "TEST long question. ".repeat(40),
  },
};
