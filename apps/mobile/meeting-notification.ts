import { useEffect, useRef } from "react";
import { meetingNotification } from "../../modules/meeting-notification";
import type { MeetingCaptureState } from "../../packages/client-core/meeting-capture";
import { translate } from "../../packages/i18n";
import type { Language } from "../../packages/protocol";

/**
 * While a meeting records, Android shows it with Pause/Resume and Stop, also
 * on the lock screen. The buttons only ask the app to act, so a meeting
 * stopped there is saved and processed like one stopped in the app.
 */
export function useMeetingNotification({
  phase,
  title,
  elapsedMillis,
  language,
  onPause,
  onResume,
  onStop,
}: {
  phase: MeetingCaptureState["phase"];
  title: string;
  /** Recorded time right now, paused time excluded. */
  elapsedMillis: () => number;
  language: Language;
  onPause(): void;
  onResume(): void;
  onStop(): void;
}) {
  const latest = useRef({ elapsedMillis, onPause, onResume, onStop });
  useEffect(() => {
    latest.current = { elapsedMillis, onPause, onResume, onStop };
  });
  const shown = phase === "recording" || phase === "paused" ? phase : null;
  useEffect(() => {
    const native = meetingNotification;
    if (!native || !shown) return;
    const tr = translate(language);
    const post = () => {
      try {
        native.show({
          title: tr(
            shown === "paused"
              ? "meetingPaused"
              : "meetingNotificationRecording",
          ),
          text: title,
          paused: shown === "paused",
          elapsedMillis: latest.current.elapsedMillis(),
          pauseLabel: tr("meetingPause"),
          resumeLabel: tr("meetingResume"),
          stopLabel: tr("meetingStopShort"),
          channelName: tr("meetingNotificationChannel"),
        });
      } catch {
        // Only the notification is missing; the recording goes on.
      }
    };
    post();
    // expo-audio posts its own notification as recording starts; replace it again.
    const again = setTimeout(post, 1000);
    return () => clearTimeout(again);
  }, [shown, title, language]);
  useEffect(() => {
    const native = meetingNotification;
    if (!native) return;
    const subscription = native.addListener("onAction", ({ action }) => {
      if (action === "pause") latest.current.onPause();
      else if (action === "resume") latest.current.onResume();
      else if (action === "stop") latest.current.onStop();
    });
    return () => subscription.remove();
  }, []);
}
