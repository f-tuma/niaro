import type { AudioRecorder, RecordingStatus } from "expo-audio";

/** Android may resolve stop() but report encoder failure only in the completion event. */
export async function stopRecording(
  recorder: Pick<AudioRecorder, "stop" | "addListener">,
): Promise<string> {
  let completion: RecordingStatus | undefined;
  let notify: (() => void) | undefined;
  const event = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const subscription = recorder.addListener(
    "recordingStatusUpdate",
    (status) => {
      if (status.isFinished || status.hasError) {
        completion = status;
        notify?.();
      }
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await recorder.stop();
    await Promise.race([
      event,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 3000);
      }),
    ]);
    if (!completion?.isFinished || completion.hasError || !completion.url) {
      throw new Error("recording_not_finalized");
    }
    return completion.url;
  } finally {
    if (timer) clearTimeout(timer);
    subscription.remove();
  }
}
