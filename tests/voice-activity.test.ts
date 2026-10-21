import { VoiceActivity } from "../packages/audio/voice-activity";

function fixture() {
  const activity = new VoiceActivity(0);
  let now = 0;
  let ended: { at: number; reason: "silence" | "empty" } | undefined;
  return {
    feed(db: number | null, duration: number) {
      for (let n = 0; n < duration; n += 100) {
        now += 100;
        const reason = activity.sample(db, now);
        if (reason && !ended) ended = { at: now, reason };
      }
      return ended;
    },
    jump(db: number | null, milliseconds: number) {
      now += milliseconds;
      return activity.sample(db, now);
    },
  };
}
test("quiet room hum is not speech and does not prevent the end of a spoken request", () => {
  const f = fixture();
  expect(f.feed(-59, 600)).toBeUndefined();
  expect(f.feed(-38, 900)).toBeUndefined();
  expect(f.feed(-59, 1700)).toBeUndefined();
  expect(f.feed(-59, 100)?.reason).toBe("silence");
  const humOnly = fixture();
  expect(humOnly.feed(-59, 9900)).toBeUndefined();
  expect(humOnly.feed(-59, 100)?.reason).toBe("empty");
});
test.each([-38, -57])(
  "a short immediate answer at %s dB survives ambient calibration",
  (level) => {
    const f = fixture();
    expect(f.feed(level, 200)).toBeUndefined();
    expect(f.feed(-90, 1700)).toBeUndefined();
    expect(f.feed(-90, 100)?.reason).toBe("silence");
  },
);
test("a click does not count as a spoken request", () => {
  const f = fixture();
  f.feed(-20, 100);
  expect(f.feed(-85, 9900)?.reason).toBe("empty");
});
test("a thinking pause and quieter continuation remain one recording", () => {
  const f = fixture();
  f.feed(-75, 600);
  f.feed(-40, 800);
  expect(f.feed(-75, 1300)).toBeUndefined();
  expect(f.feed(-57, 1500)).toBeUndefined();
  expect(f.feed(-75, 1800)?.reason).toBe("silence");
});
test("missing metering and scheduler stalls do not advance the silence deadline", () => {
  const f = fixture();
  f.feed(-80, 600);
  f.feed(-35, 900);
  f.feed(-80, 1000);
  expect(f.feed(null, 5000)).toBeUndefined();
  expect(f.feed(-80, 1500)).toBeUndefined();
  expect(f.jump(-80, 8000)).toBeNull();
  expect(f.feed(-80, 200)?.reason).toBe("silence");
  const startup = fixture();
  startup.feed(null, 20000);
  expect(startup.feed(-90, 9900)).toBeUndefined();
  expect(startup.feed(-90, 100)?.reason).toBe("empty");
});

describe("spectral voicing", () => {
  /** Feeds 100 ms frames; returns the time the endpoint fired, if any. */
  const run = (
    frames: { db: number; voiced: number; ms: number }[],
  ): { outcome: string | null; at: number } => {
    const activity = new VoiceActivity(0);
    let now = 0;
    for (const frame of frames)
      for (let t = 0; t < frame.ms; t += 100) {
        now += 100;
        const outcome = activity.sample(frame.db, now, frame.voiced);
        if (outcome) return { outcome, at: now };
      }
    return { outcome: null, at: now };
  };
  test("loud steady noise after speech does not hold the microphone open", () => {
    const result = run([
      { db: -50, voiced: 0, ms: 700 },
      { db: -30, voiced: 0.9, ms: 1500 },
      // A fan as loud as the voice, but spectrally flat.
      { db: -32, voiced: 0.05, ms: 3000 },
    ]);
    expect(result.outcome).toBe("silence");
    expect(result.at).toBe(2200 + 1800);
  });
  test("short words and sentences both preserve a natural thinking pause", () => {
    const short = run([
      { db: -50, voiced: 0, ms: 700 },
      { db: -30, voiced: 0.9, ms: 400 },
      { db: -50, voiced: 0, ms: 3000 },
    ]);
    const long = run([
      { db: -50, voiced: 0, ms: 700 },
      { db: -30, voiced: 0.9, ms: 1500 },
      { db: -50, voiced: 0, ms: 3000 },
    ]);
    expect(short.at - 1100).toBe(1800);
    expect(long.at - 2200).toBe(1800);
  });
  test("a thinking pause before a quieter name or time is never cut off", () => {
    const result = run([
      { db: -75, voiced: 0, ms: 600 },
      { db: -35, voiced: 0.9, ms: 800 },
      { db: -75, voiced: 0, ms: 1300 },
      { db: -57, voiced: 0.8, ms: 1500 },
      { db: -75, voiced: 0, ms: 1800 },
    ]);
    expect(result).toEqual({ outcome: "silence", at: 6000 });
  });
  test("noise alone is never mistaken for speech", () => {
    const result = run([{ db: -30, voiced: 0.05, ms: 11000 }]);
    expect(result.outcome).toBe("empty");
  });
});
