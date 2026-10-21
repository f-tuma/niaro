import React, { useEffect, useRef } from "react";
import { useAudioRecorderState, type AudioRecorder } from "expo-audio";
import { Text } from "../../packages/ui";
import { translate } from "../../packages/i18n";
import type { Language } from "../../packages/protocol";

// Keep the recorder's frequent timer updates out of the file/recovery screen.
export function RecorderStatus({
  recorder,
  language,
  sessionRecording,
  onUnexpectedStop,
}: {
  recorder: AudioRecorder;
  language: Language;
  sessionRecording: boolean;
  onUnexpectedStop(): void;
}) {
  const status = useAudioRecorderState(recorder);
  const wasRecording = useRef(false);
  const tr = translate(language);
  useEffect(() => {
    const isRecording = recorder.getStatus().isRecording;
    const ended = wasRecording.current && !isRecording;
    wasRecording.current = isRecording;
    if (sessionRecording && ended) onUnexpectedStop();
  }, [status.isRecording, sessionRecording, recorder, onUnexpectedStop]);
  return (
    <>
      <Text accessibilityLiveRegion="polite">
        {tr(status.isRecording ? "audioRecording" : "audioIdle")}
      </Text>
      <Text>{Math.round(status.durationMillis / 1000)} s</Text>
    </>
  );
}
