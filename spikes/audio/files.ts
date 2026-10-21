import { Directory, File, Paths } from "expo-file-system";
import { createAudioPlayer } from "expo-audio";
import { isRecordingUri } from "./journal";

export const validRecording = (uri: string) =>
  isRecordingUri(uri, Paths.document.uri);
export function inspectRecording(uri: string) {
  if (!validRecording(uri)) throw new Error("outside_recording_directory");
  const file = new File(uri);
  return file.exists ? file.size : 0;
}
export function listRecordings() {
  const directory = new Directory(Paths.document, "Audio");
  return directory.exists
    ? directory
        .list()
        .filter((item) => item instanceof File && validRecording(item.uri))
        .map((item) => item.uri)
    : [];
}
/** Inspect native player readiness only. Never play; not a full stream decode. */
export async function probeRecording(uri: string) {
  if (inspectRecording(uri) <= 0) throw new Error("empty_recording");
  const player = createAudioPlayer(uri);
  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (
        player.isLoaded &&
        Number.isFinite(player.duration) &&
        player.duration > 0
      )
        return player.duration * 1000;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("recording_not_readable");
  } finally {
    player.remove();
  }
}
