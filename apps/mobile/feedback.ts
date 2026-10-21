import * as Haptics from "expo-haptics";
import { AudioContext } from "react-native-audio-api";
import {
  earconLength,
  playEarcon,
  type Earcon,
  type ToneContext,
} from "../../packages/audio/earcons";

let context: AudioContext | undefined;
let enabled = true;
export function setFeedbackEnabled(value: boolean) {
  enabled = value;
}
const haptics: Record<Earcon, () => Promise<void>> = {
  listen: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
  sent: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium),
  reply: () => Haptics.selectionAsync(),
  done: () =>
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  error: () =>
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
};
/** A sound and a matching haptic. Returns seconds until the sound is over; a sound
 * never blocks or fails the action it accompanies. */
export function feedback(kind: Earcon) {
  if (!enabled) return 0;
  try {
    context ??= new AudioContext();
    if (context.state === "suspended") void context.resume();
    playEarcon(context as unknown as ToneContext, kind);
  } catch {
    context = undefined;
  }
  void haptics[kind]().catch(() => {});
  return earconLength(kind);
}
/** A light tick for a held press, such as opening a context menu; no sound. */
export function touch() {
  if (!enabled) return;
  void Haptics.selectionAsync().catch(() => {});
}
