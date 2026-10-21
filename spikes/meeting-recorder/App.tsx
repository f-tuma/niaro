import React, { useEffect, useRef, useSyncExternalStore } from "react";
import { AppState, Button, ScrollView, Text, View } from "react-native";
import { randomUUID } from "expo-crypto";
import { useMeetingDevice } from "../../apps/mobile/meeting-device";
import { useMeetingNotification } from "../../apps/mobile/meeting-notification";

/**
 * Device QA for meeting recording without a server: the real recorder,
 * capture journal and Android notification controls. Each second it logs one
 * `MEETING_QA` line, so logcat shows what happens while the screen is off.
 */
export default function MeetingRecorderQa() {
  const { capture, durationMillis, elapsed, pickAudio } =
    useMeetingDevice("qa-recorder");
  const state = useSyncExternalStore(capture!.subscribe, capture!.getSnapshot);
  const title =
    state.entries.find((entry) => entry.state === "pending")?.title ?? "";
  useMeetingNotification({
    phase: state.phase,
    title,
    elapsedMillis: elapsed,
    language: "cs",
    onPause: () => capture!.pause(),
    onResume: () => capture!.resume(),
    onStop: () => void capture!.stop(),
  });
  const elapsedNow = useRef(elapsed);
  useEffect(() => {
    elapsedNow.current = elapsed;
  });
  useEffect(() => {
    const timer = setInterval(() => {
      const now = capture!.getSnapshot();
      console.log(
        "MEETING_QA " +
          JSON.stringify({
            at: new Date().toISOString(),
            app: AppState.currentState,
            phase: now.phase,
            elapsedMillis: elapsedNow.current(),
            error: now.error,
            entries: now.entries.map((entry) => ({
              id: entry.id,
              state: entry.state,
              durationMillis: Math.round(entry.durationMillis),
              bytes: entry.bytes,
              interrupted: entry.interrupted,
            })),
          }),
      );
    }, 1000);
    return () => clearInterval(timer);
  }, [capture]);
  return (
    <ScrollView
      contentContainerStyle={{ padding: 24, paddingTop: 64, gap: 12 }}
    >
      <Text style={{ fontSize: 20 }}>Meeting recorder QA</Text>
      <Text testID="qa-phase">
        {state.phase} · {Math.round(durationMillis / 1000)} s
      </Text>
      {state.error ? <Text>{state.error}</Text> : null}
      <View style={{ gap: 8 }}>
        <Button
          title="QA start"
          onPress={() => {
            const id = randomUUID();
            console.log("MEETING_QA_START " + id);
            void capture!.start(
              id,
              `Schůzka · QA ${new Date().toLocaleTimeString("cs")}`,
              "cs",
            );
          }}
        />
        <Button title="QA pause" onPress={() => capture!.pause()} />
        <Button title="QA resume" onPress={() => capture!.resume()} />
        <Button title="QA stop" onPress={() => void capture!.stop()} />
        <Button
          title="QA import"
          onPress={async () => {
            const picked = await pickAudio();
            console.log("MEETING_QA_PICKED " + JSON.stringify(picked));
            if (picked)
              await capture!.importFile(
                picked,
                randomUUID(),
                `Schůzka · QA import ${new Date().toLocaleTimeString("cs")}`,
                "cs",
              );
          }}
        />
      </View>
      {state.entries.map((entry) => (
        <Text key={entry.id}>
          {entry.title} · {entry.mimeType} · {entry.state} ·{" "}
          {Math.round(entry.durationMillis / 1000)} s · {entry.bytes} B
        </Text>
      ))}
    </ScrollView>
  );
}
