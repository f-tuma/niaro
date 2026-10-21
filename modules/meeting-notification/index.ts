import { requireOptionalNativeModule } from "expo";

export type MeetingNotificationAction = "pause" | "resume" | "stop";
export type MeetingNotificationContent = {
  title: string;
  text: string;
  paused: boolean;
  elapsedMillis: number;
  pauseLabel: string;
  resumeLabel: string;
  stopLabel: string;
  /** Shown in Android's notification settings for this app. */
  channelName: string;
};
type Native = {
  /** False when no background recording notification exists to replace. */
  show(content: MeetingNotificationContent): boolean;
  addListener(
    event: "onAction",
    listener: (event: { action: string }) => void,
  ): { remove(): void };
};

/** Android only; elsewhere the system shows its own recording indicator. */
export const meetingNotification = requireOptionalNativeModule<Native>(
  "MeetingNotification",
);
