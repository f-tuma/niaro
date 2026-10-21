/** Short interface sounds, synthesized: no files, the same on the web and on phones. */
export type Earcon = "listen" | "sent" | "reply" | "done" | "error";

/** The part of the Web Audio API these sounds need; both platforms provide it. */
export type ToneContext = {
  readonly currentTime: number;
  readonly destination: unknown;
  createOscillator(): {
    type: string;
    frequency: { setValueAtTime(value: number, time: number): unknown };
    connect(node: never): unknown;
    start(when?: number): void;
    stop(when?: number): void;
  };
  createGain(): {
    gain: {
      setValueAtTime(value: number, time: number): unknown;
      linearRampToValueAtTime(value: number, time: number): unknown;
      exponentialRampToValueAtTime(value: number, time: number): unknown;
    };
    connect(node: never): unknown;
  };
};
type Note = { hz: number; at: number; length: number; gain?: number };
/** Soft sines, quieter than system sounds, each under 180 ms. */
const EARCONS: Record<Earcon, Note[]> = {
  listen: [
    { hz: 660, at: 0, length: 0.07 },
    { hz: 880, at: 0.055, length: 0.08 },
  ],
  sent: [
    { hz: 880, at: 0, length: 0.06 },
    { hz: 660, at: 0.045, length: 0.08 },
  ],
  reply: [
    { hz: 784, at: 0, length: 0.11, gain: 0.8 },
    { hz: 1175, at: 0.035, length: 0.12, gain: 0.55 },
  ],
  done: [
    { hz: 660, at: 0, length: 0.06 },
    { hz: 880, at: 0.045, length: 0.06 },
    { hz: 1320, at: 0.09, length: 0.09, gain: 0.7 },
  ],
  error: [
    { hz: 330, at: 0, length: 0.09 },
    { hz: 262, at: 0.08, length: 0.11 },
  ],
};
const VOLUME = 0.12;

/** Seconds until the sound is over; callers may wait for it before recording. */
export function earconLength(kind: Earcon) {
  return Math.max(...EARCONS[kind].map((n) => n.at + n.length));
}

export function playEarcon(context: ToneContext, kind: Earcon) {
  const now = context.currentTime + 0.01;
  for (const note of EARCONS[kind]) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(note.hz, now + note.at);
    const start = now + note.at,
      end = start + note.length;
    const peak = VOLUME * (note.gain ?? 1);
    // A few milliseconds of attack and an exponential tail: no clicks.
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(peak, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    oscillator.connect(gain as never);
    gain.connect(context.destination as never);
    oscillator.start(start);
    oscillator.stop(end + 0.02);
  }
  return earconLength(kind);
}
