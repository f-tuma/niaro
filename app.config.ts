import type { ExpoConfig } from "expo/config";
const development = process.env.AGENT_CLIENT_DEVELOPMENT === "1";
const audioSpike = process.env.AUDIO_SPIKE === "1";
const microphonePermission = audioSpike
  ? "Allow the isolated audio test to record after you press Start."
  : "Allow Agent Client to record a voice request or meeting only after you press Record.";
const config: ExpoConfig = {
  name: audioSpike ? "Agent Client Audio Spike" : "Niaro",
  slug: audioSpike ? "agent-client-audio" : "agent-client",
  version: "0.1.0",
  scheme: audioSpike ? "agentclient-audio" : "agentclient",
  userInterfaceStyle: "dark",
  icon: "./assets/application/icon.png",
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
    adaptiveIcon: {
      foregroundImage: "./assets/application/mark.png",
      monochromeImage: "./assets/application/mark.png",
      backgroundColor: "#4563DE",
    },
  },
  web: {
    bundler: "metro",
    name: "Niaro",
    shortName: "Niaro",
    favicon: "./assets/application/favicon.png",
  },
  plugins: [
    [
      "expo-splash-screen",
      {
        image: "./assets/application/mark.png",
        imageWidth: 224,
        backgroundColor: "#4563DE",
      },
    ],
    "@react-native-community/datetimepicker",
    "expo-dev-client",
    [
      "expo-image-picker",
      {
        photosPermission:
          "Allow Agent Client to import a photo only after you choose Photos.",
        cameraPermission:
          "Allow Agent Client to take a photo only after you choose Camera.",
        microphonePermission,
      },
    ],
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
        microphonePermission,
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
