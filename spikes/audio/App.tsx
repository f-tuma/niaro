import React, {
  useEffect,
  useCallback,
  useState,
  useSyncExternalStore,
} from "react";
import { AppState, ScrollView, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioPlayer,
  useAudioPlayerStatus,
} from "expo-audio";
import { Surface, Text, Button, Notice, Stack, Row } from "../../packages/ui";
import { tokens } from "../../packages/design-tokens";
import { translate, type TranslationKey } from "../../packages/i18n";
import type { Language } from "../../packages/protocol";
import {
  loadLanguage,
  saveLanguage,
} from "../../packages/client-core/preferences";
import { RecorderSession } from "./session";
import { stopRecording } from "./stop-recording";

import {
  inspectRecording,
  listRecordings,
  probeRecording,
  validRecording,
} from "./files";
import { RecoveryCard } from "./RecoveryCard";
import { RecorderStatus } from "./RecorderStatus";

export default function AudioSpike() {
  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    directory: "document",
  });
  const [session] = useState(
    () =>
      new RecorderSession({
        recorder: {
          uri: () => recorder.uri,
          prepare: () => recorder.prepareToRecordAsync(),
          record: () => recorder.record(),
          stop: () => stopRecording(recorder),
          status: () => recorder.getStatus(),
        },
        permission: async () =>
          (await requestRecordingPermissionsAsync()).granted,
        mode: (recording) =>
          setAudioModeAsync({
            allowsRecording: recording,
            playsInSilentMode: true,
            shouldPlayInBackground: false,
            allowsBackgroundRecording: false,
          }),
        inspect: inspectRecording,
        valid: validRecording,
        list: listRecordings,
        probe: probeRecording,
        storage: AsyncStorage,
      }),
  );
  const state = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  const [language, setLanguage] = useState<Language>("en");
  const [uiError, setUiError] = useState<TranslationKey>();
  const player = useAudioPlayer(state.saved?.uri ?? null);
  const playback = useAudioPlayerStatus(player);
  const onUnexpectedStop = useCallback(() => {
    void session.stop(true);
  }, [session]);
  const tr = translate(language);
  const idle = state.phase === "idle";
  const busy = !idle && state.phase !== "recording";
  useEffect(() => {
    void session.restore();
    void loadLanguage(AsyncStorage)
      .then(setLanguage)
      .catch(() => setUiError("storage_error"));
    session.setForeground(AppState.currentState === "active");
    const subscription = AppState.addEventListener("change", (next) => {
      session.setForeground(next === "active");
    });
    return () => {
      subscription.remove();
      session.setForeground(false);
    };
  }, [session]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next !== "active") player.pause();
    });
    return () => subscription.remove();
  }, [player]);
  async function changeLanguage(next: Language) {
    try {
      await saveLanguage(AsyncStorage, next);
      setLanguage(next);
    } catch {
      setUiError("storage_error");
    }
  }
  async function play() {
    try {
      setUiError(undefined);
      if (playback.playing) player.pause();
      else {
        await player.seekTo(0);
        player.play();
      }
    } catch {
      setUiError("audioPlaybackError");
    }
  }
  return (
    <SafeAreaProvider>
      <SafeAreaView
        style={{ flex: 1, backgroundColor: tokens.color.background }}
      >
        <StatusBar style="dark" />
        <ScrollView
          contentContainerStyle={{ padding: tokens.spacing.screenGutter }}
        >
          <Stack>
            <Surface>
              <Text role="screenTitle">{tr("audioSpike")}</Text>
              <Text tone="secondary">{tr("audioHint")}</Text>
              <RecorderStatus
                recorder={recorder}
                language={language}
                sessionRecording={state.phase === "recording"}
                onUnexpectedStop={onUnexpectedStop}
              />
              <Button
                disabled={busy || state.storageBlocked}
                loading={busy}
                label={tr(
                  state.phase === "recording" ? "audioStop" : "audioStart",
                )}
                onPress={() => {
                  player.pause();
                  setUiError(undefined);
                  void (state.phase === "recording"
                    ? session.stop()
                    : session.start());
                }}
              />
              {state.storageBlocked ? (
                <Button
                  label={tr("audioRetryJournal")}
                  disabled={busy}
                  onPress={() => {
                    void session.restore();
                  }}
                  variant="secondary"
                />
              ) : null}
              {state.message ? <Notice>{tr(state.message)}</Notice> : null}
              {uiError ? <Notice error>{tr(uiError)}</Notice> : null}
            </Surface>
            {state.candidates.map((candidate) => (
              <RecoveryCard
                key={candidate.uri}
                candidate={candidate}
                language={language}
                busy={!idle || state.storageBlocked}
                onCheck={() => {
                  player.pause();
                  void session.check(candidate.uri);
                }}
                onRecover={() => {
                  player.pause();
                  void session.recover(candidate.uri);
                }}
                onIgnore={() => {
                  void session.ignore(candidate.uri);
                }}
              />
            ))}
            {state.saved ? (
              <Surface>
                <Text role="cardTitle">{tr("audioLastRecording")}</Text>
                <Text>
                  {Math.round(state.saved.durationMillis / 1000)} s ·{" "}
                  {state.saved.bytes.toLocaleString(language)} B
                </Text>
                {state.saved.interrupted ? (
                  <Text>{tr("audioInterrupted")}</Text>
                ) : null}
                <Text selectable role="caption">
                  {state.saved.uri}
                </Text>
                <Button
                  disabled={!idle || !playback.isLoaded}
                  label={tr(playback.playing ? "audioPause" : "audioPlay")}
                  onPress={() => {
                    void play();
                  }}
                />
                <Text role="caption">
                  {tr(
                    playback.playing
                      ? "audioPlaying"
                      : playback.isLoaded
                        ? "audioPlaybackReady"
                        : "audioPlaybackUnavailable",
                  )}
                </Text>
              </Surface>
            ) : null}
            <Surface>
              <Text role="cardTitle">{tr("language")}</Text>
              <Row>
                <View style={{ flex: 1 }}>
                  <Button
                    variant={language === "en" ? "primary" : "secondary"}
                    label={tr("english")}
                    onPress={() => {
                      void changeLanguage("en");
                    }}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Button
                    variant={language === "cs" ? "primary" : "secondary"}
                    label={tr("czech")}
                    onPress={() => {
                      void changeLanguage("cs");
                    }}
                  />
                </View>
              </Row>
            </Surface>
          </Stack>
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
