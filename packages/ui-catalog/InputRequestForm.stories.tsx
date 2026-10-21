import type { Meta, StoryObj } from "@storybook/react-native";
import { choosePeter } from "../test-fixtures";
import { InputRequestForm } from "./InputRequestForm";
const meta = {
  title: "Input/InputRequestForm",
  component: InputRequestForm,
  args: { input: choosePeter().input, language: "en", onAnswer: () => {} },
} satisfies Meta<typeof InputRequestForm>;
export default meta;
type Story = StoryObj<typeof meta>;
export const English: Story = {};
export const ChatChoices: Story = { args: { compact: true } };
export const ChatChoicesCzech: Story = {
  args: { compact: true, language: "cs", input: choosePeter("cs").input },
};
export const Czech: Story = {
  args: { language: "cs", input: choosePeter("cs").input },
};
export const LongText: Story = {
  args: {
    language: "cs",
    input: {
      ...choosePeter("cs").input,
      question:
        "Kterého Petera mám pozvat na pracovní schůzku týkající se přípravy společného návrhu a podrobného plánování dalšího čtvrtletí? Zkontroluj prosím i společnost, aby pozvánka směřovala správnému člověku.",
      options: Array.from({ length: 8 }, (_, i) => ({
        id: `contact-${i}`,
        label: `Peter ${i + 1} · Ukázkový kontakt s dlouhým jménem`,
        detail: "Oddělení produktového vývoje a spolupráce se zákazníky",
      })),
    },
  },
};
export const Sending: Story = { args: { state: "sending" } };
export const NetworkError: Story = { args: { state: "network_error" } };
export const Conflict: Story = { args: { state: "conflict", language: "cs" } };
export const Stale: Story = { args: { stale: true } };
export const RequiredEmpty: Story = {
  parameters: { notes: "Press Send answer without selecting a contact." },
};
export const ChatLongList: Story = {
  args: { ...LongText.args, compact: true },
};
export const Resolved: Story = {
  args: {
    input: {
      ...choosePeter().input,
      status: "resolved",
      revision: 2,
      resolution: {
        selectedContactId: "peter-novak",
        source: "chat",
        reason: "Resolved in the conversation",
      },
    },
  },
};
