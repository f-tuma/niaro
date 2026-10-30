import { createPetCadence, petCadenceDue } from "../packages/ui/pet-motion";
import {
  advancePetMotion,
  createPetInteraction,
  pressPet,
  releasePet,
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

test("still signs use the original prototype upper-right head projection rather than the body origin", () => {
  const motion: PetMotion = {
    time: 2,
    level: 0,
    touch: 0,
    sleep: 0,
    interaction: createPetInteraction(),
  };
  pressPet(motion, 100, 100, 200, 10);
  releasePet(motion, 10.1, false, true);
  advancePetMotion(motion, 0, "idle", 0, 10.2, true);
  const sign = petFrame(motion, "idle", true).sign!;
  // Original signAt(), neutral R=.7/CAM=3.2/FOV=.37: project local head, then its .1 offset.
  expect(sign.x).toBeCloseTo((0.52 * 0.7) / (3.2 * 0.37) + 0.1, 6);
  expect(sign.y).toBeCloseTo(0.7 / (3.2 * 0.37) + 0.1, 6);
});

test("stable vsync divider carries original30/20/15 cadence and never queues catch-up draws", () => {
  const c = createPetCadence();
  let time = 1000;
  for (const fps of [30, 20, 15]) {
    let count = 0;
    for (let i = 0; i < 240; i++) {
      time += 1000 / 60;
      if (petCadenceDue(c, time, fps)) count++;
    }
    expect(count).toBeGreaterThanOrEqual(4 * fps - 1);
    expect(count).toBeLessThanOrEqual(4 * fps + 1);
  }
  time += 5000;
  expect(petCadenceDue(c, time)).toBe(true);
  expect(petCadenceDue(c, time)).toBe(false);
  expect(petCadenceDue(c, time + 1)).toBe(false);
});
