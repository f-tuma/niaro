export type PetState =
  | "idle"
  | "listening"
  | "working"
  | "speaking"
  | "resting";
export type PetMotion = {
  time: number;
  level: number;
  touch: number;
  sleep: number;
  interaction?: PetInteraction;
};
export type PetInteraction = {
  pressed: boolean;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  stroke: number;
  acknowledgement: number;
};
export const createPetInteraction = (): PetInteraction => ({
  pressed: false,
  x: 0,
  y: 0,
  targetX: 0,
  targetY: 0,
  stroke: 0,
  acknowledgement: 0,
});

/** Conservative inner silhouette: transparent corners never take the scroll. */
export function petHitTest(x: number, y: number, size: number) {
  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Math.hypot(x - size / 2, y - size / 2) <= size * 0.27
  );
}

export function resetPetInteraction(motion: PetMotion) {
  motion.touch = 0;
  motion.interaction = createPetInteraction();
}

/** A held finger has no repeating impulse; only distance adds soft attention. */
export function strokePet(
  motion: PetMotion,
  dx: number,
  dy: number,
  size: number,
) {
  const interaction = motion.interaction;
  if (!interaction?.pressed || !Number.isFinite(dx) || !Number.isFinite(dy))
    return;
  const length = Math.hypot(dx, dy);
  if (length < 0.5) return;
  const distance = Math.min(0.18, length / Math.max(16, size));
  interaction.stroke = Math.min(1, interaction.stroke + distance * 3);
  interaction.targetX = dx / length;
  interaction.targetY = dy / length;
}

export const PET_RADIUS = 0.7;
export const PET_FOV = 0.37;
// Fixed appearance from the approved study; these are not a user profile.
export const PET_COUNTS = [3, 2, 1, 1, 1, 0] as const;
export const PET_COLORS = [
  [0.36, 0.33, 0.86],
  [0.98, 0.45, 0.36],
  [0.12, 0.7, 0.66],
  [0.99, 0.72, 0.18],
  [0.93, 0.36, 0.66],
  [0.55, 0.8, 0.25],
] as const;
const clamp = (v: number) =>
  Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;

/** One clock for the dye: state changes never reset or accelerate its orbits. */
export function advancePetMotion(
  motion: PetMotion,
  dt: number,
  state: PetState,
  level: number,
) {
  const step = Number.isFinite(dt) ? Math.max(0, Math.min(0.1, dt)) : 0;
  motion.time += step;
  const follow = 1 - Math.exp(-step / 0.16);
  motion.level +=
    ((state === "listening" ? clamp(level) : 0) - motion.level) * follow;
  motion.sleep +=
    ((state === "resting" ? 1 : 0) - motion.sleep) *
    (1 - Math.exp(-step / 0.4));
  const interaction = motion.interaction;
  if (interaction) {
    interaction.acknowledgement *= Math.exp(-step / 0.28);
    interaction.stroke *= Math.exp(-step / 0.45);
    const interactive = state === "idle";
    const target = interactive
      ? Math.max(
          interaction.acknowledgement,
          interaction.pressed ? 0.25 + interaction.stroke * 0.65 : 0,
        )
      : 0;
    motion.touch += (target - motion.touch) * (1 - Math.exp(-step / 0.08));
    const direction = interactive && interaction.pressed ? 1 : 0;
    interaction.x += (interaction.targetX * direction - interaction.x) * follow;
    interaction.y += (interaction.targetY * direction - interaction.y) * follow;
  } else motion.touch *= Math.exp(-step / 0.3);
}

/** Quiet motion stays inside ±2% squash; speaking is a state cue, not lip sync. */
export function petFrame(motion: PetMotion, state: PetState, reduced: boolean) {
  const time = reduced ? 2 : motion.time;
  const sleep = reduced ? +(state === "resting") : motion.sleep;
  const touch = reduced || state !== "idle" ? 0 : motion.touch;
  const direction = touch * (reduced ? 0 : 1);
  const phase = time % 5.7;
  const blink = reduced || phase > 0.22 ? 1 : Math.abs(phase - 0.11) / 0.11;
  return {
    time,
    sleep,
    blink,
    stretch: reduced
      ? 0
      : Math.max(
          -0.02,
          Math.min(
            0.02,
            Math.sin(time * 1.35) * 0.004 + motion.level * 0.014 - touch * 0.02,
          ),
        ),
    bob: reduced ? 0 : Math.sin(time * 1.1) * 0.003,
    gazeX: reduced
      ? 0
      : state === "working"
        ? Math.sin(time * 0.6) * 0.14
        : (motion.interaction?.x ?? 0) * direction * 0.4,
    gazeY: (motion.interaction?.y ?? 0) * direction * -0.3,
    tilt: (motion.interaction?.x ?? 0) * direction * 0.045,
    pleased: touch * 0.55,
    smile: 0.45 + touch * 0.45,
    blush: touch * 0.5,
    mouth:
      state === "speaking" && !reduced
        ? 0.18 + 0.03 * Math.sin(time * 3)
        : sleep * 0.2,
  };
}

export function petRenderSize(size: number, pixelRatio: number) {
  const logical = Number.isFinite(size)
    ? Math.max(16, Math.min(480, size))
    : 156;
  const density = Number.isFinite(pixelRatio) ? Math.max(1, pixelRatio) : 1;
  const pixels = Math.round(Math.min(480, logical * Math.min(2, density)));
  return { logical, pixels, surface: pixels / density };
}
