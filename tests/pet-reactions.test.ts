import {
  advancePetMotion,
  createPetInteraction,
  petFrame,
  type PetMotion,
} from "../packages/ui/pet-motion";
import { typePetPlay } from "../packages/ui/pet-interaction";

const run = (
  motion: PetMotion,
  seconds: number,
  state: "idle" | "listening",
) => {
  const frames: ReturnType<typeof petFrame>[] = [];
  for (let i = 0; i < seconds * 30; i++) {
    advancePetMotion(motion, 1 / 30, state, 0.6);
    frames.push(petFrame(motion, state, false));
  }
  return frames;
};

test("listening nods: the pet looks up and its lean swings both ways", () => {
  const motion: PetMotion = { time: 2, level: 0, touch: 0, sleep: 0 };
  const frames = run(motion, 3, "listening").slice(30);
  const leans = frames.map((frame) => frame.leanY);
  expect(Math.max(...leans)).toBeGreaterThan(0.2);
  expect(Math.min(...leans)).toBeLessThan(-0.2);
  expect(Math.min(...frames.map((frame) => frame.gazeY))).toBeGreaterThan(-0.2);
  // Reduced motion keeps the pet still.
  expect(petFrame(motion, "listening", true).leanY).toBe(0);
});

test("listening eases out once the pet is idle again", () => {
  const motion: PetMotion = { time: 2, level: 0, touch: 0, sleep: 0 };
  run(motion, 2, "listening");
  run(motion, 2, "idle");
  expect(motion.listen).toBeLessThan(0.01);
});

test("typing makes the pet glance down at the composer, then back", () => {
  const motion: PetMotion = {
    time: 2,
    level: 0,
    touch: 0,
    sleep: 0,
    interaction: createPetInteraction(),
  };
  run(motion, 1, "idle");
  typePetPlay(motion.interaction!.play, motion.time);
  const glance = run(motion, 0.6, "idle");
  expect(Math.min(...glance.map((frame) => frame.gazeY))).toBeLessThan(-0.3);
  const back = run(motion, 2, "idle");
  expect(Math.abs(back.at(-1)!.gazeY)).toBeLessThan(0.1);
});
