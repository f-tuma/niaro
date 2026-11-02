import {
  createPetInteraction,
  resetPetInteraction,
  type PetMotion,
  type PetState,
} from "./pet-motion";

/**
 * Where a pet's motion waits while its view is rebuilt (a tab switch, a nested profile screen,
 * the keyboard), so the next view of the same placement continues that pet instead of starting
 * it again: its clock, sleep, breathing, ink and idle timing carry on. A touch reaction in
 * progress ends, as on any lifecycle change.
 *
 * One view owns a key at a time. A second view mounted under a key that is in use starts its own
 * motion and never keeps it, so two pets on screen (the profile and its appearance preview) are
 * never one state.
 */
const kept = new Map<string, PetMotion>();
const owners = new Map<string, PetMotion>();

/** A pet that has not moved yet: the clock at 2, as every first frame (and its still) assumes. */
export function createPetMotion(state: PetState): PetMotion {
  return {
    time: 2,
    level: 0,
    touch: 0,
    sleep: state === "resting" ? 1 : 0,
    interaction: createPetInteraction(),
  };
}

/** Takes the kept motion for key, or `fresh` when there is none or another view owns the key. */
export function claimPetMotion(
  key: string,
  fresh: PetMotion,
): { motion: PetMotion; restored: boolean } {
  if (owners.has(key)) return { motion: fresh, restored: false };
  const motion = kept.get(key);
  kept.delete(key);
  owners.set(key, motion ?? fresh);
  if (!motion) return { motion: fresh, restored: false };
  // The view applies today's look as a first appearance: no morph from what it was.
  motion.appearance = undefined;
  motion.appearanceTransition = undefined;
  return { motion, restored: true };
}

/** Keeps the owner's motion for the next view of key; a non-owner's motion is dropped. */
export function releasePetMotion(key: string, motion: PetMotion) {
  if (owners.get(key) !== motion) return;
  owners.delete(key);
  resetPetInteraction(motion);
  kept.set(key, motion);
}
