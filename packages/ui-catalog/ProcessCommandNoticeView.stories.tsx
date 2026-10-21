import type { Meta, StoryObj } from "@storybook/react-native";
import { ProcessCommandNoticeView } from "./ProcessCommandNoticeView";

const meta = {
  title: "Workflow/Process command announcement",
  component: ProcessCommandNoticeView,
  args: {
    language: "en",
    notice: { key: "processDecisionDeclined", error: false },
  },
} satisfies Meta<typeof ProcessCommandNoticeView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Declined: Story = {};
export const UnknownCzech: Story = {
  args: {
    language: "cs",
    notice: { key: "processResultUnknown", error: false },
  },
};
export const Failed: Story = {
  args: {
    notice: {
      key: "processResultFailed",
      detailKey: "processResultOutputInvalid",
      error: true,
    },
  },
};
export const ConfigurationRefusal: Story = {
  args: { notice: { key: "process_definition_invalid", error: true } },
};
