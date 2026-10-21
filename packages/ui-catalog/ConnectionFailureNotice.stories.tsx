import type { Meta, StoryObj } from "@storybook/react-native";
import { ConnectionFailureNotice } from "./ConnectionFailureNotice";
const meta = {
  title: "Connection/Failure details",
  component: ConnectionFailureNotice,
  args: {
    language: "en",
    diagnostic: {
      phase: "snapshot",
      reason: "protocol",
      httpStatus: 200,
      expectedProfile: "agent-client/0.8-fixture",
      receivedProfile: "agent-client/0.6-fixture",
      fields: ["profile"],
    },
  },
} satisfies Meta<typeof ConnectionFailureNotice>;
export default meta;
type Story = StoryObj<typeof meta>;
export const VersionMismatch: Story = {};
export const ProxyFailure: Story = {
  args: {
    language: "cs",
    diagnostic: { phase: "snapshot", reason: "http", httpStatus: 502 },
  },
};
