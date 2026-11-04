import type { ExpoConfig } from "expo/config";
const development = process.env.AGENT_CLIENT_DEVELOPMENT === "1";
const audioSpike = process.env.AUDIO_SPIKE === "1";
const microphonePermission = audioSpike
  ? "Allow the isolated audio test to record after you press Start."
  : "Allow Niaro to record a voice request or meeting only after you press Record.";
const config: ExpoConfig = {
  name: audioSpike ? "Agent Client Audio Spike" : "Niaro",
  // EAS builds the store app; the isolated audio spike is not part of it.
  ...(audioSpike
    ? {}
    : {
        owner: "f-tuma",
        extra: { eas: { projectId: "aa95554b-6570-4024-90e9-d96b2ff9c335" } },
      }),
  slug: audioSpike ? "agent-client-audio" : "niaro",
  version: "0.1.0",
  scheme: audioSpike ? "agentclient-audio" : "niaro",
  userInterfaceStyle: "dark",
  icon: "./assets/application/icon.png",
  ios: {
    bundleIdentifier: audioSpike
      ? "dev.agentclient.demo.audio"
      : "dev.ftuma.niaro",
    supportsTablet: true,
    infoPlist: {
      CFBundleLocalizations: ["en", "cs"],
      ...(development
        ? { NSAppTransportSecurity: { NSAllowsLocalNetworking: true } }
        : {}),
    },
  },
  android: {
    package: audioSpike ? "dev.agentclient.demo.audio" : "dev.ftuma.niaro",
    // Google Play needs a higher number for every upload.
    versionCode: 8,
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
          "Allow Niaro to import a photo only after you choose Photos.",
        cameraPermission:
          "Allow Niaro to take a photo only after you choose Camera.",
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
