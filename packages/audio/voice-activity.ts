type LevelFrame = { db: number; at: number; elapsed: number; speech: boolean };

/** Endpointing. With spectral voicing (0–1) a frame counts as speech only if it sounds
 * like a voice, so steady noise cannot hold the microphone open; without it, energy
 * against the ambient floor decides. Missing metering is never silence. */
export class VoiceActivity {
  private frames: LevelFrame[] = [];
  private heardVoice = false;
  private quietMs = 0;
  private monitoredMs = 0;
  private noiseFloor = Infinity;
  private previous: number;
  constructor(startedAt: number) {
    this.previous = startedAt;
  }
  sample(
    db: number | null,
    now: number,
    voiced?: number | null,
  ): "silence" | "empty" | null {
    // A stalled JS thread must not turn one reading into seconds of silence.
    const elapsed = Math.min(150, Math.max(0, now - this.previous));
    this.previous = now;
    if (db === null || !Number.isFinite(db)) {
      this.frames = [];
      this.quietMs = 0;
      return null;
    }
    this.monitoredMs += elapsed;
    const spectral = voiced !== undefined && voiced !== null;
    this.frames.push({ db, at: now, elapsed, speech: false });
    this.frames = this.frames.filter((frame) => now - frame.at < 1200);
    const levels = this.frames.map((frame) => frame.db).sort((a, b) => a - b);
    const floor = levels[Math.floor((levels.length - 1) * 0.2)]!;
    // Once speech is established, a louder syllable cannot raise the gate.
    this.noiseFloor = this.heardVoice
      ? Math.min(this.noiseFloor, floor)
      : floor;
    const gate = Math.max(-65, Math.min(-45, this.noiseFloor + 8));
    // A voice may be quieter than a noisy room's gate; noise never looks voiced.
    const speech = spectral ? voiced >= 0.5 && db >= gate - 6 : db >= gate;
    this.frames.at(-1)!.speech = speech;

    if (!this.heardVoice) {
      const recent = this.frames.filter((frame) => now - frame.at < 600);
      const monitored = this.frames.reduce(
        (sum, frame) => sum + frame.elapsed,
        0,
      );
      const heard = recent
        .filter((frame) => (spectral ? frame.speech : frame.db >= gate + 5))
        .reduce((sum, frame) => sum + frame.elapsed, 0);
      // Look back to preserve a short word spoken immediately after tapping
      // the microphone, while allowing the ambient floor to settle.
      if (monitored >= 600 && heard >= 200) {
        this.heardVoice = true;
        for (const frame of [...recent].reverse()) {
          if (spectral ? frame.speech : frame.db >= gate) break;
          this.quietMs += frame.elapsed;
        }
      }
    } else {
      this.quietMs = speech ? 0 : this.quietMs + elapsed;
    }
    // A natural pause before a name or time remains part of the same request,
    // regardless of whether this recorder also provides spectral analysis.
    if (this.heardVoice && this.quietMs >= 1800) return "silence";
    return !this.heardVoice && this.monitoredMs >= 10000 ? "empty" : null;
  }
}
