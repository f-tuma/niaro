import React from "react";
import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { VoiceComposer } from "./VoiceComposer";
import { speechBands, voiceVisualMeter } from "../audio/spectrum";
import { analyseFrame } from "../audio/analysis";
const meta = {
  title: "Voice/Inline composer",
  component: VoiceComposer,
  args: {
    language: "en",
    stage: "recording",
    text: "",
    level: 0.75,
    bands: [0.55, 0.8, 0.3],
    onStart: () => {},
    onStop: () => {},
    onUpload: () => {},
    onEdit: () => {},
    onSend: () => {},
    onCancel: () => {},
  },
} satisfies Meta<typeof VoiceComposer>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Recording: Story = {};
export const Czech: Story = { args: { language: "cs" } };
export const Silence: Story = { args: { level: 0, bands: [0, 0, 0] } };
export const Starting: Story = { args: { stage: "starting" } };
export const Transcribing: Story = { args: { stage: "transcribing" } };
export const Review: Story = {
  args: {
    stage: "review",
    text: "Připrav schůzku s Petrem zítra.",
    reviewReasons: ["uncertain"],
    language: "cs",
  },
};
export const TimeLimit: Story = {
  args: { ...Review.args, reviewReasons: ["limit"] },
};
export const PermissionDenied: Story = {
  args: { stage: "idle", error: "voice_permission" },
};
export const Retry: Story = {
  args: { stage: "recorded", error: "voice_processing_failed" },
};
export const Narrow: Story = {
  render: (args) => (
    <View style={{ width: 280 }}>
      <VoiceComposer {...args} />
    </View>
  ),
  args: { language: "cs" },
};

export const NarrowReview: Story = {
  ...Narrow,
  args: {
    ...Review.args,
    text: "Připrav schůzku s Peterem Novákem zítra ve dvě odpoledne na půl hodiny. Přidej také poznámku k návrhu projektu.",
  },
};
export const EnglishReview: Story = {
  args: {
    stage: "review",
    language: "en",
    text: "Prepare a meeting with Peter tomorrow at two in the afternoon for thirty minutes.",
    reviewReasons: ["uncertain"],
  },
};

export const LowVoice: Story = { args: { bands: [0.9, 0.15, 0.05] } };
export const HighVoice: Story = { args: { bands: [0.1, 0.2, 0.9] } };

/**
 * Web only: feeds the real microphone through the same analysis as the app
 * (analyseFrame + voiceVisualMeter at 80 ms) so the visual can be tuned live.
 */
function LiveMicrophoneComposer(
  args: React.ComponentProps<typeof VoiceComposer>,
) {
  const [meter, setMeter] = React.useState<{
    level: number;
    bands?: readonly [number, number, number];
    spectrum?: readonly number[];
  }>({ level: 0 });
  React.useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices) return;
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let context: AudioContext | undefined;
    let stream: MediaStream | undefined;
    void navigator.mediaDevices.getUserMedia({ audio: true }).then((media) => {
      if (stopped) return media.getTracks().forEach((t) => t.stop());
      stream = media;
      context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.45;
      context.createMediaStreamSource(media).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const frequencies = new Float32Array(analyser.frequencyBinCount);
      timer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        const frame = analyseFrame(samples, context!.sampleRate);
        analyser.getFloatFrequencyData(frequencies);
        setMeter(
          voiceVisualMeter(
            frame.level,
            speechBands(frequencies, context!.sampleRate, analyser.fftSize),
            frame.spectrum,
          ),
        );
      }, 80);
    });
    return () => {
      stopped = true;
      clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
      void context?.close();
    };
  }, []);
  return (
    <VoiceComposer
      {...args}
      level={meter.level}
      bands={meter.bands}
      spectrum={meter.spectrum}
    />
  );
}
export const LiveMicrophone: Story = {
  render: (args) => <LiveMicrophoneComposer {...args} />,
};
