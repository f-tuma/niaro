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
/** Browsers have no haptics; the sound alone. Returns seconds until it is over. */
export function feedback(kind: Earcon) {
  if (!enabled || typeof AudioContext === "undefined") return 0;
  try {
    context ??= new AudioContext();
    if (context.state === "suspended") void context.resume();
    playEarcon(context as unknown as ToneContext, kind);
  } catch {
    context = undefined;
  }
  return earconLength(kind);
}
/** Browsers have no haptics, and a held press needs no sound. */
export function touch() {}
