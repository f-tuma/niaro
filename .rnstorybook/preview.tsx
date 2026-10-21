import React from "react";
import { ScrollView } from "react-native";
import type { Preview } from "@storybook/react-native";
import { tokens } from "../packages/design-tokens";
import { MotionProvider } from "../packages/ui/motion";
const preview: Preview = {
  decorators: [
    (Story) => (
      <MotionProvider>
        <ScrollView
          contentContainerStyle={{
            flexGrow: 1,
            padding: tokens.spacing.screenGutter,
            backgroundColor: tokens.color.background,
          }}
        >
          <Story />
        </ScrollView>
      </MotionProvider>
    ),
  ],
};
export default preview;
