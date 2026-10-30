const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");
const { withStorybook } = require("@storybook/react-native/withStorybook");
const storybookEnabled = process.env.STORYBOOK_ENABLED === "true";
process.env.STORYBOOK_DISABLE_TELEMETRY = "true";
const config = getDefaultConfig(__dirname);
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "@app-entry") {
    return {
      type: "sourceFile",
      filePath: path.join(
        __dirname,
        process.env.AUDIO_SPIKE === "1"
          ? "spikes/audio/App.tsx"
          : process.env.MEETING_RECORDER_QA === "1"
            ? "spikes/meeting-recorder/App.tsx"
            : process.env.ATTACHMENT_CLIENT_QA === "1"
              ? "tests/helpers/attachment-native-entry.tsx"
              : process.env.NATIVE_JOURNEYS_QA === "1"
                ? "tests/helpers/mobile-emulator-entry.tsx"
                : "apps/mobile/App.tsx",
      ),
    };
  }
  return context.resolveRequest(context, moduleName, platform);
};
module.exports = withStorybook(config, {
  enabled: storybookEnabled,
  docTools: false,
});
