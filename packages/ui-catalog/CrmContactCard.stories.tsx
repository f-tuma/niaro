import type { Meta, StoryObj } from "@storybook/react-native";
import { crmContactResult } from "../test-fixtures";
import { CrmContactResults } from "./CrmContactCard";
const result = crmContactResult();
const meta = {
  title: "Results/CRM contacts",
  component: CrmContactResults,
  args: { result, language: "en" },
} satisfies Meta<typeof CrmContactResults>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Complete: Story = {};
export const Czech: Story = { args: { language: "cs" } };
export const MissingDetails: Story = {
  args: {
    result: {
      ...result,
      contacts: [{ id: "test-name-only", name: "TEST Agent Client" }],
    },
  },
};
export const Empty: Story = { args: { result: { ...result, contacts: [] } } };
export const Multiple: Story = {
  args: {
    result: {
      ...result,
      hasMore: true,
      contacts: Array.from({ length: 5 }, (_, i) => ({
        ...result.contacts[0]!,
        id: `test-${i}`,
        name: `TEST Contact ${i + 1}`,
      })),
    },
  },
};
export const LongDetails: Story = {
  args: {
    language: "cs",
    result: {
      ...result,
      contacts: [
        {
          ...result.contacts[0]!,
          name: "TEST Alexandra Nováková — mezinárodní produktový a zákaznický tým",
          jobTitle: "Koordinátorka dlouhodobých projektů a vztahů se zákazníky",
          email: "alexandra.novakova.international.projects@example.test",
        },
      ],
    },
  },
};
