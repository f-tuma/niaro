import { advancePetMotion, setPetAppearance } from "../packages/ui/pet-motion";
import {
  claimPetMotion,
  createPetMotion,
  releasePetMotion,
} from "../packages/ui/pet-store";

test("a rebuilt view of the same placement continues the kept motion", () => {
  const first = claimPetMotion("TEST-home", createPetMotion("idle"));
  expect(first.restored).toBe(false);
  setPetAppearance(first.motion, { shape: "clover" });
  for (let i = 0; i < 90; i++)
    advancePetMotion(first.motion, 1 / 30, "idle", 0);
  const time = first.motion.time;
  expect(time).toBeGreaterThan(4.9);
  releasePetMotion("TEST-home", first.motion);

  const fresh = createPetMotion("idle");
  const second = claimPetMotion("TEST-home", fresh);
  expect(second.restored).toBe(true);
  expect(second.motion).toBe(first.motion);
  expect(second.motion.time).toBe(time);
  // Today's look is applied as a first appearance, never morphing from the old one.
  expect(second.motion.appearance).toBeUndefined();
  expect(second.motion.appearanceTransition).toBeUndefined();
  setPetAppearance(second.motion, { shape: "heart" });
  expect(second.motion.appearanceTransition).toBeUndefined();
});

test("two views under one key never share a motion; only the owner keeps it", () => {
  const owner = claimPetMotion("TEST-profile", createPetMotion("idle"));
  const preview = claimPetMotion("TEST-profile", createPetMotion("idle"));
  expect(preview.motion).not.toBe(owner.motion);
  expect(preview.restored).toBe(false);
  for (let i = 0; i < 15; i++)
    advancePetMotion(owner.motion, 1 / 30, "idle", 0);
  releasePetMotion("TEST-profile", preview.motion);
  releasePetMotion("TEST-profile", owner.motion);
  const next = claimPetMotion("TEST-profile", createPetMotion("idle"));
  expect(next.motion).toBe(owner.motion);
  expect(next.motion.time).toBeCloseTo(2.5);
});

test("a kept motion ends any touch reaction, as every lifecycle change does", () => {
  const { motion } = claimPetMotion("TEST-touch", createPetMotion("idle"));
  motion.touch = 0.8;
  motion.interaction!.pressed = true;
  releasePetMotion("TEST-touch", motion);
  expect(motion.touch).toBe(0);
  expect(motion.interaction!.pressed).toBe(false);
});

test("a new pet starts at the first frame's clock, asleep when resting", () => {
  expect(createPetMotion("idle")).toMatchObject({ time: 2, sleep: 0 });
  expect(createPetMotion("resting")).toMatchObject({ time: 2, sleep: 1 });
});
