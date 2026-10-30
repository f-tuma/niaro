import {
  advancePetMotion,
  petFrame,
  petRenderSize,
  type PetMotion,
} from "../packages/ui/pet-motion";

test("microphone spikes are smoothed without changing the ink clock and squash is bounded", () => {
  const motion: PetMotion = { time: 2, level: 0, touch: 0, sleep: 0 };
  advancePetMotion(motion, 1 / 30, "listening", 1);
  expect(motion.level).toBeGreaterThan(0);
  expect(motion.level).toBeLessThan(0.2);
  expect(motion.time).toBeCloseTo(2 + 1 / 30);
  for (let i = 0; i < 900; i++) {
    advancePetMotion(
      motion,
      1 / 30,
      i % 2 ? "working" : "listening",
      i % 7 ? 1 : Infinity,
    );
    expect(
      Math.abs(petFrame(motion, "listening", false).stretch),
    ).toBeLessThanOrEqual(0.02);
    expect(Number.isFinite(motion.level)).toBe(true);
  }
  expect(motion.time).toBeCloseTo(32 + 1 / 30);
});

test("reduced motion is an identical still frame regardless of input or elapsed time", () => {
  const before = petFrame(
    { time: 2, level: 0, touch: 0, sleep: 0 },
    "listening",
    true,
  );
  const after = petFrame(
    { time: 900, level: 1, touch: 1, sleep: 1 },
    "listening",
    true,
  );
  expect(after).toEqual(before);
  expect(
    petFrame({ time: 3, level: 1, touch: 1, sleep: 0 }, "resting", true).sleep,
  ).toBe(1);
});

test("render budget caps density at 2 and physical pixels at 480", () => {
  expect(petRenderSize(156, 3)).toEqual({
    logical: 156,
    pixels: 312,
    surface: 104,
  });
  expect(petRenderSize(400, 3)).toEqual({
    logical: 400,
    pixels: 480,
    surface: 160,
  });
  expect(petRenderSize(NaN, Infinity)).toEqual({
    logical: 156,
    pixels: 156,
    surface: 156,
  });
});
