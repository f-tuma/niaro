import React from "react";
import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { ActionToast } from ".";
import { translate } from "../i18n";

const tr = translate("en");
const meta = {
  title: "Foundation/ActionToast",
  component: ActionToast,
  args: {
    message: tr("sessionExpiredShort"),
    description: tr("auth_expired"),
    actionLabel: tr("signIn"),
    onAction: () => {},
  },
  decorators: [
    (Story) => (
      <View style={{ width: "100%", maxWidth: 480 }}>
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof ActionToast>;
export default meta;
type Story = StoryObj<typeof meta>;
export const English: Story = {};
export const Czech: Story = {
  args: {
    message: translate("cs")("sessionExpiredShort"),
    description: translate("cs")("auth_expired"),
    actionLabel: translate("cs")("signIn"),
  },
};
