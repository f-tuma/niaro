import { useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState, Platform } from "react-native";
import { Directory, File, FileMode, Paths } from "expo-file-system";
import { getDocumentAsync } from "expo-document-picker";
import { randomUUID } from "expo-crypto";
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  requestNotificationPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
  createAudioPlayer,
} from "expo-audio";
import {
  MeetingCapture,
  MEETING_RECORD_SECONDS,
} from "../../packages/client-core/meeting-capture";
import { stopRecording } from "../../packages/audio/stop-recording";
import { audioSession } from "./audio-session";
const valid = (uri: string) => {
  const prefix = Paths.document.uri.replace(/\/$/, "") + "/";
  return (
    uri.startsWith(prefix) &&
    /^(?:(?:Audio|ExpoAudio)\/recording-[a-zA-Z0-9-]+\.m4a|Audio\/import-[a-zA-Z0-9-]+\.(?:m4a|mp4|3gp|mp3|wav|ogg|oga|opus|webm|weba))$/.test(
      uri.slice(prefix.length),
    )
  );
};
const file = (uri: string) => {
  if (!valid(uri)) throw new Error("meeting_local_invalid");
  return new File(uri);
};
/** One audio file from the device's files, or null when the person cancels. */
async function pickAudio() {
  const picked = await getDocumentAsync({
    type: ["audio/*", "application/ogg"],
    copyToCacheDirectory: true,
    multiple: false,
  });
  const asset = picked.canceled ? undefined : picked.assets[0];
  return asset
    ? { uri: asset.uri, name: asset.name, size: asset.size ?? null }
    : null;
}
export function useMeetingDevice(identity: string) {
  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    numberOfChannels: 1,
    bitRate: 64000,
    directory: "document",
  });
  const [capture] = useState(
    () =>
      new MeetingCapture(identity, {
        storage: AsyncStorage,
        coordinator: audioSession,
        permission: async () => {
          if (!(await requestRecordingPermissionsAsync()).granted) return false;
          if (
            Platform.OS === "android" &&
            !(await requestNotificationPermissionsAsync()).granted
          )
            throw new Error("meeting_notification_denied");
          return true;
        },
        mode: (recording) =>
          setAudioModeAsync({
            allowsRecording: recording,
            playsInSilentMode: true,
            allowsBackgroundRecording: recording,
            shouldPlayInBackground: false,
          }),
        prepare: async () => {
          if (Paths.availableDiskSpace < 72 * 1024 * 1024)
            throw new Error("meeting_storage_failed");
          await recorder.prepareToRecordAsync();
        },
        uri: () => recorder.uri,
        record: () => recorder.record({ forDuration: MEETING_RECORD_SECONDS }),
        importFile: async (source, extension) => {
          const directory = new Directory(Paths.document, "Audio");
          directory.create({ intermediates: true, idempotent: true });
          const target = new File(
            directory,
            `import-${randomUUID()}.${extension}`,
          );
          // A copy belongs to the app's own files, unlike a move from the cache.
          await new File(source).copy(target);
          return { uri: target.uri, bytes: target.size };
        },
        discard: (source) => {
          // Only ever the document picker's own temporary copies.
          const picker = new Directory(Paths.cache, "DocumentPicker").uri;
          if (!source.startsWith(picker.replace(/\/?$/, "/"))) return;
          try {
            const picked = new File(source);
            if (picked.exists) picked.delete();
          } catch {}
        },
        pause: () => recorder.pause(),
        // Android's stop timer restarts with every record call; iOS resumes the
        // paused file only with a plain record, and the duration check stops it.
        resume: (remaining) =>
          Platform.OS === "android"
            ? recorder.record({ forDuration: remaining })
            : recorder.record(),
        stop: () => stopRecording(recorder),
        status: () => recorder.getStatus(),
        valid,
        size: (uri) => {
          const f = file(uri);
          return f.exists ? f.size : 0;
        },
        read: (uri, offset, length) => {
          const handle = file(uri).open(FileMode.ReadOnly);
          try {
            handle.offset = offset;
            const bytes = handle.readBytes(length);
            if (bytes.length !== length)
              throw new Error("meeting_local_invalid");
            return bytes;
          } finally {
            handle.close();
          }
        },
        play: (uri, onFinish) => {
          const player = createAudioPlayer(file(uri).uri);
          const sub = player.addListener("playbackStatusUpdate", (status) => {
            if (status.didJustFinish) onFinish();
          });
          try {
            player.play();
          } catch (error) {
            sub.remove();
            player.remove();
            throw error;
          }
          return {
            stop() {
              sub.remove();
              player.pause();
              player.remove();
            },
          };
        },
        remove: (uri) => {
          const f = file(uri);
          if (f.exists) f.delete();
        },
        probe: async (uri) => {
          const player = createAudioPlayer(file(uri).uri);
          try {
            for (let i = 0; i < 50; i++) {
              if (player.isLoaded && player.duration > 0)
                return player.duration * 1000;
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            throw new Error("meeting_recovery_failed");
          } finally {
            player.remove();
          }
        },
      }),
  );
  // Only this leaf receives frequent native timer updates.
  const status = useAudioRecorderState(recorder, 1000);
  useEffect(() => {
    capture.activate();
    void capture.restore();
    return () => capture.dispose();
  }, [capture]);
  useEffect(() => {
    if (capture.getSnapshot().phase !== "recording") return;
    if (!recorder.getStatus().isRecording) void capture.stop(true);
    else if (status.durationMillis >= MEETING_RECORD_SECONDS * 1000)
      void capture.stop(true);
  }, [capture, recorder, status.durationMillis, status.isRecording]);
  useEffect(() => {
    const sub = recorder.addListener("recordingStatusUpdate", (event) => {
      // Android's duration timer also ends a paused recording.
      const phase = capture.getSnapshot().phase;
      if (phase !== "recording" && phase !== "paused") return;
      if (event.isFinished) {
        if (event.url && event.url !== recorder.uri) return;
        if (!recorder.getStatus().isRecording) void capture.finishNative(true);
      } else if (event.hasError) void capture.stop(true);
    });
    const app = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        capture.stopPlayback();
        capture.cancelPreparing();
      }
      if (
        state === "active" &&
        capture.getSnapshot().phase === "recording" &&
        !recorder.getStatus().isRecording
      )
        void capture.stop(true);
    });
    return () => {
      sub.remove();
      app.remove();
    };
  }, [capture, recorder]);
  return {
    capture,
    durationMillis: status.durationMillis,
    elapsed: () => recorder.getStatus().durationMillis,
    pickAudio,
  };
}
