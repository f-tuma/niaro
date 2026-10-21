import type { Meta, StoryObj } from "@storybook/react-native";
import { ServiceConnectionCard } from "./ServiceConnectionCard";
const meta = {
  title: "Workflow/Service connection",
  component: ServiceConnectionCard,
  args: {
    result: {
      type: "service.connection",
      version: 1,
      serviceId: "test-crm",
      service: "Twenty CRM",
      resumeText: "Find my contacts in CRM",
    },
    language: "en",
    phase: "disconnected",
    disabled: false,
    onConnect: () => {},
    onOpen: () => {},
    onCancel: () => {},
    onContinue: () => {},
  },
} satisfies Meta<typeof ServiceConnectionCard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Connect: Story = {};
export const Czech: Story = { args: { language: "cs" } };
export const Checking: Story = { args: { phase: "loading" } };
export const Starting: Story = { args: { phase: "starting" } };
export const Waiting: Story = { args: { phase: "pending" } };
export const BrowserBlocked: Story = {
  args: { phase: "pending", openFailed: true },
};
export const StatusUnavailable: Story = {
  args: { phase: "pending", statusFailed: true },
};
export const Cancelling: Story = { args: { phase: "cancelling" } };
export const CancellationFailed: Story = {
  args: { phase: "pending", cancelFailed: true },
};
export const Connected: Story = { args: { phase: "connected" } };
export const ConnectedCzech: Story = {
  args: { phase: "connected", language: "cs" },
};
export const Expired: Story = { args: { phase: "expired" } };
export const Cancelled: Story = { args: { phase: "cancelled" } };
export const Failed: Story = { args: { phase: "error" } };
export const NotConfigured: Story = { args: { phase: "unavailable" } };
export const Offline: Story = { args: { disabled: true } };
