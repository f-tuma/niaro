import type { StorybookConfig } from "@storybook/react-native";
const config: StorybookConfig = {
  stories: ["../packages/**/*.stories.tsx", "../spikes/audio/**/*.stories.tsx"],
  deviceAddons: [],
};
export default config;
