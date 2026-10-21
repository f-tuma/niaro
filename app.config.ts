import type { ExpoConfig } from "expo/config";
const development = process.env.AGENT_CLIENT_DEVELOPMENT === "1";
const audioSpike = process.env.AUDIO_SPIKE === "1";
const config: ExpoConfig = {
  name: audioSpike ? "Agent Client Audio Spike" : "Agent Client",
  slug: audioSpike ? "agent-client-audio" : "agent-client",
  version: "0.1.0",
  scheme: audioSpike ? "agentclient-audio" : "agentclient",
  userInterfaceStyle: "light",
  ios: {
    bundleIdentifier: audioSpike
      ? "dev.agentclient.demo.audio"
      : "dev.agentclient.demo",
    supportsTablet: true,
    infoPlist: {
      CFBundleLocalizations: ["en", "cs"],
      ...(development
        ? { NSAppTransportSecurity: { NSAllowsLocalNetworking: true } }
        : {}),
    },
  },
  android: {
    package: audioSpike ? "dev.agentclient.demo.audio" : "dev.agentclient.demo",
  },
  web: { bundler: "metro", name: "Agent Client" },
  plugins: [
    "@react-native-community/datetimepicker",
    "expo-dev-client",
    [
      "expo-secure-store",
      { configureAndroidBackup: true, faceIDPermission: false },
    ],
    [
      "expo-build-properties",
      { android: { usesCleartextTraffic: development } },
    ],
    [
      "expo-audio",
      {
        microphonePermission: audioSpike
          ? "Allow the isolated audio test to record after you press Start."
          : "Allow Agent Client to record a voice request or meeting only after you press Record.",
        enableBackgroundRecording: !audioSpike,
        enableBackgroundPlayback: false,
      },
    ],
    [
      // Raw microphone samples for the voice spectrum and endpointing. Foreground
      // only: no background audio, no foreground service, no extra permissions.
      "react-native-audio-api",
      {
        iosBackgroundMode: false,
        androidForegroundService: false,
        androidPermissions: [],
        disableFFmpeg: true,
      },
    ],
  ],
};
export default config;
